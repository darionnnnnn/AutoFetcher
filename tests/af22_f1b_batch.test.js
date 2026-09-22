// AF-22 F1b：完成 snapshot 的每個群組都進既有批次設定與儲存流程。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

test('F1b 兩組多來源完成 snapshot 進 batch，實際保存兩個 multi task 並各自首抓', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  chromeMock.runtime.id = 'autofetcher-test'
  const storage = await import('../src/shared/storage.js?f1b-storage=' + Math.random())
  const tab = await chrome.tabs.create({ url: 'https://a.test/prices' })
  await storage.setPanelCtx(tab.id, { kind: 'waiting', purpose: 'task', batch: true })

  const bg = await import('../src/background/main.js?f1b-bg=' + Math.random())
  const sender = { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }
  const identity = {
    sessionId: 'f1b-session', tabId: tab.id, documentGeneration: 'doc-f1b',
    routeIdentity: { path: '/prices', dataset: 'live' }
  }
  assert.equal((await bg.handleMessage({
    type: 'PICK_DRAFT_BEGIN', ...identity, groups: [
      { key: 'g1', name: '價格組', values: [] },
      { key: 'g2', name: '名稱組', values: [] }
    ], activeGroupKey: 'g1', stage: 'selecting', form: {}
  }, sender)).ok, true)

  const values = [
    { key: 'price-a', name: '現價A', mode: 'number', source: { locator: { css: '#price-a' } }, spec: { strategy: 'auto' } },
    { key: 'price-b', name: '現價B', mode: 'number', source: { locator: { css: '#price-b' }, frame: { url: 'https://b.test/embed' } }, spec: { strategy: 'auto' } },
    { key: 'name-a', name: '名稱A', mode: 'text', source: { locator: { css: '#name-a' } }, spec: { mode: 'text', strategy: 'auto' } },
    { key: 'name-b', name: '名稱B', mode: 'text', source: { locator: { css: '#name-b' }, frame: { url: 'https://c.test/embed' } }, spec: { mode: 'text', strategy: 'auto' } }
  ]
  let revision = 0
  for (const [groupKey, value] of [['g1', values[0]], ['g1', values[1]], ['g2', values[2]], ['g2', values[3]]]) {
    const response = await bg.handleMessage({
      type: 'PICK_DRAFT_OPERATION', ...identity, operationId: `f1b-add-${revision}`,
      expectedRevision: revision, operation: { type: 'add', groupKey, value }
    }, sender)
    assert.equal(response.ok, true)
    revision++
  }

  let runTaskCalls = 0
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION') return bg.handleMessage(message, sender)
    if (message.type === 'RESOLVE_PANEL_TAB') return { ok: true, tabId: tab.id }
    if (message.type === 'PICK_DRAFT_READ') {
      const draft = await (await import('../src/shared/pick-draft.js?f1b-read=' + Math.random())).getPickDraft(tab.id)
      return { ok: true, draft }
    }
    if (message.type === 'REBUILD_ALARMS') return { ok: true }
    if (message.type === 'GET_NEXT_RUNS') return { ok: true, nextRuns: {} }
    if (message.type === 'RUN_TASK') {
      runTaskCalls++
      return { ok: true, outcome: 'done', status: 'ok', value: 'ok' }
    }
    return undefined
  })

  const completed = await bg.handleMessage({ type: 'PICK_DRAFT_COMPLETE', ...identity, expectedRevision: revision }, sender)
  assert.equal(completed.ok, true)
  assert.equal(completed.draft.stage, 'settings')
  assert.equal(completed.panelContext.kind, 'batch')
  assert.deepEqual(completed.panelContext.items.map(item => ({ key: item.key, name: item.nameHint, count: item.fields.length })), [
    { key: 'g1', name: '價格組', count: 2 },
    { key: 'g2', name: '名稱組', count: 2 }
  ])

  const savedCtx = await storage.getPanelCtx(tab.id)
  assert.equal(savedCtx.kind, 'batch')
  assert.equal(savedCtx.items[1].fields[1].source.frame.url, 'https://c.test/embed')

  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f1b-picker=' + Math.random())
  picker.setPickDraftContext(completed.draft, { render: false })
  await picker.renderFromPanelCtx(savedCtx)
  assert.equal(dom.window.document.querySelectorAll('#batch-list [data-batch-item]').length, 2)

  // 模擬面板 reload：協定草稿保留 revision，但畫面應恢復 batch settings，
  // 且不可重新建立一份選值草稿。
  const reloadDom = new JSDOM(html)
  Object.defineProperty(reloadDom.window.document, 'visibilityState', { configurable: true, value: 'visible' })
  globalThis.window = reloadDom.window
  globalThis.document = reloadDom.window.document
  globalThis.Event = reloadDom.window.Event
  const beforeBegin = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_BEGIN').length
  const reloadedPicker = await import('../src/ui/picker/picker.js?f1b-reload=' + Math.random())
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(reloadDom.window.document.querySelector('#group-draft-section').hidden, true)
  assert.equal(reloadDom.window.document.querySelectorAll('#batch-list [data-batch-item]').length, 2)
  assert.equal(chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_BEGIN').length, beforeBegin)
  await reloadedPicker.handleSave()

  const tasks = await storage.getTasks()
  assert.equal(tasks.length, 2)
  assert.deepEqual(tasks.map(task => task.name), ['價格組', '名稱組'])
  assert.equal(tasks.every(task => task.mode === 'multi' && task.spec.mode === 'multi'), true)
  assert.deepEqual(tasks.map(task => task.spec.fields.map(field => field.key)), [['price-a', 'price-b'], ['name-a', 'name-b']])
  assert.equal(runTaskCalls, 2)
  assert.equal(chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'REBUILD_ALARMS').length, 1)
  const savedReloadDom = new JSDOM(html)
  Object.defineProperty(savedReloadDom.window.document, 'visibilityState', { configurable: true, value: 'visible' })
  globalThis.window = savedReloadDom.window
  globalThis.document = savedReloadDom.window.document
  globalThis.Event = savedReloadDom.window.Event
  const savedBeforeBegin = chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_BEGIN').length
  await import('../src/ui/picker/picker.js?f1b-saved-reload=' + Math.random())
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(savedReloadDom.window.document.querySelector('#group-draft-section').hidden, true)
  assert.equal(savedReloadDom.window.document.querySelector('#saved-feedback').hidden, false)
  assert.equal(chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_BEGIN').length, savedBeforeBegin)
  const afterSaveDraft = await (await import('../src/shared/pick-draft.js?f1b-after=' + Math.random())).getPickDraft(tab.id)
  assert.equal(afterSaveDraft.stage, 'completed')
  assert.deepEqual(afterSaveDraft.groups.map(group => ({ key: group.key, task: group.taskSaveState, first: group.firstRunState, taskId: group.taskId })), [
    { key: 'g1', task: 'done', first: 'done', taskId: tasks[0].id },
    { key: 'g2', task: 'done', first: 'done', taskId: tasks[1].id }
  ])
})

