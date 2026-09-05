process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  return { c, st, ms }
}

const daily = (id, times, weekdays = [0, 1, 2, 3, 4, 5, 6]) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'daily', times, weekdays }
})

const NOW = new Date(2026, 8, 7, 12, 0).getTime()   // 2026-09-07 12:00 週一
const TWO_DAYS_AGO = new Date(2026, 8, 5, 12, 0).getTime()

test('computeMissedSlots:關機兩天、每天兩個時間 → 四筆', async () => {
  const { ms } = await fresh()
  const got = ms.computeMissedSlots([daily('t1', ['09:00', '15:00'])], {}, TWO_DAYS_AGO, NOW)
  assert.equal(got.length, 4)
  assert.deepEqual(got.map(x => x.slot), [
    '2026-09-05T15:00', '2026-09-06T09:00', '2026-09-06T15:00', '2026-09-07T09:00'
  ])
  assert.ok(got.every(x => x.taskId === 't1'))
})

test('computeMissedSlots:帳本已有的槽不算錯過', async () => {
  const { ms } = await fresh()
  const ledger = { t1: { '2026-09-06T09:00': 'ok' } }
  const got = ms.computeMissedSlots([daily('t1', ['09:00'])], ledger, TWO_DAYS_AGO, NOW)
  assert.deepEqual(got.map(x => x.slot), ['2026-09-06T09:00'].filter(() => false).concat(['2026-09-07T09:00']))
})

test('computeMissedSlots:未勾選的星期不算錯過', async () => {
  const { ms } = await fresh()
  const sat = new Date(2026, 8, 5, 12, 0).getTime()
  const mon = new Date(2026, 8, 7, 12, 0).getTime()
  const got = ms.computeMissedSlots([daily('t1', ['09:00'], [1])], {}, sat, mon)
  assert.equal(got.length, 1)
  assert.ok(got[0].slot.startsWith('2026-09-07'), '只有週一那筆')
})

test('computeMissedSlots:停用的任務不算', async () => {
  const { ms } = await fresh()
  const got = ms.computeMissedSlots([{ ...daily('t1', ['09:00']), enabled: false }], {}, TWO_DAYS_AGO, NOW)
  assert.equal(got.length, 0)
})

test('computeMissedSlots:interval 任務不列入(太頻繁,靠正常失敗回報)', async () => {
  const { ms } = await fresh()
  const t = { id: 'i1', name: 'i1', url: 'https://a.test/p', enabled: true,
    schedule: { type: 'interval', everyMinutes: 5, weekdays: [0, 1, 2, 3, 4, 5, 6] } }
  assert.equal(ms.computeMissedSlots([t], {}, TWO_DAYS_AGO, NOW).length, 0)
})

test('computeMissedSlots:未來的時間不算錯過', async () => {
  const { ms } = await fresh()
  const got = ms.computeMissedSlots([daily('t1', ['23:00'])], {}, NOW - 3600000, NOW)
  assert.equal(got.length, 0)
})

test('refreshMissed:寫入 storage 並發一則含兩個按鈕的通知', async () => {
  const { c, st, ms } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await ms.refreshMissed(NOW, TWO_DAYS_AGO)
  const list = await ms.getMissed()
  assert.ok(list.length >= 2)
  const note = c.__calls.find(x => x.api === 'notifications.create')
  assert.ok(note, '應通知使用者')
  const opts = note.args[1]
  assert.equal(opts.buttons.length, 2)
  assert.match(opts.buttons[0].title, /補抓/)
  assert.match(opts.buttons[1].title, /略過/)
})

test('refreshMissed:沒有錯過時不發通知', async () => {
  const { c, st, ms } = await fresh()
  await st.saveTask(daily('t1', ['23:59']))
  await ms.refreshMissed(NOW, NOW - 60000)
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 0)
  assert.deepEqual(await ms.getMissed(), [])
})

test('refreshMissed:只回看七天,更早的自動放棄', async () => {
  const { st, ms } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  const thirtyDaysAgo = NOW - 30 * 86400000
  await ms.refreshMissed(NOW, thirtyDaysAgo)
  const list = await ms.getMissed()
  assert.ok(list.length <= 8, `最多七天份,實際 ${list.length}`)
  assert.ok(list.every(x => x.slot >= '2026-08-31'), '不得出現七天前的槽')
})

test('catchUpAll:對每一筆呼叫 runTask 並帶 late 理由,完成後清空', async () => {
  const { st, ms } = await fresh()
  await st.saveTask(daily('t1', ['09:00', '15:00']))
  await ms.refreshMissed(NOW, TWO_DAYS_AGO)
  const before = (await ms.getMissed()).length
  const calls = []
  await ms.catchUpAll(async (task, opts) => { calls.push([task.id, opts.slot, opts.reason]) })
  assert.equal(calls.length, before)
  assert.ok(calls.every(c => c[2] === 'late'))
  assert.deepEqual(await ms.getMissed(), [])
})

test('catchUpAll:某一筆丟例外時,其餘仍繼續', async () => {
  const { st, ms } = await fresh()
  await st.saveTask(daily('t1', ['09:00', '15:00']))
  await ms.refreshMissed(NOW, TWO_DAYS_AGO)
  const total = (await ms.getMissed()).length
  let ran = 0
  await ms.catchUpAll(async () => { ran++; if (ran === 1) throw new Error('boom') })
  assert.equal(ran, total, '一筆失敗不得中斷其餘')
})

test('skipAll 清空清單', async () => {
  const { st, ms } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await ms.refreshMissed(NOW, TWO_DAYS_AGO)
  await ms.skipAll()
  assert.deepEqual(await ms.getMissed(), [])
})

test('skipOne 只移除指定的那一筆', async () => {
  const { st, ms } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await ms.refreshMissed(NOW, TWO_DAYS_AGO)
  const list = await ms.getMissed()
  await ms.skipOne(list[0].taskId, list[0].slot)
  const after = await ms.getMissed()
  assert.equal(after.length, list.length - 1)
  assert.ok(!after.some(x => x.slot === list[0].slot))
})

test('refreshMissed 重複執行不會產生重複項目', async () => {
  const { st, ms } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await ms.refreshMissed(NOW, TWO_DAYS_AGO)
  const first = (await ms.getMissed()).length
  await ms.refreshMissed(NOW, TWO_DAYS_AGO)
  assert.equal((await ms.getMissed()).length, first)
})
