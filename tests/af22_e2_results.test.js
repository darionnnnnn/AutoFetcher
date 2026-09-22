process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 30 }

function multiTask(over = {}) {
  return {
    id: 'multi-e2', name: '結果完整性', url: 'https://a.test/page', mode: 'multi', enabled: true,
    fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }],
    spec: {
      mode: 'multi',
      fields: [
        { key: 'price', mode: 'number', source: { locator: locator('#price') }, spec: { strategy: 'auto' } },
        { key: 'label', mode: 'text', source: { locator: locator('#label'), frame: { url: 'https://b.test/embed?secret=should-not-be-diagnostic' } }, spec: { mode: 'text' } }
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
    : [{ frameId: 0, result: 'https://a.test/page' }, { frameId: 7, result: 'https://b.test/embed' }]
}

test('E2a：一值成功、一值缺回覆，按 field key 完整落紀錄且成功值不被覆寫', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'EXTRACT' && msg.locator?.css === '#price') {
      return { ok: true, value: 12, raw: '12', status: 'ok' }
    }
    if (msg.type === 'EXTRACT' && msg.locator?.css === '#label') return undefined
    return { ok: true }
  })
  const task = multiTask()
  await st.saveTask(task)
  const result = await fe.runTask(task, { slot: '2026-09-21T09:00', attempt: 3, ...FAST })
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(result.taskId, 'multi-e2#price')
  assert.deepEqual(records.map(r => [r.taskId, r.status, r.value]), [
    ['multi-e2#price', 'ok', 12], ['multi-e2#label', 'error', undefined]
  ])
  assert.equal(await st.getRunStatus(task.id, '2026-09-21T09:00'), 'ok')
  assert.equal((await st.getHealthMap())[task.id].status, 'partial')
  assert.equal(c.__calls.filter(x => x.api === 'storage.local.set' && Object.keys(x.args[0] || {}).some(k => k.startsWith('rec2:'))).length, 1)
  const diagnostics = await st.getDiagList()
  const fieldDiag = diagnostics.find(item => item.kind === 'fetch_fields')
  assert.match(String(fieldDiag?.detail), /標籤/)
  assert.match(String(fieldDiag?.detail), /https:\/\/b\.test\/embed/)
  assert.doesNotMatch(String(fieldDiag?.detail), /secret=should-not-be-diagnostic/)
})

test('E2a：frame 在前一值完成後消失，既有成功值保留、消失值明確失敗', async () => {
  const { c, st, fe } = await fresh()
  let frameListCalls = 0
  c.__setScriptResponder((injection) => {
    if (Array.isArray(injection?.args)) return []
    frameListCalls++
    return frameListCalls === 1
      ? [{ frameId: 0, result: 'https://a.test/page' }, { frameId: 7, result: 'https://b.test/embed' }]
      : [{ frameId: 0, result: 'https://a.test/page' }]
  })
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'EXTRACT' && msg.locator?.css === '#label') throw new Error('document replaced')
    return msg.type === 'EXTRACT' ? { ok: true, value: 12, raw: '12', status: 'ok' } : { ok: true }
  })
  const task = multiTask()
  await st.saveTask(task)
  await fe.runTask(task, { slot: '2026-09-21T09:30', attempt: 3, ...FAST })
  const records = await st.getRecordsByDate('2026-09-21')
  assert.deepEqual(records.map(r => [r.taskId, r.status, r.value]), [
    ['multi-e2#price', 'ok', 12], ['multi-e2#label', 'frame_not_found', undefined]
  ])
})

test('E2a：全部來源失敗仍按 key 寫完整結果，health／ledger 只更新父任務一次', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: false, error: 'parse_error', raw: msg.locator?.css }
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  const slot = '2026-09-21T09:45'
  const result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(result.status, 'parse_error')
  assert.deepEqual(records.map(r => [r.taskId, r.status]), [
    ['multi-e2#price', 'parse_error'], ['multi-e2#label', 'parse_error']
  ])
  assert.equal((await st.getHealthMap())[task.id].status, 'parse_error')
  assert.equal(await st.getRunStatus(task.id, slot), 'parse_error')
  assert.equal(c.__calls.filter(x => x.api === 'storage.local.set' && Object.keys(x.args[0] || {}).some(k => k.startsWith('rec2:'))).length, 1)
})

