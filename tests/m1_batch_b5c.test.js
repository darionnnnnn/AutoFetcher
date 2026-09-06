// AF-5 批次 B5c：樞紐表差異欄與趨勢浮層
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const bank = () => ({
  id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
  spec: { strategy: 'auto', mode: 'block', fields: [{ key: 'k1' }, { key: 'k2' }] },
  fields: [{ key: 'k1', name: '美金買入' }, { key: 'k2', name: '美金賣出' }],
  schedule: { type: 'daily', times: ['09:30'] }, order: 0
})

const rec = (taskId, slot, value, status = 'ok') => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status
})

const DAYS = [
  rec('bank#k1', '2026-09-04T09:30', 31.0), rec('bank#k2', '2026-09-04T09:30', 31.5),
  rec('bank#k1', '2026-09-05T09:30', 31.2), rec('bank#k2', '2026-09-05T09:30', 31.6),
  rec('bank#k1', '2026-09-06T09:30', 30.9), rec('bank#k2', '2026-09-06T09:30', 31.4)
]

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  return { st, ls, CR, doc: jd.window.document, win: jd.window }
}

const ctxOf = (over = {}) => ({
  records: DAYS,
  tasksById: {
    'bank#k1': { id: 'bank#k1', name: '臺銀 · 美金買入', shortName: '美金買入', parentId: 'bank', mode: 'block' },
    'bank#k2': { id: 'bank#k2', name: '臺銀 · 美金賣出', shortName: '美金賣出', parentId: 'bank', mode: 'block' }
  },
  parentTasksById: { bank: bank() },
  health: {}, nextRuns: {}, missed: [], cards: [],
  range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06',
  editing: false, ...over
})

const pivotCard = (over = {}) => ({
  id: 'c1', type: 'table', x: 0, y: 0, w: 12, h: 4,
  source: [{ taskId: 'bank#k1' }, { taskId: 'bank#k2' }],
  options: { mode: 'pivot', bucketMinutes: 1440, ...(over.options || {}) },
  ...over
})

// ---- 差異欄 ----

test('開啟差異欄時每格附上與上一列的差', async () => {
  const { CR } = await fresh()
  const el = CR.renderCard(pivotCard({ options: { mode: 'pivot', bucketMinutes: 1440, showDelta: true } }), ctxOf())
  const deltas = [...el.querySelectorAll('[data-delta]')].map(d => d.textContent.trim())
  assert.ok(deltas.length > 0, '要看得到差值')
  assert.ok(deltas.some(d => d.includes('0.2')), `09-05 的買入比 09-04 多 0.2：${deltas.join(' / ')}`)
})

test('第一列沒有上一列可以比，不顯示差值', async () => {
  const { CR } = await fresh()
  const el = CR.renderCard(pivotCard({ options: { mode: 'pivot', bucketMinutes: 1440, showDelta: true } }), ctxOf())
  const firstRow = el.querySelectorAll('tbody tr')[0]
  assert.equal(firstRow.querySelector('[data-delta]'), null)
})

test('沒有前一筆成功值時不補零也不內插', async () => {
  const { CR } = await fresh()
  const records = [
    rec('bank#k1', '2026-09-04T09:30', 31.0),
    rec('bank#k1', '2026-09-05T09:30', null, 'not_found'),
    rec('bank#k1', '2026-09-06T09:30', 30.9)
  ]
  const el = CR.renderCard(
    pivotCard({ source: [{ taskId: 'bank#k1' }], options: { mode: 'pivot', bucketMinutes: 1440, showDelta: true } }),
    ctxOf({ records })
  )
  const text = el.textContent
  assert.ok(!text.includes('0.0'), `缺值那列不得算出假的差：${text}`)
})

test('沒開差異欄時完全不出現', async () => {
  const { CR } = await fresh()
  const el = CR.renderCard(pivotCard(), ctxOf())
  assert.equal(el.querySelector('[data-delta]'), null)
})

