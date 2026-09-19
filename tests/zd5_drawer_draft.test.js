// AF-21 段 4-E：卡片設定抽屜改成草稿模型（套用／取消）
// 儀表板與抽屜用同一份模組實例（不帶 ?t=）：抽屜的草稿、儀表板的重畫與投放要看到同一份狀態，跟正式頁面一樣
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

const CARD = (type, over = {}) => ({ type, x: 0, y: 0, w: 6, h: 2, source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over })

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js')
  await st.init()
  await st.saveTask(task('t1', '電費'))
  await st.saveTask(task('t2', '水費'))
  await st.saveTask(task('t3', '瓦斯'))
  const ls = await import('../src/shared/layout-store.js')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  // jsdom 25 沒有 <dialog> 的 showModal／close：替身只切 open 屬性（正式碼不留退路分支）
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const db = await import('../src/ui/report/dashboard.js')
  const dw = await import('../src/ui/report/drawer.js')
  return { c, st, ls, db, dw, doc: jd.window.document, win: jd.window }
}

async function seed(ls, cards) {
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  const ids = []
  for (const card of cards) ids.push((await ls.addCard(did, card)).id)
  return { did, ids }
}

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms))
const fire = (win, el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }))
const cardJson = async (ls, did, id) =>
  JSON.stringify((await ls.getLayout()).dashboards.find(d => d.id === did).cards.find(c => c.id === id))
const cardOf = async (ls, did, id) =>
  (await ls.getLayout()).dashboards.find(d => d.id === did).cards.find(c => c.id === id)
const cardEl = (doc, id) => doc.querySelector(`[data-card-id="${id}"]`)
const modalOf = (doc) => doc.querySelector('dialog.modal')
const drawerOpen = (doc) => !doc.getElementById('card-drawer').hidden

// 數 layout 鍵被寫了幾次（updateCard 一次＝一次 layout 寫入）
function countLayoutWrites(c) {
  const real = c.storage.local.set.bind(c.storage.local)
  const counter = { n: 0 }
  c.storage.local.set = (obj, ...rest) => {
    if (obj && Object.prototype.hasOwnProperty.call(obj, 'layout')) counter.n++
    return real(obj, ...rest)
  }
  return counter
}

async function openViaGear(doc, id) {
  cardEl(doc, id).querySelector('[data-action="config"]').click()
  await settle()
}

async function changeType(doc, win, type) {
  const sel = doc.getElementById('drawer-type')
  sel.value = type
  fire(win, sel, 'change')
  await settle()
}

async function ensureEditing(db, doc) {
  if (!db.isEditing()) {
    doc.getElementById('edit-layout').click()
    await settle()
  }
}

async function ensureBrowsing(db, doc) {
  if (db.isEditing()) {
    doc.getElementById('edit-layout').click()
    await settle()
  }
}

const pointer = (win, type, x, y) => {
  const e = new win.Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0 })
  return e
}

function stubRect(el, r) {
  el.getBoundingClientRect = () => ({ left: r[0], top: r[1], right: r[2], bottom: r[3], width: r[2] - r[0], height: r[3] - r[1], x: r[0], y: r[1] })
}

async function dragTaskTo(doc, win, taskId, x, y) {
  const item = doc.querySelector(`[data-palette-task][data-task-id="${taskId}"]`)
  assert.ok(item, `側欄要有任務 ${taskId}`)
  item.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  doc.dispatchEvent(pointer(win, 'pointermove', x, y))
  doc.dispatchEvent(pointer(win, 'pointerup', x, y))
  await settle()
}

const checkedSources = (doc) =>
  [...doc.querySelectorAll('#drawer-sources input[data-source-checkbox]')].filter(b => b.checked).map(b => b.value)
const legendCount = (doc, id) => cardEl(doc, id).querySelectorAll('.chart-legend-item').length

// ---- 驗收 1：未套用前 storage 位元組不變；套用恰好一次；取消回原樣 ----

test('改型別後未套用：storage 與開啟前位元組相同，畫面那張卡已是新型別的預覽', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line', { title: '電費走勢' })])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  const before = await cardJson(ls, did, ids[0])
  await openViaGear(doc, ids[0])
  assert.ok(drawerOpen(doc))
  await changeType(doc, win, 'text')
  assert.equal(await cardJson(ls, did, ids[0]), before, '未套用前 storage 不得改變')
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'text', '畫面上要看到新型別的預覽')
})

