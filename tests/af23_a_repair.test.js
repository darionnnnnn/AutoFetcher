import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }

function makeTask() {
  return {
    id: 'af23-repair', name: '多來源', url: 'https://a.test/prices', mode: 'multi', enabled: true,
    fields: [{ key: 'f1', name: '現價', mode: 'number', stateActions: [] }, { key: 'f2', name: '均價', mode: 'text' }],
    spec: { mode: 'multi', fields: [
      { key: 'f1', name: '現價', mode: 'number', source: { locator: { css: '#old-1' } },
        spec: { block: { axis: 'col', index: 2, aggregate: 'sum', skip: { head: 1, blank: true }, exclude: [{ index: 4 }], pos: 'first', inner: [{ tag: 'span', index: 1 }] } } },
      { key: 'f2', name: '均價', mode: 'text', source: { locator: { css: '#old-2' } },
        spec: { cell: { row: { index: 3 }, col: { index: 1 } } } }
    ] },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    alerts: [{ id: 'alert-f1', field: 'f1', type: 'gt', value: 10, enabled: true }]
  }
}

async function setup(t) {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/prices' }])
  chrome.__setTabResponder((_tabId, message) => message?.type === 'ENTER_PICK' ? { ok: true } : undefined)
  const storage = await import('../src/shared/storage.js?af23=' + Math.random())
  await storage.init()
  await storage.saveTask(makeTask())
  const messages = await import('../src/shared/messages.js?af23=' + Math.random())
  const bg = await import('../src/background/main.js?af23=' + Math.random())
  t.after(() => resetChromeMock())
  return { chrome, storage, messages, bg }
}

async function begin(f, repairMode = 'repair') {
  const response = await f.bg.handleMessage({
    type: f.messages.MSG.BEGIN_FIELD_REPAIR, taskId: 'af23-repair', fieldKey: 'f1', repairMode
  }, extensionSender)
  assert.equal(response.ok, true)
  const enter = f.chrome.__calls.filter(call => call.api === 'tabs.sendMessage')
    .map(call => call.args[1]).reverse().find(message => message?.type === f.messages.MSG.ENTER_PICK)
  assert.ok(enter)
  return { response, enter, sender: { tab: { id: response.tabId }, frameId: 0, url: 'https://a.test/prices' } }
}

function picked(f, grant, over = {}) {
  return f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'repick', taskId: 'af23-repair',
    repairSessionId: grant.enter.repairSessionId, repairFieldKey: 'f1', repairMode: grant.enter.repairMode,
    documentGeneration: grant.enter.documentGeneration, locator: { css: '#repaired' },
    picks: [{ block: { axis: 'col', index: 5, headerText: '新表頭' } }],
    ...over
  }, grant.sender)
}

