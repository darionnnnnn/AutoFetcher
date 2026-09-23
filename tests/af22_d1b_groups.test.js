import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
const contentSender = (frameId = 0) => ({
  tab: { id: 31, url: 'https://a.test/prices' },
  frameId,
  url: 'https://a.test/prices'
})

function operation(draft, operation) {
  return {
    type: 'PICK_DRAFT_OPERATION',
    operationId: `d1b-${draft.revision}-${operation.type}`,
    expectedRevision: draft.revision,
    sessionId: draft.sessionId,
    tabId: draft.tabId,
    documentGeneration: draft.documentGeneration,
    routeIdentity: draft.routeIdentity,
    operation
  }
}

test('D1b 同頁跨表／元素留在作用群組，第二組可同表加值，切回後移值保留草稿', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  chromeMock.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/prices' }])
  chromeMock.__setTabResponder((_tabId, message) => message.type === 'PICK_DRAIN' ? { ok: true } : undefined)
  const messages = await import('../src/shared/messages.js?t=' + Math.random())
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const draftApi = await import('../src/shared/pick-draft.js?t=' + Math.random())
  const begin = await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_BEGIN,
    sessionId: 'd1b-session', tabId: 31, documentGeneration: 'doc-1',
    routeIdentity: { path: '/prices' },
    groups: [{ key: 'group-1', name: '甲組', values: [] }], activeGroupKey: 'group-1'
  }, extensionSender)
  let current = begin.draft
  await bg.handleMessage({
    type: messages.MSG.ENTER_PICK, tabId: 31, frameId: 0, purpose: 'task',
    sessionId: current.sessionId, groupKey: 'group-1', activeGroupKey: 'group-1', batch: true,
    pickStage: 'selecting'
  }, extensionSender)

  const pick = async (locator, cell) => {
    const result = await bg.handleMessage({
      type: messages.MSG.PICKED, purpose: 'task', sessionId: current.sessionId,
      groupKey: current.activeGroupKey, locator, picks: [{ cell }]
    }, contentSender())
    assert.equal(result.ok, true)
    current = result.draft
  }
  await pick({ css: '#table-a' }, { row: { index: 0 }, col: { index: 0 } })
  await pick({ css: '#table-b' }, { row: { index: 1 }, col: { index: 0 } })
  const element = await bg.handleMessage({
    type: messages.MSG.PICKED, purpose: 'task', sessionId: current.sessionId,
    groupKey: current.activeGroupKey, locator: { css: '#standalone' },
    picks: [{ mode: 'text' }]
  }, contentSender())
  assert.equal(element.ok, true)
  current = element.draft
  assert.equal(current.groups[0].values.length, 3)

  let result = await bg.handleMessage(operation(current, {
    type: 'create-group', group: { key: 'group-2', name: '乙組', values: [] }
  }), extensionSender)
  assert.equal(result.ok, true)
  current = result.draft
  result = await bg.handleMessage(operation(current, { type: 'set-active', groupKey: 'group-2' }), extensionSender)
  current = result.draft
  await bg.handleMessage({
    type: messages.MSG.ENTER_PICK, tabId: 31, frameId: 0, purpose: 'task',
    sessionId: current.sessionId, groupKey: 'group-2', activeGroupKey: 'group-2', batch: true,
    pickStage: 'selecting'
  }, extensionSender)
  await pick({ css: '#table-b' }, { row: { index: 2 }, col: { index: 0 } })
  assert.equal(current.groups[1].values.length, 1)

  result = await bg.handleMessage(operation(current, { type: 'set-active', groupKey: 'group-1' }), extensionSender)
  current = result.draft
  await bg.handleMessage({
    type: messages.MSG.ENTER_PICK, tabId: 31, frameId: 0, purpose: 'task',
    sessionId: current.sessionId, groupKey: 'group-1', activeGroupKey: 'group-1', batch: true,
    pickStage: 'selecting'
  }, extensionSender)
  const movedValueKey = current.groups[1].values[0].key
  result = await bg.handleMessage(operation(current, {
    type: 'move', fromGroupKey: 'group-2', toGroupKey: 'group-1', valueKey: movedValueKey
  }), extensionSender)
  assert.equal(result.ok, true)
  current = result.draft
  assert.equal(current.activeGroupKey, 'group-1')
  assert.equal(current.groups[0].values.length, 4)
  assert.equal(current.groups[1].values.length, 0)
  const saved = await draftApi.getPickDraft(31, { sessionId: current.sessionId })
  assert.deepEqual(saved.groups.map(group => [group.key, group.values.length]), [['group-1', 4], ['group-2', 0]])
  assert.equal(chromeMock.__calls.some(call => call.args[0]?.batch && call.args[0]?.type === messages.MSG.PICKED), false)
})

