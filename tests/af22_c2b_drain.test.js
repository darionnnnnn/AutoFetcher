import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
const tabUrl = 'https://a.test/page'
const frameUrl = 'https://a.test/frame'

async function fixture(t, frames = [{ frameId: 4, result: frameUrl }, { frameId: 0, result: tabUrl }], routeIdentity = 'route-1') {
  resetChromeMock()
  const chrome = installChromeMock()
  const tab = await chrome.tabs.create({ url: tabUrl })
  chrome.__setScriptResponder(() => frames)
  const messages = await import('../src/shared/messages.js?t=' + Math.random())
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const sessionId = `c2b-${Math.random()}`
  const begin = await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_BEGIN, tabId: tab.id, sessionId, documentGeneration: 'document-1',
    routeIdentity, activeGroupKey: 'g1',
    groups: [{ key: 'g1', name: '一組', values: [] }, { key: 'g2', name: '二組', values: [] }]
  }, extensionSender)
  const pick = (groupKey, locator) => bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId, groupKey,
    documentGeneration: 'document-1', routeIdentity: 'route-1',
    locator: { css: locator }, picks: [{ mode: 'text' }]
  }, { tab: { id: tab.id }, frameId: 4, url: frameUrl })
  const operation = (draft, type, extra = {}) => ({
    type: messages.MSG.PICK_DRAFT_OPERATION, tabId: tab.id, sessionId,
    expectedRevision: draft.revision, operationId: `op-${Math.random()}`,
    documentGeneration: 'document-1', routeIdentity: 'route-1', operation: { type, ...extra }
  })
  t.after(() => resetChromeMock())
  return { chrome, tab, messages, bg, sessionId, draft: begin.draft, pick, operation }
}

test('C2b set-active 等慢 frame drain／PICKED ACK，再以最新 revision 切組', async t => {
  const f = await fixture(t)
  const first = await f.pick('g1', '#first')
  let releaseDrain
  f.chrome.__setTabResponder((_tab, message, options) => message.type === 'PICK_DRAIN'
    ? (options?.frameId === 4 ? new Promise(resolve => { releaseDrain = () => resolve({ ok: true, drained: true }) }) : { ok: true, drained: true })
    : undefined)
  const switching = f.bg.handleMessage(f.operation(first.draft, 'set-active', { groupKey: 'g2' }), extensionSender)
  while (!releaseDrain) await new Promise(resolve => setTimeout(resolve, 0))
  const lateAck = await f.pick('g1', '#late')
  releaseDrain()
  const result = await switching
  assert.equal(result.ok, true)
  assert.equal(result.draft.activeGroupKey, 'g2')
  assert.equal(result.draft.groups[0].values.length, 2)
  assert.equal(result.draft.revision, lateAck.draft.revision + 1)
})

test('C2b frame 失聯與相同 URL 歧義都拒絕切組並保留草稿', async t => {
  const missing = await fixture(t)
  let draft = (await missing.pick('g1', '#one')).draft
  missing.chrome.__setScriptResponder(() => [{ frameId: 0, result: tabUrl }])
  let result = await missing.bg.handleMessage(missing.operation(draft, 'set-active', { groupKey: 'g2' }), extensionSender)
  assert.equal(result.error, 'drain_failed')
  assert.match(result.message, /失聯|重新進入/)
  assert.equal((await missing.bg.handleMessage({ type: missing.messages.MSG.PICK_DRAFT_READ, tabId: missing.tab.id, sessionId: missing.sessionId }, extensionSender)).draft.activeGroupKey, 'g1')

  const ambiguous = await fixture(t)
  draft = (await ambiguous.pick('g1', '#one')).draft
  ambiguous.chrome.__setScriptResponder(() => [
    { frameId: 4, result: frameUrl }, { frameId: 5, result: frameUrl }, { frameId: 0, result: tabUrl }
  ])
  result = await ambiguous.bg.handleMessage(ambiguous.operation(draft, 'set-active', { groupKey: 'g2' }), extensionSender)
  assert.equal(result.error, 'drain_failed')
  assert.match(result.message, /多個相同網址/)
})

