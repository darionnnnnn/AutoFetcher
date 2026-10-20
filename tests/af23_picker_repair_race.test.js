import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('FIELD_REPAIR_DONE 與來源分頁 close 同時發生時仍核對並套用成功結果', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const storage = await import('../src/shared/storage.js?repair-race=' + Math.random())
  await storage.init()
  const dom = new JSDOM(html, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const picker = await import('../src/ui/picker/picker.js?repair-race=' + Math.random())
  t.after(() => {
    dom.window.close()
    resetChromeMock()
  })

  const task = {
    id: 'repair-race-task', name: '重選 race', url: 'https://preview.test/page', mode: 'multi', enabled: true,
    fields: [{ key: 'field-a', name: '值 A', mode: 'number' }],
    spec: { mode: 'multi', fields: [{ key: 'field-a', name: '值 A', mode: 'number',
      source: { locator: locator('#old') }, spec: { strategy: 'auto' } }] }
  }
  await storage.saveTask(task)
  picker.render({ task, url: task.url })
  chrome.__setRuntimeResponder(message => message?.type === 'BEGIN_FIELD_REPAIR'
    ? { ok: true, sessionId: 'repair-race-session', tabId: 88 }
    : undefined)
  document.querySelector('[data-field-repair]').click()
  await sleep(5)
  const row = document.querySelector('#field-list [data-field-row]')
  assert.match(row.textContent, /重選頁面已開啟/)

  const updated = await storage.getTask(task.id)
  updated.fields[0].source = { locator: locator('#new') }
  updated.spec.fields[0].source = { locator: locator('#new') }
  await storage.saveTask(updated)
  const realGet = chrome.storage.local.get.bind(chrome.storage.local)
  let entered
  const enteredRead = new Promise(resolve => { entered = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  chrome.storage.local.get = async keys => {
    const result = await realGet(keys)
    if (!held && keys === 'tasks') {
      held = true
      entered()
      await gate
    }
    return result
  }

  const done = {
    type: 'FIELD_REPAIR_DONE', ok: true, done: true,
    operationId: 'repair-race-session', sessionId: 'repair-race-session',
    taskId: task.id, fieldKey: 'field-a', source: { locator: locator('#new') }, spec: { strategy: 'auto' }
  }
  for (const listener of chrome.runtime.onMessage._listeners) listener(done)
  await enteredRead
  chrome.__emitTabRemoved(88)
  release()
  await sleep(20)
  chrome.storage.local.get = realGet

  assert.equal(row._source.locator.css, '#new', 'persisted success is reconciled even if close arrives during getTask')
  assert.match(row.textContent, /來源已立即儲存/)
  assert.equal(row.querySelector('[data-field-repair]').disabled, false)

  chrome.__setRuntimeResponder(message => message?.type === 'BEGIN_FIELD_REPAIR'
    ? { ok: true, sessionId: 'repair-race-session-2', tabId: 89 }
    : undefined)
  row.querySelector('[data-field-repair]').click()
  await sleep(5)
  const updatedAgain = await storage.getTask(task.id)
  updatedAgain.fields[0].source = { locator: locator('#newer') }
  updatedAgain.spec.fields[0].source = { locator: locator('#newer') }
  await storage.saveTask(updatedAgain)
  let enteredSecond
  const enteredSecondRead = new Promise(resolve => { enteredSecond = resolve })
  let releaseSecond
  const secondGate = new Promise(resolve => { releaseSecond = resolve })
  held = false
  chrome.storage.local.get = async keys => {
    const result = await realGet(keys)
    if (!held && keys === 'tasks') {
      held = true
      enteredSecond()
      await secondGate
    }
    return result
  }
  chrome.__emitTabRemoved(89)
  assert.ok(row.querySelector('[data-action="resume-field-repair"]'), 'close before ACK keeps same-operation recovery available')
  const doneAfterClose = { ...done, operationId: 'repair-race-session-2', sessionId: 'repair-race-session-2',
    source: { locator: locator('#newer') } }
  for (const listener of chrome.runtime.onMessage._listeners) listener(doneAfterClose)
  await enteredSecondRead
  releaseSecond()
  await sleep(20)
  chrome.storage.local.get = realGet
  assert.equal(row._source.locator.css, '#newer', 'ACK after tab removal still updates the same active repair session')
  assert.match(row.textContent, /來源已立即儲存/)
})

test('手動關閉未送出的 session 可立刻重啟，舊 ACK 不覆蓋新 session', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const storage = await import('../src/shared/storage.js?repair-close-restart=' + Math.random())
  await storage.init()
  const dom = new JSDOM(html, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const picker = await import('../src/ui/picker/picker.js?repair-close-restart=' + Math.random())
  t.after(() => {
    dom.window.close()
    resetChromeMock()
  })

  const task = {
    id: 'repair-close-restart-task', name: 'close/restart', url: 'https://preview.test/page', mode: 'multi', enabled: true,
    fields: [{ key: 'field-a', name: '值 A', mode: 'number' }],
    spec: { mode: 'multi', fields: [{ key: 'field-a', name: '值 A', mode: 'number',
      source: { locator: locator('#old') }, spec: { strategy: 'auto' } }] }
  }
  await storage.saveTask(task)
  picker.render({ task, url: task.url })
  chrome.__setRuntimeResponder(message => message?.type === 'BEGIN_FIELD_REPAIR'
    ? { ok: true, sessionId: 'old-session', tabId: 101 }
    : undefined)
  const row = document.querySelector('#field-list [data-field-row]')
  row.querySelector('[data-field-repair]').click()
  await sleep(5)
  chrome.__emitTabRemoved(101)
  assert.equal(row.querySelector('[data-field-repair]').disabled, false,
    '未送出的人工關頁要解除 busy，允許直接重新開始')

  let releaseBegin
  const beginGate = new Promise(resolve => { releaseBegin = resolve })
  chrome.__setRuntimeResponder(async message => {
    if (message?.type !== 'BEGIN_FIELD_REPAIR') return undefined
    await beginGate
    return { ok: true, sessionId: 'new-session', tabId: 102 }
  })
  row.querySelector('[data-field-repair]').click()
  await sleep(5)
  const oldDone = {
    type: 'FIELD_REPAIR_DONE', ok: true, done: true,
    operationId: 'old-session', sessionId: 'old-session', taskId: task.id, fieldKey: 'field-a',
    source: { locator: locator('#old-ack') }, spec: { strategy: 'auto' }
  }
  for (const listener of chrome.runtime.onMessage._listeners) listener(oldDone)
  await sleep(5)
  assert.equal(row._source.locator.css, '#old', '新 BEGIN 尚未定案時拒絕舊 session 晚到 ACK')
  releaseBegin()
  await sleep(5)
  for (const listener of chrome.runtime.onMessage._listeners) listener(oldDone)
  await sleep(5)
  assert.equal(row._source.locator.css, '#old', '新 session 已 ACK 後仍拒絕舊 session 完成訊息')
  assert.equal(row.querySelector('[data-field-repair]').disabled, true,
    '新 session 仍保持 busy')

  const newDone = { ...oldDone, operationId: 'new-session', sessionId: 'new-session',
    source: { locator: locator('#new-session-source') } }
  const persisted = await storage.getTask(task.id)
  persisted.fields[0].source = structuredClone(newDone.source)
  persisted.spec.fields[0].source = structuredClone(newDone.source)
  await storage.saveTask(persisted)
  for (const listener of chrome.runtime.onMessage._listeners) listener(newDone)
  await sleep(15)
  assert.equal(row._source.locator.css, '#new-session-source', '目前 session 的 ACK 正常套用')
  assert.match(row.textContent, /來源已立即儲存/)
})