test('AC-A2 ACK 延遲時保留畫面；成功才退出，拒絕保留原因', async t => {
  for (const outcome of ['success', 'reject', 'cancel', 'timeout', 'channel']) {
    await t.test(outcome, async subtest => {
      resetChromeMock()
      const chrome = installChromeMock()
      const dom = new JSDOM('<table><tbody><tr><td id="metric">123</td></tr></tbody></table>', { url: 'https://a.test/prices' })
      const previous = { window: globalThis.window, document: globalThis.document, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent }
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
      const realSetTimeout = globalThis.setTimeout
      if (outcome === 'timeout') {
        globalThis.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 15000 ? 5 : ms, ...args)
      }
      let settle
      chrome.__setRuntimeResponder(() => {
        if (outcome === 'channel') throw new Error('connection failed')
        return new Promise(resolve => { settle = resolve })
      })
      const picker = await import('../src/content/picker-mode.js?af23-content=' + Math.random())
      try {
        picker.enterPickMode({ purpose: 'repick', taskId: 'af23-repair', repairSessionId: `session-${outcome}`, repairFieldKey: 'f1', repairMode: 'repair', documentGeneration: 'doc-a', initialTarget: document.querySelector('table') })
        const cell = document.getElementById('metric')
        cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
        cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        const action = outcome === 'cancel' ? '[data-af-cancel]' : '[data-af-done]'
        document.querySelector(action).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await new Promise(resolve => outcome === 'timeout' ? realSetTimeout(resolve, 20) : setImmediate(resolve))
        if (!['timeout', 'channel'].includes(outcome)) {
          assert.ok(document.querySelector('[data-af-overlay]'), 'overlay stays until the persistence ACK')
          assert.match(document.querySelector('[data-af-panel]').textContent, /正在套用|正在確認取消/)
          settle(outcome === 'success' || outcome === 'cancel'
            ? { ok: true, cancelled: outcome === 'cancel' }
            : { ok: false, error: 'stale_field_repair', message: '這次單值重選已失效，請重新開始' })
        }
        await new Promise(resolve => setImmediate(resolve))
        if (outcome === 'success' || outcome === 'cancel') {
          assert.equal(document.querySelector('[data-af-overlay]'), null, 'positive ACK closes the picker')
        } else if (outcome === 'timeout' || outcome === 'channel') {
          assert.ok(document.querySelector('[data-af-overlay]'), 'unknown outcome keeps the page visible')
          assert.match(document.querySelector('[data-af-panel]').textContent, /尚未確認|請勿重送/)
        } else {
          assert.ok(document.querySelector('[data-af-overlay]'), 'a rejected repair keeps the selection recoverable')
          assert.match(document.querySelector('[data-af-panel]').textContent, /請重新開始/)
          assert.equal(document.querySelector('[data-af-done]').getAttribute('aria-disabled'), 'true', 'stale authorization cannot retry forever')
          document.querySelector('[data-af-cancel]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
          await new Promise(resolve => setImmediate(resolve))
          assert.equal(document.querySelector('[data-af-overlay]'), null, 'failed authorization can be exited safely')
        }
      } finally {
        picker.exitPickMode()
        globalThis.window = previous.window
        globalThis.document = previous.document
        globalThis.Event = previous.Event
        globalThis.MouseEvent = previous.MouseEvent
        globalThis.setTimeout = realSetTimeout
        dom.window.close()
        resetChromeMock()
      }
    })
  }
})

test('AC-A2 uncertain repair retries the immutable same payload from the visible control', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<table><tbody><tr><td id="metric">123</td><td id="other">456</td></tr></tbody></table>', { url: 'https://a.test/prices' })
  const previous = { window: globalThis.window, document: globalThis.document, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 15000 ? 3 : ms, ...args)
  const submissions = []
  let resolveSecond
  chrome.__setRuntimeResponder(message => {
    if (message?.type !== 'PICKED' || !message.repairSessionId) return undefined
    submissions.push(structuredClone(message))
    if (submissions.length === 2) return new Promise(resolve => { resolveSecond = resolve })
    return new Promise(() => {})
  })
  const picker = await import('../src/content/picker-mode.js?af23-retry=' + Math.random())
  try {
    picker.enterPickMode({ purpose: 'repick', taskId: 'af23-repair', repairSessionId: 'same-op', repairFieldKey: 'f1', repairMode: 'repair', documentGeneration: 'doc-a', initialTarget: document.querySelector('table') })
    const cell = document.getElementById('metric')
    cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => realSetTimeout(resolve, 20))
    assert.ok(document.querySelector('[data-af-overlay]'))
    assert.equal(document.querySelector('[data-af-done]').textContent, '再次確認同一操作')
    const tabKey = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.querySelector('[data-af-done]').dispatchEvent(tabKey)
    assert.equal(tabKey.defaultPrevented, false, 'keyboard focus can still move to the retry control')
    const panel = document.querySelector('[data-af-panel]')
    const rightBeforeMove = panel.style.right
    document.querySelector('[data-af-panel-move]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.notEqual(panel.style.right, rightBeforeMove, 'panel movement remains available while the operation is pending')
    document.querySelector('[data-af-tool="row"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.querySelector('[data-af-chip-remove]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.getElementById('other').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.equal(document.querySelectorAll('[data-af-chip]').length, 1, 'selection removal and mode changes are blocked while pending')
    const firstPayload = structuredClone(submissions[0])
    document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(submissions.length, 2)
    assert.deepEqual(submissions[1], firstPayload, 'retry reuses the exact operation and selection payload')
    assert.ok(document.querySelector('[data-af-overlay]'), 'the UI stays open until authoritative success ACK')
    resolveSecond({ ok: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(document.querySelector('[data-af-overlay]'), null)
  } finally {
    picker.exitPickMode()
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Event = previous.Event
    globalThis.MouseEvent = previous.MouseEvent
    globalThis.setTimeout = realSetTimeout
    dom.window.close()
    resetChromeMock()
  }
})

test('AC-A2 deterministic repair rejection permits correcting the selection', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<table><tbody><tr><td id="first">123</td><td id="second">456</td></tr></tbody></table>', { url: 'https://a.test/prices' })
  const previous = { window: globalThis.window, document: globalThis.document, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })
  const sent = []
  chrome.__setRuntimeResponder(message => {
    if (message?.type !== 'PICKED' || !message.repairSessionId) return undefined
    sent.push(structuredClone(message))
    return sent.length === 1
      ? { ok: false, error: 'repair_type_mismatch', message: '新選取的資料類型與原本不同' }
      : { ok: true }
  })
  const picker = await import('../src/content/picker-mode.js?af23-repairable=' + Math.random())
  try {
    picker.enterPickMode({ purpose: 'repick', taskId: 'af23-repair', repairSessionId: 'correctable-op', repairFieldKey: 'f1', repairMode: 'repair', documentGeneration: 'doc-a', initialTarget: document.querySelector('table') })
    const first = document.getElementById('first')
    first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(document.querySelector('[data-af-overlay]'))
    assert.notEqual(document.querySelector('[data-af-done]').textContent, '再次確認同一操作')
    const second = document.getElementById('second')
    second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sent.length, 2)
    assert.notDeepEqual(sent[1].picks, sent[0].picks, 'the corrected selection is a fresh payload after a known rejection')
    assert.equal(document.querySelector('[data-af-overlay]'), null)
  } finally {
    picker.exitPickMode()
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.Event = previous.Event
    globalThis.MouseEvent = previous.MouseEvent
    dom.window.close()
    resetChromeMock()
  }
})

