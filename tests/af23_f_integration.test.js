process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = {
  pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0,
  extractTimeoutMs: 200, frameTimeoutMs: 30,
  budgetBaseMs: 1000, budgetMaxMs: 1000, attempt: 3
}
const URL = 'https://af23-f2.test/prices?access_token=AF23_QUERY_SENTINEL'
const extensionSender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
const locator = css => ({ css, path: '', anchor: null, xpath: '' })

function makeTask(over = {}) {
  return {
    id: 'af23-f2', name: 'F2 repair race', url: URL, mode: 'multi', enabled: true,
    locator: locator('#table'),
    fields: [
      { key: 'price', name: '價格', mode: 'number', stateActions: [] },
      { key: 'label', name: '標籤', mode: 'text', stateActions: [] }
    ],
    spec: { mode: 'multi', fields: [
      { key: 'price', mode: 'number', source: { locator: locator('#price') },
        spec: { block: { axis: 'col', index: 1, aggregate: 'last', skip: { head: 1 } } } },
      { key: 'label', mode: 'text', source: { locator: locator('#label') },
        spec: { cell: { row: { index: 0 }, col: { index: 1 } } } }
    ] },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    alerts: [{ id: 'price-high', field: 'price', type: 'gt', value: 10, enabled: true }],
    ...over
  }
}

async function setup(t, task = makeTask()) {
  resetChromeMock()
  const chrome = installChromeMock()
  globalThis.navigator = { onLine: true }
  const storage = await import('../src/shared/storage.js?af23-f-integration=' + Math.random())
  await storage.init()
  await storage.saveTask(task)
  const background = await import('../src/background/main.js?af23-f-integration=' + Math.random())
  await background.fieldRepairWorkerRecovery
  const scheduler = await import('../src/background/scheduler.js')
  t.after(() => resetChromeMock())
  return { chrome, storage, background, scheduler, task }
}

function successFrames() {
  return injection => Array.isArray(injection?.args) ? [] : [{ frameId: 0, result: URL }]
}

async function pauseScheduledRun(f, slot) {
  let startedResolve
  let releaseResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const release = new Promise(resolve => { releaseResolve = resolve })
  f.chrome.__setScriptResponder(successFrames())
  f.chrome.__setTabResponder(async (_tabId, message) => {
    if (message.type === 'EXTRACT') {
      startedResolve()
      await release
      return message.locator?.css === '#price'
        ? { ok: true, value: 999, raw: '999', status: 'ok' }
        : { ok: true, value: '新標籤', raw: '新標籤', status: 'ok' }
    }
    return { ok: true }
  })
  const scheduledTime = Date.now()
  const run = f.background.handleAlarm({
    name: `task:${f.task.id}:0`, scheduledTime
  }, FAST)
  await started
  return { run, slot: f.scheduler.slotOf(scheduledTime), release: () => releaseResolve() }
}

async function mutateDuringRun(f, mode) {
  if (mode === 'delete') {
    await f.storage.deleteTask(f.task.id)
    return
  }
  const begin = await f.background.handleMessage({
    type: 'BEGIN_FIELD_REPAIR', taskId: f.task.id, fieldKey: 'price', repairMode: mode
  }, extensionSender)
  assert.equal(begin.ok, true, `begin ${mode} should use the actual field-repair entry`)
  const enter = f.chrome.__calls.filter(call => call.api === 'tabs.sendMessage')
    .map(call => call.args[1]).reverse().find(message => message?.type === 'ENTER_PICK')
  assert.ok(enter, 'background entered the real picker protocol')
  const result = await f.background.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: f.task.id,
    repairSessionId: begin.sessionId, repairFieldKey: 'price', repairMode: mode,
    documentGeneration: enter.documentGeneration,
    locator: locator(mode === 'replace' ? '#replacement' : '#repaired'),
    pickModes: ['number'],
    picks: [{ block: { axis: 'col', index: mode === 'replace' ? 4 : 3, headerText: '價格' } }]
  }, { tab: { id: begin.tabId }, frameId: 0, url: URL })
  assert.equal(result.ok, true, `${mode} operation should have completed before releasing the old run`)
  return result
}

async function seedCommittedHistory(f, slot) {
  const oldSlot = f.scheduler.slotOf(Date.parse(slot.replace('T', ' ') + ':00') - 120000)
  const date = oldSlot.slice(0, 10)
  await f.storage.appendRecords(date, [
    { taskId: `${f.task.id}#price`, slot: oldSlot, capturedAt: '2026-10-20T00:00:00.000Z', value: 7, raw: '7', status: 'ok' },
    { taskId: `${f.task.id}#label`, slot: oldSlot, capturedAt: '2026-10-20T00:00:00.000Z', value: '舊標籤', raw: '舊標籤', status: 'ok' }
  ])
  await f.storage.setRunStatus(f.task.id, oldSlot, 'ok')
  return { date, oldSlot, records: await f.storage.getRecordsByDate(date) }
}

