// AF-3 批次 E:告警判定(純函式;去重與通知在 fetcher,不在這裡)
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAlerts } from '../src/shared/alerts.js'

const task = (alerts, over = {}) => ({ id: 't1', name: '電費', mode: 'number', alerts, ...over })
const ok = (value, over = {}) => ({ taskId: 't1', status: 'ok', value, capturedAt: '2026-09-06T09:00:00+08:00', ...over })
const fail = (status = 'not_found') => ({ taskId: 't1', status, capturedAt: '2026-09-06T09:00:00+08:00' })
const ids = (r) => r.hits.map(h => h.alertId)

// ---- 閾值 ----

test('gt:超過閾值才命中', () => {
  const t = task([{ id: 'a1', type: 'gt', value: 1000, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(1234), [])), ['a1'])
  assert.deepEqual(ids(evaluateAlerts(t, ok(1000), [])), [], '等於不算超過')
  assert.deepEqual(ids(evaluateAlerts(t, ok(999), [])), [])
})

test('lt:低於閾值才命中', () => {
  const t = task([{ id: 'a1', type: 'lt', value: 100, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(99), [])), ['a1'])
  assert.deepEqual(ids(evaluateAlerts(t, ok(100), [])), [])
})

test('eq:數值相等時命中,浮點誤差要容忍', () => {
  const t = task([{ id: 'a1', type: 'eq', value: 0.3, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(0.1 + 0.2), [])), ['a1'], '0.1+0.2 必須算等於 0.3')
  assert.deepEqual(ids(evaluateAlerts(t, ok(0.31), [])), [])
})

test('文字模式的 eq 比字串', () => {
  const t = task([{ id: 'a1', type: 'eq', value: '缺貨', enabled: true }], { mode: 'text' })
  assert.deepEqual(ids(evaluateAlerts(t, ok('缺貨'), [])), ['a1'])
  assert.deepEqual(ids(evaluateAlerts(t, ok('有貨'), [])), [])
})

// ---- 變動幅度 ----

test('deltaPct:與前一筆成功紀錄相比,漲跌超過設定值才命中', () => {
  const t = task([{ id: 'a1', type: 'deltaPct', value: 20, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(130), [ok(100)])), ['a1'], '漲 30% 命中')
  assert.deepEqual(ids(evaluateAlerts(t, ok(70), [ok(100)])), ['a1'], '跌 30% 也要命中')
  assert.deepEqual(ids(evaluateAlerts(t, ok(110), [ok(100)])), [], '漲 10% 不命中')
  assert.deepEqual(ids(evaluateAlerts(t, ok(120), [ok(100)])), ['a1'], '剛好 20% 要命中(門檻是大於等於)')
})

test('deltaPct:中間夾著失敗紀錄時,要跟最近一筆「成功」的比', () => {
  const t = task([{ id: 'a1', type: 'deltaPct', value: 20, enabled: true }])
  const prev = [ok(100), fail(), fail('parse_error')]
  assert.deepEqual(ids(evaluateAlerts(t, ok(130), prev)), ['a1'])
})

test('deltaPct:沒有前一筆成功紀錄時不命中,也不得拋例外', () => {
  const t = task([{ id: 'a1', type: 'deltaPct', value: 20, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(130), [])), [])
  assert.deepEqual(ids(evaluateAlerts(t, ok(130), [fail()])), [])
})

test('deltaPct:前一筆是 0 時不命中(除以 0 沒有意義)', () => {
  const t = task([{ id: 'a1', type: 'deltaPct', value: 20, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(5), [ok(0)])), [])
})

test('deltaPct:前一筆是負值時,幅度要用絕對值算(會計負數是支援的)', () => {
  const t = task([{ id: 'a1', type: 'deltaPct', value: 20, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(-130), [ok(-100)])), ['a1'], '從 -100 變 -130 是 30% 變動')
  assert.deepEqual(ids(evaluateAlerts(t, ok(-110), [ok(-100)])), [], '從 -100 變 -110 只有 10%')
})

