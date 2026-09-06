// AF-5 批次 B2b：抓取端一次寫多個值
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

const multi = (over = {}) => ({
  id: 'bank', name: '臺銀匯率', url: 'https://bank.test/rate', mode: 'block', enabled: true,
  locator: { css: '#rate', path: '', anchor: null, xpath: '' },
  spec: {
    strategy: 'auto', mode: 'block',
    fields: [
      { key: 'buy', cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '即期 · 買入' } } },
      { key: 'sell', cell: { row: { index: 0, header: '美金' }, col: { index: 4, header: '即期 · 賣出' } } }
    ]
  },
  fields: [{ key: 'buy', name: '美金買入' }, { key: 'sell', name: '美金賣出' }],
  schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

async function fresh(tabRes) {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const he = await import('../src/background/health.js?t=' + Math.random())
  if (tabRes) c.__setTabResponder(() => tabRes)
  return { c, st, fe, he }
}

const BOTH_OK = {
  ok: true,
  fields: {
    buy: { ok: true, value: 31.2, raw: '31.2', status: 'ok' },
    sell: { ok: true, value: 31.3, raw: '31.3', status: 'ok' }
  }
}

// ---- 一次抓多個值 ----

test('兩個值產生兩筆紀錄，用同一個排程槽', async () => {
  const { st, fe } = await fresh(BOTH_OK)
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  assert.equal(recs.length, 2)
  assert.deepEqual(recs.map(r => r.taskId).sort(), ['bank#buy', 'bank#sell'])
  assert.ok(recs.every(r => r.slot === '2026-09-06T09:30'))
  assert.equal(recs.find(r => r.taskId === 'bank#buy').value, 31.2)
})

test('整組值只寫一次紀錄（不得每個值各掃一次整天的資料）', async () => {
  const { c, st, fe } = await fresh(BOTH_OK)
  await st.saveTask(multi())
  const before = c.__calls.length
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const writes = c.__calls.slice(before).filter(x => x.api === 'storage.local.set' && x.args[0]?.['rec:2026-09-06'])
  assert.equal(writes.length, 1, `整組值應該一次寫入，實得 ${writes.length} 次`)
})

test('帳本記在父任務身上，不是子序列', async () => {
  const { c, st, fe } = await fresh(BOTH_OK)
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const runs = (await c.storage.local.get('runs')).runs || {}
  assert.deepEqual(Object.keys(runs), ['bank'])
  assert.equal(runs.bank['2026-09-06T09:30'], 'ok')
})

test('最後值分別記在各個子序列上', async () => {
  const { st, fe } = await fresh(BOTH_OK)
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const lv = await st.getLastValues()
  assert.equal(lv['bank#buy'].value, 31.2)
  assert.equal(lv['bank#sell'].value, 31.3)
})

// ---- 個別值失敗 ----

test('一個值抓不到：寫該值的失敗紀錄、不重試、燈號轉黃', async () => {
  const { c, st, fe, he } = await fresh({
    ok: true,
    fields: {
      buy: { ok: true, value: 31.2, raw: '31.2', status: 'ok' },
      sell: { ok: false, error: 'not_found' }
    }
  })
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  assert.equal(recs.length, 2, '失敗的值也要留下紀錄')
  assert.equal(recs.find(r => r.taskId === 'bank#sell').status, 'not_found')
  const retries = c.__calls.filter(x => x.api === 'alarms.create' && String(x.args[0]).includes(':retry:'))
  assert.equal(retries.length, 0, '欄位漂移不是暫時性問題，重試沒有意義')
  const health = await he.getHealth()
  assert.equal(health.bank.status, 'partial')
  assert.ok(health.bank.reason.includes('1'), `原因要說明幾個值抓不到：${health.bank.reason}`)
})

test('全部值都抓不到：燈號轉紅', async () => {
  const { st, fe, he } = await fresh({
    ok: true,
    fields: { buy: { ok: false, error: 'not_found' }, sell: { ok: false, error: 'not_found' } }
  })
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const health = await he.getHealth()
  assert.equal(health.bank.status, 'selector_lost')
})

test('全部成功時燈號回綠', async () => {
  const { st, fe, he } = await fresh(BOTH_OK)
  await st.saveTask(multi())
  await he.setTaskHealth('bank', { status: 'selector_lost' })
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  assert.equal((await he.getHealth()).bank.status, 'ok')
})

test('表格整個找不到：不寫紀錄、照常重試', async () => {
  const { c, st, fe } = await fresh({ ok: false, error: 'not_found', snippet: '<div>' })
  await st.saveTask(multi())
  const rec = await fe.runTask(multi(), { slot: '2026-09-06T09:30', attempt: 1, ...FAST })
  assert.equal(rec, null)
  assert.equal((await st.getRecordsByDate('2026-09-06')).length, 0)
  const retries = c.__calls.filter(x => x.api === 'alarms.create' && String(x.args[0]).includes(':retry:'))
  assert.equal(retries.length, 1, '表格找不到才是該重試的狀況')
})

test('一個值備援、另一個正常：燈號黃，兩個值都有紀錄', async () => {
  const { st, fe, he } = await fresh({
    ok: true,
    fields: {
      buy: { ok: true, value: 31.2, raw: '31.2', status: 'fallback' },
      sell: { ok: true, value: 31.3, raw: '31.3', status: 'ok' }
    }
  })
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  assert.equal(recs.find(r => r.taskId === 'bank#buy').status, 'fallback')
  assert.equal((await he.getHealth()).bank.status, 'fallback')
})

