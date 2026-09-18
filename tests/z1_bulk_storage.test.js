// AF-19 作業 A：儲存層整批 API
// saveTasks / deleteTasks / deleteLastValues / countRecordsForTasks / pruneSeries
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
  return { c, st, ls }
}

const task = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }, ...over
})

const rec = (taskId, over = {}) => ({
  taskId, slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:12+08:00',
  value: 12, raw: '12', status: 'ok', ...over
})

const card = (over = {}) => ({
  type: 'number', x: 0, y: 0, w: 3, h: 2,
  source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over
})

// 數某個 api 被呼叫幾次（整批 API 的重點就是次數）
const countCalls = (c, api) => c.__calls.filter(x => x.api === api).length
const setsAfter = (c, api, mark) => c.__calls.slice(mark).filter(x => x.api === api).length
const mark = (c) => c.__calls.length

// ---- saveTasks ----

test('saveTasks 三筆一次寫入只有一次 storage.local.set', async () => {
  const { c, st } = await fresh()
  const m = mark(c)
  await st.saveTasks([task('a'), task('b'), task('d')])
  assert.equal(setsAfter(c, 'storage.local.set', m), 1, '整批寫入只能有一次 set')
  assert.deepEqual((await st.getTasks()).map(t => t.id), ['a', 'b', 'd'])
})

test('saveTasks 未指定 order 時依序補「目前最大 + 1」', async () => {
  const { st } = await fresh()
  await st.saveTask(task('a'))
  await st.saveTasks([task('b'), task('d')])
  const all = await st.getTasks()
  assert.deepEqual(all.map(t => t.id), ['a', 'b', 'd'])
  assert.deepEqual(all.map(t => t.order), [0, 1, 2])
})

test('saveTasks 同一批可混合新增與更新', async () => {
  const { st } = await fresh()
  await st.saveTask(task('a', { name: '舊' }))
  await st.saveTasks([task('a', { name: '新' }), task('b')])
  const all = await st.getTasks()
  assert.equal(all.length, 2)
  assert.equal(all.find(t => t.id === 'a').name, '新')
})

test('saveTasks 任一筆不合法就整批不寫（storage 完全不變）', async () => {
  const { st } = await fresh()
  await st.saveTask(task('a'))
  const before = JSON.stringify(await st.getTasks())
  await assert.rejects(
    () => st.saveTasks([task('b'), task('c', { name: '' }), task('d')]),
    /任務格式錯誤/
  )
  assert.equal(JSON.stringify(await st.getTasks()), before, '整批不寫：連合法的那幾筆也不能進去')
})

test('saveTasks 重複欄位 key 的例外訊息與單筆 saveTask 一字不差，並帶 index', async () => {
  const { st } = await fresh()
  const bad = task('b', { fields: [{ key: 'k1', name: '一' }, { key: 'k1', name: '二' }] })
  let single = null
  try { await st.saveTask(bad) } catch (e) { single = e }
  assert.ok(single, 'saveTask 單筆要丟例外')

  let batch = null
  try { await st.saveTasks([task('a'), bad]) } catch (e) { batch = e }
  assert.ok(batch, 'saveTasks 要丟例外')
  assert.equal(batch.message, single.message, '訊息文字必須完全相同（既有測試比對訊息）')
  assert.equal(batch.index, 1, '例外要指出是第幾筆')
})

test('saveTasks 空陣列不寫入也不丟錯', async () => {
  const { c, st } = await fresh()
  const m = mark(c)
  await st.saveTasks([])
  assert.equal(setsAfter(c, 'storage.local.set', m), 0)
})

test('saveTask 仍是單筆行為（回傳存好的任務、order 補值）', async () => {
  const { st } = await fresh()
  const saved = await st.saveTask(task('a'))
  assert.equal(saved.id, 'a')
  assert.equal(saved.order, 0)
  await assert.rejects(() => st.saveTask(task('b', { url: '' })), /任務格式錯誤/)
})

// ---- deleteTasks ----