test('E2a：共享 deadline 不把先完成的值改成全失敗，尚未處理值仍按 key 補結果', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'EXTRACT' && msg.locator?.css === '#price') {
      return { ok: true, value: 12, raw: '12', status: 'ok' }
    }
    if (msg.type === 'EXTRACT' && msg.locator?.css === '#label') return new Promise(() => {})
    return { ok: true }
  })
  const task = multiTask()
  await st.saveTask(task)
  const result = await fe.runTask(task, {
    slot: '2026-09-21T10:00', attempt: 3,
    budgetBaseMs: 120, budgetMaxMs: 120, extractTimeoutMs: 3000, ...FAST
  })
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(result.taskId, 'multi-e2#price')
  assert.equal(records.length, 2)
  assert.equal(records[0].status, 'ok')
  assert.equal(records[1].status, 'error')
  assert.match(records[1].error, /超過單次抓取時限/)
  assert.equal(await st.getRunStatus(task.id, '2026-09-21T10:00'), 'ok')
  assert.equal((await st.getHealthMap())[task.id].status, 'partial')
})

test('E2a：零宣告值在執行前拒絕，不開擷取分頁、不寫紀錄或帳本', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask({
    fields: [],
    spec: { mode: 'multi', fields: [] }
  })
  const result = await fe.runTask(task, { slot: '2026-09-21T10:30', attempt: 3, ...FAST })
  assert.deepEqual(result, {
    ok: false,
    error: 'invalid_multi',
    message: '多來源任務沒有可執行欄位',
    fields: {}
  })
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.equal((await st.getRecordsByDate('2026-09-21')).length, 0)
  assert.equal(await st.getRunStatus(task.id, '2026-09-21T10:30'), undefined)
})

test('E2a：dryRun 的部分結果只回傳 field 形狀，不寫 records／ledger／lastValues／health', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? (msg.locator?.css === '#price'
      ? { ok: true, value: 12, raw: '12', status: 'ok' }
      : { ok: false, error: 'not_found', message: '標籤不存在' })
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  c.__calls.length = 0
  const preview = await fe.runTask(task, { slot: '2026-09-21T11:00', attempt: 3, dryRun: true, ...FAST })
  assert.deepEqual(Object.keys(preview.fields), ['price', 'label'])
  assert.equal(preview.fields.price.ok, true)
  assert.equal(preview.fields.label.error, 'not_found')
  assert.equal((await st.getRecordsByDate('2026-09-21')).length, 0)
  assert.equal(await st.getRunStatus(task.id, '2026-09-21T11:00'), undefined)
  assert.deepEqual(await st.getLastValues(), {})
  assert.deepEqual(await st.getHealthMap(), {})
  const writes = c.__calls.filter(x => x.api === 'storage.local.set')
  assert.equal(writes.some(x => Object.keys(x.args[0] || {}).some(k => k.startsWith('rec2:') || k.startsWith('runs:') || ['lastValues', 'health'].includes(k))), false)
})

test('E2a：items／blank 只屬預覽明細，不進正式紀錄', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, value: 0, raw: '', status: 'ok', items: [{ index: 0, use: 'blank' }], blank: 1 }
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  await fe.runTask(task, { slot: '2026-09-21T11:30', attempt: 3, ...FAST })
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(records.length, 2)
  for (const record of records) {
    assert.equal(Object.hasOwn(record, 'items'), false)
    assert.equal(Object.hasOwn(record, 'blank'), false)
  }
})

test('E2c：擷取回報 partial 時保留 partial 語意到子紀錄與父任務 health', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, value: msg.locator?.css === '#price' ? 12 : '標籤', raw: msg.locator?.css === '#price' ? '12' : '標籤', status: 'ok', partial: true }
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  const slot = '2026-09-21T11:45'
  const result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  assert.equal(result.taskId, 'multi-e2#price')
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(records.length, 2)
  assert.equal(records.every(record => record.partial === true), true)
  assert.equal(await st.getRunStatus(task.id, slot), 'ok')
  assert.equal((await st.getHealthMap())[task.id].status, 'partial')
})

