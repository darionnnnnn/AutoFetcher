// AF-21 批次 2 段 2-C：抓取總時限與續命、訊息逾時補齊、content 例外回應、延遲渲染短等待
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0, extractTimeoutMs: 200 }
const OK = { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
const NEVER = () => new Promise(() => {})
const ORIGIN = 'https://a.test'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function fresh(settings = { fetchTabMode: 'tab' }) {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  if (settings) await st.saveSettings(settings)
  return { c, st }
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: `${ORIGIN}/p`, mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})
const callsOf = (c, api) => c.__calls.filter(x => x.api === api)
const sentOf = (c, type) => callsOf(c, 'tabs.sendMessage').filter(x => x.args[1]?.type === type)

async function saveSite(st, over = {}) {
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  await st.saveSite(ORIGIN, {
    loginUrl: `${ORIGIN}/login`,
    selectors: {
      user: { css: '#u', path: '', anchor: null, xpath: '' },
      pass: { css: '#p', path: '', anchor: null, xpath: '' },
      submit: { css: '#go', path: '', anchor: null, xpath: '' }
    },
    loginCheck: { type: 'urlPrefix', value: `${ORIGIN}/login` },
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'wayne',
    passwordEnc: await cr.encryptSecret('hunter2'),
    enabled: true,
    failStreak: 0,
    ...over
  })
}

// ---- 驗收 1：沒有逾時的訊息全部補齊 ----

