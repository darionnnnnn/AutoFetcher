// AF-21 段 2-D：失敗通知冷卻與同站台合併、預檢 alarm 只排自己、看門狗補預檢／清殘留、喚醒後算錯過、interval 空窗（gap）
process.env.TZ = 'Asia/Taipei'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { lockNameOf, heldLocks } from '../src/shared/lock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100 }
const OK = () => ({ ok: true, value: 7, raw: '7', status: 'ok', strategyUsed: 'auto', layer: 'css' })
const NOT_FOUND = () => ({ ok: false, error: 'not_found', snippet: 'x' })
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const HOUR = 3600000
const MIN = 60000

async function fresh(nowMs) {
  mock.timers.reset()
  if (typeof nowMs === 'number') mock.timers.enable({ apis: ['Date'], now: nowMs })
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  return { c, st }
}
test.afterEach(() => mock.timers.reset())

const daily = (id, times, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times, weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})
const interval = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'interval', everyMinutes: 10, weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

const creates = (c, pred = () => true) => c.__calls.filter(x => x.api === 'notifications.create' && pred(x.args))
const idOf = (args) => (typeof args[0] === 'string' ? args[0] : null)
const optsOf = (args) => (typeof args[0] === 'string' ? args[1] : args[0])

// ================= 1. 失敗通知冷卻 =================

test('抓取「找不到元素」：同狀態 24 小時內第二次不跳；狀態換了會跳；成功後再壞會跳；超過 24 小時會跳', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const t = daily('t1', ['09:00'])
  await st.saveTask(t)
  const failN = () => creates(c, a => idOf(a) === 'fail:https://a.test').length
  let n = 0
  const slot = () => `2026-09-05T09:${String(n++).padStart(2, '0')}`

  c.__setTabResponder(NOT_FOUND)
  await fe.runTask(t, { slot: slot(), attempt: 3, ...FAST })
  assert.equal(failN(), 1, '第一次失敗要通知')
  await fe.runTask(t, { slot: slot(), attempt: 3, ...FAST })
  assert.equal(failN(), 1, '同狀態 24 小時內不再跳')
  assert.equal((await st.getHealthMap()).t1?.status, 'selector_lost', '燈號照寫，不受冷卻影響')

  // 帳本記的是別的狀態 → 狀態換了
  await st.updateNotifyLog(log => ({ ...log, t1: { status: 'parse_error', at: Date.now() } }))
  await fe.runTask(t, { slot: slot(), attempt: 3, ...FAST })
  assert.equal(failN(), 2, '狀態換了要跳')

  // 成功 → 清帳本 → 再壞會跳
  c.__setTabResponder(OK)
  await fe.runTask(t, { slot: slot(), attempt: 3, ...FAST })
  assert.equal((await st.getNotifyLog()).t1, undefined, '成功要清掉冷卻紀錄')
  c.__setTabResponder(NOT_FOUND)
  await fe.runTask(t, { slot: slot(), attempt: 3, ...FAST })
  assert.equal(failN(), 3, '恢復後再壞要跳')

  // 超過 24 小時
  await st.updateNotifyLog(log => ({ ...log, t1: { status: 'not_found', at: Date.now() - 25 * HOUR } }))
  await fe.runTask(t, { slot: slot(), attempt: 3, ...FAST })
  assert.equal(failN(), 4, '超過 24 小時要跳')
  await st.updateNotifyLog(log => ({ ...log, t1: { status: 'not_found', at: Date.now() - 23 * HOUR } }))
  await fe.runTask(t, { slot: slot(), attempt: 3, ...FAST })
  assert.equal(failN(), 4, '23 小時內仍擋')
})

test('抓取失敗：notifications:false 一則都不跳，也不記冷卻帳', async () => {
  const { c, st } = await fresh()
  await st.saveSettings({ notifications: false })
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const t = daily('t1', ['09:00'])
  await st.saveTask(t)
  c.__setTabResponder(NOT_FOUND)
  await fe.runTask(t, { slot: '2026-09-05T09:00', attempt: 3, ...FAST })
  await fe.runTask(t, { slot: '2026-09-05T09:01', attempt: 3, ...FAST })
  assert.equal(creates(c).length, 0)
  assert.equal((await st.getNotifyLog()).t1, undefined)
})