test('E2c：append 已寫入但帳本第一次失敗時，補帳本不重複追加 field 紀錄', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, value: msg.locator?.css === '#price' ? 12 : '標籤', raw: msg.locator?.css === '#price' ? '12' : '標籤', status: 'ok' }
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  const realSet = c.storage.local.set.bind(c.storage.local)
  let failLedgerOnce = true
  c.storage.local.set = async (value) => {
    if (failLedgerOnce && value && Object.keys(value).some(key => key.startsWith('runs:'))) {
      failLedgerOnce = false
      throw new Error('ledger write interrupted')
    }
    return realSet(value)
  }
  const slot = '2026-09-21T12:00'
  const result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  c.storage.local.set = realSet
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(result.taskId, 'multi-e2#price')
  assert.equal(records.length, 2)
  assert.equal(new Set(records.map(record => record.taskId + '@' + record.slot)).size, 2)
  assert.equal(await st.getRunStatus(task.id, slot), 'ok')
  assert.deepEqual(Object.keys(await st.getLastValues()).sort(), ['multi-e2#label', 'multi-e2#price'])
})

test('E2c：append 回報失敗但資料已耐久時，確認提交後不走全失敗追加', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, value: msg.locator?.css === '#price' ? 12 : '標籤', raw: msg.locator?.css === '#price' ? '12' : '標籤', status: 'ok' }
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  const realSet = c.storage.local.set.bind(c.storage.local)
  let failAfterWriteOnce = true
  c.storage.local.set = async (value) => {
    if (failAfterWriteOnce && value && Object.keys(value).some(key => key.startsWith('rec2:'))) {
      failAfterWriteOnce = false
      await realSet(value)
      throw new Error('record acknowledgement interrupted')
    }
    return realSet(value)
  }
  const slot = '2026-09-21T12:15'
  const result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  c.storage.local.set = realSet
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(result.taskId, 'multi-e2#price')
  assert.equal(records.length, 2)
  assert.equal(await st.getRunStatus(task.id, slot), 'ok')
})

test('E2c：提交重入只對尚未存在的 field 評估告警，不重複發送通知', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, value: msg.locator?.css === '#price' ? 12 : '標籤', raw: msg.locator?.css === '#price' ? '12' : '標籤', status: 'ok' }
    : { ok: true })
  const task = multiTask({ alerts: [{ id: 'price-high', field: 'price', type: 'gt', value: 10, enabled: true }] })
  await st.saveTask(task)
  const realSet = c.storage.local.set.bind(c.storage.local)
  let failLedgerOnce = true
  c.storage.local.set = async (value) => {
    if (failLedgerOnce && value && Object.keys(value).some(key => key.startsWith('runs:'))) {
      failLedgerOnce = false
      throw new Error('ledger write interrupted')
    }
    return realSet(value)
  }
  const result = await fe.runTask(task, { slot: '2026-09-21T12:45', attempt: 3, ...FAST })
  c.storage.local.set = realSet
  assert.equal(result.taskId, 'multi-e2#price')
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 1)
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(records.filter(record => record.alert === true).length, 1)
})

test('E2c：已有完整 field 結果但帳本尚未完成時，下一輪直接對帳，不重開頁面或重跑前置動作', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  await st.saveTask(task)
  const slot = '2026-09-21T12:30'
  await st.appendRecords('2026-09-21', [
    { taskId: 'multi-e2#price', slot, commitId: `multi-e2@${slot}`, capturedAt: '2026-09-21T12:30:01.000Z', value: 12, raw: '12', status: 'ok' },
    { taskId: 'multi-e2#label', slot, commitId: `multi-e2@${slot}`, capturedAt: '2026-09-21T12:30:01.000Z', value: '標籤', raw: '標籤', status: 'ok' }
  ])
  c.__calls.length = 0
  const result = await fe.runTask(task, { slot, attempt: 2, ...FAST })
  assert.equal(result.taskId, 'multi-e2#price')
  assert.equal((await st.getRecordsByDate('2026-09-21')).length, 2)
  assert.equal(await st.getRunStatus(task.id, slot), 'ok')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.sendMessage').length, 0)
})

