process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  quickRange, filterRecords, summarize, buildCalendar, parseHash, buildHash, sortRecords
} from '../src/ui/report/logic.js'

const NOW = new Date(2026, 8, 7, 12, 0).getTime()  // 2026-09-07 週一

const rec = (over = {}) => ({
  date: '2026-09-05', taskId: 't1', taskName: '總量', slot: '2026-09-05T09:00',
  capturedAt: '2026-09-05T09:00:05+08:00', value: 10, raw: '10', status: 'ok', ...over
})

// ---------- 快捷日期範圍 ----------
test('quickRange:各種快捷', async () => {
  assert.deepEqual(quickRange('today', NOW), { from: '2026-09-07', to: '2026-09-07' })
  assert.deepEqual(quickRange('yesterday', NOW), { from: '2026-09-06', to: '2026-09-06' })
  assert.deepEqual(quickRange('last7', NOW), { from: '2026-09-01', to: '2026-09-07' })
  assert.deepEqual(quickRange('last30', NOW), { from: '2026-08-09', to: '2026-09-07' })
  assert.deepEqual(quickRange('thisMonth', NOW), { from: '2026-09-01', to: '2026-09-30' })
  assert.deepEqual(quickRange('lastMonth', NOW), { from: '2026-08-01', to: '2026-08-31' })
})

test('quickRange:未知種類回 null,不亂猜', async () => {
  assert.equal(quickRange('nope', NOW), null)
})

test('quickRange:二月與閏年也算得對', async () => {
  const feb = new Date(2028, 1, 10, 12, 0).getTime()  // 2028 是閏年
  assert.deepEqual(quickRange('thisMonth', feb), { from: '2028-02-01', to: '2028-02-29' })
})

// ---------- 篩選 ----------
test('filterRecords:依任務篩選', async () => {
  const rs = [rec(), rec({ taskId: 't2' })]
  assert.equal(filterRecords(rs, { taskIds: ['t1'] }).length, 1)
  assert.equal(filterRecords(rs, { taskIds: [] }).length, 2, '空陣列代表不篩選')
  assert.equal(filterRecords(rs, {}).length, 2)
})

test('filterRecords:依狀態篩選', async () => {
  const rs = [rec(), rec({ status: 'not_found' }), rec({ status: 'fallback' })]
  assert.equal(filterRecords(rs, { statuses: ['not_found', 'fallback'] }).length, 2)
})

test('filterRecords:只看告警', async () => {
  const rs = [rec(), rec({ alert: true })]
  assert.equal(filterRecords(rs, { alertOnly: true }).length, 1)
})

test('filterRecords:數值範圍,非數值的紀錄被排除', async () => {
  const rs = [rec({ value: 5 }), rec({ value: 50 }), rec({ value: undefined, status: 'parse_error' })]
  assert.equal(filterRecords(rs, { min: 10 }).length, 1)
  assert.equal(filterRecords(rs, { max: 10 }).length, 1)
  assert.equal(filterRecords(rs, { min: 1, max: 100 }).length, 2)
})

test('filterRecords:關鍵字比對原文與任務名,不分大小寫', async () => {
  const rs = [rec({ raw: '尚未開盤' }), rec({ raw: 'OPEN' }), rec({ taskName: '匯率' })]
  assert.equal(filterRecords(rs, { keyword: '開盤' }).length, 1)
  assert.equal(filterRecords(rs, { keyword: 'open' }).length, 1)
  assert.equal(filterRecords(rs, { keyword: '匯率' }).length, 1)
})

test('filterRecords:多個條件同時成立才留下', async () => {
  const rs = [rec({ value: 5, status: 'ok' }), rec({ value: 50, status: 'ok' })]
  assert.equal(filterRecords(rs, { statuses: ['ok'], min: 10 }).length, 1)
})

// ---------- 摘要 ----------
test('summarize:每任務的筆數與統計', async () => {
  const rs = [
    rec({ value: 10 }), rec({ value: 30 }), rec({ value: 20 }),
    rec({ taskId: 't2', taskName: '匯率', value: 7 })
  ]
  const s = summarize(rs)
  const t1 = s.find(x => x.taskId === 't1')
  assert.equal(t1.count, 3)
  assert.equal(t1.min, 10)
  assert.equal(t1.max, 30)
  assert.equal(t1.avg, 20)
  assert.equal(t1.first, 10)
  assert.equal(t1.last, 20, '首末依原始順序,不是排序後')
  assert.equal(t1.delta, 10, '末減首')
  assert.equal(s.length, 2)
})