test('預檢失敗：同狀態 24 小時內不跳、狀態換了跳、成功後再壞跳、超過 24 小時跳、notifications:false 零則', async () => {
  const { c, st } = await fresh()
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  const t = daily('p1', ['09:00'])
  await st.saveTask(t)
  const preN = () => creates(c, a => idOf(a) === 'p1:precheck').length

  c.__setTabResponder(NOT_FOUND)
  await pc.runPrecheck(t, FAST)
  assert.equal(preN(), 1)
  await pc.runPrecheck(t, FAST)
  assert.equal(preN(), 1, '同狀態不再跳')
  assert.equal((await st.getHealthMap()).p1?.status, 'selector_lost', '燈號照寫')

  await st.updateNotifyLog(log => ({ ...log, 'p1:precheck': { status: 'failed', at: Date.now() } }))
  await pc.runPrecheck(t, FAST)
  assert.equal(preN(), 2, '狀態換了要跳')

  c.__setTabResponder(OK)
  await pc.runPrecheck(t, FAST)
  assert.equal((await st.getNotifyLog())['p1:precheck'], undefined, '預檢成功要清')
  c.__setTabResponder(NOT_FOUND)
  await pc.runPrecheck(t, FAST)
  assert.equal(preN(), 3, '恢復後再壞要跳')

  await st.updateNotifyLog(log => ({ ...log, 'p1:precheck': { status: 'selector_lost', at: Date.now() - 25 * HOUR } }))
  await pc.runPrecheck(t, FAST)
  assert.equal(preN(), 4, '超過 24 小時要跳')

  await st.saveSettings({ notifications: false })
  await st.updateNotifyLog(() => ({}))
  await pc.runPrecheck(t, FAST)
  assert.equal(preN(), 4, 'notifications:false 零則')
})

async function site(st, origin) {
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  await st.saveSite(origin, {
    loginUrl: `${origin}/login`,
    selectors: { user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' } },
    loginCheck: { type: 'urlPrefix', value: `${origin}/login` },
    successCheck: { type: 'urlPrefix', value: `${origin}/home` },
    username: 'wayne', passwordEnc: await cr.encryptSecret('hunter2'), enabled: true, failStreak: 0
  })
}

test('站台檢查失敗：同狀態 24 小時內不跳、狀態換了跳、成功後再壞跳、超過 24 小時跳、notifications:false 零則', async () => {
  const { c, st } = await fresh()
  const O = 'https://a.test'
  await site(st, O)
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  const OPTS = { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 }
  c.__setTabResponder(() => ({ ok: true }))
  let landing = `${O}/login`
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: landing, status: 'complete' })
  // 連續三次登入失敗會停用站台（login.js 既有規則）：每次檢查前重存站台，只測通知冷卻
  const check = async () => { await site(st, O); await sc.runSiteCheck(OPTS) }
  const siteN = () => creates(c, a => idOf(a) === `site:${O}:check`).length

  await check()
  assert.equal(siteN(), 1)
  await check()
  assert.equal(siteN(), 1, '同狀態不再跳')
  assert.equal((await st.getHealthMap())[`site:${O}`]?.status, 'login_failed', '燈號照寫')

  await st.updateNotifyLog(log => ({ ...log, [`site:${O}`]: { status: 'other', at: Date.now() } }))
  await check()
  assert.equal(siteN(), 2, '狀態換了要跳')

  landing = `${O}/home`
  await check()
  assert.equal((await st.getHealthMap())[`site:${O}`]?.status, 'ok')
  assert.equal((await st.getNotifyLog())[`site:${O}`], undefined, '檢查成功要清')
  landing = `${O}/login`
  await check()
  assert.equal(siteN(), 3, '恢復後再壞要跳')

  await st.updateNotifyLog(log => ({ ...log, [`site:${O}`]: { status: 'login_failed', at: Date.now() - 25 * HOUR } }))
  await check()
  assert.equal(siteN(), 4, '超過 24 小時要跳')

  await st.saveSettings({ notifications: false })
  await st.updateNotifyLog(() => ({}))
  await check()
  assert.equal(siteN(), 4, 'notifications:false 零則')
})

