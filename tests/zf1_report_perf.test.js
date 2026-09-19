// AF-21 段 6-A：Report 只在「看得到的資料變了」才重畫、儀表板輕量重畫、圖表抽樣
// 儀表板、抽屜、浮層、report 用同一份模組實例（不帶 ?t=），跟正式頁面一樣共用狀態
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, name) => ({
  id, name, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

const CARD = (type, over = {}) => ({ type, x: 0, y: 0, w: 6, h: 2, source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over })

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms))
const pad = (n) => String(n).padStart(2, '0')
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY = dayOf(new Date())
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dayOf(d) }

const isRecKey = (k) => typeof k === 'string' && (k.startsWith('rec:') || k.startsWith('rec2:'))

// 數「讀紀錄」的次數：chrome.storage.local.get 的鍵裡有紀錄鍵就算一次
function countRecordReads(c) {
  const real = c.storage.local.get.bind(c.storage.local)
  const counter = { n: 0 }
  c.storage.local.get = (keys, ...rest) => {
    const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : [])
    if (list.some(isRecKey)) counter.n++
    return real(keys, ...rest)
  }
  return counter
}

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js')
  await st.init()
  await st.saveTask(task('t1', '電費'))
  await st.saveTask(task('t2', '水費'))
  const ls = await import('../src/shared/layout-store.js')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const db = await import('../src/ui/report/dashboard.js')
  const rp = await import('../src/ui/report/report.js')
  const tp = await import('../src/ui/report/trend-popover.js')
  return { c, st, ls, db, rp, tp, doc: jd.window.document, win: jd.window }
}

async function seedCards(ls, cards) {
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  // 前一個測試留下的卡片先清掉（同一份模組實例、每次都是新的 storage，這裡只是保險）
  const ids = []
  for (const card of cards) ids.push((await ls.addCard(did, card)).id)
  return { did, ids }
}

const rec = (taskId, day, hh, value) => ({ taskId, slot: `${day}T${hh}:00`, capturedAt: `${day}T${hh}:00:00`, value, raw: String(value), status: 'ok' })
const recChange = (day, hh = '09') => ({ keys: new Set([`rec2:${day}:${hh}`]), dates: new Set([day]) })
const cardEl = (doc, id) => doc.querySelector(`[data-card-id="${id}"]`)
const numberText = (doc, id) => cardEl(doc, id)?.querySelector('.card-number-value')?.textContent

async function ensureBrowsing(db, doc) {
  if (db.isEditing()) {
    doc.getElementById('edit-layout').click()
    await settle()
  }
}

// ---------- 驗收 1：subscribe 帶出變動 ----------

test('1 subscribe：handler 收到 keys 與 dates，同一去抖窗口合併成一次', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const calls = []
  st.subscribe((change) => { calls.push(change) })
  await c.storage.local.set({ 'rec2:2026-09-18:09': [{ taskId: 'a' }] })
  await c.storage.local.set({ 'rec:2026-09-17': [{ taskId: 'b' }] })
  await c.storage.local.set({ lastValues: { a: 1 } })
  await c.storage.local.set({ 'runs:2026-09-18': { a: {} } })
  await settle(120)
  assert.equal(calls.length, 1, '同一窗口的多次變動只呼叫一次')
  const { keys, dates } = calls[0]
  assert.ok(keys instanceof Set && dates instanceof Set)
  assert.deepEqual([...dates].sort(), ['2026-09-17', '2026-09-18'])
  assert.deepEqual([...keys].sort(), ['lastValues', 'rec2:2026-09-18:09', 'rec:2026-09-17'])
  // 下一個窗口從空的開始累積
  await c.storage.local.set({ layout: { v: 1 } })
  await settle(120)
  assert.equal(calls.length, 2)
  assert.deepEqual([...calls[1].keys], ['layout'])
  assert.equal(calls[1].dates.size, 0)
})

test('1 subscribe：不讀參數的舊 handler 照舊被呼叫；opts.keys 模式照舊拿 changes', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  let hits = 0
  st.subscribe(() => { hits++ })
  let got = null
  st.subscribe((changes) => { got = changes }, { keys: ['settings'] })
  await c.storage.local.set({ settings: { a: 1 } })
  await st.appendRecord('2026-09-18', rec('a', '2026-09-18', '09', 1))
  await settle(120)
  assert.equal(hits, 1)
  assert.ok(got && Object.prototype.hasOwnProperty.call(got, 'settings'), 'keys 模式拿到的是原始 changes')
})

// ---------- 驗收 2：歷史頁沒有交集就不動 ----------