test('summarize:失敗紀錄計入筆數但不計入統計', async () => {
  const rs = [rec({ value: 10 }), rec({ value: undefined, status: 'not_found' })]
  const [s] = summarize(rs)
  assert.equal(s.count, 2)
  assert.equal(s.failCount, 1)
  assert.equal(s.avg, 10, '失敗的不可以當成 0 拉低平均')
})

test('summarize:全部都是失敗時統計為 null 不是 0', async () => {
  const [s] = summarize([rec({ value: undefined, status: 'not_found' })])
  assert.equal(s.avg, null)
  assert.equal(s.min, null)
  assert.equal(s.max, null)
})

test('summarize:文字模式的值不做數值統計', async () => {
  const [s] = summarize([rec({ value: '尚未開盤' })])
  assert.equal(s.count, 1)
  assert.equal(s.avg, null)
})

// ---------- 月曆 ----------
test('buildCalendar:回傳整週對齊的格子,補滿前後空白', async () => {
  const weeks = buildCalendar(2026, 9, { '2026-09-05': { count: 2, hasFail: false } })
  assert.ok(weeks.every(w => w.length === 7), '每週七格')
  const flat = weeks.flat()
  const d5 = flat.find(c => c.date === '2026-09-05')
  assert.equal(d5.count, 2)
  assert.equal(d5.inMonth, true)
  assert.ok(flat.some(c => c.inMonth === false), '前後補的格子要標記不屬於本月')
})

test('buildCalendar:沒有紀錄的日期 count 為 0', async () => {
  const weeks = buildCalendar(2026, 9, {})
  const d = weeks.flat().find(c => c.date === '2026-09-05')
  assert.equal(d.count, 0)
  assert.equal(d.hasFail, false)
})

test('buildCalendar:有失敗的日期要標記', async () => {
  const weeks = buildCalendar(2026, 9, { '2026-09-05': { count: 1, hasFail: true } })
  assert.equal(weeks.flat().find(c => c.date === '2026-09-05').hasFail, true)
})

// ---------- 排序 ----------
test('sortRecords:依欄位升冪降冪', async () => {
  const rs = [rec({ value: 30, slot: '2026-09-05T15:00' }), rec({ value: 10, slot: '2026-09-05T09:00' })]
  assert.deepEqual(sortRecords(rs, 'value', 'asc').map(r => r.value), [10, 30])
  assert.deepEqual(sortRecords(rs, 'value', 'desc').map(r => r.value), [30, 10])
  assert.deepEqual(sortRecords(rs, 'slot', 'asc').map(r => r.value), [10, 30])
})

test('sortRecords:沒有值的排在最後,不論升降冪', async () => {
  const rs = [rec({ value: undefined }), rec({ value: 10 })]
  assert.equal(sortRecords(rs, 'value', 'asc')[0].value, 10)
  assert.equal(sortRecords(rs, 'value', 'desc')[0].value, 10)
})

test('sortRecords 不改動原陣列', async () => {
  const rs = [rec({ value: 30 }), rec({ value: 10 })]
  sortRecords(rs, 'value', 'asc')
  assert.equal(rs[0].value, 30)
})

// ---------- 網址狀態 ----------
test('parseHash / buildHash 往返', async () => {
  const state = { view: 'history', from: '2026-09-01', to: '2026-09-07', taskIds: ['t1', 't2'], statuses: ['ok'] }
  assert.deepEqual(parseHash(buildHash(state)), state)
})

test('parseHash:空字串或壞掉的 hash 回預設,不丟例外', async () => {
  for (const h of ['', '#', '#garbage', '#?from=']) {
    const s = parseHash(h)
    assert.equal(typeof s, 'object')
    assert.ok(s.view)
  }
})

test('buildHash 產生的字串以 # 開頭', async () => {
  assert.ok(buildHash({ view: 'history', from: '2026-09-01', to: '2026-09-01' }).startsWith('#'))
})