test('pruneOrphanEntries 一併清 notifyLog 裡已不存在的任務與站台', async () => {
  const { st } = await fresh()
  await st.saveTask(daily('keep', ['09:00']))
  await site(st, 'https://a.test')
  await st.updateNotifyLog(() => ({
    keep: { status: 'x', at: 1 }, 'keep:precheck': { status: 'x', at: 1 }, 'site:https://a.test': { status: 'x', at: 1 },
    gone: { status: 'x', at: 1 }, 'gone:precheck': { status: 'x', at: 1 }, 'site:https://b.test': { status: 'x', at: 1 }
  }))
  await st.pruneOrphanEntries()
  assert.deepEqual(Object.keys(await st.getNotifyLog()).sort(), ['keep', 'keep:precheck', 'site:https://a.test'])
})

// ================= 2. 同站台合併 =================

test('同一 origin 三個任務接連失敗 → 只有一個通知 id，最後訊息含三個名稱與「3 個任務」；不同 origin 各自一則', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const ts = [daily('a1', ['09:00'], { name: '甲' }), daily('a2', ['09:00'], { name: '乙' }), daily('a3', ['09:00'], { name: '丙' })]
  const other = daily('b1', ['09:00'], { name: '丁', url: 'https://b.test/p' })
  await st.saveTasks([...ts, other])
  c.__setTabResponder(NOT_FOUND)
  for (const t of ts) await fe.runTask(t, { slot: '2026-09-05T09:00', attempt: 3, ...FAST })
  await fe.runTask(other, { slot: '2026-09-05T09:00', attempt: 3, ...FAST })

  const all = creates(c)
  const ids = new Set(all.map(x => idOf(x.args)))
  assert.deepEqual([...ids].sort(), ['fail:https://a.test', 'fail:https://b.test'])
  const lastA = all.filter(x => idOf(x.args) === 'fail:https://a.test').at(-1)
  const msg = optsOf(lastA.args).message
  for (const name of ['甲', '乙', '丙']) assert.ok(msg.includes(name), `訊息要有 ${name}：${msg}`)
  assert.ok(msg.includes('3 個任務'), msg)
  const msgB = optsOf(all.filter(x => idOf(x.args) === 'fail:https://b.test').at(-1).args).message
  assert.ok(msgB.includes('丁') && msgB.includes('1 個任務') && !msgB.includes('甲'), msgB)
})

test('合併：超過 3 個列前 3 個加「等」；被冷卻擋下的任務不列入；超過 5 分鐘重新累計', async () => {
  const { c, st } = await fresh()
  const nf = await import('../src/background/notify.js?t=' + Math.random())
  const now = Date.now()
  const O = 'https://a.test'
  await nf.notifySiteFailure(O, { id: 'x1', name: 'A' }, 'not_found', { nowMs: now })
  await nf.notifySiteFailure(O, { id: 'x2', name: 'B' }, 'not_found', { nowMs: now })
  await st.updateNotifyLog(log => ({ ...log, x9: { status: 'not_found', at: now } }))
  assert.equal(await nf.notifySiteFailure(O, { id: 'x9', name: 'Z' }, 'not_found', { nowMs: now }), false, '冷卻中不跳')
  await nf.notifySiteFailure(O, { id: 'x3', name: 'C' }, 'not_found', { nowMs: now })
  await nf.notifySiteFailure(O, { id: 'x4', name: 'D' }, 'not_found', { nowMs: now })
  let msg = optsOf(creates(c).at(-1).args).message
  assert.ok(msg.includes('4 個任務') && msg.includes('A、B、C等') && !msg.includes('D') && !msg.includes('Z'), msg)
  await nf.notifySiteFailure(O, { id: 'x5', name: 'E' }, 'not_found', { nowMs: now + 6 * MIN })
  msg = optsOf(creates(c).at(-1).args).message
  assert.ok(msg.includes('1 個任務') && msg.includes('E') && !msg.includes('A'), `超過 5 分鐘要重新累計：${msg}`)
})

