process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const sc = await import('../src/background/scheduler.js?t=' + Math.random())
  return { st, sc }
}

const daily = (id, times, weekdays = [0, 1, 2, 3, 4, 5, 6]) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'daily', times, weekdays }
})
const interval = (id, everyMinutes, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'interval', everyMinutes, weekdays: [0, 1, 2, 3, 4, 5, 6], ...over }
})

// ---------- 純函式:排程槽 ----------
test('slotOf 用本地時間產生 YYYY-MM-DDTHH:mm', async () => {
  const { sc } = await fresh()
  assert.equal(sc.slotOf(new Date(2026, 8, 5, 9, 30).getTime()), '2026-09-05T09:30')
  assert.equal(sc.slotOf(new Date(2026, 0, 2, 3, 5).getTime()), '2026-01-02T03:05', '個位數要補零')
})

// ---------- 純函式:下一次每日觸發 ----------
test('nextDailyRun:今天還沒到就排今天', async () => {
  const { sc } = await fresh()
  const now = new Date(2026, 8, 5, 8, 0).getTime()
  assert.equal(sc.nextDailyRun(now, ['09:00'], [0, 1, 2, 3, 4, 5, 6]), new Date(2026, 8, 5, 9, 0).getTime())
})

test('nextDailyRun:今天已過就排明天同一時間', async () => {
  const { sc } = await fresh()
  const now = new Date(2026, 8, 5, 10, 0).getTime()
  assert.equal(sc.nextDailyRun(now, ['09:00'], [0, 1, 2, 3, 4, 5, 6]), new Date(2026, 8, 6, 9, 0).getTime())
})

test('nextDailyRun:多個時間取今天最近的下一個', async () => {
  const { sc } = await fresh()
  const now = new Date(2026, 8, 5, 10, 0).getTime()
  assert.equal(sc.nextDailyRun(now, ['09:00', '15:00', '21:00'], [0, 1, 2, 3, 4, 5, 6]),
    new Date(2026, 8, 5, 15, 0).getTime())
})

test('nextDailyRun:剛好等於現在的時間點不算今天,要排到下一次', async () => {
  const { sc } = await fresh()
  const now = new Date(2026, 8, 5, 9, 0).getTime()
  assert.equal(sc.nextDailyRun(now, ['09:00'], [0, 1, 2, 3, 4, 5, 6]), new Date(2026, 8, 6, 9, 0).getTime())
})

test('nextDailyRun:跳過未勾選的星期', async () => {
  const { sc } = await fresh()
  const now = new Date(2026, 8, 5, 10, 0).getTime()
  const got = new Date(sc.nextDailyRun(now, ['09:00'], [1]))
  assert.equal(got.getDay(), 1, '應落在星期一')
  assert.equal(got.getHours(), 9)
  assert.equal(got.getMinutes(), 0)
  assert.ok(got.getTime() > now)
  assert.ok(got.getTime() - now < 8 * 86400000, '最多找一週內')
})

test('nextDailyRun:沒有任何時間或沒有勾星期時回 null', async () => {
  const { sc } = await fresh()
  const now = Date.now()
  assert.equal(sc.nextDailyRun(now, [], [1]), null)
  assert.equal(sc.nextDailyRun(now, ['09:00'], []), null)
})

// ---------- interval 觸發判定 ----------
test('shouldRunInterval:時段內且星期符合才抓', async () => {
  const { sc } = await fresh()
  const t = interval('i1', 10, { window: { from: '09:00', to: '18:00' }, weekdays: [1, 2, 3, 4, 5] })
  const mon = new Date(2026, 8, 7, 10, 0)
  assert.equal(mon.getDay(), 1)
  assert.equal(sc.shouldRunInterval(t, mon.getTime()), true)
  assert.equal(sc.shouldRunInterval(t, new Date(2026, 8, 7, 8, 59).getTime()), false, '時段前不抓')
  assert.equal(sc.shouldRunInterval(t, new Date(2026, 8, 7, 18, 1).getTime()), false, '時段後不抓')
  assert.equal(sc.shouldRunInterval(t, new Date(2026, 8, 5, 10, 0).getTime()), false, '星期六不抓')
})

test('shouldRunInterval:沒設時段時整天都抓', async () => {
  const { sc } = await fresh()
  const t = interval('i1', 10)
  assert.equal(sc.shouldRunInterval(t, new Date(2026, 8, 5, 3, 0).getTime()), true)
})

