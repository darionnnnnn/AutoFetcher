// AF-6 作業 C:前置動作逐一執行，每個動作各自定位自己的 frame
// 「先點按鈕，iframe 才出現」是本輪的主要情境：整批送給同一個 frame 一定失敗。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 60 }

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

const preMsgs = (c) =>
  c.__calls.filter((x) => x.api === 'tabs.sendMessage' && x.args[1]?.type === 'RUN_PRE_ACTIONS').map((x) => x.args)
const extractMsgs = (c) =>
  c.__calls.filter((x) => x.api === 'tabs.sendMessage' && x.args[1]?.type === 'EXTRACT').map((x) => x.args)

test('每個前置動作各送各的 frame，一次一個動作', async () => {
  const { c, st, fe } = await fresh()
  const t = task({
    frame: { url: 'https://b.example/w.html' },
    preActions: [
      { type: 'click', locator: { css: '#tab2' } },
      { type: 'waitFor', locator: { css: '#chart' }, timeoutMs: 50, frame: { url: 'https://b.example/w.html' } },
      { type: 'click', locator: { css: '#more' }, frame: { url: 'https://b.example/w.html' } }
    ]
  })
  await st.saveTask(t)
  c.__setScriptResponder(framesAs([[0, 'https://a.test/p'], [7, 'https://b.example/w.html?t=1']]))
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  const msgs = preMsgs(c)
  assert.equal(msgs.length, 3, `前置動作要逐一送，實際送了 ${msgs.length} 則`)
  assert.deepEqual(msgs.map((m) => m[2].frameId), [0, 7, 7], 'frame 序列不對，等於點到別層的東西')
  for (const m of msgs) {
    assert.equal(m[1].actions.length, 1, '一則只帶一個動作，否則失敗時分不出是哪一個')
  }
})

test('點了按鈕才長出來的 iframe，等得到就算數', async () => {
  const { c, st, fe } = await fresh()
  const t = task({
    frame: { url: 'https://b.example/w.html' },
    preActions: [{ type: 'click', locator: { css: '#open' } }]
  })
  await st.saveTask(t)
  let round = 0
  c.__setScriptResponder((injection) => {
    if (Array.isArray(injection?.args)) return []
    round++
    return round <= 1
      ? [{ frameId: 0, result: 'https://a.test/p' }]
      : [{ frameId: 0, result: 'https://a.test/p' }, { frameId: 7, result: 'https://b.example/w.html' }]
  })
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok', '第一次沒看到就放棄的話，這個情境永遠抓不到')
  assert.deepEqual(extractMsgs(c).at(-1)[2], { frameId: 7 })
})

test('前置動作的 frame 等不到就失敗，後面的動作與擷取都不准做', async () => {
  const { c, st, fe } = await fresh()
  const t = task({
    preActions: [
      { type: 'click', locator: { css: '#a' }, frame: { url: 'https://gone.example/x.html' } },
      { type: 'click', locator: { css: '#b' } }
    ]
  })
  await st.saveTask(t)
  c.__setScriptResponder(framesAs([[0, 'https://a.test/p']]))
  c.__setTabResponder((tabId, msg) => (msg.type === 'RESOLVE_LOCATOR' ? { ok: true, found: false } : { ok: true, value: 1 }))
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  // 前置動作失敗走既有的重試路徑（不寫紀錄、回 null）；不管走哪條，都不准是成功
  assert.notEqual(rec?.status, 'ok')
  assert.equal(preMsgs(c).length, 0, '第一個動作就定位不到，不該還去送第二個')
  assert.equal(extractMsgs(c).length, 0)
})

test('wait 只是等時間，不必列 frame 也不必送訊息', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'wait', ms: 1 }] })
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(preMsgs(c).length, 0, 'wait 不需要頁面幫忙')
  const listed = c.__calls.filter((x) => x.api === 'scripting.executeScript' && !Array.isArray(x.args[0]?.args))
  assert.equal(listed.length, 0)
})

test('舊任務的前置動作沒有 frame，一律走最上層', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'click', locator: { css: '#x' } }, { type: 'wait', ms: 1 }] })
  await st.saveTask(t)
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.deepEqual(preMsgs(c).map((m) => m[2].frameId), [0])
})
