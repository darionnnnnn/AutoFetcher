// AF-22 F1c-2：saved 批次頁重載後只續送 pending first-run，保護 inflight/uncertain。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const identity = { documentGeneration: 'doc-f1c2', routeIdentity: { path: '/prices' } }
const taskOf = (id, name) => ({
  id, name, url: 'https://a.test/prices', mode: 'number', enabled: true,
  locator: { css: `#${id}` }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:30'], weekdays: [] }
})

async function setupSaved(states, firstResults = []) {
  resetChromeMock()
  const chromeMock = installChromeMock()
  chromeMock.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/prices' }])
  chromeMock.__setTabResponder((_tabId, message) => message.type === 'PICK_DRAIN' ? { ok: true, drained: true, ...(message.validateSources ? { validatedSources: message.expectedSources?.length || 0 } : {}) } : undefined)
  chromeMock.runtime.id = 'autofetcher-test'
  const storage = await import('../src/shared/storage.js?f1c2-storage=' + Math.random())
  const tab = await chrome.tabs.create({ url: 'https://a.test/prices' })
  const bg = await import('../src/background/main.js?f1c2-bg=' + Math.random())
  const sender = { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }
  const groups = states.map((state, i) => ({ key: `g${i + 1}`, name: `第${i + 1}組`, values: [] }))
  const session = { ...identity, sessionId: `f1c2-session-${Math.random()}`, tabId: tab.id }
  await bg.handleMessage({ type: 'PICK_DRAFT_BEGIN', ...session, groups, activeGroupKey: 'g1', stage: 'naming', form: {} }, sender)
  let revision = 0
  for (let i = 0; i < groups.length; i++) {
    await bg.handleMessage({
      type: 'PICK_DRAFT_OPERATION', ...session, operationId: `f1c2-add-${i}`, expectedRevision: revision++,
      operation: { type: 'add', groupKey: `g${i + 1}`, value: { key: `v${i + 1}`, name: `v${i + 1}`, mode: 'number', source: { locator: { css: `#v${i + 1}` } }, spec: { strategy: 'auto' } } }
    }, sender)
  }
  const completed = await bg.handleMessage({ type: 'PICK_DRAFT_COMPLETE', ...session, expectedRevision: revision }, sender)
  assert.equal(completed.ok, true)
  revision++
  for (let i = 0; i < states.length; i++) {
    const id = `task-${i + 1}`
    await storage.saveTask(taskOf(id, `第${i + 1}組`))
    const result = await bg.handleMessage({
      type: 'PICK_DRAFT_OPERATION', ...session, operationId: `f1c2-task-${i}`, expectedRevision: revision++,
      operation: { type: 'save-state', groupKey: `g${i + 1}`, phase: 'task', state: 'done', taskId: id, taskFingerprint: `fingerprint-${i}`, taskName: `第${i + 1}組` }
    }, sender)
    assert.equal(result.ok, true)
  }
  for (let i = 0; i < states.length; i++) {
    if (!['inflight', 'done'].includes(states[i])) continue
    const result = await bg.handleMessage({
      type: 'PICK_DRAFT_OPERATION', ...session, operationId: `f1c2-first-${i}`, expectedRevision: revision++,
      operation: {
        type: 'save-state', groupKey: `g${i + 1}`, phase: 'first-run', state: states[i], taskId: `task-${i + 1}`,
        ...(firstResults[i] ? { firstResult: firstResults[i] } : {})
      }
    }, sender)
    assert.equal(result.ok, true)
  }
  const draft = await (await import('../src/shared/pick-draft.js?f1c2-draft=' + Math.random())).getPickDraft(tab.id)
  const batchRun = states.map((firstRunState, i) => ({
    key: `g${i + 1}`, taskId: `task-${i + 1}`, name: `第${i + 1}組`, taskSaveState: 'done', firstRunState,
    ...(firstResults[i] ? { firstRunResult: firstResults[i] } : {})
  }))
  await storage.setPanelCtx(tab.id, {
    kind: 'saved', batch: true, pickSessionId: session.sessionId,
    text: '已儲存 4 個任務。', batchRun
  })
  return { chromeMock, storage, bg, sender, tab, draft }
}