test('按套用：updateCard 恰好一次、storage 是新值、抽屜關閉', async () => {
  const { c, ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line')])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  await openViaGear(doc, ids[0])
  await changeType(doc, win, 'bar')
  const t = doc.getElementById('drawer-title')
  t.value = '新標題'
  fire(win, t, 'change')
  await settle()
  const writes = countLayoutWrites(c)
  doc.getElementById('drawer-apply').click()
  await settle()
  assert.equal(writes.n, 1, '套用只寫一次')
  const saved = await cardOf(ls, did, ids[0])
  assert.equal(saved.type, 'bar')
  assert.equal(saved.title, '新標題')
  assert.equal(drawerOpen(doc), false)
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'bar')
})

test('按取消：storage 不變、畫面回到原樣、抽屜關閉', async () => {
  const { c, ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line')])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  const before = await cardJson(ls, did, ids[0])
  await openViaGear(doc, ids[0])
  await changeType(doc, win, 'text')
  const writes = countLayoutWrites(c)
  doc.getElementById('drawer-cancel').click()
  await settle()
  assert.equal(writes.n, 0)
  assert.equal(await cardJson(ls, did, ids[0]), before)
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'line', '畫面要回到 storage 的樣子')
  assert.equal(drawerOpen(doc), false)
})

test('套用只寫有變的欄位：看不到的呈現選項與清單外的來源原樣保留', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('table', {
    source: [{ taskId: 'gone#k1' }, { taskId: 't2' }, { taskId: 't1' }],
    options: { mode: 'pivot', decimals: 2, unit: '元', yMin: 0, bucketMinutes: 1440, showDelta: true }
  })])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  await openViaGear(doc, ids[0])
  const t = doc.getElementById('drawer-title')
  t.value = '只改標題'
  fire(win, t, 'change')
  await settle()
  doc.getElementById('drawer-apply').click()
  await settle()
  const saved = await cardOf(ls, did, ids[0])
  assert.equal(saved.title, '只改標題')
  assert.deepEqual(saved.source.map(s => s.taskId), ['gone#k1', 't2', 't1'])
  assert.equal(saved.options.decimals, 2)
  assert.equal(saved.options.unit, '元')
  assert.equal(saved.options.yMin, 0)
  assert.equal(saved.options.bucketMinutes, 1440)
  assert.equal(saved.options.showDelta, true)
  assert.equal(saved.w, 6, '位置與大小不在草稿內，不得被改')
})

test('上下移欄序只改草稿；套用後才寫入', async () => {
  const { ls, db, doc } = await fresh()
  const { did, ids } = await seed(ls, [CARD('table', {
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }], options: { mode: 'pivot' }
  })])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  await openViaGear(doc, ids[0])
  doc.querySelector('#drawer-sources [data-source-row][data-task-id="t1"] [data-action="source-down"]').click()
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1', 't2'], '未套用不寫')
  assert.deepEqual(checkedSources(doc), ['t2', 't1'], '抽屜清單照草稿的欄序')
  doc.getElementById('drawer-apply').click()
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t2', 't1'])
})

test('還原鈕已刪除，底部動作列有「取消」與主要按鈕「套用」', async () => {
  const { doc } = await fresh()
  assert.equal(doc.getElementById('drawer-revert'), null)
  const apply = doc.getElementById('drawer-apply')
  const cancel = doc.getElementById('drawer-cancel')
  assert.equal(apply?.textContent.trim(), '套用')
  assert.equal(cancel?.textContent.trim(), '取消')
  assert.ok(apply.classList.contains('btn-primary'), '主要按鈕是「套用」')
  const footer = apply.closest('footer')
  assert.ok(footer && footer.contains(cancel), '兩顆在同一個底部動作列')
  assert.ok(doc.getElementById('card-drawer').contains(footer))
})

// ---- 驗收 2：有變更時的其他關閉方式要問 ----

