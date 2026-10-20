process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const URL = 'https://af23-contract.test/prices'
const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const FAST = {
  pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0,
  extractTimeoutMs: 200, frameTimeoutMs: 30, reviveDelaysMs: [],
  budgetBaseMs: 1000, budgetMaxMs: 1000, attempt: 3
}

function task() {
  return {
    id: 'af23-contract', name: 'Block repair contract', url: URL, mode: 'multi', enabled: true,
    fields: [{ key: 'price', name: '價格', mode: 'number', stateActions: [] }],
    spec: { mode: 'multi', fields: [{
      key: 'price', name: '價格', mode: 'number', source: { locator: locator('#old-table') },
      spec: { mode: 'block', block: {
        axis: 'col', index: 0, headerText: '舊欄', aggregate: 'sum',
        skip: { head: 1 }, exclude: [{ index: 2 }]
      } }
    }] },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    alerts: [{ id: 'price-alert', field: 'price', type: 'gt', value: 100, enabled: true }]
  }
}

async function fresh(t) {
  resetChromeMock()
  const chrome = installChromeMock()
  globalThis.navigator = { onLine: true }
  chrome.__setScriptResponder(() => [{ frameId: 0, result: URL }])
  chrome.__setTabResponder((_tabId, message) => message?.type === 'ENTER_PICK' ? { ok: true } : { ok: true })
  const storage = await import('../src/shared/storage.js?af23-contract=' + Math.random())
  await storage.init()
  await storage.saveTask(task())
  const messages = await import('../src/shared/messages.js?af23-contract=' + Math.random())
  const background = await import('../src/background/main.js?af23-contract=' + Math.random())
  await background.fieldRepairWorkerRecovery
  const fetcher = await import('../src/background/fetcher.js?af23-contract=' + Math.random())
  t.after(() => resetChromeMock())
  return { chrome, storage, messages, background, fetcher }
}

async function begin(f) {
  const response = await f.background.handleMessage({
    type: f.messages.MSG.BEGIN_FIELD_REPAIR,
    taskId: 'af23-contract', fieldKey: 'price', repairMode: 'repair'
  }, extensionSender)
  assert.equal(response.ok, true)
  const enter = f.chrome.__calls.filter(call => call.api === 'tabs.sendMessage')
    .map(call => call.args[1]).reverse().find(message => message?.type === f.messages.MSG.ENTER_PICK)
  assert.ok(enter)
  return {
    response, enter,
    sender: { tab: { id: response.tabId }, frameId: 0, url: URL }
  }
}

function repairMessage(f, grant, over = {}) {
  return {
    type: f.messages.MSG.PICKED,
    purpose: 'repick', taskId: 'af23-contract',
    repairSessionId: grant.enter.repairSessionId,
    repairFieldKey: 'price', repairMode: 'repair',
    documentGeneration: grant.enter.documentGeneration,
    locator: locator('#table'), pickModes: ['number'],
    picks: [{ block: { axis: 'col', index: 1, headerText: '數量' } }],
    ...over
  }
}

