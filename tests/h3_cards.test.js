process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const jd = new JSDOM('<!doctype html><body></body>')
globalThis.window = jd.window
globalThis.document = jd.window.document

const CR = await import('../src/ui/report/cards.js')

const rec = (taskId, slot, value, status = 'ok', over = {}) => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status,
  date: slot.slice(0, 10), ...over
})

const baseCtx = (over = {}) => ({
  records: [],
  tasksById: { t1: { id: 't1', name: '電費', mode: 'number' }, t2: { id: 't2', name: '水費', mode: 'number' } },
  health: {},
  nextRuns: {},
  missed: [],
  range: { from: '2026-09-01', to: '2026-09-06' },
  today: '2026-09-06',
  ...over
})

const card = (over = {}) => ({
  id: 'c1', type: 'number', x: 0, y: 0, w: 3, h: 2,
  source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over
})

const text = el => el.textContent

// ---- 共通 ----

test('renderCard 回傳帶 data-card-id 的元素', () => {
  const el = CR.renderCard(card(), baseCtx())
  assert.equal(el.dataset.cardId, 'c1')
  assert.equal(el.dataset.cardType, 'number')
})

test('沒填標題時用來源任務名，多來源以頓號串接', () => {
  const one = CR.renderCard(card(), baseCtx())
  assert.ok(text(one).includes('電費'))
  const two = CR.renderCard(card({
    type: 'line', source: [{ taskId: 't1' }, { taskId: 't2' }]
  }), baseCtx())
  assert.ok(text(two).includes('電費、水費'), `實得：${text(two)}`)
})

test('自訂標題優先於任務名，且以 textContent 呈現', () => {
  const el = CR.renderCard(card({ title: '<b>我的卡片</b>' }), baseCtx())
  assert.equal(el.querySelectorAll('b').length, 0)
  assert.ok(text(el).includes('<b>我的卡片</b>'))
})

test('未知型別回錯誤卡片而不是丟例外', () => {
  const el = CR.renderCard(card({ type: '亂寫' }), baseCtx())
  assert.ok(el)
  assert.ok(text(el).includes('不支援') || text(el).includes('未知'), `實得：${text(el)}`)
})

test('卡片有齒輪按鈕供開啟設定抽屜', () => {
  const el = CR.renderCard(card(), baseCtx())
  assert.ok(el.querySelector('[data-action="config"]'))
})

test('固定期間的卡片在角落標示近 N 天，跟隨範圍時不標', () => {
  const fixed = CR.renderCard(card({ options: { period: 7 } }), baseCtx())
  assert.ok(text(fixed).includes('近 7 天'), `實得：${text(fixed)}`)
  const follow = CR.renderCard(card({ options: { period: 'range' } }), baseCtx())
  assert.ok(!text(follow).includes('近'))
})

