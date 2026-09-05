process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

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

test('成功路徑:開背景分頁、擷取、寫紀錄、關掉自己開的分頁', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.equal(rec.value, 12)
  assert.equal(rec.slot, '2026-09-05T09:00')
  const created = c.__calls.find(x => x.api === 'tabs.create')
  assert.equal(created.args[0].active, false, '必須是背景分頁')
  assert.equal(created.args[0].autoDiscardable, false, 'Edge/Chrome 省電模式會卸載分頁')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.remove').length, 1, '自己開的分頁要關掉')
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 1)
})

test('冪等:同一個 slot 第二次呼叫直接略過,不開分頁不寫紀錄', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  const before = c.__calls.filter(x => x.api === 'tabs.create').length
  const second = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(second, null, '重複觸發應回 null')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, before)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 1)
})

test('不同 slot 不受冪等影響', async () => {
  const { st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  await fe.runTask(task(), { slot: '2026-09-05T10:00', ...FAST })
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 2)
})

test('已開著同 URL 的分頁時直接沿用,不另開也不關掉', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await c.tabs.create({ url: 'https://a.test/p' })
  const before = c.__calls.filter(x => x.api === 'tabs.create').length
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, before, '不得另開分頁')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.remove').length, 0, '不得關掉使用者的分頁')
})

test('沒有任何視窗時先建一個最小化視窗,用完關掉', async () => {
  const { c, st, fe } = await fresh()
  c.__setWindows([])
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  const created = c.__calls.find(x => x.api === 'windows.create')
  assert.ok(created, 'macOS 上 Chrome 可在無視窗狀態執行')
  assert.equal(created.args[0].state, 'minimized')
  assert.equal(c.__calls.filter(x => x.api === 'windows.remove').length, 1)
})

test('分頁被丟棄(discarded)時先 reload', async () => {
  const { c, st, fe } = await fresh()
  const t = await c.tabs.create({ url: 'https://a.test/p' })
  c.__setTabState(t.id, { discarded: true })
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(c.__calls.filter(x => x.api === 'tabs.reload').length, 1)
})

test('頁面載入逾時仍嘗試擷取,不直接失敗', async () => {
  const { c, st, fe } = await fresh()
  c.__setDefaultTabStatus('loading')
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok', '載不完也要試著抓')
})

test('擷取前先送 SCROLL_INTO_VIEW', async () => {
  const { c, st, fe } = await fresh()
  const seen = []
  c.__setTabResponder((tabId, msg) => {
    seen.push(msg.type)
    return { ok: true, value: 1, raw: '1', status: 'ok', strategyUsed: 'auto', layer: 'css' }
  })
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.deepEqual(seen, ['SCROLL_INTO_VIEW', 'EXTRACT'])
})

test('注入 content script 後才送訊息', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  const inject = c.__calls.findIndex(x => x.api === 'scripting.executeScript')
  const send = c.__calls.findIndex(x => x.api === 'tabs.sendMessage')
  assert.ok(inject >= 0, '必須注入 content script')
  assert.ok(inject < send, '注入要在送訊息之前')
})

test('not_found:排 2 分鐘後的重試 alarm,不立刻寫失敗紀錄', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec, null, '還要重試,先不寫紀錄')
  const alarms = await c.alarms.getAll()
  const retry = alarms.find(a => a.name.includes('retry'))
  assert.ok(retry, '應排重試 alarm')
  assert.ok(retry.scheduledTime - Date.now() > 100000, '約 2 分鐘後')
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 0, '重試中不通知')
})

test('重試用盡才寫失敗紀錄並通知', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', attempt: 2, ...FAST })
  assert.equal(rec.status, 'not_found')
  assert.equal(rec.snippet, 'x', '失敗紀錄要留 DOM 片段方便除錯')
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 1)
})

test('連續兩次 not_found 後任務標記 suggestForeground', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', attempt: 2, ...FAST })
  await fe.runTask(task(), { slot: '2026-09-05T10:00', attempt: 2, ...FAST })
  assert.equal((await st.getTask('t1')).suggestForeground, true)
})

test('parse_error 寫紀錄並保留原文,不重試', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'parse_error', raw: '--' }))
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'parse_error')
  assert.equal(rec.raw, '--')
  assert.equal(rec.value, undefined, '不可以寫成 0')
  const alarms = await c.alarms.getAll()
  assert.equal(alarms.filter(a => a.name.includes('retry')).length, 0)
})

test('離線時不開分頁,排 10 分鐘後重試', async () => {
  const { c, st, fe } = await fresh()
  globalThis.navigator = { onLine: false }
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec, null)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
  const retry = (await c.alarms.getAll()).find(a => a.name.includes('retry'))
  assert.ok(retry.scheduledTime - Date.now() > 500000, '約 10 分鐘後')
})

test('reason 為 late 時紀錄標記 late', async () => {
  const { st, fe } = await fresh()
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', reason: 'late', ...FAST })
  assert.equal(rec.status, 'late')
})

test('fallback 策略成功時紀錄標 fallback 並記下實際策略', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder(() => ({ ok: true, value: 9, raw: '9', status: 'fallback', strategyUsed: 'attr', layer: 'path' }))
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'fallback')
  assert.equal(rec.strategyUsed, 'attr')
  assert.equal(rec.layer, 'path')
})

test('抓取期間有呼叫延壽 API(MV3 worker 會被回收)', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.ok(c.__calls.some(x => x.api === 'runtime.getPlatformInfo'), '需有延壽呼叫')
})

test('同站台兩個任務串行,只開一個分頁', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task({ id: 't1' }))
  await st.saveTask(task({ id: 't2' }))
  await Promise.all([
    fe.runTask(task({ id: 't1' }), { slot: '2026-09-05T09:00', ...FAST }),
    fe.runTask(task({ id: 't2' }), { slot: '2026-09-05T09:00', ...FAST })
  ])
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 1, '同站台共用分頁')
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 2)
})

test('執行中狀態寫入 storage.session,結束後清除', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  const sess = await c.storage.session.get(null)
  const inflight = sess.inflight || {}
  assert.equal(Object.keys(inflight).length, 0, '結束後不得殘留')
  assert.ok(c.__calls.some(x => x.api === 'session.set'), '執行期間要寫狀態機')
})

test('例外不會讓 runTask 炸掉,會寫成 error 紀錄', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder(() => { throw new Error('boom') })
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', attempt: 2, ...FAST })
  assert.equal(rec.status, 'error')
  assert.ok(String(rec.error).includes('boom'))
})