// 替身守門（與 za1 同一套規則）：每次 set/remove 要持有那個鍵的鎖、讀寫同一次持有、只持有一把
function guardArea(area, ns, state) {
  const orig = { get: area.get.bind(area), set: area.set.bind(area), remove: area.remove.bind(area) }
  area.get = async (keys) => {
    const list = keys === null || keys === undefined ? ['*'] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
    const held = heldLocks()
    for (const k of list) {
      if (k === '*') continue
      const name = lockNameOf(k, ns)
      state.reads.set(ns + ':' + k, held.has(name) ? held.get(name) : null)
    }
    return orig.get(keys)
  }
  const check = (k, op) => {
    const name = lockNameOf(k, ns)
    if (name === 'session:fetchTabs') return
    const held = heldLocks()
    if (!held.has(name)) { state.violations.push(`${op} ${ns}:${k} 沒有持有鎖`); return }
    if (held.size !== 1) state.violations.push(`${op} ${ns}:${k} 同時持有 ${held.size} 把鎖`)
    const r = state.reads.get(ns + ':' + k)
    if (r !== undefined && r !== held.get(name)) state.violations.push(`${op} ${ns}:${k} 讀寫不在同一次持有`)
  }
  area.set = async (items) => { for (const k of Object.keys(items || {})) check(k, 'set'); return orig.set(items) }
  area.remove = async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) check(k, 'remove'); return orig.remove(keys) }
}

test('updateNotifyLog 與 session 累計（updateFailMerge）都在鎖內讀-改-寫（za1 同一套守門）', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const state = { reads: new Map(), violations: [] }
  guardArea(c.storage.local, 'local', state)
  guardArea(c.storage.session, 'session', state)
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  const nf = await import('../src/background/notify.js?t=' + Math.random())
  await st.init()
  const run = async (label, fn) => {
    state.reads = new Map(); state.violations = []
    await fn()
    assert.deepEqual(state.violations, [], `${label} 違反鎖規則`)
  }
  await run('updateNotifyLog', () => st.updateNotifyLog(l => ({ ...l, t1: { status: 'x', at: 1 } })))
  await run('updateFailMerge', () => st.updateFailMerge(m => ({ ...m, o: { at: 1, items: [] } })))
  await run('notifyFailure', () => nf.notifyFailure('t2', 'x', { title: 'a', message: 'b' }))
  await run('clearNotifyLog', () => nf.clearNotifyLog('t2'))
  await run('notifySiteFailure', () => nf.notifySiteFailure('https://a.test', { id: 't3', name: 'n' }, 'not_found'))
  assert.ok((await c.storage.session.get('failMerge')).failMerge?.['https://a.test'], '累計確實寫在 storage.session')

  // 守門本身要抓得到漏鎖（避免假守門）
  state.reads = new Map(); state.violations = []
  await c.storage.local.set({ notifyLog: {} })
  assert.equal(state.violations.length, 1, '鎖外寫入要被抓到')
})

// ================= 3. 預檢 alarm =================

test('預檢 alarm 觸發後只清／建自己那個任務，其他任務的預檢 alarm 不動', async () => {
  const { c, st } = await fresh()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  await st.saveTasks([daily('p1', ['09:00', '15:00']), daily('p2', ['10:00'])])
  await pc.schedulePrechecks()
  const p2Before = (await c.alarms.getAll()).find(a => a.name === 'p2:pre:0')
  assert.ok(p2Before)
  c.__calls.length = 0
  c.__setTabResponder(OK)
  await bg.handleAlarm({ name: 'p1:pre:0', scheduledTime: Date.now() }, FAST)
  const cleared = c.__calls.filter(x => x.api === 'alarms.clear').map(x => x.args[0])
  assert.ok(cleared.length > 0, '自己那個任務要重排')
  assert.ok(cleared.every(n => n.startsWith('p1:pre:')), `只清自己：${cleared}`)
  const created = c.__calls.filter(x => x.api === 'alarms.create').map(x => x.args[0])
  assert.ok(!created.some(n => n.startsWith('p2:')), `不重建別人的：${created}`)
  assert.equal((await c.alarms.getAll()).find(a => a.name === 'p2:pre:0'), p2Before, 'p2 的 alarm 物件還是原本那一個')
  assert.ok((await c.alarms.getAll()).some(a => a.name === 'p1:pre:1'))
})

