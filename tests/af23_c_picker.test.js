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
  const c = installChromeMock()
  const storage = await import('../src/shared/storage.js?af23-picker=' + Math.random())
  await storage.init()
  const dom = new JSDOM(html, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const picker = await import('../src/ui/picker/picker.js?af23-picker=' + Math.random())
  return { c, picker, doc: dom.window.document }
}

function repairTask(id = 'task-a') {
  const source = { locator: locator('#old') }
  const spec = { mode: 'multi', fields: [{ key: 'field-a', mode: 'number', source, spec: { strategy: 'auto' } }] }
  return {
    id, name: id, url: 'https://preview.test/page', mode: 'multi', enabled: true,
    locator: locator('#table'), spec, fields: [{ key: 'field-a', name: '值 A' }],
    schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }
  }
}

function doneMessage(taskId = 'task-a') {
  return {
    type: 'FIELD_REPAIR_DONE', taskId, fieldKey: 'field-a',
    source: { locator: locator('#new') }, spec: { strategy: 'auto' }
  }
}

test('AC-C2:單值 multi 也可修復；同欄位連點只開一個 session，完成後明示立即儲存', async () => {
  const { c, picker, doc } = await fresh()
  const removedListeners = new Set()
  c.tabs.onRemoved = { addListener: listener => removedListeners.add(listener) }
  picker.render({ task: repairTask(), url: 'https://preview.test/page' })
  const row = doc.querySelector('#field-list [data-field-row]')
  const repair = row.querySelector('[data-field-repair]')
  const replace = row.querySelector('[data-field-replace]')
  assert.equal(repair.hidden, false, '只有一個 field 的 multi 也應提供修復')

  let release
  const gate = new Promise(resolve => { release = resolve })
  let starts = 0
  c.__setRuntimeResponder(async message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    starts += 1
    await gate
    return { ok: true, sessionId: 'repair-session', tabId: 88 }
  })
  repair.click()
  await sleep(5)
  replace.click()
  repair.click()
  assert.equal(starts, 1, '啟動中的同欄位修復與替換都要互斥')
  assert.equal(repair.disabled, true)
  assert.equal(replace.disabled, true)
  release()
  await sleep(5)
  for (const listener of c.runtime.onMessage._listeners) listener(doneMessage())
  assert.equal(row.querySelector('[data-field-repair]').disabled, false)
  assert.match(row.textContent, /來源已立即儲存/)

  repair.click()
  await sleep(5)
  assert.equal(starts, 2, '完成後可以重新開始')
  for (const listener of removedListeners) listener(88)
  assert.equal(row.querySelector('[data-field-repair]').disabled, false, '關閉來源頁後可恢復操作')
})

test('AC-D4:render 100 次只保留一個修復 listener；舊任務訊息不改目前欄位', async () => {
  const { c, picker, doc } = await fresh()
  picker.render({ task: repairTask('task-b'), url: 'https://preview.test/page' })
  const stableListenerCount = c.runtime.onMessage._listeners.size
  for (let i = 1; i < 100; i++) picker.render({ task: repairTask('task-b'), url: 'https://preview.test/page' })
  const listenerCountAfter = c.runtime.onMessage._listeners.size
  assert.equal(listenerCountAfter, stableListenerCount, 'render 只會註冊一次 FIELD_REPAIR_DONE listener')

  const row = doc.querySelector('#field-list [data-field-row]')
  let sourceWrites = 0
  let savedSource = row._source
  Object.defineProperty(row, '_source', {
    configurable: true,
    get: () => savedSource,
    set(value) { sourceWrites += 1; savedSource = value }
  })
  for (const listener of c.runtime.onMessage._listeners) listener(doneMessage('task-a'))
  assert.equal(sourceWrites, 0, '上一個任務的延遲訊息不能修改目前表單')
  for (const listener of c.runtime.onMessage._listeners) listener(doneMessage('task-b'))
  assert.equal(sourceWrites, 1, '一則有效訊息只更新一次欄位來源')
  assert.equal(row._source.locator.css, '#new')
})
