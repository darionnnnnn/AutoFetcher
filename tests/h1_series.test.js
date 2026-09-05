process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as S from '../src/ui/report/series.js'

// 紀錄形狀比照 fetcher 寫入：{taskId, slot, capturedAt, value, raw, status}
const r = (taskId, slot, value, status = 'ok', over = {}) => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status,
  date: slot.slice(0, 10), ...over
})

const src1 = [{ taskId: 't1', aggregation: 'raw' }]
const RANGE = { from: '2026-09-01', to: '2026-09-03' }

// ---- 純度 ----

test('series 是純函式模組：不碰 DOM 也不碰 chrome', () => {
  const s = readFileSync(new URL('../src/ui/report/series.js', import.meta.url), 'utf8')
  assert.equal((s.match(/\bdocument\b/g) || []).length, 0)
  assert.equal((s.match(/\bchrome\./g) || []).length, 0)
})

// ---- buildSeries：raw ----

test('raw 聚合逐筆輸出，時間用 slot', () => {
  const recs = [r('t1', '2026-09-01T09:00', 10), r('t1', '2026-09-01T10:00', 12)]
  const out = S.buildSeries(recs, src1, { ...RANGE, aggregation: 'raw' })
  assert.equal(out.length, 1)
  assert.equal(out[0].taskId, 't1')
  assert.deepEqual(out[0].points, [
    { t: '2026-09-01T09:00', v: 10 },
    { t: '2026-09-01T10:00', v: 12 }
  ])
})

test('raw 依時間排序，不管輸入順序', () => {
  const recs = [r('t1', '2026-09-02T09:00', 2), r('t1', '2026-09-01T09:00', 1)]
  const out = S.buildSeries(recs, src1, { ...RANGE, aggregation: 'raw' })
  assert.deepEqual(out[0].points.map(p => p.v), [1, 2])
})

test('只取範圍內的紀錄', () => {
  const recs = [r('t1', '2026-08-31T09:00', 1), r('t1', '2026-09-02T09:00', 2), r('t1', '2026-09-05T09:00', 3)]
  const out = S.buildSeries(recs, src1, { ...RANGE, aggregation: 'raw' })
  assert.deepEqual(out[0].points.map(p => p.v), [2])
})

// ---- buildSeries：每日聚合 ----

test('dailyLast 取每日最後一筆，時間是日期', () => {
  const recs = [r('t1', '2026-09-01T09:00', 1), r('t1', '2026-09-01T18:00', 5), r('t1', '2026-09-02T09:00', 7)]
  const out = S.buildSeries(recs, src1, { ...RANGE, aggregation: 'dailyLast' })
  assert.deepEqual(out[0].points, [
    { t: '2026-09-01', v: 5 }, { t: '2026-09-02', v: 7 }, { t: '2026-09-03', v: null }
  ])
})

test('dailyMax 與 dailyMin', () => {
  const recs = [r('t1', '2026-09-01T09:00', 3), r('t1', '2026-09-01T18:00', 9), r('t1', '2026-09-01T20:00', 1)]
  const max = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-01', aggregation: 'dailyMax' })
  const min = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-01', aggregation: 'dailyMin' })
  assert.equal(max[0].points[0].v, 9)
  assert.equal(min[0].points[0].v, 1)
})

test('dailyAvg 與 dailySum', () => {
  const recs = [r('t1', '2026-09-01T09:00', 2), r('t1', '2026-09-01T18:00', 4)]
  const avg = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-01', aggregation: 'dailyAvg' })
  const sum = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-01', aggregation: 'dailySum' })
  assert.equal(avg[0].points[0].v, 3)
  assert.equal(sum[0].points[0].v, 6)
})

test('每日聚合對範圍內沒有資料的日子產生 null，不是略過', () => {
  const recs = [r('t1', '2026-09-01T09:00', 1), r('t1', '2026-09-03T09:00', 3)]
  const out = S.buildSeries(recs, src1, { ...RANGE, aggregation: 'dailyLast' })
  assert.deepEqual(out[0].points.map(p => p.v), [1, null, 3])
})

