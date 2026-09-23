import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const fresh = async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const draft = await import('../src/shared/pick-draft.js?t=' + Math.random())
  return { chromeMock, draft }
}

const baseDraft = (over = {}) => ({
  sessionId: 'session-1',
  version: 1,
  revision: 0,
  tabId: 17,
  documentGeneration: 3,
  routeIdentity: { path: '/products/1', dataset: 'prices' },
  groups: [{
    key: 'group-1',
    name: '價格',
    values: [{ key: 'value-1', name: '目前價格', source: { locator: { css: '#price' } }, spec: { mode: 'text' } }]
  }],
  activeGroupKey: 'group-1',
  stage: 'selecting',
  form: { schedule: { type: 'daily', times: ['09:00'] }, name: '價格任務' },
  preActions: [{ type: 'wait', ms: 100 }],
  saveStates: { 'group-1': { state: 'pending' } },
  ...over
})

test('C1a 純序列化回傳獨立副本，不修改輸入，並拒絕遞迴與超限資料', async () => {
  const { draft } = await fresh()
  const input = baseDraft()
  const before = structuredClone(input)
  const encoded = draft.serializePickDraft(input)
  const decoded = draft.deserializePickDraft(encoded)
  assert.deepEqual(decoded, input)
  assert.deepEqual(input, before)
  decoded.groups[0].values[0].name = '改過'
  assert.equal(input.groups[0].values[0].name, '目前價格')

  const recursive = baseDraft()
  recursive.groups[0].values[0].spec = { fields: [] }
  assert.throws(() => draft.serializePickDraft(recursive), /遞迴|multi|結構/i)
  assert.throws(() => draft.serializePickDraft(baseDraft({ groups: Array.from({ length: 21 }, (_, i) => ({ key: `g${i}`, name: '', values: [] })) })), /20|上限/)
  assert.throws(() => draft.serializePickDraft(baseDraft({ form: { text: 'x'.repeat(draft.MAX_DRAFT_STRING_LENGTH + 1) } })), /字串|上限/)
})

test('C1a session 草稿保存、worker 重啟後可讀，錯 tab 與過期 revision 不改原稿', async () => {
  const { draft } = await fresh()
  const value = baseDraft()
  await draft.savePickDraft(value.tabId, value)
  assert.deepEqual(await draft.getPickDraft(value.tabId), value)

  const old = baseDraft({ tabId: 99, revision: 0 })
  await assert.rejects(() => draft.savePickDraft(value.tabId, old), /tab|分頁/i)
  await assert.rejects(() => draft.updatePickDraft(value.tabId, baseDraft({ revision: 0, groups: [] }), { sessionId: value.sessionId, revision: 99 }), /revision|過期|版本/i)
  assert.deepEqual(await draft.getPickDraft(value.tabId), value)

  // 重新載入模組代表 worker 重啟；session storage 內容應仍在。
  const afterRestart = await import('../src/shared/pick-draft.js?t=' + Math.random())
  assert.deepEqual(await afterRestart.getPickDraft(value.tabId), value)
})

test('C1a 合法 20 組×100 值可保存；save/update 超過總 bytes 上限時拒絕且原稿不變', async () => {
  const { draft } = await fresh()
  const groups = Array.from({ length: draft.MAX_PICK_DRAFT_GROUPS }, (_, groupIndex) => ({
    key: `g-${groupIndex}`,
    name: `組 ${groupIndex}`,
    values: Array.from({ length: draft.MAX_PICK_DRAFT_VALUES }, (_, valueIndex) => ({
      key: `g-${groupIndex}-v-${valueIndex}`,
      name: `值 ${valueIndex}`
    }))
  }))
  const boundary = baseDraft({ groups, activeGroupKey: 'g-0' })
  await draft.savePickDraft(boundary.tabId, boundary)
  assert.equal((await draft.getPickDraft(boundary.tabId)).groups.length, draft.MAX_PICK_DRAFT_GROUPS)
  assert.equal((await draft.getPickDraft(boundary.tabId)).groups[19].values.length, draft.MAX_PICK_DRAFT_VALUES)

  const chunks = Array.from({ length: 150 }, () => 'x'.repeat(draft.MAX_DRAFT_STRING_LENGTH))
  const oversized = { ...boundary, revision: 1, form: { chunks } }
  await assert.rejects(() => draft.savePickDraft(boundary.tabId, oversized), /bytes|大小|上限/i)
  await assert.rejects(() => draft.updatePickDraft(boundary.tabId, { revision: 1, form: { chunks } }, {
    sessionId: boundary.sessionId,
    revision: boundary.revision
  }), /bytes|大小|上限/i)
  assert.deepEqual(await draft.getPickDraft(boundary.tabId), boundary, '超限 save/update 都不得覆蓋原稿')
})

