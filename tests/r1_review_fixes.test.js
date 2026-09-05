process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, name, over = {}) => ({
  id, name, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }, ...over
})
const rec = (taskId, slot, value, status = 'ok') => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status
})
const card = (over = {}) => ({
  type: 'number', x: 0, y: 0, w: 3, h: 2,
  source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task('t1', '電費'))
  await st.saveTask(task('t2', '水費'))
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  const tp = await import('../src/ui/report/templates.js?t=' + Math.random())
  return { c, st, ls, rp, db, dw, tp, doc: jd.window.document, win: jd.window }
}
const fire = (win, el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }))

// ---- 1. 篩選監聽不可累加 ----

test('重複呼叫 renderFilters 後，一次變更只觸發一次篩選', async () => {
  const { rp, doc, win } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-01')
  let calls = 0
  const orig = win.location.hash
  await rp.renderFilters()
  await rp.renderFilters()
  await rp.renderFilters()
  const kw = doc.getElementById('filter-keyword')
  const counter = () => { calls++ }
  kw.addEventListener('change', counter)
  kw.value = '停電'
  fire(win, kw, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(calls, 1, '事件本身只發一次')
  assert.equal(rp.getState().keyword, '停電')
  void orig
})

test('篩選容器上不可累積多個 change 監聽（重畫三次後只留一份）', async () => {
  const { rp, doc } = await fresh()
  const container = doc.getElementById('filters')
  let added = 0
  const realAdd = container.addEventListener.bind(container)
  const realRemove = container.removeEventListener.bind(container)
  container.addEventListener = (t, f, o) => { if (t === 'change') added++; return realAdd(t, f, o) }
  container.removeEventListener = (t, f, o) => { if (t === 'change') added--; return realRemove(t, f, o) }
  await rp.renderFilters()
  await rp.renderFilters()
  await rp.renderFilters()
  assert.ok(added <= 1, `容器上應最多一個 change 監聽，實得 ${added}`)
})

// ---- 2. 抽屜不可刪掉當前型別看不到的設定 ----

test('編輯表格卡片的標題，不會清掉它的小數位與單位', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c = await ls.addCard(did, card({ type: 'table', options: { decimals: 2, unit: '元', limit: 5 } }))
  await db.renderDashboard(did)
  await dw.openDrawer(did, c.id)
  const t = doc.getElementById('drawer-title')
  t.value = '改標題'
  fire(win, t, 'change')
  await new Promise(r => setTimeout(r, 30))
  const saved = (await ls.getLayout()).dashboards[0].cards[0].options
  assert.equal(saved.decimals, 2, '看不到的欄位不可被清掉')
  assert.equal(saved.unit, '元')
  assert.equal(saved.limit, 5)
})

test('編輯數字卡片不會清掉它的 Y 軸範圍設定', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c = await ls.addCard(did, card({ type: 'number', options: { yMin: 0, yMax: 50 } }))
  await db.renderDashboard(did)
  await dw.openDrawer(did, c.id)
  const u = doc.getElementById('drawer-unit')
  u.value = '度'
  fire(win, u, 'change')
  await new Promise(r => setTimeout(r, 30))
  const saved = (await ls.getLayout()).dashboards[0].cards[0].options
  assert.equal(saved.yMin, 0)
  assert.equal(saved.yMax, 50)
})

test('顯示中的欄位被清空時仍可移除該設定', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c = await ls.addCard(did, card({ type: 'number', options: { unit: '度' } }))
  await db.renderDashboard(did)
  await dw.openDrawer(did, c.id)
  const u = doc.getElementById('drawer-unit')
  u.value = ''
  fire(win, u, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].options.unit, undefined)
})

// ---- 3. 復原歷史不可因單擊而錯位 ----

test('編輯模式下單擊卡片（沒有位移）不會弄亂復原歷史', async () => {
  const { ls, db, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c = await ls.addCard(did, card())
  await ls.updateCard(did, c.id, { x: 0, y: 0 })
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  const grid = doc.getElementById('dashboard-grid')
  const p = (t, x, y) => {
    const ev = new win.MouseEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'pointerId', { value: 1 })
    return ev
  }
  el.dispatchEvent(p('pointerdown', 10, 10))
  grid.dispatchEvent(p('pointerup', 10, 10))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(db.historySize(), 0, '沒有實際變更就不該留下歷史')
  el.dispatchEvent(p('pointerdown', 10, 10))
  grid.dispatchEvent(p('pointermove', 310, 10))
  grid.dispatchEvent(p('pointerup', 310, 10))
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 6)
  await db.undo()
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 0, '復原要回到拖曳前')
})

// ---- 4. 單筆刪除的確認不可誤刪別筆 ----

