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
