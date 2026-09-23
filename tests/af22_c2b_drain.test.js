import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { sameRouteIgnoringTracking } from '../src/shared/route.js'

const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
const tabUrl = 'https://a.test/page'
const frameUrl = 'https://a.test/frame'

test('R01 shared route helper ignores only tracking query keys', () => {
  const base = 'https://user:secret@a.test/catalog?item=one&sort=asc&utm_source=mail'
  assert.equal(sameRouteIgnoringTracking(base, 'https://user:secret@a.test/catalog?item=one&sort=asc&utm_source=other'), true)
  assert.equal(sameRouteIgnoringTracking(base, 'https://other:secret@a.test/catalog?item=one&sort=asc&utm_source=mail'), false)
  assert.equal(sameRouteIgnoringTracking(base, 'https://user:changed@a.test/catalog?item=one&sort=asc&utm_source=mail'), false)
  assert.equal(sameRouteIgnoringTracking(base, 'https://user:secret@a.test/catalog?sort=asc&item=one&utm_source=mail'), false)
})

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
    ? (options?.frameId === 4 && !message.validateSources && !message.resume ? new Promise(resolve => { releaseDrain = () => resolve({ ok: true, drained: true }) }) : { ok: true, drained: true, validatedSources: message.expectedSources?.length })
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

test('C2b first group can become active before any page frame has joined the session', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const tab = await chrome.tabs.create({ url: tabUrl })
  chrome.__setScriptResponder(() => [])
  const messages = await import('../src/shared/messages.js?first=' + Math.random())
  const bg = await import('../src/background/main.js?first=' + Math.random())
  t.after(() => resetChromeMock())
  const sessionId = `first-group-${Math.random()}`
  const begun = await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_BEGIN, tabId: tab.id, sessionId,
    documentGeneration: 'document-first', routeIdentity: 'route-first',
    activeGroupKey: null, groups: [], stage: 'empty', form: {}
  }, extensionSender)
  assert.equal(begun.ok, true)
  const op = (draft, operation) => ({
    type: messages.MSG.PICK_DRAFT_OPERATION, tabId: tab.id, sessionId,
    expectedRevision: draft.revision, operationId: `first-${Math.random()}`,
    documentGeneration: 'document-first', routeIdentity: 'route-first', operation
  })
  const group = { key: 'first-group', name: '', values: [] }
  const created = await bg.handleMessage(op(begun.draft, { type: 'create-group', group }), extensionSender)
  assert.equal(created.ok, true)
  const activated = await bg.handleMessage(op(created.draft, { type: 'set-active', groupKey: group.key }), extensionSender)
  assert.equal(activated.ok, true)
  assert.equal(activated.draft.activeGroupKey, group.key)
})

test('D1a ENTER_PICK allows only the matching active group draft through a new batch panel ctx', async t => {
  const f = await fixture(t)
  const { setPanelCtx } = await import('../src/shared/storage.js?enter-pick=' + Math.random())
  const draft = {
    sessionId: f.sessionId, tabId: f.tab.id, activeGroupKey: 'g1',
    groups: [{ key: 'g1', name: '第一組', values: [] }]
  }
  await setPanelCtx(f.tab.id, { kind: 'new', batch: true, pickDraft: draft })
  const enter = async (tabId, sessionId, groupKey) => f.bg.handleMessage({
    type: f.messages.MSG.ENTER_PICK, purpose: 'task', batch: true, tabId,
    sessionId, groupKey, documentGeneration: 'document-1', routeIdentity: 'route-1'
  }, extensionSender)
  const allowed = await enter(f.tab.id, f.sessionId, 'g1')
  assert.equal(allowed.ok, true)
  const wrongGroup = await enter(f.tab.id, f.sessionId, 'g2')
  assert.equal(wrongGroup.ok, false)
  assert.equal(wrongGroup.error, 'pick_entry_blocked')
  const ordinaryTab = await f.chrome.tabs.create({ url: tabUrl })
  await setPanelCtx(ordinaryTab.id, { kind: 'new', batch: true })
  const missingDraft = await enter(ordinaryTab.id, f.sessionId, 'g1')
  assert.equal(missingDraft.ok, false, 'ordinary unfinished single/batch forms do not inherit the bypass')
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
    { frameId: 4, result: `${frameUrl}?utm_source=one` }, { frameId: 5, result: `${frameUrl}?gclid=two` }, { frameId: 0, result: tabUrl }
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
  f.chrome.__setScriptResponder(() => [
    { frameId: 4, result: `${frameUrl}?utm_source=campaign&gclid=abc` },
    { frameId: 0, result: tabUrl }
  ])
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
    ? (options?.frameId === 4 && !message.validateSources && !message.resume ? new Promise(resolve => { releaseDrain = () => resolve({ ok: true, drained: true }) }) : { ok: true, drained: true, validatedSources: message.expectedSources?.length })
    : undefined)
  const completing = f.bg.handleMessage({
    type: f.messages.MSG.PICK_DRAFT_COMPLETE, tabId: f.tab.id, sessionId: f.sessionId,
    documentGeneration: 'document-1', routeIdentity: 'route-1', expectedRevision: second.draft.revision
  }, extensionSender)
  while (!releaseDrain) await new Promise(resolve => setTimeout(resolve, 0))
  const lateAck = await f.pick('g2', '#last')
  releaseDrain()
  const result = await completing
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.synchronized, true)
  assert.equal(result.snapshot.groups[1].values.length, 2)
  assert.equal(result.revision, lateAck.draft.revision)
})

