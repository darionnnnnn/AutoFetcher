import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

test('AC-A1: 固定 today 驗證帳本及紀錄截止日前／當日／後一日', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  t.after(resetChromeMock)
  const storage = await import('../src/shared/storage.js?retention-boundary')
  await storage.init()
  // 固定 today 代替讀取系統時間；帳本保留 today-14 起，紀錄則含 today 共14日。
  const today = '2026-10-20'
  await storage.saveSettings({ retentionDays: 14 })
  for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) {
    await storage.setRunStatus('task', date + 'T09:00', 'ok')
  }
  for (const date of ['2026-10-06', '2026-10-07', '2026-10-08']) {
    await storage.appendRecord(date, { taskId: 'task', slot: date + 'T09:00',
      capturedAt: date + 'T01:00:00Z', value: 42, status: 'ok' })
  }
  assert.deepEqual(await storage.countRecordsBeyondRetention(14, today), { count: 1, cutoff: '2026-10-07' })
  await storage.trimOldRuns(today)
  await storage.trimOldRecords(today)
  const data = await chrome.storage.local.get(null)
  assert.equal(data['runs:2026-10-05'], undefined)
  assert.equal(data['runs:2026-10-06'].task['2026-10-06T09:00'], 'ok')
  assert.equal(data['runs:2026-10-07'].task['2026-10-07T09:00'], 'ok')
  assert.equal((await storage.getRecordsByDate('2026-10-06')).length, 0)
  assert.equal((await storage.getRecordsByDate('2026-10-07')).length, 1)
  assert.equal((await storage.getRecordsByDate('2026-10-08')).length, 1)
  assert.deepEqual(await storage.countRecordsBeyondRetention(14, today), { count: 0, cutoff: '2026-10-07' })
})
