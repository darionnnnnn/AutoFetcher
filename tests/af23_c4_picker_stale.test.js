import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fresh() {
  resetChromeMock()
  const chrome = installChromeMock()
  const storage = await import('../src/shared/storage.js?c4-picker-stale=' + Math.random())
  await storage.init()
  const dom = new JSDOM(html, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const picker = await import('../src/ui/picker/picker.js?c4-picker-stale=' + Math.random())
  return { chrome, storage, picker, dom }
}

function repairTask(id, sourceCss) {
  const source = { locator: locator(sourceCss) }
  const spec = { strategy: 'auto' }
  return {
    id, name: id, url: `https://${id}.test/page`, mode: 'multi', enabled: true,
    fields: [{ key: 'price', name: '價格', mode: 'number' }],
    spec: { mode: 'multi', fields: [{ key: 'price', name: '價格', mode: 'number', source, spec }] },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }
  }
}

test('C4 修復使舊預覽過期時提示目前 task；切到新 task 後舊結果不改提示或 busy', async t => {
  const { chrome, storage, picker, dom } = await fresh()
  t.after(() => { dom.window.close(); resetChromeMock() })
  const taskA = repairTask('c4-a', '#old')
  const taskB = repairTask('c4-b', '#other')
  await storage.saveTask(taskA)
  await storage.saveTask(taskB)
  picker.render({ task: taskA, url: taskA.url })

  let releaseA
  const gateA = new Promise(resolve => { releaseA = resolve })
  chrome.__setRuntimeResponder(async message => {
    if (message?.type === 'TEST_TASK') {
      await gateA
      return { ok: true, value: 'OLD-A', raw: 'OLD-A', status: 'ok' }
    }
    if (message?.type === 'BEGIN_FIELD_REPAIR') return { ok: true, sessionId: 'c4-a-repair', tabId: 88 }
    return undefined
  })
  const previewA = picker.handleTestNow()
  await sleep(5)
  const rowA = document.querySelector('#field-list [data-field-row]')
  rowA.querySelector('[data-field-repair]').click()
  await sleep(5)
  const doneA = {
    type: 'FIELD_REPAIR_DONE', ok: true, done: true,
    operationId: 'c4-a-repair', sessionId: 'c4-a-repair', taskId: taskA.id, fieldKey: 'price',
    source: { locator: locator('#repaired') }, spec: { strategy: 'auto' }
  }
  const persistedA = await storage.getTask(taskA.id)
  persistedA.spec.fields[0].source = structuredClone(doneA.source)
  await storage.saveTask(persistedA)
  for (const listener of chrome.runtime.onMessage._listeners) listener(doneA)
  await sleep(10)
  assert.match(rowA.textContent, /來源已立即儲存/)
  releaseA()
  await previewA
  assert.match(document.getElementById('test-note').textContent, /來源或設定已變更.*請重新試抓確認/,
    'the old preview is rejected with a warning after the repair changes the current source')
  assert.doesNotMatch(document.getElementById('preview').textContent, /OLD-A/)
  assert.equal(document.getElementById('test-now').disabled, false, 'the stale request releases its own busy state')

  let releaseOld
  let releaseNew
  const oldGate = new Promise(resolve => { releaseOld = resolve })
  const newGate = new Promise(resolve => { releaseNew = resolve })
  chrome.__setRuntimeResponder(async message => {
    if (message?.type !== 'TEST_TASK') return undefined
    if (message.task.name === taskA.name) {
      await oldGate
      return { ok: true, fields: { price: { ok: true, value: 'OLD-TASK-A', raw: 'OLD-TASK-A' } } }
    }
    await newGate
    return { ok: true, fields: { price: { ok: true, value: 'NEW-TASK-B', raw: 'NEW-TASK-B' } } }
  })
  picker.render({ task: taskA, url: taskA.url })
  const oldPreview = picker.handleTestNow()
  await sleep(5)
  picker.render({ task: taskB, url: taskB.url })
  assert.equal(document.getElementById('test-now').disabled, false, 'render releases task A busy state for task B')
  const newPreview = picker.handleTestNow()
  document.getElementById('test-note').textContent = '目前任務 B 的提示'
  await sleep(5)
  releaseOld()
  await oldPreview
  assert.equal(document.getElementById('test-note').textContent, '目前任務 B 的提示', 'old task warning cannot pollute task B')
  assert.equal(document.getElementById('test-now').disabled, true, 'old finally cannot release task B busy state')
  assert.doesNotMatch(document.getElementById('preview').textContent, /OLD-TASK-A/)
  releaseNew()
  await newPreview
  assert.match(document.getElementById('preview').textContent, /NEW-TASK-B/)
  assert.equal(document.getElementById('test-now').disabled, false)
})
