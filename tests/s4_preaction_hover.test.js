// AF-10 作業 A：前置動作靈活化——hover 型、完整點擊事件序列、waitFor 要等到「看得見」、
// 中文含第幾步的失敗訊息、wait 單位改秒（舊 ms 相容）、立即測試回報逐步軌跡。
// 對照 docs/AF-10-PLAN.md 作業 A 的驗收。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { waitMsOf, preActionLabel, preActionFailure } from '../src/shared/preaction.js'

async function bootContent(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.PointerEvent = jd.window.PointerEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  globalThis.MutationObserver = jd.window.MutationObserver
  globalThis.getComputedStyle = jd.window.getComputedStyle.bind(jd.window)
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?t=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  const run = (actions) => new Promise((resolve) => listener({ type: 'RUN_PRE_ACTIONS', actions }, {}, resolve))
  return { c, doc: jd.window.document, win: jd.window, run }
}

const LOC = (css) => ({ css, path: '', anchor: null, xpath: '' })

// ---------- A-1 hover：派發完整的滑鼠進入事件鏈 ----------

test('A-1 hover 對目標派發 pointerover/mouseover/mouseenter/mousemove', async () => {
  const { run, doc } = await bootContent('<div id="menu">選單</div>')
  const seen = []
  const el = doc.getElementById('menu')
  for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
    el.addEventListener(t, () => seen.push(t))
  }
  const res = await run([{ type: 'hover', locator: LOC('#menu'), holdMs: 0 }])
  assert.equal(res.ok, true, `hover 應成功，實得 ${JSON.stringify(res)}`)
  for (const t of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
    assert.ok(seen.includes(t), `缺少 ${t}（實得 ${seen.join(',')}）`)
  }
})

test('A-1 mouseenter 不冒泡，祖先鏈也要各自收到', async () => {
  const { run, doc } = await bootContent('<div id="bar"><div id="item">帳戶</div></div>')
  let barEnter = 0
  doc.getElementById('bar').addEventListener('mouseenter', () => { barEnter++ })
  await run([{ type: 'hover', locator: LOC('#item'), holdMs: 0 }])
  assert.equal(barEnter, 1,
    'mouseenter 不冒泡，只派給目標的話祖先的選單容器不會展開')
})

test('A-1 hover 找不到元素時回失敗代碼（中文化在 background，那裡才知道第幾步）', async () => {
  const { run } = await bootContent('<div id="a">x</div>')
  const res = await run([{ type: 'hover', locator: LOC('#nope'), holdMs: 0 }])
  assert.equal(res.ok, false)
  assert.equal(res.error, 'preaction_not_found')
})

// ---------- A-2 click：完整的指標事件序列 ----------

test('A-2 click 要派 pointerdown/mousedown/mouseup，不只是 el.click()', async () => {
  const { run, doc } = await bootContent('<button id="b">開啟</button>')
  const seen = []
  const el = doc.getElementById('b')
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    el.addEventListener(t, () => seen.push(t))
  }
  await run([{ type: 'click', locator: LOC('#b') }])
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    assert.ok(seen.includes(t),
      `綁在 ${t} 的元件庫選單會點不動（實得 ${seen.join(',')}）`)
  }
  assert.ok(seen.indexOf('mousedown') < seen.indexOf('click'), '順序要合理')
})

// ---------- A-3 waitFor：出現「且看得見」，並監聽屬性變動 ----------

test('A-3 元素已在 DOM 但被隱藏時不算出現', async () => {
  const { run, doc } = await bootContent('<div id="m" style="display:none">選單</div>')
  const res = await run([{ type: 'waitFor', locator: LOC('#m'), timeoutMs: 60 }])
  assert.equal(res.ok, false, '隱藏的選單不算「出現」，否則下一步會點到看不見的東西')
  assert.equal(res.error, 'preaction_timeout')
  void doc
})

test('A-3 屬性變動（display 被拿掉）也要能喚醒等待', async () => {
  const { run, doc } = await bootContent('<div id="m" style="display:none">選單</div>')
  const p = run([{ type: 'waitFor', locator: LOC('#m'), timeoutMs: 3000 }])
  setTimeout(() => { doc.getElementById('m').style.display = 'block' }, 30)
  const res = await p
  assert.equal(res.ok, true,
    '選單常常早就在 DOM 裡，只靠 childList 監聽永遠等不到')
})

test('A-3 visible:false 時只要在 DOM 裡就算出現', async () => {
  const { run } = await bootContent('<div id="m" style="display:none">選單</div>')
  const res = await run([{ type: 'waitFor', locator: LOC('#m'), timeoutMs: 60, visible: false }])
  assert.equal(res.ok, true, '關掉可見性要求時要放行（要點隱藏項目的站台用得到）')
})

// ---------- A-4 wait 單位：秒，且相容舊的 ms ----------

test('A-4 wait 以秒為單位，舊設定檔的 ms 仍然照舊', () => {
  assert.equal(waitMsOf({ type: 'wait', sec: 1.5 }), 1500)
  assert.equal(waitMsOf({ type: 'wait', ms: 3000 }), 3000, '舊資料零遷移')
  assert.equal(waitMsOf({ type: 'wait' }), 0)
  assert.equal(waitMsOf({ type: 'wait', sec: 0 }), 0, '0 是合法值')
})

