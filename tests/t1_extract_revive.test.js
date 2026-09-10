// AF-13：前置動作造成導覽之後，擷取要活得下來。
//
// 使用者回報：側邊面板設好「點擊元素」前置動作後按立即測試，軌跡顯示第 1 步成功，
// 但錯誤區出現 `Could not establish connection. Receiving end does not exist.`
// 根因：前置動作的點擊讓頁面換頁，舊文件連同注入的 content script 一起被丟掉，
// 而前置動作迴圈結束到擷取之間沒有任何等待。
//
// 真實瀏覽器探針（規劃階段先驗）：
//   子框架換頁時分頁狀態全程 complete（零訊號），所以「等分頁 complete」對 iframe 無效；
//   兩種導覽下重新定位＋重新注入＋再送一次都第一次就成功。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// 重試間隔在測試裡壓到 1ms：它與 pollMs／loadTimeoutMs 同一種函式選項，不是訊息欄位
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, reviveDelaysMs: [1, 1, 1] }
const CONN_ERR = 'Could not establish connection. Receiving end does not exist.'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, fe }
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const ok = (value) => ({ ok: true, value, raw: String(value), status: 'ok', strategyUsed: 'auto', layer: 'css' })
const msgsOf = (c, type) => c.__calls.filter(x => x.api === 'tabs.sendMessage' && x.args[1]?.type === type)
// 「送訊息次數」只數送往目標框架的這兩種，不含 locateFrame 內部解析 locator 的探測
const extractCount = (c) => msgsOf(c, 'EXTRACT').length

// ---- 存活重試 ----

test('文件被換掉：第一次送不到，重試之後拿到新頁面的值', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  let n = 0
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    n++
    if (n === 1) throw new Error(CONN_ERR)
    return ok(222)
  })
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok', `重試沒接上，實得 ${JSON.stringify(rec)}`)
  assert.equal(rec.value, 222, '要拿到重試那次的值，不是第一次的')
  assert.equal(extractCount(c), 2)
})

test('一直送不到：嘗試四次就放棄（初次 + 三次重試，不多不少）', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    throw new Error(CONN_ERR)
  })
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', reason: 'manual', ...FAST })
  assert.notEqual(rec.status, 'ok')
  assert.equal(extractCount(c), 4, `無上限的重試會把同站台佇列卡住，實得 ${extractCount(c)} 次`)
})

test('擷取逾時不得重試（逾時是頁面沒回應，不是文件被換掉）', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => (
    msg.type === 'EXTRACT' ? new Promise(() => {}) : { ok: true }
  ))
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', reason: 'manual', ...FAST, extractTimeoutMs: 30 })
  assert.notEqual(rec.status, 'ok')
  assert.equal(extractCount(c), 1, '逾時也重試的話，15 秒的逾時會變成 60 秒')
})

test('SCROLL_INTO_VIEW 送不到也算存活問題，會重試', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  let n = 0
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'SCROLL_INTO_VIEW') {
      n++
      if (n === 1) throw new Error(CONN_ERR)
      return { ok: true }
    }
    return msg.type === 'EXTRACT' ? ok(7) : { ok: true }
  })
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.equal(rec.value, 7)
  // 把捲動的錯誤一律吞掉的話，這裡只會有一次——那等於「送不到」也不觸發重試
  assert.equal(msgsOf(c, 'SCROLL_INTO_VIEW').length, 2,
    `捲動送不到要觸發重試，實得 ${msgsOf(c, 'SCROLL_INTO_VIEW').length} 次`)
})

test('SCROLL_INTO_VIEW 卡住：逾時後直接往下擷取，不中止也不重試', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => {
    // 永遠不回應：沒有逾時的話整個抓取會吊到 service worker 被回收
    if (msg.type === 'SCROLL_INTO_VIEW') return new Promise(() => {})
    return msg.type === 'EXTRACT' ? ok(8) : { ok: true }
  })
  const rec = await fe.runTask(task(), {
    slot: '2026-09-05T09:00', ...FAST, scrollTimeoutMs: 30
  })
  assert.equal(rec.status, 'ok', '捲動是盡力而為，它不回應不該讓整個抓取失敗')
  assert.equal(rec.value, 8)
  // 為捲動逾時重試就是把 10 秒乘以四卡住同站台佇列
  assert.equal(msgsOf(c, 'SCROLL_INTO_VIEW').length, 1, `捲動逾時不得重試，實得 ${msgsOf(c, 'SCROLL_INTO_VIEW').length} 次`)
  assert.equal(extractCount(c), 1)
})

