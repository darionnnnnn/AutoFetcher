// AF-4 A1:interval 排程相位對齊(nextIntervalRun 純函式)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function loadScheduler() {
  resetChromeMock()
  installChromeMock()
  return await import('../src/background/scheduler.js?t=' + Math.random())
}

// 本地時間建構毫秒
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime()
// 期望值以 slot 字串比對,錯誤訊息比毫秒好讀
const slotStr = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const WEEKDAYS_MF = [1, 2, 3, 4, 5]

const task = (everyMinutes, over = {}) => ({
  id: 't1', name: 't1', url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'interval', everyMinutes, weekdays: WEEKDAYS_MF, ...over }
})

// 2026-09-07 是星期一,2026-09-12 是星期六,2026-09-13 是星期日
const MON = [2026, 9, 7]
const SAT = [2026, 9, 12]

test('有時段:從時段起點對齊,不是從現在起算', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const t = task(10, { window: { from: '08:30', to: '09:20' } })
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 8, 0))), '2026-09-07T08:30')
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 8, 31))), '2026-09-07T08:40')
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 8, 39, 59))), '2026-09-07T08:40')
})

test('時段終點是閉區間,09:20 這一格算數', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const t = task(10, { window: { from: '08:30', to: '09:20' } })
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 9, 15))), '2026-09-07T09:20')
})

test('時段最後一格已到,跳到下一個合法日的時段起點', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const t = task(10, { window: { from: '08:30', to: '09:20' } })
  // 恰好等於最後一格:必須嚴格大於 now,所以跳下一天
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 9, 20))), '2026-09-08T08:30')
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 23, 0))), '2026-09-08T08:30')
})

test('時段長度不是間隔的整數倍時,最後一格不得超過終點', async () => {
  const { nextIntervalRun } = await loadScheduler()
  // 08:30~09:15 每 10 分:08:30 08:40 08:50 09:00 09:10,沒有 09:20
  const t = task(10, { window: { from: '08:30', to: '09:15' } })
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 9, 5))), '2026-09-07T09:10')
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 9, 10))), '2026-09-08T08:30')
})

test('星期六日不排,跳到下週一', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const t = task(10, { window: { from: '08:30', to: '09:20' } })
  assert.equal(slotStr(nextIntervalRun(t, at(...SAT, 8, 0))), '2026-09-14T08:30')
})

test('沒有時段:對齊當日 00:00 起的間隔倍數,整天都排', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const t = task(10)
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 8, 33))), '2026-09-07T08:40')
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 23, 55))), '2026-09-08T00:00')
})

test('跨午夜時段:傍晚段從 from 對齊,凌晨段從 00:00 對齊', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const t = task(30, { window: { from: '22:00', to: '02:00' }, weekdays: [0, 1, 2, 3, 4, 5, 6] })
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 21, 59))), '2026-09-07T22:00')
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 23, 40))), '2026-09-08T00:00')
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 1, 45))), '2026-09-07T02:00')
  // 02:00 是凌晨段最後一格,過了就要等當天傍晚 22:00
  assert.equal(slotStr(nextIntervalRun(t, at(...MON, 2, 0))), '2026-09-07T22:00')
})

test('跨午夜時段的星期以該時刻自己所在的那一天判定', async () => {
  const { nextIntervalRun } = await loadScheduler()
  // 只勾星期一;星期一 02:00 前的凌晨段算星期一,星期二 00:30 不算
  const t = task(30, { window: { from: '22:00', to: '02:00' }, weekdays: [1] })
  assert.equal(slotStr(nextIntervalRun(t, at(2026, 9, 7, 0, 10))), '2026-09-07T00:30')
  assert.equal(slotStr(nextIntervalRun(t, at(2026, 9, 7, 23, 40))), '2026-09-14T00:00')
})

test('weekdays 缺省或空陣列一律視為每天', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const noWd = { id: 't1', schedule: { type: 'interval', everyMinutes: 10 } }
  const emptyWd = { id: 't1', schedule: { type: 'interval', everyMinutes: 10, weekdays: [] } }
  assert.equal(slotStr(nextIntervalRun(noWd, at(...SAT, 8, 33))), '2026-09-12T08:40')
  assert.equal(slotStr(nextIntervalRun(emptyWd, at(...SAT, 8, 33))), '2026-09-12T08:40')
})

test('間隔非法時回 null', async () => {
  const { nextIntervalRun } = await loadScheduler()
  for (const bad of [0, -5, undefined, null, 'abc', NaN]) {
    assert.equal(nextIntervalRun(task(bad), at(...MON, 8, 0)), null, `everyMinutes=${bad} 應回 null`)
  }
})

test('結果一律嚴格大於 now(等於 now 要跳下一格)', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const t = task(10)
  const now = at(...MON, 8, 30)
  const next = nextIntervalRun(t, now)
  assert.ok(next > now, '不得回傳等於 now 的時刻')
  assert.equal(slotStr(next), '2026-09-07T08:40')
})

test('回傳值的秒與毫秒必須歸零(才對得上排程槽)', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const d = new Date(nextIntervalRun(task(10), at(...MON, 8, 33, 27)))
  assert.equal(d.getSeconds(), 0)
  assert.equal(d.getMilliseconds(), 0)
})