test('deleteTasks 一次掃描刪掉多個任務與它們的紀錄', async () => {
  const { c, st } = await fresh()
  await st.saveTasks([task('a'), task('b'), task('d')])
  await st.appendRecords('2026-09-05', [rec('a'), rec('b'), rec('d')])
  await st.appendRecords('2026-09-06', [rec('a#k1'), rec('d')])

  const m = mark(c)
  await st.deleteTasks(['a', 'b'])
  assert.equal(setsAfter(c, 'storage.local.get', m) >= 1, true)
  const fullScans = c.__calls.slice(m).filter(x => x.api === 'storage.local.get' && (x.args[0] === null || x.args[0] === undefined)).length
  assert.equal(fullScans, 1, '整批刪除只能掃一次全部 storage')

  assert.deepEqual((await st.getTasks()).map(t => t.id), ['d'])
  assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['d'])
  assert.deepEqual((await st.getRecordsByDate('2026-09-06')).map(r => r.taskId), ['d'], '序列紀錄也要跟著父任務刪掉')
})

test('deleteTasks 讓某一天完全空掉時移除該日期鍵', async () => {
  const { st } = await fresh()
  await st.saveTasks([task('a'), task('b')])
  await st.appendRecords('2026-09-05', [rec('a')])
  await st.deleteTasks(['a'])
  assert.deepEqual(await st.listDates(), [], '該日期已無紀錄，鍵要移除')
})

test('deleteTask 仍可單獨使用且連動卡片清理', async () => {
  const { st, ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ source: [{ taskId: 't1', aggregation: 'raw' }] }))
  await st.saveTask(task('t1'))
  await st.deleteTask('t1')
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})

// ---- countRecordsForTasks ----

test('countRecordsForTasks 一次掃描回 total 與 byId', async () => {
  const { c, st } = await fresh()
  await st.appendRecords('2026-09-05', [rec('a'), rec('a#k1'), rec('b')])
  await st.appendRecords('2026-09-06', [rec('a'), rec('d')])

  const m = mark(c)
  const res = await st.countRecordsForTasks(['a', 'b'])
  const fullScans = c.__calls.slice(m).filter(x => x.api === 'storage.local.get' && (x.args[0] === null || x.args[0] === undefined)).length
  assert.equal(fullScans, 1, '整批計數只能掃一次')

  assert.equal(res.total, 4, 'a 三筆（含序列）+ b 一筆')
  assert.equal(res.byId.a, 3)
  assert.equal(res.byId.b, 1)
})

test('countRecordsForTasks 空清單回 0，未知 id 回 0', async () => {
  const { st } = await fresh()
  await st.appendRecords('2026-09-05', [rec('a')])
  assert.equal((await st.countRecordsForTasks([])).total, 0)
  const res = await st.countRecordsForTasks(['沒有這個'])
  assert.equal(res.total, 0)
  assert.equal(res.byId['沒有這個'], 0)
})

test('countRecordsForTask 單筆結果與整批一致', async () => {
  const { st } = await fresh()
  await st.appendRecords('2026-09-05', [rec('a'), rec('a#k1'), rec('b')])
  assert.equal(await st.countRecordsForTask('a'), 2)
  assert.equal((await st.countRecordsForTasks(['a'])).byId.a, 2)
})

// ---- deleteLastValues ----

test('deleteLastValues 只刪指定的序列鍵', async () => {
  const { st } = await fresh()
  await st.setLastValues({ 't1#k1': { value: 1 }, 't1#k2': { value: 2 }, 't2': { value: 3 } })
  await st.deleteLastValues(['t1#k1'])
  const lv = await st.getLastValues()
  assert.deepEqual(Object.keys(lv).sort(), ['t1#k2', 't2'])
})

test('deleteLastValues 空清單或不存在的鍵都不丟錯', async () => {
  const { st } = await fresh()
  await st.setLastValues({ 't1': { value: 1 } })
  await st.deleteLastValues([])
  await st.deleteLastValues(['沒有這個'])
  assert.deepEqual(Object.keys(await st.getLastValues()), ['t1'])
})

// ---- pruneSeries ----