test('AC-A5 舊修復拒絕來源/stateActions 衝突；改名與排程保留最新內容', async t => {
  const f = await setup(t)
  const grant = await begin(f)
  const before = await f.storage.getTask('af23-repair')
  await f.storage.updateTasks(['af23-repair'], task => {
    task.name = '新名稱'
    task.schedule.times = ['10:00']
    return task
  })
  const result = await picked(f, grant)
  assert.equal(result.ok, true)
  const after = await f.storage.getTask('af23-repair')
  assert.equal(after.name, '新名稱')
  assert.deepEqual(after.schedule.times, ['10:00'])
  assert.equal(after.spec.fields[0].source.locator.css, '#repaired')
  assert.deepEqual(after.spec.fields[1], before.spec.fields[1])

  const stale = await begin(f)
  await f.storage.updateTasks(['af23-repair'], task => {
    task.spec.fields[0].source.locator.css = '#newer-edit'
    task.fields[0].stateActions = [{ type: 'click', locator: { css: '#changed-state' } }]
    task.spec.fields[0].stateActions = structuredClone(task.fields[0].stateActions)
    return task
  })
  const changed = await f.storage.getTask('af23-repair')
  const rejected = await picked(f, stale)
  assert.equal(rejected.error, 'stale_field_repair')
  assert.deepEqual(await f.storage.getTask('af23-repair'), changed, 'stale submit does not overwrite newer source or actions')
})

test('AC-A6 scalar same-value repair preserves strategy, multiplier, precision and final extracted value', async t => {
  const f = await setup(t)
  await f.storage.updateTasks(['af23-repair'], task => {
    task.fields[0].mode = 'number'
    task.spec.fields[0].mode = 'number'
    task.spec.fields[0].spec = { strategy: 'auto', multiplier: 100, decimals: 2 }
    task.spec.fields[0].source.locator = { css: '#old-scalar' }
    return task
  })
  const grant = await begin(f)
  const before = await f.storage.getTask('af23-repair')
  const incompatible = await picked(f, grant, {
    pickModes: ['text'], picks: [{ locator: { css: '#repaired' } }]
  })
  assert.equal(incompatible.error, 'repair_type_mismatch')
  assert.deepEqual(await f.storage.getTask('af23-repair'), before, 'incompatible data type is rejected without losing the current metric')
  const result = await picked(f, grant, {
    pickModes: ['number'], picks: [{ locator: { css: '#repaired' } }]
  })
  assert.equal(result.ok, true)
  const after = await f.storage.getTask('af23-repair')
  assert.deepEqual(after.spec.fields[0].spec, { strategy: 'auto', multiplier: 100, decimals: 2, mode: 'number' })
  const { extractValue } = await import('../src/shared/extract.js?af23=' + Math.random())
  const dom = new JSDOM('<strong id="v">1.234</strong>')
  assert.equal(extractValue(dom.window.document.getElementById('v'), after.spec.fields[0].spec).value, 123.4)
  dom.window.close()
})

