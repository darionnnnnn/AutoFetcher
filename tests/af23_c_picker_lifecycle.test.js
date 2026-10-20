process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const pickerHtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const FAST = { pollMs: 1, loadTimeoutMs: 200, checkTimeoutMs: 30, fillTimeoutMs: 30,
  extractTimeoutMs: 200, frameTimeoutMs: 30, messageTimeoutMs: 200, extraDelayMs: 0 }

async function mountPicker(t, search = '') {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.runtime.id = 'af23-picker-test'
  globalThis.navigator = { onLine: true }
  const storage = await import('../src/shared/storage.js?af23-lifecycle=' + Math.random())
  await storage.init()
  const background = await import('../src/background/main.js?af23-lifecycle=' + Math.random())
  const dom = new JSDOM(pickerHtml, { url: `chrome-extension://af23-picker-test/ui/picker/picker.html${search}` })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const picker = await import('../src/ui/picker/picker.js?af23-lifecycle=' + Math.random())
  t.after(() => {
    dom.window.close()
    resetChromeMock()
  })
  return { chrome, storage, background, dom, picker, doc: dom.window.document }
}

function previewTask(id, count = 1) {
  const fields = Array.from({ length: count }, (_, index) => ({
    key: `field-${index + 1}`, name: `值 ${index + 1}`, mode: 'number',
    source: { locator: locator(`#value-${index + 1}`) }, spec: { strategy: 'auto' }
  }))
  return {
    id, name: id, url: 'https://preview.test/page', mode: 'multi', enabled: true,
    fields: fields.map(({ key, name, mode }) => ({ key, name, mode })),
    spec: { mode: 'multi', fields }
  }
}

test('AC-C1:未儲存的欄位 stateActions 從實際 picker 表單進 TEST_TASK 並到 EXTRACT', async t => {
  const f = await mountPicker(t)
  const task = previewTask('unsaved-state-action')
  await f.storage.saveTask(task)
  f.picker.render({ task, url: task.url })
  const messages = []
  f.chrome.__setTabResponder((_tabId, message) => {
    messages.push(structuredClone(message))
    if (message.type === 'RUN_PRE_ACTIONS') return { ok: true }
    if (message.type === 'EXTRACT') return { ok: true, value: 42, raw: '42', status: 'ok', strategyUsed: 'auto', layer: 'css' }
    return { ok: true }
  })
  f.doc.getElementById('preaction-add').click()
  const actionRow = f.doc.querySelector('[data-preaction-row]')
  const type = actionRow.querySelector('.preaction-type')
  type.value = 'click'
  type.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }))
  // 模擬已由頁面選取器回填到表單列的 locator；本測試檢查 unsaved 表單到 TEST_TASK 的 seam。
  actionRow._locator = locator('#expand-tab')
  f.doc.querySelector('[data-field-key="field-1"] [data-source-state-copy]').click()

  const unsavedTask = f.picker.getFormData()
  assert.deepEqual(unsavedTask.fields[0].stateActions.map(action => action.locator?.css), ['#expand-tab'],
    'field state action is read from the live form snapshot')
  assert.deepEqual(task.spec.fields[0].stateActions, undefined, 'the test action was not saved into the formal task')
  const sender = { url: 'chrome-extension://af23-picker-test/ui/picker/picker.html' }
  f.chrome.__setRuntimeResponder(message => f.background.handleMessage(message, sender, FAST))
  await f.picker.handleTestNow()

  const preparation = messages.find(message => message.type === 'RUN_PRE_ACTIONS')
  const extraction = messages.find(message => message.type === 'EXTRACT')
  assert.deepEqual(preparation?.actions, [{ type: 'click', locator: locator('#expand-tab') }],
    'the actual background runner executes the unsaved per-field action')
  assert.equal(extraction?.locator?.css, '#value-1')
  assert.equal(f.doc.getElementById('preview').textContent, '值 1: 42')
  assert.deepEqual((await f.storage.getTask(task.id)).spec.fields[0].stateActions, undefined,
    'preview executes the edit without saving it')
})

