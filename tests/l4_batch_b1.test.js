// AF-5 批次 B1：序列索引與儲存層
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const si = await import('../src/shared/series-index.js?t=' + Math.random())
  return { c, st, ls, si }
}

const single = (id = 't1', over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:30'] }, ...over
})

const multi = (id = 'bank', over = {}) => ({
  id, name: '臺銀匯率', url: 'https://bank.test/rate', mode: 'block', enabled: true,
  spec: { strategy: 'auto', mode: 'block', block: { aggregate: 'sum' } },
  fields: [
    { key: 'k1', name: '美金買入', cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '買入' } } },
    { key: 'k2', name: '美金賣出', cell: { row: { index: 0, header: '美金' }, col: { index: 4, header: '賣出' } } }
  ],
  schedule: { type: 'daily', times: ['09:30'] }, ...over
})

// ---- buildSeriesIndex ----

test('單值任務在索引裡就是它自己', async () => {
  const { si } = await fresh()
  const idx = si.buildSeriesIndex([single('t1')])
  assert.deepEqual(idx.seriesIds, ['t1'])
  assert.equal(idx.byId.t1.name, '任務t1')
  assert.equal(idx.byId.t1.shortName, '任務t1')
  assert.equal(idx.byId.t1.parentId, 't1')
  assert.equal(idx.byId.t1.fieldKey, '')
  assert.equal(idx.byId.t1.mode, 'number')
})

test('多值任務每個值一條序列，名稱是「任務 · 值」', async () => {
  const { si } = await fresh()
  const idx = si.buildSeriesIndex([multi()])
  assert.deepEqual(idx.seriesIds, ['bank#k1', 'bank#k2'])
  assert.equal(idx.byId['bank#k1'].name, '臺銀匯率 · 美金買入')
  assert.equal(idx.byId['bank#k1'].shortName, '美金買入')
  assert.equal(idx.byId['bank#k1'].parentId, 'bank')
  assert.equal(idx.byId['bank#k1'].fieldKey, 'k1')
  assert.equal(idx.byId['bank#k1'].mode, 'block')
})

test('父任務清單只含真正的任務，不含子序列', async () => {
  const { si } = await fresh()
  const idx = si.buildSeriesIndex([single('t1'), multi()])
  assert.deepEqual(Object.keys(idx.parents).sort(), ['bank', 't1'])
  assert.deepEqual(idx.childrenOf.bank, ['bank#k1', 'bank#k2'])
  assert.deepEqual(idx.childrenOf.t1, ['t1'])
})

test('序列順序 = 任務順序 × 值的順序', async () => {
  const { si } = await fresh()
  const idx = si.buildSeriesIndex([multi('b1'), single('t9'), multi('b2')])
  assert.deepEqual(idx.seriesIds, ['b1#k1', 'b1#k2', 't9', 'b2#k1', 'b2#k2'])
})

test('索引查不到的 id 不會爆，用 nameOf 拿到 id 本身', async () => {
  const { si } = await fresh()
  const idx = si.buildSeriesIndex([single('t1')])
  assert.equal(si.nameOf(idx, 'unknown'), 'unknown')
  assert.equal(si.nameOf(idx, 't1'), '任務t1')
})

test('只有一個值的 fields 也照多值處理', async () => {
  const { si } = await fresh()
  const idx = si.buildSeriesIndex([multi('b', { fields: [{ key: 'only', name: '收盤' }] })])
  assert.deepEqual(idx.seriesIds, ['b#only'])
  assert.equal(idx.byId['b#only'].name, '臺銀匯率 · 收盤')
})

test('空清單與壞資料不會爆', async () => {
  const { si } = await fresh()
  assert.deepEqual(si.buildSeriesIndex([]).seriesIds, [])
  assert.deepEqual(si.buildSeriesIndex(null).seriesIds, [])
  assert.deepEqual(si.buildSeriesIndex([null, { id: '' }]).seriesIds, [])
})

// ---- saveTask 的守門 ----

test('任務 id 不得含保留字元', async () => {
  const { st } = await fresh()
  await assert.rejects(() => st.saveTask(single('a#b')), /id/i)
})

test('值的 key 不得缺少或重複', async () => {
  const { st } = await fresh()
  await assert.rejects(() => st.saveTask(multi('b', { fields: [{ name: '沒有 key' }] })), /key/i)
  await assert.rejects(
    () => st.saveTask(multi('b', { fields: [{ key: 'x', name: '甲' }, { key: 'x', name: '乙' }] })),
    /key/i
  )
})

