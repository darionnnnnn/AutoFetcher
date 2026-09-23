import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh({ liveBatch = false } = {}) {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  let storage = null
  if (liveBatch) {
    chromeMock.runtime.id = 'autofetcher-test'
    Object.defineProperty(jd.window.document, 'visibilityState', { configurable: true, value: 'visible' })
    storage = await import('../src/shared/storage.js?t=' + Math.random())
    await storage.setPanelCtx(17, { kind: 'waiting', purpose: 'task', batch: true })
    let liveDraft = null
    chromeMock.__setRuntimeResponder(async message => {
      if (message.type === 'RESOLVE_PANEL_TAB') return { tabId: 17 }
      if (message.type === 'PICK_DRAFT_READ') return { ok: true, draft: liveDraft }
      if (message.type === 'PICK_DRAFT_BEGIN') {
        liveDraft = {
          sessionId: message.sessionId,
          revision: 0,
          tabId: 17,
          documentGeneration: message.documentGeneration,
          routeIdentity: message.routeIdentity,
          groups: [],
          activeGroupKey: null,
          stage: 'empty'
        }
        return {
          ok: true,
          revision: 0,
          draft: liveDraft
        }
      }
      if (message.type === 'PICK_DRAFT_OPERATION') {
        const operation = message.operation
        if (operation.type === 'create-group') liveDraft.groups.push(structuredClone(operation.group))
        if (operation.type === 'rename') {
          const group = liveDraft.groups.find(item => item.key === operation.groupKey)
          if (group) group.name = operation.name
        }
        if (operation.type === 'set-active') liveDraft.activeGroupKey = operation.groupKey
        liveDraft = { ...liveDraft, revision: liveDraft.revision + 1, stage: 'naming' }
        return { ok: true, revision: liveDraft.revision, draft: structuredClone(liveDraft) }
      }
      return undefined
    })
  }
  const picker = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { chromeMock, picker, doc: jd.window.document, storage }
}

const draft = (over = {}) => ({
  sessionId: 'session-d1a',
  revision: 0,
  tabId: 17,
  documentGeneration: 'doc-1',
  documentIdentity: { load: 1 },
  routeIdentity: { path: '/prices', dataset: 'main' },
  groups: [],
  activeGroupKey: null,
  stage: 'empty',
  ...over
})

const ack = (base, operation, revision = base.revision + 1, over = {}) => {
  const groups = structuredClone(base.groups)
  if (operation.type === 'create-group') groups.push(structuredClone(operation.group))
  if (operation.type === 'rename') {
    const g = groups.find(item => item.key === operation.groupKey)
    if (g) g.name = operation.name
  }
  if (operation.type === 'set-active') base = { ...base, activeGroupKey: operation.groupKey }
  return {
    ok: true,
    sessionId: base.sessionId,
    tabId: base.tabId,
    revision,
    draft: { ...structuredClone(base), groups, revision, activeGroupKey: operation.groupKey ?? base.activeGroupKey, stage: 'naming', ...over }
  }
}

test('D1a 初始側欄先顯示新增第一個群組，不偷進入選值', async () => {
  const { picker, doc } = await fresh()
  picker.renderPickDraft(draft())
  assert.equal(doc.getElementById('group-draft-section').hidden, false)
  assert.equal(doc.getElementById('group-start-first').hidden, false)
  assert.equal(doc.getElementById('group-name-editor').hidden, true)
  assert.match(doc.getElementById('group-draft-section').textContent, /新增第一個群組/)
  assert.equal(doc.getElementById('group-finish').hidden, true)
})