test('登入：passwordField 檢查永不回應 → 上限內結束，照「送不到」的既有語意判定不在登入頁', async () => {
  const { c, st } = await fresh()
  await saveSite(st, { loginCheck: { type: 'passwordField' } })
  const lg = await import('../src/background/login.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: `${ORIGIN}/p` })
  c.__setTabResponder(NEVER)
  const t0 = Date.now()
  const r = await lg.ensureLoggedIn(tab.id, task(), { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0, checkTimeoutMs: 80 })
  const took = Date.now() - t0
  assert.ok(took < 1000, `要在上限內結束，實際 ${took}ms`)
  assert.equal(sentOf(c, 'CHECK_ELEMENT').length, 1)
  assert.deepEqual(r, { ok: true })
})

test('登入：FILL_LOGIN 永不回應 → 上限內結束、結果是登入失敗（failStreak +1）', async () => {
  const { c, st } = await fresh()
  await saveSite(st)
  const lg = await import('../src/background/login.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: `${ORIGIN}/login` })
  c.__setTabResponder(NEVER)
  const t0 = Date.now()
  const r = await lg.ensureLoggedIn(tab.id, task(), { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0, fillTimeoutMs: 80 })
  const took = Date.now() - t0
  assert.ok(took < 1000, `要在上限內結束，實際 ${took}ms`)
  assert.equal(sentOf(c, 'FILL_LOGIN').length, 1)
  assert.equal(r.ok, false)
  assert.equal(r.reason, '無法登入')
  assert.equal((await st.getSite(ORIGIN)).failStreak, 1)
})

test('登入：被抓取總時限截斷的失敗不算帳密錯（failStreak 不加，三次才不會誤停用站台）', async () => {
  const { c, st } = await fresh()
  await saveSite(st)
  const lg = await import('../src/background/login.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: `${ORIGIN}/login` })
  c.__setTabResponder(NEVER)
  const r = await lg.ensureLoggedIn(tab.id, task(), { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0, fillTimeoutMs: 5000, deadlineAt: Date.now() + 60 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, '超過單次抓取時限')
  assert.equal((await st.getSite(ORIGIN)).failStreak, 0)
})

test('登入：成功判定的 CHECK_ELEMENT 永不回應 → 上限內結束、登入失敗（attempted）', async () => {
  const { c, st } = await fresh()
  await saveSite(st, { successCheck: { type: 'element', value: '#logout' } })
  const lg = await import('../src/background/login.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: `${ORIGIN}/login` })
  c.__setTabResponder((tabId, msg) => (msg.type === 'FILL_LOGIN' ? { ok: true } : NEVER()))
  const t0 = Date.now()
  const r = await lg.ensureLoggedIn(tab.id, task(), { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0, checkTimeoutMs: 80 })
  const took = Date.now() - t0
  assert.ok(took < 1000, `要在上限內結束，實際 ${took}ms`)
  assert.equal(sentOf(c, 'CHECK_ELEMENT').length, 1)
  assert.equal(r.ok, false)
  assert.equal(r.attempted, true)
  assert.equal((await st.getSite(ORIGIN)).failStreak, 1)
})

test('登入：等載入走 waitTabReady（被卸載的分頁會重載），不再有第二份', async () => {
  const { c, st } = await fresh()
  await saveSite(st)
  const lg = await import('../src/background/login.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: `${ORIGIN}/login` })
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'FILL_LOGIN') c.__setTabState(tabId, { discarded: true, url: `${ORIGIN}/home` })
    return { ok: true }
  })
  const r = await lg.ensureLoggedIn(tab.id, task(), { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 })
  assert.equal(r.ok, true)
  assert.equal(callsOf(c, 'tabs.reload').length, 1, '登入後的等載入要看 discarded')
})

test('框架探測：RESOLVE_LOCATOR 永不回應 → 每個候選在探測上限內算沒命中', async () => {
  const { c } = await fresh()
  const fr = await import('../src/background/frames.js?t=' + Math.random())
  c.__setScriptResponder(() => [
    { frameId: 0, result: `${ORIGIN}/p` },
    { frameId: 5, result: 'https://b.example/x.html' },
    { frameId: 6, result: 'https://b.example/y.html' }
  ])
  c.__setTabResponder(NEVER)
  const t0 = Date.now()
  const r = await fr.locateFrame(3, { url: 'https://z.example/w.html' }, { css: '#v' }, { pollMs: 1, timeoutMs: 10, probeTimeoutMs: 80 })
  const took = Date.now() - t0
  assert.ok(took < 1000, `兩個候選各 80ms，實際 ${took}ms`)
  assert.equal(r.frameId, null)
  assert.equal(sentOf(c, 'RESOLVE_LOCATOR').length, 2)
})

test('main.js 的 ENTER_PICK 轉送：content 永不回應 → 上限內結束，不吊住', async () => {
  const { c } = await fresh()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: `${ORIGIN}/p` })
  c.__setTabResponder(NEVER)
  const t0 = Date.now()
  const out = await bg.handleMessage({ type: 'ENTER_PICK', tabId: tab.id, frameId: 0, purpose: 'login-user' }, {}, { contentTimeoutMs: 80 })
  const took = Date.now() - t0
  assert.ok(took < 1000, `要在上限內結束，實際 ${took}ms`)
  assert.equal(sentOf(c, 'ENTER_PICK').length, 1)
  assert.notEqual(out?.ok, true, '沒送到不得回 ok')
})

// ---- 驗收 2、3：總時限 ----

const EXTRACT_HANGS = (tabId, msg) => {
  if (msg.type === 'EXTRACT' && msg.locator?.css === '#v') return NEVER()
  return msg.type === 'EXTRACT' ? OK : { ok: true }
}
const BUDGET = { budgetBaseMs: 300, budgetMaxMs: 300, extractTimeoutMs: 3000 }

test('總時限：擷取永不回應、時限 300ms → 時限內結束、寫失敗紀錄、分頁釋放', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(EXTRACT_HANGS)
  const t0 = Date.now()
  const rec = await fe.runTask(task(), { slot: '2026-09-19T09:00', attempt: 3, ...FAST, ...BUDGET })
  const took = Date.now() - t0
  assert.ok(took >= 280 && took < 1300, `時限 300ms＋合理誤差，實際 ${took}ms`)
  assert.equal(rec.status, 'error')
  assert.match(rec.error, /超過單次抓取時限/)
  const recs = await st.getRecordsByDate('2026-09-19')
  assert.equal(recs.length, 1)
  assert.match(recs[0].error, /超過單次抓取時限/)
  assert.equal(await st.getRunStatus('t1', '2026-09-19T09:00'), 'error', '帳本也記下這一格')
  const created = callsOf(c, 'tabs.create').length
  assert.equal(created, 1)
  assert.equal(callsOf(c, 'tabs.remove').length, 1, '抓取分頁要被釋放')
})

test('總時限：第 1 次嘗試超時 → 走既有的排重試（不寫紀錄）', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(EXTRACT_HANGS)
  const rec = await fe.runTask(task(), { slot: '2026-09-19T09:00', attempt: 1, ...FAST, ...BUDGET })
  assert.equal(rec, null)
  const names = callsOf(c, 'alarms.create').map(x => x.args[0])
  assert.ok(names.includes('t1:retry:1@2026-09-19T09:00'), `要排重試，實得 ${names.join(', ')}`)
  assert.equal(callsOf(c, 'tabs.remove').length, 1, '抓取分頁要被釋放')
})

