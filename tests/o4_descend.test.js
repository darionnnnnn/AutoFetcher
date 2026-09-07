// AF-6 作業 C:選到 <iframe> 就鑽進去選，以及前置動作各自記住自己的 frame
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <div id="box"><span id="v">1,234</span></div>
  <iframe id="fr" src="https://b.example/w.html?token=abc"></iframe>`

async function setupPage() {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, win: jd.window, pm }
}

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  return { c, st }
}

function sendTo(c, msg, sender = {}) {
  const listener = [...c.runtime.onMessage._listeners][0]
  return new Promise((resolve, reject) => {
    const ret = listener(msg, sender, resolve)
    if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
  })
}

const runtimeMsgs = (c) => c.__calls.filter((x) => x.api === 'runtime.sendMessage').map((x) => x.args[0])
const sent = (c) => c.__calls.filter((x) => x.api === 'tabs.sendMessage').map((x) => x.args)
const framesAs = (list) => (injection) =>
  Array.isArray(injection?.args) ? [] : list.map(([frameId, url]) => ({ frameId, result: url }))

// ---------- content：選到 iframe 就要求下鑽 ----------

test('確認的目標是 iframe 時，送的是下鑽要求而不是選好了', async () => {
  const { c, doc, win, pm } = await setupPage()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('fr') })
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const msgs = runtimeMsgs(c)
  const last = msgs.at(-1)
  assert.equal(last.type, 'DESCEND_FRAME', `送出的是 ${last.type}，選到 iframe 卻當成選好了，之後抓到的會是 iframe 這個殼`)
  assert.equal(last.src, 'https://b.example/w.html?token=abc')
  assert.equal(last.purpose, 'task', '下鑽之後還是同一件事，purpose 要原樣帶著')
  assert.equal(msgs.some((m) => m.type === 'PICKED'), false)
})

test('目標不是 iframe 時行為完全不變', async () => {
  const { c, doc, win, pm } = await setupPage()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(runtimeMsgs(c).at(-1).type, 'PICKED')
})

test('進不去那個框架時要說出來，不能默默留在原地', async () => {
  const { doc, pm } = await setupPage()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v'), hint: 'frame_not_found' })
  const panel = doc.querySelector('[data-af-panel]')
  assert.match(panel?.textContent || '', /無法進入.*框架/)
})

// ---------- background：下鑽的路由 ----------

test('下鑽要用 iframe 的 src 找出那個 frame，並在裡面重新進入選取模式', async () => {
  const { c } = await freshBg()
  c.__setScriptResponder(framesAs([[0, 'https://a.test/p'], [7, 'https://b.example/w.html?token=zzz']]))
  await sendTo(c, {
    type: 'DESCEND_FRAME', purpose: 'task', src: 'https://b.example/w.html?token=abc'
  }, { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0 })
  const [tabId, msg, options] = sent(c).at(-1)
  assert.equal(tabId, 3)
  assert.equal(msg.type, 'ENTER_PICK')
  assert.equal(msg.purpose, 'task')
  assert.deepEqual(options, { frameId: 7 })
})

test('兩個一模一樣的 iframe 時不得亂猜，要退回原本那層並說明', async () => {
  const { c } = await freshBg()
  c.__setScriptResponder(framesAs([
    [0, 'https://a.test/p'], [7, 'https://b.example/w.html?id=1'], [8, 'https://b.example/w.html?id=2']
  ]))
  await sendTo(c, {
    type: 'DESCEND_FRAME', purpose: 'task', src: 'https://b.example/w.html?id=9'
  }, { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0 })
  const [, msg, options] = sent(c).at(-1)
  assert.equal(msg.type, 'ENTER_PICK')
  assert.equal(msg.hint, 'frame_not_found')
  assert.deepEqual(options, { frameId: 0 }, '要退回發出下鑽要求的那個 frame')
})

test('前置動作的選取一樣鑽得進去，PICKED 要把 frame 網址帶回 Picker', async () => {
  const { c } = await freshBg()
  await sendTo(c, {
    type: 'PICKED', purpose: 'preaction', locator: { css: '#btn' }
  }, { tab: { id: 3, url: 'https://a.test/p' }, frameId: 7, url: 'https://b.example/w.html?token=abc' })
  const fwd = runtimeMsgs(c).at(-1)
  assert.equal(fwd.purpose, 'preaction')
  assert.equal(fwd.frameUrl, 'https://b.example/w.html?token=abc', '不帶回來的話，那個按鈕下次就點不到了')
})

test('在最上層選的前置動作不得帶 frame 欄位', async () => {
  const { c } = await freshBg()
  await sendTo(c, {
    type: 'PICKED', purpose: 'preaction', locator: { css: '#btn' }
  }, { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0, url: 'https://a.test/p' })
  assert.equal('frameUrl' in runtimeMsgs(c).at(-1), false)
})
