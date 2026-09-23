process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 30 }
const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })

function multiTask(over = {}) {
  return {
    id: 'r14-race', name: '競態規格', url: 'https://r14-race.test/page', mode: 'multi', enabled: true,
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
    : [{ frameId: 0, result: 'https://r14-race.test/page' }]
}

function installSuccessResponder(c) {
  c.__setScriptResponder(framesResponder())
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    return msg.locator?.css === '#price'
      ? { ok: true, value: 12, raw: '12', status: 'ok' }
      : { ok: true, value: '標籤', raw: '標籤', status: 'ok' }
  })
}

async function mutateAfterLastValuesRead(c, mutate) {
  const realGet = c.storage.local.get.bind(c.storage.local)
  let triggered = false
  c.storage.local.get = async (key) => {
    const result = await realGet(key)
    if (!triggered && key === 'lastValues') {
      triggered = true
      await mutate()
    }
    return result
  }
  return {
    triggered: () => triggered,
    restore: () => { c.storage.local.get = realGet }
  }
}

test('R14b 紅測：最後 validity gate 後刪任務，setLastValues／health 仍復活舊 execution', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T10:00'
  await st.saveTask(task)
  installSuccessResponder(c)
  const race = await mutateAfterLastValuesRead(c, () => st.deleteTask(task.id))
  let result
  try {
    result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  } finally {
    race.restore()
  }
  assert.equal(race.triggered(), true)
  assert.equal(result?.error, 'task_changed')
  assert.equal(await st.getTask(task.id), null)
  assert.deepEqual(await st.getLastValues(), {}, 'task deletion後不得由舊 execution 復活 lastValues')
  assert.equal((await st.getHealthMap())[task.id], undefined, 'task deletion後不得由舊 execution 復活 health')
})

test('R14b 紅測：最後 validity gate 後移除 field，setLastValues 仍復活已刪序列', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T10:10'
  await st.saveTask(task)
  installSuccessResponder(c)
  const changed = structuredClone(task)
  changed.fields = [changed.fields[0]]
  changed.spec.fields = [changed.spec.fields[0]]
  const race = await mutateAfterLastValuesRead(c, () => st.saveTask(changed))
  let result
  try {
    result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
  } finally {
    race.restore()
  }
  assert.equal(race.triggered(), true)
  assert.equal(result?.error, 'task_changed')
  assert.deepEqual(Object.keys(await st.getLastValues()).sort(), [],
    '移除 field 後不得由舊 execution 復活已刪序列')
})

test('R14b：mutation 在 lastValues 鎖內規格讀取後發生，寫後清理仍移除舊 execution', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const changed = structuredClone(task)
  changed.spec.fields[0].source.locator.css = '#new-price'
  const slot = '2026-09-22T10:20'
  await st.saveTask(task)
  installSuccessResponder(c)

  const realGet = c.storage.local.get.bind(c.storage.local)
  let armed = false
  let triggered = false
  let mutationPromise
  c.storage.local.get = async (key) => {
    const result = await realGet(key)
    if (key === 'lastValues') armed = true
    if (armed && !triggered && key === 'tasks') {
      triggered = true
      mutationPromise = st.saveTask(changed)
      for (let i = 0; i < 20; i++) {
        const current = await realGet('tasks')
        if (current.tasks?.[0]?.spec?.fields?.[0]?.source?.locator?.css === '#new-price') break
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      // 回傳 target-key check 之前讀到的舊 tasks，模擬 check 後才 mutation。
      return result
    }
    return result
  }
  try {
    const result = await fe.runTask(task, { slot, attempt: 3, ...FAST })
    await mutationPromise
    assert.equal(triggered, true)
    assert.equal(result.error, 'task_changed')
    assert.deepEqual(await st.getLastValues(), {})
  } finally {
    c.storage.local.get = realGet
    if (mutationPromise) await mutationPromise
  }
})

test('R14b：移除單一 field 只清該 field，未改 source 的 lastValue 保留', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const slot = '2026-09-22T10:30'
  await st.saveTask(task)
  installSuccessResponder(c)
  await fe.runTask(task, { slot, attempt: 3, ...FAST })
  const changed = structuredClone(task)
  changed.fields = [changed.fields[0]]
  changed.spec.fields = [changed.spec.fields[0]]
  await st.saveTask(changed)
  const lastValues = await st.getLastValues()
  assert.deepEqual(Object.keys(lastValues).sort(), ['r14-race#price'])
  assert.equal(lastValues['r14-race#price'].value, 12)
})

test('R14b：新 execution value 不被舊 fingerprint cleanup 刪除', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  const oldFingerprint = await fe.executionFingerprintOf(task)
  const slotA = '2026-09-22T10:40'
  await st.saveTask(task)
  installSuccessResponder(c)
  await fe.runTask(task, { slot: slotA, attempt: 3, ...FAST })
  const changed = structuredClone(task)
  changed.spec.fields[0].source.locator.css = '#new-price'
  await st.saveTask(changed)
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    return msg.locator?.css === '#new-price'
      ? { ok: true, value: 13, raw: '13', status: 'ok' }
      : { ok: true, value: '新標籤', raw: '新標籤', status: 'ok' }
  })
  await fe.runTask(changed, { slot: '2026-09-22T10:50', attempt: 3, ...FAST })
  await st.clearLastValuesForExecution(changed.id, oldFingerprint)
  const lastValues = await st.getLastValues()
  assert.equal(lastValues['r14-race#price'].value, 13)
  assert.equal(lastValues['r14-race#label'].value, '新標籤')
})