test('AC-C6:partial 綁定正確失敗欄位，實際 pending operation 可用同一 session 核對恢復', async t => {
  const f = await mountPicker(t)
  const task = previewTask('partial-repair-reconcile', 2)
  await f.storage.saveTask(task)
  f.picker.render({ task, url: task.url })
  const extracted = []
  f.chrome.__setScriptResponder(() => [{ frameId: 0, result: task.url }])
  f.chrome.__setTabResponder((_tabId, message) => {
    if (message.type === 'EXTRACT') {
      extracted.push(structuredClone(message))
      return message.locator?.css === '#value-1'
        ? { ok: true, value: 42, raw: '42', status: 'ok', strategyUsed: 'auto', layer: 'css' }
        : { ok: false, error: 'not_found', message: '第二值找不到' }
    }
    return { ok: true }
  })
  const sender = { url: 'chrome-extension://af23-picker-test/ui/picker/picker.html' }
  f.chrome.__setRuntimeResponder(message => f.background.handleMessage(message, sender, FAST))
  await f.picker.handleTestNow()

  const rows = [...f.doc.querySelectorAll('#field-list [data-field-row]')]
  assert.equal(rows[0].dataset.fieldKey, 'field-1')
  assert.equal(rows[0].querySelector('[data-field-result]').textContent, '42')
  assert.equal(rows[1].dataset.fieldKey, 'field-2')
  assert.equal(rows[1].querySelector('[data-field-result]').textContent, '—')
  assert.match(rows[1].querySelector('[data-field-result]').title, /第二值找不到/)
  assert.match(f.doc.getElementById('preview').textContent, /成功 1 個、失敗 1 個/)
  assert.deepEqual(extracted.map(message => message.locator.css), ['#value-1', '#value-2'])

  rows[1].querySelector('[data-field-repair]').click()
  await sleep(10)
  const enterCall = f.chrome.__calls.filter(call => call.api === 'tabs.sendMessage')
    .map(call => call.args).reverse().find(([, message]) => message?.type === 'ENTER_PICK')
  assert.ok(enterCall, '失敗值的修復入口實際打開來源選取')
  const [repairTabId, enter] = enterCall
  assert.equal(enter.repairFieldKey, 'field-2', '修復入口精確指向失敗的 field key')

  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let rejectNextTaskWrite = true
  f.chrome.storage.local.set = async items => {
    if (rejectNextTaskWrite && Object.hasOwn(items, 'tasks')) {
      rejectNextTaskWrite = false
      throw new Error('injected uncertain repair commit')
    }
    return realSet(items)
  }
  const picked = await f.background.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: task.id,
    repairSessionId: enter.repairSessionId, repairFieldKey: 'field-2', repairMode: 'repair',
    documentGeneration: enter.documentGeneration,
    locator: locator('#repaired-value-2'), picks: [{ mode: 'number', locator: locator('#repaired-value-2') }],
    pickModes: ['number']
  }, { tab: { id: repairTabId }, frameId: 0, url: task.url })
  f.chrome.storage.local.set = realSet
  assert.equal(picked.error, 'field_repair_pending', '寫入不確定時背景保留可對帳的 operation receipt')
  const row = rows[1]
  const pickerMessageListener = [...f.chrome.runtime.onMessage._listeners].at(-1)
  pickerMessageListener({
    type: 'FIELD_REPAIR_PENDING', state: 'pending', operationId: enter.repairSessionId,
    sessionId: enter.repairSessionId, taskId: task.id, fieldKey: 'field-2', repairMode: 'repair',
    message: '結果尚未確認，請核對同一操作。'
  })
  f.chrome.__emitTabRemoved(repairTabId)
  assert.equal(row._source.locator.css, '#value-2', 'pending receipt 不先套用未核對來源')
  assert.equal(row.querySelector('[data-field-repair]').disabled, true)

  const createsBeforeReconcile = f.chrome.__calls.filter(call => call.api === 'tabs.create').length
  row.querySelector('[data-action="resume-field-repair"]').click()
  await sleep(20)
  assert.equal(f.chrome.__calls.filter(call => call.api === 'tabs.create').length, createsBeforeReconcile,
    '再次確認讀取原 journal，不另開 tab 或建立新 session')
  const operation = await f.storage.getFieldRepairOperation(enter.repairSessionId)
  assert.equal(operation.status, 'complete')
  assert.equal(operation.result.ok, true)
  assert.equal((await f.storage.getTask(task.id)).spec.fields.find(field => field.key === 'field-2').source.locator.css,
    '#repaired-value-2')
  assert.equal(row._source.locator.css, '#repaired-value-2', 'same-operation 回應核對後才更新正確欄位')
  assert.match(row.textContent, /來源已立即儲存/)
})
