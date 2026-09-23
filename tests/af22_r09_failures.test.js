import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100, frameTimeoutMs: 20 }

function multiTask(over = {}) {
  return {
    id: 'r09-multi', name: 'R09 multi failure', url: 'https://r09.test/login', mode: 'multi', enabled: true,
    fields: [{ key: 'first', name: '第一值' }, { key: 'second', name: '第二值' }],
    spec: { mode: 'multi', fields: [
      { key: 'first', mode: 'number', source: { locator: locator('#first') }, spec: { strategy: 'auto' } },
      { key: 'second', mode: 'text', source: { locator: locator('#second') }, spec: { mode: 'text' } }
    ] },
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

test('R09 offline: final scheduled failure leaves one reason-bearing record per declared field', async () => {
  const { c, st, fe } = await fresh()
  globalThis.navigator.onLine = false
  const task = multiTask()
  await st.saveTask(task)
  const day = new Date().toISOString().slice(0, 10)
  const slot = `${day}T09:00`
  const result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  const records = await st.getRecordsByDate(day)
  assert.deepEqual(records.map(r => [r.taskId, r.status, r.error]), [
    ['r09-multi#first', 'error', '目前離線'], ['r09-multi#second', 'error', '目前離線']
  ])
  assert.equal(result.taskId, 'r09-multi#first')
  assert.equal(await st.getRunStatus(task.id, slot), 'error')
  assert.equal(c.__calls.some(call => call.api === 'tabs.create'), false)
})

test('R09 dryRun offline returns every field and writes no formal records or ledger', async () => {
  const { c, st, fe } = await fresh()
  globalThis.navigator.onLine = false
  const task = multiTask()
  await st.saveTask(task)
  const slot = '2026-09-23T09:00'
  const result = await fe.runTask(task, { slot, dryRun: true, ...FAST })
  assert.deepEqual(Object.keys(result.fields), ['first', 'second'])
  assert.ok(Object.values(result.fields).every(field => field.error === 'offline'))
  assert.equal((await st.getRecordsByDate('2026-09-23')).length, 0)
  assert.equal(await st.getRunStatus(task.id, slot), undefined)
  assert.equal(c.__calls.some(call => call.api === 'storage.local.set' && Object.keys(call.args[0] || {}).some(key => key.startsWith('rec2:') || key.startsWith('runs:'))), false)
})

test('R09 disabled login: each declared field records the same explicit authentication failure', async () => {
  const { c, st, fe } = await fresh()
  const crypto = await import('../src/shared/crypto.js?t=' + Math.random())
  await st.saveSite('https://r09.test', {
    loginUrl: 'https://r09.test/login',
    selectors: { user: locator('#user'), pass: locator('#pass'), submit: locator('#submit') },
    loginCheck: { type: 'urlPrefix', value: 'https://r09.test/login' },
    successCheck: { type: 'urlPrefix', value: 'https://r09.test/home' },
    username: 'user', passwordEnc: await crypto.encryptSecret('password'),
    enabled: false, failStreak: 0
  })
  const task = multiTask()
  await st.saveTask(task)
  const day = new Date().toISOString().slice(0, 10)
  const slot = `${day}T09:30`
  await fe.runTask(task, { slot, attempt: 3, ...FAST })
  const records = await st.getRecordsByDate(day)
  assert.deepEqual(records.map(r => [r.taskId, r.status, r.error]), [
    ['r09-multi#first', 'login_failed', '站台自動登入已停用'],
    ['r09-multi#second', 'login_failed', '站台自動登入已停用']
  ])
  assert.equal(await st.getRunStatus(task.id, slot), 'login_failed')
  assert.equal(c.__calls.some(call => call.args?.[1]?.type === 'EXTRACT'), false)
})

test('R09 shared pre-action failure writes one reason-bearing result for every multi field', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask({
    url: 'https://r09.test/page',
    preActions: [{ type: 'click', locator: locator('#open-panel') }]
  })
  await st.saveTask(task)
  c.__setScriptResponder(injection => Array.isArray(injection?.args)
    ? []
    : [{ frameId: 0, result: 'https://r09.test/page' }])
  c.__setTabResponder((tabId, message) => {
    if (message.type === 'RESOLVE_LOCATOR') return { ok: true, found: true }
    if (message.type === 'RUN_PRE_ACTIONS') return { ok: false, error: 'not_found' }
    return { ok: true }
  })
  const day = new Date().toISOString().slice(0, 10)
  const slot = `${day}T09:40`
  await fe.runTask(task, { slot, attempt: 3, ...FAST })
  const records = await st.getRecordsByDate(day)
  assert.equal(records.length, 2)
  assert.deepEqual(records.map(r => r.taskId), ['r09-multi#first', 'r09-multi#second'])
  assert.ok(records.every(r => r.status === 'error' && /前置動作第 1 步/.test(r.error)))
  assert.equal(await st.getRunStatus(task.id, slot), 'error')
})

test('R09 unexpected outer fetch exception still generates a full multi field result set', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask({ url: 'https://r09.test/page' })
  await st.saveTask(task)
  const createTab = c.tabs.create
  c.tabs.create = async () => { throw new Error('fetch worker exploded') }
  const day = new Date().toISOString().slice(0, 10)
  const slot = `${day}T09:50`
  try { await fe.runTask(task, { slot, attempt: 3, ...FAST }) }
  finally { c.tabs.create = createTab }
  const records = await st.getRecordsByDate(day)
  assert.deepEqual(records.map(r => [r.taskId, r.status]), [
    ['r09-multi#first', 'error'], ['r09-multi#second', 'error']
  ])
  assert.ok(records.every(r => /fetch worker exploded/.test(r.error)))
  assert.equal(await st.getRunStatus(task.id, slot), 'error')
})