test('A-4 content 端的 wait 也走同一份換算', async () => {
  const { run } = await bootContent('<div id="a">x</div>')
  const t0 = Date.now()
  const res = await run([{ type: 'wait', sec: 0.05 }])
  assert.equal(res.ok, true)
  assert.ok(Date.now() - t0 >= 40, '0.05 秒要等大約 50 毫秒')
})

// ---------- A-5 失敗訊息：中文、含第幾步與動作名稱 ----------

test('A-5 失敗訊息含第幾步與動作的中文名稱', () => {
  assert.equal(preActionLabel('hover'), '移到元素上')
  assert.equal(preActionLabel('waitFor'), '等元素出現')
  assert.equal(preActionLabel('click'), '點擊元素')
  const msg = preActionFailure(1, { type: 'waitFor' }, 'preaction_timeout')
  assert.ok(msg.includes('第 2 步'), `要說第幾步，實得 ${msg}`)
  assert.ok(msg.includes('等元素出現'), `要說哪一種動作，實得 ${msg}`)
  assert.ok(!/preaction_/.test(msg), `不得把內部代碼丟給使用者，實得 ${msg}`)
})

test('A-5 找不到元素與逾時是兩種不同的說法', () => {
  const a = preActionFailure(0, { type: 'click' }, 'preaction_not_found')
  const b = preActionFailure(0, { type: 'waitFor' }, 'preaction_timeout')
  assert.notEqual(a, b)
  assert.ok(/找不到/.test(a), a)
  assert.ok(/逾時|等不到/.test(b), b)
})

// ---------- A-6 鏈結：失敗訊息一路走到紀錄與立即測試 ----------

// 先前的案例把 jsdom 的 window 掛上 globalThis，navigator 因此變成唯讀的取值器
function forceOnline() {
  try { globalThis.navigator = { onLine: true } }
  catch { Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true }) }
}

async function bootFetcher() {
  resetChromeMock()
  const c = installChromeMock()
  forceOnline()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder((tabId, msg) => msg?.type === 'RUN_PRE_ACTIONS'
    ? { ok: false, error: 'preaction_timeout' }
    : { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' })
  return { c, st, fe }
}
const FAST = { pollMs: 1, loadTimeoutMs: 200, extractTimeoutMs: 200 }
const baseTask = (over = {}) => ({
  id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

test('A-6 前置動作失敗時，立即測試看到的是中文、含第幾步', async () => {
  const { st, fe } = await bootFetcher()
  const t = baseTask({
    preActions: [
      { type: 'click', locator: { css: '#a' } },
      { type: 'waitFor', locator: { css: '#nope' }, timeoutMs: 5 }
    ]
  })
  await st.saveTask(t)
  const res = await fe.runTask(t, { dryRun: true, reason: 'manual', slot: '2026-09-06T09:00', extraDelayMs: 0, ...FAST })
  assert.equal(res.ok, false)
  assert.ok(/第 1 步/.test(res.error), `第一個動作就失敗了，要說第幾步，實得 ${res.error}`)
  assert.ok(/點擊元素/.test(res.error), `要說是哪一種動作，實得 ${res.error}`)
  assert.ok(!/preaction_/.test(res.error), `不得把內部代碼丟給使用者，實得 ${res.error}`)
})

test('A-6 立即測試成功時回報前置動作逐步軌跡', async () => {
  resetChromeMock()
  const c = installChromeMock()
  forceOnline()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder((tabId, msg) => msg?.type === 'RUN_PRE_ACTIONS'
    ? { ok: true }
    : { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' })
  const t = baseTask({
    preActions: [
      { type: 'hover', locator: { css: '#menu' } },
      { type: 'click', locator: { css: '#item' } }
    ]
  })
  await st.saveTask(t)
  const res = await fe.runTask(t, { dryRun: true, reason: 'manual', slot: '2026-09-06T09:00', extraDelayMs: 0, ...FAST })
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.preActionTrace), `要帶逐步軌跡，實得 ${JSON.stringify(res.preActionTrace)}`)
  assert.equal(res.preActionTrace.length, 2)
  assert.equal(res.preActionTrace[0].type, 'hover')
  assert.equal(res.preActionTrace[0].ok, true)
  assert.equal(typeof res.preActionTrace[0].ms, 'number')
})

// ---------- A-7 前置動作那一列被重畫之後，回填不得寫進孤兒節點 ----------

test('A-7 選好元素回填時，那一列已經不在畫面上就不寫（否則使用者看到「選好了卻沒反應」）', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  const doc = jd.window.document

  // 事件在 render 時綁定（測試環境沒有 chrome.runtime.id，模組底部的 init 區塊不會跑）
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', tabId: 3 })
  doc.getElementById('preaction-add')?.click()
  const row = doc.querySelector('[data-preaction-row]')
  assert.ok(row, `前置：按「新增動作」要長出一列，實得 ${doc.getElementById('preaction-list')?.childElementCount}`)
  row.querySelector('[data-action="preaction-pick"]')?.click()
  await new Promise(r => setTimeout(r, 5))

  // 那一列被整份重畫掉（編輯既有任務時會 replaceChildren）
  doc.getElementById('preaction-list').replaceChildren()

  // 選取結果晚一步回來
  for (const fn of c.runtime.onMessage._listeners) {
    fn({ type: 'PICKED', purpose: 'preaction', locator: { css: '#x' } }, {}, () => {})
  }
  await new Promise(r => setTimeout(r, 5))
  assert.equal(row._locator ?? null, null,
    '寫進已經被丟掉的節點等於什麼都沒發生，使用者會以為選取失敗')
})
