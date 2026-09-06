// AF-4 C2b:資料來源側欄與投放到卡片的接線
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

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task('t1', '電費'))
  await st.saveTask(task('t2', '水費'))
  await st.saveTask(task('t3', '公告', 'text'))
  await st.saveTask({ ...task('t4', '停用的'), enabled: false })
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  return { st, ls, db, doc: jd.window.document, win: jd.window }
}

async function seed(ls, cards) {
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  const ids = []
  for (const c of cards) ids.push((await ls.addCard(did, c)).id)
  return { did, ids }
}

const CARD = (type, over = {}) => ({ type, x: 0, y: 0, w: 6, h: 2, source: [], options: {}, ...over })

const pointer = (win, type, x, y, over = {}) => {
  const e = new win.Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0, ...over })
  return e
}
const settle = () => new Promise(r => setTimeout(r, 30))

// 讓卡片元素有可命中的矩形
function stubRect(el, rect) {
  el.getBoundingClientRect = () => ({
    left: rect[0], top: rect[1], right: rect[2], bottom: rect[3],
    width: rect[2] - rect[0], height: rect[3] - rect[1], x: rect[0], y: rect[1]
  })
}

async function enterEditMode(doc) {
  doc.getElementById('edit-layout').click()
  await settle()
}

async function dragTaskTo(doc, win, taskId, x, y) {
  const item = doc.querySelector(`[data-palette-task][data-task-id="${taskId}"]`)
  assert.ok(item, `側欄要有任務 ${taskId}`)
  item.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  doc.dispatchEvent(pointer(win, 'pointermove', x, y))
  doc.dispatchEvent(pointer(win, 'pointerup', x, y))
  await settle()
}

const cardOf = async (ls, did, cardId) =>
  (await ls.getLayout()).dashboards.find(d => d.id === did).cards.find(c => c.id === cardId)

// ---- 側欄 ----

test('編輯模式才顯示資料來源側欄', async () => {
  const { ls, db, doc } = await fresh()
  const { did } = await seed(ls, [CARD('number', { source: [{ taskId: 't1' }] })])
  await db.renderDashboard(did)
  const palette = doc.getElementById('source-palette')
  assert.ok(palette, '要有側欄容器')
  assert.equal(palette.hidden, true, '瀏覽模式不該出現')
  await enterEditMode(doc)
  assert.equal(palette.hidden, false, '編輯模式要出現')
})

test('側欄列出啟用中的任務,停用的不列', async () => {
  const { ls, db, doc } = await fresh()
  const { did } = await seed(ls, [CARD('number')])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  const ids = [...doc.querySelectorAll('[data-palette-task]')].map(el => el.dataset.taskId)
  assert.deepEqual(ids.sort(), ['t1', 't2', 't3'])
})

test('側欄顯示任務名稱,並可搜尋過濾', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did } = await seed(ls, [CARD('number')])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  assert.ok(doc.getElementById('source-palette').textContent.includes('電費'))
  const search = doc.getElementById('palette-search')
  assert.ok(search, '要有搜尋框')
  search.value = '水'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  const shown = [...doc.querySelectorAll('[data-palette-task]')].filter(el => !el.hidden).map(el => el.dataset.taskId)
  assert.deepEqual(shown, ['t2'])
})

// ---- 投放到卡片 ----

test('拖到表格卡片會加一欄', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('table', { source: [{ taskId: 't1', aggregation: 'raw' }], options: { mode: 'pivot' } })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't2', 300, 100)
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1', 't2'])
})

test('拖到折線卡片會追加一條序列', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line', { source: [{ taskId: 't1', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't2', 300, 100)
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1', 't2'])
})

test('拖到數值卡片會取代原本的來源', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('number', { source: [{ taskId: 't1', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 300, 200])
  await dragTaskTo(doc, win, 't2', 150, 100)
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t2'])
})

test('拖到文字卡片不會有任何改變', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('text', { options: { content: '說明' } })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 300, 200])
  await dragTaskTo(doc, win, 't1', 150, 100)
  assert.deepEqual((await cardOf(ls, did, ids[0])).source, [])
})

test('瀏覽模式下拖曳不生效', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('table', { source: [{ taskId: 't1' }] })])
  await db.renderDashboard(did)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 600, 200])
  const item = doc.querySelector('[data-palette-task][data-task-id="t2"]')
  assert.ok(!item || item.offsetParent === null || doc.getElementById('source-palette').hidden,
    '瀏覽模式側欄應該是隱藏的')
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1'])
})

test('投放後可以用復原回到原狀', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line', { source: [{ taskId: 't1', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't2', 300, 100)
  assert.equal((await cardOf(ls, did, ids[0])).source.length, 2)
  await db.undo()
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1'], '復原要回到只有一條序列')
})

test('沒有造成改變的投放不進復原堆疊', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line', { source: [{ taskId: 't1', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  const before = db.historySize()
  await dragTaskTo(doc, win, 't1', 300, 100)
  assert.equal(db.historySize(), before, '拖同一個任務進去沒變化,不該佔用一步復原')
})

test('投放後畫面立即反映(卡片重畫)', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('table', { source: [{ taskId: 't1', aggregation: 'raw' }], options: { mode: 'pivot' } })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't2', 300, 100)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  assert.ok(el.textContent.includes('水費'), `卡片要立刻出現新欄位,實得:${el.textContent.slice(0, 60)}`)
})

test('折線卡片已有 8 條序列時再拖會顯示提示且不改動', async () => {
  const { st, ls, db, doc, win } = await fresh()
  for (let i = 0; i < 8; i++) await st.saveTask(task(`s${i}`, `序列${i}`))
  const source = Array.from({ length: 8 }, (_, i) => ({ taskId: `s${i}`, aggregation: 'raw' }))
  const { did, ids } = await seed(ls, [CARD('line', { source })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't1', 300, 100)
  assert.equal((await cardOf(ls, did, ids[0])).source.length, 8, '超過上限不可加進去')
  const toast = doc.getElementById('dnd-toast')
  assert.ok(toast && !toast.hidden && toast.textContent.length > 0, '要告訴使用者為什麼沒加進去')
})
