process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 30 }

function multiTask(over = {}) {
  return {
    id: 'multi-e1', name: '跨來源', url: 'https://a.test/page', mode: 'multi', enabled: true,
    fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }],
    spec: {
      mode: 'multi',
      fields: [
        { key: 'price', mode: 'number', source: { locator: locator('#price') }, spec: { strategy: 'auto' } },
        { key: 'label', mode: 'text', source: { locator: locator('#label'), frame: { url: 'https://b.test/embed' } }, spec: { mode: 'text' } }
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

test('E1 multi 每個來源各自定位 frame 與擷取，部分成功保留兩個 field 結果', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder((injection) => {
    if (Array.isArray(injection?.args)) return []
    return [{ frameId: 0, result: 'https://a.test/page' }, { frameId: 7, result: 'https://b.test/embed?token=1' }]
  })
  c.__setTabResponder((tabId, msg, options) => {
    if (msg.type === 'RESOLVE_LOCATOR') return { ok: true, found: options?.frameId === 7 }
    if (msg.type === 'EXTRACT' && msg.locator?.css === '#price') return { ok: true, value: 12, raw: '12', status: 'ok' }
    if (msg.type === 'EXTRACT' && msg.locator?.css === '#label') return { ok: false, error: 'not_found', message: '標籤不存在' }
    return { ok: true }
  })
  const task = multiTask()
  await st.saveTask(task)
  const first = await fe.runTask(task, { slot: '2026-09-21T09:00', attempt: 3, ...FAST })
  assert.equal(first.taskId, 'multi-e1#price')
  const records = await st.getRecordsByDate('2026-09-21')
  assert.deepEqual(records.map(r => [r.taskId, r.status, r.value]), [
    ['multi-e1#price', 'ok', 12], ['multi-e1#label', 'not_found', undefined]
  ])
  const extracts = c.__calls.filter(x => x.api === 'tabs.sendMessage' && x.args[1]?.type === 'EXTRACT')
  assert.deepEqual(extracts.map(x => [x.args[1].locator.css, x.args[2].frameId]), [['#price', 0], ['#label', 7]])
})

test('E1 所有 field 失敗仍各自寫入紀錄，不把 multi 當成成功', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder((injection) => Array.isArray(injection?.args)
    ? []
    : [{ frameId: 0, result: 'https://a.test/page' }, { frameId: 7, result: 'https://b.test/embed' }])
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: false, error: 'parse_error', raw: msg.locator.css }
    : { ok: true })
  const task = multiTask()
  await st.saveTask(task)
  const result = await fe.runTask(task, { slot: '2026-09-21T10:00', attempt: 3, ...FAST })
  assert.equal(result.status, 'parse_error')
  const records = await st.getRecordsByDate('2026-09-21')
  assert.deepEqual(records.map(r => [r.taskId, r.status]), [
    ['multi-e1#price', 'parse_error'], ['multi-e1#label', 'parse_error']
  ])
})

test('E1 同 URL 多 frame 無法消歧時，該 field 明確失敗且不退回頂層', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder((injection) => {
    if (Array.isArray(injection?.args)) return []
    return [
      { frameId: 0, result: 'https://a.test/page' },
      { frameId: 7, result: 'https://b.test/embed' },
      { frameId: 8, result: 'https://b.test/embed'
      }
    ]
  })
  c.__setTabResponder((tabId, msg) => msg.type === 'RESOLVE_LOCATOR'
    ? { ok: true, found: true }
    : { ok: true, value: 99, raw: '99', status: 'ok' })
  const task = multiTask({
    fields: [{ key: 'label', name: '標籤' }],
    spec: { mode: 'multi', fields: [{ key: 'label', mode: 'text', source: { locator: locator('#same'), frame: { url: 'https://b.test/embed' } }, spec: { mode: 'text' } }] }
  })
  await st.saveTask(task)
  const result = await fe.runTask(task, { slot: '2026-09-21T11:00', attempt: 3, ...FAST })
  assert.equal(result.taskId, 'multi-e1#label')
  const records = await st.getRecordsByDate('2026-09-21')
  assert.deepEqual(records.map(r => [r.taskId, r.status]), [['multi-e1#label', 'frame_not_found']])
  assert.equal(records[0].value, undefined)
})

test('E1 單一來源通訊失敗只在該 field 內有界重試，成功來源不重抓', async () => {
  const { c, st, fe } = await fresh()
  const attempts = new Map()
  c.__setScriptResponder((injection) => Array.isArray(injection?.args)
    ? []
    : [{ frameId: 0, result: 'https://a.test/page' }, { frameId: 7, result: 'https://b.test/embed' }])
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    const css = msg.locator.css
    const count = (attempts.get(css) || 0) + 1
    attempts.set(css, count)
    if (css === '#label' && count === 1) throw new Error('document replaced')
    return { ok: true, value: css === '#price' ? 12 : 'ready', raw: css === '#price' ? '12' : 'ready', status: 'ok' }
  })
  const task = multiTask()
  await st.saveTask(task)
  const result = await fe.runTask(task, { slot: '2026-09-21T12:00', attempt: 3, reviveDelaysMs: [1, 1], ...FAST })
  assert.equal(result.taskId, 'multi-e1#price')
  assert.equal(attempts.get('#price'), 1)
  assert.equal(attempts.get('#label'), 2)
  assert.equal((await st.getRecordsByDate('2026-09-21')).length, 2)
})

test('E1 同站台前置動作在多來源任務中只執行一次', async () => {
  const { c, st, fe } = await fresh()
  c.__setScriptResponder((injection) => Array.isArray(injection?.args)
    ? []
    : [{ frameId: 0, result: 'https://a.test/page' }, { frameId: 7, result: 'https://b.test/embed' }])
  const seen = []
  c.__setTabResponder((tabId, msg) => {
    seen.push(msg.type)
    if (msg.type === 'EXTRACT') return { ok: true, value: 1, raw: '1', status: 'ok' }
    if (msg.type === 'RESOLVE_LOCATOR') return { ok: true, found: true }
    return { ok: true }
  })
  const task = multiTask({ preActions: [{ type: 'click', locator: locator('#tab') }] })
  await st.saveTask(task)
  await fe.runTask(task, { slot: '2026-09-21T12:30', attempt: 3, ...FAST })
  assert.equal(seen.filter(type => type === 'RUN_PRE_ACTIONS').length, 1)
  assert.equal(seen.filter(type => type === 'EXTRACT').length, 2)
})

test('E1 multi 離線與 dryRun 都按 field 形狀處理，dryRun 不寫正式紀錄', async () => {
  const { c, st, fe } = await fresh()
  const task = multiTask()
  await st.saveTask(task)
  globalThis.navigator = { onLine: false }
  const preview = await fe.runTask(task, { slot: '2026-09-21T13:00', dryRun: true, ...FAST })
  assert.deepEqual(Object.keys(preview.fields), ['price', 'label'])
  assert.equal((await st.getRecordsByDate('2026-09-21')).length, 0)
  const saved = await fe.runTask(task, { slot: '2026-09-21T13:00', attempt: 3, ...FAST })
  assert.equal(saved.taskId, 'multi-e1#price')
  assert.equal((await st.getRecordsByDate('2026-09-21')).length, 2)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
})