test('複製為 TSV 時不含差值', async () => {
  const { CR } = await fresh()
  const el = CR.renderCard(pivotCard({ options: { mode: 'pivot', bucketMinutes: 1440, showDelta: true } }), ctxOf())
  const tsv = el.dataset.tsv || ''
  assert.ok(!tsv.includes('↑') && !tsv.includes('↓'), '貼進試算表的是值，不是箭頭')
})

// ---- 趨勢浮層 ----

test('非編輯模式點樞紐表欄標會開趨勢浮層', async () => {
  const { CR, doc } = await fresh()
  const el = CR.renderCard(pivotCard(), ctxOf())
  doc.body.appendChild(el)
  const th = [...el.querySelectorAll('thead th')].find(t => t.textContent.includes('美金買入'))
  th.click()
  await new Promise(r => setTimeout(r, 20))
  const pop = doc.querySelector('[data-trend-popover]')
  assert.ok(pop, '點欄標要看得到趨勢')
  assert.ok(pop.querySelector('svg'), '浮層裡要有折線')
  assert.ok(pop.textContent.includes('美金買入'))
})

test('編輯模式下點欄標不開浮層', async () => {
  const { CR, doc } = await fresh()
  const el = CR.renderCard(pivotCard(), ctxOf({ editing: true }))
  doc.body.appendChild(el)
  const th = [...el.querySelectorAll('thead th')].find(t => t.textContent.includes('美金買入'))
  th.click()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(doc.querySelector('[data-trend-popover]'), null, '編輯模式要留給拖曳')
})

test('浮層可以把這條序列加成折線卡', async () => {
  const { CR, ls, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const el = CR.renderCard(pivotCard(), ctxOf({ dashId: did }))
  doc.body.appendChild(el)
  const th = [...el.querySelectorAll('thead th')].find(t => t.textContent.includes('美金買入'))
  th.click()
  await new Promise(r => setTimeout(r, 20))
  doc.querySelector('[data-trend-add]').click()
  await new Promise(r => setTimeout(r, 40))
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.ok(cards.some(c => c.type === 'line' && c.source.some(s => s.taskId === 'bank#k1')))
})

test('浮層可以一次比較其他任務的同名值', async () => {
  const { CR, doc } = await fresh()
  const ctx = ctxOf({
    tasksById: {
      ...ctxOf().tasksById,
      'other#x': { id: 'other#x', name: '玉山 · 美金買入', shortName: '美金買入', parentId: 'other', mode: 'block' }
    },
    parentTasksById: { bank: bank(), other: { id: 'other', name: '玉山' } },
    records: [...DAYS, rec('other#x', '2026-09-06T09:30', 31.1)]
  })
  const el = CR.renderCard(pivotCard(), ctx)
  doc.body.appendChild(el)
  const th = [...el.querySelectorAll('thead th')].find(t => t.textContent.includes('美金買入'))
  th.click()
  await new Promise(r => setTimeout(r, 20))
  const cmp = doc.querySelector('[data-trend-compare]')
  assert.ok(cmp, '要有一鍵比較同名值')
  cmp.click()
  await new Promise(r => setTimeout(r, 30))
  const pop = doc.querySelector('[data-trend-popover]')
  assert.ok(pop.textContent.includes('玉山'), `比較後要看到另一家：${pop.textContent}`)
})

test('點數值卡也開得出趨勢', async () => {
  const { CR, doc } = await fresh()
  const el = CR.renderCard({
    id: 'n1', type: 'number', x: 0, y: 0, w: 3, h: 2,
    source: [{ taskId: 'bank#k1' }], options: {}
  }, ctxOf())
  doc.body.appendChild(el)
  el.querySelector('.card-number-value').click()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(doc.querySelector('[data-trend-popover]'))
})

test('再點一次或按 Esc 關掉浮層', async () => {
  const { CR, doc, win } = await fresh()
  const el = CR.renderCard(pivotCard(), ctxOf())
  doc.body.appendChild(el)
  const th = [...el.querySelectorAll('thead th')].find(t => t.textContent.includes('美金買入'))
  th.click()
  await new Promise(r => setTimeout(r, 20))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(doc.querySelector('[data-trend-popover]'), null)
})