test('AC-A6 cell repair keeps explicit positions and inner path while replacing coordinates', async t => {
  const f = await setup(t)
  await f.storage.updateTasks(['af23-repair'], task => {
    task.spec.fields[0].spec = { cell: {
      row: { index: 0, header: '舊列', pos: 'first' },
      col: { index: 1, header: '舊欄', pos: 'last-1' },
      inner: [{ tag: 'span', index: 1 }]
    } }
    task.fields[0].stateActions = [{ type: 'click', locator: { css: '#expand' } }]
    task.spec.fields[0].stateActions = structuredClone(task.fields[0].stateActions)
    return task
  })
  const grant = await begin(f)
  const result = await picked(f, grant, {
    picks: [{ cell: {
      row: { index: 4, header: '新列' }, col: { index: 2, header: '新欄' }
    } }]
  })
  assert.equal(result.ok, true)
  const after = await f.storage.getTask('af23-repair')
  assert.deepEqual(after.spec.fields[0].spec.cell, {
    row: { index: 4, header: '新列', pos: 'first' },
    col: { index: 2, header: '新欄', pos: 'last-1' },
    inner: [{ tag: 'span', index: 1 }]
  })
  assert.deepEqual(after.fields[0].stateActions, [{ type: 'click', locator: { css: '#expand' } }])
})

test('AC-A3 replace starts with the selected metric parameters instead of inheriting old extraction semantics', async t => {
  const f = await setup(t)
  await f.storage.updateTasks(['af23-repair'], task => {
    task.fields[0].mode = 'number'
    task.spec.fields[0].mode = 'number'
    task.spec.fields[0].spec = { strategy: 'fixed', multiplier: 100, decimals: 2, type: 'currency' }
    return task
  })
  const grant = await begin(f, 'replace')
  const result = await picked(f, grant, {
    pickModes: ['text'],
    picks: [{ block: { axis: 'col', index: 1, aggregate: 'last' } }]
  })
  assert.equal(result.ok, true)
  const after = await f.storage.getTask('af23-repair')
  const replacement = after.spec.fields.find(entry => entry.key === result.newFieldKey)
  assert.ok(replacement)
  assert.deepEqual(Object.keys(replacement.spec), ['block'])
  assert.equal(replacement.spec.block.axis, 'col')
  assert.equal(replacement.spec.block.index, 1)
  assert.equal(replacement.spec.multiplier, undefined)
  assert.equal(replacement.spec.decimals, undefined)
  assert.equal(replacement.spec.type, undefined)
  assert.equal(replacement.mode, 'text')
  assert.equal(after.fields.find(field => field.key === replacement.key).mode, 'text')
})

test('AC-A3 task 寫入前中斷可由已記錄操作恢復；重送不會建立第二個 key', async t => {
  const f = await setup(t)
  const grant = await begin(f, 'replace')
  const before = await f.storage.getTask('af23-repair')
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let failTaskWrite = true
  f.chrome.storage.local.set = async items => {
    if (failTaskWrite && Object.hasOwn(items, 'tasks')) {
      failTaskWrite = false
      throw new Error('injected task write failure')
    }
    return realSet(items)
  }
  const failed = await picked(f, grant)
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'field_repair_pending')
  assert.deepEqual(await f.storage.getTask('af23-repair'), before, 'task 寫入失敗時正式任務未改變')
  const operationId = grant.enter.repairSessionId
  assert.equal((await f.storage.getFieldRepairOperation(operationId)).status, 'prepared')

  const restarted = await import('../src/background/main.js?af23-worker=' + Math.random())
  await restarted.fieldRepairWorkerRecovery
  const recovered = await f.storage.getTask('af23-repair')
  const activeFields = recovered.fields.filter(field => field.key !== 'f2')
  assert.equal(activeFields.length, 1)
  const recoveredKey = activeFields[0].key
  assert.ok(recoveredKey.startsWith('field-'))
  assert.equal((await f.storage.getFieldRepairOperation(operationId)).status, 'complete')

  const replay = await picked(f, grant)
  assert.equal(replay.ok, true)
  assert.equal(replay.newFieldKey, recoveredKey)
  assert.equal((await f.storage.getTask('af23-repair')).fields.filter(field => field.key !== 'f2').length, 1)
})

