// AF-4 B2:表格卡片的列軸標頭、欄序、樞紐列數上限、容差合併、無 slot 紀錄的範圍比對
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const jd = new JSDOM('<!doctype html><body></body>')
globalThis.window = jd.window
globalThis.document = jd.window.document

const CR = await import('../src/ui/report/cards.js')

const rec = (taskId, slot, value, status = 'ok', over = {}) => ({
  taskId, slot, capturedAt: new Date(slot + ':00').toISOString(), value, raw: String(value), status,
  date: slot.slice(0, 10), ...over
})

const baseCtx = (over = {}) => ({
  records: [],
  tasksById: {
    t1: { id: 't1', name: '電費', mode: 'number' },
    t2: { id: 't2', name: '水費', mode: 'number' },
    t3: { id: 't3', name: '瓦斯', mode: 'number' }
  },
  health: {}, nextRuns: {}, missed: [],
  range: { from: '2026-09-01', to: '2026-09-30' },
  today: '2026-09-06',
  ...over
})

const tableCard = (over = {}) => ({
  id: 'c1', type: 'table', x: 0, y: 0, w: 12, h: 4,
  source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
  options: { mode: 'pivot' }, ...over
})

const heads = el => [...el.querySelectorAll('thead th')].map(th => th.textContent)
const bodyRows = el => [...el.querySelectorAll('tbody tr')]

test('樞紐表第一欄標頭預設是「時間」', () => {
  const records = [rec('t1', '2026-09-06T09:00', 1)]
  const el = CR.renderCard(tableCard(), baseCtx({ records }))
  assert.equal(heads(el)[0], '時間')
})

test('樞紐表第一欄標頭可以自訂', () => {
  const records = [rec('t1', '2026-09-06T09:00', 1)]
  const el = CR.renderCard(tableCard({ options: { mode: 'pivot', rowHeader: '抓取時刻' } }), baseCtx({ records }))
  assert.equal(heads(el)[0], '抓取時刻')
})

test('自訂標頭是空白或全空白字元時退回預設', () => {
  const records = [rec('t1', '2026-09-06T09:00', 1)]
  for (const bad of ['', '   ']) {
    const el = CR.renderCard(tableCard({ options: { mode: 'pivot', rowHeader: bad } }), baseCtx({ records }))
    assert.equal(heads(el)[0], '時間', `rowHeader=${JSON.stringify(bad)} 應退回預設`)
  }
})

test('欄序照 card.source 的順序,不是任務清單的順序', () => {
  const records = [rec('t1', '2026-09-06T09:00', 1), rec('t2', '2026-09-06T09:00', 2), rec('t3', '2026-09-06T09:00', 3)]
  const el = CR.renderCard(tableCard({
    source: [{ taskId: 't3' }, { taskId: 't1' }, { taskId: 't2' }]
  }), baseCtx({ records }))
  assert.deepEqual(heads(el).slice(1), ['瓦斯', '電費', '水費'])
})

test('樞紐表也吃列數上限,取最新的幾列', () => {
  const records = ['09:00', '09:10', '09:20', '09:30'].map((t, i) => rec('t1', `2026-09-06T${t}`, i))
  const el = CR.renderCard(tableCard({
    source: [{ taskId: 't1' }], options: { mode: 'pivot', limit: 2 }
  }), baseCtx({ records }))
  const rows = bodyRows(el)
  assert.equal(rows.length, 2, '樞紐表沒有上限時一個月的資料會渲染上千列')
  assert.ok(rows[0].textContent.includes('09:20'), `第一列應為 09:20,實得:${rows[0].textContent}`)
})

test('容差合併:設定 5 分鐘後,09:01 與 09:03 併成一列', () => {
  const records = [rec('t1', '2026-09-06T09:01', 1), rec('t2', '2026-09-06T09:03', 2)]
  const el = CR.renderCard(tableCard({ options: { mode: 'pivot', bucketMinutes: 5 } }), baseCtx({ records }))
  const rows = bodyRows(el)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].textContent.includes('09:00'))
  assert.ok(rows[0].textContent.includes('1') && rows[0].textContent.includes('2'))
})

