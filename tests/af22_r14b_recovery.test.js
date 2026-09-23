process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = css => ({ css, path: '', anchor: null, xpath: '' })
function task(over = {}) {
  return {
    id: 'r14b-recovery', name: 'Recovery', url: 'https://recovery.test/', mode: 'multi', enabled: true,
    fields: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }],
    spec: { mode: 'multi', fields: [
      { key: 'a', mode: 'number', source: { locator: locator('#a') }, spec: { strategy: 'auto' } },
      { key: 'b', mode: 'text', source: { locator: locator('#b') }, spec: { mode: 'text' } }
    ] },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ...over
  }
}
async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  return { c, st }
}
async function seed(st, valueTask) {
  await st.saveTask(valueTask)
  const fingerprint = await (await import('../src/shared/task-source.js')).executionFingerprintOf(valueTask)
  await st.setLastValuesForExecution(valueTask.id, fingerprint, {
    [`${valueTask.id}#a`]: { value: 1, status: 'ok', at: 1 },
    [`${valueTask.id}#b`]: { value: 'old', status: 'ok', at: 1 }
  })
  await st.updateHealthMap(health => ({ ...health, [valueTask.id]: { status: 'ok', at: 1, executionFingerprint: fingerprint } }))
  return fingerprint
}
function changedSource(valueTask) {
  const next = structuredClone(valueTask)
  next.spec.fields[0].source.locator.css = '#new-a'
  return next
}

test('R14b recovery: marker durable before task write; replay keeps state when task mutation did not commit', async () => {
  const { c, st } = await fresh()
  const valueTask = task()
  const oldFp = await seed(st, valueTask)
  const realSet = c.storage.local.set.bind(c.storage.local)
  c.storage.local.set = async values => {
    if (values?.tasks) throw new Error('worker stopped before tasks write')
    return realSet(values)
  }
  await assert.rejects(st.saveTask(changedSource(valueTask)), /worker stopped/)
  c.storage.local.set = realSet
  assert.equal((await c.storage.local.get('executionInvalidations')).executionInvalidations.length, 1)
  await st.replayExecutionInvalidations()
  assert.equal((await st.getTask(valueTask.id)).spec.fields[0].source.locator.css, '#a')
  assert.equal((await st.getLastValues())[`${valueTask.id}#a`].executionFingerprint, oldFp)
  assert.equal((await c.storage.local.get('executionInvalidations')).executionInvalidations.length, 0)
})

test('R14b recovery: task write followed by cleanup interruption is replayed on startup/watchdog', async () => {
  const { c, st } = await fresh()
  const valueTask = task()
  const oldFp = await seed(st, valueTask)
  const realSet = c.storage.local.set.bind(c.storage.local)
  let interrupt = true
  c.storage.local.set = async values => {
    if (interrupt && values?.lastValues) {
      interrupt = false
      throw new Error('worker stopped before cleanup')
    }
    return realSet(values)
  }
  await assert.rejects(st.saveTask(changedSource(valueTask)), /worker stopped/)
  c.storage.local.set = realSet
  assert.equal((await st.getTask(valueTask.id)).spec.fields[0].source.locator.css, '#new-a')
  assert.equal((await c.storage.local.get('executionInvalidations')).executionInvalidations.length, 1)
  await st.replayExecutionInvalidations()
  const values = await st.getLastValues()
  assert.equal(values[`${valueTask.id}#a`], undefined)
  assert.equal(values[`${valueTask.id}#b`].value, 'old')
  assert.equal((await st.getHealthMap())[valueTask.id], undefined)
  assert.equal((await c.storage.local.get('executionInvalidations')).executionInvalidations.length, 0)
  assert.notEqual(oldFp, await (await import('../src/shared/task-source.js')).executionFingerprintOf(changedSource(valueTask)))
})

test('R14b recovery: cleanup success with marker removal interruption replays idempotently', async () => {
  const { c, st } = await fresh()
  const valueTask = task()
  await seed(st, valueTask)
  const realSet = c.storage.local.set.bind(c.storage.local)
  let interrupt = true
  c.storage.local.set = async values => {
    if (interrupt && values?.executionInvalidations?.length === 0) {
      interrupt = false
      throw new Error('worker stopped before marker removal')
    }
    return realSet(values)
  }
  await assert.rejects(st.saveTask(changedSource(valueTask)), /worker stopped/)
  c.storage.local.set = realSet
  assert.equal((await st.getLastValues())[`${valueTask.id}#a`], undefined)
  await st.replayExecutionInvalidations()
  assert.equal((await c.storage.local.get('executionInvalidations')).executionInvalidations.length, 0)
})

test('R14b recovery: a newer execution and unchanged field survive conditional replay; rename makes no marker', async () => {
  const { c, st } = await fresh()
  const valueTask = task()
  const oldFp = await seed(st, valueTask)
  const changed = changedSource(valueTask)
  // Simulate a newer execution written after the mutation, before recovery runs.
  await st.saveTask(changed)
  const newFp = await (await import('../src/shared/task-source.js')).executionFingerprintOf(changed)
  await st.setLastValuesForExecution(valueTask.id, newFp, {
    [`${valueTask.id}#a`]: { value: 2, status: 'ok', at: 2 },
    [`${valueTask.id}#b`]: { value: 'new', status: 'ok', at: 2 }
  })
  await c.storage.local.set({ executionInvalidations: [{ id: 'pending', changes: [{ taskId: valueTask.id, executionFingerprint: oldFp, seriesKeys: ['a'], clearHealth: true }] }] })
  await st.replayExecutionInvalidations()
  const values = await st.getLastValues()
  assert.equal(values[`${valueTask.id}#a`].value, 2)
  assert.equal(values[`${valueTask.id}#b`].value, 'new')

  const renamed = structuredClone(changed)
  renamed.name = 'Renamed'
  await st.saveTask(renamed)
  assert.equal((await c.storage.local.get('executionInvalidations')).executionInvalidations.length, 0)
})

test('R14b recovery: deletion replay removes old fields and health', async () => {
  const { c, st } = await fresh()
  const valueTask = task()
  await seed(st, valueTask)
  const realSet = c.storage.local.set.bind(c.storage.local)
  let interrupt = true
  c.storage.local.set = async values => {
    if (interrupt && values?.lastValues) {
      interrupt = false
      throw new Error('worker stopped during delete cleanup')
    }
    return realSet(values)
  }
  await assert.rejects(st.deleteTask(valueTask.id), /worker stopped/)
  c.storage.local.set = realSet
  assert.equal(await st.getTask(valueTask.id), null)
  await st.replayExecutionInvalidations()
  assert.deepEqual(await st.getLastValues(), {})
  assert.equal((await st.getHealthMap())[valueTask.id], undefined)
})

test('R14b recovery: the 100-marker cap rejects another task mutation before tasks changes', async () => {
  const { c, st } = await fresh()
  const valueTask = task()
  await st.saveTask(valueTask)
  const markers = Array.from({ length: 100 }, (_, index) => ({ id: `pending-${index}`, changes: [] }))
  await c.storage.local.set({ executionInvalidations: markers })
  await assert.rejects(st.saveTask(changedSource(valueTask)), /queue is full/)
  assert.equal((await st.getTask(valueTask.id)).spec.fields[0].source.locator.css, '#a')
})
