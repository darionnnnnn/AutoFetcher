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
  return { c, picker, storage, doc: dom.window.document }
}

async function persistRepairResult(storage, taskId, message) {
  const task = await storage.getTask(taskId)
  const field = task.spec.fields.find(item => item.key === message.fieldKey)
  field.source = structuredClone(message.source)
  field.spec = structuredClone(message.spec)
  await storage.saveTask(task)
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
    type: 'FIELD_REPAIR_DONE', ok: true, done: true, operationId: 'repair-session', sessionId: 'repair-session', taskId, fieldKey: 'field-a',
    source: { locator: locator('#new') }, spec: { strategy: 'auto' }
  }
}

test('AC-C2:單值 multi 也可修復；同欄位連點只開一個 session，完成後明示立即儲存', async () => {
  const { c, picker, storage, doc } = await fresh()
  await storage.saveTask(repairTask())
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
  const done = doneMessage()
  await persistRepairResult(storage, 'task-a', done)
  for (const listener of c.runtime.onMessage._listeners) listener(done)
  await sleep(10)
  assert.equal(row.querySelector('[data-field-repair]').disabled, false)
  assert.match(row.textContent, /來源已立即儲存/)

  repair.click()
  await sleep(5)
  assert.equal(starts, 2, '完成後可以重新開始')
  for (const listener of removedListeners) listener(88)
  assert.equal(row.querySelector('[data-field-repair]').disabled, false, '關閉來源頁後可恢復操作')
})

test('AC-D4:render 100 次只保留一個修復 listener；舊任務訊息不改目前欄位', async () => {
  const { c, picker, storage, doc } = await fresh()
  const savedTask = repairTask('task-b')
  savedTask.spec.fields[0].source = { locator: locator('#new') }
  await storage.saveTask(savedTask)
  picker.render({ task: savedTask, fields: [{ key: 'field-a', name: '值 A', source: savedTask.spec.fields[0].source, spec: savedTask.spec.fields[0].spec }], url: 'https://preview.test/page' })
  const stableListenerCount = c.runtime.onMessage._listeners.size
  for (let i = 1; i < 100; i++) picker.render({ task: savedTask, fields: [{ key: 'field-a', name: '值 A', source: savedTask.spec.fields[0].source, spec: savedTask.spec.fields[0].spec }], url: 'https://preview.test/page' })
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
  await sleep(5)
  assert.equal(sourceWrites, 0, '上一個任務的延遲訊息不能修改目前表單')
  for (const listener of c.runtime.onMessage._listeners) listener(doneMessage('task-b'))
  await sleep(5)
  assert.equal(sourceWrites, 1, '一則有效訊息只更新一次欄位來源')
  assert.equal(row._source.locator.css, '#new')
})

test('AC-C3:忙碌狀態隨重畫與切換任務正確解除', async () => {
  const { c, picker, storage, doc } = await fresh()
  await storage.saveTask(repairTask('task-rerender'))
  const removedListeners = new Set()
  c.tabs.onRemoved = { addListener: listener => removedListeners.add(listener) }
  let release
  const gate = new Promise(resolve => { release = resolve })
  c.__setRuntimeResponder(async message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    await gate
    return { ok: true, sessionId: 'repair-session-rerender', tabId: 89 }
  })
  picker.render({ task: repairTask('task-rerender'), url: 'https://preview.test/page' })
  doc.querySelector('#field-list [data-field-repair]').click()
  await sleep(5)
  picker.render({ task: repairTask('task-rerender'), url: 'https://preview.test/page' })
  let button = doc.querySelector('#field-list [data-field-repair]')
  assert.equal(button.disabled, true, '重畫產生的新 row 仍要反映進行中的 session')
  release()
  await sleep(5)
  for (const listener of removedListeners) listener(89)
  button = doc.querySelector('#field-list [data-field-repair]')
  assert.equal(button.disabled, false, '關閉 session 分頁要解除目前 row，而非舊 row')

  let releaseOld
  const oldGate = new Promise(resolve => { releaseOld = resolve })
  c.__setRuntimeResponder(async message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    await oldGate
    return { ok: true, sessionId: 'repair-session-switch', tabId: 90 }
  })
  button.click()
  await sleep(5)
  picker.render({ task: repairTask('task-other'), url: 'https://preview.test/page' })
  const done = { ...doneMessage('task-rerender'), operationId: 'repair-session-switch', sessionId: 'repair-session-switch' }
  await persistRepairResult(storage, 'task-rerender', done)
  for (const listener of c.runtime.onMessage._listeners) listener(done)
  await sleep(10)
  picker.render({ task: repairTask('task-rerender'), url: 'https://preview.test/page' })
  button = doc.querySelector('#field-list [data-field-repair]')
  assert.equal(button.disabled, false, '切換期間收到的舊任務完成事件要清理 session')
  releaseOld()
  await sleep(5)
})

test('AC-C3:BEGIN ACK 前快速關閉來源分頁不留下永久 busy', async () => {
  const { c, picker, doc } = await fresh()
  const removedListeners = new Set()
  c.tabs.onRemoved = { addListener: listener => removedListeners.add(listener) }
  let release
  const gate = new Promise(resolve => { release = resolve })
  c.__setRuntimeResponder(async message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    await gate
    return { ok: true, sessionId: 'repair-session-fast-close', tabId: 91 }
  })
  picker.render({ task: repairTask('task-fast-close'), url: 'https://preview.test/page' })
  doc.querySelector('#field-list [data-field-repair]').click()
  await sleep(5)
  for (const listener of removedListeners) listener(91)
  release()
  await sleep(5)
  assert.equal(doc.querySelector('#field-list [data-field-repair]').disabled, false)
  assert.match(doc.querySelector('[data-field-hint]').textContent, /已關閉.*重新開始/)
})

