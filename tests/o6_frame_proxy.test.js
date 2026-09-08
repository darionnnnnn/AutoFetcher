// AF-6 作業 C2:iframe 的代理層
// 滑鼠移到 <iframe> 上時，事件由 iframe 自己的文件接走，最上層的選取模式
// 永遠 hover 不到那個 <iframe> 元素——沒有代理層，下鑽入口就是走不到的死功能。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function setup(body) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${body}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, win: jd.window, pm }
}

const WITH_FRAME = `
  <div id="v">1,234</div>
  <iframe id="fr" src="https://b.example/w.html?token=abc"></iframe>`

const runtimeMsgs = (c) => c.__calls.filter((x) => x.api === 'runtime.sendMessage').map((x) => x.args[0])

test('選取模式一開，每個 iframe 上面都要有一層可以指到的代理', async () => {
  const { doc, pm } = await setup(WITH_FRAME)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  const proxies = doc.querySelectorAll('[data-af-frame-proxy]')
  assert.equal(proxies.length, 1, 'iframe 上沒有代理層的話，使用者永遠選不到它')
})

test('代理層要指得回它代表的那個 iframe', async () => {
  const { doc, win, pm } = await setup(WITH_FRAME)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  const proxy = doc.querySelector('[data-af-frame-proxy]')
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  const panel = doc.querySelector('[data-af-panel]')
  assert.match(panel?.textContent || '', /框架/, '面板要說得出「這是一個框架，確認就進去」')
})

test('指著代理層按 Enter 就是下鑽，帶的是那個 iframe 的 src', async () => {
  const { c, doc, win, pm } = await setup(WITH_FRAME)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  const proxy = doc.querySelector('[data-af-frame-proxy]')
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const last = runtimeMsgs(c).at(-1)
  assert.equal(last.type, 'DESCEND_FRAME')
  assert.equal(last.src, 'https://b.example/w.html?token=abc')
})

test('離開選取模式時代理層要收乾淨', async () => {
  const { doc, pm } = await setup(WITH_FRAME)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  pm.exitPickMode()
  assert.equal(doc.querySelectorAll('[data-af-frame-proxy]').length, 0, '留在頁面上會擋住使用者操作網頁')
})

test('沒有 iframe 的頁面不得多出任何東西', async () => {
  const { doc, pm } = await setup('<div id="v">1,234</div>')
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  assert.equal(doc.querySelectorAll('[data-af-frame-proxy]').length, 0)
})

test('代理層本身不得被當成可以抓的目標送出去', async () => {
  const { c, doc, win, pm } = await setup(WITH_FRAME)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  const proxy = doc.querySelector('[data-af-frame-proxy]')
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const last = runtimeMsgs(c).at(-1)
  assert.notEqual(last.type, 'PICKED', '送出 PICKED 的話，抓到的會是我們自己貼上去的空 div')
})

test('iframe 的 src 是相對路徑時，下鑽要送絕對網址', async () => {
  // 送原始屬性值的話，background 那邊 new URL() 會拋，一律變成「無法進入此框架」
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM('<!doctype html><html><body><div id="v">1</div><iframe id="fr" src="/inner.html"></iframe></body></html>',
    { url: 'https://a.test/page' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('fr') })
  doc.dispatchEvent(new jd.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const last = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).at(-1)
  assert.equal(last.type, 'DESCEND_FRAME')
  assert.equal(last.src, 'https://a.test/inner.html')
})

// AF-8：新的點擊語意下，代理層維持「點一下就進去」——那是導覽不是選取
test('點一下代理層就下鑽（不是先選再確認）', async () => {
  const { c, doc, win, pm } = await setup(WITH_FRAME)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  const proxy = doc.querySelector('[data-af-frame-proxy]')
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  proxy.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  const last = runtimeMsgs(c).at(-1)
  assert.equal(last?.type, 'DESCEND_FRAME', '點框架要直接進去，要求使用者再雙擊一次很沒道理')
  assert.equal(last.src, 'https://b.example/w.html?token=abc')
  assert.equal(pm.isActive(), false, '下鑽之後這一層的選取模式要收掉')
})

test('指到代理層時完成鈕說的是「進入這個框架」', async () => {
  const { doc, win, pm } = await setup(WITH_FRAME)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  const proxy = doc.querySelector('[data-af-frame-proxy]')
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  const done = doc.querySelector('[data-af-done]')
  assert.equal(done.textContent, '進入這個框架',
    `按鈕要說出按下去會發生什麼，實得 ${JSON.stringify(done.textContent)}`)
  assert.notEqual(done.getAttribute('aria-disabled'), 'true')
  pm.exitPickMode()
})
