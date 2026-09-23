// AF-22 F1c-1：task 已寫入但 done checkpoint 中斷，reload 以固定 id 對帳後續保存。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

test('F1c-1 saveTask 後 done checkpoint 中斷，reload/retry 沿用固定 taskId 且不重複首抓', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  chromeMock.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/prices' }])
  chromeMock.__setTabResponder((_tabId, message) => message.type === 'PICK_DRAIN' ? { ok: true, drained: true, ...(message.validateSources ? { validatedSources: message.expectedSources?.length || 0 } : {}) } : undefined)
  chromeMock.runtime.id = 'autofetcher-test'
  const storage = await import('../src/shared/storage.js?f1c-storage=' + Math.random())
  const tab = await chrome.tabs.create({ url: 'https://a.test/prices' })
  await storage.setPanelCtx(tab.id, { kind: 'waiting', purpose: 'task', batch: true })

  const bg = await import('../src/background/main.js?f1c-bg=' + Math.random())
  const sender = { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }
  const identity = { sessionId: 'f1c-session', tabId: tab.id, documentGeneration: 'doc-f1c', routeIdentity: { path: '/prices' } }
  await bg.handleMessage({
    type: 'PICK_DRAFT_BEGIN', ...identity,
    groups: [{ key: 'g1', name: '第一組', values: [] }, { key: 'g2', name: '第二組', values: [] }],
    activeGroupKey: 'g1', stage: 'naming', form: {}
  }, sender)
  let revision = 0
  for (const [groupKey, key] of [['g1', 'v1'], ['g2', 'v2']]) {
    await bg.handleMessage({
      type: 'PICK_DRAFT_OPERATION', ...identity, operationId: `f1c-add-${key}`, expectedRevision: revision++,
      operation: { type: 'add', groupKey, value: { key, name: key, mode: 'number', source: { locator: { css: `#${key}` } }, spec: { strategy: 'auto' } } }
    }, sender)
  }
  const completed = await bg.handleMessage({ type: 'PICK_DRAFT_COMPLETE', ...identity, expectedRevision: revision }, sender)
  assert.equal(completed.ok, true)

  let failedDone = false
  let runTaskCalls = 0
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_OPERATION' && message.operation?.phase === 'task' &&
        message.operation?.state === 'done' && message.operation?.groupKey === 'g1' && !failedDone) {
      failedDone = true
      return { ok: false, error: 'storage_failure', message: 'done checkpoint interrupted' }
    }
    if (message.type === 'PICK_DRAFT_OPERATION') return bg.handleMessage(message, sender)
    if (message.type === 'RESOLVE_PANEL_TAB') return { ok: true, tabId: tab.id }
    if (message.type === 'PICK_DRAFT_READ') {
      const draft = await (await import('../src/shared/pick-draft.js?f1c-read=' + Math.random())).getPickDraft(tab.id)
      return { ok: true, draft }
    }
    if (message.type === 'REBUILD_ALARMS') return { ok: true }
    if (message.type === 'GET_NEXT_RUNS') return { ok: true, nextRuns: {} }
    if (message.type === 'RUN_TASK') {
      runTaskCalls++
      return { ok: true, outcome: 'done', value: 'ok' }
    }
    return undefined
  })

  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f1c-picker=' + Math.random())
  picker.setPickDraftContext(completed.draft, { render: false })
  await picker.renderFromPanelCtx(await storage.getPanelCtx(tab.id))
  await picker.handleSave()

  const firstTasks = await storage.getTasks()
  assert.equal(firstTasks.length, 1)
  const fixedId = firstTasks[0].id
  assert.equal(runTaskCalls, 0)
  const interruptedCtx = await storage.getPanelCtx(tab.id)
  assert.equal(interruptedCtx.items[0].taskSaveState, 'inflight')
  assert.equal(interruptedCtx.items[0].taskCheckpoint.taskId, fixedId)
  assert.equal(typeof interruptedCtx.items[0].taskCheckpoint.taskFingerprint, 'string')

  // 真正重新載入 side panel：boot 從 draft READ 恢復協定 revision，再進 batch settings。
  const reloadDom = new JSDOM(html)
  Object.defineProperty(reloadDom.window.document, 'visibilityState', { configurable: true, value: 'visible' })
  globalThis.window = reloadDom.window
  globalThis.document = reloadDom.window.document
  globalThis.Event = reloadDom.window.Event
  const reloaded = await import('../src/ui/picker/picker.js?f1c-picker-reload=' + Math.random())
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(reloadDom.window.document.querySelectorAll('#batch-list [data-batch-item]').length, 2)
  // 模擬中斷後使用者改了候選表單；對帳仍沿用已寫入任務，不覆寫它。
  const firstName = reloadDom.window.document.querySelector('#batch-list [data-batch-item] input[data-batch-name]')
  firstName.value = '中斷後改名'
  await reloaded.handleSave()

  const tasks = await storage.getTasks()
  assert.equal(tasks.length, 2, reloadDom.window.document.getElementById('errors')?.textContent || '')
  assert.equal(tasks.some(task => task.id === fixedId), true)
  assert.equal(tasks.find(task => task.id === fixedId).name, '第一組')
  assert.equal(new Set(tasks.map(task => task.id)).size, 2)
  assert.equal(runTaskCalls, 2)
})
