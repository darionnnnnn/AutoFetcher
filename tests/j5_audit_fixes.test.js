// AF-4 終檢修正:定案未落實的六項
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

// ---- 1. 樞紐表未設 limit 時的預設列數上限 ----

test('樞紐表沒設 limit 時仍有預設上限,不會渲染上千列', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const records = Array.from({ length: 300 }, (_, i) => {
    const h = String(Math.floor(i / 60)).padStart(2, '0')
    const m = String(i % 60).padStart(2, '0')
    return { taskId: 't1', slot: `2026-09-06T${h}:${m}`, capturedAt: `2026-09-06T${h}:${m}:00`, value: i, raw: String(i), status: 'ok', date: '2026-09-06' }
  })
  const el = CR.renderCard({
    id: 'c1', type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 't1', aggregation: 'raw' }], options: { mode: 'pivot' }
  }, {
    records, tasksById: { t1: { id: 't1', name: '電費', mode: 'number' } },
    health: {}, nextRuns: {}, missed: [], range: { from: '2026-09-01', to: '2026-09-30' }, today: '2026-09-06'
  })
  const rows = el.querySelectorAll('tbody tr').length
  assert.ok(rows > 0 && rows <= 50, `未設 limit 應有預設上限(50),實得 ${rows} 列`)
})

test('明確設定的 limit 仍然優先於預設', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const records = Array.from({ length: 100 }, (_, i) => ({
    taskId: 't1', slot: `2026-09-06T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    capturedAt: '2026-09-06T00:00:00', value: i, raw: String(i), status: 'ok', date: '2026-09-06'
  }))
  const el = CR.renderCard({
    id: 'c1', type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 't1' }], options: { mode: 'pivot', limit: 3 }
  }, {
    records, tasksById: { t1: { name: '電費' } }, health: {}, nextRuns: {}, missed: [],
    range: { from: '2026-09-01', to: '2026-09-30' }, today: '2026-09-06'
  })
  assert.equal(el.querySelectorAll('tbody tr').length, 3)
})

// ---- 2. 「有效時刻」只有一份 ----

test('紀錄的有效時刻由 series.js 提供唯一一份實作', async () => {
  const S = await import('../src/ui/report/series.js?t=' + Math.random())
  assert.equal(typeof S.effectiveTimeOf, 'function', '要有共用的有效時刻函式')
  assert.equal(S.effectiveTimeOf({ slot: '2026-09-06T09:00', capturedAt: '2026-09-06T10:00:00' }), '2026-09-06T09:00', 'slot 優先')
  assert.equal(S.effectiveTimeOf({ capturedAt: '2026-09-06T10:00:41' }), '2026-09-06T10:00', '沒有 slot 時用 capturedAt 截到分鐘')
  assert.equal(S.effectiveTimeOf({}), '')
  assert.equal(S.effectiveTimeOf(null), '')
})

test('cards.js 用同一份有效時刻做期間篩選', async () => {
  const src = readFileSync(new URL('../src/ui/report/cards.js', import.meta.url), 'utf8')
  assert.ok(/effectiveTimeOf/.test(src), 'cards.js 應改用共用函式,不可自己再寫一份 slot||capturedAt 的切法')
})

// ---- 3. renameDashboard 空字串 ----

test('儀表板改名成空白時忽略,保留原名', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  await ls.renameDashboard(did, '我的儀表板')
  for (const bad of ['', '   ', null, undefined, 123]) {
    await ls.renameDashboard(did, bad)
    const after = (await ls.getLayout()).dashboards.find(d => d.id === did)
    assert.equal(after.name, '我的儀表板', `改名成 ${JSON.stringify(bad)} 應被忽略`)
  }
  await ls.renameDashboard(did, '  改過的  ')
  assert.equal((await ls.getLayout()).dashboards.find(d => d.id === did).name, '改過的', '前後空白要修掉')
})

// ---- 4~6:側欄與建卡 ----

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
  await st.saveTask(task('t2', '公告', 'text'))
  await st.saveTask(task('t3', '用量', 'block'))
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

async function dropTaskAt(doc, win, taskId, x, y) {
  const item = doc.querySelector(`[data-palette-task][data-task-id="${taskId}"]`)
  item.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  item.dispatchEvent(pointer(win, 'pointermove', x, y))
  item.dispatchEvent(pointer(win, 'pointerup', x, y))
  await settle()
}

const cardsOf = async (ls, did) => (await ls.getLayout()).dashboards.find(d => d.id === did).cards

test('側欄看得出任務的抓取模式', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await settle()
  const textItem = doc.querySelector('[data-palette-task][data-task-id="t2"]')
  assert.ok(textItem.textContent.includes('公告'), '要有名稱')
  assert.ok(/文字/.test(textItem.textContent) || textItem.dataset.mode === 'text',
    `要看得出是文字模式,實得:${textItem.textContent}`)
  const blockItem = doc.querySelector('[data-palette-task][data-task-id="t3"]')
  assert.ok(/區塊|表格/.test(blockItem.textContent) || blockItem.dataset.mode === 'block',
    `要看得出是區塊模式,實得:${blockItem.textContent}`)
})

test('文字模式的任務拖到空白處建的是最近 N 筆的表格卡', async () => {
  const { ls, db, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await settle()
  await dropTaskAt(doc, win, 't2', 600, 400)
  const cards = await cardsOf(ls, did)
  assert.equal(cards[0].type, 'table')
  assert.equal(cards[0].options.mode, 'recent', '文字內容用樞紐表看不出所以然,應為最近 N 筆')
})

test('新卡片建在落點附近,不是永遠塞回版面最前面', async () => {
  const { ls, db, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await settle()
  // 格線 1200x800、12 欄、每列 80px:落在 (600, 400) 約為第 6 欄、第 5 列
  await dropTaskAt(doc, win, 't1', 600, 400)
  const c = (await cardsOf(ls, did))[0]
  assert.ok(c.y >= 3, `落在下方應建在下方,實得 y=${c.y}`)
  assert.ok(c.x >= 4, `落在中間偏右應建在該處,實得 x=${c.x}`)
})

test('落點被既有卡片佔住時仍要找得到不重疊的位置', async () => {
  const { ls, db, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 6, y: 5, w: 3, h: 2, source: [{ taskId: 't1' }], options: {} })
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await settle()
  await dropTaskAt(doc, win, 't3', 600, 400)
  const cards = await cardsOf(ls, did)
  assert.equal(cards.length, 2)
  const [a, b] = cards
  const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert.equal(overlap, false, `不可重疊:${JSON.stringify([a, b])}`)
})

test('窄視窗時側欄不與格線搶寬度', async () => {
  const css = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const hasNarrowRule = /@media[^{]*max-width:\s*(768|900)px[^{]*\{[\s\S]*?(#source-palette|\.dashboard-layout)/.test(css)
  assert.ok(hasNarrowRule, '窄視窗要有側欄的版面規則(改為整列或收合)')
})