test('E2c：舊執行先寫帳本但 lastValues／health 未完成時，下一輪仍補完狀態', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  await st.saveTask(task)
  const slot = '2026-09-21T12:40'
  await st.appendRecords('2026-09-21', [
    { taskId: 'multi-e2#price', slot, commitId: `multi-e2@${slot}`, capturedAt: '2026-09-21T12:40:01.000Z', value: 12, raw: '12', status: 'ok' },
    { taskId: 'multi-e2#label', slot, commitId: `multi-e2@${slot}`, capturedAt: '2026-09-21T12:40:01.000Z', value: '標籤', raw: '標籤', status: 'ok' }
  ])
  await st.setRunStatus(task.id, slot, 'ok')
  c.__calls.length = 0
  const result = await fe.runTask(task, { slot, attempt: 2, ...FAST })
  assert.equal(result.taskId, 'multi-e2#price')
  assert.deepEqual(Object.keys(await st.getLastValues()).sort(), ['multi-e2#label', 'multi-e2#price'])
  assert.equal((await st.getHealthMap())[task.id].status, 'ok')
  assert.equal((await st.getRecordsByDate('2026-09-21')).length, 2)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.sendMessage').length, 0)
})

test('E2c：舊 slot 重入遇到較新的 lastValues／health 不回寫舊值或重抓', async () => {
  const { c, st, fe } = await fresh()
  const health = await import('../src/background/health.js?t=' + Math.random())
  const task = multiTask()
  await st.saveTask(task)
  const oldSlot = '2026-09-21T12:30'
  const oldCapturedAt = '2026-09-21T04:30:01.000Z'
  await st.appendRecords('2026-09-21', [
    { taskId: 'multi-e2#price', slot: oldSlot, commitId: `multi-e2@${oldSlot}`, capturedAt: oldCapturedAt, value: 12, raw: '12', status: 'ok' },
    { taskId: 'multi-e2#label', slot: oldSlot, commitId: `multi-e2@${oldSlot}`, capturedAt: oldCapturedAt, value: '舊標籤', raw: '舊標籤', status: 'ok' }
  ])
  await st.setRunStatus(task.id, oldSlot, 'ok')
  const newerLast = {
    'multi-e2#price': { value: 13, capturedAt: '2026-09-21T04:31:01.000Z' },
    'multi-e2#label': { value: '新標籤', capturedAt: '2026-09-21T04:31:01.000Z' }
  }
  await st.setLastValues(newerLast)
  await health.setTaskHealth(task.id, { status: 'partial', reason: '較新 slot' })
  c.__calls.length = 0

  const result = await fe.runTask(task, { slot: oldSlot, attempt: 2, ...FAST })
  assert.equal(result, null)
  assert.deepEqual(await st.getLastValues(), newerLast)
  const currentHealth = (await st.getHealthMap())[task.id]
  assert.equal(currentHealth.status, 'partial')
  assert.equal(currentHealth.reason, '較新 slot')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.sendMessage').length, 0)
})

test('E2c：同一 slot 的兩次手動 multi 抓取各自保留，不套用排程去重', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder(framesResponder())
  let value = 12
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: true, value, raw: String(value), status: 'ok' }
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  const slot = '2026-09-21T13:00'
  await fe.runTask(task, { slot, reason: 'manual', attempt: 3, ...FAST })
  value = 13
  await fe.runTask(task, { slot, reason: 'manual', attempt: 3, ...FAST })
  const records = await st.getRecordsByDate('2026-09-21')
  assert.equal(records.length, 4)
  assert.deepEqual(records.filter(record => record.taskId === 'multi-e2#price').map(record => record.value), [12, 13])
  assert.equal(await st.getRunStatus(task.id, slot), undefined)
})
