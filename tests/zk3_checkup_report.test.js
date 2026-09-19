process.env.TZ = 'Asia/Taipei'
// AF-21 體檢修正（段 Z）：Report 與對話框的九條迴歸
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms))

const task = (id, name = `任務${id}`) => ({
  id, name, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

// 同一份模組實例（不加 ?t=）：report.js／dashboard.js 內部 import 的就是這幾個，跨模組的行為才測得到
const charts = await import('../src/ui/report/charts.js')
const modal = await import('../src/ui/modal.js')
const storage = await import('../src/shared/storage.js')
const layoutStore = await import('../src/shared/layout-store.js')
const dashboard = await import('../src/ui/report/dashboard.js')
const drawer = await import('../src/ui/report/drawer.js')
const reportPage = await import('../src/ui/report/report.js')
const tasksPage = await import('../src/ui/report/tasks.js')
const settingsPage = await import('../src/ui/report/settings.js')

function makeDom() {
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
  return jd
}

async function fresh(tasks = [task('t1', '電費')]) {
  resetChromeMock()
  const c = installChromeMock()
  await storage.init()
  for (const t of tasks) await storage.saveTask(t)
  const jd = makeDom()
  return { c, jd, doc: jd.window.document, win: jd.window }
}

const ev = (win, type, props = {}) => {
  const e = new win.Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1 }, props)
  return e
}

// ---- 1. 多序列圖表的 X 軸依時間排序 ----

const ptsOf = (svg, taskId, sel) =>
  [...svg.querySelectorAll(sel)]
    .filter(el => el.getAttribute('data-task-id') === taskId)
    .map(el => Number(el.getAttribute(sel === 'circle' ? 'cx' : 'x')))

test('折線圖：兩條序列的時間戳交錯時，X 軸依時間排序、線不回頭', async () => {
  makeDom()
  // A 先出現 09:00、11:00；B 的 10:00 是「後見」但時間在中間
  const a = { taskId: 'A', points: [{ t: '2026-01-01T09:00', v: 1 }, { t: '2026-01-01T11:00', v: 3 }] }
  const b = { taskId: 'B', points: [{ t: '2026-01-01T10:00', v: 2 }, { t: '2026-01-01T12:00', v: 4 }] }
  const svg = charts.lineChart([a, b], { width: 600, height: 200 })

  const ax = ptsOf(svg, 'A', 'circle')
  const bx = ptsOf(svg, 'B', 'circle')
  // 依時間排序：09:00 < 10:00 < 11:00 < 12:00
  assert.ok(ax[0] < bx[0], `09:00 應在 10:00 左邊（得 ${ax[0]} / ${bx[0]}）`)
  assert.ok(bx[0] < ax[1], `10:00 應在 11:00 左邊（得 ${bx[0]} / ${ax[1]}）`)
  assert.ok(ax[1] < bx[1], `11:00 應在 12:00 左邊（得 ${ax[1]} / ${bx[1]}）`)
  // 每條序列自己的 x 都不往回走
  for (const xs of [ax, bx]) {
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], 'x 座標往回走了')
  }
  const labels = [...svg.querySelectorAll('[data-axis-label="x"]')].map(el => el.textContent)
  assert.deepEqual(labels, ['09:00', '12:00'], 'X 軸兩端標籤是最早與最晚')
})

test('長條圖：X 軸同樣依時間排序', async () => {
  makeDom()
  const a = { taskId: 'A', points: [{ t: '2026-01-01T09:00', v: 1 }, { t: '2026-01-01T11:00', v: 3 }] }
  const b = { taskId: 'B', points: [{ t: '2026-01-01T10:00', v: 2 }] }
  const svg = charts.barChart([a, b], { width: 600, height: 200 })
  const ax = ptsOf(svg, 'A', 'rect')
  const bx = ptsOf(svg, 'B', 'rect')
  assert.ok(ax[0] < bx[0] && bx[0] < ax[1], `10:00 的長條應夾在中間（得 ${ax[0]} / ${bx[0]} / ${ax[1]}）`)
})

test('時間戳解析不出來時維持首見順序（不是時間的標籤不被亂排）', async () => {
  makeDom()
  const svg = charts.lineChart([{ taskId: 'A', points: [{ t: '乙', v: 1 }, { t: '甲', v: 2 }] }], { width: 600, height: 200 })
  const labels = [...svg.querySelectorAll('[data-axis-label="x"]')].map(el => el.textContent)
  assert.deepEqual(labels, ['乙', '甲'])
})

// ---- 2. 抽屜「套用」寫不進去時不關窗 ----