test('schedulePrechecks 不帶 taskId 仍是全部重建（REBUILD_ALARMS 用）', async () => {
  const { c, st } = await fresh()
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  await st.saveTasks([daily('p1', ['09:00']), daily('p2', ['10:00'])])
  await pc.schedulePrechecks()
  c.__calls.length = 0
  await pc.schedulePrechecks()
  const cleared = c.__calls.filter(x => x.api === 'alarms.clear').map(x => x.args[0]).sort()
  assert.deepEqual(cleared, ['p1:pre:0', 'p2:pre:0'])
})

test('看門狗：刪掉一個預檢 alarm 後跑一輪會補回；已刪任務的重試 alarm 與停用任務的預檢 alarm 被清', async () => {
  const { c, st } = await fresh()
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveTasks([daily('p1', ['09:00']), daily('p2', ['10:00'], { enabled: false })])
  await pc.schedulePrechecks()
  const expected = (await c.alarms.getAll()).find(a => a.name === 'p1:pre:0').scheduledTime
  await c.alarms.clear('p1:pre:0')
  await c.alarms.create('gone:retry:1@2026-09-05T09:00', { when: Date.now() + MIN })
  await c.alarms.create('p2:retry:2@2026-09-05T10:00', { when: Date.now() + MIN })
  await c.alarms.create('p2:pre:0', { when: Date.now() + HOUR })
  await c.alarms.create('p1:retry:1@2026-09-05T09:00', { when: Date.now() + MIN })
  await wd.runWatchdog()
  const names = (await c.alarms.getAll()).map(a => a.name)
  const back = (await c.alarms.getAll()).find(a => a.name === 'p1:pre:0')
  assert.ok(back, '預檢 alarm 要補回')
  assert.equal(back.scheduledTime, expected, '與 schedulePrechecks 同一份計算')
  assert.ok(!names.includes('gone:retry:1@2026-09-05T09:00'), '已刪任務的重試 alarm 要清')
  assert.ok(!names.includes('p2:retry:2@2026-09-05T10:00'), '停用任務的重試 alarm 要清')
  assert.ok(!names.includes('p2:pre:0'), '停用任務的預檢 alarm 要清')
  assert.ok(names.includes('p1:retry:1@2026-09-05T09:00'), '啟用任務的重試 alarm 不動')
})

// ================= 4. 喚醒後也算錯過 =================

test('喚醒：lastSeenAt 9 小時前、沒有 onStartup → 看門狗一輪後列出 daily 槽；再一輪不重複、不再通知；10 分鐘前的格子不列；lastSeenAt＝現在−20 分鐘', async () => {
  const now = at(2026, 9, 18, 12, 0)
  const { c, st } = await fresh(now)
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveTask(daily('d1', ['04:00', '11:50']))
  await st.setLastSeenAt(now - 9 * HOUR)
  await wd.runWatchdog()
  let list = await st.getMissedList()
  assert.deepEqual(list.map(m => m.slot), ['2026-09-18T04:00'], '04:00 列入、11:50（10 分鐘前）不列入')
  assert.equal(await st.getLastSeenAt(), now - 20 * MIN)
  const missedN = () => creates(c, a => idOf(a) === 'missed-tasks').length
  assert.equal(missedN(), 1)

  await wd.runWatchdog()
  list = await st.getMissedList()
  assert.equal(list.length, 1, '不重複列')
  assert.equal(missedN(), 1, '不再通知')

  // 時間往前走 15 分鐘：11:50 已過 25 分鐘 → 這一輪才接著算到它
  mock.timers.setTime(now + 15 * MIN)
  await wd.runWatchdog()
  list = await st.getMissedList()
  assert.deepEqual(list.map(m => m.slot), ['2026-09-18T04:00', '2026-09-18T11:50'], '下一輪接著算、不漏')
  assert.equal(await st.getLastSeenAt(), now + 15 * MIN - 20 * MIN)
})

// ================= 5. interval 空窗 =================

