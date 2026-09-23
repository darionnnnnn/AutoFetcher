// AF-21 段 1-B：帳本按日分鍵（runs:<date>）、紀錄按小時分鍵（rec2:<date>:<HH>）、全鍵操作不一次讀滿
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh({ init = true } = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  if (init) await st.init()
  return { c, st }
}

const dump = (c) => c.storage.local.get(null)
const mark = (c) => c.__calls.length
const callsSince = (c, m, api) => c.__calls.slice(m).filter(x => x.api === api)
const isFullGet = (x) => x.api === 'storage.local.get' && (x.args[0] === null || x.args[0] === undefined)

// 本地日期 n 天前（YYYY-MM-DD）
function localDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const task = (id) => ({
  id, name: '任務' + id, url: 'https://x.test/' + id, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

// ---------- 1. 帳本按日分鍵 ----------

test('帳本：同格寫兩次冪等，寫進 runs:<slot 日期>', async () => {
  const { c, st } = await fresh()
  await st.setRunStatus('t1', '2026-09-05T09:00', 'ok')
  await st.setRunStatus('t1', '2026-09-05T09:00', 'ok')
  const all = await dump(c)
  assert.deepEqual(all['runs:2026-09-05'], { t1: { '2026-09-05T09:00': 'ok' } })
  assert.equal('runs' in all, false, '不得再寫單一 runs 鍵')
  assert.equal(await st.getRunStatus('t1', '2026-09-05T09:00'), 'ok')
  assert.equal(await st.getRunStatus('t1', '2026-09-06T09:00'), undefined, '某日無鍵＝該日沒有格子')
})

test('帳本：getLedgerRange 跨兩天回傳兩天的格，範圍外不回，且不掃整個 storage', async () => {
  const { c, st } = await fresh()
  await st.setRunStatus('t1', '2026-09-05T09:00', 'ok')
  await st.setRunStatus('t1', '2026-09-06T09:00', 'error')
  await st.setRunStatus('t2', '2026-09-06T10:00', 'ok')
  await st.setRunStatus('t1', '2026-09-08T09:00', 'ok')
  const m = mark(c)
  const got = await st.getLedgerRange('2026-09-05', '2026-09-06')
  assert.deepEqual(got, {
    t1: { '2026-09-05T09:00': 'ok', '2026-09-06T09:00': 'error' },
    t2: { '2026-09-06T10:00': 'ok' }
  })
  assert.equal(c.__calls.slice(m).filter(isFullGet).length, 0, '不得 get(null)')
  assert.equal(callsSince(c, m, 'storage.local.getKeys').length, 0, '由日期列舉鍵，不取所有鍵名')
})

test('帳本：trimOldRuns 刪 14 天以前、保留以後；retentionDays 0 照樣清；一天只做一次', async () => {
  const { c, st } = await fresh()
  await st.saveSettings({ retentionDays: 0 })
  for (const d of ['2026-09-01', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-30']) {
    await st.setRunStatus('t1', d + 'T09:00', 'ok')
  }
  await st.trimOldRuns('2026-09-30')
  const keys = Object.keys(await dump(c)).filter(k => k.startsWith('runs:')).sort()
  assert.deepEqual(keys, ['runs:2026-09-16', 'runs:2026-09-30'])
  // 同一天再呼叫不再掃
  await st.setRunStatus('t1', '2026-09-02T09:00', 'ok')
  const m = mark(c)
  await st.trimOldRuns('2026-09-30')
  assert.equal(callsSince(c, m, 'storage.local.getKeys').length, 0, '同一天第二次不得再掃')
  assert.ok('runs:2026-09-02' in await dump(c))
})

test('帳本：deleteTasks 後各日 runs: 鍵不含被刪任務、空鍵被移除', async () => {
  const { c, st } = await fresh()
  await st.saveTasks([task('t1'), task('t2')])
  await st.setRunStatus('t1', '2026-09-05T09:00', 'ok')
  await st.setRunStatus('t2', '2026-09-05T09:00', 'ok')
  await st.setRunStatus('t1', '2026-09-06T09:00', 'ok')
  await st.deleteTasks(['t1'])
  const all = await dump(c)
  assert.deepEqual(all['runs:2026-09-05'], { t2: { '2026-09-05T09:00': 'ok' } })
  assert.equal('runs:2026-09-06' in all, false, '空了就刪鍵')
})

test('帳本：看門狗每日呼叫 trimOldRuns', async () => {
  const { c, st } = await fresh()
  await st.setRunStatus('t1', '2000-01-01T09:00', 'ok')
  await st.setRunStatus('t1', localDaysAgo(1) + 'T09:00', 'ok')
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await wd.runWatchdog()
  const all = await dump(c)
  assert.equal('runs:2000-01-01' in all, false)
  assert.ok(('runs:' + localDaysAgo(1)) in all)
})

// ---------- 2. v3 遷移 ----------

async function seedV2(c, runs, extra = {}) {
  await c.storage.local.set({ schemaVersion: 2, settings: { retentionDays: 365 }, runs, ...extra })
}

test('v3 遷移：3 天前進 runs:<date>、30 天前丟、舊鍵移除、schemaVersion 4', async () => {
  const { c, st } = await fresh({ init: false })
  const d3 = localDaysAgo(3)
  const d30 = localDaysAgo(30)
  await seedV2(c, { t1: { [d3 + 'T09:00']: 'ok', [d30 + 'T09:00']: 'ok' } })
  await st.init()
  const all = await dump(c)
  assert.deepEqual(all['runs:' + d3], { t1: { [d3 + 'T09:00']: 'ok' } })
  assert.equal(('runs:' + d30) in all, false)
  assert.equal('runs' in all, false)
  assert.equal(all.schemaVersion, 4)
})

test('v3 遷移：已有 runs:<date> 同日其他格時是併入不是覆蓋', async () => {
  const { c, st } = await fresh({ init: false })
  const d3 = localDaysAgo(3)
  await seedV2(c, { t1: { [d3 + 'T09:00']: 'ok' } }, {
    ['runs:' + d3]: { t1: { [d3 + 'T08:00']: 'error' }, t2: { [d3 + 'T10:00']: 'ok' } }
  })
  await st.init()
  assert.deepEqual((await dump(c))['runs:' + d3], {
    t1: { [d3 + 'T08:00']: 'error', [d3 + 'T09:00']: 'ok' },
    t2: { [d3 + 'T10:00']: 'ok' }
  })
})

test('v3 遷移：第一次寫 runs: 鍵時丟例外 → 重跑 init 結果與一次跑完相同（冪等）', async () => {
  const d2 = localDaysAgo(2)
  const d3 = localDaysAgo(3)
  const oldRuns = {
    t1: { [d3 + 'T09:00']: 'ok', [d2 + 'T09:00']: 'error' },
    t2: { [d2 + 'T10:00']: 'ok' }
  }
  // 基準：一次跑完
  const ref = await fresh({ init: false })
  await seedV2(ref.c, structuredClone(oldRuns))
  await ref.st.init()
  const expected = await dump(ref.c)
  assert.ok(Object.keys(expected).some(k => k.startsWith('runs:')), '基準要真的有遷出按日鍵')

  // 中途失敗再重跑
  const { c, st } = await fresh({ init: false })
  await seedV2(c, structuredClone(oldRuns))
  const origSet = c.storage.local.set
  let thrown = false
  c.storage.local.set = async (items) => {
    if (!thrown && Object.keys(items || {}).some(k => k.startsWith('runs:'))) {
      thrown = true
      throw new Error('模擬寫入失敗')
    }
    return origSet.call(c.storage.local, items)
  }
  await assert.rejects(() => st.init())
  assert.equal(thrown, true)
  c.storage.local.set = origSet
  await st.init()
  assert.deepEqual(await dump(c), expected)
})

// ---------- 3. 匯入比程式新的設定檔 ----------

test('匯入 schemaVersion 99 的設定檔：丟白話錯誤、storage 零改動', async () => {
  const { c, st } = await fresh()
  await st.saveTasks([task('t1')])
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  const before = structuredClone(await dump(c))
  const json = JSON.stringify({
    kind: 'autofetcher-settings', version: 1, exportedAt: new Date().toISOString(),
    data: { schemaVersion: 99, tasks: [task('t9')], sites: { 'https://x.test': { enabled: true } }, settings: { retentionDays: 1 }, layout: { dashboards: [] } }
  })
  const m = mark(c)
  await assert.rejects(() => io.importSettings(json), /這個設定檔來自較新的版本，請先更新 AutoFetcher/)
  assert.deepEqual(await dump(c), before)
  assert.equal(callsSince(c, m, 'storage.local.set').length + callsSince(c, m, 'storage.local.remove').length, 0)
})

test('匯出設定帶目前的 schemaVersion（4）', async () => {
  await fresh()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  const obj = JSON.parse(await io.exportSettings())
  assert.equal(obj.data.schemaVersion, 4)
})

// ---------- 4. 小時鍵 ----------

test('小時鍵：slot 09:30 寫進 rec2:2026-09-05:09；兩個小時各一筆 → 兩個鍵各一次 set；沒有新鍵以 rec: 開頭', async () => {
  const { c, st } = await fresh()
  const m0 = mark(c)
  await st.appendRecord('2026-09-05', { taskId: 'a', slot: '2026-09-05T09:30', capturedAt: '2026-09-05T01:30:00.000Z', value: 1 })
  const all0 = await dump(c)
  assert.ok('rec2:2026-09-05:09' in all0)
  assert.equal(callsSince(c, m0, 'storage.local.set').length, 1)

  const m = mark(c)
  await st.appendRecords('2026-09-06', [
    { taskId: 'a', slot: '2026-09-06T09:00', capturedAt: '2026-09-06T01:00:00.000Z', value: 1 },
    { taskId: 'b', slot: '2026-09-06T14:00', capturedAt: '2026-09-06T06:00:00.000Z', value: 2 },
    { taskId: 'c', slot: '2026-09-06T09:05', capturedAt: '2026-09-06T01:05:00.000Z', value: 3 }
  ])
  const sets = callsSince(c, m, 'storage.local.set').map(x => Object.keys(x.args[0]))
  assert.deepEqual(sets.flat().sort(), ['rec2:2026-09-06:09', 'rec2:2026-09-06:14'], '每組一次 set')
  const all = await dump(c)
  assert.deepEqual(all['rec2:2026-09-06:09'].map(r => r.taskId), ['a', 'c'])
  const recKeys = Object.keys(all).filter(k => k.startsWith('rec'))
  assert.ok(recKeys.length > 0)
  assert.deepEqual(recKeys.filter(k => k.startsWith('rec:')), [], '新紀錄鍵不得以 rec: 開頭（降版相容）')
})

test('小時鍵：沒有 slot 取 capturedAt 的本地小時，都沒有用 00', async () => {
  const { c, st } = await fresh()
  // Asia/Taipei：UTC 01:00 → 本地 09
  await st.appendRecords('2026-09-05', [
    { taskId: 'a', capturedAt: '2026-09-05T01:00:00.000Z', value: 1 },
    { taskId: 'b', value: 2 }
  ])
  const all = await dump(c)
  assert.deepEqual(all['rec2:2026-09-05:09'].map(r => r.taskId), ['a'])
  assert.deepEqual(all['rec2:2026-09-05:00'].map(r => r.taskId), ['b'])
})

test('lockNameOf：小時鍵與同日舊鍵共用 rec@<date>', async () => {
  const { lockNameOf } = await import('../src/shared/lock.js')
  assert.equal(lockNameOf('rec2:2026-09-05:09'), 'rec@2026-09-05')
  assert.equal(lockNameOf('rec:2026-09-05'), 'rec@2026-09-05')
  assert.equal(lockNameOf('runs:2026-09-05'), 'runs:2026-09-05')
})

test('subscribe：小時鍵變動會通知、runs:<date> 不會', async () => {
  const { c, st } = await fresh()
  let hits = 0
  st.subscribe(() => { hits++ })
  await c.storage.local.set({ 'runs:2026-09-05': { t1: { s: 'ok' } } })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(hits, 0)
  await st.appendRecord('2026-09-05', { taskId: 'a', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z' })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(hits, 1)
})

// ---------- 5. 三種資料狀態 ----------

const A = { taskId: 'a', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z', value: 1 }
const B = { taskId: 'b#k1', slot: '2026-09-05T10:00', capturedAt: '2026-09-05T02:00:00.000Z', value: 2 }
const STATES = ['legacy', 'hour', 'both']

async function seed(state) {
  const env = await fresh()
  const { c, st } = env
  if (state === 'legacy') await c.storage.local.set({ 'rec:2026-09-05': [A, B] })
  if (state === 'hour') await st.appendRecords('2026-09-05', [A, B])
  // 舊鍵放較晚的 B、小時鍵放較早的 A：合併後要依 capturedAt 排
  if (state === 'both') {
    await c.storage.local.set({ 'rec:2026-09-05': [B] })
    await st.appendRecords('2026-09-05', [A])
  }
  // 另一天、另一種鍵，當干擾
  await st.appendRecords('2026-09-07', [{ taskId: 'a', slot: '2026-09-07T09:00', capturedAt: '2026-09-07T01:00:00.000Z', value: 3 }])
  return env
}

for (const state of STATES) {
  test(`三態[${state}]：getRecordsByDate／getRecordsInRange／listDates／countRecordsForTasks`, async () => {
    const { st } = await seed(state)
    assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['a', 'b#k1'])
    const range = await st.getRecordsInRange('2026-09-05', '2026-09-07')
    assert.deepEqual(range.map(r => `${r.date}/${r.taskId}`), ['2026-09-05/a', '2026-09-05/b#k1', '2026-09-07/a'])
    const wide = await st.getRecordsInRange('2026-06-01', '2026-09-30')
    assert.deepEqual(wide.map(r => `${r.date}/${r.taskId}`), ['2026-09-05/a', '2026-09-05/b#k1', '2026-09-07/a'], '超過 62 天走鍵名清單也同結果')
    assert.deepEqual(await st.listDates(), ['2026-09-05', '2026-09-07'])
    assert.deepEqual(await st.countRecordsForTasks(['a', 'b']), { total: 3, byId: { a: 2, b: 1 } })
  })

  test(`三態[${state}]：deleteRecord 找得到兩種鍵，鍵空了就移除`, async () => {
    const { c, st } = await seed(state)
    await st.deleteRecord('2026-09-05', 'a', A.capturedAt)
    assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['b#k1'])
    await st.deleteRecord('2026-09-05', 'b#k1', B.capturedAt)
    assert.deepEqual(await st.getRecordsByDate('2026-09-05'), [])
    const left = Object.keys(await dump(c)).filter(k => k.includes('2026-09-05'))
    assert.deepEqual(left, [], '該日各鍵空了都要移除')
    assert.deepEqual(await st.listDates(), ['2026-09-07'])
    // 找不到時不改動
    const m = mark(c)
    await st.deleteRecord('2026-09-07', 'zzz', 'x')
    assert.equal(callsSince(c, m, 'storage.local.set').length + callsSince(c, m, 'storage.local.remove').length, 0)
  })

  test(`三態[${state}]：deleteTasks 連同序列紀錄刪掉`, async () => {
    const { st } = await seed(state)
    await st.saveTasks([task('a'), task('b')])
    await st.deleteTasks(['b'])
    assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['a'])
    await st.deleteTasks(['a'])
    assert.deepEqual(await st.listDates(), [])
  })

  test(`三態[${state}]：trimOldRecords 兩種鍵都清`, async () => {
    const { c, st } = await seed(state)
    await st.saveSettings({ retentionDays: 3 })
    await st.trimOldRecords('2026-09-08') // 保留 09-06 起
    assert.deepEqual(await st.listDates(), ['2026-09-07'])
    assert.deepEqual(Object.keys(await dump(c)).filter(k => k.includes('2026-09-05')), [])
  })

  test(`三態[${state}]：importRecords 對該日所有既有鍵去重，新紀錄進 rec2:`, async () => {
    const { c, st } = await seed(state)
    const C = { taskId: 'c', slot: '2026-09-05T15:00', capturedAt: '2026-09-05T07:00:00.000Z', value: 9 }
    const res = await st.importRecords({ days: [{ date: '2026-09-05', tasks: { a: { records: [A, B, C] } } }] })
    assert.deepEqual(res, { added: 1, skipped: 2 })
    assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['a', 'b#k1', 'c'])
    assert.deepEqual((await dump(c))['rec2:2026-09-05:15'], [C])
  })
}

// ---------- 6. 範圍讀取不掃 storage ----------

test('getRecordsInRange 7 天：沒有 get(null) 也沒有 getKeys；100 天走 getKeys；起日晚於訖日回 []', async () => {
  const { c, st } = await fresh()
  await st.appendRecords('2026-09-03', [A])
  let m = mark(c)
  const got = await st.getRecordsInRange('2026-09-01', '2026-09-07')
  assert.equal(got.length, 1, '要真的讀到資料')
  assert.equal(c.__calls.slice(m).filter(isFullGet).length, 0, '不得 get(null)')
  assert.equal(callsSince(c, m, 'storage.local.getKeys').length, 0, '不得 getKeys（不經 listDates）')

  m = mark(c)
  const wide = await st.getRecordsInRange('2026-06-01', '2026-09-08')
  assert.equal(wide.length, 1)
  assert.equal(callsSince(c, m, 'storage.local.getKeys').length, 1, '100 天要先取鍵名')
  assert.equal(c.__calls.slice(m).filter(isFullGet).length, 0)

  assert.deepEqual(await st.getRecordsInRange('2026-09-07', '2026-09-01'), [])
})

// ---------- 7. 同日順序 ----------

test('同日順序依 capturedAt；沒有 capturedAt 的排在最後', async () => {
  const { st } = await fresh()
  await st.appendRecords('2026-09-05', [
    { taskId: 'x', slot: '2026-09-05T11:00', capturedAt: '2026-09-05T03:00:00.000Z' },
    { taskId: 'y', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z' },
    { taskId: 'z', slot: '2026-09-05T08:00' }
  ])
  // 同一個小時內寫入順序顛倒也要排回來
  await st.appendRecords('2026-09-05', [{ taskId: 'w', slot: '2026-09-05T09:59', capturedAt: '2026-09-05T00:30:00.000Z' }])
  assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['w', 'y', 'x', 'z'])
  assert.deepEqual((await st.getRecordsInRange('2026-09-05', '2026-09-05')).map(r => r.taskId), ['w', 'y', 'x', 'z'])
})

// ---------- 8. 分批 ----------

test('countRecordsForTasks：120 個紀錄鍵下任一次 get 的鍵數 ≤ 50', async () => {
  const { c, st } = await fresh()
  const items = {}
  for (let i = 0; i < 120; i++) {
    const date = `2026-0${1 + Math.floor(i / 24) % 9}-${String(1 + (i % 24)).padStart(2, '0')}`
    items[`rec2:${date}:${String(i % 24).padStart(2, '0')}`] = [{ taskId: 'a', capturedAt: `x${i}` }]
  }
  await c.storage.local.set(items)
  const recKeys = Object.keys(await dump(c)).filter(k => k.startsWith('rec2:'))
  assert.equal(recKeys.length, 120)
  const m = mark(c)
  const res = await st.countRecordsForTasks(['a'])
  assert.equal(res.total, 120)
  const gets = callsSince(c, m, 'storage.local.get')
  assert.ok(gets.length >= 3, '120 鍵至少三批')
  for (const g of gets) {
    assert.ok(Array.isArray(g.args[0]) || typeof g.args[0] === 'string', '不得 get(null)')
    const n = Array.isArray(g.args[0]) ? g.args[0].length : 1
    assert.ok(n <= 50, `一次取了 ${n} 個鍵`)
  }
})

// ---------- 9. 用量估算不序列化金鑰與站台 ----------

test('getStorageStats 退路分支：序列化字串不含 cryptoKey 與 sites 的值', async () => {
  const { c, st } = await fresh()
  delete c.storage.local.getBytesInUse
  assert.equal(typeof c.storage.local.getBytesInUse, 'undefined')
  await c.storage.local.set({ cryptoKey: 'KEY-SECRET-123', sites: { 'https://x.test': { passwordEnc: 'SITE-SECRET-456' } } })
  await st.appendRecords('2026-09-05', [A])
  const seen = []
  const orig = JSON.stringify
  JSON.stringify = function (...args) {
    const out = orig.apply(this, args)
    if (typeof out === 'string') seen.push(out)
    return out
  }
  let stats
  try {
    stats = await st.getStorageStats()
  } finally {
    JSON.stringify = orig
  }
  assert.ok(seen.length > 0, '要真的走到估算分支')
  assert.ok(stats.bytes > 0)
  assert.equal(stats.recordCount, 1)
  assert.equal(stats.oldestDate, '2026-09-05')
  for (const s of seen) {
    assert.ok(!s.includes('KEY-SECRET-123'), 'cryptoKey 的值不得被序列化')
    assert.ok(!s.includes('SITE-SECRET-456'), 'sites 的值不得被序列化')
  }
})