async function openCardDrawer(doc, over = {}) {
  const l = await layoutStore.getLayout()
  const did = l.dashboards[0].id
  const card = await layoutStore.addCard(did, { type: 'number', title: '原標題', x: 0, y: 0, w: 6, h: 2, source: [{ taskId: 't1' }], options: {}, ...over })
  await dashboard.renderDashboard(did)
  await drawer.openDrawer(did, card.id)
  await settle()
  const titleInput = doc.getElementById('drawer-title')
  titleInput.value = '改過的標題'
  titleInput.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  await settle()
  return { did, cardId: card.id }
}

test('套用失敗：抽屜留著、草稿留著、抽屜裡說出原因；修好再按就寫得進去', async () => {
  const { c, doc } = await fresh()
  const { did, cardId } = await openCardDrawer(doc)

  const realSet = c.storage.local.set
  c.storage.local.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'))
  try {
    doc.getElementById('drawer-apply').click()
    await settle(120)
  } finally {
    c.storage.local.set = realSet
  }

  assert.equal(doc.getElementById('card-drawer').hidden, false, '寫入失敗時抽屜不該關掉')
  assert.equal(drawer.isDrawerOpen(), true)
  const draft = drawer.getDraftPreview(did, cardId)
  assert.equal(draft?.title, '改過的標題', '草稿要留著')
  const err = doc.getElementById('drawer-error')
  assert.ok(err && !err.hidden && err.textContent.includes('QUOTA_BYTES'), `抽屜裡要顯示原因，得：${err?.textContent}`)
  const mid = await layoutStore.getLayout()
  assert.equal(mid.dashboards.find(d => d.id === did).cards.find(x => x.id === cardId).title, '原標題')

  doc.getElementById('drawer-apply').click()
  await settle(120)
  assert.equal(doc.getElementById('card-drawer').hidden, true, '寫成功才關')
  const after = await layoutStore.getLayout()
  assert.equal(after.dashboards.find(d => d.id === did).cards.find(x => x.id === cardId).title, '改過的標題')
  assert.equal(doc.getElementById('drawer-error').hidden, true, '成功後錯誤訊息要收掉')
})

test('requestClose 選「套用」寫不進去時走同一條：抽屜不關，openDrawer 也不炸', async () => {
  const { c, doc } = await fresh()
  const { did, cardId } = await openCardDrawer(doc)
  // 型別／來源／呈現全同會被 addCard 去重成同一張卡，第二張要真的不一樣
  const other = await layoutStore.addCard(did, { type: 'table', title: '另一張', x: 0, y: 2, w: 12, h: 4, source: [{ taskId: 't1' }], options: { mode: 'recent' } })
  assert.notEqual(other.id, cardId, '（前提）是兩張不同的卡')

  const realSet = c.storage.local.set
  c.storage.local.set = () => Promise.reject(new Error('write failed'))
  try {
    // 開另一張卡 → requestClose 問「要套用嗎」→ 選「套用」
    const opening = drawer.openDrawer(did, other.id)
    await settle()
    const dlg = doc.querySelector('dialog.modal')
    assert.ok(dlg, '要先問要不要套用')
    dlg.querySelector('[data-action="confirm"]').click()
    await opening
    await settle(60)
  } finally {
    c.storage.local.set = realSet
  }

  assert.equal(doc.getElementById('card-drawer').hidden, false, '套用失敗就不換卡、不關抽屜')
  assert.equal(drawer.getDraftPreview(did, cardId)?.title, '改過的標題', '草稿留在原本那張卡上')
  // 收尾：把草稿捨棄掉，不留給下一則測試
  const closing = drawer.closeDrawer()
  await settle()
  doc.querySelector('dialog.modal')?.querySelector('[data-action="extra"]')?.click()
  await closing
  await settle(60)
})

// ---- 3. 換儀表板清空 undo／redo ----

