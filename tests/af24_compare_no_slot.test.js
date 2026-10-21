// AF-24 B6：與另一天比較不得丟掉沒有 slot 的紀錄（手動／立即抓取），時刻換回本地
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareDays } from '../src/ui/report/logic.js'

test('A 日一筆沒有 slot 的手動紀錄（capturedAt 為 UTC）出現在比較表、時刻為本地 HH:mm', () => {
  const a = [{ taskId: 't1', capturedAt: '2026-10-21T01:15:20.000Z', value: 10, status: 'ok' }] // 台北 09:15
  const b = [{ taskId: 't1', slot: '2026-10-22T09:15', capturedAt: '2026-10-22T01:15:03.000Z', value: 12, status: 'ok' }]
  const res = compareDays(a, b, ['t1'])
  const rows = res.rows
  const row = rows.find(r => r.time === '09:15')
  assert.ok(row, `應有 09:15 這一列：${JSON.stringify(rows)}`)
  const v = row.values.t1
  assert.equal(v.a, 10)
  assert.equal(v.b, 12)
  assert.equal(v.delta, 2)
})

test('logic.js 不再自己寫一份時刻擷取', () => {
  const src = readFileSync(new URL('../src/ui/report/logic.js', import.meta.url), 'utf8')
  assert.equal(/extractTime/.test(src), false)
  assert.equal(/!r\.slot\) continue/.test(src), false)
})
