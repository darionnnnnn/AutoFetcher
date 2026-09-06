process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, name, mode = 'number') => ({
  id, name, url: `https://x.test/${id}`, mode, enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
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
  await st.saveTask(task('t3', '公告', 'text'))
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  return { c, st, ls, db, dw, doc: jd.window.document, win: jd.window }
}

async function seedOne(ls, over = {}) {
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  const c = await ls.addCard(did, card(over))
  return { did, cardId: c.id }
}

const fire = (win, el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }))

// ---- 開關 ----

test('點齒輪開啟抽屜，顯示該卡片的目前設定', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls, { title: '我的卡片' })
  await db.renderDashboard(did)
  doc.querySelector(`[data-card-id="${cardId}"] [data-action="config"]`).click()
  await new Promise(r => setTimeout(r, 20))
  const drawer = doc.getElementById('card-drawer')
  assert.ok(drawer && !drawer.hidden, '抽屜要打開')
  assert.equal(doc.getElementById('drawer-title').value, '我的卡片')
  assert.equal(doc.getElementById('drawer-type').value, 'number')
  void dw, win
})

test('關閉抽屜後設定已存進 storage', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const t = doc.getElementById('drawer-title')
  t.value = '改過的標題'
  fire(win, t, 'change')
  await new Promise(r => setTimeout(r, 20))
  doc.getElementById('drawer-close').click()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(doc.getElementById('card-drawer').hidden)
  const saved = (await ls.getLayout()).dashboards[0].cards[0]
  assert.equal(saved.title, '改過的標題')
})

// ---- 即時套用 ----

test('改型別後該卡片立即重畫成新型別', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const sel = doc.getElementById('drawer-type')
  sel.value = 'line'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  const el = doc.querySelector(`[data-card-id="${cardId}"]`)
  assert.equal(el.dataset.cardType, 'line')
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].type, 'line')
})

test('改來源後序列跟著變', async () => {
  const { ls, st, db, dw, doc, win } = await fresh()
  await st.appendRecord('2026-09-06', { taskId: 't2', slot: '2026-09-06T09:00', capturedAt: 'a', value: 777, status: 'ok' })
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const box = doc.querySelector('#drawer-sources input[value="t2"]')
  box.checked = true
  fire(win, box, 'change')
  const box1 = doc.querySelector('#drawer-sources input[value="t1"]')
  box1.checked = false
  fire(win, box1, 'change')
  await new Promise(r => setTimeout(r, 30))
  const saved = (await ls.getLayout()).dashboards[0].cards[0]
  assert.deepEqual(saved.source.map(s => s.taskId), ['t2'])
})

test('改期間立即寫回設定', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const sel = doc.getElementById('drawer-period')
  sel.value = '7'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].options.period, 7)
})

test('小數位與單位寫回設定', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const d = doc.getElementById('drawer-decimals')
  d.value = '2'
  fire(win, d, 'change')
  const u = doc.getElementById('drawer-unit')
  u.value = '度'
  fire(win, u, 'change')
  await new Promise(r => setTimeout(r, 30))
  const o = (await ls.getLayout()).dashboards[0].cards[0].options
  assert.equal(o.decimals, 2)
  assert.equal(o.unit, '度')
})

test('Y 軸範圍只在折線與長條型別出現', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  assert.ok(doc.getElementById('drawer-field-yaxis').hidden, 'number 型別不該顯示 Y 軸範圍')
  const sel = doc.getElementById('drawer-type')
  sel.value = 'line'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(doc.getElementById('drawer-field-yaxis').hidden, false)
})

test('閾值設定寫回並帶顏色', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  doc.getElementById('drawer-threshold-op').value = 'gte'
  doc.getElementById('drawer-threshold-value').value = '90'
  fire(win, doc.getElementById('drawer-threshold-value'), 'change')
  await new Promise(r => setTimeout(r, 30))
  const th = (await ls.getLayout()).dashboards[0].cards[0].options.thresholds
  assert.ok(Array.isArray(th) && th.length === 1)
  assert.equal(th[0].op, 'gte')
  assert.equal(th[0].value, 90)
})

// ---- 來源過濾 ----

test('文字模式任務在數值型卡片下停用並說明原因', async () => {
  const { ls, db, dw, doc } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const t3 = doc.querySelector('#drawer-sources input[value="t3"]')
  assert.ok(t3.disabled, '文字模式任務不可作為 number 卡片來源')
  const label = t3.closest('label') || t3.parentElement
  assert.ok(label.textContent.includes('文字'), `要說明原因，實得：${label.textContent}`)
})

test('切成表格型別後文字模式任務可選', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const sel = doc.getElementById('drawer-type')
  sel.value = 'table'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(doc.querySelector('#drawer-sources input[value="t3"]').disabled, false)
})

// ---- 還原 ----

