process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 30 }

const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })

function multiTask(over = {}) {
  return {
    id: 'r14-exec', name: '執行規格', url: 'https://r14.test/page', mode: 'multi', enabled: true,
    fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }],
    spec: {
      mode: 'multi',
      fields: [
        { key: 'price', mode: 'number', source: { locator: locator('#price') }, spec: { strategy: 'auto' } },
        { key: 'label', mode: 'text', source: { locator: locator('#label') }, spec: { mode: 'text' } }
      ]
    },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ...over
  }
}

function legacyBlockTask(over = {}) {
  return {
    id: 'r14-legacy', name: '舊區塊', url: 'https://r14.test/page', mode: 'block', enabled: true,
    locator: locator('#table'),
    fields: [{ key: 'buy', name: '買入' }, { key: 'sell', name: '賣出' }],
    spec: {
      mode: 'block', strategy: 'auto',
      fields: [
        { key: 'buy', cell: { row: { index: 0 }, col: { index: 1 } } },
        { key: 'sell', cell: { row: { index: 0 }, col: { index: 2 } } }
      ]
    },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ...over
  }
}

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, fe }
}

function framesResponder() {
  return (injection) => Array.isArray(injection?.args)
    ? []
    : [{ frameId: 0, result: 'https://r14.test/page' }]
}

async function runPaused(c, fe, task, slot) {
  let startedResolve
  let releaseResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const release = new Promise(resolve => { releaseResolve = resolve })
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder(async (tabId, msg) => {
    if (msg.type === 'EXTRACT') {
      startedResolve()
      await release
      return msg.locator?.css === '#price'
        ? { ok: true, value: 12, raw: '12', status: 'ok' }
        : { ok: true, value: '標籤', raw: '標籤', status: 'ok' }
    }
    return { ok: true }
  })
  const run = fe.runTask(task, { slot, attempt: 3, ...FAST })
  await started
  return { run, release: () => releaseResolve() }
}

async function assertNoPublishedResult(st, task, slot, result) {
  assert.equal(result.error, 'task_changed')
  assert.equal((await st.getRecordsByDate(slot.slice(0, 10))).length, 0)
  assert.deepEqual(await st.getLastValues(), {})
  assert.equal((await st.getHealthMap())[task.id], undefined)
  assert.deepEqual(await st.getRunState(), {})
}

test('R14：執行中刪除任務，舊 multi 回覆不寫紀錄、lastValues、health 且收尾 runState', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T09:00'
  await st.saveTask(task)
  const { run, release } = await runPaused(c, fe, task, slot)
  await st.deleteTask(task.id)
  release()
  await assertNoPublishedResult(st, task, slot, await run)
})

test('R14：執行中移除 field，舊 multi 回覆不復活已刪序列的狀態', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T09:10'
  await st.saveTask(task)
  const { run, release } = await runPaused(c, fe, task, slot)
  const changed = structuredClone(task)
  changed.fields = [changed.fields[0]]
  changed.spec.fields = [changed.spec.fields[0]]
  await st.saveTask(changed)
  release()
  await assertNoPublishedResult(st, task, slot, await run)
})

test('R14：執行中改來源，舊 multi 回覆不發布成新規格結果', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T09:20'
  await st.saveTask(task)
  const { run, release } = await runPaused(c, fe, task, slot)
  const changed = structuredClone(task)
  changed.spec.fields[0].source.locator.css = '#other-price'
  await st.saveTask(changed)
  release()
  await assertNoPublishedResult(st, task, slot, await run)
})

test('R14：durable A 規格在帳本中斷後改成 B，不把 A 舊紀錄當成 B 恢復', async () => {
  const { c, st, fe } = await fresh()
  const taskA = multiTask()
  const slot = '2026-09-22T09:25'
  await st.saveTask(taskA)
  const first = await runPaused(c, fe, taskA, slot)
  first.release()
  await first.run
  const beforeRecords = await st.getRecordsByDate(slot.slice(0, 10))
  assert.equal(beforeRecords.length, 2)
  assert.equal(typeof beforeRecords[0].executionFingerprint, 'string')
  assert.equal(beforeRecords.every(record => record.executionFingerprint.length === 64), true)
  assert.equal(beforeRecords.every(record => !Object.hasOwn(record, 'executionSnapshot')), true)
  assert.equal(beforeRecords.every(record => JSON.stringify(record).length < 1000), true)
  const beforeLastValues = await st.getLastValues()

  await c.storage.local.remove(`runs:${slot.slice(0, 10)}`)
  const taskB = structuredClone(taskA)
  taskB.spec.fields[0].source.locator.css = '#new-price'
  await st.saveTask(taskB)
  c.__calls.length = 0
  const result = await fe.runTask(taskB, { slot, attempt: 2, ...FAST })
  assert.equal(result.error, 'task_changed')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.deepEqual(await st.getRecordsByDate(slot.slice(0, 10)), beforeRecords)
  assert.deepEqual(await st.getLastValues(), { 'r14-exec#label': beforeLastValues['r14-exec#label'] })
  assert.equal((await st.getHealthMap())[taskB.id], undefined)
})

