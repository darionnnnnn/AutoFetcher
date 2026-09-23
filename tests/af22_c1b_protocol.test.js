import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const fresh = async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const protocol = await import('../src/shared/pick-protocol.js?t=' + Math.random())
  const messages = await import('../src/shared/messages.js?t=' + Math.random())
  return { chromeMock, protocol, messages }
}

const begin = (over = {}) => ({
  sessionId: 'session-c1b',
  tabId: 17,
  documentGeneration: 'doc-1',
  documentIdentity: { load: 1 },
  routeIdentity: { path: '/products/1', dataset: 'prices' },
  groups: [{ key: 'g1', name: '價格', values: [] }],
  activeGroupKey: 'g1',
  ...over
})

const op = (operationId, expectedRevision, operation, over = {}) => ({
  operationId, expectedRevision, sessionId: 'session-c1b', tabId: 17,
  documentGeneration: 'doc-1', documentIdentity: { load: 1 },
  routeIdentity: { path: '/products/1', dataset: 'prices' },
  operation, ...over
})

test('C1b runtime protocol: begin/add/remove/move/rename/set-active/patch-form/pause 完整且每步 ACK', async () => {
  const { protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  let response = await protocol.beginPickDraft(begin(), sender)
  assert.equal(response.ok, true)
  assert.equal(response.revision, 0)

  response = await protocol.handlePickDraftOperation(op('a1', 0, {
    type: 'add', groupKey: 'g1', value: { key: 'v1', name: '目前價格' }
  }), sender)
  assert.equal(response.revision, 1)
  response = await protocol.handlePickDraftOperation(op('r1', 1, { type: 'rename', groupKey: 'g1', name: '現價' }), sender)
  response = await protocol.handlePickDraftOperation(op('f1', 2, { type: 'patch-form', patch: { name: '價格任務' } }), sender)
  response = await protocol.handlePickDraftOperation(op('p1', 3, { type: 'pause' }), sender)
  assert.equal(response.draft.stage, 'paused')
  assert.equal(response.draft.groups[0].name, '現價')
  assert.equal(response.draft.form.name, '價格任務')

  // 重新開始同一 session 會恢復原稿，不能清成空表。
  const resumed = await protocol.beginPickDraft(begin(), sender)
  assert.equal(resumed.draft.revision, 4)
  assert.equal(resumed.draft.groups[0].values[0].key, 'v1')
})

test('D2 block exclude/include uses one atomic replace-value operation and preserves stable source key', async () => {
  const { protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  const original = { key: 'pick-stable', mode: 'block', source: { locator: { css: '#prices' }, frame: { frameId: 0 } },
    locator: { css: '#prices' }, spec: { block: { axis: 'col', index: 2, exclude: [{ index: 1 }] } } }
  let result = await protocol.handlePickDraftOperation(op('add-block', 0,
    { type: 'add', groupKey: 'g1', value: original }), sender)
  const changed = structuredClone(original)
  changed.spec.block.exclude.push({ index: 3 })
  result = await protocol.handlePickDraftOperation(op('replace-block', 1,
    { type: 'replace-value', groupKey: 'g1', valueKey: original.key, value: changed }), sender)
  const value = result.draft.groups[0].values[0]
  assert.equal(result.draft.groups[0].values.length, 1)
  assert.equal(value.key, original.key)
  assert.deepEqual(value.source, original.source)
  assert.deepEqual(value.spec.block.exclude.map(item => item.index), [1, 3])
})

test('C1b operationId 去重：ACK 重送不增加 revision，明確 add/remove 不會因重送反轉', async () => {
  const { protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  const first = await protocol.handlePickDraftOperation(op('same', 0, {
    type: 'add', groupKey: 'g1', value: { key: 'v1' }
  }), sender)
  const again = await protocol.handlePickDraftOperation(op('same', 0, {
    type: 'add', groupKey: 'g1', value: { key: 'v1' }
  }), sender)
  assert.equal(first.revision, 1)
  assert.equal(again.revision, 1)
  assert.equal(again.duplicate, true)
  assert.equal(again.draft.groups[0].values.length, 1)
})

test('C1b 最後 ACK 才能完成；舊 revision 明確 conflict，成功回傳凍結 snapshot', async () => {
  const { protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  await protocol.handlePickDraftOperation(op('a1', 0, { type: 'add', groupKey: 'g1', value: { key: 'v1' } }), sender)
  await assert.rejects(() => protocol.completePickDraft({ ...op('done', 0, { type: 'complete' }) }, sender), /最後一筆|revision|同步/)
  const completed = await protocol.completePickDraft({
    type: 'PICK_DRAFT_COMPLETE', sessionId: 'session-c1b', tabId: 17,
    documentGeneration: 'doc-1', documentIdentity: { load: 1 },
    routeIdentity: { path: '/products/1', dataset: 'prices' }, expectedRevision: 1
  }, sender)
  assert.equal(completed.synchronized, true)
  assert.equal(completed.frozen, true)
  assert.equal(completed.ackRevision, 1)
  assert.equal(completed.snapshot.groups[0].values[0].key, 'v1')
})

test('C1b 身分不符與 storage failure 都不寫入且不回成功', async () => {
  const { chromeMock, protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  await assert.rejects(() => protocol.handlePickDraftOperation(op('bad-tab', 0, { type: 'add', groupKey: 'g1', value: { key: 'v2' } }, { tabId: 17 }), { ...sender, tab: { id: 99 } }), /tabId|身分/)
  const originalSet = chromeMock.storage.session.set
  chromeMock.storage.session.set = async () => { throw new Error('session full') }
  await assert.rejects(() => protocol.handlePickDraftOperation(op('write-fail', 0, { type: 'add', groupKey: 'g1', value: { key: 'v2' } }), sender), /session full/)
  chromeMock.storage.session.set = originalSet
})

test('C1b runtime message 可從 main 接到 session draft；面板關閉暫停，分頁關閉清除', async () => {
  const { protocol, messages } = await fresh()
  // 純協定已覆蓋 runtime handler 的同一函式；這裡核對訊息型別保持 extension-only 白名單。
  assert.ok(messages.MSG.PICK_DRAFT_BEGIN)
  assert.ok(messages.MSG.PICK_DRAFT_OPERATION)
  assert.equal(messages.CONTENT_ALLOWED.has(messages.MSG.PICK_DRAFT_OPERATION), false)
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  const read = await protocol.readPickDraftMessage({ tabId: 17, sessionId: 'session-c1b', documentGeneration: 'doc-1', routeIdentity: begin().routeIdentity }, sender)
  assert.equal(read.draft.sessionId, 'session-c1b')
})

test('C1b background handleMessage 走 runtime message 到 session draft', async () => {
  const { messages } = await fresh()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  const started = await bg.handleMessage({ type: messages.MSG.PICK_DRAFT_BEGIN, ...begin() }, sender)
  assert.equal(started.ok, true)
  const result = await bg.handleMessage({
    type: messages.MSG.PICK_DRAFT_OPERATION,
    ...op('runtime-a', 0, { type: 'add', groupKey: 'g1', value: { key: 'v1' } })
  }, sender)
  assert.equal(result.ok, true)
  assert.equal(result.draft.groups[0].values[0].key, 'v1')
})

test('C1b 完成屏障與 update 共用同一把 session lock：並行最後操作不會送舊 snapshot', async () => {
  const { chromeMock, protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  const originalGet = chromeMock.storage.session.get
  let release
  const gate = new Promise(resolve => { release = resolve })
  let blocked = false
  let draftGets = 0
  chromeMock.storage.session.get = async (key) => {
    if (key === 'pickDraft:17') draftGets++
    if (!blocked && key === 'pickDraft:17' && draftGets === 2) {
      blocked = true
      await gate
    }
    return originalGet(key)
  }
  const updatePromise = protocol.handlePickDraftOperation(
    op('race-add', 0, { type: 'add', groupKey: 'g1', value: { key: 'race' } }), sender
  )
  while (!blocked) await new Promise(resolve => setTimeout(resolve, 0))
  const completePromise = protocol.completePickDraft({
    type: 'PICK_DRAFT_COMPLETE', sessionId: 'session-c1b', tabId: 17,
    documentGeneration: 'doc-1', documentIdentity: { load: 1 },
    routeIdentity: { path: '/products/1', dataset: 'prices' }, expectedRevision: 0
  }, sender)
  release()
  await updatePromise
  await assert.rejects(completePromise, /最後一筆|revision|同步/)
  chromeMock.storage.session.get = originalGet
})

test('C1b operationId 去重仍先核身分；同 id 的舊 session／文件不能拿到成功 ACK', async () => {
  const { protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  await protocol.handlePickDraftOperation(op('claimed', 0, { type: 'add', groupKey: 'g1', value: { key: 'v1' } }), sender)
  await assert.rejects(() => protocol.handlePickDraftOperation(op('claimed', 0, {
    type: 'add', groupKey: 'g1', value: { key: 'v2' }
  }, { sessionId: 'other-session' }), sender), /sessionId|身分/)
  await assert.rejects(() => protocol.handlePickDraftOperation(op('claimed', 0, {
    type: 'add', groupKey: 'g1', value: { key: 'v2' }
  }, { documentGeneration: 'doc-2' }), sender), /文件|世代|身分/)
})

test('C1b 滾動去重歷史外的舊 operationId 以 revision conflict 拒絕，不重套用', async () => {
  const { protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  await protocol.handlePickDraftOperation(op('old-op', 0, { type: 'add', groupKey: 'g1', value: { key: 'old' } }), sender)
  for (let revision = 1; revision <= 512; revision++) {
    await protocol.handlePickDraftOperation(op(`fill-${revision}`, revision, {
      type: 'patch-form', patch: { [`field${revision}`]: revision }
    }), sender)
  }
  await assert.rejects(() => protocol.handlePickDraftOperation(
    op('old-op', 0, { type: 'add', groupKey: 'g1', value: { key: 'should-not-appear' } }), sender
  ), /revision|過期|同步/)
})

test('C1b move 到已有相同 key 是明確 conflict，來源與目標都不改；create-group 走正式操作', async () => {
  const { protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft({ ...begin(), groups: [
    { key: 'g1', name: '一', values: [{ key: 'v1' }] },
    { key: 'g2', name: '二', values: [{ key: 'v1' }] }
  ] }, sender)
  await assert.rejects(() => protocol.handlePickDraftOperation(op('move-conflict', 0, {
    type: 'move', fromGroupKey: 'g1', toGroupKey: 'g2', valueKey: 'v1'
  }), sender), /已有相同值|conflict/)
  const created = await protocol.handlePickDraftOperation(op('create', 0, {
    type: 'create-group', group: { key: 'g3', name: '三', values: [] }
  }), sender)
  assert.equal(created.draft.groups.at(-1).key, 'g3')
})

test('C1b 草稿協定拒絕 content sender，即使訊息型別被直接送進 handler', async () => {
  const { protocol, messages } = await fresh()
  await assert.rejects(() => protocol.beginPickDraft(begin(), {
    url: 'https://a.test/products/1', tab: { id: 17 }, frameId: 0
  }), /擴充功能頁|forbidden|sender/)
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const response = await bg.handleMessage({ type: messages.MSG.PICK_DRAFT_BEGIN, ...begin() }, {
    url: 'https://a.test/products/1', tab: { id: 17 }, frameId: 0
  })
  assert.equal(response.ok, false)
  assert.equal(response.error, 'forbidden')
})

test('C1b pause 寫入失敗不回成功；無 panel ctx 仍送 EXIT_PICK 清所有可列出的 frame', async () => {
  const { chromeMock, protocol } = await fresh()
  const sender = { url: 'chrome-extension://test/ui/picker/picker.html' }
  await protocol.beginPickDraft(begin(), sender)
  chromeMock.__setScriptResponder?.(() => [
    { frameId: 0, result: 'https://a.test/products/1' },
    { frameId: 4, result: 'https://frame.test/prices' }
  ])
  const originalSet = chromeMock.storage.session.set
  chromeMock.storage.session.set = async () => { throw new Error('session full') }
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const result = await bg.closePanelFor(17)
  chromeMock.storage.session.set = originalSet
  assert.equal(result.ok, false)
  const exits = chromeMock.__calls.filter(call => call.api === 'tabs.sendMessage' && call.args[1]?.type === 'EXIT_PICK')
  assert.ok(exits.length >= 2)
})
