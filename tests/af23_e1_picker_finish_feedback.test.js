import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const picker = await import('../src/ui/picker/picker.js?e1=' + Math.random())
  return { chromeMock, picker, doc: dom.window.document }
}

function draft() {
  return {
    sessionId: 'e1-session', revision: 3, tabId: 17,
    documentGeneration: 'e1-document', routeIdentity: { url: 'https://preview.test/page' },
    activeGroupKey: 'e1-group', stage: 'selecting', form: {},
    groups: [{ key: 'e1-group', name: '讀數', values: [
      { key: 'e1-value', name: '即時值', source: { locator: { css: '#price' } }, spec: { strategy: 'auto' } }
    ] }]
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('E1:完成首個畫面同步顯示忙碌、重畫不解鎖，ACK 後保留 canonical 完成協定', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const value = draft()
  const gate = deferred()
  let completes = 0
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type !== 'PICK_DRAFT_COMPLETE') return undefined
    completes += 1
    return gate.promise
  })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  const button = doc.getElementById('group-finish')

  button.click()
  assert.equal(button.disabled, true, 'click handler before its first await disables immediately')
  assert.equal(button.textContent, '正在完成…')
  assert.equal(doc.getElementById('group-draft-status').textContent, '正在同步選取…')

  button.click()
  picker.renderPickDraft(value)
  assert.equal(button.disabled, true, 'render while pending must not re-enable Finish')
  assert.equal(button.textContent, '正在完成…')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(completes, 1, 'duplicate activation sends only one completion request')

  gate.resolve({ ok: true, synchronized: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(button.disabled, false)
  assert.equal(button.textContent, '完成選取')
  assert.match(doc.getElementById('group-draft-status').textContent, /選取已同步/)
  const request = chromeMock.__calls.find(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICK_DRAFT_COMPLETE')
  assert.deepEqual(request.args[0], {
    type: 'PICK_DRAFT_COMPLETE', sessionId: value.sessionId, tabId: value.tabId,
    documentGeneration: value.documentGeneration, routeIdentity: value.routeIdentity,
    expectedRevision: value.revision
  })
})

test('E1:完成拒絕後顯示錯誤並恢復可重試按鈕', async () => {
  const { chromeMock, picker, doc } = await fresh()
  const value = draft()
  let completes = 0
  chromeMock.__setRuntimeResponder(async message => {
    if (message.type !== 'PICK_DRAFT_COMPLETE') return undefined
    completes += 1
    if (completes === 1) throw new Error('暫時無法同步')
    return { ok: true, synchronized: true }
  })
  picker.setPickDraftContext(value)
  picker.renderPickDraft(value)
  const button = doc.getElementById('group-finish')

  button.click()
  assert.equal(button.disabled, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(button.disabled, false)
  assert.equal(button.textContent, '完成選取')
  assert.equal(doc.getElementById('group-draft-status').dataset.state, 'error')
  assert.match(doc.getElementById('group-draft-status').textContent, /暫時無法同步/)

  button.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(completes, 2, '失敗恢復後使用者可再次送出')
  assert.match(doc.getElementById('group-draft-status').textContent, /選取已同步/)
})