async function dirtyDrawer() {
  const env = await fresh()
  const { ls, db, doc, win } = env
  const { did, ids } = await seed(ls, [CARD('line', { title: '原標題' })])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  const before = await cardJson(ls, did, ids[0])
  await openViaGear(doc, ids[0])
  const t = doc.getElementById('drawer-title')
  t.value = '改過的'
  fire(win, t, 'change')
  await settle()
  return { ...env, did, ids, before }
}

test('有變更時按 ✕ 出現對話框，選捨棄 → storage 不變、抽屜關閉', async () => {
  const { ls, doc, did, ids, before } = await dirtyDrawer()
  doc.getElementById('drawer-close').click()
  await settle()
  const dlg = modalOf(doc)
  assert.ok(dlg, '要出現確認框')
  assert.equal(dlg.querySelector('.modal-title').textContent, '要套用剛才的變更嗎？')
  const labels = [...dlg.querySelectorAll('button')].map(b => b.textContent)
  assert.deepEqual(labels.sort(), ['套用', '捨棄', '繼續編輯'].sort())
  const discard = dlg.querySelector('[data-action="extra"]')
  assert.equal(discard.textContent, '捨棄')
  assert.ok(!discard.classList.contains('btn-primary') && !discard.classList.contains('btn-danger'), '捨棄不是主要也不是危險樣式')
  assert.equal(dlg.querySelector('[data-action="confirm"]').textContent, '套用')
  assert.equal(dlg.querySelector('[data-action="cancel"]').textContent, '繼續編輯')
  discard.click()
  await settle()
  assert.equal(await cardJson(ls, did, ids[0]), before)
  assert.equal(drawerOpen(doc), false)
})

test('有變更時按 ✕ 選套用 → 寫入', async () => {
  const { ls, doc, did, ids } = await dirtyDrawer()
  doc.getElementById('drawer-close').click()
  await settle()
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await settle()
  assert.equal((await cardOf(ls, did, ids[0])).title, '改過的')
  assert.equal(drawerOpen(doc), false)
})

test('有變更時按 ✕ 選繼續編輯 → 抽屜仍開、草稿仍在，之後套用照樣寫入', async () => {
  const { ls, doc, did, ids, before } = await dirtyDrawer()
  doc.getElementById('drawer-close').click()
  await settle()
  const keep = modalOf(doc).querySelector('[data-action="cancel"]')
  assert.equal(keep.textContent, '繼續編輯')
  keep.click()
  await settle()
  assert.equal(modalOf(doc), null)
  assert.ok(drawerOpen(doc))
  assert.equal(doc.getElementById('drawer-title').value, '改過的', '草稿仍在')
  assert.equal(await cardJson(ls, did, ids[0]), before)
  doc.getElementById('drawer-apply').click()
  await settle()
  assert.equal((await cardOf(ls, did, ids[0])).title, '改過的')
})

test('沒有變更時按 ✕ 直接關、不出對話框', async () => {
  const { ls, db, doc } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line')])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  await openViaGear(doc, ids[0])
  doc.getElementById('drawer-close').click()
  await settle()
  assert.equal(modalOf(doc), null)
  assert.equal(drawerOpen(doc), false)
})

test('有變更時按 Esc 也要問；選捨棄後 storage 不變', async () => {
  const { ls, doc, win, did, ids, before } = await dirtyDrawer()
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  assert.ok(modalOf(doc), 'Esc 要出現確認框')
  modalOf(doc).querySelector('[data-action="extra"]').click()
  await settle()
  assert.equal(drawerOpen(doc), false)
  assert.equal(await cardJson(ls, did, ids[0]), before)
})

test('在確認框按 Esc：等於繼續編輯，抽屜仍開著、草稿仍在，也不會連帶再問一次', async () => {
  const { ls, doc, win, did, ids, before } = await dirtyDrawer()
  doc.getElementById('drawer-close').click()
  await settle()
  const dlg = modalOf(doc)
  dlg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()
  assert.equal(modalOf(doc), null, '不得再冒出第二個確認框')
  assert.ok(drawerOpen(doc), '抽屜仍開著')
  assert.equal(doc.getElementById('drawer-title').value, '改過的', '草稿仍在')
  assert.equal(await cardJson(ls, did, ids[0]), before)
  doc.getElementById('drawer-cancel').click()
  await settle()
})

