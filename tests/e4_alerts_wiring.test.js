// AF-3 批次 E:告警接線(抓取時評估、60 分鐘去重、通知、紀錄標記、通知點擊路由)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 1234, raw: '1,234', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, fe }
}

const task = (over = {}) => ({
  id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  alerts: [{ id: 'a1', type: 'gt', value: 1000, enabled: true }],
  ...over
})

const notifyCount = (c) => c.__calls.filter(x => x.api === 'notifications.create').length

test('命中告警:紀錄標 alert 與 alertHits,並發通知', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.alert, true)
  assert.deepEqual(rec.alertHits, ['a1'])
  assert.equal(notifyCount(c), 1, '命中要通知')
  const opts = c.__calls.find(x => x.api === 'notifications.create').args[1]
  assert.ok(opts.message.includes('1234') || opts.message.includes('1,234'), `通知要說發生什麼:${opts.message}`)
})

test('沒命中:紀錄不得有 alert 標記,也不通知', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ alerts: [{ id: 'a1', type: 'gt', value: 99999, enabled: true }] })
  await st.saveTask(t)
  const rec = await fe.runTask(t, { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.alert, undefined)
  assert.equal(notifyCount(c), 0)
})

test('60 分鐘內同一條件不重複通知,但紀錄照樣標記', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  const r1 = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  const r2 = await fe.runTask(task(), { slot: '2026-09-06T09:30', ...FAST })
  assert.equal(r1.alert, true)
  assert.equal(r2.alert, true, '紀錄一律標記,去重只針對通知')
  assert.equal(notifyCount(c), 1, '半小時內不該通知第二次')
})

test('超過冷卻時間後會再通知一次', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  // 把上次通知時間往前推 61 分鐘
  const res = await chrome.storage.local.get('alertLog')
  const log = res.alertLog
  log.t1.a1 = Date.now() - 61 * 60 * 1000
  await chrome.storage.local.set({ alertLog: log })
  await fe.runTask(task(), { slot: '2026-09-06T10:00', ...FAST })
  assert.equal(notifyCount(c), 2)
})

test('冷卻時間可用設定調整', async () => {
  const { c, st, fe } = await fresh()
  await st.saveSettings({ alertCooldownMin: 1 })
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  const res = await chrome.storage.local.get('alertLog')
  const log = res.alertLog
  log.t1.a1 = Date.now() - 2 * 60 * 1000
  await chrome.storage.local.set({ alertLog: log })
  await fe.runTask(task(), { slot: '2026-09-06T09:05', ...FAST })
  assert.equal(notifyCount(c), 2, '設定 1 分鐘後,兩分鐘前的通知不該再被壓住')
})

test('兩個不同條件各自獨立去重', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ alerts: [
    { id: 'a1', type: 'gt', value: 1000, enabled: true },
    { id: 'a2', type: 'lt', value: 9999, enabled: true }
  ] })
  await st.saveTask(t)
  const rec = await fe.runTask(t, { slot: '2026-09-06T09:00', ...FAST })
  assert.deepEqual(rec.alertHits, ['a1', 'a2'])
  assert.equal(notifyCount(c), 2, '兩個條件各通知一次')
})

test('連續失敗的告警也會評估(失敗紀錄同樣要標記)', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ alerts: [{ id: 'a1', type: 'failStreak', value: 2, enabled: true }] })
  await st.saveTask(t)
  c.__setTabResponder(() => ({ ok: false, error: 'parse_error', raw: '--' }))
  const r1 = await fe.runTask(t, { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(r1.alert, undefined, '第一次失敗還不到門檻')
  const r2 = await fe.runTask(t, { slot: '2026-09-06T10:00', ...FAST })
  assert.equal(r2.alert, true, '第二次失敗要命中')
  assert.deepEqual(r2.alertHits, ['a1'])
})

test('演練(dryRun)不評估告警,也不寫 alertLog', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: 'precheck', dryRun: true, ...FAST })
  assert.equal(notifyCount(c), 0)
  const res = await chrome.storage.local.get('alertLog')
  assert.equal(res.alertLog, undefined)
})

test('關閉通知偏好時不通知,但紀錄仍要標記(報表看得到)', async () => {
  const { c, st, fe } = await fresh()
  await st.saveSettings({ notifications: false })
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.alert, true)
  assert.equal(notifyCount(c), 0)
})

test('沒有設定 alerts 的任務完全不受影響', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ alerts: undefined })
  await st.saveTask(t)
  const rec = await fe.runTask(t, { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.equal(rec.alert, undefined)
  assert.equal(notifyCount(c), 0)
})

// ---- 通知點擊路由(D13:過去只註冊了 onButtonClicked) ----

test('點告警通知會開報表並定位到該任務那一天', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  assert.ok(typeof bg.handleNotificationClick === 'function', 'main 必須匯出通知點擊處理')
  await bg.handleNotificationClick('t1:alert:a1:2026-09-06')
  const opened = c.__calls.find(x => x.api === 'tabs.create')
  assert.ok(opened, '要開報表')
  const url = String(opened.args[0].url)
  assert.match(url, /report\.html/)
  assert.ok(url.includes('t1'), `要帶上任務,實得 ${url}`)
  assert.ok(url.includes('2026-09-06'), `要帶上日期,實得 ${url}`)
})

test('通知點擊事件真的有註冊(不是只寫了函式沒接上)', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  assert.ok(c.notifications.onClicked._listeners.size > 0, 'chrome.notifications.onClicked 必須有監聽')
})