test('連續對兩筆按刪除，確認只會刪掉最後一筆', async () => {
  const { st, rp, doc } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T10:00', 2))
  rp.renderTable(await st.getRecordsInRange('2026-09-01', '2026-09-01'))
  const rows = [...doc.querySelectorAll('#record-table tbody tr')]
  rows[0].click()
  await new Promise(r => setTimeout(r, 20))
  doc.querySelector('#record-table [data-action="delete-record"]').click()
  await new Promise(r => setTimeout(r, 20))
  const rows2 = [...doc.querySelectorAll('#record-table tbody tr')].filter(r => !r.classList.contains('detail'))
  rows2[1].click()
  await new Promise(r => setTimeout(r, 20))
  const btns = doc.querySelectorAll('#record-table [data-action="delete-record"]')
  btns[btns.length - 1].click()
  await new Promise(r => setTimeout(r, 20))
  doc.querySelector('#record-delete-confirm [data-action="confirm"]').click()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await st.getRecordsByDate('2026-09-01')).length, 1, '一次確認只能刪一筆')
})

// ---- 5. 不可偷改儀表板 id ----

test('用不存在的儀表板 id 渲染時，退回第一個而不是改寫它的 id', async () => {
  const { ls, db } = await fresh()
  const before = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard('不存在的id')
  const after = (await ls.getLayout()).dashboards[0].id
  assert.equal(after, before, '儀表板 id 不可被改寫')
})

// ---- 6. 下次執行時間只有一份實作，且排除預檢與重試 ----

test('預檢與重試 alarm 不可被當成下次執行時間', async () => {
  const { c, st } = await fresh()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const real = Date.now() + 7200000
  await c.alarms.create('task:t1:0', { when: real })
  await c.alarms.create('precheck:t1:0', { when: Date.now() + 60000 })
  await c.alarms.create('task:t1:0:retry:1', { when: Date.now() + 120000 })
  const res = await bg.handleMessage({ type: 'GET_NEXT_RUNS' })
  assert.ok(res.nextRuns.t1 >= real - 1000, `應取正式排程 ${real}，實得 ${res.nextRuns.t1}`)
  void st
})

test('UI 端不自行解析 alarm 名稱，一律問 background', () => {
  for (const f of ['src/ui/report/dashboard.js', 'src/ui/report/report.js', 'src/ui/report/tasks.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    assert.equal((src.match(/alarms\.getAll/g) || []).length, 0, `${f} 不該自己讀 alarms`)
  }
})

// ---- 7. 刪任務要清掉 status 卡的任務篩選 ----

test('刪任務後 status 卡片的任務篩選也要移除該任務', async () => {
  const { ls, st } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ type: 'status', source: [], options: { taskIds: ['t1', 't2'] } }))
  await st.deleteTask('t1')
  const c0 = (await ls.getLayout()).dashboards[0].cards[0]
  assert.deepEqual(c0.options.taskIds, ['t2'])
})

test('status 卡片的篩選清空後整張卡片刪除', async () => {
  const { ls, st } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ type: 'status', source: [], options: { taskIds: ['t1'] } }))
  await st.deleteTask('t1')
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})

test('沒有指定篩選的 status 卡片不受刪任務影響', async () => {
  const { ls, st } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ type: 'status', source: [], options: {} }))
  await st.deleteTask('t1')
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 1)
})

// ---- 8. 成功狀態判定只有一份 ----

test('成功狀態的定義集中在一處，各模組共用', () => {
  const shared = readFileSync(new URL('../src/shared/record-status.js', import.meta.url), 'utf8')
  assert.ok(/fallback/.test(shared) && /late/.test(shared), '共用模組要含三種成功狀態')
  for (const f of ['src/ui/report/series.js', 'src/ui/report/logic.js', 'src/ui/report/report.js',
                   'src/ui/report/cards.js', 'src/shared/export.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    assert.ok(/record-status/.test(src), `${f} 要改用共用的成功狀態判定`)
  }
})

test('fallback 與 late 在各處都算成功', async () => {
  const rs = await import('../src/shared/record-status.js?t=' + Math.random())
  for (const s of ['ok', 'fallback', 'late']) assert.equal(rs.isSuccess({ status: s }), true, s)
  for (const s of ['not_found', 'error', 'timeout', undefined]) {
    assert.equal(rs.isSuccess({ status: s }), false, String(s))
  }
})

test('fallback 紀錄在數字卡片顯示值而不是破折號', async () => {
  const { st, ls, db, doc } = await fresh()
  await st.appendRecord('2026-09-06', rec('t1', '2026-09-06T09:00', 42, 'fallback'))
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card())
  await db.renderDashboard(did)
  const txt = doc.querySelector('[data-card-id]').textContent
  assert.ok(txt.includes('42'), `fallback 應顯示值，實得：${txt}`)
})

// ---- 9. HTML 報表顏色取自 theme.css ----

