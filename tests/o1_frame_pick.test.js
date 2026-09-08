// AF-6 作業 A:選取端的 frame 路由
// 目標值在跨網域 iframe 內時，右鍵、選取模式、Picker 都必須認得「目標在哪個 frame」。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  return { c, st }
}

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, pk, doc: jd.window.document }
}

function sendTo(c, msg, sender = {}) {
  const listener = [...c.runtime.onMessage._listeners][0]
  return new Promise((resolve, reject) => {
    const ret = listener(msg, sender, resolve)
    if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
  })
}

const injections = (c) => c.__calls.filter((x) => x.api === 'scripting.executeScript').map((x) => x.args[0])
const sent = (c) => c.__calls.filter((x) => x.api === 'tabs.sendMessage').map((x) => x.args)
const ctxOf = (c) => {
  const created = c.__calls.find((x) => x.api === 'windows.create')
  const url = created?.args?.[0]?.url || ''
  return JSON.parse(decodeURIComponent(url.split('?ctx=')[1] || '%7B%7D'))
}

const LOCATOR = { css: '#v', path: 'body > div:nth-of-type(1)', anchor: null, xpath: '/html[1]/body[1]/div[1]' }
const base = (over = {}) => ({
  name: '總量', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
  scheduleType: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5],
  everyMinutes: 15, ...over
})

// ---------- 注入 ----------

test('injectContent 預設只注入最上層 frame，而且要明寫 frameIds', async () => {
  const { c } = await freshBg()
  const { injectContent } = await import('../src/background/inject.js?t=' + Math.random())
  await injectContent(5)
  const target = injections(c).at(-1).target
  assert.equal(target.tabId, 5)
  // 不指定 frame 就是「注入所有 frame」以外的另一種錯：訊息之後會廣播，誰先回誰贏
  assert.deepEqual(target.frameIds, [0], 'target 必須明寫 frameIds: [0]')
  assert.notEqual(target.allFrames, true)
})

test('injectContent 可以指名注入某個 frame', async () => {
  const { c } = await freshBg()
  const { injectContent } = await import('../src/background/inject.js?t=' + Math.random())
  await injectContent(5, { frameId: 7 })
  assert.deepEqual(injections(c).at(-1).target.frameIds, [7])
})

test('injectContent 可以一次注入全部 frame（列 frame 之前用不到，但下鑽選取要）', async () => {
  const { c } = await freshBg()
  const { injectContent } = await import('../src/background/inject.js?t=' + Math.random())
  await injectContent(5, { allFrames: true })
  const target = injections(c).at(-1).target
  assert.equal(target.allFrames, true)
  assert.equal(target.frameIds, undefined, 'allFrames 與 frameIds 不得同時給')
})

// ---------- 右鍵選單 ----------

test('在 iframe 裡右鍵「選取要抓的內容」，要注入並送訊息到那個 frame', async () => {
  const { c } = await freshBg()
  await c.__emitContextMenuClick(
    { menuItemId: 'af-pick', frameId: 7 },
    { id: 3, url: 'https://a.test/p' }
  )
  const inj = injections(c).at(-1)
  assert.deepEqual(inj.target.frameIds, [7], '要注入右鍵所在的 frame')
  const [tabId, msg, options] = sent(c).at(-1)
  assert.equal(tabId, 3)
  assert.equal(msg.type, 'ENTER_PICK')
  assert.deepEqual(options, { frameId: 7 }, 'ENTER_PICK 必須指名 frame，否則會廣播給每個 frame')
})

test('在最上層右鍵時 frameId 就是 0，不能省略第三個參數', async () => {
  const { c } = await freshBg()
  await c.__emitContextMenuClick({ menuItemId: 'af-pick', frameId: 0 }, { id: 3, url: 'https://a.test/p' })
  assert.deepEqual(sent(c).at(-1)[2], { frameId: 0 })
})