test('當天全部失敗時該日是 null，不是 0', () => {
  const recs = [r('t1', '2026-09-01T09:00', null, 'not_found'), r('t1', '2026-09-01T10:00', null, 'error')]
  const out = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-01', aggregation: 'dailySum' })
  assert.equal(out[0].points[0].v, null)
})

test('失敗紀錄在 raw 模式保留為 null 點，不可被丟掉', () => {
  const recs = [r('t1', '2026-09-01T09:00', 10), r('t1', '2026-09-01T10:00', null, 'not_found')]
  const out = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-01', aggregation: 'raw' })
  assert.deepEqual(out[0].points.map(p => p.v), [10, null])
})

test('非數值的值不計入每日聚合', () => {
  const recs = [r('t1', '2026-09-01T09:00', '文字'), r('t1', '2026-09-01T10:00', 4)]
  const out = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-01', aggregation: 'dailyAvg' })
  assert.equal(out[0].points[0].v, 4)
})

test('跨日邊界依當地時區的 slot 分日', () => {
  const recs = [r('t1', '2026-09-01T23:59', 1), r('t1', '2026-09-02T00:01', 2)]
  const out = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-02', aggregation: 'dailyLast' })
  assert.deepEqual(out[0].points, [{ t: '2026-09-01', v: 1 }, { t: '2026-09-02', v: 2 }])
})

test('多來源回多條序列，順序與 source 相同', () => {
  const recs = [r('t1', '2026-09-01T09:00', 1), r('t2', '2026-09-01T09:00', 2)]
  const out = S.buildSeries(recs, [
    { taskId: 't2', aggregation: 'raw' }, { taskId: 't1', aggregation: 'raw' }
  ], { from: '2026-09-01', to: '2026-09-01' })
  assert.deepEqual(out.map(s => s.taskId), ['t2', 't1'])
  assert.equal(out[0].points[0].v, 2)
})

test('來源自己的 aggregation 優先於共用選項', () => {
  const recs = [r('t1', '2026-09-01T09:00', 2), r('t1', '2026-09-01T18:00', 8)]
  const out = S.buildSeries(recs, [{ taskId: 't1', aggregation: 'dailyMax' }],
    { from: '2026-09-01', to: '2026-09-01', aggregation: 'dailyLast' })
  assert.equal(out[0].points[0].v, 8)
})

test('沒有資料的來源仍回一條序列（每日聚合時全是 null）', () => {
  const out = S.buildSeries([], src1, { ...RANGE, aggregation: 'dailyLast' })
  assert.equal(out.length, 1)
  assert.equal(out[0].points.length, 3)
  assert.ok(out[0].points.every(p => p.v === null))
})

test('空來源清單回空陣列', () => {
  assert.deepEqual(S.buildSeries([r('t1', '2026-09-01T09:00', 1)], [], RANGE), [])
})

// ---- normalize ----

test('percentFromFirst 以第一個非 null 值為 100', () => {
  const recs = [r('t1', '2026-09-01T09:00', 50), r('t1', '2026-09-02T09:00', 75)]
  const out = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-02', aggregation: 'dailyLast', normalize: 'percentFromFirst' })
  assert.deepEqual(out[0].points.map(p => p.v), [100, 150])
})

test('percentFromFirst 首值為 null 時取下一個非 null 當基準，null 仍是 null', () => {
  const recs = [r('t1', '2026-09-02T09:00', 40), r('t1', '2026-09-03T09:00', 20)]
  const out = S.buildSeries(recs, src1, { ...RANGE, aggregation: 'dailyLast', normalize: 'percentFromFirst' })
  assert.deepEqual(out[0].points.map(p => p.v), [null, 100, 50])
})

test('percentFromFirst 基準為 0 時不做正規化（避免除以零）', () => {
  const recs = [r('t1', '2026-09-01T09:00', 0), r('t1', '2026-09-02T09:00', 5)]
  const out = S.buildSeries(recs, src1, { from: '2026-09-01', to: '2026-09-02', aggregation: 'dailyLast', normalize: 'percentFromFirst' })
  assert.deepEqual(out[0].points.map(p => p.v), [0, 5])
})

// ---- resolvePeriod ----

test("resolvePeriod 'range' 直接用範圍列的值", () => {
  assert.deepEqual(S.resolvePeriod('range', '2026-09-01', '2026-09-07', '2026-09-06'),
    { from: '2026-09-01', to: '2026-09-07' })
})

