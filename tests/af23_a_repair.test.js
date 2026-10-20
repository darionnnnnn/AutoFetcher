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
