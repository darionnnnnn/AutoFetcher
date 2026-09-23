import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }

const makeTask = () => ({
  id: 'repair-task', name: '多來源', url: 'https://a.test/prices', mode: 'multi', enabled: true,
  fields: [{ key: 'f1', name: '現價' }, { key: 'f2', name: '均價' }],
  spec: { mode: 'multi', strategy: 'auto', fields: [
    { key: 'f1', name: '現價', mode: 'number', source: { locator: { css: '#old-1' } },
      spec: { block: { axis: 'col', index: 2, aggregate: 'sum', skip: { head: 1, blank: true }, exclude: [{ index: 4 }], pos: 'first', inner: [{ tag: 'span', index: 1 }] } } },
    { key: 'f2', name: '均價', mode: 'text', source: { locator: { css: '#old-2' }, frame: { url: 'https://a.test/embed' } },
      spec: { cell: { row: { index: 3 }, col: { index: 1 } } } }
  ] },
  schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  alerts: [{ id: 'alert-f1', field: 'f1', type: 'gt', value: 10, enabled: true },
    { id: 'alert-f2', field: 'f2', type: 'eq', value: 'up', enabled: true }]
})

async function setup(t) {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/prices' }])
  chrome.__setTabResponder((_tabId, message) => message?.type === 'ENTER_PICK' ? { ok: true } : undefined)
  const storage = await import('../src/shared/storage.js?r18=' + Math.random())
  await storage.init()
  await storage.saveTask(makeTask())
  const messages = await import('../src/shared/messages.js?r18=' + Math.random())
  const bg = await import('../src/background/main.js?r18=' + Math.random())
  t.after(() => resetChromeMock())
  return { chrome, storage, messages, bg }
}

async function begin(f, fieldKey = 'f1') {
  const response = await f.bg.handleMessage({
    type: f.messages.MSG.BEGIN_FIELD_REPAIR, taskId: 'repair-task', fieldKey, repairMode: 'repair'
  }, extensionSender)
  assert.equal(response.ok, true)
  const enter = f.chrome.__calls.filter(call => call.api === 'tabs.sendMessage')
    .map(call => call.args[1]).find(message => message?.type === f.messages.MSG.ENTER_PICK)
  assert.ok(enter)
  return { response, enter, sender: { tab: { id: response.tabId, url: 'https://a.test/prices' }, frameId: 0, url: 'https://a.test/prices' } }
}

function picked(f, grant, over = {}) {
  return f.bg.handleMessage({
    type: f.messages.MSG.PICKED, purpose: 'repick', taskId: 'repair-task',
    repairSessionId: grant.enter.repairSessionId,
    repairFieldKey: grant.enter.repairFieldKey,
    repairMode: grant.enter.repairMode,
    documentGeneration: grant.enter.documentGeneration,
    locator: { css: '#repaired' },
    picks: [{ block: { axis: 'col', index: 5, headerText: '現價（修正）' } }],
    ...over
  }, grant.sender)
}

test('R18 same-value repair updates only the authorized field and preserves key/name/alerts/siblings/settings', async t => {
  const f = await setup(t)
  const before = await f.storage.getTask('repair-task')
  const grant = await begin(f)
  assert.equal(grant.enter.repairFieldKey, 'f1')
  assert.equal(grant.enter.taskId, 'repair-task')
  assert.equal(grant.enter.frameId, undefined, 'persisted frame identity stays URL based')
  const result = await picked(f, grant)
  assert.equal(result.ok, true)
  const after = await f.storage.getTask('repair-task')
  assert.deepEqual(after.fields, before.fields)
  assert.deepEqual(after.alerts, before.alerts)
  assert.deepEqual(after.spec.fields[1], before.spec.fields[1], 'sibling is byte-for-byte unchanged')
  assert.deepEqual(after.spec.fields[0].source, { locator: { css: '#repaired' } })
  assert.deepEqual(after.spec.fields[0].spec.block, {
    axis: 'col', index: 5, headerText: '現價（修正）', aggregate: 'sum',
    skip: { head: 1, blank: true }, exclude: [{ index: 4 }], pos: 'first', inner: [{ tag: 'span', index: 1 }]
  })
  const replay = await picked(f, grant)
  assert.equal(replay.error, 'stale_field_repair', 'grant is one-shot')
})

test('R18 cancelled, wrong-tab, wrong-field, and post-worker-restart grants do not mutate a task', async t => {
  const f = await setup(t)
  const original = await f.storage.getTask('repair-task')

  const cancelled = await begin(f)
  const cancel = await picked(f, cancelled, { cancelled: true, picks: [] })
  assert.equal(cancel.cancelled, true)
  assert.deepEqual(await f.storage.getTask('repair-task'), original)

  const wrongTab = await begin(f)
  const rejected = await f.bg.handleMessage({
    type: f.messages.MSG.PICKED, taskId: 'repair-task', repairSessionId: wrongTab.enter.repairSessionId,
    repairFieldKey: 'f2', repairMode: 'repair', documentGeneration: wrongTab.enter.documentGeneration,
    locator: { css: '#attack' }, picks: [{ cell: { row: { index: 0 }, col: { index: 0 } } }]
  }, { ...wrongTab.sender, tab: { id: wrongTab.response.tabId + 100, url: 'https://a.test/prices' } })
  assert.equal(rejected.error, 'stale_field_repair')
  assert.deepEqual(await f.storage.getTask('repair-task'), original)

  const stale = await begin(f)
  const restarted = await import('../src/background/main.js?r18-worker-restart=' + Math.random())
  const replay = await restarted.handleMessage({
    type: f.messages.MSG.PICKED, taskId: 'repair-task', repairSessionId: stale.enter.repairSessionId,
    repairFieldKey: 'f1', repairMode: 'repair', documentGeneration: stale.enter.documentGeneration,
    locator: { css: '#stale' }, picks: [{ block: { axis: 'col', index: 7 } }]
  }, stale.sender)
  assert.equal(replay.error, 'stale_field_repair')
  assert.deepEqual(await f.storage.getTask('repair-task'), original)
})
