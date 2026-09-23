import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const fresh = async (frames) => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  chromeMock.__setScriptResponder((injection) => {
    if (injection?.target?.allFrames === true) {
      return frames.map(([frameId, url]) => ({ frameId, result: url }))
    }
    return []
  })
  chromeMock.__setTabResponder((tabId, message) => ({
    ok: true,
    ...(message?.type === 'ENTER_PICK' && message?.activeGroupKey !== undefined
      ? { activeGroupKey: message.activeGroupKey }
      : {})
  }))
  const messages = await import('../src/shared/messages.js?t=' + Math.random())
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const storage = await import('../src/shared/storage.js?t=' + Math.random())
  const draft = await import('../src/shared/pick-draft.js?t=' + Math.random())
  return { chromeMock, messages, bg, storage, draft }
}

const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
const contentSender = (frameId, url) => ({
  tab: { id: 3, url: 'https://a.test/page' }, frameId, url
})

async function start(bg, messages, over = {}) {
  await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_BEGIN,
    sessionId: 's-c2a', tabId: 3, documentGeneration: 'doc-c2a',
    routeIdentity: { path: '/page' },
    groups: [{ key: 'g-1', name: '同組', values: [] }], activeGroupKey: 'g-1'
  }, extensionSender)
  return bg.handleMessage({
    type: messages.MSG.ENTER_PICK,
    tabId: 3,
    frameId: 0,
    purpose: 'task',
    sessionId: 's-c2a',
    groupKey: 'g-1',
    activeGroupKey: 'g-1',
    ...over
  }, extensionSender)
}

test('C2a 下鑽先停止舊 frame，目的 frame 收到同一 session／group 與可再定位錨', async () => {
  const { chromeMock, messages, bg } = await fresh([
    [0, 'https://a.test/page'], [7, 'https://b.test/embed'], [11, 'https://c.test/nested']
  ])
  await start(bg, messages)
  const result = await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME,
    purpose: 'task',
    src: 'https://b.test/embed?token=2',
    frameAnchor: { css: 'iframe.price-panel' },
    sessionId: 's-c2a', groupKey: 'g-1', activeGroupKey: 'g-1', draftRevision: 4
  }, contentSender(0, 'https://a.test/page'))

  assert.equal(result.ok, true)
  assert.equal(result.frameId, 7)
  assert.equal(result.activeGroupKey, 'g-1')
  const sent = chromeMock.__calls.filter((call) => call.api === 'tabs.sendMessage')
  assert.equal(sent[1].args[1].type, messages.MSG.EXIT_PICK)
  assert.deepEqual(sent[1].args[2], { frameId: 0 })
  assert.equal(sent.at(-1).args[1].type, messages.MSG.ENTER_PICK)
  assert.equal(sent.at(-1).args[1].sessionId, 's-c2a')
  assert.equal(sent.at(-1).args[1].groupKey, 'g-1')
  assert.deepEqual(sent.at(-1).args[1].frame, {
    url: 'https://b.test/embed', anchor: { css: 'iframe.price-panel' }
  })
  assert.equal(sent.at(-1).args[1].frameId, undefined)
})

test('C2a 相同 URL frame 不猜第一個：退回原層並回傳可重試 ambiguous 狀態', async () => {
  const { chromeMock, messages, bg } = await fresh([
    [0, 'https://a.test/page'], [7, 'https://b.test/embed'], [8, 'https://b.test/embed']
  ])
  await start(bg, messages)
  const result = await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME, purpose: 'task', src: 'https://b.test/embed',
    sessionId: 's-c2a', groupKey: 'g-1'
  }, contentSender(0, 'https://a.test/page'))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'frame_ambiguous')
  assert.equal(result.retryable, true)
  assert.deepEqual(result.candidates, [7, 8])
  const sent = chromeMock.__calls.filter((call) => call.api === 'tabs.sendMessage')
  const last = sent.at(-1)
  assert.equal(last.args[1].type, messages.MSG.ENTER_PICK)
  assert.equal(last.args[1].hint, 'frame_not_found')
  assert.equal(last.args[1].frameError, 'frame_ambiguous')
  assert.deepEqual(last.args[2], { frameId: 0 })
  assert.equal(sent.some((call) => [7, 8].includes(call.args[2]?.frameId)), false)
})