test('C1a route identity 物件鍵排序不同仍視為同一身分', async () => {
  const { draft } = await fresh()
  const value = baseDraft({ routeIdentity: { path: '/p', query: { sku: '1', sort: 'asc' } } })
  await draft.savePickDraft(value.tabId, value)
  assert.equal(draft.samePickDraftIdentity(value, {
    ...value,
    routeIdentity: { query: { sort: 'asc', sku: '1' }, path: '/p' }
  }), true)
  assert.ok(await draft.getPickDraft(value.tabId, {
    sessionId: value.sessionId,
    routeIdentity: { query: { sort: 'asc', sku: '1' }, path: '/p' }
  }))
})

test('C1a document generation 物件鍵排序不同仍視為同一世代', async () => {
  const { draft } = await fresh()
  const value = baseDraft({ documentGeneration: { load: 3, source: 'navigation' } })
  const reordered = { source: 'navigation', load: 3 }
  await draft.savePickDraft(value.tabId, value)
  assert.equal(draft.samePickDraftIdentity(value, { ...value, documentGeneration: reordered }), true)
  assert.ok(await draft.getPickDraft(value.tabId, {
    sessionId: value.sessionId,
    documentGeneration: reordered
  }))
  await draft.updatePickDraft(value.tabId, { stage: 'paused' }, {
    sessionId: value.sessionId,
    revision: value.revision,
    documentGeneration: reordered
  })
  assert.equal((await draft.getPickDraft(value.tabId)).stage, 'paused')
})

test('C1a clear 是明確操作，storage 寫入失敗向外回報，不假成功', async () => {
  const { chromeMock, draft } = await fresh()
  const value = baseDraft()
  await draft.savePickDraft(value.tabId, value)
  await draft.clearPickDraft(value.tabId, { sessionId: value.sessionId, revision: value.revision })
  assert.equal(await draft.getPickDraft(value.tabId), null)

  const originalSet = chromeMock.storage.session.set
  chromeMock.storage.session.set = async () => { throw new Error('session full') }
  await assert.rejects(() => draft.savePickDraft(value.tabId, value), /session full/)
  chromeMock.storage.session.set = originalSet
})

test('C1a 草稿資料模型表達暫停階段，hover 等非操作事件不會自行寫入', async () => {
  const { chromeMock, draft } = await fresh()
  const value = baseDraft({ stage: 'paused', activeGroupKey: 'group-1' })
  await draft.savePickDraft(value.tabId, value)
  const writes = chromeMock.__calls.filter(call => call.api === 'storage.session.set')
  assert.equal(writes.length, 1)
  assert.equal((await draft.getPickDraft(value.tabId)).stage, 'paused')
})

test('D2 return-selection 僅能由 settings 階段回選值，保留群組與共用表單', async () => {
  const protocol = await import('../src/shared/pick-protocol.js?t=' + Math.random())
  const base = baseDraft({ stage: 'settings', paused: true })
  const result = protocol.applyPickDraftOperation(base, {
    sessionId: base.sessionId,
    tabId: base.tabId,
    documentGeneration: base.documentGeneration,
    routeIdentity: base.routeIdentity,
    operationId: 'return-1',
    expectedRevision: base.revision,
    operation: { type: 'return-selection' }
  })
  assert.equal(result.draft.stage, 'selecting')
  assert.equal(result.draft.paused, false)
  assert.deepEqual(result.draft.groups, base.groups)
  assert.deepEqual(result.draft.form, base.form)
  assert.throws(() => protocol.applyPickDraftOperation({ ...base, stage: 'selecting' }, {
    sessionId: base.sessionId,
    tabId: base.tabId,
    documentGeneration: base.documentGeneration,
    routeIdentity: base.routeIdentity,
    operationId: 'return-2',
    expectedRevision: base.revision,
    operation: { type: 'return-selection' }
  }), /設定階段/)
})