test('F1c-2 saved boot：只續送 pending；inflight/done 不重送，null 回覆成 uncertain', async () => {
  const { chromeMock, storage, bg, sender, tab } = await setupSaved(['pending', 'inflight', 'done', 'pending'])
  const runCalls = []
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_READ') {
      const draft = await (await import('../src/shared/pick-draft.js?f1c2-read=' + Math.random())).getPickDraft(tab.id)
      return { ok: true, draft }
    }
    if (message.type === 'PICK_DRAFT_OPERATION') return bg.handleMessage(message, sender)
    if (message.type === 'RUN_TASK') {
      runCalls.push(message.taskId)
      return message.taskId === 'task-1' ? { ok: true, outcome: 'done', value: 12 } : undefined
    }
    return undefined
  })
  const dom = new JSDOM(html, { url: `chrome-extension://autofetcher-test/ui/picker/picker.html?tabId=${tab.id}`, pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  await import('../src/ui/picker/picker.js?f1c2-picker=' + Math.random())
  await new Promise(resolve => setTimeout(resolve, 180))

  assert.deepEqual(runCalls, ['task-1', 'task-4'], '只送 pending 項目；inflight/done 不盲目重送')
  const saved = await storage.getPanelCtx(tab.id)
  assert.deepEqual(saved.batchRun.map(entry => entry.firstRunState), ['done', 'inflight', 'done', 'uncertain'], JSON.stringify(saved))
  const draft = await (await import('../src/shared/pick-draft.js?f1c2-final=' + Math.random())).getPickDraft(tab.id)
  assert.deepEqual(draft.groups.map(group => group.firstRunState), ['done', 'inflight', 'done', 'uncertain'])
  const first = dom.window.document.querySelector('#saved-feedback [data-saved-first]')
  assert.equal(first?.dataset.state, 'error', `仍有 uncertain 時畫面要提醒結果不明: ${first?.outerHTML}`)
  assert.match(first?.textContent || '', /任務管理|中斷|沒抓到/)
})

test('F1c-2 saved done：只顯示已保存結果，不重送且不標紅', async () => {
  const { chromeMock, storage, bg, sender, tab } = await setupSaved(['done'])
  const runCalls = []
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_READ') {
      const draft = await (await import('../src/shared/pick-draft.js?f1c2-read-done=' + Math.random())).getPickDraft(tab.id)
      return { ok: true, draft }
    }
    if (message.type === 'PICK_DRAFT_OPERATION') return bg.handleMessage(message, sender)
    if (message.type === 'RUN_TASK') { runCalls.push(message.taskId); return { ok: true } }
    return undefined
  })
  const dom = new JSDOM(html, { url: `chrome-extension://autofetcher-test/ui/picker/picker.html?tabId=${tab.id}`, pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  await import('../src/ui/picker/picker.js?f1c2-picker-done=' + Math.random())
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.deepEqual(runCalls, [])
  const first = dom.window.document.querySelector('#saved-feedback [data-saved-first]')
  assert.equal(first?.dataset.state, 'neutral')
  assert.match(first?.textContent || '', /已執行.*確認/)
  assert.equal((await storage.getPanelCtx(tab.id)).batchRun[0].firstRunState, 'done')
})

test('F1c-2 saved failed result：reload 保留失敗文字與紅色狀態，不重送', async () => {
  const { chromeMock, storage, bg, sender, tab } = await setupSaved(['done'], [{ ok: false, text: '第一筆沒抓到：元素不存在。請到任務管理確認' }])
  const runCalls = []
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type === 'PICK_DRAFT_READ') {
      const draft = await (await import('../src/shared/pick-draft.js?f1c2-read-failed=' + Math.random())).getPickDraft(tab.id)
      return { ok: true, draft }
    }
    if (message.type === 'PICK_DRAFT_OPERATION') return bg.handleMessage(message, sender)
    if (message.type === 'RUN_TASK') { runCalls.push(message.taskId); return { ok: true } }
    return undefined
  })
  const dom = new JSDOM(html, { url: `chrome-extension://autofetcher-test/ui/picker/picker.html?tabId=${tab.id}`, pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  await import('../src/ui/picker/picker.js?f1c2-picker-failed=' + Math.random())
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.deepEqual(runCalls, [])
  const first = dom.window.document.querySelector('#saved-feedback [data-saved-first]')
  assert.equal(first?.dataset.state, 'error', first?.outerHTML)
  assert.match(first?.textContent || '', /元素不存在/)
  assert.deepEqual((await storage.getPanelCtx(tab.id)).first, { state: 'error', text: '第一筆沒抓到：元素不存在。請到任務管理確認' })
})
