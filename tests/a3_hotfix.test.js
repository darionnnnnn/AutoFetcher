// AF-3 批次 A:注入修復、通知單一入口、移除原型猴補
// 由 Claude 先寫,實作由委派完成。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  return { c, st }
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

// ---- notify:通知的唯一入口 ----

test('notify 帶統一的 iconUrl,指向真的存在的圖示', async () => {
  const { c } = await fresh()
  const n = await import('../src/background/notify.js?t=' + Math.random())
  await n.notify('id-1', { title: 't', message: 'm' })
  const call = c.__calls.find(x => x.api === 'notifications.create')
  assert.ok(call, '必須真的建立通知')
  const opts = call.args[1] ?? call.args[0]
  assert.ok(
    /^chrome-extension:\/\/[^/]+\/icons\/icon-128\.png$/.test(opts.iconUrl),
    `iconUrl 必須是 getURL 取得的絕對網址（相對路徑會相對於呼叫端解析而 404），實得:${opts.iconUrl}`
  )
  assert.equal(opts.type, 'basic')
})

test('notify 在 settings.notifications 為 false 時完全不發通知', async () => {
  const { c, st } = await fresh()
  await st.saveSettings({ notifications: false })
  const n = await import('../src/background/notify.js?t=' + Math.random())
  const res = await n.notify('id-1', { title: 't', message: 'm' })
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 0)
  assert.equal(res, false, '關閉時要回報沒有送出')
})

test('notify 預設(設定沒寫 notifications)視為開啟', async () => {
  const { c } = await fresh()
  const n = await import('../src/background/notify.js?t=' + Math.random())
  await n.notify('id-1', { title: 't', message: 'm' })
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 1)
})

test('notify 保留呼叫端給的按鈕', async () => {
  const { c } = await fresh()
  const n = await import('../src/background/notify.js?t=' + Math.random())
  await n.notify('missed-tasks', {
    title: 't', message: 'm', buttons: [{ title: '全部補抓' }, { title: '全部略過' }]
  })
  const call = c.__calls.find(x => x.api === 'notifications.create')
  const opts = call.args[1] ?? call.args[0]
  assert.equal(opts.buttons?.length, 2)
  assert.equal(opts.buttons[0].title, '全部補抓')
})

test('notifications.create 拋錯時 notify 不往外拋,並記一筆診斷', async () => {
  const { c } = await fresh()
  const orig = c.notifications.create
  c.notifications.create = async () => { throw new Error('Unable to download all specified images.') }
  try {
    const n = await import('../src/background/notify.js?t=' + Math.random())
    const dg = await import('../src/shared/diag.js?t=' + Math.random())
    const res = await n.notify('id-1', { title: 't', message: 'm' })
    assert.equal(res, false)
    const entries = await dg.getAll()
    assert.ok(entries.some(e => JSON.stringify(e).includes('notify')), '失敗要留下診斷紀錄')
  } finally {
    c.notifications.create = orig
  }
})

// ---- 四個呼叫端都改走 notify(iconUrl 一致) ----

test('抓取失敗(not_found 重試用盡)的通知走統一入口', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: '<div/>' }))
  await fe.runTask(task(), { slot: '2026-09-05T09:00', attempt: 3, ...FAST })
  const call = c.__calls.find(x => x.api === 'notifications.create')
  assert.ok(call, '重試用盡要通知')
  const opts = call.args[1] ?? call.args[0]
  assert.ok(opts.iconUrl.endsWith('/icons/icon-128.png'), `實得:${opts.iconUrl}`)
  assert.ok(opts.iconUrl.startsWith('chrome-extension://'), '必須是絕對網址')
})

test('預檢失敗的通知走統一入口', async () => {
  const { c, st } = await fresh()
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await pc.runPrecheck(task(), FAST)
  const call = c.__calls.find(x => x.api === 'notifications.create')
  assert.ok(call, '預檢失敗要通知')
  const opts = call.args[1] ?? call.args[0]
  assert.ok(opts.iconUrl.endsWith('/icons/icon-128.png'), `實得:${opts.iconUrl}`)
  assert.ok(opts.iconUrl.startsWith('chrome-extension://'), '必須是絕對網址')
})

