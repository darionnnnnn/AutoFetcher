// AF-4 B1:pivot 的時間容差合併、列數上限、無 slot 紀錄的處理
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pivot } from '../src/ui/report/series.js'

// 紀錄工廠:預設成功
// capturedAt 用產品真實格式:new Date().toISOString() 的 UTC(帶 Z)。
// 測試時區固定 Asia/Taipei,所以本地 09:00 的 UTC 是同日 01:00。
const utcOf = (localMinute, sec = '05') => {
  const ms = new Date(`${localMinute}:${sec}`).getTime()
  return new Date(ms).toISOString()
}
const rec = (taskId, slot, value, over = {}) => ({
  taskId, slot, value, status: 'ok',
  capturedAt: slot ? utcOf(slot) : undefined, ...over
})

const IDS = ['a', 'b']

test('bucketMinutes 0(或未給)時逐筆比對,行為與舊版一致', async () => {
  const recs = [rec('a', '2026-09-07T09:00', 1), rec('b', '2026-09-07T09:01', 2)]
  const out = pivot(recs, IDS, { bucketMinutes: 0 })
  assert.equal(out.rows.length, 2, '沒開容差就是兩列')
  assert.deepEqual(out.rows.map(r => r.t), ['2026-09-07T09:00', '2026-09-07T09:01'])
})

test('第三參數只接受 options 物件;誤傳陣列時視為沒給選項(不可炸)', async () => {
  const recs = [rec('a', '2026-09-07T09:00', 1), rec('b', '2026-09-07T09:00', 2)]
  const out = pivot(recs, IDS, ['b', 'a'])
  assert.deepEqual(out.columns, ['a', 'b'], '陣列簽章已收斂,欄序退回 taskIds 順序')
})

test('bucketMinutes 5:09:01 與 09:03 併進 09:00 這一列', async () => {
  const recs = [rec('a', '2026-09-07T09:01', 1), rec('b', '2026-09-07T09:03', 2)]
  const out = pivot(recs, IDS, { bucketMinutes: 5 })
  assert.equal(out.rows.length, 1, '應併成一列')
  assert.equal(out.rows[0].t, '2026-09-07T09:00', '列鍵是桶起點(向下對齊)')
  assert.deepEqual(out.rows[0].values, { a: 1, b: 2 })
})

test('桶邊界:09:05 屬於下一桶,不與 09:04 同列', async () => {
  const recs = [rec('a', '2026-09-07T09:04', 1), rec('a', '2026-09-07T09:05', 2)]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.deepEqual(out.rows.map(r => r.t), ['2026-09-07T09:00', '2026-09-07T09:05'])
})

test('同一任務同一桶多筆:取 capturedAt 最新的成功值,並記合併筆數', async () => {
  const recs = [
    rec('a', '2026-09-07T09:01', 1, { capturedAt: utcOf('2026-09-07T09:01', '00') }),
    rec('a', '2026-09-07T09:04', 9, { capturedAt: utcOf('2026-09-07T09:04', '00') }),
    rec('a', '2026-09-07T09:02', 5, { capturedAt: utcOf('2026-09-07T09:02', '00') })
  ]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].values.a, 9, '要取最新那一筆,不是最早也不是最後掃到的')
  assert.equal(out.rows[0].merged?.a, 3, '要記錄這一格由幾筆合併而來')
})

test('桶內該任務全部失敗時為 null,不可拿失敗紀錄的值充數', async () => {
  const recs = [
    rec('a', '2026-09-07T09:01', 7, { status: 'error' }),
    rec('a', '2026-09-07T09:02', 8, { status: 'error' })
  ]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].values.a, null)
})

test('桶內有成功也有失敗時,取最新的那筆成功值', async () => {
  const recs = [
    rec('a', '2026-09-07T09:01', 7),
    rec('a', '2026-09-07T09:04', 8, { status: 'error' })
  ]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.equal(out.rows[0].values.a, 7, '最新的是失敗紀錄時要退回較早的成功值')
})

test('空桶不成列(沒有紀錄的時間不該出現空白列)', async () => {
  const recs = [rec('a', '2026-09-07T09:00', 1), rec('a', '2026-09-07T10:00', 2)]
  const out = pivot(recs, ['a'], { bucketMinutes: 5 })
  assert.equal(out.rows.length, 2, '中間 11 個空桶不可產生空列')
})

test('沒有 slot 的紀錄改用 capturedAt 截到分鐘,不再整筆丟掉', async () => {
  const recs = [
    { taskId: 'a', value: 3, status: 'ok', capturedAt: utcOf('2026-09-07T09:00', '41') },
    rec('b', '2026-09-07T09:00', 4)
  ]
  const out = pivot(recs, IDS, { bucketMinutes: 0 })
  assert.equal(out.rows.length, 1, '補抓/手動觸發的紀錄也要進得了樞紐表')
  assert.deepEqual(out.rows[0].values, { a: 3, b: 4 })
})

test('slot 與 capturedAt 都沒有的紀錄才略過', async () => {
  const out = pivot([{ taskId: 'a', value: 3, status: 'ok' }], ['a'], { bucketMinutes: 0 })
  assert.equal(out.rows.length, 0)
})

test('limit:取最新的 N 列,但顯示順序仍由舊到新', async () => {
  const recs = ['09:00', '09:10', '09:20', '09:30'].map((t, i) => rec('a', `2026-09-07T${t}`, i))
  const out = pivot(recs, ['a'], { limit: 2 })
  assert.deepEqual(out.rows.map(r => r.t), ['2026-09-07T09:20', '2026-09-07T09:30'])
})

test('limit 非法或 0 時不截斷', async () => {
  const recs = ['09:00', '09:10', '09:20'].map((t, i) => rec('a', `2026-09-07T${t}`, i))
  for (const bad of [0, -1, 'x', null]) {
    assert.equal(pivot(recs, ['a'], { limit: bad }).rows.length, 3, `limit=${bad} 不該截斷`)
  }
})

test('taskOrder 決定欄序,沒列到的排在後面', async () => {
  const recs = [rec('a', '2026-09-07T09:00', 1), rec('b', '2026-09-07T09:00', 2)]
  const out = pivot(recs, IDS, { taskOrder: ['b'] })
  assert.deepEqual(out.columns, ['b', 'a'])
})

test('容差合併時每一列的 values 一定含有全部欄位(缺的是 null)', async () => {
  const recs = [rec('a', '2026-09-07T09:01', 1)]
  const out = pivot(recs, IDS, { bucketMinutes: 5 })
  assert.deepEqual(out.rows[0].values, { a: 1, b: null })
})