test('總時限：同站台佇列的下一個任務照常執行', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const t2 = task({ id: 't2', name: '次', locator: { css: '#w', path: '', anchor: null, xpath: '' } })
  await st.saveTask(task())
  await st.saveTask(t2)
  c.__setTabResponder(EXTRACT_HANGS)
  const t0 = Date.now()
  const [a, b] = await Promise.all([
    fe.runTask(task(), { slot: '2026-09-19T09:00', attempt: 3, ...FAST, ...BUDGET }),
    fe.runTask(t2, { slot: '2026-09-19T09:00', attempt: 3, ...FAST, ...BUDGET })
  ])
  assert.ok(Date.now() - t0 < 2000)
  assert.match(a.error, /超過單次抓取時限/)
  assert.equal(b.status, 'ok')
  assert.equal(b.value, 12)
  assert.equal(callsOf(c, 'tabs.remove').length, 1, '佇列清空後釋放一次')
})

test('總時限：事後再等一段時間，不會出現第二筆紀錄（沒有被拋下還在跑的那段）', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  // 用自己的站台：同站台佇列是模組層狀態，前面案例若有吊住的執行不得擋到這一格
  const t = task({ url: 'https://late.test/p' })
  await st.saveTask(t)
  // 擷取在時限之後才回來：被拋下的那段若還活著，會拿到這個成功值再寫一筆
  c.__setTabResponder(async (tabId, msg) => {
    if (msg.type === 'EXTRACT') {
      await sleep(700)
      return OK
    }
    return { ok: true }
  })
  const rec = await fe.runTask(t, { slot: '2026-09-19T09:00', attempt: 3, ...FAST, ...BUDGET })
  assert.match(rec.error, /超過單次抓取時限/)
  await sleep(1200)
  const recs = await st.getRecordsByDate('2026-09-19')
  assert.equal(recs.length, 1, `只能有一筆，實得 ${JSON.stringify(recs.map(r => r.status))}`)
  assert.equal(recs[0].status, 'error')
  assert.equal(await st.getRunStatus('t1', '2026-09-19T09:00'), 'error', '帳本不得被晚到的成功覆寫')
})

test('總時限的算法：150 秒＋宣告的等待（wait／hover 以 60 秒計），上限 270 秒', async () => {
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  assert.equal(fe.runBudgetMsOf(task()), 150000)
  assert.equal(fe.runBudgetMsOf(task({ preActions: [{ type: 'wait', sec: 5 }, { type: 'hover', holdMs: 1000 }, { type: 'waitFor', timeoutMs: 8000 }] })), 164000)
  assert.equal(fe.runBudgetMsOf(task({ preActions: [{ type: 'wait', sec: 120 }] })), 210000, 'wait 以上限 60 秒計')
  assert.equal(fe.runBudgetMsOf(task({ preActions: [{ type: 'wait', sec: 100 }, { type: 'wait', sec: 100 }] })), 270000, '上限 270 秒')
})

// ---- 驗收 4：續命等待 ----

test('續命：45 單位的等待（間隔 20）期間 getPlatformInfo ≥ 2 次；5 單位不呼叫', async () => {
  const { c } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await fe.keepAliveSleep(45, { intervalMs: 20 })
  assert.ok(callsOf(c, 'runtime.getPlatformInfo').length >= 2)
  c.__calls.length = 0
  await fe.keepAliveSleep(5, { intervalMs: 20 })
  assert.equal(callsOf(c, 'runtime.getPlatformInfo').length, 0)
})