test('F1b 完成屏障拒絕含空組的 snapshot，不進設定或批次儲存', async () => {
  resetChromeMock()
  installChromeMock()
  const storage = await import('../src/shared/storage.js?f1b-empty-storage=' + Math.random())
  const tab = await chrome.tabs.create({ url: 'https://a.test/prices' })
  await storage.setPanelCtx(tab.id, { kind: 'waiting', purpose: 'task', batch: true })
  const bg = await import('../src/background/main.js?f1b-empty-bg=' + Math.random())
  const sender = { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }
  const identity = {
    sessionId: 'f1b-empty', tabId: tab.id, documentGeneration: 'doc-empty',
    routeIdentity: { path: '/prices' }
  }
  await bg.handleMessage({
    type: 'PICK_DRAFT_BEGIN', ...identity,
    groups: [{ key: 'g1', name: '空組', values: [] }], activeGroupKey: 'g1', stage: 'naming', form: {}
  }, sender)
  const result = await bg.handleMessage({ type: 'PICK_DRAFT_COMPLETE', ...identity, expectedRevision: 0 }, sender)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'empty_group')
  assert.equal((await storage.getPanelCtx(tab.id)).kind, 'waiting')
})

test('F1b taskId checkpoint 訊息失敗時 handleBatchSave 可見中止且不寫 task', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const storage = await import('../src/shared/storage.js?f1b-checkpoint-storage=' + Math.random())
  const tab = await chrome.tabs.create({ url: 'https://a.test/prices' })
  await storage.setPanelCtx(tab.id, { kind: 'waiting', purpose: 'task', batch: true })
  const bg = await import('../src/background/main.js?f1b-checkpoint-bg=' + Math.random())
  const sender = { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }
  const identity = {
    sessionId: 'f1b-checkpoint', tabId: tab.id, documentGeneration: 'doc-checkpoint',
    routeIdentity: { path: '/prices' }
  }
  await bg.handleMessage({
    type: 'PICK_DRAFT_BEGIN', ...identity,
    groups: [{ key: 'g1', name: '價格組', values: [] }], activeGroupKey: 'g1', stage: 'naming', form: {}
  }, sender)
  await bg.handleMessage({
    type: 'PICK_DRAFT_OPERATION', ...identity, operationId: 'checkpoint-add', expectedRevision: 0,
    operation: { type: 'add', groupKey: 'g1', value: {
      key: 'price', name: '現價', mode: 'number', source: { locator: { css: '#price' } }, spec: { strategy: 'auto' }
    } }
  }, sender)
  const completed = await bg.handleMessage({ type: 'PICK_DRAFT_COMPLETE', ...identity, expectedRevision: 1 }, sender)
  assert.equal(completed.ok, true)

  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION' && message.operation?.phase === 'task' && message.operation?.state === 'inflight') {
      return { ok: false, error: 'storage_failure', message: 'session unavailable' }
    }
    return bg.handleMessage(message, sender)
  })
  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f1b-checkpoint-picker=' + Math.random())
  picker.setPickDraftContext(completed.draft, { render: false })
  await picker.renderFromPanelCtx(await storage.getPanelCtx(tab.id))
  await picker.handleSave()

  assert.equal((await storage.getTasks()).length, 0)
  assert.equal(chromeMock.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'REBUILD_ALARMS'), false)
  assert.match(dom.window.document.getElementById('errors').textContent, /保存進度同步失敗/)
})

