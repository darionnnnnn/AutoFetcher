// AF-24 D-a：取名模式與選值模式雙向互斥、取名 Esc 通知面板、頁面完成請求的轉發與面板消費
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function content(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://a.test/p' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?t=' + Math.random())
  return { c, doc: jd.window.document, win: jd.window }
}
const sentOf = (c, type) => c.__calls.filter(x => x.api === 'runtime.sendMessage' && x.args[0]?.type === type).map(x => x.args[0])
const NAME_REQ = { type: 'PICK_GROUP_NAME', requestId: 'r1', sessionId: 's1', groupKey: 'g1' }

test('取名中收到 ENTER_PICK：取名監聽拆掉，點一下不再回填名稱', async () => {
  const { c, doc, win } = await content('<p id="t">標題</p>')
  await c.__emitMessage(NAME_REQ)
  await c.__emitMessage({ type: 'ENTER_PICK', purpose: 'task', sessionId: 's1', groupKey: 'g1', pickStage: 'selecting' })
  doc.getElementById('t').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(r => setTimeout(r, 5))
  assert.equal(sentOf(c, 'PICK_GROUP_NAME_RESULT').length, 0)
  assert.equal(doc.querySelector('[data-af-overlay="group-name-preview"]'), null)
})

test('取名中按 Esc：結束取名並送一則 cancelled 結果給面板', async () => {
  const { c, doc, win } = await content('<p id="t">標題</p>')
  await c.__emitMessage(NAME_REQ)
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  const res = sentOf(c, 'PICK_GROUP_NAME_RESULT')
  assert.equal(res.length, 1)
  assert.equal(res[0].cancelled, true)
  assert.equal(res[0].requestId, 'r1')
})

test('PICK_DRAFT_FINISH_REQUEST 是 content 允許送的型別', async () => {
  const { CONTENT_ALLOWED, MSG } = await import('../src/shared/messages.js?t=' + Math.random())
  assert.ok(CONTENT_ALLOWED.has(MSG.PICK_DRAFT_FINISH_REQUEST))
})

test('background：不是這個分頁目前選取階段的完成請求一律拒絕，不轉發', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const res = await bg.handleMessage({ type: 'PICK_DRAFT_FINISH_REQUEST', sessionId: 'nope', groupKey: 'g1' },
    { tab: { id: 31, url: 'https://a.test/p' }, frameId: 0, url: 'https://a.test/p' })
  assert.equal(res.ok, false)
  assert.equal(sentOf(c, 'PICK_DRAFT_FINISH_REQUEST').length, 0)
})

test('面板：只有帶對 tabId 與 sessionId 的完成請求會按下「完成選取」', async () => {
  resetChromeMock()
  installChromeMock()
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.setPickDraftContext({ sessionId: 's1', tabId: 31, revision: 1, activeGroupKey: 'g1',
    groups: [{ key: 'g1', name: '甲', values: [{ key: 'v1' }] }] }, { render: false })
  const btn = jd.window.document.getElementById('group-finish')
  assert.ok(btn, '前置：面板要有完成選取鈕')
  btn.hidden = false
  btn.disabled = false
  let clicks = 0
  btn.click = () => { clicks++ }
  assert.equal(pk.consumeDraftFinishRequest({ type: 'PICK_DRAFT_FINISH_REQUEST', sessionId: 's1', groupKey: 'g1' }), false, '沒有 tabId（content 直接廣播的那份）不理')
  assert.equal(pk.consumeDraftFinishRequest({ type: 'PICK_DRAFT_FINISH_REQUEST', tabId: 99, sessionId: 's1' }), false)
  assert.equal(pk.consumeDraftFinishRequest({ type: 'PICK_DRAFT_FINISH_REQUEST', tabId: 31, sessionId: 's2' }), false)
  assert.equal(pk.consumeDraftFinishRequest({ type: 'PICK_DRAFT_FINISH_REQUEST', tabId: 31, sessionId: 's1' }, { tab: { id: 31, url: 'https://evil.test/' } }), false, '網頁自己塞 tabId 直接廣播的不理')
  assert.equal(pk.consumeDraftFinishRequest({ type: 'PICK_DRAFT_FINISH_REQUEST', tabId: 31, sessionId: 's1' }, {}), true)
  assert.equal(clicks, 1)
})

test('鏈結：content 送完成請求 → background 核對選取階段 → 轉給面板時帶上 tabId', async () => {
  resetChromeMock()
  const c = installChromeMock()
  c.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/prices' }])
  c.__setTabResponder((_tabId, message) => message.type === 'PICK_DRAIN' ? { ok: true } : undefined)
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const ext = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
  const begin = await bg.handleMessage({
    type: 'PICK_DRAFT_BEGIN', sessionId: 'chain-s', tabId: 31, documentGeneration: 'doc-1',
    routeIdentity: { path: '/prices' }, groups: [{ key: 'g1', name: '甲', values: [] }], activeGroupKey: 'g1'
  }, ext)
  assert.equal(begin.ok, true)
  await bg.handleMessage({ type: 'ENTER_PICK', tabId: 31, frameId: 0, purpose: 'task', sessionId: 'chain-s',
    groupKey: 'g1', activeGroupKey: 'g1', batch: true, pickStage: 'selecting' }, ext)
  const res = await bg.handleMessage({ type: 'PICK_DRAFT_FINISH_REQUEST', sessionId: 'chain-s', groupKey: 'g1' },
    { tab: { id: 31, url: 'https://a.test/prices' }, frameId: 0, url: 'https://a.test/prices' })
  assert.equal(res.ok, true, JSON.stringify(res))
  const relayed = sentOf(c, 'PICK_DRAFT_FINISH_REQUEST')
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].tabId, 31)
  assert.equal(relayed[0].sessionId, 'chain-s')
})