test('D1b same panel context rehydrates a hidden tab-bound group draft without changing its values', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const value = draft({
    groups: [{ key: 'round-two', name: 'Second Round Only', values: [
      { key: 'round-two-value', name: '來源 C', source: { locator: { css: '#price-c' } } }
    ] }],
    activeGroupKey: 'round-two', stage: 'selecting'
  })
  picker.setPickDraftContext(value, { render: false })
  const ctx = { kind: 'pick-draft', tabId: value.tabId, pickDraft: structuredClone(value) }
  await picker.renderFromPanelCtx(ctx)
  const section = doc.getElementById('group-draft-section')
  assert.equal(section.hidden, false)
  assert.equal(doc.querySelector('[data-group-row]')?.dataset.groupKey, 'round-two')
  assert.equal(doc.querySelector('[data-group-value]')?.dataset.valueKey, 'round-two-value')

  // Simulate the stale screen left by another tab's panel context render.
  section.hidden = true
  const restored = await picker.renderFromPanelCtx(ctx)
  assert.deepEqual(restored, { rendered: true, rehydrated: true })
  assert.equal(section.hidden, false)
  assert.equal(doc.querySelector('[data-group-row]')?.dataset.active, 'true')
  assert.equal(doc.querySelector('[data-group-value]')?.dataset.valueKey, 'round-two-value')
  assert.deepEqual(value.groups[0].values, ctx.pickDraft.groups[0].values)
  assert.equal(chromeMock.__calls.some(call => call.args[0]?.type === 'PICK_DRAFT_COMPLETE'), false,
    'rehydration does not complete or rewrite the draft')

  const wrongTab = await picker.renderFromPanelCtx({
    ...ctx, tabId: value.tabId + 1
  })
  assert.deepEqual(wrongTab, { rendered: false, stale: true }, 'a different panel tab cannot rehydrate this draft')
  assert.equal(doc.querySelector('[data-group-value]')?.dataset.valueKey, 'round-two-value')
})

test('D1a 現有一次建立多個任務入口會先 begin 草稿，側欄可見第一個群組入口', async () => {
  const { chromeMock, doc } = await fresh({ liveBatch: true })
  assert.equal(chromeMock.runtime.id, 'autofetcher-test')
  await new Promise(resolve => setTimeout(resolve, 25))
  const begin = chromeMock.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_BEGIN')
  assert.ok(begin, '既有 batch waiting 入口要建立 C1b draft')
  assert.equal(doc.getElementById('group-draft-section').hidden, false)
  assert.equal(doc.getElementById('group-start-first').hidden, false)
  assert.match(doc.getElementById('group-draft-title').textContent, /先建立群組/)
  await doc.getElementById('group-start-first').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  const name = doc.getElementById('group-name')
  name.value = '入口命名'
  name.dispatchEvent(new window.Event('input', { bubbles: true }))
  await doc.getElementById('group-name-confirm').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  const enter = chromeMock.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'ENTER_PICK')
  assert.ok(enter, '現有入口命名確認後要進入頁面選值')
  assert.equal(enter.args[0].groupKey.startsWith('group-'), true)
})

test('D1a 新增群組先建空組並聚焦名稱；名稱 ACK 後才可開始選值', async () => {
  const { chromeMock, picker, doc } = await fresh()
  let current = draft()
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type !== 'PICK_DRAFT_OPERATION') return undefined
    const operation = message.operation
    const response = ack(current, operation)
    current = response.draft
    return response
  })
  picker.setPickDraftContext(current)
  picker.renderPickDraft(current)
  await doc.getElementById('group-start-first').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  const create = chromeMock.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_OPERATION')
  assert.equal(create.args[0].operation.type, 'create-group')
  assert.equal(create.args[0].expectedRevision, 0)
  assert.equal(doc.getElementById('group-name-editor').hidden, false)
  assert.equal(doc.activeElement, doc.getElementById('group-name'))
  assert.equal(doc.getElementById('group-start-selection').hidden, true)

  const name = doc.getElementById('group-name')
  name.value = '現價'
  name.setSelectionRange(1, 2)
  name.dispatchEvent(new window.Event('input', { bubbles: true }))
  assert.equal(doc.getElementById('group-start-selection').hidden, false)
  await doc.getElementById('group-name-confirm').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  const operations = chromeMock.__calls
    .filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_OPERATION')
    .map(call => call.args[0].operation.type)
  assert.ok(operations.includes('rename'))
  assert.ok(operations.includes('set-active'))
  const enter = chromeMock.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'ENTER_PICK')
  assert.ok(enter, '名稱確認後才請求頁面選值')
  assert.equal(enter.args[0].purpose, 'task')
  assert.equal(enter.args[0].groupKey, current.groups[0].key)
})