test('AC-A4 worker entry recovers pending operation on ordinary worker reload', async t => {
  const f = await setup(t)
  const grant = await begin(f, 'replace')
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let failTaskWrite = true
  f.chrome.storage.local.set = async items => {
    if (failTaskWrite && Object.hasOwn(items, 'tasks')) { failTaskWrite = false; throw new Error('task write interrupted') }
    return realSet(items)
  }
  const pending = await picked(f, grant)
  assert.equal(pending.error, 'field_repair_pending')
  f.chrome.storage.local.set = realSet
  const reloaded = await import('../src/background/main.js?af23-ordinary-worker=' + Math.random())
  await reloaded.fieldRepairWorkerRecovery
  const task = await f.storage.getTask('af23-repair')
  assert.equal(task.fields.filter(field => field.key !== 'f2').length, 1)
  assert.equal((await f.storage.getFieldRepairOperation(grant.enter.repairSessionId)).status, 'complete')
  assert.ok(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'FIELD_REPAIR_DONE' &&
    call.args[0].done === true && call.args[0].operationId === grant.enter.repairSessionId),
  'worker recovery broadcasts only the authoritative successful completion')
})

test('AC-A4 cancel cannot report success while submitted repair is waiting on storage', async t => {
  const f = await setup(t)
  const grant = await begin(f, 'replace')
  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  let releaseRead
  let readStarted
  const started = new Promise(resolve => { readStarted = resolve })
  const blocked = new Promise(resolve => { releaseRead = resolve })
  f.chrome.storage.local.get = async keys => {
    if (keys === 'tasks') {
      readStarted()
      await blocked
    }
    return realGet(keys)
  }
  const submission = picked(f, grant)
  await started
  const cancel = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'repick', taskId: 'af23-repair', cancelled: true,
    repairSessionId: grant.enter.repairSessionId, repairFieldKey: 'f1', repairMode: 'replace',
    documentGeneration: grant.enter.documentGeneration
  }, grant.sender)
  assert.equal(cancel.ok, false)
  assert.equal(cancel.error, 'field_repair_submitting')
  releaseRead()
  const result = await submission
  assert.equal(result.ok, true)
  assert.equal((await f.storage.getTask('af23-repair')).fields.filter(field => field.key !== 'f2').length, 1)
})

test('AC-A3 repair preserves the exact iframe source URL in the formal task', async t => {
  const f = await setup(t)
  f.chrome.__setScriptResponder(() => [{ frameId: 1, result: 'https://a.test/prices?token=AF23_SECRET_SENTINEL' }])
  await f.storage.updateTasks(['af23-repair'], task => {
    task.spec.fields[0].source.frame = { url: 'https://a.test/prices?token=AF23_SECRET_SENTINEL' }
    return task
  })
  const grant = await begin(f)
  grant.sender.frameId = 1
  grant.sender.url = 'https://a.test/prices?token=AF23_SECRET_SENTINEL'
  const result = await picked(f, grant)
  assert.equal(result.ok, true)
  const after = await f.storage.getTask('af23-repair')
  assert.equal(after.spec.fields[0].source.frame.url, 'https://a.test/prices?token=AF23_SECRET_SENTINEL')
  assert.equal(result.source.frame.url, 'https://a.test/prices?token=AF23_SECRET_SENTINEL')
})

