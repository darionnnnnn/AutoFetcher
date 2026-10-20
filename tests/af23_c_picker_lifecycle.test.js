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