test('D1a 頁面取名只回填名稱，不送 PICKED／ENTER_PICK；空文字保留原名', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const g = { key: 'g1', name: '手動名', values: [] }
  const value = draft({ groups: [g], activeGroupKey: 'g1', stage: 'naming' })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  await doc.getElementById('group-name-from-page').click()
  const request = chromeMock.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_GROUP_NAME')
  assert.ok(request)
  assert.equal(request.args[0].groupKey, 'g1')
  assert.ok(request.args[0].requestId)
  await picker.consumeGroupNameResult({
    type: 'PICK_GROUP_NAME_RESULT', requestId: request.args[0].requestId,
    sessionId: value.sessionId, groupKey: 'g1',
    documentGeneration: value.documentGeneration, routeIdentity: value.routeIdentity,
    text: '頁面標題'
  })
  assert.equal(doc.getElementById('group-name').value, '頁面標題')
  await picker.consumeGroupNameResult({
    type: 'PICK_GROUP_NAME_RESULT', requestId: request.args[0].requestId,
    sessionId: value.sessionId, groupKey: 'g1',
    documentGeneration: value.documentGeneration, routeIdentity: value.routeIdentity,
    text: '   '
  })
  assert.equal(doc.getElementById('group-name').value, '頁面標題')
  const messages = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage').map(call => call.args[0])
  assert.equal(messages.some(message => message.type === 'PICKED'), false)
  assert.equal(messages.some(message => message.type === 'ENTER_PICK'), false)
})

test('D1b 取名結果需吻合 requestId 與文件身分；舊結果不覆蓋名稱', async () => {
  const { picker, doc, chromeMock } = await fresh()
  const value = draft({ groups: [{ key: 'g1', name: '原名', values: [] }], activeGroupKey: 'g1', stage: 'naming' })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  await doc.getElementById('group-name-from-page').click()
  const request = chromeMock.__calls.find(call => call.args[0]?.type === 'PICK_GROUP_NAME')?.args[0]
  assert.ok(request?.requestId)
  const stale = await picker.consumeGroupNameResult({
    type: 'PICK_GROUP_NAME_RESULT', requestId: 'old-request', sessionId: value.sessionId,
    groupKey: 'g1', documentGeneration: value.documentGeneration, routeIdentity: value.routeIdentity,
    text: '不應套用'
  })
  assert.equal(stale, false)
  assert.equal(doc.getElementById('group-name').value, '原名')
  const staleDocument = await picker.consumeGroupNameResult({
    type: 'PICK_GROUP_NAME_RESULT', requestId: request.requestId, sessionId: value.sessionId,
    groupKey: 'g1', documentGeneration: 'new-document', routeIdentity: value.routeIdentity,
    text: '也不應套用'
  })
  assert.equal(staleDocument, false)
  assert.equal(doc.getElementById('group-name').value, '原名')
  const accepted = await picker.consumeGroupNameResult({
    type: 'PICK_GROUP_NAME_RESULT', requestId: request.requestId, sessionId: value.sessionId,
    groupKey: 'g1', documentGeneration: value.documentGeneration, routeIdentity: value.routeIdentity,
    text: '新名稱'
  })
  assert.equal(accepted, true)
  assert.equal(doc.getElementById('group-name').value, '新名稱')
})

test('D1a 同名保留來源與穩定 key，20 組後新增按鈕停用；輸入框重畫保留焦點與文字', async () => {
  const { picker, doc } = await fresh()
  const groups = Array.from({ length: 20 }, (_, i) => ({
    key: `g${i}`,
    name: '同名',
    values: [{ key: `v${i}`, name: '價格', source: { frameUrl: `https://f${i}.test` } }]
  }))
  const value = draft({ groups, activeGroupKey: 'g0', stage: 'naming' })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  const rows = [...doc.querySelectorAll('[data-group-row]')]
  assert.equal(rows.length, 20)
  assert.equal(rows[0].dataset.groupKey, 'g0')
  assert.match(rows[0].textContent, /f0\.test/)
  assert.equal(doc.getElementById('group-add').disabled, true)
  const input = doc.getElementById('group-name')
  input.focus()
  input.value = '正在輸入'
  input.setSelectionRange(1, 2)
  picker.renderPickDraft({ ...value, revision: 1 })
  assert.equal(doc.activeElement, input)
  assert.equal(input.value, '正在輸入')
  assert.equal(input.selectionStart, 1)
})

test('D1a input 的 Ctrl+Z/Delete/Ctrl+A 留給欄位，不觸發完成操作', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const value = draft({ groups: [{ key: 'g1', name: '同名', values: [] }], activeGroupKey: 'g1', stage: 'naming' })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  const input = doc.getElementById('group-name')
  for (const key of ['z', 'Delete', 'a']) {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }))
  }
  assert.equal(chromeMock.__calls.some(call => call.args[0]?.type === 'PICK_DRAFT_COMPLETE'), false)
})

