// AF-24 C2：失敗收尾單一入口——哪些重試、用盡才通知、手動不通知
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100, frameTimeoutMs: 20 }
const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const single = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: locator('#v'), spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})
const multi = (id) => ({
  id, name: id, url: 'https://a.test/m', mode: 'multi', enabled: true,
  fields: [{ key: 'x', name: 'X' }, { key: 'y', name: 'Y' }],
  spec: { mode: 'multi', fields: [
    { key: 'x', mode: 'number', source: { locator: locator('#x') }, spec: { strategy: 'auto' } },
    { key: 'y', mode: 'number', source: { locator: locator('#y') }, spec: { strategy: 'auto' } }
  ] },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, fe }
}
const retries = c => c.__calls.filter(x => x.api === 'alarms.create' && /:retry:/.test(String(x.args[0])))
const notes = c => c.__calls.filter(x => x.api === 'notifications.create')
const ERROR = () => ({ ok: false, error: 'boom', message: '頁面回了奇怪的東西' })
const PARSE = () => ({ ok: false, error: 'parse_error', raw: 'N/A' })

test('單值未知錯誤：前兩次排重試、不寫紀錄不通知；第三次寫紀錄並通知一次', async () => {
  const { c, st, fe } = await fresh()
  const t = single('e1')
  await st.saveTask(t)
  c.__setTabResponder(ERROR)
  const slot = '2026-10-20T09:00'
  assert.equal(await fe.runTask(t, { slot, attempt: 1, ...FAST }), null)
  assert.equal(await fe.runTask(t, { slot, attempt: 2, ...FAST }), null)
  assert.equal(retries(c).length, 2)
  assert.equal((await st.getRecordsByDate('2026-10-20')).length, 0)
  assert.equal(notes(c).length, 0, '還在重試不通知')
  const rec = await fe.runTask(t, { slot, attempt: 3, ...FAST })
  assert.equal(rec.status, 'error')
  assert.equal(retries(c).length, 2, '用盡不再排重試')
  assert.equal(notes(c).length, 1, '用盡通知一次')
  // 同狀態 24 小時內另一格再失敗：不再通知
  await fe.runTask(t, { slot: '2026-10-20T10:00', attempt: 3, ...FAST })
  assert.equal(notes(c).length, 1)
})

test('parse_error 不重試：第一次就寫紀錄並通知', async () => {
  const { c, st, fe } = await fresh()
  const t = single('p1')
  await st.saveTask(t)
  c.__setTabResponder(PARSE)
  const rec = await fe.runTask(t, { slot: '2026-10-20T09:00', attempt: 1, ...FAST })
  assert.equal(rec.status, 'parse_error')
  assert.equal(rec.raw, 'N/A')
  assert.equal('value' in rec, false)
  assert.equal(retries(c).length, 0)
  assert.equal(notes(c).length, 1)
})

test('手動抓取失敗：不重試、不通知，但留紀錄', async () => {
  const { c, st, fe } = await fresh()
  const t = single('m1')
  await st.saveTask(t)
  c.__setTabResponder(ERROR)
  const rec = await fe.runTask(t, { slot: '2026-10-20T09:00', reason: 'manual', ...FAST })
  assert.equal(rec.status, 'error')
  assert.equal(retries(c).length, 0)
  assert.equal(notes(c).length, 0)
})

test('multi 正式排程最後一次仍離線：每值一筆失敗紀錄、通知一次', async () => {
  const { c, st, fe } = await fresh()
  globalThis.navigator.onLine = false
  const t = multi('mu')
  await st.saveTask(t)
  assert.equal(await fe.runTask(t, { slot: '2026-10-20T09:00', attempt: 1, ...FAST }), null, '離線先排重試')
  await fe.runTask(t, { slot: '2026-10-20T09:00', attempt: 3, ...FAST })
  const recs = await st.getRecordsByDate('2026-10-20')
  assert.deepEqual(recs.map(r => r.taskId).sort(), ['mu#x', 'mu#y'])
  assert.equal(notes(c).length, 1)
})

test('失敗路徑都經同一個入口：fetcher 不再有手寫的 attempt < 3', () => {
  const src = readFileSync(new URL('../src/background/fetcher.js', import.meta.url), 'utf8')
  assert.equal(/attempt < 3/.test(src), false)
  assert.ok((src.match(/scheduleRetry\(/g) || []).length <= 3, '定義＋入口＋multi 整組 not_found 一處')
})

test('同一站台三個任務最後一次都離線：合併成一則通知（同一個通知 id，名單三個任務）', async () => {
  const { c, st, fe } = await fresh()
  globalThis.navigator.onLine = false
  const tasks = ['o1', 'o2', 'o3'].map(id => single(id))
  await st.saveTasks(tasks)
  for (const t of tasks) await fe.runTask(t, { slot: '2026-10-20T09:00', attempt: 3, ...FAST })
  const ids = new Set(notes(c).map(x => x.args[0]))
  assert.deepEqual([...ids], ['fail:https://a.test'], '同站台只有一個通知 id（後到的更新同一則）')
  const last = notes(c).at(-1).args[1]
  assert.match(last.message, /3 個任務/)
})