test('C2a 目的 frame 成為唯一作用層；舊 frame 的延遲 PICKED 不得改草稿，跨 frame 值可追加', async () => {
  const { messages, bg, storage, draft } = await fresh([
    [0, 'https://a.test/page'], [7, 'https://b.test/embed'], [11, 'https://c.test/nested']
  ])
  await start(bg, messages)
  const top = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    locator: { css: '#top' }, picks: [{ cell: { row: { index: 0 }, col: { index: 0 } } }]
  }, contentSender(0, 'https://a.test/page'))
  assert.equal(top.ok, true)
  await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME, purpose: 'task', src: 'https://b.test/embed',
    sessionId: 's-c2a', groupKey: 'g-1'
  }, contentSender(0, 'https://a.test/page'))

  const stale = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    locator: { css: '#old' }, picks: [{ cell: { row: { index: 0 }, col: { index: 0 } } }]
  }, contentSender(0, 'https://a.test/page'))
  assert.equal(stale.ok, false)
  assert.equal(stale.error, 'stale_frame')
  const staleCtx = await storage.getPanelCtx(3)
  assert.equal(staleCtx.kind, 'waiting')
  assert.equal(staleCtx.pickDraft.groups[0].values.length, 1)

  const first = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    locator: { css: '#new' }, picks: [{ cell: { row: { index: 1 }, col: { index: 0 } } }]
  }, contentSender(7, 'https://b.test/embed'))
  assert.equal(first.ok, true)
  await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME, purpose: 'task', src: 'https://c.test/nested',
    sessionId: 's-c2a', groupKey: 'g-1'
  }, contentSender(7, 'https://b.test/embed'))
  const second = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    locator: { css: '#nested' }, picks: [{ block: { axis: 'col', index: 2 } }]
  }, contentSender(11, 'https://c.test/nested'))
  assert.equal(second.ok, true)
  const saved = await draft.getPickDraft(3, { sessionId: 's-c2a' })
  assert.equal(saved.groups[0].key, 'g-1')
  assert.equal(saved.groups[0].values.length, 3)
  assert.deepEqual(saved.groups[0].values.map((item) => item.source.frame), [
    undefined, { url: 'https://b.test/embed' }, { url: 'https://c.test/nested' }
  ])
  assert.deepEqual(saved.groups[0].values.map((item) => item.source.locator.css), ['#top', '#new', '#nested'])
  assert.ok(saved.groups[0].values.every((item) => item.key && item.mode && item.spec))
  const revision = saved.revision
  const duplicate = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    locator: { css: '#nested' }, picks: [{ block: { axis: 'col', index: 2 } }]
  }, contentSender(11, 'https://c.test/nested'))
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.draft.revision, revision)
  assert.equal((await draft.getPickDraft(3)).groups[0].values.length, 3)
  const ctx = await storage.getPanelCtx(3)
  assert.deepEqual(ctx.pickDraft.groups[0].values, saved.groups[0].values)
  assert.equal(ctx.ctx, undefined)
})

test('C2a 從巢狀 frame 返回父層時只回已記錄的 parentFrameId，不猜頂層', async () => {
  const { chromeMock, messages, bg } = await fresh([
    [0, 'https://a.test/page'], [7, 'https://b.test/embed'], [11, 'https://c.test/nested']
  ])
  await start(bg, messages)
  await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME, purpose: 'task', src: 'https://b.test/embed',
    sessionId: 's-c2a', groupKey: 'g-1'
  }, contentSender(0, 'https://a.test/page'))
  await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME, purpose: 'task', src: 'https://c.test/nested',
    sessionId: 's-c2a', groupKey: 'g-1'
  }, contentSender(7, 'https://b.test/embed'))

  const result = await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME, direction: 'ascend', purpose: 'task',
    sessionId: 's-c2a', groupKey: 'g-1'
  }, contentSender(11, 'https://c.test/nested'))
  assert.equal(result.ok, true)
  assert.equal(result.frameId, 7)
  const sent = chromeMock.__calls.filter((call) => call.api === 'tabs.sendMessage')
  const last = sent.at(-1)
  assert.equal(last.args[1].type, messages.MSG.ENTER_PICK)
  assert.equal(last.args[1].sessionId, 's-c2a')
  assert.deepEqual(last.args[2], { frameId: 7 })
})