test('AC-C3:修復啟動失敗顯示原因、恢復按鈕並可重試', async () => {
  const { c, picker, doc } = await fresh()
  let starts = 0
  c.__setRuntimeResponder(message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    starts += 1
    return starts === 1
      ? { ok: false, error: 'tab_create_failed', message: '來源頁開啟失敗' }
      : { ok: true, sessionId: 'repair-retry', tabId: 93 }
  })
  picker.render({ task: repairTask('task-retry'), url: 'https://preview.test/page' })
  let button = doc.querySelector('#field-list [data-field-repair]')
  button.click()
  await sleep(5)
  button = doc.querySelector('#field-list [data-field-repair]')
  assert.equal(button.disabled, false)
  assert.match(doc.querySelector('[data-field-hint]').textContent, /來源頁開啟失敗/)
  button.click()
  await sleep(5)
  assert.equal(starts, 2)
  assert.equal(doc.querySelector('#field-list [data-field-repair]').disabled, true)
})

test('A4/C3:pending 不套用來源，保留忙碌並提供同一操作核對入口；done 僅接受成功 ACK', async () => {
  const { c, picker, doc } = await fresh()
  picker.render({ task: repairTask('task-pending'), url: 'https://preview.test/page' })
  let release
  const gate = new Promise(resolve => { release = resolve })
  c.__setRuntimeResponder(async message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    await gate
    return { ok: true, sessionId: 'repair-op-1', tabId: 92 }
  })
  doc.querySelector('#field-list [data-field-repair]').click()
  await sleep(5)
  release()
  await sleep(5)
  const row = doc.querySelector('#field-list [data-field-row]')
  const before = row._source.locator.css
  for (const listener of c.runtime.onMessage._listeners) listener({
    type: 'FIELD_REPAIR_PENDING', state: 'pending', operationId: 'repair-op-1', sessionId: 'repair-op-1',
    taskId: 'task-pending', fieldKey: 'field-a', repairMode: 'repair', message: '結果尚未確認，請返回來源頁完成同一操作。'
  })
  assert.equal(row._source.locator.css, before, 'pending 不得被當成成功來源套用')
  assert.equal(row.querySelector('[data-field-repair]').disabled, true, 'pending 期間保留同欄位鎖')
  const resume = row.querySelector('[data-action="resume-field-repair"]')
  assert.ok(resume, 'pending 提供可操作的核對入口')
  resume.click()
  await sleep(0)
  assert.deepEqual(c.__calls.find(call => call.api === 'tabs.update').args, [92, { active: true }])
  for (const listener of c.runtime.onMessage._listeners) listener({
    type: 'FIELD_REPAIR_DONE', ok: false, done: false, taskId: 'task-pending', fieldKey: 'field-a',
    source: { locator: locator('#must-not-apply') }, spec: { strategy: 'regex' }
  })
  assert.equal(row._source.locator.css, before, '沒有成功完成旗標時不可套用回傳定位')
  for (const listener of c.runtime.onMessage._listeners) listener({
    type: 'FIELD_REPAIR_PENDING', state: 'failed', operationId: 'repair-op-1', sessionId: 'repair-op-1',
    taskId: 'task-pending', fieldKey: 'field-a', message: '來源重選未套用，請重試。'
  })
  assert.equal(row.querySelector('[data-field-repair]').disabled, false, '明確失敗後恢復重試')
  assert.match(row.textContent, /未套用，請重試/)
})

test('A4/C3:操作進入 journal 後來源分頁關閉仍鎖住欄位，重試只核對同 operation', async () => {
  const { c, picker, doc } = await fresh()
  const removedListeners = new Set()
  c.tabs.onRemoved = { addListener: listener => removedListeners.add(listener) }
  let begins = 0
  c.__setRuntimeResponder(message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    begins += 1
    return begins === 1
      ? { ok: true, sessionId: 'journal-op', tabId: 120 }
      : { ok: false, error: 'field_repair_pending', operationId: 'journal-op', sessionId: 'journal-op', state: 'pending', message: '同一操作仍在核對' }
  })
  picker.render({ task: repairTask('task-journal'), url: 'https://preview.test/page' })
  doc.querySelector('[data-field-repair]').click()
  await sleep(5)
  for (const listener of c.runtime.onMessage._listeners) listener({
    type: 'FIELD_REPAIR_PENDING', state: 'pending', operationId: 'journal-op', sessionId: 'journal-op',
    taskId: 'task-journal', fieldKey: 'field-a', repairMode: 'repair', message: '結果待確認'
  })
  for (const listener of removedListeners) listener(120)
  const row = doc.querySelector('#field-list [data-field-row]')
  assert.equal(row.querySelector('[data-field-repair]').disabled, true, 'pending journal 不能因關頁解除鎖定')
  const reconcile = row.querySelector('[data-action="resume-field-repair"]')
  assert.equal(reconcile.textContent, '再次確認同一操作')
  reconcile.click()
  await sleep(5)
  assert.equal(begins, 2, '重試只呼叫同欄位 BEGIN 核對既有 operation')
  assert.equal(row.querySelector('[data-field-repair]').disabled, true, '核對仍 pending 時保持 busy')
})
