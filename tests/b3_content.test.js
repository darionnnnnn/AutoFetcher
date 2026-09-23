import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function setup(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  // content script 有冪等守衛（同一分頁被注入兩次不重複註冊）；每個測試換了新的
  // document，等同新分頁，所以要清掉旗標。正式環境每個分頁本來就是獨立的全域。
  globalThis.__afContentLoaded = false
  const mod = await import('../src/content/main.js?t=' + Math.random())
  return { c, doc: jd.window.document, win: jd.window, mod }
}

function rightClick(doc, el) {
  const ev = new globalThis.Event('contextmenu', { bubbles: true })
  Object.defineProperty(ev, 'target', { value: el })
  doc.dispatchEvent(ev)
}

const MSG = {
  DESCRIBE: 'DESCRIBE', EXTRACT: 'EXTRACT', SCROLL_INTO_VIEW: 'SCROLL_INTO_VIEW'
}

test('載入時註冊 contextmenu 與 onMessage 監聽器', async () => {
  const { c, doc } = await setup('<div id="a">1</div>')
  assert.equal(c.runtime.onMessage._listeners.size, 1)
  assert.doesNotThrow(() => rightClick(doc, doc.getElementById('a')))
})

test('DESCRIBE 回傳四層定位與預覽文字', async () => {
  const { c, doc } = await setup('<div id="daily-total">1,234</div>')
  rightClick(doc, doc.getElementById('daily-total'))
  const res = await c.__emitMessage({ type: MSG.DESCRIBE })
  assert.equal(res.ok, true)
  assert.equal(res.locator.css, '#daily-total')
  assert.ok(res.locator.path.length > 0)
  assert.ok(res.locator.xpath.startsWith('/html[1]'))
  assert.equal(res.preview, '1,234')
  assert.equal(res.previewValue, 1234, '數值模式的預覽解析值')
})

test('DESCRIBE 在沒有右鍵過任何元素時回 no_target', async () => {
  const { c } = await setup('<div id="a">1</div>')
  const res = await c.__emitMessage({ type: MSG.DESCRIBE })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'no_target')
})

test('右鍵第二個元素會覆蓋第一個', async () => {
  const { c, doc } = await setup('<div id="a">1</div><div id="b">2</div>')
  rightClick(doc, doc.getElementById('a'))
  rightClick(doc, doc.getElementById('b'))
  const res = await c.__emitMessage({ type: MSG.DESCRIBE })
  assert.equal(res.locator.css, '#b')
})