test('編輯模式下切換儀表板：復原堆疊清空，Ctrl+Z 不會改到沒在看的那一個', async () => {
  const { doc, win } = await fresh()
  const l0 = await layoutStore.getLayout()
  const dashA = l0.dashboards[0].id
  const dashB = (await layoutStore.addDashboard('B')).id
  const cA = await layoutStore.addCard(dashA, { type: 'number', title: 'A 卡', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1' }], options: {} })
  await dashboard.renderDashboard(dashA)
  doc.getElementById('edit-layout').click()
  await settle()

  const grid = doc.getElementById('dashboard-grid')
  const el = doc.querySelector(`[data-card-id="${cA.id}"]`)
  el.dispatchEvent(ev(win, 'pointerdown', { clientX: 10, clientY: 10 }))
  grid.dispatchEvent(ev(win, 'pointermove', { clientX: 310, clientY: 170 }))
  grid.dispatchEvent(ev(win, 'pointerup', { clientX: 310, clientY: 170 }))
  await settle(120)
  assert.ok(dashboard.historySize() > 0, '（前提）A 上有一步可復原')

  doc.querySelector(`[data-dash-id="${dashB}"]`).dispatchEvent(new win.Event('click', { bubbles: true }))
  await settle(80)
  assert.equal(dashboard.historySize(), 0, '換儀表板要清空復原堆疊')

  const beforeA = JSON.stringify((await layoutStore.getLayout()).dashboards.find(d => d.id === dashA).cards)
  await dashboard.undo()
  await settle(60)
  const afterA = JSON.stringify((await layoutStore.getLayout()).dashboards.find(d => d.id === dashA).cards)
  assert.equal(beforeA, afterA, 'Ctrl+Z 不該改到沒在看的儀表板')
  doc.getElementById('edit-layout').click()
  await settle()
})

// ---- 4. pointercancel 之後不得永遠忙碌 ----

test('卡片拖曳收到 pointercancel：activeOp 歸零、ghost 清掉、不再忙碌', async () => {
  const { doc, win } = await fresh()
  const l = await layoutStore.getLayout()
  const did = l.dashboards[0].id
  const c1 = await layoutStore.addCard(did, { type: 'number', x: 0, y: 0, w: 6, h: 2, source: [{ taskId: 't1' }], options: {} })
  await dashboard.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await settle()

  const grid = doc.getElementById('dashboard-grid')
  const cardEl = doc.querySelector(`[data-card-id="${c1.id}"]`)
  cardEl.dispatchEvent(ev(win, 'pointerdown', { clientX: 100, clientY: 100 }))
  grid.dispatchEvent(ev(win, 'pointermove', { clientX: 300, clientY: 180 }))
  assert.ok(grid.querySelector('.ghost'), '（前提）拖曳中有 ghost')
  grid.dispatchEvent(ev(win, 'pointercancel', { clientX: 300, clientY: 180 }))
  await settle()

  assert.equal(grid.querySelector('.ghost'), null, 'ghost 要清掉')
  doc.getElementById('edit-layout').click()
  await settle()
  assert.equal(dashboard.isEditing(), false)
  assert.equal(dashboard.isDashboardBusy(), false, 'pointercancel 之後不該還算忙碌')
  assert.equal(await dashboard.refreshDashboard({ full: false }), 'light')
  // 位置沒有被這次取消的移動改掉
  const after = await layoutStore.getLayout()
  const stored = after.dashboards.find(d => d.id === did).cards.find(x => x.id === c1.id)
  assert.deepEqual([stored.x, stored.y], [0, 0], '取消的拖曳不得套用')
})

test('頁籤拖曳收到 pointercancel：tabDrag 歸零、不再忙碌', async () => {
  const { doc, win } = await fresh()
  const l = await layoutStore.getLayout()
  await layoutStore.addDashboard('B')
  await dashboard.renderDashboard(l.dashboards[0].id)
  await settle()
  const tab = doc.querySelector('[data-dash-id]')
  tab.dispatchEvent(ev(win, 'pointerdown', { clientX: 10, clientY: 10 }))
  assert.equal(dashboard.isDashboardBusy(), true, '（前提）拖曳中算忙碌')
  tab.dispatchEvent(ev(win, 'pointercancel', { clientX: 10, clientY: 10 }))
  await settle()
  assert.equal(dashboard.isDashboardBusy(), false, 'pointercancel 之後不該還算忙碌')
})

// ---- 5. 對話框殭屍 ----

test('modal：對話框元素被人從文件上丟掉時，isDialogOpen 不再恆真', async () => {
  const { doc } = await fresh()
  const box = doc.getElementById('settings-import-result')
  const p = modal.confirmDialog({ title: 't', container: box })
  assert.equal(modal.isDialogOpen(), true)
  box.textContent = '別的東西把這一區覆寫了'
  assert.equal(modal.isDialogOpen(), false, '已不在文件上的對話框要當成取消結束掉')
  assert.equal(await p, false, '原本那個 Promise 要以取消收掉')
})

test('設定匯入：確認框開著時再選一個壞檔，先把它當取消收掉（不留殭屍）', async () => {
  const { doc } = await fresh()
  const good = JSON.stringify({
    kind: 'autofetcher-settings', version: 1, exportedAt: 'x',
    data: { schemaVersion: 3, tasks: [], sites: {}, settings: { retentionDays: 30 } }
  })
  await settingsPage.handleSettingsImport(good)
  await settle()
  const firstDlg = doc.querySelector('#settings-import-result dialog')
  assert.ok(firstDlg, '（前提）確認框開著')
  assert.equal(firstDlg.hasAttribute('open'), true)
  assert.equal(modal.isDialogOpen(), true)

  await settingsPage.handleSettingsImport('{ 這不是 JSON')
  await settle()
  assert.match(doc.getElementById('settings-import-result').textContent, /設定匯入失敗/)
  // 寫結果區之前就要把它當取消收掉（close 過才沒有 open）；不是等別人呼叫 isDialogOpen 才補救
  assert.equal(firstDlg.hasAttribute('open'), false, '舊確認框要在覆寫結果區之前被收掉')
  assert.equal(modal.isDialogOpen(), false, '否則抽屜的 Esc／點外關閉從此失效')
})

// ---- 6. 離開儀表板前先請抽屜關閉 ----

test('抽屜開著切到任務頁：選「繼續編輯」不切頁、選「捨棄」才切', async () => {
  const { doc } = await fresh()
  reportPage.showTab('dashboard')
  const { did, cardId } = await openCardDrawer(doc)
  assert.ok(did && cardId)

  const p1 = reportPage.showTab('tasks')
  await settle()
  let dlg = doc.querySelector('dialog.modal')
  assert.ok(dlg, '有未套用的變更要先問')
  dlg.querySelector('[data-action="cancel"]').click()   // 繼續編輯
  await p1
  await settle()
  assert.equal(doc.getElementById('panel-dashboard').hidden, false, '選繼續編輯就不切頁')
  assert.equal(drawer.isDrawerOpen(), true)

  const p2 = reportPage.showTab('tasks')
  await settle()
  dlg = doc.querySelector('dialog.modal')
  dlg.querySelector('[data-action="extra"]').click()    // 捨棄
  await p2
  await settle(60)
  assert.equal(drawer.isDrawerOpen(), false, '切過去之後抽屜不得還開著')
  assert.equal(doc.getElementById('panel-tasks').hidden, false)
  assert.equal(doc.getElementById('panel-dashboard').hidden, true)
})

// ---- 7. runResults 隨任務刪除清掉 ----

test('手動抓取結果不隨任務名字留給下一個同 id 的任務：刪掉就清', async () => {
  const { c, doc } = await fresh()
  c.__setRuntimeResponder((msg) => (msg?.type === 'RUN_TASK' ? { outcome: 'done', value: 42 } : {}))
  tasksPage.renderTasks([task('t1', '電費')], {}, [])
  const row = doc.querySelector('#task-list [data-task-id="t1"]')
  row.querySelector('[data-action="run"]').click()
  await settle(60)
  assert.match(doc.querySelector('#task-list .task-run-result').textContent, /42/, '（前提）結果有顯示')

  tasksPage.renderTasks([], {}, [])            // 任務被刪
  tasksPage.renderTasks([task('t1', '電費')], {}, [])  // 之後又有一個同 id 的任務
  assert.equal(doc.querySelector('#task-list .task-run-result'), null, '已刪任務的抓取結果不該殘留')
})

// ---- 8. 設定頁的中斷次數從 diag 數 ----

test('renderGuards 不讀 7 天紀錄：中斷次數全部從 diag 來', async () => {
  const { c, doc } = await fresh()
  const day = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
  await storage.appendRecords(day, [{ taskId: 't1', slot: `${day}T09:00`, capturedAt: new Date().toISOString(), status: 'interrupted' }])
  await c.storage.local.set({ diag: [{ at: Date.now() - 1000, kind: 'interrupted' }] })
  c.__calls.length = 0
  await settingsPage.renderSettings()
  await settle(60)
  const text = doc.getElementById('health-guards').textContent
  assert.match(text, /被瀏覽器中斷 1 次/, 'diag 裡一筆 interrupted → 算 1 次（紀錄那筆不重複算）')
})

// ---- 9. 空窗列的「知道了」 ----

test('錯過清單的空窗列：SKIP_ONE 要帶 kind gap，背景回 ok:false 時顯示它給的原因', async () => {
  const { c, doc } = await fresh()
  c.__setRuntimeResponder((msg) => (msg?.type === 'SKIP_ONE' ? { ok: false, error: '找不到這一筆空窗' } : {}))
  tasksPage.renderTasks([task('t1', '電費')], {}, [{ taskId: 't1', kind: 'gap', slot: '2026-01-01T09:00', since: '2026-01-01T09:00' }])
  const ack = doc.querySelector('#missed-banner [data-action="ack-gap"]')
  assert.ok(ack, '（前提）空窗列有「知道了」')
  ack.click()
  await settle(60)

  const sent = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).filter(m => m?.type === 'SKIP_ONE')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'gap', 'SKIP_ONE 要帶 kind:gap')
  assert.match(doc.getElementById('task-note').textContent, /找不到這一筆空窗/, '要顯示背景給的原因')
})