test('F1b 第2組保存 checkpoint 中斷時第1組仍首抓一次，重試不重建第1組', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  chromeMock.runtime.id = 'autofetcher-test'
  const storage = await import('../src/shared/storage.js?f1b-partial-storage=' + Math.random())
  const tab = await chrome.tabs.create({ url: 'https://a.test/prices' })
  await storage.setPanelCtx(tab.id, { kind: 'waiting', purpose: 'task', batch: true })
  const bg = await import('../src/background/main.js?f1b-partial-bg=' + Math.random())
  const sender = { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }
  const identity = { sessionId: 'f1b-partial', tabId: tab.id, documentGeneration: 'doc-partial', routeIdentity: { path: '/prices' } }
  await bg.handleMessage({
    type: 'PICK_DRAFT_BEGIN', ...identity,
    groups: [{ key: 'g1', name: '第一組', values: [] }, { key: 'g2', name: '第二組', values: [] }],
    activeGroupKey: 'g1', stage: 'naming', form: {}
  }, sender)
  let revision = 0
  for (const [groupKey, key] of [['g1', 'v1'], ['g2', 'v2']]) {
    await bg.handleMessage({
      type: 'PICK_DRAFT_OPERATION', ...identity, operationId: `partial-add-${key}`, expectedRevision: revision++,
      operation: { type: 'add', groupKey, value: { key, name: key, mode: 'number', source: { locator: { css: `#${key}` } }, spec: { strategy: 'auto' } } }
    }, sender)
  }
  const completed = await bg.handleMessage({ type: 'PICK_DRAFT_COMPLETE', ...identity, expectedRevision: revision }, sender)
  let runTaskCalls = 0
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION' && message.operation?.phase === 'task' &&
        message.operation?.state === 'inflight' && message.operation?.groupKey === 'g2') {
      return { ok: false, error: 'storage_failure', message: 'checkpoint unavailable' }
    }
    if (message.type === 'PICK_DRAFT_OPERATION') return bg.handleMessage(message, sender)
    if (message.type === 'REBUILD_ALARMS') return { ok: true }
    if (message.type === 'RUN_TASK') { runTaskCalls++; return { ok: true, outcome: 'done', value: 'ok' } }
    if (message.type === 'GET_NEXT_RUNS') return { ok: true, nextRuns: {} }
    return undefined
  })
  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f1b-partial-picker=' + Math.random())
  picker.setPickDraftContext(completed.draft, { render: false })
  await picker.renderFromPanelCtx(await storage.getPanelCtx(tab.id))
  await picker.handleSave()

  const tasks = await storage.getTasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].name, '第一組')
  assert.equal(runTaskCalls, 1)
  assert.equal(chromeMock.__calls.filter(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'REBUILD_ALARMS').length, 1)
})
