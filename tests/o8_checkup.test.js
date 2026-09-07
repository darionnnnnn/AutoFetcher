// AF-6 體檢輪：兩個「單元測試各自綠、接起來卻壞」的洞
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <div id="box"><span id="v">1,234</span></div>
  <iframe id="fr" src="https://b.example/w.html"></iframe>`

// 走 content/main.js 的訊息路由，而不是直接呼叫 enterPickMode——
// 直呼會繞過「路由有沒有把欄位傳下去」這一段，那正是先前假綠的地方。
async function setupRouted() {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, { url: 'https://a.test/p' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?t=' + Math.random())
  return { c, doc: jd.window.document, win: jd.window }
}

test('background 退回 ENTER_PICK 帶 hint 時，面板真的要顯示「無法進入這個框架」', async () => {
  const { c, doc } = await setupRouted()
  await c.__emitMessage({ type: 'ENTER_PICK', purpose: 'task', hint: 'frame_not_found' })
  const panel = doc.querySelector('[data-af-panel]')
  assert.ok(panel, '應已進入選取模式')
  assert.match(panel.textContent, /無法進入這個框架/, 'hint 在訊息路由那一層被丟掉了，使用者不會知道為什麼還留在原地')
})

test('指著 iframe 代理層按 ↑ 要走到 iframe 的父層，不能走進我們自己的 overlay', async () => {
  const { c, doc, win } = await setupRouted()
  await c.__emitMessage({ type: 'ENTER_PICK', purpose: 'task' })
  const proxy = doc.querySelector('[data-af-frame-proxy]')
  assert.ok(proxy, 'iframe 上應有代理層')
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  // 現在按 Enter：送出的目標必須是頁面上的元素，不得是 overlay
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const last = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).at(-1)
  assert.equal(last.type, 'PICKED', `↑ 之後 Enter 應選到 iframe 的父層（body），實得 ${last.type}`)
  assert.equal(last.locator?.path, 'html:nth-of-type(1) > body:nth-of-type(1)',
    `選到的是 ${last.locator?.path}——走進 overlay 的話，抓到的會是我們自己貼上去的 div`)
})