test('D1b content picking sends one PICKED per cross-table／element value in the selected group', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const dom = new JSDOM(`<!doctype html><html><body>
    <table id="table-a"><tbody><tr><td id="a-cell">甲</td></tr></tbody></table>
    <table id="table-b"><tbody><tr><td id="b-cell">乙</td></tr></tbody></table>
    <span id="standalone">丙</span>
  </body></html>`)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chromeMock.__setRuntimeResponder(async message => ({
    ok: true,
    revision: 1,
    message
  }))
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const tableA = document.getElementById('table-a')
  const tableB = document.getElementById('table-b')
  const cellA = document.getElementById('a-cell')
  const cellB = document.getElementById('b-cell')
  const standalone = document.getElementById('standalone')
  picker.enterPickMode({ purpose: 'task', sessionId: 'd1b-session', groupKey: 'group-1', batch: true, pickStage: 'selecting', initialTarget: tableA })
  const choose = async (target) => {
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  await choose(cellA)
  await choose(cellB)
  await choose(standalone)
  const picked = chromeMock.__calls
    .filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
    .map(call => call.args[0])
  assert.equal(picked.length, 3)
  assert.ok(picked.every(message => message.sessionId === 'd1b-session' && message.groupKey === 'group-1'))
  assert.ok(picked.every(message => !message.batch && message.picks?.length === 1))
  picker.exitPickMode()
})

test('D1b 群組取名回報綁 requestId／文件身分，舊回報被拒', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const messages = await import('../src/shared/messages.js?t=' + Math.random())
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const begin = await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_BEGIN,
    sessionId: 'name-session', tabId: 31, documentGeneration: 'doc-name',
    routeIdentity: { path: '/prices' },
    groups: [{ key: 'group-1', name: '甲組', values: [] }], activeGroupKey: 'group-1'
  }, extensionSender)
  await bg.handleMessage({
    type: messages.MSG.ENTER_PICK, tabId: 31, frameId: 0, purpose: 'task', batch: true,
    sessionId: begin.draft.sessionId, groupKey: 'group-1', activeGroupKey: 'group-1',
    pickStage: 'selecting', documentGeneration: 'doc-name', routeIdentity: { path: '/prices' }
  }, extensionSender)
  const request = await bg.handleMessage({
    type: messages.MSG.PICK_GROUP_NAME, tabId: 31, requestId: 'name-1',
    sessionId: begin.draft.sessionId, groupKey: 'group-1',
    documentGeneration: 'doc-name', routeIdentity: { path: '/prices' }
  }, extensionSender)
  assert.equal(request.ok, true)
  const sentToPage = chromeMock.__calls.find(call => call.api === 'tabs.sendMessage' && call.args[1]?.type === messages.MSG.PICK_GROUP_NAME)
  assert.equal(sentToPage.args[1].requestId, 'name-1')
  const staleRequest = await bg.handleMessage({
    type: messages.MSG.PICK_GROUP_NAME_RESULT, requestId: 'old', sessionId: begin.draft.sessionId,
    groupKey: 'group-1', documentGeneration: 'doc-name', routeIdentity: { path: '/prices' }, text: '舊名'
  }, contentSender())
  assert.equal(staleRequest.error, 'stale_frame')
  const staleDocument = await bg.handleMessage({
    type: messages.MSG.PICK_GROUP_NAME_RESULT, requestId: 'name-1', sessionId: begin.draft.sessionId,
    groupKey: 'group-1', documentGeneration: 'doc-new', routeIdentity: { path: '/prices' }, text: '舊頁'
  }, contentSender())
  assert.equal(staleDocument.error, 'stale_frame')
  const accepted = await bg.handleMessage({
    type: messages.MSG.PICK_GROUP_NAME_RESULT, requestId: 'name-1', sessionId: begin.draft.sessionId,
    groupKey: 'group-1', documentGeneration: 'doc-name', routeIdentity: { path: '/prices' }, text: '新名'
  }, contentSender())
  assert.equal(accepted.ok, true)
  const forwarded = chromeMock.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === messages.MSG.PICK_GROUP_NAME_RESULT)
  assert.equal(forwarded.args[0].requestId, 'name-1')
})