test('C2a content 下鑽先等 partial PICKED ACK，再送 DESCEND_FRAME', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const dom = new JSDOM(`<!doctype html><html><body>
    <table id="t"><tbody><tr><td id="cell">42</td></tr></tbody></table>
    <iframe id="fr" src="https://b.test/embed"></iframe>
  </body></html>`)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  const order = []
  chromeMock.__setRuntimeResponder(async (message) => {
    order.push(message.type)
    if (message.type === 'PICKED' && message.partial === true) {
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push('PICKED_ACK')
      return { ok: true, revision: 1 }
    }
    return { ok: true }
  })
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const table = document.getElementById('t')
  const cell = document.getElementById('cell')
  picker.enterPickMode({ purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1', initialTarget: table })
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(picker.selectedCount(), 1)
  const proxy = document.querySelector('[data-af-frame-proxy]')
  assert.ok(proxy)
  proxy.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  proxy.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(order, ['PICKED'])
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(order, ['PICKED', 'PICKED_ACK', 'DESCEND_FRAME'])
})

test('D1b immediate draft mode propagates to a descended frame', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const dom = new JSDOM(`<!doctype html><html><body>
    <table id="t"><tbody><tr><td id="cell">42</td></tr></tbody></table>
    <iframe id="fr" src="https://b.test/embed"></iframe>
  </body></html>`)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  chromeMock.__setRuntimeResponder(async message => ({ ok: true, revision: 2 }))
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  picker.enterPickMode({
    purpose: 'task', sessionId: 'group-session', groupKey: 'group-1',
    pickStage: 'selecting', initialTarget: document.getElementById('t')
  })

  const cell = document.getElementById('cell')
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const proxy = document.querySelector('[data-af-frame-proxy]')
  assert.ok(proxy)
  proxy.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  proxy.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))

  const messages = chromeMock.__calls
    .filter(call => call.api === 'runtime.sendMessage')
    .map(call => call.args[0])
  const descend = messages.find(message => message.type === 'DESCEND_FRAME')
  assert.ok(descend)
  assert.equal(descend.sessionId, 'group-session')
  assert.equal(descend.groupKey, 'group-1')
  assert.equal(descend.batch, true, 'child frame must use immediate draft writes')
  assert.equal(messages.filter(message => message.type === 'PICKED').length, 1,
    'the already-selected parent value is acknowledged before descending')
})

test('C2a PICKED operationId 以值 index 派生；remove 後同值可用新操作重加', async () => {
  const { messages, bg, draft } = await fresh([[0, 'https://a.test/page']])
  await start(bg, messages)
  const payload = {
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    operationId: 'pick-logical-1', locator: { css: '#same' },
    picks: [{ cell: { row: { index: 0, header: 'r' }, col: { index: 0, header: 'c' } } }],
    preview: '42', previewValue: 42
  }
  const first = await bg.handleMessage(payload, contentSender(0, 'https://a.test/page'))
  assert.equal(first.ok, true)
  const afterAdd = await draft.getPickDraft(3, { sessionId: 's-c2a' })
  const value = afterAdd.groups[0].values[0]
  const removed = await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_OPERATION,
    operationId: 'remove-value-1', expectedRevision: afterAdd.revision,
    sessionId: 's-c2a', tabId: 3,
    operation: { type: 'remove', groupKey: 'g-1', valueKey: value.key }
  }, extensionSender)
  assert.equal(removed.ok, true)
  const readded = await bg.handleMessage({ ...payload, operationId: 'pick-logical-2' }, contentSender(0, 'https://a.test/page'))
  assert.equal(readded.ok, true)
  const final = await draft.getPickDraft(3, { sessionId: 's-c2a' })
  assert.equal(final.groups[0].values.length, 1)
  assert.equal(final.groups[0].values[0].key, value.key)
  assert.equal(final.groups[0].values[0].mode, 'number')
})