test('R14：沒有規格摘要的舊 durable multi 只安全拒絕恢復，不猜成目前規格', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T09:27'
  await st.saveTask(task)
  await st.appendRecords(slot.slice(0, 10), [
    { taskId: 'r14-exec#price', slot, commitId: `r14-exec@${slot}`, capturedAt: '2026-09-22T01:27:01.000Z', value: 12, status: 'ok' },
    { taskId: 'r14-exec#label', slot, commitId: `r14-exec@${slot}`, capturedAt: '2026-09-22T01:27:01.000Z', value: '標籤', status: 'ok' }
  ])
  c.__calls.length = 0
  const result = await fe.runTask(task, { slot, attempt: 2, ...FAST })
  assert.equal(result.error, 'task_changed')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.equal((await st.getRecordsByDate(slot.slice(0, 10))).length, 2)
})

test('R14：執行中只改 field 名稱仍沿用原 key／規格並發布結果', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T09:30'
  await st.saveTask(task)
  const { run, release } = await runPaused(c, fe, task, slot)
  const changed = structuredClone(task)
  changed.fields[0].name = '最新價格'
  changed.fields[1].name = '最新標籤'
  await st.saveTask(changed)
  release()
  const result = await run
  assert.equal(result.taskId, 'r14-exec#price')
  const records = await st.getRecordsByDate(slot.slice(0, 10))
  assert.deepEqual(records.map(record => [record.taskId, record.value]), [
    ['r14-exec#price', 12], ['r14-exec#label', '標籤']
  ])
  assert.deepEqual(Object.keys(await st.getLastValues()).sort(), ['r14-exec#label', 'r14-exec#price'])
  assert.equal((await st.getHealthMap())[task.id].status, 'ok')
  assert.deepEqual(await st.getRunState(), {})
})

test('R11：手動 multi 採用 caller executionId，未提供時仍產生本輪 id', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  await st.saveTask(task)
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? (msg.locator?.css === '#price'
      ? { ok: true, value: 12, raw: '12', status: 'ok' }
      : { ok: true, value: '標籤', raw: '標籤', status: 'ok' })
    : { ok: true })

  await fe.runTask(task, { reason: 'manual', executionId: 'caller-execution-17', slot: '2026-09-22T09:35', ...FAST })
  const supplied = await st.getRecordsByDate('2026-09-22')
  assert.deepEqual(supplied.map(record => record.executionId), ['caller-execution-17', 'caller-execution-17'])

  await fe.runTask(task, { reason: 'manual', slot: '2026-09-22T09:36', ...FAST })
  const all = await st.getRecordsByDate('2026-09-22')
  const generated = all.filter(record => record.slot === '2026-09-22T09:36').map(record => record.executionId)
  assert.equal(generated.length, 2)
  assert.equal(typeof generated[0], 'string')
  assert.ok(generated[0].length > 0)
  assert.equal(generated[0], generated[1])
  assert.notEqual(generated[0], 'caller-execution-17')
})

test('R14a legacy：同 slot 重入沿用無 fingerprint 的既有 fields 對帳', async () => {
  const { c, st, fe } = await fresh()
  const task = legacyBlockTask()
  const slot = '2026-09-22T09:40'
  await st.saveTask(task)
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, fields: {
      buy: { ok: true, value: 31.2, raw: '31.2', status: 'ok' },
      sell: { ok: true, value: 31.3, raw: '31.3', status: 'ok' }
    } }
    : { ok: true })
  const first = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  assert.equal(first.taskId, 'r14-legacy#buy')
  await c.storage.local.remove(`runs:${slot.slice(0, 10)}`)
  c.__calls.length = 0
  const second = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  assert.equal(second.taskId, 'r14-legacy#buy')
  assert.equal((await st.getRecordsByDate(slot.slice(0, 10))).length, 2)
})

test('R14a legacy：fields append 已耐久後回錯仍完成對帳，不追加重複紀錄', async () => {
  const { c, st, fe } = await fresh()
  const task = legacyBlockTask()
  const slot = '2026-09-22T09:50'
  await st.saveTask(task)
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, fields: {
      buy: { ok: true, value: 31.2, raw: '31.2', status: 'ok' },
      sell: { ok: true, value: 31.3, raw: '31.3', status: 'ok' }
    } }
    : { ok: true })
  const realSet = c.storage.local.set.bind(c.storage.local)
  let failAfterWrite = true
  c.storage.local.set = async (value) => {
    if (failAfterWrite && value && Object.keys(value).some(key => key.startsWith('rec2:'))) {
      failAfterWrite = false
      await realSet(value)
      throw new Error('legacy record acknowledgement interrupted')
    }
    return realSet(value)
  }
  const result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  c.storage.local.set = realSet
  assert.equal(result.taskId, 'r14-legacy#buy')
  assert.equal((await st.getRecordsByDate(slot.slice(0, 10))).length, 2)
  assert.equal(await st.getRunStatus(task.id, slot), 'ok')
})