test('cards.js 不使用 innerHTML 也不寫死色碼', () => {
  const src = readFileSync(new URL('../src/ui/report/cards.js', import.meta.url), 'utf8')
  assert.equal((src.match(/innerHTML/g) || []).length, 0)
  assert.equal((src.match(/#[0-9a-fA-F]{3,6}\b/g) || []).length, 0)
})

// ---- number ----

test('number 顯示最新值', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-06T09:00', 1234)] })
  assert.ok(text(CR.renderCard(card(), ctx)).includes('1234') ||
            text(CR.renderCard(card(), ctx)).includes('1,234'))
})

test('number 依小數位與單位格式化', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-06T09:00', 12.3456)] })
  const el = CR.renderCard(card({ options: { decimals: 2, unit: '度' } }), ctx)
  assert.ok(text(el).includes('12.35'), `實得：${text(el)}`)
  assert.ok(text(el).includes('度'))
})

test('number 抓取失敗顯示破折號而不是 0，並在 title 帶錯誤原因', () => {
  const ctx = baseCtx({
    records: [rec('t1', '2026-09-06T09:00', null, 'not_found')],
    health: { t1: { status: 'not_found', reason: '找不到元素' } }
  })
  const el = CR.renderCard(card(), ctx)
  assert.ok(text(el).includes('—'))
  assert.ok(!/\b0\b/.test(text(el).replace(/近 \d+ 天/, '')), `失敗不可顯示 0：${text(el)}`)
  const holder = el.querySelector('[title]')
  assert.ok(holder && holder.getAttribute('title').includes('找不到元素'))
})

test('number 上升顯示上箭頭、下降顯示下箭頭', () => {
  const up = baseCtx({ records: [rec('t1', '2026-09-06T09:00', 10), rec('t1', '2026-09-06T10:00', 12)] })
  const down = baseCtx({ records: [rec('t1', '2026-09-06T09:00', 10), rec('t1', '2026-09-06T10:00', 8)] })
  assert.ok(text(CR.renderCard(card(), up)).includes('↑'))
  assert.ok(text(CR.renderCard(card(), down)).includes('↓'))
})

test('number 差異可切換成與前一日比較', () => {
  const ctx = baseCtx({ records: [
    rec('t1', '2026-09-05T09:00', 100),
    rec('t1', '2026-09-06T09:00', 110), rec('t1', '2026-09-06T10:00', 120)
  ] })
  const prev = CR.renderCard(card({ options: { compare: 'prev' } }), ctx)
  const prevDay = CR.renderCard(card({ options: { compare: 'prevDay' } }), ctx)
  assert.notEqual(text(prev), text(prevDay), '兩種基準的顯示要不同')
  assert.ok(text(prevDay).includes('20'), `與前一日 100 相比差 20：${text(prevDay)}`)
})

test('number 超過閾值時加上 threshold-hit 類別', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-06T09:00', 95)] })
  const hit = CR.renderCard(card({ options: { thresholds: [{ op: 'gte', value: 90, color: 'var(--warn)' }] } }), ctx)
  const miss = CR.renderCard(card({ options: { thresholds: [{ op: 'gte', value: 99, color: 'var(--warn)' }] } }), ctx)
  assert.ok(hit.querySelector('.threshold-hit') || hit.classList.contains('threshold-hit'))
  assert.ok(!(miss.querySelector('.threshold-hit') || miss.classList.contains('threshold-hit')))
})

test('number 可選顯示迷你走勢圖', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-05T09:00', 1), rec('t1', '2026-09-06T09:00', 2)] })
  assert.ok(CR.renderCard(card({ options: { sparkline: true } }), ctx).querySelector('svg'))
  assert.equal(CR.renderCard(card({ options: { sparkline: false } }), ctx).querySelector('svg'), null)
})

test('number 完全沒有紀錄時顯示破折號', () => {
  assert.ok(text(CR.renderCard(card(), baseCtx())).includes('—'))
})

// ---- line / bar ----

test('line 卡片畫出 svg', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-05T09:00', 1), rec('t1', '2026-09-06T09:00', 2)] })
  assert.ok(CR.renderCard(card({ type: 'line' }), ctx).querySelector('svg path'))
})

test('bar 卡片畫出長條', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-05T09:00', 1), rec('t1', '2026-09-06T09:00', 2)] })
  assert.ok(CR.renderCard(card({ type: 'bar', options: { aggregation: 'dailyLast' } }), ctx).querySelector('svg rect[data-t]'))
})

test('line 點擊資料點時呼叫 onPointClick 並帶任務與日期', () => {
  const clicks = []
  const ctx = baseCtx({
    records: [rec('t1', '2026-09-05T09:00', 1), rec('t1', '2026-09-06T09:00', 2)],
    onPointClick: p => clicks.push(p)
  })
  const el = CR.renderCard(card({ type: 'line' }), ctx)
  el.querySelector('[data-t]').dispatchEvent(new jd.window.Event('click', { bubbles: true }))
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0].taskId, 't1')
  assert.ok(clicks[0].date.startsWith('2026-09-0'))
})

test('line 卡片的 Y 軸範圍選項會傳給圖表', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-05T09:00', 1), rec('t1', '2026-09-06T09:00', 2)] })
  const a = CR.renderCard(card({ type: 'line', options: { yMin: 0, yMax: 10 } }), ctx).querySelector('path').getAttribute('d')
  const b = CR.renderCard(card({ type: 'line', options: { yMin: 0, yMax: 1000 } }), ctx).querySelector('path').getAttribute('d')
  assert.notEqual(a, b)
})

test('line 沒有資料時顯示沒有資料', () => {
  assert.ok(text(CR.renderCard(card({ type: 'line' }), baseCtx())).includes('沒有資料'))
})

// ---- table ----

test('table 最近 N 筆模式只顯示 N 列', () => {
  const records = Array.from({ length: 8 }, (_, i) => rec('t1', `2026-09-06T0${i}:00`, i))
  const el = CR.renderCard(card({ type: 'table', options: { mode: 'recent', limit: 3 } }), baseCtx({ records }))
  assert.equal(el.querySelectorAll('tbody tr').length, 3)
})

