process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// 紀錄日期取自 slot（當地時區），測試不可用 UTC 日期，否則跨 UTC 午夜會誤判
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 5, raw: '5', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, bg }
}

const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100 }
const daily = (id, times = ['09:00']) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times, weekdays: [0, 1, 2, 3, 4, 5, 6] }
})

test('載入時註冊所有必要的監聽器', async () => {
  const { c } = await fresh()
  assert.ok(c.alarms.onAlarm._listeners.size >= 1, '要接 onAlarm')
  assert.ok(c.runtime.onInstalled._listeners.size >= 1)
  assert.ok(c.runtime.onStartup._listeners.size >= 1)
  assert.ok(c.runtime.onMessage._listeners.size >= 1)
  assert.ok(c.contextMenus.onClicked._listeners.size >= 1)
  assert.ok(c.notifications.onButtonClicked._listeners.size >= 1, '通知按鈕要有人接')
})

test('載入時本身不做任何事(worker 每次喚醒都會重新載入)', async () => {
  const { c } = await fresh()
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.equal(c.__calls.filter(x => x.api === 'alarms.create').length, 0)
})

test('安裝/更新時建右鍵選單、重建排程、確保看門狗', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1'))
  await c.__emitInstalled({ reason: 'update' })
  const menus = c.__calls.filter(x => x.api === 'contextMenus.create')
  assert.ok(menus.length >= 4, '父項加至少三個子項')
  const names = (await c.alarms.getAll()).map(a => a.name)
  assert.ok(names.some(n => n.startsWith('task:t1:')), '更新後排程必須重建,否則任務會靜默停擺')
  assert.ok(names.includes('__watchdog'))
})

test('瀏覽器啟動時重建排程、算錯過清單、更新燈號', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1'))
  await c.__emitStartup()
  const names = (await c.alarms.getAll()).map(a => a.name)
  assert.ok(names.some(n => n.startsWith('task:t1:')))
  assert.ok(names.includes('__watchdog'))
  assert.ok(c.__calls.some(x => x.api === 'action.setBadgeText'), '要更新燈號')
})

test('看門狗 alarm 觸發時跑看門狗,不抓資料', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1'))
  await c.__emitAlarm('__watchdog')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  const names = (await c.alarms.getAll()).map(a => a.name)
  assert.ok(names.some(n => n.startsWith('task:t1:')), '看門狗會補建缺失的 alarm')
})

test('任務 alarm 觸發時抓資料並寫紀錄', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(daily('t1'))
  await bg.handleAlarm({ name: 'task:t1:0' }, FAST)
  const today = localToday()
  const recs = await st.getRecordsByDate(today)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].taskId, 't1')
})

test('任務 alarm 觸發後會重排下一次(每日排程不能只響一次)', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(daily('t1'))
  await bg.handleAlarm({ name: 'task:t1:0' }, FAST)
  const next = (await c.alarms.getAll()).find(a => a.name === 'task:t1:0')
  assert.ok(next, '抓完必須排下一次')
  assert.ok(next.scheduledTime > Date.now())
})

test('已刪除任務的 alarm 觸發時安靜略過,不丟例外', async () => {
  const { bg } = await fresh()
  await assert.doesNotReject(() => bg.handleAlarm({ name: 'task:gone:0' }, FAST))
})

test('停用任務的 alarm 觸發時不抓,並清掉該 alarm', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask({ ...daily('t1'), enabled: false })
  await c.alarms.create('task:t1:0', { when: Date.now() })
  await bg.handleAlarm({ name: 'task:t1:0' }, FAST)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.equal((await c.alarms.getAll()).filter(a => a.name === 'task:t1:0').length, 0)
})

test('interval 任務在時段外觸發時不抓', async () => {
  const { c, st, bg } = await fresh()
  const now = new Date()
  const from = String((now.getHours() + 2) % 24).padStart(2, '0') + ':00'
  const to = String((now.getHours() + 3) % 24).padStart(2, '0') + ':00'
  await st.saveTask({
    ...daily('i1'), schedule: { type: 'interval', everyMinutes: 5, weekdays: [0, 1, 2, 3, 4, 5, 6], window: { from, to } }
  })
  await bg.handleAlarm({ name: 'task:i1:0' }, FAST)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
})

