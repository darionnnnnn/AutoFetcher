// AF-24 C1：啟動與看門狗同時算錯過清單：gap 不重複累加、lastSeenAt 不被拉回
process.env.TZ = 'Asia/Taipei'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const HOUR = 3600000
const MIN = 60000
const interval = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'interval', everyMinutes: 10, weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

async function fresh(nowMs) {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: nowMs })
  resetChromeMock()
  installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  return { st, ms }
}
test.afterEach(() => mock.timers.reset())

test('兩個 refreshMissed 同時跑（同一個窗）：gap 只算一次', async () => {
  const now = at(2026, 9, 18, 12, 0)
  const { st, ms } = await fresh(now)
  await st.saveTask(interval('i1', { createdAt: now - 10 * 24 * HOUR }))
  await st.setLastSeenAt(now - 2 * HOUR)
  await Promise.all([ms.refreshMissed(now), ms.refreshMissed(now)])
  const list = await st.getMissedList()
  assert.equal(list.length, 1)
  assert.equal(list[0].count, 10, `(10:00, 11:40] 共 10 格，實得 ${list[0].count}`)
  assert.equal('slots' in list[0], false, '逐格清單不寫進 storage')
  assert.equal(await st.getLastSeenAt(), now - 20 * MIN)
})

test('較晚的窗先寫完、較早的窗後寫：lastSeenAt 不得被拉回，重疊的格子不再加', async () => {
  const now = at(2026, 9, 18, 12, 0)
  const { st, ms } = await fresh(now)
  await st.saveTask(interval('i1', { createdAt: now - 10 * 24 * HOUR }))
  await st.setLastSeenAt(now - 2 * HOUR)
  await ms.refreshMissed(now + 30 * MIN)   // 算到 12:10
  await ms.refreshMissed(now, now - 2 * HOUR) // 慢的那一輪（同樣起點）後到
  const list = await st.getMissedList()
  assert.equal(list[0].count, 13, `10:10…12:10 共 13 格，實得 ${list[0].count}`)
  assert.equal(list[0].slot, '2026-09-18T12:10')
  assert.equal(await st.getLastSeenAt(), now + 10 * MIN)
})
