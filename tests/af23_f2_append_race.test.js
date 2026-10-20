process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 30 }

function task() {
  return {
    id: 'af23-f2-race', name: 'F2 append 競態', url: 'https://f2.test/page', mode: 'multi', enabled: true,
    fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }],
    spec: { mode: 'multi', fields: [
      { key: 'price', mode: 'number', source: { locator: { css: '#price' } }, spec: { strategy: 'auto' } },
      { key: 'label', mode: 'text', source: { locator: { css: '#label' } }, spec: { mode: 'text' } }
    ] },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  }
}

async function fresh() {
  resetChromeMock()
  const chrome = installChromeMock()
  globalThis.navigator = { onLine: true }
  const storage = await import('../src/shared/storage.js?f2=' + Math.random())
  await storage.init()
  const fetcher = await import('../src/background/fetcher.js?f2=' + Math.random())
  return { chrome, storage, fetcher }
}

function installExtracts(chrome) {
  chrome.__setScriptResponder(injection => Array.isArray(injection?.args)
    ? [] : [{ frameId: 0, result: 'https://f2.test/page' }])
  chrome.__setTabResponder((_tabId, message) => message?.type === 'EXTRACT'
    ? (message.locator?.css === '#price'
      ? { ok: true, value: 12, raw: '12', status: 'ok' }
      : { ok: true, value: 'Label', raw: 'Label', status: 'ok' })
    : { ok: true })
}

async function waitForTask(chrome, predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate((await chrome.storage.local.get('tasks')).tasks?.[0])) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.fail('task mutation did not become durable')
}

async function sourceChange(f, nextCss = '#new-price') {
  const next = structuredClone(await f.storage.getTask('af23-f2-race'))
  next.spec.fields[0].source.locator.css = nextCss
  return f.storage.saveTask(next)
}

test('AC-F2 source change while append waits for rec2 lock blocks the append and preserves completed history', async t => {
  const f = await fresh()
  const original = task()
  const slot = '2026-10-18T09:00'
  const oldSlot = '2026-10-17T09:00'
  await f.storage.saveTask(original)
  const oldFingerprint = await f.fetcher.executionFingerprintOf(original)
  const controlSlot = '2026-10-18T08:00'
  const controlAppend = await f.storage.appendRecordsForExecution(controlSlot.slice(0, 10), [{
    taskId: `${original.id}#price`, slot: controlSlot, commitId: `${original.id}@${controlSlot}`,
    executionFingerprint: oldFingerprint, capturedAt: '2026-10-18T00:00:00.000Z', value: 11, status: 'ok'
  }], original.id, oldFingerprint)
  assert.equal(controlAppend, true, '最新 fingerprint 對來源未變更的任務允許 append')
  assert.equal((await f.storage.getRecordsByDate(controlSlot.slice(0, 10))).length, 1)
  await f.storage.appendRecords(oldSlot.slice(0, 10), [{ taskId: 'af23-f2-race#price', slot: oldSlot,
    commitId: `af23-f2-race@${oldSlot}`, executionFingerprint: oldFingerprint,
    capturedAt: '2026-10-17T01:00:00.000Z', value: 10, status: 'ok' }])
  await f.storage.setRunStatus(original.id, oldSlot, 'ok')
  await f.storage.updateRunState(state => ({ ...state, [`${original.id}@${slot}`]: { state: 'running', at: Date.now() } }))

  // Hold the target rec2 lock before the conditional appender queues for it.
  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  let releaseRecordRead
  let recordLockHeld
  const held = new Promise(resolve => { releaseRecordRead = resolve })
  const gotRecordLock = new Promise(resolve => { recordLockHeld = resolve })
  f.chrome.storage.local.get = async keys => {
    if (keys === `rec2:${slot.slice(0, 10)}:09`) {
      recordLockHeld()
      await held
    }
    return realGet(keys)
  }
  const blockingWrite = f.storage.appendRecords(slot.slice(0, 10), [{
    taskId: `${original.id}#unrelated`, slot, capturedAt: '2026-10-18T01:00:00.000Z', value: 'holder', status: 'ok'
  }])
  await gotRecordLock
  const candidate = [{ taskId: `${original.id}#price`, slot, commitId: `${original.id}@${slot}`,
    executionFingerprint: oldFingerprint, capturedAt: '2026-10-18T01:00:01.000Z', value: 12, status: 'ok' }]
  const appendResult = f.storage.appendRecordsForExecution(slot.slice(0, 10), candidate,
    original.id, oldFingerprint)
  const mutation = sourceChange(f)
  await waitForTask(f.chrome, current => current?.spec?.fields?.[0]?.source?.locator?.css === '#new-price')
  const changedTask = await f.storage.getTask(original.id)
  assert.notEqual(await f.fetcher.executionFingerprintOf(changedTask), oldFingerprint,
    '來源變更確實讓執行 fingerprint 改變，鎖內拒絕不是錯誤參數造成')
  releaseRecordRead()
  let appended
  try {
    await blockingWrite
    await mutation
    appended = await appendResult
  } finally {
    f.chrome.storage.local.get = realGet
    releaseRecordRead()
  }
  assert.equal(appended, false, '鎖內重讀最新 task 後拒絕舊 execution')
  const records = await f.storage.getRecordsByDate(slot.slice(0, 10))
  assert.deepEqual(records.filter(record => record.taskId === `${original.id}#price` && record.slot === slot), [], '變更後不得留下新的舊規格紀錄')
  const history = await f.storage.getRecordsByDate(oldSlot.slice(0, 10))
  assert.equal(history.length, 1, '已完成的舊 slot 歷史保留')
  assert.equal(history[0].value, 10)
  t.after(() => resetChromeMock())
})