test('R09 worker timeout recovery writes every multi field interrupted without ledger and leaves slot retryable', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  await st.saveTask(task)
  const day = new Date().toISOString().slice(0, 10)
  const slot = `${day}T09:10`
  await st.updateRunState(() => ({
    [`${task.id}@${slot}`]: {
      state: 'running', at: Date.now() - 11 * 60 * 1000, boot: 'old-worker', attempt: 1, reason: 'scheduled'
    }
  }))
  await fe.recoverRunState(FAST)
  const records = await st.getRecordsByDate(day)
  assert.deepEqual(records.map(r => [r.taskId, r.status, r.error]), [
    ['r09-multi#first', 'interrupted', '上一次執行被瀏覽器中斷'],
    ['r09-multi#second', 'interrupted', '上一次執行被瀏覽器中斷']
  ])
  assert.equal(await st.getRunStatus(task.id, slot), undefined)
  assert.equal((await st.getHealthMap())[task.id].status, 'interrupted')
  assert.deepEqual(await st.getRunState(), {})
  assert.ok((await st.getMissedList()).some(item => item.taskId === task.id && item.slot === slot))

  c.__setScriptResponder(injection => Array.isArray(injection?.args)
    ? []
    : [{ frameId: 0, result: task.url }])
  c.__setTabResponder((tabId, message) => message.type === 'EXTRACT'
    ? { ok: true, value: message.locator?.css === '#first' ? 7 : 'ready', raw: 'ready', status: 'ok' }
    : { ok: true })
  const retry = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  assert.equal(retry.taskId, 'r09-multi#first')
  assert.equal(await st.getRunStatus(task.id, slot), 'ok')
  const afterRetry = await st.getRecordsByDate(day)
  assert.equal(afterRetry.filter(r => r.status === 'interrupted').length, 2)
  assert.equal(afterRetry.filter(r => r.status === 'ok').length, 2)
})

test('R09 worker recovery reconciles a fully durable multi result instead of duplicating it as interrupted', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  await st.saveTask(task)
  const day = new Date().toISOString().slice(0, 10)
  const slot = `${day}T09:15`
  c.__setScriptResponder(injection => Array.isArray(injection?.args)
    ? []
    : [{ frameId: 0, result: task.url }])
  c.__setTabResponder((tabId, message) => message.type === 'EXTRACT'
    ? { ok: true, value: message.locator?.css === '#first' ? 7 : 'ready', raw: 'ready', status: 'ok' }
    : { ok: true })
  await fe.runTask(task, { slot, attempt: 3, ...FAST })
  assert.equal((await st.getRecordsByDate(day)).length, 2)

  // Simulate a worker disappearing after record append/finalization work but before ledger write.
  await c.storage.local.set({ [`runs:${day}`]: { [task.id]: {} } })
  await st.updateRunState(() => ({
    [`${task.id}@${slot}`]: { state: 'running', at: Date.now() - 11 * 60 * 1000, boot: 'old-worker', attempt: 3, reason: 'scheduled' }
  }))
  await fe.recoverRunState(FAST)
  const records = await st.getRecordsByDate(day)
  assert.equal(records.length, 2)
  assert.ok(records.every(r => r.status === 'ok'))
  assert.equal(await st.getRunStatus(task.id, slot), undefined, 'stale run recovery still leaves the ledger empty')
  assert.equal((await st.getHealthMap())[task.id].status, 'ok')
  assert.equal((await st.getMissedList()).some(item => item.taskId === task.id && item.slot === slot), false)
})

test('R09 worker timeout recovery preserves legacy single-value parent row', async () => {
  const { st, fe } = await fresh()
  const task = {
    id: 'r09-legacy', name: 'Legacy', url: 'https://r09.test/login', mode: 'number', enabled: true,
    locator: locator('#value'), spec: { strategy: 'auto' },
    schedule: { type: 'interval', everyMinutes: 10, weekdays: [0, 1, 2, 3, 4, 5, 6] }
  }
  await st.saveTask(task)
  const day = new Date().toISOString().slice(0, 10)
  const slot = `${day}T09:20`
  await st.updateRunState(() => ({
    [`${task.id}@${slot}`]: { state: 'queued', at: Date.now() - 11 * 60 * 1000, boot: 'old-worker', attempt: 1, reason: 'scheduled' }
  }))
  await fe.recoverRunState(FAST)
  const records = await st.getRecordsByDate(day)
  assert.deepEqual(records.map(r => [r.taskId, r.status]), [[task.id, 'interrupted']])
  assert.equal(await st.getRunStatus(task.id, slot), undefined)
})
