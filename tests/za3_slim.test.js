// AF-21 段 1-C：紀錄瘦身（snippet 不進紀錄、raw 截斷只在寫紀錄那一層、anchor 上限）＋孤兒鍵清理
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

async function fresh(tabRes) {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  if (tabRes) c.__setTabResponder((tabId, msg) => (msg?.type === 'EXTRACT' ? tabRes : { ok: true }))
  return { c, st, fe }
}

// 立即測試走使用者開著的分頁（tabId），框架探測回空
function prepDry(c) {
  c.__setTabState(1, { url: 'https://a.test/p', status: 'complete' })
  c.__setScriptResponder(() => [])
}

const single = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const multi = () => ({
  id: 'bank', name: '匯率', url: 'https://a.test/p', mode: 'block', enabled: true,
  locator: { css: '#rate', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto', mode: 'block', fields: [{ key: 'buy' }, { key: 'sell' }] },
  fields: [{ key: 'buy', name: '買入' }, { key: 'sell', name: '賣出' }],
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
})

const RAW600 = 'x'.repeat(600)
const RAW500 = 'y'.repeat(500)

// ---- 驗收 1：snippet 不進紀錄 ----

test('驗收1：not_found 帶 snippet → 寫進 storage 的紀錄沒有 snippet 鍵', async () => {
  const { st, fe } = await fresh({ ok: false, error: 'not_found', snippet: '<div>token=abc</div>' })
  await st.saveTask(single())
  await fe.runTask(single(), { slot: '2026-09-05T09:00', attempt: 3, ...FAST })
  const recs = await st.getRecordsByDate('2026-09-05')
  assert.equal(recs.length, 1)
  assert.equal(recs[0].status, 'not_found')
  assert.equal('snippet' in recs[0], false, '頁面片段不得落地')
})

test('驗收1：同一情境的立即測試（dryRun）仍回傳 snippet 與診斷包', async () => {
  const { c, st, fe } = await fresh({ ok: false, error: 'not_found', snippet: '<div>token=abc</div>' })
  prepDry(c)
  const res = await fe.runTask(single(), { dryRun: true, reason: 'manual', tabId: 1, ...FAST })
  assert.equal(res.snippet, '<div>token=abc</div>', '試抓時使用者要看得到')
  assert.ok(res.debug, '失敗要附診斷包')
  assert.equal((await st.getRecordsByDate(new Date().toISOString().slice(0, 10))).length, 0, '試抓不寫紀錄')
})

// ---- 驗收 2：raw 截斷只在寫紀錄那一層 ----

test('驗收2 單值：600 字 raw → 紀錄 500 字＋rawTruncated；立即測試仍回 600 字', async () => {
  const { c, st, fe } = await fresh({ ok: true, value: 1, raw: RAW600, status: 'ok', strategyUsed: 'block', layer: 'css' })
  await st.saveTask(single())
  await fe.runTask(single(), { slot: '2026-09-05T09:00', ...FAST })
  const [rec] = await st.getRecordsByDate('2026-09-05')
  assert.equal(rec.raw.length, 500)
  assert.equal(rec.raw, RAW600.slice(0, 500))
  assert.equal(rec.rawTruncated, true)
  prepDry(c)
  const res = await fe.runTask(single(), { dryRun: true, reason: 'manual', tabId: 1, ...FAST })
  assert.equal(res.raw.length, 600, '截錯層：立即測試不得截')
  assert.equal('rawTruncated' in res, false)
})

test('驗收2 單值：500 字 raw → 原樣、沒有 rawTruncated 鍵', async () => {
  const { st, fe } = await fresh({ ok: true, value: 1, raw: RAW500, status: 'ok', strategyUsed: 'block', layer: 'css' })
  await st.saveTask(single())
  await fe.runTask(single(), { slot: '2026-09-05T09:00', ...FAST })
  const [rec] = await st.getRecordsByDate('2026-09-05')
  assert.equal(rec.raw, RAW500)
  assert.equal('rawTruncated' in rec, false)
})

test('驗收2 多值：600 字截、500 字原樣；立即測試的 fields 仍是 600 字', async () => {
  const RES = {
    ok: true,
    fields: {
      buy: { ok: true, value: 1, raw: RAW600, status: 'ok' },
      sell: { ok: true, value: 2, raw: RAW500, status: 'ok' }
    }
  }
  const { c, st, fe } = await fresh(RES)
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-05T09:00', ...FAST })
  const recs = await st.getRecordsByDate('2026-09-05')
  const buy = recs.find(r => r.taskId === 'bank#buy')
  const sell = recs.find(r => r.taskId === 'bank#sell')
  assert.ok(buy && sell, `兩個值都要有紀錄：${JSON.stringify(recs.map(r => r.taskId))}`)
  assert.equal(buy.raw.length, 500)
  assert.equal(buy.rawTruncated, true)
  assert.equal(sell.raw, RAW500)
  assert.equal('rawTruncated' in sell, false)
  prepDry(c)
  const res = await fe.runTask(multi(), { dryRun: true, reason: 'manual', tabId: 1, ...FAST })
  assert.equal(res.fields.buy.raw.length, 600, '截錯層：立即測試不得截')
})

test('驗收2 多值失敗值：600 字 raw 也截（失敗紀錄同一條寫入路徑）', async () => {
  const { st, fe } = await fresh({ ok: true, fields: { buy: { ok: false, error: 'parse_error', raw: RAW600 }, sell: { ok: true, value: 2, raw: '2' } } })
  await st.saveTask(multi())
  await fe.runTask(multi(), { slot: '2026-09-05T09:00', ...FAST })
  const buy = (await st.getRecordsByDate('2026-09-05')).find(r => r.taskId === 'bank#buy')
  assert.equal(buy.raw.length, 500)
  assert.equal(buy.rawTruncated, true)
})

// ---- 驗收 3：JSON 匯出剝掉舊紀錄的 snippet ----

test('驗收3：JSON 匯出一筆帶 snippet 的舊紀錄 → 輸出不含 snippet，其他欄位原樣', async () => {
  const { st } = await fresh()
  await st.saveTask(single())
  const old = { taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:03.000Z', status: 'not_found', snippet: '<div>secret</div>', error: '找不到' }
  await st.appendRecord('2026-09-05', old)
  const ex = await import('../src/shared/export.js?t=' + Math.random())
  const { content: text } = await ex.buildExport({ from: '2026-09-05', to: '2026-09-05', format: 'json' })
  assert.equal(text.includes('snippet'), false)
  assert.equal(text.includes('secret'), false)
  const parsed = JSON.parse(text)
  const recs = parsed.tasks.t1.records
  const { snippet, ...rest } = old
  assert.deepEqual(recs[0], rest)
})

// ---- 驗收 4：anchor 上限 ----

test('驗收4：前一個兄弟文字 121 字 → anchor 為 null；120 字 → 有 anchor', async () => {
  const { describe: describeEl } = await import('../src/shared/selector.js')
  const mk = (n) => new JSDOM(`<!doctype html><body><div><p>  ${'字'.repeat(n)}  </p><span>12</span></div></body>`).window.document.querySelector('span')
  assert.equal(describeEl(mk(121)).anchor, null)
  const a = describeEl(mk(120)).anchor
  assert.ok(a)
  assert.equal(a.text, '字'.repeat(120), 'trim 後量長度')
})

// ---- 驗收 5：pruneOrphanEntries ----

async function seedOrphans(c, st) {
  await st.saveTask(single({ id: 'live' }))
  await c.storage.local.set({
    sites: { 'https://keep.test': { username: 'u' } },
    alertLog: { 'live#a': { x: 1 }, 'gone#a': { x: 1 }, gone2: { x: 1 }, live: { y: 2 } },
    lastValues: { 'live#a': { value: 1 }, 'gone#b': { value: 2 }, gone3: { value: 3 } },
    health: { live: { status: 'ok' }, gone: { status: 'x' }, 'site:https://keep.test': { status: 'ok' }, 'site:https://gone.test': { status: 'x' } }
  })
}

test('驗收5：已刪任務（序列與單值兩種鍵）與已刪站台全部清掉，現存的保留', async () => {
  const { c, st } = await fresh()
  await seedOrphans(c, st)
  await st.pruneOrphanEntries()
  const got = await c.storage.local.get(['alertLog', 'lastValues', 'health'])
  assert.deepEqual(Object.keys(got.alertLog).sort(), ['live', 'live#a'])
  assert.deepEqual(Object.keys(got.lastValues).sort(), ['live#a'])
  assert.deepEqual(Object.keys(got.health).sort(), ['live', 'site:https://keep.test'])
  assert.deepEqual(got.alertLog.live, { y: 2 }, '現存項目內容不動')
})

test('驗收5：什麼都不用清時零次 set', async () => {
  const { c, st } = await fresh()
  await st.saveTask(single({ id: 'live' }))
  await c.storage.local.set({
    sites: { 'https://keep.test': {} },
    alertLog: { 'live#a': {} }, lastValues: { live: {} }, health: { live: {}, 'site:https://keep.test': {} }
  })
  c.__calls.length = 0
  await st.pruneOrphanEntries()
  assert.equal(c.__calls.filter(x => x.api === 'storage.local.set' || x.api === 'storage.local.remove').length, 0)
})

// ---- 驗收 6：看門狗一天只清一次 ----

test('驗收6：看門狗一天內跑兩次只清一次', async () => {
  const { c, st } = await fresh()
  await seedOrphans(c, st)
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await wd.runWatchdog()
  let h = (await c.storage.local.get('health')).health
  assert.equal('gone' in h, false, '第一次要清')
  await c.storage.local.set({ health: { ...h, gone: { status: 'x' } } })
  await wd.runWatchdog()
  h = (await c.storage.local.get('health')).health
  assert.equal('gone' in h, true, '同一天第二次不得再清')
})