test('「設定此站台登入」一律走最上層 frame（登入表單在 iframe 內不在本輪範圍）', async () => {
  const { c } = await freshBg()
  await c.__emitContextMenuClick({ menuItemId: 'af-site-login', frameId: 7 }, { id: 3, url: 'https://a.test/p' })
  const [, msg, options] = sent(c).at(-1)
  assert.equal(msg.type, 'ENTER_PICK')
  assert.deepEqual(options, { frameId: 0 })
})

// ---------- PICKED 帶回 frame 身分 ----------

test('在 iframe 內選好的目標，frame 身分要一路傳到 Picker', async () => {
  const { c } = await freshBg()
  await sendTo(c, {
    type: 'PICKED', purpose: 'task', locator: { css: '#rate' }, preview: '31.2'
  }, { tab: { id: 3, url: 'https://a.test/p' }, frameId: 7, url: 'https://b.example/widget.html?token=abc' })
  const ctx = ctxOf(c)
  assert.equal(ctx.frameId, 7)
  assert.equal(ctx.frameUrl, 'https://b.example/widget.html?token=abc', 'frameUrl 要取 sender.url（frame 自己的網址），不是分頁網址')
  assert.equal(ctx.url, 'https://a.test/p', '任務網址仍是分頁的網址')
})

test('目標在最上層時不得留下 frame 欄位（舊任務零遷移的前提）', async () => {
  const { c } = await freshBg()
  await sendTo(c, {
    type: 'PICKED', purpose: 'task', locator: { css: '#v' }, preview: '1'
  }, { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0, url: 'https://a.test/p' })
  const ctx = ctxOf(c)
  assert.equal('frameId' in ctx, false, 'top 不得帶 frameId')
  assert.equal('frameUrl' in ctx, false, 'top 不得帶 frameUrl')
})

// ---------- 任務存 frame ----------

test('buildTask 收到 frame 就存進任務', async () => {
  const { pk } = await freshPicker()
  const t = pk.buildTask(base(), LOCATOR, undefined, { url: 'https://b.example/widget.html' })
  assert.deepEqual(t.frame, { url: 'https://b.example/widget.html' })
})

test('buildTask 沒有 frame 時不得憑空造一個', async () => {
  const { pk } = await freshPicker()
  const t = pk.buildTask(base(), LOCATOR)
  assert.equal('frame' in t, false, '目標在最上層的任務不能有 frame 欄位')
})

test('編輯既有任務時原本的 frame 要留著', async () => {
  const { pk } = await freshPicker()
  const t = pk.buildTask(base(), LOCATOR, { id: 'old', order: 1, frame: { url: 'https://b.example/w.html' } })
  assert.deepEqual(t.frame, { url: 'https://b.example/w.html' })
})

// ---------- 立即測試 ----------
// AF-7 起「立即測試」不再自己對頁面送 EXTRACT：頁面可能已經重新整理，
// content script 不在、frameId 也會換。改交給 background 走與正式抓取同一條路徑。

test('「立即測試」把目標所在的 frame 交給背景，不自己對頁面送訊息', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, frameId: 7, frameUrl: 'https://b.example/w.html', locator: LOCATOR })
  doc.getElementById('name').value = '測試'
  c.__setRuntimeResponder(() => ({ ok: true, value: 1, raw: '1' }))
  await pk.handleTestNow()
  assert.equal(sent(c).length, 0, '不得自己 tabs.sendMessage')
  const msg = c.__calls
    .filter(x => x.api === 'runtime.sendMessage')
    .map(x => x.args[0])
    .find(m => m?.type === 'TEST_TASK')
  assert.ok(msg, '要送 TEST_TASK 給背景')
  assert.equal(msg.tabId, 3)
  assert.deepEqual(msg.task.frame, { url: 'https://b.example/w.html' })
})

test('目標在最上層時「立即測試」送出的任務沒有 frame 欄位', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: LOCATOR })
  doc.getElementById('name').value = '測試'
  c.__setRuntimeResponder(() => ({ ok: true, value: 1, raw: '1' }))
  await pk.handleTestNow()
  const msg = c.__calls
    .filter(x => x.api === 'runtime.sendMessage')
    .map(x => x.args[0])
    .find(m => m?.type === 'TEST_TASK')
  assert.equal('frame' in msg.task, false)
})