test('C2a value key 沿用 B2 身分：skip／exclude／pos／名稱變化不重生', async () => {
  const { messages, bg, draft } = await fresh([[0, 'https://a.test/page']])
  await start(bg, messages)
  const initial = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    operationId: 'pick-block-1', locator: { css: '#table' },
    picks: [{ block: { axis: 'col', index: 1, headerText: 'Price' } }],
    pickModes: ['block']
  }, contentSender(0, 'https://a.test/page'))
  assert.equal(initial.ok, true)
  let saved = await draft.getPickDraft(3, { sessionId: 's-c2a' })
  const key = saved.groups[0].values[0].key
  const renamed = await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_OPERATION,
    operationId: 'rename-value-1', expectedRevision: saved.revision,
    sessionId: 's-c2a', tabId: 3,
    operation: { type: 'rename', groupKey: 'g-1', valueKey: key, name: '自訂價格' }
  }, extensionSender)
  assert.equal(renamed.ok, true)
  saved = await draft.getPickDraft(3, { sessionId: 's-c2a' })
  const changed = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    operationId: 'pick-block-2', locator: { css: '#table' },
    picks: [{ block: {
      axis: 'col', index: 1, headerText: 'Price',
      skip: { head: 1, tail: 2 }, exclude: [{ index: 3, header: 'Total' }]
    } }],
    pickModes: ['block']
  }, contentSender(0, 'https://a.test/page'))
  assert.equal(changed.ok, true)
  const final = await draft.getPickDraft(3, { sessionId: 's-c2a' })
  assert.equal(final.groups[0].values.length, 1)
  assert.equal(final.groups[0].values[0].key, key)
  assert.equal(final.groups[0].values[0].name, '自訂價格')
})

test('C2a 數值／文字格使用實際 preview 或每值 mode hint，不把多值數字猜成文字', async () => {
  const { messages, bg, draft } = await fresh([[0, 'https://a.test/page']])
  await start(bg, messages)
  const result = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: 's-c2a', groupKey: 'g-1',
    operationId: 'pick-mixed-1', locator: { css: '#table' },
    picks: [
      { cell: { row: { index: 0 }, col: { index: 0 } } },
      { cell: { row: { index: 1 }, col: { index: 0 } } }
    ],
    pickModes: ['number', 'text'], preview: '42（共 2 個值）'
  }, contentSender(0, 'https://a.test/page'))
  assert.equal(result.ok, true)
  const saved = await draft.getPickDraft(3, { sessionId: 's-c2a' })
  assert.deepEqual(saved.groups[0].values.map(value => value.mode), ['number', 'text'])
})

test('C2a transition 找不到目的 frame 時回到原 frame 並帶可見的重試錯誤', async () => {
  const { chromeMock, messages, bg } = await fresh([[0, 'https://a.test/page'], [7, 'https://b.test/embed']])
  await start(bg, messages)
  chromeMock.__setScriptResponder(() => { throw new Error('permission denied') })
  const result = await bg.handleMessage({
    type: messages.MSG.DESCEND_FRAME, purpose: 'task', src: 'https://b.test/embed',
    sessionId: 's-c2a', groupKey: 'g-1'
  }, contentSender(0, 'https://a.test/page'))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'frame_unavailable')
  assert.equal(result.retryable, true)
  const sent = chromeMock.__calls.filter(call => call.api === 'tabs.sendMessage')
  const resume = sent.at(-1)
  assert.equal(resume.args[1].type, messages.MSG.ENTER_PICK)
  assert.equal(resume.args[1].hint, 'frame_not_found')
  assert.equal(resume.args[1].frameError, 'frame_unavailable')
  assert.deepEqual(resume.args[2], { frameId: 0 })
})
