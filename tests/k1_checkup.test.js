// AF-4 體檢輪(換模型):有效時刻漏網的三處、effectiveTimeOf 退路、pointercancel 的 pointerId
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const jd = new JSDOM('<!doctype html><body></body>')
globalThis.window = jd.window
globalThis.document = jd.window.document

const { buildSeries, effectiveTimeOf, latest, pivot } = await import('../src/ui/report/series.js')
const CR = await import('../src/ui/report/cards.js')

const UTC_0900 = '2026-09-07T01:00:41.000Z' // 台北 09:00
const UTC_1000 = '2026-09-07T02:00:00.000Z' // 台北 10:00

// ---- 1. raw 折線的時間鍵 ----

test('raw 序列的點 t 用有效時刻,沒有 slot 的紀錄不可變成 undefined', () => {
  const recs = [
    { taskId: 'a', slot: '2026-09-07T09:00', capturedAt: UTC_0900, value: 1, status: 'ok' },
    { taskId: 'a', capturedAt: UTC_1000, value: 2, status: 'ok' }
  ]
  const [s] = buildSeries(recs, [{ taskId: 'a', aggregation: 'raw' }], { from: '2026-09-07', to: '2026-09-07' })
  assert.deepEqual(s.points.map(p => p.t), ['2026-09-07T09:00', '2026-09-07T10:00'],
    'X 軸會印出 undefined,且所有無 slot 的點塌成同一格')
})

test('raw 序列的排序也用有效時刻,無 slot 的紀錄不可全排到最前面', () => {
  const recs = [
    { taskId: 'a', capturedAt: UTC_1000, value: 2, status: 'ok' },
    { taskId: 'a', slot: '2026-09-07T09:00', capturedAt: UTC_0900, value: 1, status: 'ok' }
  ]
  const [s] = buildSeries(recs, [{ taskId: 'a', aggregation: 'raw' }], { from: '2026-09-07', to: '2026-09-07' })
  assert.deepEqual(s.points.map(p => p.v), [1, 2])
})

// ---- 2. 最近 N 筆模式 ----

test('最近 N 筆的時間欄與排序用有效時刻(UTC 的 capturedAt 要換算)', () => {
  const records = [
    { taskId: 't1', slot: '2026-09-07T09:00', capturedAt: UTC_0900, value: 1, raw: '1', status: 'ok' },
    { taskId: 't1', capturedAt: UTC_1000, value: 2, raw: '2', status: 'ok' }
  ]
  const el = CR.renderCard({
    id: 'c1', type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 't1' }], options: { mode: 'recent', limit: 10 }
  }, {
    records, tasksById: { t1: { name: '電費' } }, health: {}, nextRuns: {}, missed: [],
    range: { from: '2026-09-01', to: '2026-09-30' }, today: '2026-09-07'
  })
  const times = [...el.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent)
  assert.deepEqual(times, ['2026-09-07T10:00', '2026-09-07T09:00'],
    '由新到舊;UTC 字串直接顯示會變成 02:00 而且排到 09:00 前面')
})

// ---- 3. 匯出報表 ----

test('匯出的獨立 HTML 報表,紀錄表的時間與排序用有效時刻', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask({ id: 't1', name: '電費', url: 'https://x.test', mode: 'number', enabled: true,
    spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:00'] } })
  await st.appendRecord('2026-09-07', { taskId: 't1', slot: '2026-09-07T09:00', capturedAt: UTC_0900, value: 1, raw: '1', status: 'ok' })
  await st.appendRecord('2026-09-07', { taskId: 't1', capturedAt: UTC_1000, value: 2, raw: '2', status: 'ok' })
  const ex = await import('../src/shared/export.js?t=' + Math.random())
  const { content: html } = await ex.buildHtmlReport({ from: '2026-09-07', to: '2026-09-07' })
  assert.ok(html.includes('2026-09-07T10:00'), '無 slot 的紀錄要顯示本地 10:00')
  assert.ok(!html.includes('2026-09-07T02:00'), '不可把 UTC 字串直接印出來')
  assert.ok(html.indexOf('2026-09-07T09:00') < html.indexOf('2026-09-07T10:00'), '要照時間先後排')
})

// ---- 4. effectiveTimeOf 的退路 ----

test('slot 格式不合時退到 capturedAt,不可整筆丟掉', () => {
  assert.equal(effectiveTimeOf({ slot: '2026-09-07 09:00', capturedAt: UTC_0900 }), '2026-09-07T09:00')
  assert.equal(effectiveTimeOf({ slot: 'garbage', capturedAt: UTC_0900 }), '2026-09-07T09:00')
})

test('capturedAt 是 Date 物件或毫秒數時也算得出來(分組與排序不可一個有一個沒有)', () => {
  const ms = Date.parse(UTC_0900)
  assert.equal(effectiveTimeOf({ capturedAt: new Date(ms) }), '2026-09-07T09:00')
  assert.equal(effectiveTimeOf({ capturedAt: ms }), '2026-09-07T09:00')
})

// ---- 5. latest 的排序基準 ----

test('latest 同一有效分鐘內以 capturedAt 決定新舊,不靠陣列原始順序', () => {
  const recs = [
    { taskId: 'a', slot: '2026-09-07T09:00', capturedAt: '2026-09-07T01:00:50.000Z', value: 9, status: 'ok' },
    { taskId: 'a', slot: '2026-09-07T09:00', capturedAt: '2026-09-07T01:00:05.000Z', value: 1, status: 'ok' }
  ]
  const { current } = latest(recs, 'a', '2026-09-07')
  assert.equal(current.value, 9, '重試成功會與失敗紀錄同槽,要以抓到的時刻決定最新')
})

// ---- 6. 舊的 pivot 陣列簽章已移除,唯一呼叫端改用 options ----

test('pivot 只接受 options 物件(陣列簽章已收斂)', () => {
  const recs = [{ taskId: 'a', slot: '2026-09-07T09:00', capturedAt: UTC_0900, value: 1, status: 'ok' },
                { taskId: 'b', slot: '2026-09-07T09:00', capturedAt: UTC_0900, value: 2, status: 'ok' }]
  assert.deepEqual(pivot(recs, ['a', 'b'], { taskOrder: ['b', 'a'] }).columns, ['b', 'a'])
})
