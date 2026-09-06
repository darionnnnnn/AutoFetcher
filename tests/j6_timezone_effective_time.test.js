// AF-4 終檢:capturedAt 是 UTC(帶 Z),slot 是本地時間,不可混在同一個字串空間比較
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { effectiveTimeOf, pivot, buildSeries } from '../src/ui/report/series.js'

// 產品端寫的就是這個格式(background/fetcher.js:new Date().toISOString())
const UTC_0900_TPE = '2026-09-07T01:00:41.000Z' // 台北 09:00:41

test('capturedAt 是 UTC 時要換算成本地時刻,不可直接切字串', () => {
  assert.equal(effectiveTimeOf({ capturedAt: UTC_0900_TPE }), '2026-09-07T09:00',
    '直接 slice 會得到 01:00,和同時刻的 slot(09:00)差 8 小時')
})

test('slot 仍然原樣採用(它本來就是本地時間)', () => {
  assert.equal(effectiveTimeOf({ slot: '2026-09-07T09:00', capturedAt: UTC_0900_TPE }), '2026-09-07T09:00')
})

test('沒有 Z 也沒有 offset 的舊字串當成本地時間,不要硬套 UTC', () => {
  assert.equal(effectiveTimeOf({ capturedAt: '2026-09-07T09:00:41' }), '2026-09-07T09:00')
})

test('帶 offset 的字串照 offset 換算', () => {
  assert.equal(effectiveTimeOf({ capturedAt: '2026-09-07T09:00:41+08:00' }), '2026-09-07T09:00')
})

test('無法解析的時間字串回空字串,不可產生 NaN 的列鍵', () => {
  assert.equal(effectiveTimeOf({ capturedAt: '不是時間' }), '')
  assert.equal(effectiveTimeOf({ slot: 'xxxx' }), '')
})

test('同一時刻的有 slot 與無 slot 紀錄要落在同一列', () => {
  const recs = [
    { taskId: 'a', slot: '2026-09-07T09:00', capturedAt: '2026-09-07T01:00:03.000Z', value: 1, status: 'ok' },
    { taskId: 'b', capturedAt: UTC_0900_TPE, value: 2, status: 'ok' }
  ]
  const out = pivot(recs, ['a', 'b'], {})
  assert.equal(out.rows.length, 1, `補抓紀錄應與同時刻的排程紀錄同列,實得 ${out.rows.map(r => r.t)}`)
  assert.deepEqual(out.rows[0].values, { a: 1, b: 2 })
})

test('同一桶內比較新舊時,兩種格式要換算到同一基準', () => {
  const recs = [
    { taskId: 'a', slot: '2026-09-07T09:01', capturedAt: '2026-09-07T01:01:00.000Z', value: 1, status: 'ok' },
    { taskId: 'a', capturedAt: '2026-09-07T01:04:00.000Z', value: 9, status: 'ok' }
  ]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].values.a, 9, '09:04 那筆比 09:01 新,要取它')
})

test('折線等卡片的序列也要吃得到沒有 slot 的紀錄(與表格同一套規則)', () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const recs = [{ taskId: 'a', capturedAt: UTC_0900_TPE, value: 5, status: 'ok' }]
  const series = buildSeries(recs, [{ taskId: 'a', aggregation: 'raw' }], { from: '2026-09-07', to: '2026-09-07' })
  const points = series[0]?.points || []
  assert.equal(points.length, 1, '表格看得到、折線看不到的話,同一份資料兩種答案')
})

test('同桶內一筆帶 UTC 的 capturedAt、一筆只有本地 slot 時,新舊仍要比對正確', () => {
  const recs = [
    // 本地 09:04,只有 slot(沒有 capturedAt)
    { taskId: 'a', slot: '2026-09-07T09:04', value: 9, status: 'ok' },
    // 本地 09:01,帶 UTC 的 capturedAt(字串上是 01:01,比 09:04 小)
    { taskId: 'a', capturedAt: '2026-09-07T01:01:00.000Z', value: 1, status: 'ok' }
  ]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].values.a, 9, '09:04 比 09:01 新;拿字串比會判反')
})

test('只有 slot 的紀錄之間也要比得出新舊', () => {
  const recs = [
    { taskId: 'a', slot: '2026-09-07T09:01', value: 1, status: 'ok' },
    { taskId: 'a', slot: '2026-09-07T09:04', value: 9, status: 'ok' }
  ]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.equal(out.rows[0].values.a, 9)
})

// ---- 有效時刻必須是唯一一份:每日聚合與 latest 也要用同一套 ----

test('每日聚合也吃得到沒有 slot 的紀錄', async () => {
  const { JSDOM } = await import('jsdom')
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const recs = [{ taskId: 'a', capturedAt: UTC_0900_TPE, value: 5, status: 'ok' }]
  const series = buildSeries(recs, [{ taskId: 'a', aggregation: 'dailyLast' }],
    { from: '2026-09-07', to: '2026-09-07' })
  const pts = (series[0]?.points || []).filter(p => p.v !== null)
  assert.equal(pts.length, 1, '每日聚合把無 slot 紀錄歸到 undefined 那一天就會整筆消失')
})

test('latest 取最新時,沒有 slot 的紀錄不可被當成最舊', async () => {
  const { latest } = await import('../src/ui/report/series.js')
  const recs = [
    { taskId: 'a', slot: '2026-09-07T09:00', capturedAt: '2026-09-07T01:00:00.000Z', value: 1, status: 'ok' },
    // 同一天稍晚的手動觸發:沒有 slot
    { taskId: 'a', capturedAt: '2026-09-07T02:00:00.000Z', value: 2, status: 'ok' }
  ]
  const { current } = latest(recs, 'a', '2026-09-07')
  assert.equal(current?.value, 2, '數值卡片會顯示舊值,而表格顯示新值,同一份資料兩種答案')
})

test('latest 的前一日比較也用同一套有效時刻', async () => {
  const { latest } = await import('../src/ui/report/series.js')
  const recs = [
    // 前一天,只有 capturedAt(UTC)
    { taskId: 'a', capturedAt: '2026-09-05T01:00:00.000Z', value: 10, status: 'ok' },
    { taskId: 'a', slot: '2026-09-07T09:00', capturedAt: '2026-09-07T01:00:00.000Z', value: 20, status: 'ok' }
  ]
  const { prevDay } = latest(recs, 'a', '2026-09-07')
  assert.equal(prevDay?.value, 10, '前一日的值要找得到,才算得出日變化')
})