test('D1b Ctrl/Cmd+Enter 才能從側欄完成；命名輸入欄快捷鍵留給欄位', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const value = draft({ groups: [{ key: 'g1', name: '同名', values: [{ key: 'v1', name: '值' }] }], activeGroupKey: 'g1', stage: 'selecting' })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  const input = doc.getElementById('group-name')
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  assert.equal(chromeMock.__calls.some(call => call.args[0]?.type === 'PICK_DRAFT_COMPLETE'), false)
  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(chromeMock.__calls.some(call => call.args[0]?.type === 'PICK_DRAFT_COMPLETE'), true)
})

test('D1a session write failure 不顯示成功，保留可重試名稱', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const value = draft({ groups: [{ key: 'g1', name: '', values: [] }], activeGroupKey: 'g1', stage: 'naming' })
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION') return { ok: false, error: 'storage_failure', message: 'session full' }
    return undefined
  })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  const input = doc.getElementById('group-name')
  input.value = '保留這個字'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await doc.getElementById('group-name-confirm').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(doc.getElementById('group-name').value, '保留這個字')
  assert.match(doc.getElementById('group-draft-status').textContent, /session full|同步失敗/)
  assert.equal(chromeMock.__calls.some(call => call.args[0]?.type === 'ENTER_PICK'), false)
})

test('D1b Undo 只在移除 ACK 成功後出現；失敗不留下可誤套的 inverse', async () => {
  const { chromeMock, picker, doc } = await fresh()
  let current = draft({ groups: [{ key: 'g1', name: '群組名', values: [{ key: 'v1', name: '值' }] }], activeGroupKey: 'g1', stage: 'selecting' })
  let failRemove = true
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type !== 'PICK_DRAFT_OPERATION') return undefined
    if (message.operation.type === 'remove' && failRemove) return { ok: false, error: 'conflict', message: '同步失敗' }
    const next = structuredClone(current)
    const op = message.operation
    const group = next.groups.find(item => item.key === (op.groupKey || op.fromGroupKey))
    if (op.type === 'remove') group.values = group.values.filter(value => value.key !== op.valueKey)
    if (op.type === 'add') group.values.push(structuredClone(op.value))
    next.revision += 1
    current = next
    return { ok: true, draft: structuredClone(next), revision: next.revision }
  })
  picker.setPickDraftContext(current)
  picker.renderPickDraft(current)
  await doc.querySelector('[data-group-value] button').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(doc.getElementById('group-undo').hidden, true)
  assert.match(doc.getElementById('group-draft-status').textContent, /同步失敗/)

  failRemove = false
  picker.renderPickDraft(current)
  await doc.querySelector('[data-group-value] button').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(current.groups[0].values.length, 0)
  assert.equal(doc.getElementById('group-undo').hidden, false)

  await doc.getElementById('group-undo').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(current.groups[0].values.length, 1)
  assert.equal(current.groups[0].name, '群組名')
  assert.equal(doc.getElementById('group-undo').hidden, true)
})

test('D1a 完成前等待最後名稱 ACK，完成屏障使用最新 revision', async () => {
  const { chromeMock, picker, doc } = await fresh()
  let current = draft({
    groups: [{ key: 'g1', name: '舊名', values: [{ key: 'v1', name: '值' }] }],
    activeGroupKey: 'g1',
    stage: 'selecting'
  })
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION') {
      const op = message.operation
      if (op.type === 'rename') current.groups[0].name = op.name
      current = { ...current, revision: current.revision + 1 }
      return { ok: true, revision: current.revision, draft: structuredClone(current) }
    }
    if (message.type === 'PICK_DRAFT_COMPLETE') return { ok: true, synchronized: true, revision: current.revision }
    return undefined
  })
  picker.setPickDraftContext(current)
  picker.renderPickDraft(current)
  const input = doc.getElementById('group-name')
  input.value = '新名'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await doc.getElementById('group-finish').click()
  await new Promise(resolve => setTimeout(resolve, 20))
  const messages = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage').map(call => call.args[0])
  const rename = messages.find(message => message.type === 'PICK_DRAFT_OPERATION')
  const complete = messages.find(message => message.type === 'PICK_DRAFT_COMPLETE')
  assert.equal(rename.operation.type, 'rename')
  assert.equal(complete.expectedRevision, 1)
})