test('gap：每 10 分鐘、lastSeenAt 2 小時前、帳本空 → 一筆 gap，count＝應觸發格數（排除最後 20 分鐘）；再跑不重複計', async () => {
  const now = at(2026, 9, 18, 12, 0)
  const { c, st } = await fresh(now)
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveTask(interval('i1', { createdAt: now - 10 * 24 * HOUR }))
  await st.setLastSeenAt(now - 2 * HOUR)
  await wd.runWatchdog()
  let list = await st.getMissedList()
  assert.equal(list.length, 1)
  // (10:00, 11:40]：10:10 … 11:40 共 10 格
  assert.deepEqual(list[0], { taskId: 'i1', taskName: 'i1', kind: 'gap', count: 10, from: '2026-09-18T10:10', slot: '2026-09-18T11:40' })
  assert.equal(creates(c, a => idOf(a) === 'missed-tasks').length, 0, 'gap 不另外通知')
  await wd.runWatchdog()
  list = await st.getMissedList()
  assert.equal(list.length, 1)
  assert.equal(list[0].count, 10, '再跑一輪不重複計')

  // 時間往前 30 分鐘：同一筆 gap 加上 11:50、12:00、12:10 三格，slot 延到 12:10
  mock.timers.setTime(now + 30 * MIN)
  await wd.runWatchdog()
  list = await st.getMissedList()
  assert.equal(list.length, 1, '不新增第二筆')
  assert.equal(list[0].count, 13)
  assert.equal(list[0].from, '2026-09-18T10:10')
  assert.equal(list[0].slot, '2026-09-18T12:10')
})

test('gap：帳本有其中幾格 → count 扣掉；createdAt 在 30 分鐘前 → 只算那之後的格子；漏 0 格不產生', async () => {
  const now = at(2026, 9, 18, 12, 0)
  const { st } = await fresh(now)
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  await st.saveTasks([interval('i1', { createdAt: 0 }), interval('i2', { createdAt: now - 30 * MIN }), interval('i3', { createdAt: 0 })])
  await st.setRunStatus('i1', '2026-09-18T10:30', 'ok')
  await st.setRunStatus('i1', '2026-09-18T10:40', 'not_found')
  for (let m = 10; m <= 100; m += 10) {
    const h = 10 + Math.floor(m / 60)
    await st.setRunStatus('i3', `2026-09-18T${h}:${String(m % 60).padStart(2, '0')}`, 'ok')
  }
  await ms.refreshMissed(now, now - 2 * HOUR)
  const list = await st.getMissedList()
  const byId = Object.fromEntries(list.map(m => [m.taskId, m]))
  assert.equal(byId.i1.count, 8, '帳本有的兩格扣掉')
  assert.equal(byId.i2.count, 2, '只算 11:30、11:40')
  assert.equal(byId.i2.from, '2026-09-18T11:30')
  assert.equal(byId.i3, undefined, '漏 0 格不產生項目')
})

test('saveTasks 新任務寫 createdAt；以不含 createdAt 的物件更新既有任務後不變；沒有 createdAt 的舊任務視為很早以前建立', async () => {
  const now = at(2026, 9, 18, 12, 0)
  const { st } = await fresh(now)
  await st.saveTasks([interval('n1')])
  const [t] = await st.getTasks()
  assert.equal(t.createdAt, now)
  mock.timers.setTime(now + HOUR)
  const { createdAt, ...rest } = t
  await st.saveTasks([{ ...rest, name: '改名' }])
  const [t2] = await st.getTasks()
  assert.equal(t2.name, '改名')
  assert.equal(t2.createdAt, now, 'createdAt 不變')

  // 舊任務（沒有 createdAt）：整段窗都算
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  const gaps = ms.computeIntervalGaps([interval('old')], {}, now - 2 * HOUR, now - 20 * MIN)
  assert.equal(gaps[0].count, 10)
})

test('catchUpAll 不對 gap 呼叫 runTask 且 gap 仍在清單；catchUpOne 也略過；skipOne 移除它', async () => {
  const { st } = await fresh()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  await st.saveTasks([interval('i1'), daily('d1', ['09:00'])])
  const gap = { taskId: 'i1', taskName: 'i1', kind: 'gap', count: 5, from: '2026-09-18T10:10', slot: '2026-09-18T10:50' }
  await st.updateMissedList(() => [gap, { taskId: 'd1', taskName: 'd1', slot: '2026-09-18T09:00' }])
  const ran = []
  await ms.catchUpAll(async (task, opts) => { ran.push(`${task.id}@${opts.slot}`) })
  assert.deepEqual(ran, ['d1@2026-09-18T09:00'])
  assert.deepEqual(await st.getMissedList(), [gap], 'gap 仍在清單')
  await ms.catchUpOne('i1', gap.slot, async (task) => { ran.push(task.id) })
  assert.equal(ran.length, 1, 'catchUpOne 也不得對 gap 呼叫 runTask')
  assert.equal((await st.getMissedList()).length, 1)
  await ms.skipOne('i1', gap.slot)
  assert.deepEqual(await st.getMissedList(), [])
})

