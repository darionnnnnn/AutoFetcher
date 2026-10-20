import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

async function setup(t, search = '') {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.runtime.id = 'autofetcher-test'
  const activated = new Set()
  chrome.tabs.onActivated = {
    addListener: listener => activated.add(listener),
    removeListener: listener => activated.delete(listener),
    _listeners: activated
  }
  const storage = await import('../src/shared/storage.js?af23-boot=' + Math.random())
  await storage.init()
  const dom = new JSDOM(html, { url: `chrome-extension://autofetcher-test/ui/picker/picker.html${search}` })
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const picker = await import('../src/ui/picker/picker.js?af23-boot=' + Math.random())
  t.after(() => {
    dom.window.document.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'))
    dom.window.close()
    resetChromeMock()
  })
  return { chrome, storage, dom, picker, activated }
}

test('sidepanel 在沒有 visibilitychange 時依同視窗 active tab 重跑 boot', async t => {
  const f = await setup(t)
  await f.storage.setPanelCtx(11, { kind: 'waiting', purpose: 'task', notice: 'tab-eleven' })
  await f.storage.setPanelCtx(22, { kind: 'waiting', purpose: 'task', notice: 'tab-twenty-two' })
  let activeTabId = 11
  const draftReads = []
  f.chrome.__setRuntimeResponder(message => {
    if (message?.type === 'RESOLVE_PANEL_TAB') return { ok: true, tabId: activeTabId }
    if (message?.type === 'PICK_DRAFT_READ') {
      draftReads.push(message.tabId)
      return { ok: true, draft: null }
    }
    return undefined
  })

  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'))
  await tick()
  assert.equal(f.dom.window.document.body.dataset.afPickerReady, 'true')
  assert.equal(f.dom.window.document.getElementById('panel-notice').textContent, 'tab-eleven')
  assert.deepEqual(draftReads, [11])
  assert.equal(f.activated.size, 1, 'sidepanel subscribes to tab activation')

  activeTabId = 22
  await Promise.all([...f.activated].map(listener => listener({ tabId: 22, windowId: 900 })))
  await tick()
  assert.deepEqual(draftReads, [11, 22], 'activation reloads the new tab protocol draft')
  assert.equal(f.dom.window.document.getElementById('panel-notice').textContent, 'tab-twenty-two')
  f.dom.window.document.dispatchEvent(new f.dom.window.PageTransitionEvent('pagehide'))
  assert.equal(f.activated.size, 0, 'page teardown removes the activation listener')
})

test('跨視窗 activation、forcedTab fallback 與 queryeditor 不切換 boot 目標', async t => {
  const sidepanel = await setup(t)
  await sidepanel.storage.setPanelCtx(11, { kind: 'waiting', purpose: 'task', notice: 'current-window' })
  let activeTabId = 11
  const draftReads = []
  sidepanel.chrome.__setRuntimeResponder(message => {
    if (message?.type === 'RESOLVE_PANEL_TAB') return { ok: true, tabId: activeTabId }
    if (message?.type === 'PICK_DRAFT_READ') draftReads.push(message.tabId)
    return { ok: true, draft: null }
  })
  sidepanel.dom.window.document.dispatchEvent(new sidepanel.dom.window.Event('visibilitychange'))
  await tick()
  await Promise.all([...sidepanel.activated].map(listener => listener({ tabId: 99, windowId: 901 })))
  await tick()
  assert.deepEqual(draftReads, [11], 'activation from another window is ignored')

  const forced = await setup(t, '?tabId=77')
  forced.chrome.__setRuntimeResponder(message => message?.type === 'PICK_DRAFT_READ'
    ? { ok: true, draft: null }
    : { ok: true, tabId: 88 })
  await tick()
  assert.equal(forced.activated.size, 0, 'forcedTab fallback does not subscribe to active-tab changes')

  const query = await setup(t, '?ctx=%7B%22kind%22%3A%22waiting%22%7D')
  await tick()
  assert.equal(query.activated.size, 0, 'queryeditor boot does not subscribe to sidepanel activation')
})