test('pruneSeries 只移除指定序列的來源，其餘來源留著', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({
    source: [{ taskId: 't1#k1', aggregation: 'raw' }, { taskId: 't1#k2', aggregation: 'raw' }]
  }))
  await ls.pruneSeries(['t1#k1'])
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1, '還有來源就不能刪卡')
  assert.deepEqual(cards[0].source.map(s => s.taskId), ['t1#k2'])
})

test('pruneSeries 讓來源歸零的卡片整張移除', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ source: [{ taskId: 't1#k1', aggregation: 'raw' }] }))
  await ls.pruneSeries(['t1#k1'])
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})

test('pruneSeries 不動不相干的卡片', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ source: [{ taskId: 't9#kx', aggregation: 'raw' }] }))
  const before = JSON.stringify(await ls.getLayout())
  await ls.pruneSeries(['t1#k1'])
  assert.equal(JSON.stringify(await ls.getLayout()), before)
})

test('pruneSeries 也清 status 卡的 options.taskIds', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({
    type: 'status', source: [], options: { taskIds: ['t1#k1', 't1#k2'] }
  }))
  await ls.pruneSeries(['t1#k1'])
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].options.taskIds, ['t1#k2'])
})

test('pruneSeries 比對的是完整序列 id，不是父任務 id', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({
    source: [{ taskId: 't1#k1', aggregation: 'raw' }, { taskId: 't1#k2', aggregation: 'raw' }]
  }))
  await ls.pruneSeries(['t1'])
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1, '給父任務 id 不該把序列來源清光——那是 pruneCardsForTask 的事')
  assert.deepEqual(cards[0].source.map(s => s.taskId), ['t1#k1', 't1#k2'])
})

test('pruneSeries 空清單不改任何東西', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ source: [{ taskId: 't1#k1', aggregation: 'raw' }] }))
  const before = JSON.stringify(await ls.getLayout())
  await ls.pruneSeries([])
  assert.equal(JSON.stringify(await ls.getLayout()), before)
})

test('pruneCardsForTask 仍以父任務 id 清掉整個任務的來源', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({
    source: [{ taskId: 't1#k1', aggregation: 'raw' }, { taskId: 't2#k1', aggregation: 'raw' }]
  }))
  await ls.pruneCardsForTask('t1')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.deepEqual(cards[0].source.map(s => s.taskId), ['t2#k1'])
})

// ---- 既有逐筆迴圈改走整批 API ----

test('applyOrder 一次寫回全部順序（不再逐筆寫）', async () => {
  const { JSDOM } = await import('jsdom')
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const { c, st } = await fresh()
  await st.saveTasks([task('a'), task('b'), task('d')])
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())

  const m = mark(c)
  await ts.applyOrder(['d', 'a', 'b'])
  assert.equal(setsAfter(c, 'storage.local.set', m), 1, '重新排序只能寫一次')
  const all = await st.getTasks()
  assert.deepEqual(all.map(t => t.id), ['d', 'a', 'b'])
  assert.deepEqual(all.map(t => t.order), [0, 1, 2])
})

test('applyOrder 忽略清單中不存在的任務', async () => {
  const { JSDOM } = await import('jsdom')
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const { st } = await fresh()
  await st.saveTasks([task('a'), task('b')])
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  await ts.applyOrder(['b', '不存在', 'a'])
  assert.deepEqual((await st.getTasks()).map(t => t.id), ['b', 'a'])
})

test('popup 全部暫停一次寫回，並只送一次重建排程', async () => {
  const { JSDOM } = await import('jsdom')
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
  const { c, st } = await fresh()
  await st.saveTasks([task('a'), task('b'), task('d')])
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())

  const m = mark(c)
  await pp.handleToggleAll()
  assert.equal(setsAfter(c, 'storage.local.set', m), 1, '三個任務不該寫三次')
  assert.ok((await st.getTasks()).every(t => t.enabled === false))
  const rebuilds = c.__calls.slice(m).filter(x => x.api === 'runtime.sendMessage' && x.args[0]?.type === 'REBUILD_ALARMS')
  assert.equal(rebuilds.length, 1)
})