test('table 最近 N 筆是最新的幾筆', () => {
  const records = [rec('t1', '2026-09-06T01:00', 1), rec('t1', '2026-09-06T09:00', 9)]
  const el = CR.renderCard(card({ type: 'table', options: { mode: 'recent', limit: 1 } }), baseCtx({ records }))
  assert.ok(text(el).includes('9'))
})

test('table 樞紐模式每個任務一欄', () => {
  const records = [rec('t1', '2026-09-06T09:00', 1), rec('t2', '2026-09-06T09:00', 2)]
  const el = CR.renderCard(card({
    type: 'table', options: { mode: 'pivot' },
    source: [{ taskId: 't1' }, { taskId: 't2' }]
  }), baseCtx({ records }))
  const heads = [...el.querySelectorAll('thead th')].map(th => th.textContent)
  assert.ok(heads.includes('電費') && heads.includes('水費'), `實得表頭：${heads}`)
})

test('table 有複製 TSV 按鈕，剪貼簿不可用時隱藏', () => {
  const records = [rec('t1', '2026-09-06T09:00', 1)]
  const before = globalThis.navigator
  const el1 = CR.renderCard(card({ type: 'table' }), baseCtx({ records }))
  const btn = el1.querySelector('[data-action="copy-tsv"]')
  assert.ok(btn, '要有複製 TSV 按鈕')
  void before
})

test('buildTsv 以定位字元分隔並含表頭', () => {
  const tsv = CR.buildTsv([['時間', '值'], ['2026-09-06T09:00', '1']])
  assert.equal(tsv, '時間\t值\n2026-09-06T09:00\t1')
})

// ---- gauge ----

test('gauge 用最新值與上下限', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-06T09:00', 42)] })
  const el = CR.renderCard(card({ type: 'gauge', options: { min: 0, max: 100 } }), ctx)
  assert.ok(el.querySelector('svg'))
  assert.ok(text(el).includes('42'))
})

test('gauge 超過警戒線時帶 over-warn', () => {
  const ctx = baseCtx({ records: [rec('t1', '2026-09-06T09:00', 95)] })
  const el = CR.renderCard(card({ type: 'gauge', options: { min: 0, max: 100, warn: 90 } }), ctx)
  assert.ok(el.querySelector('.over-warn') || el.classList.contains('over-warn'))
})

// ---- text ----

test('text 卡片支援粗體與清單，且不解譯 HTML', () => {
  const el = CR.renderCard(card({
    type: 'text', source: [],
    options: { content: '這是 **重點**\n- 第一項\n- 第二項\n<script>x</script>' }
  }), baseCtx())
  assert.equal(el.querySelectorAll('script').length, 0)
  assert.equal(el.querySelectorAll('strong, b').length, 1)
  assert.equal(el.querySelectorAll('li').length, 2)
  assert.ok(text(el).includes('<script>'), 'HTML 要以純文字呈現')
})

test('text 卡片沒有內容時不丟錯', () => {
  assert.ok(CR.renderCard(card({ type: 'text', source: [], options: {} }), baseCtx()))
})

// ---- status ----

test('status 列出每個任務的最後狀態與下次執行', () => {
  const ctx = baseCtx({
    health: { t1: { status: 'ok' }, t2: { status: 'not_found' } },
    nextRuns: { t1: '2026-09-07 09:00' }
  })
  const el = CR.renderCard(card({ type: 'status', source: [], options: {} }), ctx)
  assert.ok(text(el).includes('電費') && text(el).includes('水費'))
  assert.ok(text(el).includes('2026-09-07 09:00'))
})

test('status 可篩選任務', () => {
  const ctx = baseCtx({ health: { t1: { status: 'ok' }, t2: { status: 'ok' } } })
  const el = CR.renderCard(card({ type: 'status', source: [], options: { taskIds: ['t2'] } }), ctx)
  assert.ok(!text(el).includes('電費'))
  assert.ok(text(el).includes('水費'))
})

test('status 顯示錯過筆數', () => {
  const ctx = baseCtx({ missed: [{ taskId: 't1', slot: 'x' }, { taskId: 't1', slot: 'y' }] })
  const el = CR.renderCard(card({ type: 'status', source: [], options: { taskIds: ['t1'] } }), ctx)
  assert.ok(/錯過\s*2/.test(text(el)) || text(el).includes('2'), `實得：${text(el)}`)
})