test('續命：runTask 裡的前置動作 wait 走續命等待', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const t = task({ preActions: [{ type: 'wait', ms: 45 }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT' ? OK : { ok: true }))
  await fe.runTask(t, { slot: '2026-09-19T09:00', ...FAST, keepAliveMs: 20 })
  // 開頭一次＋等待期間兩次
  assert.ok(callsOf(c, 'runtime.getPlatformInfo').length >= 3)
})

// ---- 驗收 5：單步上限 ----

test('單步上限：wait 120 秒 → 以 60 秒執行；使用者存的值不改', async () => {
  const pa = await import('../src/shared/preaction.js?t=' + Math.random())
  const action = { type: 'wait', sec: 120 }
  assert.equal(pa.PRE_ACTION_STEP_MAX_MS, 60000)
  assert.deepEqual(pa.capStepMs(pa.waitMsOf(action)), { ms: 60000, capped: true })
  assert.deepEqual(pa.capStepMs(pa.waitMsOf({ type: 'wait', sec: 30 })), { ms: 30000, capped: false })
  assert.equal(action.sec, 120)
  // hover 的停留超過上限：送訊息逾時跟著上限走（不是 120 秒＋緩衝）
  assert.equal(pa.messageTimeoutMs({ type: 'hover', holdMs: 120000 }), 60000 + pa.PRE_ACTION_MESSAGE_BUFFER_MS)
})

test('單步上限：超過時軌跡與紀錄都註明「等待秒數超過上限，以 60 秒執行」', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const t = task({ preActions: [{ type: 'wait', sec: 0.12 }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT' ? OK : { ok: true }))
  // 上限縮成 30ms：120ms 的等待照 30ms 跑
  const t0 = Date.now()
  const dry = await fe.runTask(t, { ...FAST, dryRun: true, preActionStepMaxMs: 30 })
  assert.ok(Date.now() - t0 < 110, '要照上限跑，不是照設定的 120ms')
  assert.equal(dry.preActionTrace[0].error, '等待秒數超過上限，以 60 秒執行')
  const rec = await fe.runTask(t, { slot: '2026-09-19T09:00', ...FAST, preActionStepMaxMs: 30 })
  assert.equal(rec.status, 'ok')
  assert.match(rec.error, /等待秒數超過上限，以 60 秒執行/)
  assert.equal((await st.getTask('t1')).preActions[0].sec, 0.12)
})

// ---- 驗收 6：content 例外 ----

async function content(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?t=' + Math.random())
  return { c, doc: jd.window.document }
}
const boom = () => new Proxy({}, { get() { throw new Error('boom') } })

test('content：extractValue 丟例外 → 回 content_exception（不是沒回應）', async () => {
  const { c } = await content('<div id="v">12</div>')
  const res = await Promise.race([
    c.__emitMessage({ type: 'EXTRACT', locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: boom() }),
    sleep(1000).then(() => 'no-response')
  ])
  assert.equal(res?.ok, false)
  assert.equal(res.error, 'content_exception')
  assert.match(res.detail, /boom/)
})

test('content：同步分支丟例外也回 content_exception', async () => {
  const { c } = await content('<div id="v">12</div>')
  const res = await Promise.race([
    c.__emitMessage({ type: 'SCROLL_INTO_VIEW', locator: boom() }),
    sleep(1000).then(() => 'no-response')
  ])
  assert.equal(res?.error, 'content_exception')
})

test('background：content_exception 寫進紀錄的是中文句', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT' ? { ok: false, error: 'content_exception', detail: 'boom' } : { ok: true }))
  const rec = await fe.runTask(task(), { slot: '2026-09-19T09:00', attempt: 3, ...FAST })
  assert.equal(rec.error, '頁面上的程式發生錯誤：boom')
})

// ---- 驗收 7：延遲渲染短等待 ----

const LOC = { css: '#late', path: '', anchor: null, xpath: '' }

test('延遲渲染：目標 800ms 後才插進 DOM → EXTRACT 回 ok', async () => {
  const { c, doc } = await content('<div id="root"></div>')
  setTimeout(() => {
    const el = doc.createElement('div')
    el.id = 'late'
    el.textContent = '4,321'
    doc.getElementById('root').appendChild(el)
  }, 800)
  const t0 = Date.now()
  const res = await c.__emitMessage({ type: 'EXTRACT', locator: LOC, spec: { strategy: 'auto' } })
  const took = Date.now() - t0
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.value, 4321)
  assert.ok(took >= 750 && took < 2500, `出現就接著擷取，實際 ${took}ms`)
})

test('延遲渲染：永不出現 → 約 3 秒回 not_found（上限 4 秒）', async () => {
  const { c } = await content('<div id="root"></div>')
  const t0 = Date.now()
  const res = await c.__emitMessage({ type: 'EXTRACT', locator: LOC, spec: { strategy: 'auto' } })
  const took = Date.now() - t0
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not_found')
  assert.ok(took >= 2900 && took < 4000, `約 3 秒，實際 ${took}ms`)
})

test('延遲渲染：不要求可見（隱藏的元素出現也算）', async () => {
  const { c, doc } = await content('<div id="root"></div>')
  setTimeout(() => {
    const el = doc.createElement('div')
    el.id = 'late'
    el.style.display = 'none'
    el.textContent = '7'
    doc.getElementById('root').appendChild(el)
  }, 100)
  const res = await c.__emitMessage({ type: 'EXTRACT', locator: LOC, spec: { strategy: 'auto' } })
  assert.equal(res.ok, true)
})