test('沒設容差時兩筆各自成列(預設不合併)', () => {
  const records = [rec('t1', '2026-09-06T09:01', 1), rec('t2', '2026-09-06T09:03', 2)]
  const el = CR.renderCard(tableCard(), baseCtx({ records }))
  assert.equal(bodyRows(el).length, 2)
})

test('合併多筆的儲存格要在 title 說明合併了幾筆', () => {
  const records = [
    rec('t1', '2026-09-06T09:01', 1),
    rec('t1', '2026-09-06T09:02', 2),
    rec('t1', '2026-09-06T09:03', 3)
  ]
  const el = CR.renderCard(tableCard({
    source: [{ taskId: 't1' }], options: { mode: 'pivot', bucketMinutes: 5 }
  }), baseCtx({ records }))
  const td = bodyRows(el)[0].querySelectorAll('td')[1]
  assert.ok(/3/.test(td.getAttribute('title') || ''), `合併了 3 筆要在 title 說明,實得:${td.getAttribute('title')}`)
})

test('只有一筆的儲存格不加合併說明', () => {
  const records = [rec('t1', '2026-09-06T09:01', 1)]
  const el = CR.renderCard(tableCard({
    source: [{ taskId: 't1' }], options: { mode: 'pivot', bucketMinutes: 5 }
  }), baseCtx({ records }))
  const td = bodyRows(el)[0].querySelectorAll('td')[1]
  assert.ok(!td.getAttribute('title'), '沒合併就不該有 title 干擾')
})

test('複製 TSV 的第一欄標頭跟著自訂的列軸標頭走', () => {
  const records = [rec('t1', '2026-09-06T09:00', 1)]
  const el = CR.renderCard(tableCard({ options: { mode: 'pivot', rowHeader: '抓取時刻' } }), baseCtx({ records }))
  const btn = el.querySelector('[data-action="copy-tsv"]')
  assert.ok(btn, '要有複製 TSV 按鈕')
  let copied = ''
  const before = globalThis.navigator
  globalThis.navigator = { clipboard: { writeText: (t) => { copied = t; return Promise.resolve() } } }
  try {
    btn.dispatchEvent(new window.Event('click'))
  } finally {
    globalThis.navigator = before
  }
  assert.ok(copied.startsWith('抓取時刻'), `TSV 首欄應為抓取時刻,實得:${copied.slice(0, 20)}`)
})

test('沒有 slot 的紀錄用 capturedAt 判斷是否落在期間內,不再一律保留', () => {
  const records = [
    { taskId: 't1', capturedAt: new Date('2026-08-01T09:00:00').toISOString(), value: 99, raw: '99', status: 'ok' },
    rec('t1', '2026-09-06T09:00', 1)
  ]
  const el = CR.renderCard(tableCard({ source: [{ taskId: 't1' }] }),
    baseCtx({ records, range: { from: '2026-09-01', to: '2026-09-30' } }))
  assert.ok(!el.textContent.includes('99'), '八月的紀錄不該出現在九月的範圍裡')
  assert.ok(el.textContent.includes('1'))
})

test('最近 N 筆模式不受列軸標頭與容差設定影響', () => {
  const records = [rec('t1', '2026-09-06T09:01', 1), rec('t1', '2026-09-06T09:03', 2)]
  const el = CR.renderCard(tableCard({
    source: [{ taskId: 't1' }],
    options: { mode: 'recent', rowHeader: '抓取時刻', bucketMinutes: 5 }
  }), baseCtx({ records }))
  assert.equal(bodyRows(el).length, 2, '最近 N 筆是逐筆列出,不合併')
  assert.equal(heads(el)[0], '時間', '最近 N 筆模式的欄位是固定的四欄')
})