test('有變更時點抽屜外要問；點抽屜裡不問', async () => {
  const { doc, win } = await dirtyDrawer()
  doc.getElementById('drawer-title').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await settle()
  assert.equal(modalOf(doc), null, '點抽屜裡不問')
  doc.querySelector('.app-bar').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await settle()
  assert.ok(modalOf(doc), '點抽屜外要問')
  // 收掉確認框：modal.js 與抽屜在本檔共用同一份模組實例，留著會帶進下一則測試
  modalOf(doc).querySelector('[data-action="extra"]').click()
  await settle()
  assert.equal(drawerOpen(doc), false)
})

test('有變更時打開另一張卡的抽屜要問；選繼續編輯就不換卡', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line', { title: 'A' }), CARD('line', { title: 'B', x: 6, source: [{ taskId: 't3', aggregation: 'raw' }] })])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  await openViaGear(doc, ids[0])
  const t = doc.getElementById('drawer-title')
  t.value = 'A 改'
  fire(win, t, 'change')
  await settle()
  cardEl(doc, ids[1]).querySelector('[data-action="config"]').click()
  await settle()
  assert.ok(modalOf(doc), '換卡要問')
  modalOf(doc).querySelector('[data-action="cancel"]').click()
  await settle()
  assert.equal(doc.getElementById('drawer-title').value, 'A 改', '仍在編輯 A')
  cardEl(doc, ids[1]).querySelector('[data-action="config"]').click()
  await settle()
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await settle()
  assert.equal((await cardOf(ls, did, ids[0])).title, 'A 改', '選套用寫入 A')
  assert.ok(drawerOpen(doc))
  assert.equal(doc.getElementById('drawer-title').value, 'B', '換成 B 的抽屜')
})

// ---- 驗收 3：抽屜開著時投放到同一張卡併進草稿 ----

test('抽屜開著時投放到該卡：storage 不變、來源清單多一項、預覽多一條序列；套用後才寫入', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line')])
  await db.renderDashboard(did)
  await ensureEditing(db, doc)
  await openViaGear(doc, ids[0])
  const before = await cardJson(ls, did, ids[0])
  assert.deepEqual(checkedSources(doc), ['t1'])
  assert.equal(legendCount(doc, ids[0]), 1)
  stubRect(cardEl(doc, ids[0]), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't2', 300, 100)
  assert.equal(await cardJson(ls, did, ids[0]), before, '投放不得直接寫 storage')
  assert.deepEqual(checkedSources(doc), ['t1', 't2'], '抽屜來源清單多一項')
  assert.equal(legendCount(doc, ids[0]), 2, '預覽多一條序列')
  assert.ok(drawerOpen(doc), '投放不得關抽屜')
  doc.getElementById('drawer-apply').click()
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1', 't2'])
  await ensureBrowsing(db, doc)
})

test('抽屜開著時投放到草稿已有的來源不重複（同一套去重）', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line')])
  await db.renderDashboard(did)
  await ensureEditing(db, doc)
  await openViaGear(doc, ids[0])
  const box = doc.querySelector('#drawer-sources input[value="t2"]')
  box.checked = true
  fire(win, box, 'change')
  await settle()
  stubRect(cardEl(doc, ids[0]), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't2', 300, 100)
  assert.deepEqual(checkedSources(doc), ['t1', 't2'])
  assert.equal(legendCount(doc, ids[0]), 2)
  await ensureBrowsing(db, doc)
})

test('抽屜開著時投放到另一張卡照舊立即寫入，編輯中的卡不受影響', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line'), CARD('line', { x: 6, source: [{ taskId: 't3', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await ensureEditing(db, doc)
  await openViaGear(doc, ids[0])
  const editedBefore = await cardJson(ls, did, ids[0])
  stubRect(cardEl(doc, ids[0]), [0, 0, 600, 200])
  stubRect(cardEl(doc, ids[1]), [600, 0, 1200, 200])
  await dragTaskTo(doc, win, 't2', 900, 100)
  assert.deepEqual((await cardOf(ls, did, ids[1])).source.map(s => s.taskId), ['t3', 't2'], '另一張卡立即寫入')
  assert.equal(await cardJson(ls, did, ids[0]), editedBefore)
  assert.deepEqual(checkedSources(doc), ['t1'], '編輯中那張卡的草稿不變')
  await ensureBrowsing(db, doc)
})