test('D1b 重新進入同一群組以背景草稿初始化，點既有值送 removePicks', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const dom = new JSDOM(`<!doctype html><html><body>
    <table id="table-a"><tbody><tr><td id="a-cell">甲</td></tr></tbody></table>
  </body></html>`)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chromeMock.__setRuntimeResponder(async () => ({ ok: true, revision: 1 }))
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const table = document.getElementById('table-a')
  const cell = document.getElementById('a-cell')
  const choose = async () => {
    cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  picker.enterPickMode({ purpose: 'task', sessionId: 'same-group', groupKey: 'group-1', batch: true, pickStage: 'selecting', initialTarget: table })
  await choose()
  const first = chromeMock.__calls
    .filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
    .at(-1).args[0]
  picker.enterPickMode({
    purpose: 'task', sessionId: 'same-group', groupKey: 'group-1', batch: true, pickStage: 'selecting', initialTarget: table,
    draftValues: [{ source: { locator: first.locator }, spec: first.picks[0] }]
  })
  await choose()
  const picked = chromeMock.__calls
    .filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
    .map(call => call.args[0])
  assert.equal(picked.length, 2)
  assert.equal(picked[1].picks.length, 0)
  assert.equal(picked[1].removePicks.length, 1)
  picker.exitPickMode()
})

test('D1b 既有值改名／preview／block skip 後，重新進組仍以 B2 身分點擊移除', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const dom = new JSDOM(`<!doctype html><html><body>
    <table id="table-a"><thead><tr><th id="a-head">欄甲</th></tr></thead>
      <tbody><tr><td>甲</td></tr><tr><td>乙</td></tr></tbody></table>
  </body></html>`)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  chromeMock.__setRuntimeResponder(async () => ({ ok: true, revision: 1 }))
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const table = document.getElementById('table-a')
  const header = document.getElementById('a-head')
  const chooseHeader = async () => {
    header.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  picker.enterPickMode({ purpose: 'task', sessionId: 'same-block', groupKey: 'group-1', batch: true, pickStage: 'selecting', initialTarget: table })
  await chooseHeader()
  const first = chromeMock.__calls
    .filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
    .at(-1).args[0]
  assert.equal(first.picks.length, 1)
  assert.ok(first.picks[0].block)
  const changed = structuredClone(first.picks[0])
  changed.block.skip = 7
  changed.block.exclude = [{ index: 99 }]
  picker.enterPickMode({
    purpose: 'task', sessionId: 'same-block', groupKey: 'group-1', batch: true, pickStage: 'selecting', initialTarget: table,
    draftValues: [{
      name: '使用者改名', preview: '新的預覽',
      source: { locator: first.locator }, spec: changed
    }]
  })
  await chooseHeader()
  const picked = chromeMock.__calls
    .filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
    .map(call => call.args[0])
  assert.equal(picked.length, 2)
  assert.equal(picked[1].picks.length, 0)
  assert.equal(picked[1].removePicks.length, 1)
  picker.exitPickMode()
})

test('D1b 快速切組保留舊 PICKED ACK 鏈，舊組失敗可見且可重試', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const dom = new JSDOM(`<!doctype html><html><body>
    <table id="table-a"><tbody><tr><td id="a-cell">甲</td></tr></tbody></table>
  </body></html>`)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  let releaseOld
  let oldAttempts = 0
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type !== 'PICKED') return { ok: true, revision: 1 }
    if (message.groupKey === 'group-1') {
      oldAttempts++
      if (oldAttempts === 1) return new Promise(resolve => { releaseOld = () => resolve({ ok: false, message: '舊組同步失敗' }) })
    }
    return { ok: true, revision: 1, draft: { groups: [{ key: message.groupKey, values: [] }] } }
  })
  const picker = await import('../src/content/picker-mode.js?t=' + Math.random())
  const table = document.getElementById('table-a')
  const cell = document.getElementById('a-cell')
  const choose = async () => {
    cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  picker.enterPickMode({ purpose: 'task', sessionId: 'fast-switch', groupKey: 'group-1', batch: true, pickStage: 'selecting', initialTarget: table })
  const oldPick = choose()
  await new Promise(resolve => setTimeout(resolve, 0))
  picker.enterPickMode({ purpose: 'task', sessionId: 'fast-switch', groupKey: 'group-2', batch: true, pickStage: 'selecting', initialTarget: table })
  const newPick = choose()
  await new Promise(resolve => setTimeout(resolve, 0))
  let sent = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].args[0].groupKey, 'group-1')
  releaseOld()
  await oldPick
  await newPick
  await new Promise(resolve => setTimeout(resolve, 0))
  sent = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
  assert.equal(sent.length, 2)
  assert.equal(sent[0].args[0].groupKey, 'group-1')
  assert.equal(sent[1].args[0].groupKey, 'group-2')
  picker.enterPickMode({ purpose: 'task', sessionId: 'fast-switch', groupKey: 'group-1', batch: true, pickStage: 'selecting', initialTarget: table, draftValues: [] })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.match(document.body.textContent, /舊組同步失敗/)
  await choose()
  sent = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED')
  assert.equal(sent.length, 3)
  assert.equal(sent[2].args[0].groupKey, 'group-1')
  picker.exitPickMode()
})
