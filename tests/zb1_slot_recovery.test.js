// AF-21 批次 2：排程槽取排定時刻、遲到標記、先排後跑、runState 復原
// 時鐘用 node:test 的 mock.timers 只假 Date（setTimeout 照真的跑），讓跨日情境每天都測得到
process.env.TZ = 'Asia/Taipei'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100 }
const OK = () => ({ ok: true, value: 7, raw: '7', status: 'ok', strategyUsed: 'auto', layer: 'css' })
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

async function fresh(nowMs) {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: nowMs })
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}
test.afterEach(() => mock.timers.reset())

const daily = (id, time, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: [time], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})
const interval = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'interval', everyMinutes: 10, weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

// ---- 2-1 排程槽與遲到 ----

test('晚觸發跨日：23:55 的 alarm 在隔天 00:05 才跑，寫進昨天那一格、隔天那格帳本仍空', async () => {
  const { c, st, bg } = await fresh(at(2026, 9, 18, 0, 5))
  await st.saveTask(daily('d1', '23:55'))
  c.__setTabResponder(OK)
  await bg.handleAlarm({ name: 'task:d1:0', scheduledTime: at(2026, 9, 17, 23, 55) }, FAST)
  const recs = await st.getRecordsByDate('2026-09-17')
  assert.equal(recs.length, 1)
  assert.equal(recs[0].slot, '2026-09-17T23:55')
  assert.equal(recs[0].status, 'ok', '晚 10 分鐘不算遲到')
  assert.equal(await st.getRunStatus('d1', '2026-09-18T23:55'), undefined, '不得預先佔住隔天那一格')
  assert.equal((await st.getRecordsByDate('2026-09-18')).length, 0)
})

test('晚 7 小時才抓到：狀態記 late（算成功）', async () => {
  const { c, st, bg } = await fresh(at(2026, 9, 18, 7, 0))
  await st.saveTask(daily('d1', '23:55'))
  c.__setTabResponder(OK)
  await bg.handleAlarm({ name: 'task:d1:0', scheduledTime: at(2026, 9, 17, 23, 55) }, FAST)
  const [r] = await st.getRecordsByDate('2026-09-17')
  assert.equal(r.status, 'late')
  assert.equal(r.value, 7)
})

test('晚 25 分鐘（重試成功的典型值）仍是 ok，不變黃燈', async () => {
  const { c, st, bg } = await fresh(at(2026, 9, 18, 9, 25))
  await st.saveTask(interval('i1'))
  c.__setTabResponder(OK)
  await bg.handleAlarm({ name: 'i1:retry:2@2026-09-18T09:00' }, FAST)
  const [r] = await st.getRecordsByDate('2026-09-18')
  assert.equal(r.slot, '2026-09-18T09:00')
  assert.equal(r.status, 'ok')
})

test('抓取失敗不得被改寫成 late', async () => {
  const { c, st, bg } = await fresh(at(2026, 9, 18, 7, 0))
  await st.saveTask(daily('d1', '23:55'))
  c.__setTabResponder(() => ({ ok: false, error: 'not_found' }))
  // 第 1、2 次失敗只排重試不寫紀錄；用第 3 次（重試 alarm 的 attempt 2 → 3）才會寫失敗紀錄
  await bg.handleAlarm({ name: 'd1:retry:2@2026-09-17T23:55' }, FAST)
  const recs = await st.getRecordsByDate('2026-09-17')
  assert.ok(recs.length >= 1)
  assert.ok(recs.every(r => r.status !== 'late'), '失敗的紀錄維持失敗狀態')
})

test('晚超過 24 小時的 daily alarm 不執行，但下一次 alarm 已排好', async () => {
  const { c, st, bg } = await fresh(at(2026, 9, 19, 0, 30))
  await st.saveTask(daily('d1', '23:55'))
  c.__setTabResponder(OK)
  await bg.handleAlarm({ name: 'task:d1:0', scheduledTime: at(2026, 9, 17, 23, 55) }, FAST)
  assert.equal((await st.getRecordsInRange('2026-09-01', '2026-09-30')).length, 0, '三天前那格不該填今天的值（任何一天都不得寫）')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create' || x.api === 'windows.create').length, 0, '不得開頁去抓')
  const next = (await chrome.alarms.getAll()).find(a => a.name === 'task:d1:0')
  assert.ok(next && next.scheduledTime > Date.now(), '下一次要排好')
})

test('daily：抓取途中丟例外，下一次 alarm 仍存在，而且留下診斷', async () => {
  const { c, st, bg } = await fresh(at(2026, 9, 18, 9, 0))
  await st.saveTask(daily('d1', '09:00'))
  const origGet = c.storage.local.get
  c.storage.local.get = async (k) => {
    if (k === 'settings' || (Array.isArray(k) && k.includes('settings'))) throw new Error('boom')
    return origGet(k)
  }
  await bg.handleAlarm({ name: 'task:d1:0', scheduledTime: at(2026, 9, 18, 9, 0) }, { pollMs: 1, loadTimeoutMs: 100, extractTimeoutMs: 100 })
  c.storage.local.get = origGet
  const next = (await chrome.alarms.getAll()).find(a => a.name === 'task:d1:0')
  assert.ok(next && next.scheduledTime > Date.now(), 'one-shot alarm 不能因為這一次失敗就消失')
  const diag = (await chrome.storage.local.get('diag')).diag || []
  assert.ok(diag.some(e => e.kind === 'alarm_error'), '外層 catch 不得靜默')
})

// ---- 2-2 runState 與復原 ----