test('2 歷史頁：範圍是上週、今天的紀錄變動 → 讀紀錄零次、DOM 同一批；範圍含今天 → 重新篩選', async () => {
  const { c, st, rp, doc } = await fresh()
  await st.appendRecord(daysAgo(7), rec('t1', daysAgo(7), '09', 3))
  rp.initFromHash(`#view=history&from=${daysAgo(8)}&to=${daysAgo(6)}`)
  rp.showTab('history')
  await rp.refreshCurrentView()
  await settle()
  const panel = doc.getElementById('panel-history')
  const before = [...panel.querySelectorAll('*')]
  assert.ok(before.length > 0, '歷史頁要先畫出東西')
  await st.appendRecord(TODAY, rec('t1', TODAY, '09', 5))
  const reads = countRecordReads(c)
  await rp.refreshCurrentView(recChange(TODAY))
  await settle()
  assert.equal(reads.n, 0, '沒有交集不得讀紀錄')
  const after = [...panel.querySelectorAll('*')]
  assert.equal(after.length, before.length)
  assert.ok(after.every((el, i) => el === before[i]), 'DOM 節點必須是同一批物件')

  // 範圍含今天 → 重新篩選
  rp.initFromHash(`#view=history&from=${daysAgo(1)}&to=${TODAY}`)
  rp.showTab('history')
  const reads2 = countRecordReads(c)
  await rp.refreshCurrentView(recChange(TODAY))
  await settle()
  assert.ok(reads2.n >= 1, '有交集要重讀紀錄')
  assert.ok(panel.textContent.includes('5'), '新紀錄要出現在歷史頁')
})

test('2 任務頁同樣受交集規則；tasks 變動一律重畫', async () => {
  const { c, rp, doc } = await fresh()
  rp.initFromHash(`#view=tasks&from=${daysAgo(8)}&to=${daysAgo(6)}`)
  await rp.showTab('tasks')
  await settle()
  const list = doc.getElementById('task-list')
  const first = list.firstElementChild
  assert.ok(first, '任務頁要有列')
  let sends = 0
  const realSend = c.runtime.sendMessage
  c.runtime.sendMessage = (...a) => { sends++; return realSend(...a) }
  await rp.refreshCurrentView(recChange(TODAY))
  await settle()
  assert.equal(sends, 0, '沒有交集不重畫任務頁')
  assert.equal(list.firstElementChild, first)
  await rp.refreshCurrentView({ keys: new Set(['tasks']), dates: new Set() })
  await settle()
  assert.ok(sends >= 1, 'tasks 變動要重畫')
  c.runtime.sendMessage = realSend
})

// ---------- 驗收 3：儀表板輕量重畫 ----------

test('3 儀表板只有紀錄變動 → 讀一次、側欄與頁籤是同一個物件、卡片換成新值；layout 變動 → 整份重畫', async () => {
  const { c, st, ls, db, rp, doc } = await fresh()
  const { did, ids } = await seedCards(ls, [CARD('number')])
  await st.appendRecord(TODAY, rec('t1', TODAY, '08', 5))
  rp.initFromHash(`#view=dashboard&dash=${did}`)
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  assert.equal(numberText(doc, ids[0]), '5')
  const tabsBefore = [...doc.getElementById('dashboard-tabs').children]
  const paletteBefore = [...doc.getElementById('palette-list').children]
  const grid = doc.getElementById('dashboard-grid')
  assert.ok(tabsBefore.length > 0 && paletteBefore.length > 0, '頁籤與側欄要先畫出東西')

  await st.appendRecord(TODAY, rec('t1', TODAY, '09', 7))
  const reads = countRecordReads(c)
  await rp.refreshCurrentView(recChange(TODAY))
  await settle()
  assert.equal(reads.n, 1, '輕量重畫只讀一次紀錄')
  assert.equal(numberText(doc, ids[0]), '7', '卡片內容要更新')
  const tabsAfter = [...doc.getElementById('dashboard-tabs').children]
  const paletteAfter = [...doc.getElementById('palette-list').children]
  assert.ok(tabsAfter.length === tabsBefore.length && tabsAfter.every((el, i) => el === tabsBefore[i]), '頁籤不得重建')
  assert.ok(paletteAfter.length === paletteBefore.length && paletteAfter.every((el, i) => el === paletteBefore[i]), '側欄不得重建')
  assert.equal(doc.getElementById('dashboard-grid'), grid)

  // 儀表板範圍（含卡片區間）只到今天：上週的紀錄變動不讀
  const reads0 = countRecordReads(c)
  await rp.refreshCurrentView(recChange(daysAgo(20)))
  await settle()
  assert.equal(reads0.n, 0, '與儀表板範圍沒有交集不讀紀錄')

  // layout 變動 → 整份重畫
  await rp.refreshCurrentView({ keys: new Set(['layout']), dates: new Set() })
  await settle()
  const tabsFull = [...doc.getElementById('dashboard-tabs').children]
  assert.ok(tabsFull.length > 0 && tabsFull[0] !== tabsBefore[0], 'layout 變動要整份重畫（頁籤重建）')
})