test('C2b 相同 frameId 與 URL 的 frame 文件重載仍被 documentId 識別並拒絕完成', async t => {
  const frames = [
    { frameId: 4, result: frameUrl, documentId: 'frame-doc-before' },
    { frameId: 0, result: tabUrl, documentId: 'top-doc' }
  ]
  const f = await fixture(t, frames)
  const picked = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'task', sessionId: f.sessionId, groupKey: 'g1',
    documentGeneration: 'document-1', routeIdentity: 'route-1', operationId: 'frame-pick',
    locator: { css: '#frame-value' }, picks: [{ mode: 'text' }]
  }, { tab: { id: f.tab.id, url: tabUrl }, frameId: 4, url: frameUrl, documentId: 'frame-doc-before' })
  assert.equal(picked.ok, true)
  assert.equal(picked.draft.groups[0].values.length, 1)
  const pickedSecondGroup = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'task', sessionId: f.sessionId, groupKey: 'g2',
    documentGeneration: 'document-1', routeIdentity: 'route-1', operationId: 'frame-pick-g2',
    locator: { css: '#frame-value-2' }, picks: [{ mode: 'text' }]
  }, { tab: { id: f.tab.id, url: tabUrl }, frameId: 4, url: frameUrl, documentId: 'frame-doc-before' })
  assert.equal(pickedSecondGroup.ok, true)
  const staleAck = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'task', sessionId: f.sessionId, groupKey: 'g1',
    documentGeneration: 'document-1', routeIdentity: 'route-1', operationId: 'frame-pick-after-reload',
    locator: { css: '#new-document-value' }, picks: [{ mode: 'text' }]
  }, { tab: { id: f.tab.id, url: tabUrl }, frameId: 4, url: frameUrl, documentId: 'frame-doc-after' })
  assert.equal(staleAck.error, 'stale_document')
  f.chrome.__setScriptResponder(() => [
    { frameId: 4, result: frameUrl, documentId: 'frame-doc-after' },
    { frameId: 0, result: tabUrl, documentId: 'top-doc' }
  ])
  const result = await f.bg.handleMessage({
    type: f.messages.MSG.PICK_DRAFT_COMPLETE, tabId: f.tab.id, sessionId: f.sessionId,
    documentGeneration: 'document-1', routeIdentity: 'route-1'
  }, extensionSender)
  assert.equal(result.error, 'drain_failed')
  assert.match(result.message, /文件已變更/)
})

test('C2b worker 重啟後由草稿來源 URL 重建唯一 frame 目標並安全完成切組', async t => {
  const f = await fixture(t)
  const one = await f.pick('g1', '#one')
  await f.pick('g2', '#two')
  const restartedBackground = await import('../src/background/main.js?t=' + Math.random())
  const drains = []
  f.chrome.__setTabResponder((_tab, message, options) => {
    if (message.type === 'PICK_DRAIN') {
      drains.push(options?.frameId)
      return { ok: true, drained: true }
    }
    return undefined
  })
  const operation = f.operation(one.draft, 'set-active', { groupKey: 'g2' })
  const result = await restartedBackground.handleMessage(operation, extensionSender)
  assert.equal(result.ok, true)
  assert.equal(result.draft.activeGroupKey, 'g2')
  assert.deepEqual(drains.sort((a, b) => a - b), [0, 4], '重啟後應以唯一 live frame URL 重建同步目標')
})

test('C2b 立刻完成會等慢 frame 的最後一筆 PICKED ACK 並完成最新 snapshot', async t => {
  const f = await fixture(t)
  await f.pick('g1', '#first')
  const second = await f.pick('g2', '#second')
  let releaseDrain
  f.chrome.__setTabResponder((_tab, message, options) => message.type === 'PICK_DRAIN'
    ? (options?.frameId === 4 ? new Promise(resolve => { releaseDrain = () => resolve({ ok: true, drained: true }) }) : { ok: true, drained: true })
    : undefined)
  const completing = f.bg.handleMessage({
    type: f.messages.MSG.PICK_DRAFT_COMPLETE, tabId: f.tab.id, sessionId: f.sessionId,
    documentGeneration: 'document-1', routeIdentity: 'route-1', expectedRevision: second.draft.revision
  }, extensionSender)
  while (!releaseDrain) await new Promise(resolve => setTimeout(resolve, 0))
  const lateAck = await f.pick('g2', '#last')
  releaseDrain()
  const result = await completing
  assert.equal(result.ok, true)
  assert.equal(result.synchronized, true)
  assert.equal(result.snapshot.groups[1].values.length, 2)
  assert.equal(result.revision, lateAck.draft.revision)
})

