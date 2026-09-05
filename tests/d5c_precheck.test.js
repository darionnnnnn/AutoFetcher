process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// 紀錄日期取自 slot（當地時區），測試不可用 UTC 日期，否則跨 UTC 午夜會誤判
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const he = await import('../src/background/health.js?t=' + Math.random())
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, fe, he, pc }
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00', '15:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

// ---------- fetcher 的演練模式 ----------
test('dryRun:不寫紀錄、不記帳本,但回傳擷取結果', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  const r = await fe.runTask(task(), { slot: '2026-09-05T09:00', dryRun: true, ...FAST })
  assert.equal(r.ok, true)
  assert.equal(r.value, 12)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 0, '演練不得留下紀錄')
  const { runs } = await c.storage.local.get('runs')
  assert.equal(runs?.t1?.['2026-09-05T09:00'], undefined, '演練不得記帳本')
})

test('dryRun:不受帳本冪等阻擋,可以重複演練', async () => {
  const { st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  const r = await fe.runTask(task(), { slot: '2026-09-05T09:00', dryRun: true, ...FAST })
  assert.equal(r.ok, true, '正式抓過了,演練仍要能跑')
})

test('dryRun:失敗時也不寫紀錄、不排重試', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await st.saveTask(task())
  const r = await fe.runTask(task(), { slot: '2026-09-05T09:00', dryRun: true, ...FAST })
  assert.equal(r.ok, false)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 0)
  assert.equal((await c.alarms.getAll()).filter(a => a.name.includes('retry')).length, 0)
})

// ---------- 預檢排程 ----------
test('schedulePrechecks:每個時間點前 N 分鐘各建一個預檢 alarm', async () => {
  const { c, st, pc } = await fresh()
  await st.saveTask(task({ precheckLeadMinutes: 30 }))
  await pc.schedulePrechecks()
  const pre = (await c.alarms.getAll()).filter(a => a.name.includes(':pre:'))
  assert.equal(pre.length, 2, '兩個時間點各一個')
  assert.ok(pre.every(a => a.periodInMinutes === undefined), '預檢也要重算,不可用週期')
})

test('schedulePrechecks:預檢時間確實比正式時間早 N 分鐘', async () => {
  const { c, st, pc } = await fresh()
  await st.saveTask(task({ precheckLeadMinutes: 30, schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] } }))
  await pc.schedulePrechecks()
  const pre = (await c.alarms.getAll()).find(a => a.name.includes(':pre:'))
  const d = new Date(pre.scheduledTime)
  assert.equal(d.getHours(), 8)
  assert.equal(d.getMinutes(), 30)
})

test('schedulePrechecks:提前時間設 0 代表關閉', async () => {
  const { c, st, pc } = await fresh()
  await st.saveTask(task({ precheckLeadMinutes: 0 }))
  await pc.schedulePrechecks()
  assert.equal((await c.alarms.getAll()).filter(a => a.name.includes(':pre:')).length, 0)
})

test('schedulePrechecks:沒設定時預設提前 30 分鐘', async () => {
  const { c, st, pc } = await fresh()
  await st.saveTask(task({ schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] } }))
  await pc.schedulePrechecks()
  const pre = (await c.alarms.getAll()).find(a => a.name.includes(':pre:'))
  assert.equal(new Date(pre.scheduledTime).getMinutes(), 30)
})

test('schedulePrechecks:interval 任務不做每槽預檢(太頻繁)', async () => {
  const { c, st, pc } = await fresh()
  await st.saveTask(task({ schedule: { type: 'interval', everyMinutes: 5, weekdays: [0, 1, 2, 3, 4, 5, 6] } }))
  await pc.schedulePrechecks()
  assert.equal((await c.alarms.getAll()).filter(a => a.name.includes(':pre:')).length, 0)
})

test('schedulePrechecks:停用的任務不排預檢,且會清掉舊的', async () => {
  const { c, st, pc } = await fresh()
  await st.saveTask(task())
  await pc.schedulePrechecks()
  assert.ok((await c.alarms.getAll()).some(a => a.name.includes(':pre:')))
  await st.saveTask(task({ enabled: false }))
  await pc.schedulePrechecks()
  assert.equal((await c.alarms.getAll()).filter(a => a.name.includes(':pre:')).length, 0)
})

test('isPrecheckAlarm 認得預檢 alarm 並取出任務 id', async () => {
  const { pc } = await fresh()
  assert.deepEqual(pc.parsePrecheckName('t1:pre:0'), { taskId: 't1', index: 0 })
  assert.equal(pc.parsePrecheckName('t1:0'), null)
  assert.equal(pc.parsePrecheckName('__watchdog'), null)
})

// ---------- 執行預檢 ----------
test('預檢成功:健康狀態設為 ok,不通知,不留紀錄', async () => {
  const { c, st, he, pc } = await fresh()
  await st.saveTask(task())
  await pc.runPrecheck(task(), FAST)
  assert.equal((await he.getHealth()).t1.status, 'ok')
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 0)
  assert.equal((await st.getRecordsByDate(localToday())).length, 0)
})

test('預檢找不到元素:標成 selector_lost 並通知,訊息含任務名', async () => {
  const { c, st, he, pc } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await st.saveTask(task())
  await pc.runPrecheck(task(), FAST)
  assert.equal((await he.getHealth()).t1.status, 'selector_lost')
  const note = c.__calls.find(x => x.api === 'notifications.create')
  assert.ok(note, '預檢失敗要提早告訴使用者')
  assert.match(JSON.stringify(note.args[1]), /總量/)
})

test('預檢抓不到數值:標成 parse_error', async () => {
  const { c, st, he, pc } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'parse_error', raw: '--' }))
  await st.saveTask(task())
  await pc.runPrecheck(task(), FAST)
  assert.equal((await he.getHealth()).t1.status, 'parse_error')
})

test('預檢停在登入頁:標成 login_failed', async () => {
  const { c, st, he, pc } = await fresh()
  await st.saveSite('https://a.test', { loginUrl: 'https://a.test/login', loginPageUrlPrefix: 'https://a.test/login' })
  await st.saveTask(task({ url: 'https://a.test/login?next=/p' }))
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await pc.runPrecheck(task({ url: 'https://a.test/login?next=/p' }), FAST)
  assert.equal((await he.getHealth()).t1.status, 'login_failed')
})

test('預檢由失敗轉成功:健康狀態回到 ok', async () => {
  const { c, st, he, pc } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await pc.runPrecheck(task(), FAST)
  c.__setTabResponder(() => ({ ok: true, value: 1, raw: '1', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await pc.runPrecheck(task(), FAST)
  assert.equal((await he.getHealth()).t1.status, 'ok')
})

test('預檢丟例外不會讓呼叫端炸掉', async () => {
  const { c, st, pc } = await fresh()
  c.__setTabResponder(() => { throw new Error('boom') })
  await st.saveTask(task())
  await assert.doesNotReject(() => pc.runPrecheck(task(), FAST))
})