test('AC-F2 source change after rec2 check but before set is replay-cleaned; cleanup can resume twice', async t => {
  const f = await fresh()
  const original = task()
  const slot = '2026-10-18T09:10'
  await f.storage.saveTask(original)
  installExtracts(f.chrome)

  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  const realRemove = f.chrome.storage.local.remove.bind(f.chrome.storage.local)
  let appendSeen = false
  let failedCleanup = false
  let mutation
  f.chrome.storage.local.set = async items => {
    const key = Object.keys(items)[0]
    if (key?.startsWith('rec2:') && !appendSeen) {
      appendSeen = true
      mutation = sourceChange(f)
      await waitForTask(f.chrome, current => current?.spec?.fields?.[0]?.source?.locator?.css === '#new-price')
      // saveTask's invalidation replay is waiting on this rec2 lock. Simulate a
      // worker/storage interruption on the first marker-driven cleanup write.
      return realSet(items)
    }
    return realSet(items)
  }
  f.chrome.storage.local.remove = async keys => {
    const list = Array.isArray(keys) ? keys : [keys]
    if (appendSeen && !failedCleanup && list.some(key => key?.startsWith('rec2:'))) {
      failedCleanup = true
      throw new Error('injected invalidation cleanup interruption')
    }
    return realRemove(keys)
  }
  let result
  try {
    result = await f.fetcher.runTask(original, { slot, attempt: 1, ...FAST })
    await mutation?.catch(() => {})
  } finally {
    f.chrome.storage.local.set = realSet
    f.chrome.storage.local.remove = realRemove
  }
  assert.equal(appendSeen, true, '測試命中 rec2 寫入鎖內的窗口')
  assert.equal(failedCleanup, true, '第一次 marker cleanup 被注入中斷')
  assert.equal(result?.error, 'task_changed')
  const pending = await f.chrome.storage.local.get('executionInvalidations')
  assert.equal(pending.executionInvalidations?.length, 1, '失敗清理的 marker 保留供重播')
  assert.equal((await f.storage.getRecordsByDate(slot.slice(0, 10))).filter(record => record.slot === slot).length > 0, true,
    '先確認 append 已耐久，測試才能證明 replay 有清理對象')

  assert.equal(await f.storage.replayExecutionInvalidations(), undefined)
  const afterFirstReplay = await f.storage.getRecordsByDate(slot.slice(0, 10))
  assert.deepEqual(afterFirstReplay.filter(record => record.slot === slot), [])
  await f.storage.replayExecutionInvalidations()
  assert.deepEqual((await f.storage.getRecordsByDate(slot.slice(0, 10))).filter(record => record.slot === slot), [],
    '第二次重播冪等，不刪其他紀錄')
  assert.deepEqual((await f.chrome.storage.local.get('executionInvalidations')).executionInvalidations, [])
  t.after(() => resetChromeMock())
})