async function seedUnrelatedHistory(f, slot) {
  const task = makeTask({ id: 'af23-unrelated', name: 'unrelated task' })
  await f.storage.saveTask(task)
  const date = slot.slice(0, 10)
  await f.storage.appendRecords(date, [
    { taskId: `${task.id}#price`, slot, capturedAt: '2026-10-20T00:00:00.000Z', value: 42, raw: '42', status: 'ok' }
  ])
  await f.storage.setRunStatus(task.id, slot, 'ok')
  return { task, date, records: (await f.storage.getRecordsByDate(date))
    .filter(record => record.taskId.startsWith(`${task.id}#`)) }
}

for (const mode of ['repair', 'replace', 'delete']) {
  test(`AC-F2 scheduled multi ${mode} during extraction cannot publish stale records, ledger, health, or alerts`, async t => {
    const f = await setup(t)
    const { run, slot, release } = await pauseScheduledRun(f)
    const history = await seedCommittedHistory(f, slot)
    const unrelatedHistory = await seedUnrelatedHistory(f, slot)
    const previousSlot = f.scheduler.slotOf(Date.parse(slot.replace('T', ' ') + ':00') - 120000)
    // Seed an already committed neighboring slot. Its history and parent ledger must survive.
    await mutateDuringRun(f, mode)
    const date = slot.slice(0, 10)
    const afterMutation = {
      records: await f.storage.getRecordsByDate(history.date),
      health: await f.storage.getHealthMap(),
      lastValues: await f.storage.getLastValues(),
      alertLog: await f.storage.getAlertLog(),
      alertCommitLog: await f.storage.getAlertCommitLog(),
      notifications: f.chrome.__calls.filter(call => call.api === 'notifications.create').length
    }
    release()
    await run

    const finalRecords = await f.storage.getRecordsByDate(history.date)
    assert.deepEqual(finalRecords, afterMutation.records, 'in-flight old sources do not append into committed history')
    if (mode !== 'delete') {
      assert.ok(finalRecords.some(record => record.slot === history.oldSlot), 'repair and replacement preserve committed history')
      assert.equal(await f.storage.getRunStatus(f.task.id, previousSlot), 'ok', 'older parent ledger remains intact')
    } else {
      assert.equal(finalRecords.some(record => record.taskId.startsWith(`${f.task.id}#`)), false,
        'explicit deletion keeps its confirmed behavior of deleting that task history')
    }
    assert.deepEqual((await f.storage.getRecordsByDate(unrelatedHistory.date))
      .filter(record => record.taskId.startsWith(`${unrelatedHistory.task.id}#`)), unrelatedHistory.records,
      'deleting one task does not alter another task history')
    assert.equal(await f.storage.getRunStatus(unrelatedHistory.task.id, slot), 'ok',
      'the unrelated task ledger survives deletion')
    assert.equal(await f.storage.getRunStatus(f.task.id, slot), undefined, 'stale execution never writes the scheduled parent ledger')
    assert.deepEqual(await f.storage.getRunState(), {}, 'scheduled execution always releases its run-state marker')
    assert.deepEqual(await f.storage.getHealthMap(), afterMutation.health, 'stale result cannot replace current health')
    assert.deepEqual(await f.storage.getLastValues(), afterMutation.lastValues, 'stale result cannot publish current values')
    assert.deepEqual(await f.storage.getAlertLog(), afterMutation.alertLog, 'stale result cannot claim an alert')
    assert.deepEqual(await f.storage.getAlertCommitLog(), afterMutation.alertCommitLog, 'stale result cannot commit alert identity')
    assert.equal(f.chrome.__calls.filter(call => call.api === 'notifications.create').length, afterMutation.notifications,
      'stale value above the alert threshold emits no notification')
    if (mode === 'replace') {
      const task = await f.storage.getTask(f.task.id)
      assert.ok(task.spec.fields.some(field => field.key !== 'price'), 'the replacement operation really changed the active series key')
      assert.ok((task.archivedFields || []).length >= 1, 'replacement archived the previous field instead of editing it in place')
    }
  })
}