test('R01 同 URL 替換已選 table 後，完成 drain 拒絕舊來源', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><html><body><table id="old"><tbody><tr><td id="old-cell">舊值</td></tr></tbody></table><button id="switch">切組</button></body></html>', { url: tabUrl })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chrome.__setRuntimeResponder(message => message.type === 'PICKED' ? { ok: true, revision: 1 } : undefined)
  const picker = await import('../src/content/picker-mode.js?replace=' + Math.random())
  const common = { purpose: 'task', sessionId: 'same-url-replace', pickStage: 'selecting', batch: true, documentGeneration: 'doc-1', routeIdentity: 'same-route' }
  const oldTable = document.querySelector('#old')
  const oldCell = document.querySelector('#old-cell')
  oldCell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  picker.enterPickMode({ ...common, groupKey: 'g1', initialTarget: oldTable })
  oldCell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const pickedMessage = chrome.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')?.args[0]
  const expectedSources = [{ groupKey: 'g1', value: {
    source: { locator: pickedMessage.locator }, spec: pickedMessage.picks[0]
  } }]
  picker.exitPickMode()
  picker.enterPickMode({ ...common, groupKey: 'g2', initialTarget: document.querySelector('#switch') })
  const replacement = document.createElement('table')
  replacement.id = 'old'
  replacement.innerHTML = '<tbody><tr><td id="new-cell">新值</td></tr></tbody>'
  oldTable.replaceWith(replacement)
  const result = await picker.drainPickQueue({ sessionId: common.sessionId, documentGeneration: common.documentGeneration, routeIdentity: common.routeIdentity, validateSources: true, expectedSources })
  assert.equal(result.ok, false, 'same-URL DOM replacement must invalidate the prior source')
  assert.equal(result.error, 'stale_source')
  assert.match(result.message, /g1|舊值/)
  picker.releaseDraftSources(common.sessionId)
  const missingCache = await picker.drainPickQueue({ sessionId: common.sessionId, documentGeneration: common.documentGeneration, routeIdentity: common.routeIdentity, validateSources: true, expectedSources })
  assert.equal(missingCache.error, 'stale_source', 'missing frame cache must fail closed')
  assert.match(missingCache.message, /未經目前文件核對/)
  picker.exitPickMode()
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
})

test('R01 complete 對 frame 來源核對失敗會保留所有值並留在選取階段', async t => {
  const f = await fixture(t)
  const first = await f.pick('g1', '#old-source')
  const second = await f.pick('g2', '#other-source')
  const before = await f.bg.handleMessage({ type: f.messages.MSG.PICK_DRAFT_READ, tabId: f.tab.id, sessionId: f.sessionId }, extensionSender)
  f.chrome.__setTabResponder((_tab, message) => message.type === 'PICK_DRAIN' && message.validateSources
    ? { ok: false, error: 'stale_source', message: '第 g1 組的「舊值」來源未經目前文件核對，請重新選取' }
    : { ok: true, drained: true })
  const result = await f.bg.handleMessage({
    type: f.messages.MSG.PICK_DRAFT_COMPLETE, tabId: f.tab.id, sessionId: f.sessionId,
    documentGeneration: 'document-1', routeIdentity: 'route-1', expectedRevision: second.draft.revision
  }, extensionSender)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'drain_failed')
  assert.match(result.message, /g1.*舊值/)
  const read = await f.bg.handleMessage({ type: f.messages.MSG.PICK_DRAFT_READ, tabId: f.tab.id, sessionId: f.sessionId }, extensionSender)
  assert.equal(read.draft.stage, before.draft.stage)
  assert.equal(read.draft.revision, before.draft.revision)
  assert.deepEqual(read.draft.groups.map(group => group.values.length), [1, 1])
})