test('shouldRunInterval:跨午夜時段(22:00~02:00)兩端都算數', async () => {
  const { sc } = await fresh()
  const t = interval('i1', 10, { window: { from: '22:00', to: '02:00' } })
  assert.equal(sc.shouldRunInterval(t, new Date(2026, 8, 5, 23, 0).getTime()), true)
  assert.equal(sc.shouldRunInterval(t, new Date(2026, 8, 5, 1, 0).getTime()), true)
  assert.equal(sc.shouldRunInterval(t, new Date(2026, 8, 5, 12, 0).getTime()), false)
})

// ---------- alarm 名稱 ----------
test('alarmName / parseAlarmName 往返,taskId 含冒號也不會拆錯', async () => {
  const { sc } = await fresh()
  const n = sc.alarmName('t:1', 2)
  assert.deepEqual(sc.parseAlarmName(n), { taskId: 't:1', index: 2 })
  assert.equal(sc.parseAlarmName('__watchdog'), null, '非任務 alarm 回 null')
})

// ---------- rebuildAlarms ----------
test('rebuildAlarms:daily 三個時間建三個 alarm,且不得使用 periodInMinutes', async () => {
  const { st, sc } = await fresh()
  await st.saveTask(daily('t1', ['09:00', '15:00', '21:00']))
  await sc.rebuildAlarms()
  const all = await chrome.alarms.getAll()
  assert.equal(all.length, 3)
  for (const a of all) {
    assert.equal(a.periodInMinutes, undefined, 'daily 不可用 periodInMinutes(日光節約會漂移)')
    assert.ok(a.scheduledTime > Date.now())
  }
})

// AF-4:interval 改為對齊的 one-shot alarm,原「用 periodInMinutes」的斷言已反轉,
// 詳細行為見 tests/d15_interval_wiring.test.js
test('rebuildAlarms:interval 用對齊的 when,不用 periodInMinutes', async () => {
  const { st, sc } = await fresh()
  await st.saveTask(interval('i1', 15))
  await sc.rebuildAlarms()
  const all = await chrome.alarms.getAll()
  assert.equal(all.length, 1)
  assert.equal(all[0].periodInMinutes, undefined)
  assert.ok(all[0].scheduledTime > Date.now())
})

test('rebuildAlarms:停用的任務不建 alarm', async () => {
  const { st, sc } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await st.saveTask({ ...daily('t2', ['09:00']), enabled: false })
  await sc.rebuildAlarms()
  const all = await chrome.alarms.getAll()
  assert.equal(all.length, 1)
  assert.equal(sc.parseAlarmName(all[0].name).taskId, 't1')
})

test('rebuildAlarms:先清空舊的,不會重複累積', async () => {
  const { st, sc } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await sc.rebuildAlarms()
  await sc.rebuildAlarms()
  await sc.rebuildAlarms()
  assert.equal((await chrome.alarms.getAll()).length, 1)
})

test('rebuildAlarms:保留看門狗 alarm 不被清掉', async () => {
  const { st, sc } = await fresh()
  await chrome.alarms.create('__watchdog', { periodInMinutes: 15 })
  await st.saveTask(daily('t1', ['09:00']))
  await sc.rebuildAlarms()
  const names = (await chrome.alarms.getAll()).map(a => a.name)
  assert.ok(names.includes('__watchdog'), '看門狗必須存活')
})

test('rebuildAlarms:排程設定不合法的任務略過,不丟例外', async () => {
  const { st, sc } = await fresh()
  await st.saveTask({ ...daily('t1', []), schedule: { type: 'daily', times: [], weekdays: [] } })
  await st.saveTask(daily('t2', ['09:00']))
  await sc.rebuildAlarms()
  assert.equal((await chrome.alarms.getAll()).length, 1)
})

test('ensureWatchdog 建立每 15 分鐘的看門狗,重複呼叫不重複建立', async () => {
  const { sc } = await fresh()
  await sc.ensureWatchdog()
  await sc.ensureWatchdog()
  const wd = (await chrome.alarms.getAll()).filter(a => a.name === '__watchdog')
  assert.equal(wd.length, 1)
  assert.equal(wd[0].periodInMinutes, 15)
})