test('HTML 報表的調色盤來自 theme.css，不是模組內寫死', () => {
  const src = readFileSync(new URL('../src/shared/export.js', import.meta.url), 'utf8')
  assert.equal((src.match(/#[0-9a-fA-F]{3,6}\b/g) || []).length, 0,
    'export.js 不可寫死色碼，應由 theme.css 產生')
})

test('HTML 報表仍然內嵌完整調色盤', async () => {
  const { ls, st, ex } = await (async () => {
    const f = await fresh()
    const ex = await import('../src/shared/export.js?t=' + Math.random())
    return { ...f, ex }
  })()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 10))
  const did = (await ls.getLayout()).dashboards[0].id
  const { content } = await ex.buildHtmlReport({ from: '2026-09-01', to: '2026-09-01', dashId: did })
  for (let i = 1; i <= 8; i++) assert.ok(content.includes(`--chart-${i}`), `缺 --chart-${i}`)
})

// ---- 10. 套用範本要先確認且可復原 ----

test('套用範本前要確認，取消時卡片不動', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card())
  await db.renderDashboard(did)
  const sel = doc.getElementById('apply-template')
  sel.value = 'compare'
  sel.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
  const dlg = doc.getElementById('template-confirm')
  assert.ok(dlg && !dlg.hidden, '要先出現確認框')
  dlg.querySelector('[data-action="cancel"]').click()
  await new Promise(r => setTimeout(r, 30))
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1)
  assert.equal(cards[0].type, 'number')
})

test('確認後才取代卡片', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card())
  await db.renderDashboard(did)
  const sel = doc.getElementById('apply-template')
  sel.value = 'compare'
  sel.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
  doc.querySelector('#template-confirm [data-action="confirm"]').click()
  await new Promise(r => setTimeout(r, 60))
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.ok(cards.some(c => c.type === 'line'))
})

// ---- 11. 樞紐表要接上 UI ----

test('歷史頁可切換紀錄列表與樞紐表', async () => {
  const { st, rp, doc, win } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  await st.appendRecord('2026-09-01', rec('t2', '2026-09-01T09:00', 2))
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-01')
  const sel = doc.getElementById('table-mode')
  assert.ok(sel, '要有表格模式切換')
  sel.value = 'pivot'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 60))
  const heads = [...doc.querySelectorAll('#record-table thead th')].map(th => th.textContent)
  assert.ok(heads.includes('電費') && heads.includes('水費'), `樞紐表頭應是任務名，實得 ${heads}`)
})

// ---- 12. 設定頁不再猜不存在的看門狗欄位 ----

test('看門狗時間取自實際寫入的來源', async () => {
  const src = readFileSync(new URL('../src/ui/report/settings.js', import.meta.url), 'utf8')
  for (const k of ['lastWatchdogAt', 'watchdogLastRun', 'lastWatchdog']) {
    assert.equal(src.includes(k), false, `${k} 沒有任何寫入端，不該猜測讀取`)
  }
})

test('設定頁顯示看門狗與最近診斷', async () => {
  const { c } = await fresh()
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  const now = Date.now()
  await c.storage.local.set({ diag: [{ at: now, kind: 'watchdog', detail: '看門狗巡檢完成' }] })
  await se.renderSettings()
  assert.ok(globalThis.document.getElementById('health-watchdog').textContent.length > 0)
  assert.equal(globalThis.document.querySelectorAll('#health-diag [data-diag]').length, 1)
})

// ---- 13. 任務頁與設定頁不再全量掃 storage ----

test('UI 不直接呼叫 chrome.storage.local.get(null)', () => {
  for (const f of ['src/ui/report/tasks.js', 'src/ui/report/settings.js',
                   'src/ui/report/dashboard.js', 'src/ui/report/report.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    assert.equal((src.match(/chrome\.storage/g) || []).length, 0,
      `${f} 應改走 shared/storage`)
  }
})

test('storage 提供任務紀錄筆數查詢', async () => {
  const { st } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  await st.appendRecord('2026-09-02', rec('t1', '2026-09-02T09:00', 2))
  await st.appendRecord('2026-09-02', rec('t2', '2026-09-02T09:00', 3))
  assert.equal(await st.countRecordsForTask('t1'), 2)
  assert.equal(await st.countRecordsForTask('沒有這個'), 0)
})

// ---- 14. 重新選取要有可見結果 ----

test('按重新選取會開啟該任務的目標頁', async () => {
  const { c, doc } = await fresh()
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  ts.renderTasks([task('t1', '電費')], {}, [])
  doc.querySelector('[data-task-id="t1"] [data-action="repick"]').click()
  await new Promise(r => setTimeout(r, 40))
  const opened = c.__calls.filter(x => x.api === 'tabs.create')
  assert.ok(opened.some(x => String(x.args[0].url).includes('x.test/t1')),
    `應開啟目標頁，實得 ${JSON.stringify(opened.map(o => o.args[0]))}`)
})

test('content 不支援選取模式時任務頁顯示提示', async () => {
  const { doc } = await fresh()
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  ts.renderTasks([task('t1', '電費')], {}, [])
  doc.querySelector('[data-task-id="t1"] [data-action="repick"]').click()
  await new Promise(r => setTimeout(r, 60))
  const note = doc.getElementById('task-note')
  assert.ok(note && note.textContent.includes('右鍵'), `要提示改用右鍵重選，實得：${note && note.textContent}`)
})