test('重試要重新定位框架，不得沿用上一輪的 frameId', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ frame: { url: 'https://a.test/inner' } })
  await st.saveTask(t)
  let round = 0
  c.__setScriptResponder((opts) => {
    if (opts?.target?.allFrames !== true) return []
    round++
    // 第一輪那個框架即將被換掉，第二輪換了一個 frameId
    return round <= 1
      ? [{ frameId: 0, result: 'https://a.test/p' }, { frameId: 7, result: 'https://a.test/inner' }]
      : [{ frameId: 0, result: 'https://a.test/p' }, { frameId: 9, result: 'https://a.test/inner' }]
  })
  let n = 0
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    n++
    if (n === 1) throw new Error(CONN_ERR)
    return ok(31)
  })
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  const frames = msgsOf(c, 'EXTRACT').map(x => x.args[2]?.frameId)
  assert.deepEqual(frames, [7, 9], `重試要重新定位，實得 ${JSON.stringify(frames)}`)
})

test('找不到框架不重試（locateFrame 自己已經輪詢到逾時才放棄）', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ frame: { url: 'https://a.test/never' } })
  await st.saveTask(t)
  c.__setScriptResponder((opts) => (
    opts?.target?.allFrames === true ? [{ frameId: 0, result: 'https://a.test/p' }] : []
  ))
  c.__setTabResponder(() => ({ ok: false, error: 'not_found' }))
  const started = Date.now()
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST, frameTimeoutMs: 120 })
  const elapsed = Date.now() - started
  assert.equal(rec.status, 'not_found')
  assert.equal(extractCount(c), 0)
  // locateFrame 自己已經輪詢到逾時才放棄，再重試就是把 20 秒乘以四
  assert.ok(elapsed < 300, `找不到框架只該找一輪，實得 ${elapsed}ms（四輪會超過 480ms）`)
})

test('注入一直失敗時嘗試次數仍有上限', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  let injects = 0
  c.__setScriptResponder((opts) => {
    if (opts?.target?.allFrames === true) return []
    injects++
    throw new Error('Cannot access contents of the page')
  })
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', reason: 'manual', ...FAST })
  assert.notEqual(rec.status, 'ok')
  // 受限頁面(chrome://、擴充功能商店)注入必然失敗，不能因此無止盡重試
  assert.ok(injects <= 8, `注入嘗試次數要有上限，實得 ${injects}`)
})

test('成功路徑零額外成本：不多送訊息、不多等（用正式的重試間隔）', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT' ? ok(5) : { ok: true }))
  const started = Date.now()
  // 刻意不給 reviveDelaysMs：正式間隔是 300/600/1200，成功路徑一秒都不該用到
  const rec = await fe.runTask(task(), {
    slot: '2026-09-05T09:00', pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200
  })
  const elapsed = Date.now() - started
  assert.equal(rec.status, 'ok')
  assert.equal(extractCount(c), 1)
  assert.equal(msgsOf(c, 'SCROLL_INTO_VIEW').length, 1)
  assert.ok(elapsed < 250, `成功路徑不該碰到重試等待，實得 ${elapsed}ms`)
})

// ---- 前置動作與存活重試的分界 ----

test('前置動作失敗時，擷取相關訊息一次都不送', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#go' } }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => (
    msg.type === 'RUN_PRE_ACTIONS' ? { ok: false, error: 'preaction_not_found' } : ok(1)
  ))
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', reason: 'manual', ...FAST })
  assert.notEqual(rec.status, 'ok')
  assert.equal(extractCount(c), 0)
  assert.equal(msgsOf(c, 'SCROLL_INTO_VIEW').length, 0)
})

test('前置動作不得被重放（它有副作用，點兩次就是點兩次）', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#go' } }] })
  await st.saveTask(t)
  let n = 0
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RUN_PRE_ACTIONS') return { ok: true }
    if (msg.type !== 'EXTRACT') return { ok: true }
    n++
    if (n <= 2) throw new Error(CONN_ERR)
    return ok(42)
  })
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.equal(msgsOf(c, 'RUN_PRE_ACTIONS').length, 1,
    '重試區塊把前置動作包進去的話，那個點擊會被按第二次')
})

