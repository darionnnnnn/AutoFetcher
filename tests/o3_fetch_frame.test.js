// AF-6 作業 B:抓取流程接上 frame 定位
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 50 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, fe }
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const framesAs = (list) => (injection) =>
  Array.isArray(injection?.args) ? [] : list.map(([frameId, url]) => ({ frameId, result: url }))

const msgsOf = (c, type) =>
  c.__calls.filter((x) => x.api === 'tabs.sendMessage' && x.args[1]?.type === type).map((x) => x.args)

test('目標在 iframe 內時，擷取要送到定位出來的那個 frame', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ frame: { url: 'https://b.example/w.html' } })
  await st.saveTask(t)
  c.__setScriptResponder(framesAs([[0, 'https://a.test/p'], [7, 'https://b.example/w.html?t=9']]))
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.deepEqual(msgsOf(c, 'EXTRACT').at(-1)[2], { frameId: 7 })
  assert.deepEqual(msgsOf(c, 'SCROLL_INTO_VIEW').at(-1)[2], { frameId: 7 })
})

test('找不到目標所在的框架時要寫 not_found，而且不得硬抓最上層', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ frame: { url: 'https://b.example/w.html' } })
  await st.saveTask(t)
  c.__setScriptResponder(framesAs([[0, 'https://a.test/p']]))
  c.__setTabResponder((tabId, msg) => (msg.type === 'RESOLVE_LOCATOR' ? { ok: true, found: false } : { ok: true, value: 12, raw: '12', status: 'ok' }))
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'not_found')
  assert.match(rec.error || '', /框架/)
  assert.equal(msgsOf(c, 'EXTRACT').length, 0, '定位失敗還去抓，抓到的會是別的東西')
})

test('舊任務（沒有 frame）行為完全不變，也不必列 frame', async () => {
  const { c, st, fe } = await fresh()
  const t = task()
  await st.saveTask(t)
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.deepEqual(msgsOf(c, 'EXTRACT').at(-1)[2], { frameId: 0 })
  const listed = c.__calls.filter((x) => x.api === 'scripting.executeScript' && !Array.isArray(x.args[0]?.args))
  assert.equal(listed.length, 0, '舊任務不該多付列 frame 的成本')
})

test('演練模式（預檢）定位失敗時要說得出原因，而且不寫紀錄', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ frame: { url: 'https://b.example/w.html' } })
  await st.saveTask(t)
  c.__setScriptResponder(framesAs([[0, 'https://a.test/p']]))
  c.__setTabResponder((tabId, msg) => (msg.type === 'RESOLVE_LOCATOR' ? { ok: true, found: false } : { ok: true, value: 1 }))
  const res = await fe.runTask(t, { slot: '2026-09-05T09:00', dryRun: true, ...FAST })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'frame_not_found')
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 0)
})