test('popup：gap 列沒有補抓鈕、文字含「休眠期間略過」、只有「知道了」且送 SKIP_ONE', async () => {
  const { c } = await fresh()
  const html = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  const gap = { taskId: 'i1', taskName: '匯率', kind: 'gap', count: 12, from: '2026-09-18T10:10', slot: '2026-09-18T12:00' }
  pp.render({
    health: { level: 'yellow', summary: '1 個任務注意' },
    tasks: [interval('i1', { name: '匯率' })],
    lastValues: {}, nextRuns: {}, healthMap: {},
    missed: [gap]
  })
  const doc = jd.window.document
  const rows = doc.querySelectorAll('.missed-gap')
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.ok(row.textContent.includes('休眠期間略過 12 次'), row.textContent)
  assert.ok(row.textContent.includes('2026-09-18T10:10～2026-09-18T12:00'), row.textContent)
  assert.ok(!row.textContent.includes('補抓'), '不得有補抓')
  const buttons = [...row.querySelectorAll('button')]
  assert.deepEqual(buttons.map(b => b.textContent), ['知道了'])
  buttons[0].click()
  await new Promise(r => setTimeout(r, 10))
  const sent = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  assert.deepEqual(sent.filter(m => m.type === 'SKIP_ONE'), [{ type: 'SKIP_ONE', taskId: 'i1', slot: '2026-09-18T12:00' }])
  assert.ok(!sent.some(m => m.type === 'CATCH_UP_ONE'))
})

test('任務頁：gap 列沒有補抓鈕與勾選框、文字含「休眠期間略過」；「補抓勾選項目」不送 gap；「知道了」送 SKIP_ONE', async () => {
  const { c } = await fresh()
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  const gap = { taskId: 'i1', taskName: '匯率', kind: 'gap', count: 3, from: '2026-09-18T10:10', slot: '2026-09-18T10:30' }
  ts.renderTasks([interval('i1', { name: '匯率' }), daily('d1', ['09:00'])], {}, [{ taskId: 'd1', slot: '2026-09-18T09:00' }, gap])
  const doc = jd.window.document
  const row = doc.querySelector('#missed-banner .missed-gap')
  assert.ok(row, '要有 gap 列')
  assert.ok(row.textContent.includes('休眠期間略過 3 次'), row.textContent)
  assert.equal(row.querySelector('input[type="checkbox"]'), null)
  assert.deepEqual([...row.querySelectorAll('button')].map(b => b.textContent), ['知道了'])
  assert.ok(!row.textContent.includes('補抓'))
  assert.equal(doc.querySelectorAll('#missed-banner input[type="checkbox"]').length, 1, '只有 daily 那筆能勾')

  doc.querySelector('#missed-banner [data-action="catch-up"]').click()
  await new Promise(r => setTimeout(r, 10))
  row.querySelector('button').click()
  await new Promise(r => setTimeout(r, 10))
  const sent = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  assert.deepEqual(sent.filter(m => m.type === 'CATCH_UP_ONE').map(m => m.taskId), ['d1'], 'gap 不得被補抓')
  assert.deepEqual(sent.filter(m => m.type === 'SKIP_ONE'), [{ type: 'SKIP_ONE', taskId: 'i1', slot: '2026-09-18T10:30' }])
})

test('燈號：gap 算在錯過（黃燈）', async () => {
  await fresh()
  const { computeHealth } = await import('../src/background/health.js?t=' + Math.random())
  const h = computeHealth([interval('i1')], {}, [{ taskId: 'i1', kind: 'gap', count: 2, from: 'a', slot: 'b' }])
  assert.equal(h.level, 'yellow')
})
