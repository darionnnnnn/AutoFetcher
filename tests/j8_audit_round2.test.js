// AF-4 終檢第二批:投放語意、拖曳狀態、圖例色號
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
  for (const [id, name] of [['t1', '電費'], ['t2', '水費'], ['t3', '瓦斯']]) await st.saveTask(task(id, name))
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

const pointer = (win, type, x, y, over = {}) => {
  const e = new win.Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0, ...over })
  return e
}
const settle = () => new Promise(r => setTimeout(r, 30))
function stubRect(el, r) {
  el.getBoundingClientRect = () => ({ left: r[0], top: r[1], right: r[2], bottom: r[3], width: r[2] - r[0], height: r[3] - r[1], x: r[0], y: r[1] })
}
async function seedRecords(st, ids) {
  const d = new Date(); const p = n => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  for (const id of ids) {
    await st.appendRecord(day, { taskId: id, slot: `${day}T09:00`, capturedAt: new Date(`${day}T09:00:00`).toISOString(), value: 1, raw: '1', status: 'ok' })
  }
}
const cardOf = async (ls, did, id) => (await ls.getLayout()).dashboards.find(d => d.id === did).cards.find(c => c.id === id)

async function editable(ls, db, doc, cards) {
  const did = (await ls.getLayout()).dashboards[0].id
  const ids = []
  for (const c of cards) ids.push((await ls.addCard(did, c)).id)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await settle()
  return { did, ids }
}

test('把表格最後一欄拖到最前面(既有欄位重新排序)', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2', 't3'])
  const { did, ids } = await editable(ls, db, doc, [{
    type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }, { taskId: 't3', aggregation: 'raw' }],
    options: { mode: 'pivot' }
  }])
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 800, 200])
  const ths = [...el.querySelectorAll('thead th')]
  stubRect(ths[0], [0, 0, 200, 40]); stubRect(ths[1], [200, 0, 400, 40])
  stubRect(ths[2], [400, 0, 600, 40]); stubRect(ths[3], [600, 0, 800, 40])
  const item = doc.querySelector('[data-palette-task][data-task-id="t3"]')
  item.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  item.dispatchEvent(pointer(win, 'pointermove', 250, 100))
  item.dispatchEvent(pointer(win, 'pointerup', 250, 100))
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t3', 't1', 't2'],
    '已經在最後一欄的任務要能被拖到前面,不能整個沒反應')
})

test('最近 N 筆模式的表格不會用固定表頭去算欄位插入位置', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await editable(ls, db, doc, [{
    type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't3', aggregation: 'raw' }],
    options: { mode: 'recent' }
  }])
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 800, 200])
  for (const [i, th] of [...el.querySelectorAll('thead th')].entries()) stubRect(th, [i * 200, 0, (i + 1) * 200, 40])
  const item = doc.querySelector('[data-palette-task][data-task-id="t2"]')
  item.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  // 落在左半:若誤把固定表頭當成資料欄,索引會算成 0 而插到最前面
  item.dispatchEvent(pointer(win, 'pointermove', 250, 100))
  item.dispatchEvent(pointer(win, 'pointerup', 250, 100))
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1', 't3', 't2'],
    '最近 N 筆的表頭是固定四欄,與來源無關,不可拿來算插入位置')
})

test('狀態卡片的任務可以拖進去也可以拖出來', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await editable(ls, db, doc, [{
    type: 'status', x: 0, y: 0, w: 6, h: 2, source: [], options: { taskIds: ['t1', 't2'] }
  }])
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 600, 200])
  const handle = el.querySelector('[data-remove-source][data-task-id="t1"]')
  assert.ok(handle, '狀態卡片加得進去就要拿得出來')
  handle.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  handle.dispatchEvent(pointer(win, 'pointermove', 900, 700))
  handle.dispatchEvent(pointer(win, 'pointerup', 900, 700))
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).options.taskIds, ['t2'])
})

test('把欄位拖到側欄放開也算移除(使用者最直覺的丟掉方式)', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await editable(ls, db, doc, [{
    type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
    options: { mode: 'pivot' }
  }])
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [400, 0, 1000, 200])
  const palette = doc.getElementById('source-palette')
  stubRect(palette, [0, 0, 220, 800])
  const handle = el.querySelector('[data-remove-source][data-task-id="t1"]')
  handle.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  handle.dispatchEvent(pointer(win, 'pointermove', 100, 400))
  handle.dispatchEvent(pointer(win, 'pointerup', 100, 400))
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t2'])
})

test('圖例色號與線條色號一致(來源含髒資料時也不可偏移)', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const el = CR.renderCard({
    id: 'c1', type: 'line', x: 0, y: 0, w: 6, h: 2,
    source: [{ aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }], options: {}
  }, {
    records: [], tasksById: { t2: { name: '水費' } }, health: {}, nextRuns: {}, missed: [],
    range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06', editing: true
  })
  const dot = el.querySelector('.chart-legend-dot')
  assert.ok(dot, '要有圖例色點')
  assert.ok(/--chart-2/.test(dot.style.backgroundColor),
    `t2 是 source 的第二項,色號應為 --chart-2,實得:${dot.style.backgroundColor}`)
})