test('執行中會登記在 runState（帶這個 worker 的 boot），結束就移除', async () => {
  const { c, st } = await fresh(at(2026, 9, 18, 9, 0))
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  const { BOOT } = await import('../src/background/fetch-tab.js')
  await st.saveTask(daily('d1', '09:00'))
  let during = null
  c.__setTabResponder(async () => { during = await st.getRunState(); return OK() })
  await fetcher.runTask(await st.getTask('d1'), { slot: '2026-09-18T09:00', ...FAST })
  const entry = during?.['d1@2026-09-18T09:00']
  assert.ok(entry, '執行中要登記')
  assert.equal(entry.state, 'running')
  assert.equal(entry.boot, BOOT)
  assert.deepEqual(await st.getRunState(), {}, '結束要移除')
})

test('手動抓取與試抓不登記 runState', async () => {
  const { c, st } = await fresh(at(2026, 9, 18, 9, 0))
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(daily('d1', '09:00'))
  let during = 'unset'
  c.__setTabResponder(async () => { during = await st.getRunState(); return OK() })
  await fetcher.runTask(await st.getTask('d1'), { reason: 'manual', ...FAST })
  assert.deepEqual(during, {})
  await fetcher.runTask(await st.getTask('d1'), { dryRun: true, ...FAST })
  assert.deepEqual(during, {})
})

test('復原：別的 worker 留下、10 分鐘內的項目 → 續跑一次，帳本只有一格', async () => {
  const { c, st } = await fresh(at(2026, 9, 18, 9, 5))
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(daily('d1', '09:00'))
  await st.updateRunState(() => ({ 'd1@2026-09-18T09:00': { state: 'queued', at: at(2026, 9, 18, 9, 0), boot: 'old-boot', attempt: 1, reason: 'scheduled' } }))
  c.__setTabResponder(OK)
  await fetcher.recoverRunState(FAST)
  const recs = await st.getRecordsByDate('2026-09-18')
  assert.equal(recs.length, 1)
  assert.equal(recs[0].status, 'ok')
  assert.equal(await st.getRunStatus('d1', '2026-09-18T09:00'), 'ok')
  assert.deepEqual(await st.getRunState(), {})
  await fetcher.recoverRunState(FAST)
  assert.equal((await st.getRecordsByDate('2026-09-18')).length, 1, '再跑一次復原不得重抓')
})

test('復原：超過 10 分鐘 → interrupted 紀錄＋紅燈；daily 進錯過清單、不寫帳本（才補抓得到）', async () => {
  const { c, st } = await fresh(at(2026, 9, 18, 9, 40))
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTasks([daily('d1', '09:00'), interval('i1')])
  await st.updateRunState(() => ({
    'd1@2026-09-18T09:00': { state: 'running', at: at(2026, 9, 18, 9, 0), boot: 'old-boot', attempt: 1, reason: 'scheduled' },
    'i1@2026-09-18T09:10': { state: 'queued', at: at(2026, 9, 18, 9, 10), boot: 'old-boot', attempt: 1, reason: 'scheduled' }
  }))
  let fetched = 0
  c.__setTabResponder(() => { fetched++; return OK() })
  await fetcher.recoverRunState(FAST)
  assert.equal(fetched, 0, '太舊的不續跑')
  const recs = await st.getRecordsByDate('2026-09-18')
  assert.deepEqual(recs.map(r => [r.taskId, r.slot, r.status]).sort(), [['d1', '2026-09-18T09:00', 'interrupted'], ['i1', '2026-09-18T09:10', 'interrupted']])
  assert.equal(await st.getRunStatus('d1', '2026-09-18T09:00'), undefined)
  const missed = await st.getMissedList()
  assert.ok(missed.some(m => m.taskId === 'd1' && m.slot === '2026-09-18T09:00'), 'daily 要能補抓')
  assert.ok(!missed.some(m => m.taskId === 'i1'), 'interval 不進錯過清單')
  const health = await st.getHealthMap()
  assert.equal(health.d1.status, 'interrupted')
  assert.deepEqual(await st.getRunState(), {})
})

test('復原：同一個 worker（boot 相同）的項目不碰', async () => {
  const { c, st } = await fresh(at(2026, 9, 18, 9, 40))
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  const { BOOT } = await import('../src/background/fetch-tab.js')
  await st.saveTask(daily('d1', '09:00'))
  const mine = { 'd1@2026-09-18T09:00': { state: 'running', at: at(2026, 9, 18, 9, 39), boot: BOOT, attempt: 1, reason: 'scheduled' } }
  await st.updateRunState(() => mine)
  let fetched = 0
  c.__setTabResponder(() => { fetched++; return OK() })
  await fetcher.recoverRunState(FAST)
  assert.equal(fetched, 0)
  assert.deepEqual(await st.getRunState(), mine)
  assert.equal((await st.getRecordsByDate('2026-09-18')).length, 0)
})

test('復原：runState 為空（瀏覽器重啟後 session 清空）什麼都不做', async () => {
  const { st } = await fresh(at(2026, 9, 18, 9, 40))
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  await assert.doesNotReject(() => fetcher.recoverRunState(FAST))
  assert.deepEqual(await st.getRunState(), {})
})

test('復原：啟動與看門狗同時復原，同一格只處理一次', async () => {
  const { c, st } = await fresh(at(2026, 9, 18, 9, 40))
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(daily('d1', '09:00'))
  await st.updateRunState(() => ({ 'd1@2026-09-18T09:00': { state: 'running', at: at(2026, 9, 18, 9, 0), boot: 'old-boot', attempt: 1, reason: 'scheduled' } }))
  c.__setTabResponder(OK)
  await Promise.all([fetcher.recoverRunState(FAST), fetcher.recoverRunState(FAST)])
  const recs = await st.getRecordsByDate('2026-09-18')
  assert.equal(recs.filter(r => r.status === 'interrupted').length, 1)
  assert.equal((await st.getMissedList()).filter(m => m.taskId === 'd1').length, 1)
})