test('R01 保持連接的來源可更新、移組，已移除值不受孤兒 cache 阻擋', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td id="cell">初值</td></tr></tbody></table></body></html>', { url: tabUrl })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chrome.__setRuntimeResponder(message => message.type === 'PICKED' ? { ok: true } : undefined)
  const picker = await import('../src/content/picker-mode.js?move=' + Math.random())
  const identity = { sessionId: 'same-node-move', documentGeneration: 'doc-1', routeIdentity: 'same-route' }
  const cell = document.querySelector('#cell')
  picker.enterPickMode({ purpose: 'task', ...identity, groupKey: 'g1', pickStage: 'selecting', initialTarget: document.querySelector('table') })
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const picked = chrome.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')?.args[0]
  const value = { source: { locator: picked.locator }, spec: picked.picks[0] }
  const expected = [{ groupKey: 'g1', value }]
  cell.textContent = '動態更新值'
  assert.equal((await picker.drainPickQueue({ ...identity, validateSources: true, expectedSources: expected })).validatedSources, 1)
  expected[0].groupKey = 'g2' // a draft move changes group ownership, not DOM identity
  assert.equal((await picker.drainPickQueue({ ...identity, validateSources: true, expectedSources: expected })).validatedSources, 1)
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await picker.drainPickQueue({ ...identity, validateSources: true, expectedSources: [] })).validatedSources, 0)
  picker.exitPickMode()
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
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

test('R01 content 僅忽略白名單追蹤參數的新增、刪除與重排', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const initialUrl = 'https://a.test/catalog?item=one&utm_source=old&gclid=old&fbclid=old'
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td id="cell">值一</td><td id="cell2">值二</td></tr></tbody></table></body></html>', { url: initialUrl })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chrome.__setRuntimeResponder(message => message.type === 'PICKED' ? { ok: true } : undefined)
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const cell = document.querySelector('#cell')
  const identity = { sessionId: 'tracking-route', documentGeneration: 'doc-1', routeIdentity: { url: initialUrl } }
  picker.enterPickMode({ purpose: 'task', ...identity, groupKey: 'g1', pickStage: 'selecting', initialTarget: document.querySelector('table') })

  dom.window.history.pushState({}, '', '/catalog?fbclid=new&item=one&utm_campaign=next&gclid=new')
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 1)

  dom.window.history.pushState({}, '', '/catalog?item=one')
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  const secondCell = document.querySelector('#cell2')
  secondCell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  secondCell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal((await picker.drainPickQueue(identity)).ok, true, 'tracking-only additions, removals and reordering keep capture active')
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 2)
  picker.exitPickMode()
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
})

test('R01 content hash 變更保守暫停並拒絕路由外的舊 drain', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const initialUrl = 'https://a.test/catalog?item=one'
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td id="cell">值</td></tr></tbody></table></body></html>', { url: initialUrl })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chrome.__setRuntimeResponder(message => message.type === 'PICKED' ? { ok: true } : undefined)
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const identity = { sessionId: 'hash-route', documentGeneration: 'doc-1', routeIdentity: { url: initialUrl } }
  picker.enterPickMode({ purpose: 'task', ...identity, groupKey: 'g1', pickStage: 'selecting', initialTarget: document.querySelector('table') })
  dom.window.location.hash = '#section'
  assert.equal((await picker.drainPickQueue(identity)).error, 'stale_route')
  document.querySelector('#cell').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 0)
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
})

test('R01 資料集路由變更後，先前 PICKED 的延遲 stale ACK 不能恢復舊 drain', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const initialUrl = 'https://a.test/catalog?item=one'
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td id="cell">值</td></tr></tbody></table></body></html>', { url: initialUrl })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  let releaseAck
  let markSent
  const sent = new Promise(resolve => { markSent = resolve })
  chrome.__setRuntimeResponder(message => {
    if (message.type !== 'PICKED') return undefined
    markSent()
    return new Promise(resolve => { releaseAck = resolve })
  })
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const identity = { sessionId: 'stale-route-ack', documentGeneration: 'doc-1', routeIdentity: { url: initialUrl } }
  const cell = document.querySelector('#cell')
  picker.enterPickMode({ purpose: 'task', ...identity, groupKey: 'g1', pickStage: 'selecting', initialTarget: document.querySelector('table') })
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sent
  dom.window.history.pushState({}, '', '/catalog?item=two')
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  releaseAck({ ok: false, error: 'stale_route', message: '頁面資料已變更' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await picker.drainPickQueue(identity)).error, 'stale_route')
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 1)
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
})