test('AC-A4 terminal repair result stays immutable and pending replay does not close the source tab', async t => {
  const f = await setup(t)
  const grant = await begin(f, 'replace')
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let failTaskWrite = true
  f.chrome.storage.local.set = async items => {
    if (failTaskWrite && Object.hasOwn(items, 'tasks')) { failTaskWrite = false; throw new Error('task write barrier') }
    return realSet(items)
  }
  const first = await picked(f, grant)
  assert.equal(first.error, 'field_repair_pending')
  const removesBeforeReplay = f.chrome.__calls.filter(call => call.api === 'tabs.remove').length
  const replay = await picked(f, grant)
  assert.equal(replay.ok, true)
  assert.equal(f.chrome.__calls.filter(call => call.api === 'tabs.remove').length, removesBeforeReplay + 1,
    'the tab is removed only after replay commits successfully')

  const operation = await f.storage.getFieldRepairOperation(grant.enter.repairSessionId)
  const terminalAt = operation.updatedAt
  const terminalResult = structuredClone(operation.result)
  const replayAgain = await picked(f, grant)
  assert.deepEqual(replayAgain, terminalResult)
  assert.equal((await f.storage.getFieldRepairOperation(operation.id)).updatedAt, terminalAt,
    'replaying a completed operation does not mutate its receipt')
})

test('AC-A4 terminal failure replay returns the stored result shape, not a receipt object', async t => {
  const f = await setup(t)
  const grant = await begin(f)
  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let changedAfterReceipt = false
  f.chrome.storage.local.set = async items => {
    await realSet(items)
    if (!changedAfterReceipt && Object.hasOwn(items, 'fieldRepairOperations')) {
      changedAfterReceipt = true
      const { tasks } = await realGet('tasks')
      const next = tasks.map(task => task.id !== 'af23-repair' ? task : {
        ...task, spec: { ...task.spec, fields: task.spec.fields.map(entry => entry.key === 'f1'
          ? { ...entry, source: { locator: { css: '#concurrent-edit' } } } : entry) }
      })
      await realSet({ tasks: next })
    }
  }
  const first = await picked(f, grant)
  assert.equal(first.error, 'stale_field_repair')
  const receipt = await f.storage.getFieldRepairOperation(grant.enter.repairSessionId)
  assert.equal(receipt.status, 'complete')
  assert.deepEqual(receipt.result, first)
  const terminalAt = receipt.updatedAt
  const replay = await picked(f, grant)
  assert.deepEqual(replay, first)
  assert.equal((await f.storage.getFieldRepairOperation(receipt.id)).updatedAt, terminalAt)
})

test('AC-A4 pending operation older than the completed TTL remains recoverable', async t => {
  const f = await setup(t)
  const operation = { id: 'old-pending', taskId: 'af23-repair', fieldKey: 'f1', repairMode: 'repair',
    status: 'prepared', createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000 }
  await f.storage.beginFieldRepairOperation(operation)
  assert.equal((await f.storage.getFieldRepairOperation(operation.id)).status, 'prepared')
  assert.equal((await f.storage.listPendingFieldRepairOperations()).some(item => item.id === operation.id), true)
})

