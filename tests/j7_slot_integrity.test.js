// AF-4 終檢:重試與晚觸發都必須沿用原本的排程槽
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100 }
const localDate = (ms) => {
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const slotOf = (ms) => {
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
  return `${localDate(ms)}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const interval = (id, everyMinutes, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'interval', everyMinutes, weekdays: [0, 1, 2, 3, 4, 5, 6], ...over }
})

test('抓取失敗排的重試 alarm 帶著原本的排程槽', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(interval('i1', 10))
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  const scheduledTime = Date.now() - 120000
  await bg.handleAlarm({ name: 'task:i1:0', scheduledTime }, FAST)
  const retry = (await chrome.alarms.getAll()).find(a => a.name.includes(':retry:'))
  assert.ok(retry, '失敗要排重試')
  assert.ok(retry.name.includes(slotOf(scheduledTime)),
    `重試 alarm 要帶原始槽,才不會寫進新的一格,實得:${retry.name}`)
})

test('重試成功時寫回原本那一格,不是重試當下的時刻', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(interval('i1', 10))
  const original = Date.now() - 300000
  const slot = slotOf(original)
  c.__setTabResponder(() => ({ ok: true, value: 7, raw: '7', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await bg.handleAlarm({ name: `i1:retry:1@${slot}` }, FAST)
  const recs = await st.getRecordsByDate(localDate(original))
  assert.equal(recs.length, 1)
  assert.equal(recs[0].slot, slot, '重試補的是原本那一格,否則同一次排程會出現兩列')
})

test('沒有帶槽的舊格式重試 alarm 仍然可用(退回當下時刻)', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(interval('i1', 10))
  c.__setTabResponder(() => ({ ok: true, value: 7, raw: '7', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await assert.doesNotReject(() => bg.handleAlarm({ name: 'i1:retry:1' }, FAST))
  assert.equal((await st.getRecordsByDate(localDate(Date.now()))).length, 1)
})

test('alarm 排定時刻在時段內,但晚了幾分鐘才觸發時仍要抓', async () => {
  const { c, st, bg } = await fresh()
  const now = new Date()
  // 時段在「現在」之前剛結束:排定時刻落在時段最後一格,實際觸發已經超出
  const end = new Date(now.getTime() - 2 * 60000)
  const start = new Date(end.getTime() - 30 * 60000)
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  await st.saveTask(interval('i1', 10, { window: { from: hhmm(start), to: hhmm(end) } }))
  c.__setTabResponder(() => ({ ok: true, value: 5, raw: '5', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await bg.handleAlarm({ name: 'task:i1:0', scheduledTime: end.getTime() }, FAST)
  const recs = await st.getRecordsByDate(localDate(end.getTime()))
  assert.equal(recs.length, 1, '排定時刻在時段內就該抓,晚觸發不是跳過的理由')
  assert.equal(recs[0].slot, slotOf(end.getTime()))
})

test('排定時刻本來就在時段外時仍然不抓', async () => {
  const { c, st, bg } = await fresh()
  const now = new Date()
  const from = String((now.getHours() + 2) % 24).padStart(2, '0') + ':00'
  const to = String((now.getHours() + 3) % 24).padStart(2, '0') + ':00'
  await st.saveTask(interval('i1', 5, { window: { from, to } }))
  await bg.handleAlarm({ name: 'task:i1:0', scheduledTime: Date.now() }, FAST)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
})
