// AF-24 D-b：Tab 還給瀏覽器移動焦點；四段模式改用數字鍵 1～4（停用的段要說明原因）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `<table id="t"><thead><tr><th>幣別</th><th>買入</th></tr></thead>
  <tbody><tr><td>美金</td><td id="a1">31.2</td></tr><tr><td>日圓</td><td id="b1">0.21</td></tr></tbody></table>`

async function enter(opts = {}) {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t'), ...opts })
  const key = (k, init = {}) => { const ev = new jd.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }); doc.dispatchEvent(ev); return ev }
  const move = el => el.dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  const active = () => doc.querySelector('[data-af-tool][data-af-active]')?.getAttribute('data-af-tool')
  return { pm, doc, key, move, active }
}

test('滑鼠在表格上按 Tab：不攔、模式不變', async () => {
  const { pm, doc, key, move, active } = await enter()
  move(doc.getElementById('a1'))
  const ev = key('Tab')
  assert.equal(ev.defaultPrevented, false, 'Tab 要交給瀏覽器移動焦點')
  assert.equal(active(), 'cell')
  pm.exitPickMode()
})

test('數字鍵 2 切到整欄；Ctrl+2／Alt+2 不攔', async () => {
  const { pm, doc, key, move, active } = await enter()
  move(doc.getElementById('a1'))
  assert.equal(key('2', { ctrlKey: true }).defaultPrevented, false)
  assert.equal(key('2', { altKey: true }).defaultPrevented, false)
  assert.equal(active(), 'cell')
  assert.equal(key('2').defaultPrevented, true)
  assert.equal(active(), 'col')
  pm.exitPickMode()
})

test('一次只能選一個元素的用途按 2：模式不變，面板說明原因', async () => {
  const { pm, doc, key, move, active } = await enter({ purpose: 'preaction' })
  move(doc.getElementById('a1'))
  key('2')
  assert.equal(active(), 'cell')
  assert.match(doc.querySelector('[data-af-panel]')?.textContent || '', /一次只選一個元素/)
  pm.exitPickMode()
})

test('工具列每一段都標出快捷鍵（畫面數字＋aria-keyshortcuts）', async () => {
  const { pm, doc } = await enter()
  const tools = [...doc.querySelectorAll('[data-af-tool]')]
  assert.equal(tools.length, 4)
  assert.deepEqual(tools.map(b => b.getAttribute('aria-keyshortcuts')), ['1', '2', '3', '4'])
  assert.deepEqual(tools.map(b => b.textContent.trim().slice(0, 1)), ['1', '2', '3', '4'])
  pm.exitPickMode()
})

test('D-c 作用中那段 aria-pressed=true、其餘 false；面板說明區 aria-live', async () => {
  const { pm, doc, key, move } = await enter()
  move(doc.getElementById('a1'))
  key('2')
  const pressed = [...doc.querySelectorAll('[data-af-tool]')].map(b => b.getAttribute('aria-pressed'))
  assert.deepEqual(pressed, ['false', 'true', 'false', 'false'])
  assert.equal(doc.querySelector('[data-af-panel-body]')?.getAttribute('aria-live'), 'polite')
  pm.exitPickMode()
})

test('體檢：焦點在 shadow DOM 裡的輸入框時，數字鍵與 Backspace 都放給頁面', async () => {
  const { pm, doc, active } = await enter()
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })
  const input = doc.createElement('input')
  root.appendChild(input)
  input.focus()
  const ev = new doc.defaultView.KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true, composed: true })
  input.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, false, '輸入框裡打 2 不得被攔')
  assert.equal(active(), 'cell')
  pm.exitPickMode()
})