test('AC-F2 deletion while append holds rec2 lock does not leave records for the deleted task', async t => {
  const f = await fresh()
  const original = task()
  const slot = '2026-10-18T09:20'
  await f.storage.saveTask(original)
  installExtracts(f.chrome)

  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let appendSeen = false
  let deletion
  f.chrome.storage.local.set = async items => {
    const key = Object.keys(items)[0]
    if (key?.startsWith('rec2:') && !appendSeen) {
      appendSeen = true
      deletion = f.storage.deleteTask(original.id)
      await waitForTask(f.chrome, current => !current)
    }
    return realSet(items)
  }
  let result
  try {
    result = await f.fetcher.runTask(original, { slot, attempt: 1, ...FAST })
    await deletion
  } finally {
    f.chrome.storage.local.set = realSet
  }
  assert.equal(appendSeen, true)
  assert.equal(result?.error, 'task_changed')
  assert.equal(await f.storage.getTask(original.id), null)
  assert.deepEqual(await f.storage.getRecordsByDate(slot.slice(0, 10)), [], '刪除後 append 不得復活 task 記錄')
  t.after(() => resetChromeMock())
})

test('AC-F2 invalidation cleanup is scoped to scheduled commitId and leaves manual executionId records alone', async t => {
  const f = await fresh()
  const original = task()
  const slot = '2026-10-18T09:30'
  const manualSlot = '2026-10-18T09:31'
  const completedSlot = '2026-10-17T09:30'
  await f.storage.saveTask(original)
  const fingerprint = await f.fetcher.executionFingerprintOf(original)
  await f.storage.appendRecords(slot.slice(0, 10), [{ taskId: `${original.id}#price`, slot,
    commitId: `${original.id}@${slot}`, executionFingerprint: fingerprint, value: 1, status: 'ok' }])
  await f.storage.appendRecords(completedSlot.slice(0, 10), [{ taskId: `${original.id}#price`, slot: completedSlot,
    commitId: `${original.id}@${completedSlot}`, executionFingerprint: fingerprint, value: 3, status: 'ok' }])
  await f.storage.setRunStatus(original.id, completedSlot, 'ok')
  await f.storage.appendRecords(manualSlot.slice(0, 10), [{ taskId: `${original.id}#price`, slot: manualSlot,
    executionId: 'manual-keep-1', executionFingerprint: fingerprint, value: 2, status: 'ok' }])
  await f.chrome.storage.local.set({ executionInvalidations: [{ id: 'f2-marker-manual', changes: [{
    taskId: original.id, executionFingerprint: fingerprint, seriesKeys: ['price'], clearHealth: true,
    pendingCommits: [{ slot, commitId: `${original.id}@${slot}` },
      { slot: completedSlot, commitId: `${original.id}@${completedSlot}` }]
  }] }] })
  const changed = structuredClone(original)
  changed.spec.fields[0].source.locator.css = '#new-price'
  await f.storage.saveTask(changed)
  await f.storage.replayExecutionInvalidations()
  const records = await f.storage.getRecordsByDate(slot.slice(0, 10))
  assert.deepEqual(records.map(record => record.commitId || record.executionId), ['manual-keep-1'],
    '未完成排程commit清除，manual executionId不被誤刪')
  const oldHistory = await f.storage.getRecordsByDate(completedSlot.slice(0, 10))
  assert.equal(oldHistory.length, 1, '已完成slot ledger保護歷史')
  t.after(() => resetChromeMock())
})