test('3 趨勢浮層開著 → 延後、浮層沒被關；關掉之後補一次', async () => {
  const { c, st, ls, db, rp, tp, doc } = await fresh()
  const { did, ids } = await seedCards(ls, [CARD('number')])
  await st.appendRecord(TODAY, rec('t1', TODAY, '08', 5))
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  cardEl(doc, ids[0]).querySelector('.card-number-value').click()
  await settle()
  assert.ok(doc.querySelector('[data-trend-popover]'), '浮層要開著')
  await st.appendRecord(TODAY, rec('t1', TODAY, '09', 7))
  const reads = countRecordReads(c)
  await rp.refreshCurrentView(recChange(TODAY))
  await settle()
  assert.equal(reads.n, 0, '浮層開著時延後')
  assert.ok(doc.querySelector('[data-trend-popover]'), '浮層不得被關')
  assert.equal(numberText(doc, ids[0]), '5')
  tp.closeTrendPopover()
  await settle()
  assert.equal(reads.n, 1, '關掉之後補一次')
  assert.equal(numberText(doc, ids[0]), '7')
})

// ---------- 驗收 4：編輯模式、抽屜延後 ----------

test('4 編輯模式中收到變動不重畫；離開編輯模式後補一次', async () => {
  const { c, st, ls, db, rp, doc } = await fresh()
  const { did, ids } = await seedCards(ls, [CARD('number')])
  await st.appendRecord(TODAY, rec('t1', TODAY, '08', 5))
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await settle()
  assert.equal(db.isEditing(), true)
  const elBefore = cardEl(doc, ids[0])
  await st.appendRecord(TODAY, rec('t1', TODAY, '09', 7))
  const reads = countRecordReads(c)
  await rp.refreshCurrentView(recChange(TODAY))
  await rp.refreshCurrentView({ keys: new Set(['layout']), dates: new Set() })
  await settle()
  assert.equal(reads.n, 0, '編輯中不重畫')
  assert.equal(cardEl(doc, ids[0]), elBefore)
  assert.equal(numberText(doc, ids[0]), '5')
  doc.getElementById('edit-layout').click()
  await settle()
  assert.equal(db.isEditing(), false)
  assert.equal(numberText(doc, ids[0]), '7', '離開編輯模式後補一次')
})

test('4 抽屜開著時延後、那張卡顯示草稿；關掉後補一次', async () => {
  const { c, st, ls, db, rp, doc, win } = await fresh()
  const { did, ids } = await seedCards(ls, [CARD('line'), CARD('number', { x: 6 })])
  await st.appendRecord(TODAY, rec('t1', TODAY, '08', 5))
  await ensureBrowsing(db, doc)
  await db.renderDashboard(did)
  cardEl(doc, ids[0]).querySelector('[data-action="config"]').click()
  await settle()
  const sel = doc.getElementById('drawer-type')
  sel.value = 'text'
  sel.dispatchEvent(new win.Event('change', { bubbles: true }))
  await settle()
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'text', '草稿預覽')
  await st.appendRecord(TODAY, rec('t1', TODAY, '09', 7))
  const reads = countRecordReads(c)
  await rp.refreshCurrentView(recChange(TODAY))
  await settle()
  assert.equal(reads.n, 0, '抽屜開著時延後')
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'text', '抽屜那張卡仍是草稿')
  assert.equal(numberText(doc, ids[1]), '5')
  // 延後期間若有整份重畫（例如別處觸發），草稿預覽照舊不退化
  await db.renderDashboard(did)
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'text')
  doc.getElementById('drawer-cancel').click()
  await settle(80)
  assert.ok(reads.n >= 1, '關掉之後補一次')
  assert.equal(numberText(doc, ids[1]), '7')
  assert.equal(cardEl(doc, ids[0]).dataset.cardType, 'line', '關掉後回到 storage 版本')
})

// ---------- 驗收 5：抽樣 ----------