test('還原回到開啟抽屜時的狀態', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls, { title: '原標題' })
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const t = doc.getElementById('drawer-title')
  t.value = '亂改的'
  fire(win, t, 'change')
  await new Promise(r => setTimeout(r, 20))
  doc.getElementById('drawer-revert').click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].title, '原標題')
  assert.equal(doc.getElementById('drawer-title').value, '原標題')
})

test('還原後再改仍會存檔（還原不會鎖住抽屜）', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls, { title: '原標題' })
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  doc.getElementById('drawer-revert').click()
  await new Promise(r => setTimeout(r, 20))
  const t = doc.getElementById('drawer-title')
  t.value = '第二次改'
  fire(win, t, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].title, '第二次改')
})

// ---- 影響範圍 ----

test('抽屜開著時不重畫其他卡片', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  const c1 = await ls.addCard(did, card())
  const c2 = await ls.addCard(did, card({ x: 6, source: [{ taskId: 't2', aggregation: 'raw' }] }))
  await db.renderDashboard(did)
  const other = doc.querySelector(`[data-card-id="${c2.id}"]`)
  await dw.openDrawer(did, c1.id)
  const t = doc.getElementById('drawer-title')
  t.value = '只動這張'
  fire(win, t, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(doc.querySelector(`[data-card-id="${c2.id}"]`), other, '其他卡片節點不可被重建')
})

// ---- 刪除卡片 ----

test('刪除卡片需確認，取消時不刪', async () => {
  const { ls, db, dw, doc } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  doc.getElementById('drawer-delete').click()
  await new Promise(r => setTimeout(r, 20))
  const dlg = doc.getElementById('drawer-delete-confirm')
  assert.ok(dlg && !dlg.hidden)
  dlg.querySelector('[data-action="cancel"]').click()
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 1)
})

test('刪除卡片確認後移除並關閉抽屜', async () => {
  const { ls, db, dw, doc } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  doc.getElementById('drawer-delete').click()
  await new Promise(r => setTimeout(r, 20))
  doc.querySelector('#drawer-delete-confirm [data-action="confirm"]').click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
  assert.ok(doc.getElementById('card-drawer').hidden)
  assert.equal(doc.querySelector(`[data-card-id="${cardId}"]`), null)
})

// ---- 型別專屬欄位 ----

test('text 型別顯示內容輸入，且不顯示來源清單', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const sel = doc.getElementById('drawer-type')
  sel.value = 'text'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(doc.getElementById('drawer-field-content').hidden, false)
  assert.ok(doc.getElementById('drawer-field-sources').hidden)
})

test('gauge 型別顯示上下限與警戒線欄位', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const sel = doc.getElementById('drawer-type')
  sel.value = 'gauge'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(doc.getElementById('drawer-field-gauge').hidden, false)
})

test('drawer.js 不使用 innerHTML 也不寫死色碼', () => {
  const src = readFileSync(new URL('../src/ui/report/drawer.js', import.meta.url), 'utf8')
  assert.equal((src.match(/innerHTML/g) || []).length, 0)
  assert.equal((src.match(/#[0-9a-fA-F]{3,6}\b/g) || []).length, 0)
})

// ---- 補：三個原本設定不到的選項 ----

test('可設定 number 卡片的比較基準（前一筆／前一日）', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const sel = doc.getElementById('drawer-compare')
  assert.ok(sel, '要有比較基準選單')
  sel.value = 'prevDay'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].options.compare, 'prevDay')
})

test('可設定表格卡片的筆數上限', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls, { type: 'table' })
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const el = doc.getElementById('drawer-limit')
  assert.ok(el, '要有筆數欄位')
  el.value = '25'
  fire(win, el, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].options.limit, 25)
})

test('可設定表格卡片的模式（最近 N 筆／樞紐）', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls, { type: 'table' })
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const sel = doc.getElementById('drawer-table-mode')
  assert.ok(sel, '要有表格模式選單')
  sel.value = 'pivot'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].options.mode, 'pivot')
})

test('可設定 status 卡片要顯示哪些任務', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls, { type: 'status', source: [] })
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  const box = doc.querySelector('#drawer-status-tasks input[value="t2"]')
  assert.ok(box, 'status 卡片要有任務篩選清單')
  box.checked = true
  fire(win, box, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual((await ls.getLayout()).dashboards[0].cards[0].options.taskIds, ['t2'])
})

test('比較基準與筆數欄位只在對應型別出現', async () => {
  const { ls, db, dw, doc, win } = await fresh()
  const { did, cardId } = await seedOne(ls)
  await db.renderDashboard(did)
  await dw.openDrawer(did, cardId)
  assert.equal(doc.getElementById('drawer-field-number').hidden, false, 'number 型別要顯示比較基準')
  assert.ok(doc.getElementById('drawer-field-table').hidden, 'number 型別不該顯示表格欄位')
  const sel = doc.getElementById('drawer-type')
  sel.value = 'table'
  fire(win, sel, 'change')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(doc.getElementById('drawer-field-table').hidden, false)
  assert.ok(doc.getElementById('drawer-field-number').hidden)
})