test('AC-A6 block repair preserves extraction semantics and old/new history values', async t => {
  const f = await fresh(t)
  const date = '2026-10-20'
  const oldSlot = `${date}T08:00`
  const newSlot = `${date}T09:00`
  await f.storage.appendRecords(date, [{
    taskId: 'af23-contract#price', slot: oldSlot,
    capturedAt: `${date}T00:00:00.000Z`, value: 5, raw: '5', status: 'ok'
  }])

  const grant = await begin(f)
  const repaired = await f.background.handleMessage(repairMessage(f, grant), grant.sender)
  assert.equal(repaired.ok, true)

  const repairedTask = await f.storage.getTask('af23-contract')
  assert.equal(repairedTask.fields[0].key, 'price', 'same-value repair keeps the field key')
  assert.deepEqual(repairedTask.spec.fields[0].spec.block, {
    axis: 'col', index: 1, headerText: '數量', aggregate: 'sum',
    skip: { head: 1 }, exclude: [{ index: 2 }]
  })

  const previousGlobals = Object.fromEntries(
    ['window', 'document', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']
      .map(key => [key, globalThis[key]])
  )
  const dom = new JSDOM(`<!doctype html><table id="table">
    <thead><tr><th>日期</th><th>數量</th></tr></thead>
    <tbody><tr><td>09-01</td><td>10</td></tr>
      <tr><td>09-02</td><td>32</td></tr><tr><td>09-03</td><td>7</td></tr></tbody>
  </table>`, { url: URL })
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.PointerEvent, KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    __afContentLoaded: false
  })
  try {
    await import('../src/content/main.js?af23-contract-extract=' + Math.random())
    const contentListener = [...f.chrome.runtime.onMessage._listeners].at(-1)
    assert.equal(typeof contentListener, 'function')
    f.chrome.__setTabResponder((tabId, message, options) => {
      if (message?.type === f.messages.MSG.ENTER_PICK) return { ok: true }
      return new Promise(resolve => {
        const handled = contentListener(message, {
          tab: { id: tabId }, frameId: options?.frameId ?? 0, url: URL
        }, resolve)
        if (handled !== true) resolve({ ok: false, error: 'unhandled_content_message', type: message?.type })
      })
    })
    const result = await f.fetcher.runTask(repairedTask, { slot: newSlot, ...FAST })
    assert.equal(result.status, 'ok')
    assert.equal(result.value, 32, JSON.stringify(result))

    const history = await f.storage.getRecordsByDate(date)
    const series = history.filter(record => record.taskId === 'af23-contract#price')
    assert.equal(series.length, 2)
    assert.ok(series.some(record => record.slot === oldSlot && record.value === 5), 'pre-repair history remains addressable')
    assert.ok(series.some(record => record.slot === newSlot && record.value === 32), 'formal fetch records the post-repair extracted value')
  } finally {
    dom.window.close()
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    delete globalThis.__afContentLoaded
  }
})

test('AC-A5 deleting a task after BEGIN rejects the old submit without recreating it', async t => {
  const f = await fresh(t)
  const grant = await begin(f)
  await f.storage.deleteTask('af23-contract')

  const rejected = await f.background.handleMessage(repairMessage(f, grant), grant.sender)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'field_not_found')
  assert.equal(await f.storage.getTask('af23-contract'), null, 'a stale grant cannot recreate a deleted task')
  assert.equal(await f.storage.getFieldRepairOperation(grant.enter.repairSessionId), null,
    'a rejected post-delete submit never creates a durable repair operation')
})

for (const invalidIdentity of ['frame', 'documentGeneration']) {
  test(`AC-A5 ${invalidIdentity} mismatch rejects without writing and leaves the valid grant usable`, async t => {
    const f = await fresh(t)
    const grant = await begin(f)
    const before = await f.storage.getTask('af23-contract')
    const badMessage = repairMessage(f, grant, invalidIdentity === 'documentGeneration'
      ? { documentGeneration: 'different-document' }
      : {})
    const badSender = invalidIdentity === 'frame'
      ? { ...grant.sender, frameId: 2 }
      : grant.sender

    const rejected = await f.background.handleMessage(badMessage, badSender)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error, 'stale_field_repair')
    assert.deepEqual(await f.storage.getTask('af23-contract'), before, 'invalid identity cannot change the task')
    assert.equal(await f.storage.getFieldRepairOperation(grant.enter.repairSessionId), null,
      'invalid identity cannot create a journal receipt')

    const accepted = await f.background.handleMessage(repairMessage(f, grant), grant.sender)
    assert.equal(accepted.ok, true, 'rejection of a forged identity does not consume the legitimate grant')
    assert.equal((await f.storage.getTask('af23-contract')).spec.fields[0].source.locator.css, '#table')
  })
}
