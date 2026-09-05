process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const dg = await import('../src/shared/diag.js?t=' + Math.random())
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  return { c, st, dg, wd }
}

const daily = (id, times) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'daily', times, weekdays: [0, 1, 2, 3, 4, 5, 6] }
})

// ---------- 診斷環形緩衝 ----------
test('diag:寫入超過上限時只保留最後 500 筆', async () => {
  const { dg } = await fresh()
  for (let i = 0; i < 600; i++) await dg.log('test', String(i))
  const all = await dg.getAll()
  assert.equal(all.length, 500)
  assert.equal(all[all.length - 1].detail, '599', '最後一筆是最新的')
  assert.equal(all[0].detail, '100', '最舊的被丟掉')
})

test('diag:每筆有時間、種類、內容', async () => {
  const { dg } = await fresh()
  await dg.log('alarm', 't1:0 觸發')
  const [e] = await dg.getAll()
  assert.equal(e.kind, 'alarm')
  assert.equal(e.detail, 't1:0 觸發')
  assert.equal(typeof e.at, 'number')
})

// ---------- 看門狗 ----------
test('看門狗:任務的 alarm 不見了會補建', async () => {
  const { c, st, wd } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  assert.equal((await c.alarms.getAll()).filter(a => a.name.startsWith('t1')).length, 0)
  await wd.runWatchdog()
  assert.equal((await c.alarms.getAll()).filter(a => a.name.startsWith('t1')).length, 1)
})

test('看門狗:alarm 都在時不重建(不製造抖動)', async () => {
  const { c, st, wd } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await wd.runWatchdog()
  const before = (await c.alarms.getAll()).find(a => a.name.startsWith('t1')).scheduledTime
  const calls = c.__calls.filter(x => x.api === 'alarms.create').length
  await wd.runWatchdog()
  const after = (await c.alarms.getAll()).find(a => a.name.startsWith('t1')).scheduledTime
  assert.equal(after, before, '時間不該被重算')
  assert.equal(c.__calls.filter(x => x.api === 'alarms.create').length, calls)
})

test('看門狗:確保自己的 __watchdog alarm 存在', async () => {
  const { c, wd } = await fresh()
  await wd.runWatchdog()
  const wdAlarm = (await c.alarms.getAll()).find(a => a.name === '__watchdog')
  assert.ok(wdAlarm)
  assert.equal(wdAlarm.periodInMinutes, 15)
})

test('看門狗:清理卡超過三分鐘的執行中狀態', async () => {
  const { c, wd } = await fresh()
  const now = Date.now()
  await c.storage.session.set({
    inflight: {
      'a:2026-09-05T09:00': { state: 'extracting', startedAt: now - 5 * 60 * 1000 },
      'b:2026-09-05T09:00': { state: 'loading', startedAt: now - 30 * 1000 }
    }
  })
  await wd.runWatchdog()
  const { inflight } = await c.storage.session.get('inflight')
  assert.deepEqual(Object.keys(inflight), ['b:2026-09-05T09:00'], '只清掉卡住的那筆')
})

test('看門狗:清掉的卡住執行會被記進診斷', async () => {
  const { c, dg, wd } = await fresh()
  await c.storage.session.set({
    inflight: { 'a:2026-09-05T09:00': { state: 'extracting', startedAt: Date.now() - 600000 } }
  })
  await wd.runWatchdog()
  const kinds = (await dg.getAll()).map(e => e.kind)
  assert.ok(kinds.includes('interrupted'), '中斷的執行要留下痕跡')
})

test('看門狗:時區變更時重建所有 alarm', async () => {
  const { c, st, wd } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await wd.runWatchdog()
  await c.storage.local.set({ lastTimezone: 'America/New_York' })
  const before = c.__calls.filter(x => x.api === 'alarms.create').length
  await wd.runWatchdog()
  assert.ok(c.__calls.filter(x => x.api === 'alarms.create').length > before, '時區變了必須重建')
  const { lastTimezone } = await c.storage.local.get('lastTimezone')
  assert.equal(lastTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
})

test('看門狗:每次執行都留下心跳', async () => {
  const { dg, wd } = await fresh()
  await wd.runWatchdog()
  const kinds = (await dg.getAll()).map(e => e.kind)
  assert.ok(kinds.includes('watchdog'))
})

test('看門狗:任務全部停用時清掉它們的 alarm', async () => {
  const { c, st, wd } = await fresh()
  await st.saveTask(daily('t1', ['09:00']))
  await wd.runWatchdog()
  await st.saveTask({ ...daily('t1', ['09:00']), enabled: false })
  await wd.runWatchdog()
  assert.equal((await c.alarms.getAll()).filter(a => a.name.startsWith('t1')).length, 0)
})

test('看門狗:單一步驟丟例外不會讓整輪掛掉', async () => {
  const { c, wd } = await fresh()
  await c.storage.session.set({ inflight: 'this-is-not-an-object' })
  await assert.doesNotReject(() => wd.runWatchdog())
})

test('selfCheck 建立一分鐘後的測試 alarm 並回報', async () => {
  const { c, wd } = await fresh()
  const res = await wd.selfCheck()
  const t = (await c.alarms.getAll()).find(a => a.name === '__selftest')
  assert.ok(t, '應建立自檢 alarm')
  assert.ok(t.scheduledTime - Date.now() > 50000 && t.scheduledTime - Date.now() < 70000)
  assert.equal(res.scheduledAt, t.scheduledTime)
})