test('C2b content drain 會重送相同 PICKED operation，ACK 前封鎖新手勢', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td id="cell">值</td></tr></tbody></table></body></html>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  let attempts = 0
  let release
  chrome.__setRuntimeResponder(async message => {
    if (message.type !== 'PICKED') return { ok: true }
    attempts++
    if (attempts === 1) return { ok: false, message: '暫時寫入失敗' }
    return new Promise(resolve => { release = () => resolve({ ok: true, revision: 1 }) })
  })
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const table = document.querySelector('table')
  const cell = document.querySelector('#cell')
  picker.enterPickMode({ purpose: 'task', sessionId: 'c2b-content', groupKey: 'g1', batch: true, pickStage: 'selecting', documentGeneration: 'doc-1', initialTarget: table })
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const first = chrome.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')?.args[0]
  const draining = picker.drainPickQueue({ sessionId: 'c2b-content', documentGeneration: 'doc-1' })
  while (!release) await new Promise(resolve => setTimeout(resolve, 0))
  const pickedCalls = chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
  assert.equal(pickedCalls.length, 2)
  assert.equal(pickedCalls[0].args[0].operationId, pickedCalls[1].args[0].operationId)
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 2)
  release()
  assert.equal((await draining).ok, true)
  picker.exitPickMode()
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  assert.ok(first?.operationId)
  t.after(() => resetChromeMock())
})

test('C2b 同一文件的 SPA 路徑變更後，完成屏障拒絕舊草稿並退出選取', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td id="cell">值</td></tr></tbody></table></body></html>', { url: 'https://a.test/catalog?item=one' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chrome.__setRuntimeResponder(message => message.type === 'PICKED' ? { ok: true } : undefined)
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  picker.enterPickMode({ purpose: 'task', sessionId: 'route-session', groupKey: 'g1', pickStage: 'selecting', documentGeneration: 'doc-1', routeIdentity: { url: 'https://a.test/catalog?item=one' }, initialTarget: document.querySelector('table') })
  dom.window.history.pushState({}, '', '/catalog?item=two')
  const result = await picker.drainPickQueue({ sessionId: 'route-session', documentGeneration: 'doc-1', routeIdentity: { url: 'https://a.test/catalog?item=one' } })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'stale_route')
  document.querySelector('#cell').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 0)
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
})

test('C2b 背景收到路徑已變更的延遲 PICKED 時拒絕寫入草稿', async t => {
  const f = await fixture(t, undefined, { url: tabUrl })
  const result = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'task', sessionId: f.sessionId, groupKey: 'g1',
    documentGeneration: 'document-1', routeIdentity: { url: tabUrl }, operationId: 'late-route-pick',
    locator: { css: '#stale' }, picks: [{ mode: 'text' }]
  }, { tab: { id: f.tab.id, url: 'https://a.test/catalog?item=changed' }, frameId: 4, url: frameUrl })
  assert.equal(result.error, 'stale_route')
  const read = await f.bg.handleMessage({ type: f.messages.MSG.PICK_DRAFT_READ, tabId: f.tab.id, sessionId: f.sessionId }, extensionSender)
  assert.equal(read.draft.groups[0].values.length, 0)
})

test('C2b 過期 EXIT 與另一 session 的 drain resume 不影響目前選取', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td id="cell">值</td></tr></tbody></table></body></html>', { url: tabUrl })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chrome.__setRuntimeResponder(message => message.type === 'PICKED' ? { ok: true } : undefined)
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const opts = { purpose: 'task', sessionId: 'current-session', groupKey: 'g1', pickStage: 'selecting', documentGeneration: 'doc-current', routeIdentity: { url: tabUrl }, initialTarget: document.querySelector('table') }
  picker.enterPickMode(opts)
  assert.equal(picker.exitPickMode({ identity: { sessionId: 'old-session', documentGeneration: 'doc-old', routeIdentity: { url: tabUrl } } }), false)
  const drain = await picker.drainPickQueue({ sessionId: 'current-session', documentGeneration: 'doc-current', routeIdentity: { url: tabUrl } })
  assert.equal(drain.ok, true)
  const staleResume = await picker.drainPickQueue({ sessionId: 'old-session', resume: true })
  assert.equal(staleResume.error, 'stale_session')
  document.querySelector('#cell').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  document.querySelector('#cell').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 0)
  picker.exitPickMode()
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
})