test('AC-A4 recovery continues after one operation and its diagnostic write both fail', async t => {
  const f = await setup(t)
  await f.bg.fieldRepairWorkerRecovery
  const task = await f.storage.getTask('af23-repair')
  const stable = value => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    return JSON.stringify(value)
  }
  const makeOperation = (id, fieldKey, source, nextSpec) => {
    const field = task.fields.find(item => item.key === fieldKey)
    const entry = task.spec.fields.find(item => item.key === fieldKey)
    return {
      id, taskId: task.id, fieldKey, repairMode: 'repair', status: 'prepared', createdAt: Date.now(),
      fieldSnapshot: stable({ key: field.key, mode: field.mode, fieldSource: field.source,
        entrySource: entry.source, spec: entry.spec, fieldStateActions: field.stateActions,
        entryStateActions: entry.stateActions }),
      source: { locator: { css: source } }, nextSpec, selectedMode: field.mode,
      cleanup: { layout: false, lastValues: false, alarms: false }
    }
  }
  const first = makeOperation('recovery-first-fails', 'f1', '#first-recovered',
    { block: { axis: 'col', index: 5, headerText: '新現價', aggregate: 'last' } })
  const second = makeOperation('recovery-second-succeeds', 'f2', '#second-recovered',
    { cell: { row: { index: 8 }, col: { index: 3 } } })
  await f.storage.beginFieldRepairOperation(first)
  await f.storage.beginFieldRepairOperation(second)
  assert.deepEqual((await f.storage.listPendingFieldRepairOperations()).map(item => item.id), [first.id, second.id])

  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let failedTaskWrite = false
  let failedReceiptRead = false
  let failedDiagWrite = false
  let rejectDiagWrite = true
  const secretSentinel = 'textarea-token-password-sentinel-7f3a'
  f.chrome.storage.local.set = async items => {
    if (!failedTaskWrite && Object.hasOwn(items, 'tasks')) {
      failedTaskWrite = true
      throw new Error('injected first recovery task write failure')
    }
    if (Object.hasOwn(items, 'diag') && rejectDiagWrite) {
      failedDiagWrite = true
      throw new Error('injected diagnostic write failure')
    }
    return realSet(items)
  }
  f.chrome.storage.local.get = async keys => {
    if (failedTaskWrite && !failedReceiptRead && keys === 'fieldRepairOperations') {
      failedReceiptRead = true
      throw new Error(secretSentinel)
    }
    return realGet(keys)
  }

  assert.equal(await f.bg.recoverFieldRepairOperations(), 2)
  f.chrome.storage.local.get = realGet
  f.chrome.storage.local.set = realSet
  assert.equal(failedReceiptRead, true, 'the first operation reaches the per-item recovery catch')
  assert.equal(failedDiagWrite, true, 'diagnostic storage failure is isolated from the recovery loop')
  assert.equal((await f.storage.getFieldRepairOperation(first.id)).status, 'prepared',
    'failed operation remains pending for a later recovery attempt')
  assert.equal((await f.storage.getFieldRepairOperation(second.id)).status, 'complete',
    'the later operation recovers despite the first operation and diagnostic write failing')
  const recovered = await f.storage.getTask(task.id)
  assert.equal(recovered.spec.fields.find(entry => entry.key === 'f2').source.locator.css, '#second-recovered')

  rejectDiagWrite = false
  failedTaskWrite = false
  failedReceiptRead = false
  f.chrome.storage.local.set = async items => {
    if (!failedTaskWrite && Object.hasOwn(items, 'tasks')) {
      failedTaskWrite = true
      throw new Error('injected retry task write failure')
    }
    if (Object.hasOwn(items, 'diag') && rejectDiagWrite) throw new Error('injected retry diagnostic write failure')
    return realSet(items)
  }
  f.chrome.storage.local.get = async keys => {
    if (failedTaskWrite && !failedReceiptRead && keys === 'fieldRepairOperations') {
      failedReceiptRead = true
      throw new Error(secretSentinel)
    }
    return realGet(keys)
  }
  await f.bg.recoverFieldRepairOperations()
  f.chrome.storage.local.get = realGet
  f.chrome.storage.local.set = realSet
  const diag = await import('../src/shared/diag.js?af23=' + Math.random())
  const recoveryLogs = (await diag.getAll()).filter(entry => entry.kind === 'field_repair_recovery_failed')
  assert.ok(recoveryLogs.length > 0, 'a retry records the sanitized recovery diagnostic')
  assert.ok(!JSON.stringify(recoveryLogs).includes(secretSentinel), 'diagnostics never persist raw exception text')
  assert.equal(recoveryLogs.at(-1).detail.reason, 'operation_recovery_failed')
})