test('預檢 alarm 觸發時跑演練,不留紀錄', async () => {
  const { st, bg } = await fresh()
  await st.saveTask(daily('t1'))
  await bg.handleAlarm({ name: 't1:pre:0' }, FAST)
  const today = localToday()
  assert.equal((await st.getRecordsByDate(today)).length, 0, '預檢不得產生紀錄')
})

test('重試 alarm 觸發時帶著遞增的 attempt 再抓一次', async () => {
  const { c, st, bg } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await st.saveTask(daily('t1'))
  await bg.handleAlarm({ name: 't1:retry:2' }, FAST)
  const today = localToday()
  const recs = await st.getRecordsByDate(today)
  assert.equal(recs.length, 1, 'attempt 3 是最後一次,要寫失敗紀錄')
  assert.equal(recs[0].status, 'not_found')
})

test('訊息 RUN_TASK 會抓指定任務', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1'))
  await c.__emitMessage({ type: 'RUN_TASK', taskId: 't1', __testOpts: FAST })
  const today = localToday()
  assert.equal((await st.getRecordsByDate(today)).length, 1)
})

test('訊息 REBUILD_ALARMS 會重建排程與預檢', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1', ['09:00', '15:00']))
  await c.__emitMessage({ type: 'REBUILD_ALARMS' })
  const names = (await c.alarms.getAll()).map(a => a.name)
  assert.equal(names.filter(n => /^task:t1:\d+$/.test(n)).length, 2)
  assert.ok(names.some(n => n.includes(':pre:')), '預檢也要一起排')
})

test('訊息 REBUILD_ALARMS 之後燈號要跟著更新', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1'))
  const before = c.__calls.filter(x => x.api === 'action.setBadgeText').length
  await c.__emitMessage({ type: 'REBUILD_ALARMS' })
  assert.ok(c.__calls.filter(x => x.api === 'action.setBadgeText').length > before,
    '新增或修改任務後燈號不更新的話,popup 會停在舊狀態')
})

test('訊息 MARK_READ 會把異常標成已讀', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1'))
  const he = await import('../src/background/health.js?t=' + Math.random())
  await he.setTaskHealth('t1', { status: 'selector_lost' })
  await c.__emitMessage({ type: 'MARK_READ', taskIds: ['t1'] })
  assert.equal((await he.getHealth()).t1.read, true)
})

test('未知訊息不回應也不丟例外', async () => {
  const { c } = await fresh()
  await assert.doesNotReject(() => c.__emitMessage({ type: 'WHATEVER' }))
})

test('通知按鈕:第一顆補抓全部,第二顆全部略過', async () => {
  const { c, st, bg } = await fresh()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  await st.saveTask(daily('t1'))
  await ms.refreshMissed(Date.now(), Date.now() - 3 * 86400000)
  assert.ok((await ms.getMissed()).length > 0, '前提:要先有錯過項目')
  await bg.handleNotificationButton('missed', 1)
  assert.deepEqual(await ms.getMissed(), [], '第二顆是略過')
})

test('右鍵選單:抓取此文字會向分頁要描述並開設定視窗', async () => {
  const { c, bg } = await fresh()
  c.__setTabResponder(() => ({ ok: true, locator: { css: '#v' }, preview: '12', previewValue: 12 }))
  await bg.handleContextMenu({ menuItemId: 'af-capture' }, { id: 9, url: 'https://a.test/p' })
  const sent = c.__calls.find(x => x.api === 'tabs.sendMessage')
  assert.equal(sent.args[0], 9)
  assert.equal(sent.args[1].type, 'DESCRIBE')
  const win = c.__calls.find(x => x.api === 'windows.create')
  assert.ok(win, '要開設定視窗')
  assert.match(String(win.args[0].url), /picker\.html/)
})

test('右鍵選單:分頁上沒有右鍵目標時提示使用者,不開視窗', async () => {
  const { c, bg } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'no_target' }))
  await bg.handleContextMenu({ menuItemId: 'af-capture' }, { id: 9, url: 'https://a.test/p' })
  assert.equal(c.__calls.filter(x => x.api === 'windows.create').length, 0)
  assert.ok(c.__calls.some(x => x.api === 'notifications.create'), '要告訴使用者發生什麼事')
})

test('右鍵選單:開啟報表', async () => {
  const { c, bg } = await fresh()
  await bg.handleContextMenu({ menuItemId: 'af-open-report' }, { id: 9, url: 'https://a.test/p' })
  const call = c.__calls.find(x => x.api === 'tabs.create')
  assert.match(String(call.args[0].url), /report\.html/)
})