test('只抓到部分列時整組標記 partial', async () => {
  const { st, fe } = await fresh({ ...BOTH_OK, partial: true })
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  assert.ok(recs.every(r => r.partial === true))
})

// ---- 單值任務完全不受影響 ----

test('單值任務的紀錄 taskId 仍是任務 id 本身', async () => {
  const { st, fe } = await fresh({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' })
  const single = {
    id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: { css: '#v' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  }
  await st.saveTask(single)
  await fe.runTask(single, { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  assert.equal(recs.length, 1)
  assert.equal(recs[0].taskId, 't1')
})

// ---- 告警 ----

const withAlert = (alerts) => multi({ alerts })

test('告警可以只套用在某一個值上', async () => {
  const { st, fe } = await fresh(BOTH_OK)
  // 門檻 31 兩個值都超過，唯一的差別是這條告警只指定 sell
  const t = withAlert([{ id: 'a1', type: 'gt', value: 31, enabled: true, field: 'sell' }])
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  assert.equal(recs.find(r => r.taskId === 'bank#sell').alert, true, '指定的值要命中')
  assert.ok(!recs.find(r => r.taskId === 'bank#buy').alert,
    '31.2 也超過門檻，但這條告警沒有指定它')
})

test('沒指定值的告警對每個值各自評估', async () => {
  const { st, fe } = await fresh(BOTH_OK)
  const t = withAlert([{ id: 'a1', type: 'gt', value: 31, enabled: true }])
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  assert.ok(recs.every(r => r.alert === true))
})

test('通知訊息用序列名稱，不是父任務名稱', async () => {
  const { c, st, fe } = await fresh(BOTH_OK)
  const t = withAlert([{ id: 'a1', type: 'gt', value: 31.25, enabled: true, field: 'sell' }])
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-06T09:30', ...FAST })
  const note = c.__calls.filter(x => x.api === 'notifications.create').pop()
  assert.ok(note, '命中告警要發通知')
  const text = JSON.stringify(note.args)
  assert.ok(text.includes('美金賣出'), `通知要說是哪一個值：${text}`)
})

test('告警去重記在子序列上，兩個值互不干擾', async () => {
  const { c, st, fe } = await fresh(BOTH_OK)
  const t = withAlert([{ id: 'a1', type: 'gt', value: 31, enabled: true }])
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-06T09:30', ...FAST })
  const log = await st.getAlertLog()
  assert.ok(log['bank#buy']?.a1, '買入的去重紀錄')
  assert.ok(log['bank#sell']?.a1, '賣出的去重紀錄')
  const notes = c.__calls.filter(x => x.api === 'notifications.create')
  assert.equal(notes.length, 2, '兩個值各自通知一次')
})

test('變動比例只跟自己這個值的前一筆比', async () => {
  const { st, fe } = await fresh(BOTH_OK)
  const t = withAlert([{ id: 'a1', type: 'deltaPct', value: 10, enabled: true }])
  await st.saveTask(t)
  // 買入的前一筆是 31.1（變動很小），賣出的前一筆是 20（變動超過 10%）
  await st.appendRecord('2026-09-06', { taskId: 'bank#buy', slot: '2026-09-06T09:00', capturedAt: '2026-09-06T01:00:00.000Z', value: 31.1, status: 'ok' })
  await st.appendRecord('2026-09-06', { taskId: 'bank#sell', slot: '2026-09-06T09:00', capturedAt: '2026-09-06T01:00:00.000Z', value: 20, status: 'ok' })
  await fe.runTask(t, { slot: '2026-09-06T09:30', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-06')
  const buy = recs.find(r => r.taskId === 'bank#buy' && r.slot === '2026-09-06T09:30')
  const sell = recs.find(r => r.taskId === 'bank#sell' && r.slot === '2026-09-06T09:30')
  assert.ok(!buy.alert, '買入只變動 0.3%，不該命中')
  assert.equal(sell.alert, true, '賣出從 20 變 31.3，該命中')
})

// ---- 預檢 ----

test('預檢：至少一個值成功就算通過', async () => {
  const { st, he } = await fresh({
    ok: true,
    fields: { buy: { ok: true, value: 31.2, raw: '31.2', status: 'ok' }, sell: { ok: false, error: 'not_found' } }
  })
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  const t = multi()
  await st.saveTask(t)
  await pc.runPrecheck(t, FAST)
  assert.equal((await he.getHealth()).bank.status, 'ok')
})

test('預檢：全部值都失敗才算失敗，原因說明是哪些值', async () => {
  const { c, st, he } = await fresh({
    ok: true,
    fields: { buy: { ok: false, error: 'not_found' }, sell: { ok: false, error: 'not_found' } }
  })
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  const t = multi()
  await st.saveTask(t)
  await pc.runPrecheck(t, FAST)
  const h = (await he.getHealth()).bank
  assert.equal(h.status, 'selector_lost')
  assert.ok(c.__calls.some(x => x.api === 'notifications.create'), '預檢失敗要通知')
})

test('預檢：單值任務的判定完全不變', async () => {
  const { st, he } = await fresh({ ok: true, value: 5, raw: '5', status: 'ok' })
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  const single = {
    id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: { css: '#v' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  }
  await st.saveTask(single)
  await pc.runPrecheck(single, FAST)
  assert.equal((await he.getHealth()).t1.status, 'ok')
})