test('AC-A4 task 已替換但版面清理中斷，重啟只補清理且不再換 key', async t => {
  const f = await setup(t)
  const layout = await import('../src/shared/layout-store.js?af23=' + Math.random())
  const dashboard = await layout.addDashboard('測試版面')
  const oldSeries = 'af23-repair#f1'
  await layout.addCard(dashboard.id, { type: 'number', source: [{ taskId: oldSeries }] })
  await f.storage.setLastValues({ [oldSeries]: { value: 12, capturedAt: new Date().toISOString() } })
  const grant = await begin(f, 'replace')
  const operationId = grant.enter.repairSessionId
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let failLayoutWrite = true
  f.chrome.storage.local.set = async items => {
    if (failLayoutWrite && Object.hasOwn(items, 'layout')) {
      failLayoutWrite = false
      throw new Error('injected layout write failure')
    }
    return realSet(items)
  }
  const failed = await picked(f, grant)
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'field_repair_cleanup_pending')
  const committed = await f.storage.getTask('af23-repair')
  const newKey = committed.fields.find(field => field.key !== 'f2').key
  assert.ok(newKey.startsWith('field-'), 'task key was committed before cleanup failed')
  assert.equal((await f.storage.getFieldRepairOperation(operationId)).status, 'cleanup')

  f.chrome.storage.local.set = realSet
  const restarted = await import('../src/background/main.js?af23-worker=' + Math.random())
  assert.equal(await restarted.recoverFieldRepairOperations(), 1)
  assert.equal(await restarted.recoverFieldRepairOperations(), 0, '第二次恢復沒有待處理操作')
  const after = await f.storage.getTask('af23-repair')
  assert.equal(after.fields.filter(field => field.key !== 'f2').length, 1)
  assert.equal(after.fields.find(field => field.key !== 'f2').key, newKey)
  assert.equal((await f.storage.getLastValues())[oldSeries], undefined)
  const currentLayout = await layout.getLayout()
  assert.equal(currentLayout.dashboards.find(item => item.id === dashboard.id).cards.length, 0)
  assert.deepEqual((await f.storage.getFieldRepairOperation(operationId)).cleanup,
    { layout: true, lastValues: true, alarms: true })
})

test('AC-A4 lastValues 清理失敗後會略過已完成版面清理並完成恢復', async t => {
  const f = await setup(t)
  const layout = await import('../src/shared/layout-store.js?af23=' + Math.random())
  const dashboard = await layout.addDashboard('測試版面')
  await layout.addCard(dashboard.id, { type: 'number', source: [{ taskId: 'af23-repair#f1' }] })
  await f.storage.setLastValues({ 'af23-repair#f1': { value: 12 } })
  const grant = await begin(f, 'replace')
  const operationId = grant.enter.repairSessionId
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let fail = true
  f.chrome.storage.local.set = async items => {
    if (fail && Object.hasOwn(items, 'lastValues')) { fail = false; throw new Error('injected lastValues failure') }
    return realSet(items)
  }
  const response = await picked(f, grant)
  assert.equal(response.ok, false)
  assert.equal(response.error, 'field_repair_cleanup_pending')
  const partial = await f.storage.getFieldRepairOperation(operationId)
  assert.equal(partial.cleanup.layout, true)
  assert.equal(partial.cleanup.lastValues, false)
  f.chrome.storage.local.set = realSet
  const restarted = await import('../src/background/main.js?af23-worker=' + Math.random())
  await restarted.recoverFieldRepairOperations()
  await restarted.recoverFieldRepairOperations()
  assert.deepEqual((await f.storage.getFieldRepairOperation(operationId)).cleanup,
    { layout: true, lastValues: true, alarms: true })
  assert.equal((await f.storage.getTask('af23-repair')).fields.filter(field => field.key !== 'f2').length, 1)
})

test('AC-A4 alarm 重建失敗後恢復不重做欄位替換', async t => {
  const f = await setup(t)
  const grant = await begin(f, 'replace')
  const operationId = grant.enter.repairSessionId
  const realCreate = f.chrome.alarms.create.bind(f.chrome.alarms)
  let fail = true
  f.chrome.alarms.create = async (...args) => {
    if (fail) { fail = false; throw new Error('injected alarm failure') }
    return realCreate(...args)
  }
  const response = await picked(f, grant)
  assert.equal(response.ok, false)
  assert.equal(response.error, 'field_repair_cleanup_pending')
  const partial = await f.storage.getFieldRepairOperation(operationId)
  assert.deepEqual(partial.cleanup, { layout: true, lastValues: true, alarms: false })
  const committedKey = (await f.storage.getTask('af23-repair')).fields.find(field => field.key !== 'f2').key
  const restarted = await import('../src/background/main.js?af23-worker=' + Math.random())
  await restarted.recoverFieldRepairOperations()
  await restarted.recoverFieldRepairOperations()
  const after = await f.storage.getTask('af23-repair')
  assert.equal(after.fields.find(field => field.key !== 'f2').key, committedKey)
  assert.equal(after.fields.filter(field => field.key !== 'f2').length, 1)
  assert.equal((await f.storage.getFieldRepairOperation(operationId)).status, 'complete')
})