test('EXTRACT 依 locator 解析並回值,附實際命中層', async () => {
  const { c } = await setup('<div id="v">1,234</div>')
  const res = await c.__emitMessage({
    type: MSG.EXTRACT,
    locator: { css: '#v', path: '', anchor: null, xpath: '' },
    spec: { strategy: 'auto' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.value, 1234)
  assert.equal(res.raw, '1,234')
  assert.equal(res.layer, 'css')
  assert.equal(res.status, 'ok')
})

test('EXTRACT 找不到元素時回 not_found 並附 snippet', async () => {
  const { c } = await setup('<div id="v">1</div>')
  const res = await c.__emitMessage({
    type: MSG.EXTRACT,
    locator: { css: '#gone', path: 'nav b', anchor: null, xpath: '/html[1]/body[1]/table[9]' },
    spec: { strategy: 'auto' }
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not_found')
  assert.ok(res.snippet.length > 0)
  assert.ok(res.snippet.length <= 500)
})

test('EXTRACT 找到元素但解析不出數字時回 parse_error 並保留原文', async () => {
  const { c } = await setup('<div id="v">--</div>')
  const res = await c.__emitMessage({
    type: MSG.EXTRACT,
    locator: { css: '#v', path: '', anchor: null, xpath: '' },
    spec: { strategy: 'auto' }
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'parse_error')
  assert.equal(res.raw, '--')
})

test('EXTRACT 支援 text 模式', async () => {
  const { c } = await setup('<div id="v">尚未開盤</div>')
  const res = await c.__emitMessage({
    type: MSG.EXTRACT,
    locator: { css: '#v', path: '', anchor: null, xpath: '' },
    spec: { mode: 'text' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.value, '尚未開盤')
})

test('SCROLL_INTO_VIEW 對命中的元素呼叫 scrollIntoView', async () => {
  const { c, doc } = await setup('<div id="v">1</div>')
  let called = 0
  doc.getElementById('v').scrollIntoView = () => { called++ }
  const res = await c.__emitMessage({
    type: MSG.SCROLL_INTO_VIEW,
    locator: { css: '#v', path: '', anchor: null, xpath: '' }
  })
  assert.equal(res.ok, true)
  assert.equal(called, 1)
})

test('SCROLL_INTO_VIEW 在元素沒有該方法時不丟例外', async () => {
  const { c } = await setup('<div id="v">1</div>')
  const res = await c.__emitMessage({
    type: MSG.SCROLL_INTO_VIEW,
    locator: { css: '#v', path: '', anchor: null, xpath: '' }
  })
  assert.equal(res.ok, true)
})

test('未知訊息型別不回應,不丟例外', async () => {
  const { c } = await setup('<div id="v">1</div>')
  const res = await c.__emitMessage({ type: 'NOT_A_REAL_MESSAGE' })
  assert.equal(res, undefined)
})

test('content script 不得自行排程或寫 storage', async () => {
  const { c, doc } = await setup('<div id="v">1</div>')
  rightClick(doc, doc.getElementById('v'))
  await c.__emitMessage({ type: MSG.DESCRIBE })
  const apis = c.__calls.map(x => x.api)
  assert.equal(apis.filter(a => a.startsWith('alarms.')).length, 0)
  assert.equal(apis.filter(a => a.startsWith('storage.')).length, 0)
})

test('群組取名 hover 預覽可見文字與文字欄位，離開/取消清理且點擊只回填同一文字', async () => {
  const { c, doc, win } = await setup('<div id="nested">外層 <span id="leaf">標題 😀</span></div><textarea id="note">欄位文字</textarea><input id="secret" type="password" value="不應顯示">')
  const pick = { type: 'PICK_GROUP_NAME', requestId: 'r1', sessionId: 's1', groupKey: 'g1' }
  await c.__emitMessage(pick)
  const nested = doc.getElementById('nested')
  const leaf = doc.getElementById('leaf')
  const hover = (el, type = 'mouseover', relatedTarget = null) => {
    const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 80, relatedTarget })
    el.dispatchEvent(event)
    return event
  }
  const rects = () => [{ width: 100, height: 20 }]
  leaf.getClientRects = rects
  hover(leaf)
  let overlay = doc.querySelector('[data-af-overlay="group-name-preview"]')
  assert.ok(overlay)
  assert.equal(overlay.shadowRoot.querySelector('.label').textContent, '可取用範圍：此元素及其子元素的文字')
  assert.equal(overlay.shadowRoot.querySelector('.value').textContent, '標題 😀')
  assert.match(overlay.shadowRoot.querySelector('.note').textContent, /只回填群組名稱/)

  const textarea = doc.getElementById('note')
  textarea.getClientRects = rects
  hover(textarea, 'mousemove')
  assert.equal(overlay.shadowRoot.querySelector('.label').textContent, '可取用範圍：此欄位的文字')
  assert.equal(overlay.shadowRoot.querySelector('.value').textContent, '欄位文字')
  hover(textarea, 'mouseout', null)
  assert.equal(overlay.style.display, 'none', '游標離開時預覽隱藏')
  hover(leaf)
  assert.equal(overlay.style.display, 'block')

  let pageClick = false
  doc.addEventListener('click', () => { pageClick = true })
  const click = new win.MouseEvent('click', { bubbles: true, cancelable: true })
  leaf.dispatchEvent(click)
  assert.equal(click.defaultPrevented, true)
  assert.equal(pageClick, false, '選名稱不執行頁面 click 動作')
  const result = c.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_GROUP_NAME_RESULT')
  assert.equal(result.args[0].text, '標題 😀')
  assert.equal(doc.querySelector('[data-af-overlay="group-name-preview"]'), null, '點擊後 overlay 清理')
  assert.equal(c.__calls.some(call => ['PICKED', 'ENTER_PICK'].includes(call.args[0]?.type)), false)

  await c.__emitMessage({ ...pick, requestId: 'r-long' })
  const longText = '界😀'.repeat(400)
  const long = doc.createElement('div')
  long.textContent = longText
  doc.body.appendChild(long)
  hover(long)
  overlay = doc.querySelector('[data-af-overlay="group-name-preview"]')
  assert.match(overlay.shadowRoot.querySelector('.value').textContent, /預覽已截短/)
  assert.ok(overlay.shadowRoot.querySelector('.value').textContent.startsWith(longText.slice(0, 500)))
  long.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  const longResult = c.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_GROUP_NAME_RESULT').at(-1)
  assert.equal(longResult.args[0].text, longText, '截短僅用於預覽，回填仍取完整文字')

  await c.__emitMessage({ ...pick, requestId: 'r-empty' })
  const empty = doc.createElement('div')
  doc.body.appendChild(empty)
  hover(empty)
  overlay = doc.querySelector('[data-af-overlay="group-name-preview"]')
  assert.equal(overlay.shadowRoot.querySelector('.value').textContent, '（空白）')
  empty.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  const emptyResult = c.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_GROUP_NAME_RESULT').at(-1)
  assert.equal(emptyResult.args[0].text, '')

  await c.__emitMessage({ ...pick, requestId: 'r2' })
  const secret = doc.getElementById('secret')
  secret.getClientRects = rects
  hover(secret)
  overlay = doc.querySelector('[data-af-overlay="group-name-preview"]')
  assert.equal(overlay.style.display, 'none')
  assert.doesNotMatch(overlay.shadowRoot.textContent, /不應顯示/)
  secret.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  const passwordResult = c.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_GROUP_NAME_RESULT').at(-1)
  assert.equal(passwordResult.args[0].text, '')
  assert.equal(doc.querySelector('[data-af-overlay="group-name-preview"]'), null)

  await c.__emitMessage({ ...pick, requestId: 'r3' })
  assert.ok(doc.querySelector('[data-af-overlay="group-name-preview"]'))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  assert.equal(doc.querySelector('[data-af-overlay="group-name-preview"]'), null, 'Escape 取消時清理')
})