test('AC-F2 precheck alarm still warns and TEST_TASK remains a dry run after repair integrity changes', async t => {
  const f = await setup(t)
  f.chrome.__setScriptResponder(successFrames())
  f.chrome.__setTabResponder((_tabId, message) => message.type === 'EXTRACT'
    ? { ok: false, error: 'not_found', message: 'fixture target missing' }
    : { ok: true })
  const slot = f.scheduler.slotOf(Date.now())
  await f.background.handleAlarm({ name: `${f.task.id}:pre:0` }, FAST)
  assert.equal((await f.storage.getHealthMap())[f.task.id]?.status, 'selector_lost')
  assert.ok(f.chrome.__calls.some(call => call.api === 'notifications.create'), 'precheck failure retains its warning notification')
  assert.equal(await f.storage.getRunStatus(f.task.id, slot), undefined)
  assert.equal((await f.storage.getRecordsByDate(slot.slice(0, 10))).length, 0)

  const before = {
    tasks: await f.storage.getTask(f.task.id),
    health: await f.storage.getHealthMap(),
    lastValues: await f.storage.getLastValues(),
    alerts: await f.storage.getAlertLog(),
    alarms: await f.chrome.alarms.getAll(),
    runs: Object.fromEntries(Object.entries(await f.chrome.storage.local.get(null)).filter(([key]) => key.startsWith('runs:')))
  }
  f.chrome.__setTabResponder((_tabId, message) => message.type === 'EXTRACT'
    ? (message.locator?.css === '#price'
      ? { ok: true, value: 12, raw: '12', status: 'ok' }
      : { ok: true, value: '預覽', raw: '預覽', status: 'ok' })
    : { ok: true })
  const response = await f.background.handleMessage({ type: 'TEST_TASK', task: f.task }, extensionSender, FAST)
  assert.equal(response?.ok, true, 'a successful preview reports success while remaining a dry run')
  assert.deepEqual(await f.storage.getTask(f.task.id), before.tasks)
  assert.deepEqual(await f.storage.getHealthMap(), before.health)
  assert.deepEqual(await f.storage.getLastValues(), before.lastValues)
  assert.deepEqual(await f.storage.getAlertLog(), before.alerts)
  assert.deepEqual(await f.chrome.alarms.getAll(), before.alarms)
  assert.deepEqual(Object.fromEntries(Object.entries(await f.chrome.storage.local.get(null)).filter(([key]) => key.startsWith('runs:'))), before.runs)
})

test('AC-F4 auto fetch diagnostics redact credential, URL token, hidden-page, and exception sentinels', async t => {
  const querySecret = 'AF23_QUERY_SENTINEL'
  const passwordSecret = 'AF23_PASSWORD_SENTINEL'
  const hiddenSecret = 'AF23_HIDDEN_SENTINEL'
  const exceptionSecret = 'AF23_EXCEPTION_SENTINEL'
  const task = makeTask({
    name: `F4 token=${passwordSecret}`,
    url: `https://af23-f2.test/prices?access_token=${querySecret}`,
    spec: { mode: 'multi', fields: [
      { key: 'price', mode: 'number', name: '價格', source: {
        locator: locator('#price'), frame: { url: `https://af23-frame.test/embed?secret=${querySecret}` }
      }, spec: { block: { axis: 'col', index: 1, aggregate: 'last' } } },
      makeTask().spec.fields[1]
    ] }
  })
  const f = await setup(t, task)
  f.chrome.__setScriptResponder(injection => Array.isArray(injection?.args) ? [] : [
    { frameId: 0, result: task.url },
    { frameId: 7, result: `https://af23-frame.test/embed?secret=${querySecret}` }
  ])
  f.chrome.__setTabResponder((_tabId, message) => {
    if (message.type !== 'EXTRACT') return { ok: true }
    return { ok: false, error: 'not_found', message: `${exceptionSecret} password=${passwordSecret}`,
      snippet: hiddenSecret, raw: hiddenSecret }
  })
  await f.background.handleAlarm({ name: `task:${task.id}:0`, scheduledTime: Date.now() }, FAST)
  const diagnostics = await f.storage.getDiagList()
  const serialized = JSON.stringify(diagnostics)
  for (const secret of [querySecret, passwordSecret, hiddenSecret, exceptionSecret]) {
    assert.equal(serialized.includes(secret), false, `automatic diagnostics leaked ${secret}`)
  }
  assert.ok(diagnostics.some(item => item.kind === 'fetch_fields'), 'the failure path did emit the diagnostic being audited')
  assert.equal(f.chrome.__calls.filter(call => /fetch|xhr|webRequest/i.test(call.api)).length, 0,
    'the exercised automatic diagnostic path emits no external request')
})
