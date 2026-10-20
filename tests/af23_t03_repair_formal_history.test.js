process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const SRC = process.env.AF23_QA_SRC
  ? resolve(process.cwd(), process.env.AF23_QA_SRC)
  : resolve(new URL('../src/', import.meta.url).pathname)
const FIXTURE_URL = 'https://af23-t03.test/prices'
const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const FAST = {
  pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200,
  frameTimeoutMs: 30, reviveDelaysMs: [], budgetBaseMs: 1000, budgetMaxMs: 1000, attempt: 1
}
const load = async (path, tag) => import(`${pathToFileURL(join(SRC, path)).href}?af23-t03=${tag}-${Math.random()}`)

test('T03 scalar 與 canonical cell 修復後走正式抓取，精確寫入同一歷史序列', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  globalThis.navigator = { onLine: true }
  const storage = await load('shared/storage.js', 'storage')
  await storage.init()
  const oldCell = { row: { index: 0, header: '舊列' }, col: { index: 1, header: 'Amount' } }
  const task = {
    id: 'af23-t03-formal', name: '修復正式抓取', url: FIXTURE_URL, mode: 'multi', enabled: true,
    locator: locator('#prices'),
    fields: [
      { key: 'scalar', name: 'Scalar', mode: 'number', stateActions: [] },
      { key: 'text', name: 'Text', mode: 'text', stateActions: [] },
      { key: 'cell', name: 'Cell', mode: 'number', stateActions: [] }
    ],
    spec: { mode: 'multi', fields: [
      { key: 'scalar', mode: 'number', source: { locator: locator('#old-scalar') },
        spec: { strategy: 'auto', multiplier: 100, decimals: 2 } },
      { key: 'text', mode: 'text', source: { locator: locator('#old-text') }, spec: { mode: 'text' } },
      { key: 'cell', mode: 'number', source: { locator: locator('#old-table') }, spec: { cell: oldCell } }
    ] },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  }
  await storage.saveTask(task)
  const background = await load('background/main.js', 'background')
  await background.fieldRepairWorkerRecovery
  const fetcher = await load('background/fetcher.js', 'fetcher')
  const messages = await load('shared/messages.js', 'messages')
  t.after(() => resetChromeMock())

  const day = new Date().toISOString().slice(0, 10)
  const oldSlot = `${day}T08:00`
  const slot = `${day}T09:00`
  await storage.appendRecords(day, [
    { taskId: `${task.id}#scalar`, slot: oldSlot, capturedAt: `${day}T00:00:00.000Z`, value: 4.5, raw: '4.5', status: 'ok' },
    { taskId: `${task.id}#text`, slot: oldSlot, capturedAt: `${day}T00:00:00.000Z`, value: 'old text', raw: 'old text', status: 'ok' },
    { taskId: `${task.id}#cell`, slot: oldSlot, capturedAt: `${day}T00:00:00.000Z`, value: 7.25, raw: '7.25', status: 'ok' }
  ])

  async function repair(fieldKey, selectedLocator, pick, mode) {
    const begin = await background.handleMessage({
      type: messages.MSG.BEGIN_FIELD_REPAIR, taskId: task.id, fieldKey, repairMode: 'repair'
    }, extensionSender)
    assert.equal(begin.ok, true, `${fieldKey} repair opens through BEGIN_FIELD_REPAIR`)
    const enter = chrome.__calls.filter(call => call.api === 'tabs.sendMessage')
      .map(call => call.args[1]).reverse().find(message => message?.type === messages.MSG.ENTER_PICK)
    assert.ok(enter, `${fieldKey} repair enters the real picker protocol`)
    const result = await background.handleMessage({
      type: messages.MSG.PICKED, purpose: 'repick', taskId: task.id,
      repairSessionId: enter.repairSessionId, repairFieldKey: fieldKey, repairMode: 'repair',
      documentGeneration: enter.documentGeneration,
      locator: selectedLocator, pickModes: [mode], picks: [pick]
    }, { tab: { id: begin.tabId }, frameId: 0, url: FIXTURE_URL })
    assert.equal(result.ok, true, `${fieldKey} repair persists its selected source`)
  }

  const scalarSource = locator('#scalar-value')
  await repair('scalar', scalarSource, { locator: scalarSource }, 'number')
  const textSource = locator('#text-value')
  await repair('text', textSource, { locator: textSource }, 'text')
  const cellSource = locator('#prices')
  await repair('cell', cellSource, { cell: { row: { index: 1, header: 'Cell-target' }, col: { index: 1, header: 'Amount' } } }, 'number')

  const repairedTask = await storage.getTask(task.id)
  assert.equal(repairedTask.fields.find(field => field.key === 'scalar').mode, 'number')
  assert.equal(repairedTask.fields.find(field => field.key === 'text').mode, 'text')
  assert.deepEqual(repairedTask.spec.fields.find(field => field.key === 'scalar').spec,
    { strategy: 'auto', multiplier: 100, decimals: 2, mode: 'number' },
    'same-value scalar repair preserves strategy, multiplier and decimal precision')
  assert.equal(repairedTask.fields.find(field => field.key === 'cell').mode, 'number')
  assert.deepEqual(repairedTask.spec.fields.find(field => field.key === 'cell').spec.cell, {
    row: { index: 1, header: 'Cell-target' }, col: { index: 1, header: 'Amount' }
  }, 'the saved cell remains canonical {cell}, without a synthetic mode/block rewrite')

  const previousGlobals = Object.fromEntries(
    ['window', 'document', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']
      .map(key => [key, globalThis[key]])
  )
  const dom = new JSDOM(`<!doctype html><div id="scalar-value">1.234</div><div id="text-value">001</div>
    <table id="prices"><thead><tr><th>Metric</th><th>Amount</th></tr></thead><tbody>
      <tr><th>Other</th><td>111.11</td></tr><tr><th>Cell-target</th><td>29.625</td></tr>
    </tbody></table>`, { url: FIXTURE_URL })
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.PointerEvent, KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    __afContentLoaded: false
  })
  try {
    await load('content/main.js', 'content')
    const contentListener = [...chrome.runtime.onMessage._listeners].at(-1)
    assert.equal(typeof contentListener, 'function', 'formal fetch uses the actual content EXTRACT handler')
    chrome.__setScriptResponder(injection => Array.isArray(injection?.args) ? [] : [{ frameId: 0, result: FIXTURE_URL }])
    chrome.__setTabResponder((tabId, message, options) => {
      if (message?.type === messages.MSG.ENTER_PICK) return { ok: true }
      return new Promise(resolveResult => {
        const handled = contentListener(message, {
          tab: { id: tabId }, frameId: options?.frameId ?? 0, url: FIXTURE_URL
        }, resolveResult)
        if (handled !== true) resolveResult({ ok: false, error: 'unhandled_content_message', type: message?.type })
      })
    })
    const result = await fetcher.runTask(repairedTask, { slot, ...FAST })
    assert.equal(result.status, 'ok', JSON.stringify(result))

    const history = await storage.getRecordsByDate(day)
    const scalarHistory = history.filter(record => record.taskId === `${task.id}#scalar`)
    const textHistory = history.filter(record => record.taskId === `${task.id}#text`)
    const cellHistory = history.filter(record => record.taskId === `${task.id}#cell`)
    assert.equal(scalarHistory.length, 2)
    assert.equal(textHistory.length, 2)
    assert.equal(cellHistory.length, 2)
    assert.ok(scalarHistory.some(record => record.slot === oldSlot && record.value === 4.5))
    assert.ok(scalarHistory.some(record => record.slot === slot && record.value === 123.4 && record.raw === '1.234'),
      'formal scalar extraction preserves multiplier 100 and two-decimal precision')
    assert.ok(textHistory.some(record => record.slot === oldSlot && record.value === 'old text'))
    assert.ok(textHistory.some(record => record.slot === slot && record.value === '001' && record.raw === '001'),
      'same-value text repair preserves the leading zeros in formal history')
    assert.ok(cellHistory.some(record => record.slot === oldSlot && record.value === 7.25))
    assert.ok(cellHistory.some(record => record.slot === slot && record.value === 29.625 && record.raw === '29.625'),
      'formal canonical cell extraction writes the selected table cell, not the whole table text')
  } finally {
    dom.window.close()
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    delete globalThis.__afContentLoaded
  }
})
