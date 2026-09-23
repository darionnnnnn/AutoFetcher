import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 30 }
const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const task = {
  id: 'r11-task', name: 'R11 測試', url: 'https://a.test/page', mode: 'multi', enabled: true,
  fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }],
  spec: { mode: 'multi', fields: [
    { key: 'price', mode: 'number', source: { locator: locator('#price') }, spec: { strategy: 'auto' } },
    { key: 'label', mode: 'text', source: { locator: locator('#label') }, spec: { mode: 'text' } }
  ] },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
}

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  const he = await import('../src/background/health.js?t=' + Math.random())
  c.__setScriptResponder(injection => Array.isArray(injection?.args)
    ? [] : [{ frameId: 0, result: 'https://a.test/page' }])
  return { c, st, bg, pc, he }
}

function responder(failLabel) {
  return (tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    if (msg.locator?.css === '#label' && failLabel) return { ok: false, error: 'parse_error', raw: 'N/A' }
    return { ok: true, value: msg.locator?.css === '#price' ? 12 : '上市', raw: '12', status: 'ok' }
  }
}

test('R11 RUN_TASK 真實 handler 回報部分失敗，且只讀本次 executionId', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(task)
  c.__setTabResponder(responder(true))
  const first = await bg.handleMessage({ type: 'RUN_TASK', taskId: task.id }, {}, FAST)
  assert.equal(first.outcome, 'partial')
  assert.deepEqual(first.values.map(v => [v.name, v.ok]), [['價格', true], ['標籤', false]])
  c.__setTabResponder(responder(false))
  const second = await bg.handleMessage({ type: 'RUN_TASK', taskId: task.id }, {}, FAST)
  assert.equal(second.outcome, 'done')
  assert.deepEqual(second.values.map(v => v.ok), [true, true])
  const records = await st.getRecordsByDate(localToday())
  const executions = new Set(records.filter(r => r.taskId.startsWith(`${task.id}#`)).map(r => r.executionId))
  assert.equal(executions.size, 2, '同分鐘兩次手動抓取要有獨立執行身分')
})

test('R11 預檢同一組一成功一失敗標部分失敗並列出失敗值名', async () => {
  const { c, st, pc, he } = await fresh()
  await st.saveTask(task)
  c.__setTabResponder(responder(true))
  await pc.runPrecheck(task, FAST)
  const health = (await he.getHealth())[task.id]
  assert.equal(health.status, 'partial')
  assert.equal(health.reason, '部分失敗')
  assert.equal(health.detail, '標籤')
})

test('R11 RUN_TASK 全部失敗回 failed，空 fields 在執行前拒絕', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(task)
  c.__setTabResponder((tabId, msg) => msg.type === 'EXTRACT'
    ? { ok: false, error: 'not_found' } : { ok: true })
  const failed = await bg.handleMessage({ type: 'RUN_TASK', taskId: task.id }, {}, FAST)
  assert.equal(failed.outcome, 'failed')
  assert.deepEqual(failed.values.map(v => v.ok), [false, false])
  const empty = { ...task, id: 'empty-r11', fields: [], spec: { mode: 'multi', fields: [] } }
  await chrome.storage.local.set({ tasks: [...await st.getTasks(), empty] })
  const rejected = await bg.handleMessage({ type: 'RUN_TASK', taskId: empty.id }, {}, FAST)
  assert.equal(rejected.outcome, 'failed')
  assert.match(rejected.error, /沒有可執行欄位/)
})