test('resolvePeriod 數字代表近 N 天（含今天）', () => {
  assert.deepEqual(S.resolvePeriod(7, '2026-01-01', '2026-01-02', '2026-09-06'),
    { from: '2026-08-31', to: '2026-09-06' })
  assert.deepEqual(S.resolvePeriod(1, '2026-01-01', '2026-01-02', '2026-09-06'),
    { from: '2026-09-06', to: '2026-09-06' })
})

test('resolvePeriod 未給或不合法時視為 range', () => {
  assert.deepEqual(S.resolvePeriod(undefined, '2026-09-01', '2026-09-02', '2026-09-06'),
    { from: '2026-09-01', to: '2026-09-02' })
  assert.deepEqual(S.resolvePeriod('亂寫', '2026-09-01', '2026-09-02', '2026-09-06'),
    { from: '2026-09-01', to: '2026-09-02' })
})

test('resolvePeriod 跨月往前推算正確', () => {
  assert.deepEqual(S.resolvePeriod(30, '', '', '2026-09-06'), { from: '2026-08-08', to: '2026-09-06' })
})

// ---- latest ----

test('latest 回最新、前一筆與前一日最後一筆', () => {
  const recs = [
    r('t1', '2026-09-05T09:00', 1), r('t1', '2026-09-05T18:00', 2),
    r('t1', '2026-09-06T09:00', 3), r('t1', '2026-09-06T10:00', 4)
  ]
  const got = S.latest(recs, 't1', '2026-09-06')
  assert.equal(got.current.value, 4)
  assert.equal(got.prev.value, 3)
  assert.equal(got.prevDay.value, 2)
})

test('latest 沒有前一日資料時 prevDay 為 null', () => {
  const recs = [r('t1', '2026-09-06T09:00', 3)]
  const got = S.latest(recs, 't1', '2026-09-06')
  assert.equal(got.current.value, 3)
  assert.equal(got.prev, null)
  assert.equal(got.prevDay, null)
})

test('latest 忽略其他任務的紀錄', () => {
  const recs = [r('t2', '2026-09-06T11:00', 99), r('t1', '2026-09-06T09:00', 3)]
  assert.equal(S.latest(recs, 't1', '2026-09-06').current.value, 3)
})

test('latest 的 current 可以是失敗紀錄，prevDay 只取成功的', () => {
  const recs = [
    r('t1', '2026-09-05T09:00', 5),
    r('t1', '2026-09-05T18:00', null, 'not_found'),
    r('t1', '2026-09-06T09:00', null, 'error')
  ]
  const got = S.latest(recs, 't1', '2026-09-06')
  assert.equal(got.current.status, 'error')
  assert.equal(got.prevDay.value, 5)
})

test('latest 沒有任何紀錄時三個欄位都是 null', () => {
  const got = S.latest([], 't1', '2026-09-06')
  assert.deepEqual([got.current, got.prev, got.prevDay], [null, null, null])
})

// ---- pivot ----

test('pivot 列是時間、欄是任務，欄序照給定順序', () => {
  const recs = [
    r('t1', '2026-09-01T09:00', 1), r('t2', '2026-09-01T09:00', 2),
    r('t1', '2026-09-01T10:00', 3)
  ]
  const p = S.pivot(recs, ['t2', 't1'], ['t2', 't1'])
  assert.deepEqual(p.columns, ['t2', 't1'])
  assert.deepEqual(p.rows.map(r2 => r2.t), ['2026-09-01T09:00', '2026-09-01T10:00'])
  assert.deepEqual(p.rows[0].values, { t2: 2, t1: 1 })
})

test('pivot 該時刻沒有值時該格為 null', () => {
  const recs = [r('t1', '2026-09-01T09:00', 1), r('t2', '2026-09-01T10:00', 2)]
  const p = S.pivot(recs, ['t1', 't2'], ['t1', 't2'])
  assert.equal(p.rows[0].values.t2, null)
  assert.equal(p.rows[1].values.t1, null)
})

test('pivot 空輸入回空欄列', () => {
  const p = S.pivot([], [], [])
  assert.deepEqual(p.columns, [])
  assert.deepEqual(p.rows, [])
})