test('R01 background PICKED 和 ENTER_PICK 接受 tracker 變化，仍維持文件世代守門', async t => {
  const f = await fixture(t, undefined, { url: tabUrl })
  const trackedUrl = 'https://a.test/page?utm_source=mail&gclid=abc'
  f.chrome.__setTabState(f.tab.id, { url: trackedUrl })
  f.chrome.__setTabResponder((_tabId, message) => message.type === f.messages.MSG.ENTER_PICK
    ? { ok: true, activeGroupKey: 'g1' }
    : undefined)

  const entered = await f.bg.handleMessage({
    type: f.messages.MSG.ENTER_PICK, tabId: f.tab.id, frameId: 0, purpose: 'task', batch: true,
    sessionId: f.sessionId, groupKey: 'g1', activeGroupKey: 'g1', documentGeneration: 'document-1',
    routeIdentity: { url: tabUrl }, draftValues: []
  }, extensionSender)
  assert.equal(entered.ok, true)

  const staleDocument = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'task', sessionId: f.sessionId, groupKey: 'g1',
    documentGeneration: 'old-document', routeIdentity: { url: tabUrl }, operationId: 'tracker-stale-doc',
    locator: { css: '#stale-document' }, picks: [{ mode: 'text' }]
  }, { tab: { id: f.tab.id, url: trackedUrl }, frameId: 0, url: trackedUrl })
  assert.equal(staleDocument.error, 'stale_document')

  const picked = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'task', sessionId: f.sessionId, groupKey: 'g1',
    documentGeneration: 'document-1', routeIdentity: { url: tabUrl }, operationId: 'tracker-valid-pick',
    locator: { css: '#valid' }, picks: [{ mode: 'text' }]
  }, { tab: { id: f.tab.id, url: trackedUrl }, frameId: 0, url: trackedUrl })
  assert.equal(picked.ok, true)
  assert.equal(picked.draft.groups[0].values.length, 1)
})

test('R01 background dataset query 與 hash 變更都拒絕延遲 PICKED', async t => {
  for (const [label, changedUrl] of [
    ['dataset query', 'https://a.test/page?item=two'],
    ['hash', 'https://a.test/page#section']
  ]) {
    const f = await fixture(t, undefined, { url: tabUrl })
    const result = await f.bg.handleMessage({
      type: f.messages.MSG.PICKED, purpose: 'task', sessionId: f.sessionId, groupKey: 'g1',
      documentGeneration: 'document-1', routeIdentity: { url: tabUrl }, operationId: `late-${label}`,
      locator: { css: '#stale' }, picks: [{ mode: 'text' }]
    }, { tab: { id: f.tab.id, url: changedUrl }, frameId: 4, url: frameUrl })
    assert.equal(result.error, 'stale_route', label)
    const read = await f.bg.handleMessage({ type: f.messages.MSG.PICK_DRAFT_READ, tabId: f.tab.id, sessionId: f.sessionId }, extensionSender)
    assert.equal(read.draft.groups[0].values.length, 0, label)
  }
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

test('C2b 已退出的參與 frame 可完成同一 session drain，但不能恢復舊選取', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><html><body><table><tbody><tr><td>值</td></tr></tbody></table></body></html>', { url: tabUrl })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chrome.__setRuntimeResponder(() => ({ ok: true }))
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  picker.enterPickMode({ purpose: 'task', sessionId: 'finished-session', groupKey: 'g1', pickStage: 'selecting', documentGeneration: 'doc-finished', routeIdentity: { url: tabUrl }, initialTarget: document.querySelector('table') })
  picker.exitPickMode()
  const drained = await picker.drainPickQueue({ sessionId: 'finished-session', documentGeneration: 'doc-finished', routeIdentity: { url: tabUrl } })
  assert.equal(drained.ok, true)
  assert.equal(drained.drained, true)
  const resumed = await picker.drainPickQueue({ sessionId: 'finished-session', documentGeneration: 'doc-finished', routeIdentity: { url: tabUrl }, resume: true })
  assert.deepEqual(resumed, { ok: true, resumed: false })
  const unrelated = await picker.drainPickQueue({ sessionId: 'other-session', resume: true })
  assert.equal(unrelated.error, 'stale_session')
  document.querySelector('td').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(chrome.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED').length, 0)
  dom.window.close()
  delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.Event; delete globalThis.MouseEvent
  t.after(() => resetChromeMock())
})

test('legacy PICKED without sessionId remains valid after a C2b participant is registered', async t => {
  const f = await fixture(t)
  const registered = await f.pick('g1', '#new-session-value')
  assert.equal(registered.ok, true)
  // This is the pre-C2 message shape. An absent msg.sessionId must not match
  // an absent participant.sessionId and dereference participant.frames.
  const legacy = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED,
    purpose: 'task',
    locator: { css: '#legacy-value' },
    previewValue: 42,
    picks: [{ mode: 'text' }]
  }, { tab: { id: f.tab.id, url: tabUrl }, frameId: 4, url: frameUrl })
  assert.equal(legacy.ok, true)
  const panel = await f.chrome.storage.session.get(`panel:${f.tab.id}`)
  assert.equal(panel[`panel:${f.tab.id}`]?.kind, 'new')
  assert.equal(panel[`panel:${f.tab.id}`]?.ctx.locator.css, '#legacy-value')
})