test('前置動作沒有回應時會逾時，訊息說得出第幾步，而且擷取不執行', async () => {
  const { c, st, fe } = await fresh()
  const t = task({
    preActions: [
      { type: 'wait', sec: 0 },
      { type: 'click', locator: { css: '#go' } }
    ]
  })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => (
    msg.type === 'RUN_PRE_ACTIONS' ? new Promise(() => {}) : ok(1)
  ))
  const rec = await fe.runTask(t, {
    slot: '2026-09-05T09:00', reason: 'manual', ...FAST, preActionTimeoutMs: 30
  })
  assert.notEqual(rec.status, 'ok')
  assert.match(String(rec.error), /第 2 步/, `要說得出卡在哪一步，實得 ${rec.error}`)
  assert.equal(extractCount(c), 0)
})

test('立即測試走同一條路徑：重試成功，而且軌跡還在', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#go' } }] })
  await st.saveTask(t)
  let n = 0
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RUN_PRE_ACTIONS') return { ok: true }
    if (msg.type !== 'EXTRACT') return { ok: true }
    n++
    if (n === 1) throw new Error(CONN_ERR)
    return ok(99)
  })
  const res = await fe.runTask(t, { dryRun: true, reason: 'manual', ...FAST })
  assert.equal(res.ok, true, `立即測試沒有走到重試，實得 ${JSON.stringify(res)}`)
  assert.equal(res.value, 99)
  assert.equal(res.preActionTrace?.length, 1, '重試不得把前置動作軌跡弄丟')
  assert.equal(res.preActionTrace[0].ok, true)
})

// ---- 安定等待 ----

test('前置動作之後要再等一次額外等待秒數（縮小讀到舊文件的窗口）', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#go' } }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT' ? ok(3) : { ok: true }))
  const started = Date.now()
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST, extraDelayMs: 150 })
  const elapsed = Date.now() - started
  assert.equal(rec.status, 'ok')
  assert.ok(elapsed >= 300,
    `載入後與前置動作後各要等一次，實得 ${elapsed}ms（少於 300 表示前置動作後那次沒等）`)
})

test('沒有前置動作的任務不得多等那一次', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT' ? ok(3) : { ok: true }))
  const started = Date.now()
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST, extraDelayMs: 150 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 300, `沒有前置動作就只等一次，實得 ${elapsed}ms`)
})

test('額外等待設為 0 時前置動作之後不等（0 是合法值）', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#go' } }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT' ? ok(3) : { ok: true }))
  const started = Date.now()
  await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST, extraDelayMs: 0 })
  assert.ok(Date.now() - started < 200, '0 代表使用者自願不等')
})

// ---- 前置動作訊息逾時的算法（純函式，唯一一份）----

test('前置動作的訊息逾時要涵蓋動作自己需要的時間', async () => {
  const pa = await import('../src/shared/preaction.js?t=' + Math.random())
  // hover 的 holdMs 沒有上限：固定 20 秒會把「使用者刻意設長的 hover」誤報成沒有回應
  assert.equal(pa.messageTimeoutMs({ type: 'hover', holdMs: 30000 }), 35000)
  assert.equal(pa.messageTimeoutMs({ type: 'hover' }), 5300, '預設停留 300ms 加 5 秒緩衝')
  // waitFor 用它自己的逾時
  assert.equal(pa.messageTimeoutMs({ type: 'waitFor', timeoutMs: 30000 }), 35000)
  assert.equal(pa.messageTimeoutMs({ type: 'waitFor' }), 25000, '預設 20 秒加緩衝')
  // 沒有自帶時間的動作
  assert.equal(pa.messageTimeoutMs({ type: 'click' }), 20000)
})

// ---- 錯誤訊息：Chrome 的英文原文不該落到使用者眼前 ----