test('eq:大數也要能判定相等(絕對誤差門檻對大數太嚴)', () => {
  const t = task([{ id: 'a1', type: 'eq', value: 1e10, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(1e10), [])), ['a1'])
  assert.deepEqual(ids(evaluateAlerts(t, ok(1e10 + 1), [])), [], '差 1 就不是相等')
})

// ---- 連續失敗 ----

test('failStreak:連續失敗達到次數才命中(本筆算在內)', () => {
  const t = task([{ id: 'a1', type: 'failStreak', value: 3, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, fail(), [fail()])), [], '只有兩次')
  assert.deepEqual(ids(evaluateAlerts(t, fail(), [fail(), fail()])), ['a1'])
})

test('failStreak:中間成功過就重新算', () => {
  const t = task([{ id: 'a1', type: 'failStreak', value: 3, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, fail(), [fail(), ok(1), fail()])), [])
})

test('failStreak:fallback 與 late 算成功,不打斷連續失敗的計數起點', () => {
  const t = task([{ id: 'a1', type: 'failStreak', value: 2, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, fail(), [ok(1, { status: 'fallback' })])), [])
  assert.deepEqual(ids(evaluateAlerts(t, fail(), [ok(1, { status: 'late' })])), [])
})

test('本筆成功時 failStreak 一定不命中', () => {
  const t = task([{ id: 'a1', type: 'failStreak', value: 2, enabled: true }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(1), [fail(), fail(), fail()])), [])
})

// ---- 一般規則 ----

test('失敗紀錄不觸發數值類條件(沒有值可以比)', () => {
  const t = task([
    { id: 'a1', type: 'gt', value: 1, enabled: true },
    { id: 'a2', type: 'lt', value: 999999, enabled: true },
    { id: 'a3', type: 'deltaPct', value: 1, enabled: true }
  ])
  assert.deepEqual(ids(evaluateAlerts(t, fail(), [ok(100)])), [])
})

test('停用的條件不評估', () => {
  const t = task([{ id: 'a1', type: 'gt', value: 1, enabled: false }])
  assert.deepEqual(ids(evaluateAlerts(t, ok(1234), [])), [])
})

test('多條可以同時命中,順序照設定順序', () => {
  const t = task([
    { id: 'a1', type: 'gt', value: 100, enabled: true },
    { id: 'a2', type: 'lt', value: 9999, enabled: true }
  ])
  assert.deepEqual(ids(evaluateAlerts(t, ok(1234), [])), ['a1', 'a2'])
})

test('沒有設定 alerts 時回傳空的 hits,不得是 undefined', () => {
  assert.deepEqual(evaluateAlerts({ id: 't1' }, ok(1), []).hits, [])
  assert.deepEqual(evaluateAlerts({ id: 't1', alerts: [] }, ok(1), []).hits, [])
})

test('每個命中都帶得出給人看的訊息,含任務名與實際值', () => {
  const t = task([{ id: 'a1', type: 'gt', value: 1000, enabled: true }])
  const hit = evaluateAlerts(t, ok(1234), []).hits[0]
  assert.equal(hit.type, 'gt')
  assert.ok(hit.message.includes('1234') || hit.message.includes('1,234'), `訊息要有實際值:${hit.message}`)
  assert.ok(hit.message.includes('1000') || hit.message.includes('1,000'), `訊息要有門檻:${hit.message}`)
})

test('不得改動傳進來的任務或紀錄', () => {
  const t = task([{ id: 'a1', type: 'gt', value: 1000, enabled: true }])
  const rec = ok(1234)
  const before = JSON.stringify({ t, rec })
  evaluateAlerts(t, rec, [ok(100)])
  assert.equal(JSON.stringify({ t, rec }), before, '純函式不得有副作用')
})
