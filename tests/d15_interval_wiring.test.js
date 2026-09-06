// AF-4 A2:interval 排程改用對齊的 one-shot alarm(不再用 periodInMinutes)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function freshScheduler() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const sc = await import('../src/background/scheduler.js?t=' + Math.random())
  return { st, sc }
}

async function freshMain() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 5, raw: '5', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, bg }
}

async function freshWatchdog() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  return { c, st, wd }
}

const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100 }

const interval = (id, everyMinutes, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'interval', everyMinutes, weekdays: [0, 1, 2, 3, 4, 5, 6], ...over }
})

const minuteOf = (ms) => new Date(ms).getMinutes()

// ---- rebuildAlarms ----

test('rebuildAlarms:interval 一律用 when,不得再用 periodInMinutes', async () => {
  const { st, sc } = await freshScheduler()
  await st.saveTask(interval('i1', 15))
  await sc.rebuildAlarms()
  const all = (await chrome.alarms.getAll()).filter(a => a.name.startsWith('task:'))
  assert.equal(all.length, 1)
  assert.equal(all[0].periodInMinutes, undefined, 'interval 相位會漂,不可用 periodInMinutes')
  assert.ok(all[0].scheduledTime > Date.now(), '要排在未來')
})

test('rebuildAlarms:interval 的 when 與 nextIntervalRun 算出來的一致', async () => {
  const { st, sc } = await freshScheduler()
  await st.saveTask(interval('i1', 10))
  const before = Date.now()
  await sc.rebuildAlarms()
  const a = (await chrome.alarms.getAll()).find(x => x.name === 'task:i1:0')
  const expected = sc.nextIntervalRun(interval('i1', 10), before)
  assert.ok(Math.abs(a.scheduledTime - expected) <= 60000, `應對齊到 ${new Date(expected)},實得 ${new Date(a.scheduledTime)}`)
  assert.equal(minuteOf(a.scheduledTime) % 10, 0, '每 10 分鐘的任務要落在 10 的倍數上')
})

test('rebuildAlarms:interval 的 weekdays 缺省視為每天,照樣建 alarm', async () => {
  const { st, sc } = await freshScheduler()
  const t = interval('i1', 10)
  delete t.schedule.weekdays
  await st.saveTask(t)
  await sc.rebuildAlarms()
  const all = (await chrome.alarms.getAll()).filter(a => a.name.startsWith('task:'))
  assert.equal(all.length, 1, 'weekdays 缺省不該讓任務靜默停擺')
})

test('rebuildAlarms:everyMinutes 非法時不建 alarm', async () => {
  const { st, sc } = await freshScheduler()
  await st.saveTask(interval('i1', 0))
  await sc.rebuildAlarms()
  assert.equal((await chrome.alarms.getAll()).filter(a => a.name.startsWith('task:')).length, 0)
})

// ---- shouldRunInterval 的 weekdays 缺省 ----

test('shouldRunInterval:weekdays 缺省或空陣列視為每天', async () => {
  const { sc } = await freshScheduler()
  const noWd = { schedule: { type: 'interval', everyMinutes: 10 } }
  const emptyWd = { schedule: { type: 'interval', everyMinutes: 10, weekdays: [] } }
  assert.equal(sc.shouldRunInterval(noWd, Date.now()), true, 'weekdays 缺省不可一律回 false')
  assert.equal(sc.shouldRunInterval(emptyWd, Date.now()), true)
})

test('shouldRunInterval:有勾星期時仍照原規則過濾', async () => {
  const { sc } = await freshScheduler()
  const today = new Date().getDay()
  const other = (today + 1) % 7
  assert.equal(sc.shouldRunInterval({ schedule: { type: 'interval', everyMinutes: 10, weekdays: [today] } }, Date.now()), true)
  assert.equal(sc.shouldRunInterval({ schedule: { type: 'interval', everyMinutes: 10, weekdays: [other] } }, Date.now()), false)
})

// ---- 觸發後重排 ----

test('interval 觸發後會排下一個 one-shot alarm', async () => {
  const { c, st, bg } = await freshMain()
  await st.saveTask(interval('i1', 10))
  await bg.handleAlarm({ name: 'task:i1:0', scheduledTime: Date.now() }, FAST)
  const created = c.__calls.filter(x => x.api === 'alarms.create' && x.args?.[0] === 'task:i1:0')
  assert.ok(created.length >= 1, '觸發後必須自己排下一次,否則只跑一次就停')
  const info = created[created.length - 1].args[1]
  assert.equal(info.periodInMinutes, undefined)
  assert.ok(info.when > Date.now())
})

test('interval 的排程槽取 alarm 的 scheduledTime,不是實際觸發時刻', async () => {
  const { st, bg } = await freshMain()
  await st.saveTask(interval('i1', 10))
  // 模擬電腦忙碌,alarm 晚了 90 秒才被處理
  const scheduledTime = Date.now() - 90000
  await bg.handleAlarm({ name: 'task:i1:0', scheduledTime }, FAST)
  const localDate = (ms) => {
    const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const recs = await st.getRecordsByDate(localDate(scheduledTime))
  assert.equal(recs.length, 1)
  const expectedSlot = (() => {
    const d = new Date(scheduledTime); const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  })()
  assert.equal(recs[0].slot, expectedSlot, '槽要對齊 alarm 排定時刻,晚觸發不可自成新槽(冪等靠它)')
})

test('時段外觸發時不抓,但仍要排下一次', async () => {
  const { c, st, bg } = await freshMain()
  const now = new Date()
  const from = String((now.getHours() + 2) % 24).padStart(2, '0') + ':00'
  const to = String((now.getHours() + 3) % 24).padStart(2, '0') + ':00'
  await st.saveTask(interval('i1', 5, { window: { from, to } }))
  await bg.handleAlarm({ name: 'task:i1:0', scheduledTime: Date.now() }, FAST)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0, '時段外不得抓取')
  const created = c.__calls.filter(x => x.api === 'alarms.create' && x.args?.[0] === 'task:i1:0')
  assert.ok(created.length >= 1, '時段外提早 return 會讓任務永遠不再排,必須先重排')
})

// ---- 看門狗 ----

test('看門狗補建 interval alarm 時也用 when,不得自己另寫一份週期算法', async () => {
  const { c, st, wd } = await freshWatchdog()
  await st.saveTask(interval('i1', 10))
  await wd.runWatchdog()
  const a = (await chrome.alarms.getAll()).find(x => x.name === 'task:i1:0')
  assert.ok(a, '看門狗要補上缺的 alarm')
  assert.equal(a.periodInMinutes, undefined)
  assert.equal(minuteOf(a.scheduledTime) % 10, 0, '看門狗補的 alarm 也要對齊')
})