test('重試耗盡後給的是中文與具體建議，不是 Chrome 的英文', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#go' } }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RUN_PRE_ACTIONS') return { ok: true }
    if (msg.type !== 'EXTRACT') return { ok: true }
    throw new Error(CONN_ERR)
  })
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', reason: 'manual', ...FAST })
  assert.notEqual(rec.status, 'ok')
  const err = String(rec.error)
  assert.doesNotMatch(err, /Could not establish connection|Receiving end/,
    `Chrome 的英文原文不該落到使用者眼前：${err}`)
  assert.match(err, /換頁|重新載入/, `要說出發生什麼事：${err}`)
  assert.match(err, /等待/, `要說出使用者能做什麼：${err}`)
})

test('英文原文留給診斷，不丟掉', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    throw new Error(CONN_ERR)
  })
  await fe.runTask(task(), { slot: '2026-09-05T09:00', reason: 'manual', ...FAST })
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  const list = await st2.getDiagList()
  const joined = JSON.stringify(list)
  assert.match(joined, /Receiving end/, '除錯時找不到原文就等於什麼線索都沒有')
})

test('立即測試拿到的是同一句中文（訊息只有一份）', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#go' } }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RUN_PRE_ACTIONS') return { ok: true }
    if (msg.type !== 'EXTRACT') return { ok: true }
    throw new Error(CONN_ERR)
  })
  const res = await fe.runTask(t, { dryRun: true, reason: 'manual', ...FAST })
  assert.equal(res.ok, false)
  assert.doesNotMatch(String(res.error), /Could not establish connection/)
  assert.match(String(res.error), /換頁|重新載入/)
  assert.equal(res.preActionTrace?.length, 1, '軌跡不得因為換訊息而弄丟')
})

// ---- 體檢補洞：前置動作自己「送不到」的時候 ----
// SPEC §4 推薦「點擊（切頁籤）→ 等元素出現」，點擊換頁之後下一步的訊息會打中將死的文件。
// 這正是本輪要消滅的那條路，但原實作只保護了前置動作**之後**的擷取。

test('前置動作之間換頁：waitFor 送不到要重試（它只是觀察，重放沒有副作用）', async () => {
  const { c, st, fe } = await fresh()
  const t = task({
    preActions: [
      { type: 'click', locator: { css: '#tab2' } },
      { type: 'waitFor', locator: { css: '#ready' } }
    ]
  })
  await st.saveTask(t)
  let waits = 0
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RUN_PRE_ACTIONS') {
      const act = msg.actions?.[0]
      if (act?.type === 'waitFor') {
        waits++
        if (waits === 1) throw new Error(CONN_ERR)   // 點擊換頁，舊文件連 content script 一起沒了
      }
      return { ok: true }
    }
    return msg.type === 'EXTRACT' ? ok(55) : { ok: true }
  })
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', reason: 'manual', ...FAST })
  assert.equal(rec.status, 'ok', `waitFor 送不到就整個失敗，實得 ${JSON.stringify(rec)}`)
  assert.equal(rec.value, 55)
  assert.equal(waits, 2, 'waitFor 要重送一次')
  const clicks = msgsOf(c, 'RUN_PRE_ACTIONS').filter(x => x.args[1].actions?.[0]?.type === 'click').length
  assert.equal(clicks, 1, '點擊有副作用，不得跟著重放')
})

test('前置動作之間換頁：click 送不到不重試，但訊息要是中文、說得出第幾步', async () => {
  const { c, st, fe } = await fresh()
  const t = task({
    preActions: [
      { type: 'click', locator: { css: '#tab2' } },
      { type: 'click', locator: { css: '#confirm' } }
    ]
  })
  await st.saveTask(t)
  let n = 0
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RUN_PRE_ACTIONS') {
      n++
      if (n === 2) throw new Error(CONN_ERR)
      return { ok: true }
    }
    return ok(1)
  })
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', reason: 'manual', ...FAST })
  assert.notEqual(rec.status, 'ok')
  assert.equal(msgsOf(c, 'RUN_PRE_ACTIONS').length, 2, '點擊送不到不得重放')
  assert.doesNotMatch(String(rec.error), /Could not establish/, `英文原文不該落到使用者眼前：${rec.error}`)
  assert.match(String(rec.error), /第 2 步/, `要說得出第幾步：${rec.error}`)
  assert.match(String(rec.error), /換頁|等待/, `要說出怎麼辦：${rec.error}`)
  assert.equal(extractCount(c), 0)
})