test('5 抽樣：10000 點含一個尖峰 → ≤600、尖峰在內、時間遞增；599 點原樣', async () => {
  const { downsamplePoints } = await import('../src/ui/report/series.js')
  const base = Date.UTC(2026, 8, 1)
  const pts = []
  for (let i = 0; i < 10000; i++) {
    pts.push({ t: new Date(base + i * 60000).toISOString(), v: 10 + (i % 7) * 0.1 })
  }
  pts[4321].v = 999
  pts[7777].v = -50
  const res = downsamplePoints(pts)
  assert.equal(res.sampled, true)
  assert.equal(res.original, 10000)
  assert.ok(res.points.length <= 600 && res.points.length > 100, `點數 ${res.points.length}`)
  assert.ok(res.points.some(p => p.v === 999), '尖峰要保留')
  assert.ok(res.points.some(p => p.v === -50), '谷底要保留')
  for (let i = 1; i < res.points.length; i++) {
    assert.ok(Date.parse(res.points[i].t) > Date.parse(res.points[i - 1].t), '時間遞增')
  }

  const small = pts.slice(0, 599)
  const r2 = downsamplePoints(small)
  assert.equal(r2.sampled, false)
  assert.equal(r2.points, small, '599 點原樣')
})

test('5 抽樣：中間有缺值的序列抽樣後缺口仍在、不跨缺口', async () => {
  const { downsamplePoints } = await import('../src/ui/report/series.js')
  const base = Date.UTC(2026, 8, 1)
  const pts = []
  for (let i = 0; i < 5000; i++) {
    const inGap = i >= 2000 && i < 2500
    pts.push({ t: new Date(base + i * 60000).toISOString(), v: inGap ? null : i })
  }
  const res = downsamplePoints(pts)
  assert.ok(res.points.length <= 600)
  const gapIdx = res.points.findIndex(p => p.v === null)
  assert.ok(gapIdx > 0, '缺口要留著')
  // 缺口前後的保留點分別在缺值區間的兩側：線不會跨過缺口
  const beforeGap = res.points[gapIdx - 1]
  const afterGap = res.points.slice(gapIdx).find(p => p.v !== null)
  assert.ok(beforeGap.v < 2000 && afterGap.v >= 2500)
  // 缺值區間內不得有被補出來的值
  assert.ok(!res.points.some(p => p.v !== null && p.v >= 2000 && p.v < 2500))
  // 非缺口區段之間沒有第二個缺口
  assert.equal(res.points.filter(p => p.v === null).length, 1)
})

test('5 卡片：抽樣過的折線卡有「已抽樣顯示」（title 說原始點數），599 點沒有；表格卡不抽樣', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const { renderCard } = await import('../src/ui/report/cards.js')
  const mk = (n) => {
    const records = []
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.UTC(2026, 8, 18, 0, 0) + i * 60000)
      const local = `2026-09-18T${pad(Math.floor(i / 60) % 24)}:${pad(i % 60)}`
      records.push({ taskId: 't1', slot: local, capturedAt: d.toISOString(), value: i, status: 'ok', date: '2026-09-18' })
    }
    return records
  }
  const ctx = (records) => ({ records, range: { from: '2026-09-18', to: '2026-09-18' }, today: '2026-09-18', tasksById: {} })
  const big = renderCard({ id: 'c1', type: 'line', w: 6, h: 3, source: [{ taskId: 't1', aggregation: 'raw' }], options: {} }, ctx(mk(1200)))
  const badge = big.querySelector('[data-sampled]')
  assert.ok(badge, '要有抽樣標示')
  assert.equal(badge.textContent, '已抽樣顯示')
  assert.ok(badge.title.includes('1200'), 'title 說明原始點數')
  assert.ok(big.querySelectorAll('circle').length <= 600)

  const small = renderCard({ id: 'c2', type: 'line', w: 6, h: 3, source: [{ taskId: 't1', aggregation: 'raw' }], options: {} }, ctx(mk(599)))
  assert.equal(small.querySelector('[data-sampled]'), null)
  assert.equal(small.querySelectorAll('circle').length, 599)

  const bar = renderCard({ id: 'c3', type: 'bar', w: 6, h: 3, source: [{ taskId: 't1', aggregation: 'raw' }], options: {} }, ctx(mk(1200)))
  assert.ok(bar.querySelector('[data-sampled]'), '長條圖同樣抽樣')

  const table = renderCard({ id: 'c4', type: 'table', w: 6, h: 3, source: [{ taskId: 't1', aggregation: 'raw' }], options: {} }, ctx(mk(700)))
  assert.equal(table.querySelector('[data-sampled]'), null, '表格卡不抽樣')
})