test('值的 key 不得含保留字元', async () => {
  const { st } = await fresh()
  await assert.rejects(() => st.saveTask(multi('b', { fields: [{ key: 'a#b', name: '甲' }] })), /key/i)
})

test('合法的多值任務存得進去且 fields 原樣保留', async () => {
  const { st } = await fresh()
  await st.saveTask(multi())
  const saved = await st.getTask('bank')
  assert.equal(saved.fields.length, 2)
  assert.equal(saved.fields[0].key, 'k1')
})

// ---- 刪除、計數、清卡都以父任務為準 ----

test('刪除多值任務會清掉它所有值的紀錄', async () => {
  const { st } = await fresh()
  await st.saveTask(multi())
  await st.appendRecord('2026-09-06', { taskId: 'bank#k1', slot: '2026-09-06T09:30', capturedAt: 'a', value: 31, status: 'ok' })
  await st.appendRecord('2026-09-06', { taskId: 'bank#k2', slot: '2026-09-06T09:30', capturedAt: 'b', value: 32, status: 'ok' })
  await st.deleteTask('bank')
  assert.equal((await st.getRecordsByDate('2026-09-06')).length, 0)
})

test('刪除任務不得誤刪 id 開頭相同的其他任務', async () => {
  const { st } = await fresh()
  await st.saveTask(single('abc'))
  await st.saveTask(single('abcd'))
  await st.appendRecord('2026-09-06', { taskId: 'abc', slot: '2026-09-06T09:30', capturedAt: 'a', value: 1, status: 'ok' })
  await st.appendRecord('2026-09-06', { taskId: 'abcd', slot: '2026-09-06T09:30', capturedAt: 'b', value: 2, status: 'ok' })
  await st.deleteTask('abc')
  const left = await st.getRecordsByDate('2026-09-06')
  assert.deepEqual(left.map(r => r.taskId), ['abcd'])
})

test('計數把所有值的紀錄都算進去', async () => {
  const { st } = await fresh()
  await st.saveTask(multi())
  await st.appendRecord('2026-09-06', { taskId: 'bank#k1', slot: '2026-09-06T09:30', capturedAt: 'a', value: 31, status: 'ok' })
  await st.appendRecord('2026-09-06', { taskId: 'bank#k2', slot: '2026-09-06T09:30', capturedAt: 'b', value: 32, status: 'ok' })
  await st.appendRecord('2026-09-06', { taskId: 'other', slot: '2026-09-06T09:30', capturedAt: 'c', value: 1, status: 'ok' })
  assert.equal(await st.countRecordsForTask('bank'), 2)
})

test('刪除多值任務會移除以它任一值為來源的卡片', async () => {
  const { st, ls } = await fresh()
  await st.saveTask(multi())
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 'bank#k1' }], options: {} })
  await ls.addCard(did, { type: 'line', x: 0, y: 0, w: 6, h: 3, source: [{ taskId: 'bank#k1' }, { taskId: 'bank#k2' }], options: {} })
  await st.deleteTask('bank')
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})

test('多來源卡片只掉被刪的那個任務的欄位', async () => {
  const { st, ls } = await fresh()
  await st.saveTask(multi())
  await st.saveTask(single('t9'))
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'table', x: 0, y: 0, w: 12, h: 3, source: [{ taskId: 'bank#k1' }, { taskId: 't9' }], options: { mode: 'pivot' } })
  await st.deleteTask('bank')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].source.map(s => s.taskId), ['t9'])
})

// ---- 設定匯入：壞任務不拖垮整批 ----

test('匯入時單一壞任務被跳過，其餘照常匯入', async () => {
  const { st } = await fresh()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  const payload = JSON.stringify({
    kind: 'autofetcher-settings',
    version: 1,
    data: { tasks: [single('good1'), { id: 'bad#id', name: '壞的', url: 'u' }, single('good2')], sites: {} }
  })
  const res = await io.importSettings(payload)
  const ids = (await st.getTasks()).map(t => t.id).sort()
  assert.deepEqual(ids, ['good1', 'good2'])
  assert.equal(res.skippedTasks, 1, '要回報跳過幾筆，不能靜默吞掉')
})