test('錯過清單的通知走統一入口且保留兩個按鈕', async () => {
  const { c, st } = await fresh()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  await st.saveTask(task())
  const now = new Date('2026-09-05T12:00:00+08:00').getTime()
  await ms.refreshMissed(now, now - 6 * 3600 * 1000)
  const call = c.__calls.find(x => x.api === 'notifications.create')
  assert.ok(call, '有錯過的槽要通知')
  const opts = call.args[1] ?? call.args[0]
  assert.ok(opts.iconUrl.endsWith('/icons/icon-128.png'), `實得:${opts.iconUrl}`)
  assert.ok(opts.iconUrl.startsWith('chrome-extension://'), '必須是絕對網址')
  assert.equal(opts.buttons?.length, 2)
})

test('關閉通知偏好後,抓取失敗也不發通知', async () => {
  const { c, st } = await fresh()
  await st.saveSettings({ notifications: false })
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: '<div/>' }))
  await fe.runTask(task(), { slot: '2026-09-05T09:00', attempt: 3, ...FAST })
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 0)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 1, '通知關掉不影響寫紀錄')
})

// ---- 注入方式:必須是 func + 動態 import,不能是 files ----

function assertModuleInjection(call) {
  assert.ok(call, '必須有注入呼叫')
  const injectArg = call.args[0]
  assert.equal(typeof injectArg.func, 'function', '必須用 func 注入(files 會因 ES module 而在真實瀏覽器爆掉)')
  assert.ok(!injectArg.files, '不得使用 files 注入 content script')
  assert.ok(Array.isArray(injectArg.args), 'func 需要以 args 傳入模組網址')
  assert.ok(
    injectArg.args.some(a => typeof a === 'string' && a.endsWith('content/main.js')),
    '注入的網址必須指向 content/main.js'
  )
}

test('抓取流程以 func + 動態 import 注入 content script', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assertModuleInjection(c.__calls.find(x => x.api === 'scripting.executeScript'))
})

test('右鍵選單以 func + 動態 import 注入 content script', async () => {
  const { c, st } = await fresh()
  const mainMod = await import('../src/background/main.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, locator: { css: '#v' }, preview: '1,234', previewValue: 1234 }))
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await mainMod.handleContextMenu({ menuItemId: 'af-capture' }, tab)
  assertModuleInjection(c.__calls.find(x => x.api === 'scripting.executeScript'))
})

test('注入的 func 真的會 import 傳進去的網址', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  const call = c.__calls.find(x => x.api === 'scripting.executeScript')
  const { func, args } = call.args[0]
  // 在受控環境下實際執行注入函式:它必須對傳入的網址發出動態 import
  const seen = []
  const fakeImport = (u) => { seen.push(u); return Promise.resolve({}) }
  const src = func.toString()
  assert.ok(/import\s*\(/.test(src), '注入函式內必須有動態 import(')
  await new Function('__imp', `return (${src.replace(/import\s*\(/g, '__imp(')})`)(fakeImport)(...args)
  assert.deepEqual(seen, args.slice(0, 1), '必須 import 傳進來的那個網址')
})

// ---- content script 重複注入要冪等 ----

test('content script 重複載入不會重複註冊訊息監聽', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const dom = new JSDOM('<!doctype html><div id="v">1</div>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const before = c.runtime.onMessage._listeners.size
  await import('../src/content/main.js?t=' + Math.random())
  const after1 = c.runtime.onMessage._listeners.size
  assert.equal(after1, before + 1, '第一次載入要註冊一個監聽')
  await import('../src/content/main.js?t=' + Math.random())
  assert.equal(c.runtime.onMessage._listeners.size, after1, '第二次載入不得再註冊')
})

// ---- 不得猴補內建原型 ----

test('載入 background 模組後內建原型仍是原生實作', async () => {
  await fresh()
  const nativeStarts = Function.prototype.toString.call(String.prototype.startsWith)
  const nativeTest = Function.prototype.toString.call(RegExp.prototype.test)
  await import('../src/background/watchdog.js?t=' + Math.random())
  await import('../src/background/main.js?t=' + Math.random())
  assert.equal(
    Function.prototype.toString.call(String.prototype.startsWith),
    nativeStarts,
    'watchdog 不得改寫 String.prototype.startsWith'
  )
  assert.equal(
    Function.prototype.toString.call(RegExp.prototype.test),
    nativeTest,
    'main 不得改寫 RegExp.prototype.test'
  )
  assert.equal('task:t1:0'.startsWith('t1'), false, '原生語意必須保持:task:t1:0 不以 t1 開頭')
  assert.equal(/^t1:\d+$/.test('task:t1:0'), false, '原生語意必須保持:正則不得偷偷去頭比對')
})