test('D2 空組有直達繼續或刪除操作，完成會定位第一個空組', async () => {
  const { chromeMock, picker, doc } = await fresh()
  let current = draft({ groups: [
    { key: 'g1', name: '有值', values: [{ key: 'v1', name: '值' }] },
    { key: 'g2', name: '空組', values: [] }
  ], activeGroupKey: 'g1', stage: 'selecting' })
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION') {
      const op = message.operation
      if (op.type === 'set-active') current = { ...current, activeGroupKey: op.groupKey }
      current = { ...current, revision: current.revision + 1 }
      return { ok: true, draft: structuredClone(current), revision: current.revision }
    }
    if (message.type === 'ENTER_PICK') return { ok: true }
    if (message.type === 'PICK_DRAFT_COMPLETE') return { ok: false, synchronized: false, message: '空組' }
    return undefined
  })
  picker.setPickDraftContext(current)
  picker.renderPickDraft(current)
  assert.equal(doc.getElementById('group-finish').disabled, false)
  assert.match(doc.querySelector('[data-group-row][data-group-key="g2"]').textContent, /繼續選值/)
  assert.match(doc.querySelector('[data-group-row][data-group-key="g2"]').textContent, /刪除此空組/)
  await doc.getElementById('group-finish').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(current.activeGroupKey, 'g2')
  const enter = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage')
    .map(call => call.args[0]).find(message => message.type === 'ENTER_PICK')
  assert.equal(enter.groupKey, 'g2')
  assert.match(doc.getElementById('group-draft-status').textContent, /沒有值/)
})

test('D2 設定畫面返回選取沿用 session 與作用組，並重新進入原群組', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const current = draft({
    groups: [{ key: 'g1', name: '目前組', values: [{ key: 'v1', name: '值', source: { locator: { css: '.value' } }, spec: { mode: 'number' } }] }],
    activeGroupKey: 'g1', stage: 'settings', form: { schedule: { type: 'interval' } }
  })
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION') return {
      ok: true, draft: { ...structuredClone(current), stage: 'selecting', paused: false, revision: 1 }, revision: 1
    }
    if (message.type === 'ENTER_PICK') return { ok: true }
    return undefined
  })
  picker.setPickDraftContext(current)
  picker.renderPickDraft(current)
  await doc.getElementById('batch-return-selection').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  const messages = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage').map(call => call.args[0])
  const operation = messages.find(message => message.type === 'PICK_DRAFT_OPERATION')
  const enter = messages.find(message => message.type === 'ENTER_PICK')
  assert.deepEqual(operation.operation, { type: 'return-selection' })
  assert.equal(operation.sessionId, current.sessionId)
  assert.equal(enter.sessionId, current.sessionId)
  assert.equal(enter.groupKey, 'g1')
  assert.equal(enter.draftValues[0].key, 'v1')
})

test('D2 復原移除值後另一組改名會使舊復原失效', async () => {
  const { chromeMock, picker, doc } = await fresh()
  let current = draft({ groups: [
    { key: 'g1', name: '甲', values: [{ key: 'v1', name: '值' }] },
    { key: 'g2', name: '乙', values: [] }
  ], activeGroupKey: 'g2', stage: 'selecting' })
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type !== 'PICK_DRAFT_OPERATION') return undefined
    const op = message.operation
    if (op.type === 'remove') current.groups.find(group => group.key === op.groupKey).values = []
    if (op.type === 'rename') current.groups.find(group => group.key === op.groupKey).name = op.name
    current = { ...current, revision: current.revision + 1 }
    return { ok: true, draft: structuredClone(current), revision: current.revision }
  })
  picker.setPickDraftContext(current)
  picker.renderPickDraft(current)
  await doc.querySelector('[data-group-row][data-group-key="g1"] [data-group-value] button').click()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(doc.getElementById('group-undo').hidden, false)
  const input = doc.getElementById('group-name')
  input.value = '乙已修正'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(current.groups[1].name, '乙已修正')
  assert.equal(doc.getElementById('group-undo').hidden, true)
  assert.equal(current.groups[0].values.length, 0)
})