test('抽屜開著時從同一張卡拖出移除把手：storage 不變、草稿與預覽少一條；套用後才寫入', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line', { source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await ensureEditing(db, doc)
  await openViaGear(doc, ids[0])
  const before = await cardJson(ls, did, ids[0])
  assert.equal(legendCount(doc, ids[0]), 2)
  stubRect(cardEl(doc, ids[0]), [0, 0, 600, 200])
  const handle = cardEl(doc, ids[0]).querySelector('[data-remove-source][data-task-id="t2"]')
  assert.ok(handle, '要有 t2 的移除把手')
  handle.dispatchEvent(pointer(win, 'pointerdown', 100, 100))
  doc.dispatchEvent(pointer(win, 'pointermove', 800, 600))
  doc.dispatchEvent(pointer(win, 'pointerup', 800, 600))
  await settle()
  assert.equal(await cardJson(ls, did, ids[0]), before, '移除不得直接寫 storage')
  assert.deepEqual(checkedSources(doc), ['t1'], '草稿少一項')
  assert.equal(legendCount(doc, ids[0]), 1, '預覽少一條')
  assert.ok(drawerOpen(doc))
  doc.getElementById('drawer-apply').click()
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1'])
  await ensureBrowsing(db, doc)
})

test('抽屜開著時從另一張卡拖出移除把手照舊立即寫入', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line'), CARD('line', { x: 6, source: [{ taskId: 't2', aggregation: 'raw' }, { taskId: 't3', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await ensureEditing(db, doc)
  await openViaGear(doc, ids[0])
  stubRect(cardEl(doc, ids[0]), [0, 0, 600, 200])
  stubRect(cardEl(doc, ids[1]), [600, 0, 1200, 200])
  const handle = cardEl(doc, ids[1]).querySelector('[data-remove-source][data-task-id="t3"]')
  handle.dispatchEvent(pointer(win, 'pointerdown', 700, 100))
  doc.dispatchEvent(pointer(win, 'pointermove', 800, 600))
  doc.dispatchEvent(pointer(win, 'pointerup', 800, 600))
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[1])).source.map(s => s.taskId), ['t2'])
  assert.deepEqual(checkedSources(doc), ['t1'])
  doc.getElementById('drawer-cancel').click()
  await settle()
  await ensureBrowsing(db, doc)
})

// ---- 驗收 4：紀錄變動重畫時，編輯中的卡仍顯示草稿預覽 ----

test('抽屜開著時整個儀表板重畫，那張卡仍顯示草稿預覽', async () => {
  const { ls, st, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line'), CARD('line', { x: 6, source: [{ taskId: 't3', aggregation: 'raw' }] })])
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  await openViaGear(doc, ids[0])
  await changeType(doc, win, 'text')
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'text')
  // 紀錄變動 → 儀表板重畫（report.js 的 refreshCurrentView 走的就是 renderDashboard）
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  await st.appendRecord(day, { taskId: 't1', slot: `${day}T09:00`, capturedAt: `${day}T09:00:00`, value: 5, raw: '5', status: 'ok' })
  await db.renderDashboard(did)
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'text', '不得被 storage 版本蓋回去')
  assert.equal(cardEl(doc, ids[1]).dataset.cardType, 'line', '其他卡照 storage')
  assert.equal((await cardOf(ls, did, ids[0])).type, 'line')
  // 關掉之後重畫就回到 storage 版本
  doc.getElementById('drawer-cancel').click()
  await settle()
  await db.renderDashboard(did)
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'line')
})

// ---- 教學頁 ----

test('教學頁說的是點卡片右上的齒輪開設定，並提到套用', () => {
  const help = readFileSync(new URL('../src/ui/help/help.html', import.meta.url), 'utf8')
  assert.ok(!help.includes('點卡片開設定'), '實際是點齒輪，不是點卡片')
  assert.ok(help.includes('齒輪'))
  assert.ok(help.includes('「套用」'))
})
