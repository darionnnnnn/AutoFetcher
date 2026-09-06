// AF-5 批次 B5：報表接線（名稱索引、側欄、拖曳、抽屜、範本、歷史頁）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const multi = (id = 'bank', over = {}) => ({
  id, name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
  spec: { strategy: 'auto', mode: 'block', fields: [{ key: 'k1' }, { key: 'k2' }] },
  fields: [{ key: 'k1', name: '美金買入' }, { key: 'k2', name: '美金賣出' }],
  schedule: { type: 'daily', times: ['09:30'] }, order: 0, ...over
})

const single = (id = 't9', over = {}) => ({
  id, name: '總量', url: 'https://x.test/a', mode: 'number', enabled: true,
  spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:30'] }, order: 1, ...over
})

const rec = (taskId, slot, value, status = 'ok') => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status
})

function stubGeometry(win, doc) {
  const grid = doc.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 })
  win.HTMLElement.prototype.getBoundingClientRect = win.HTMLElement.prototype.getBoundingClientRect ||
    (() => ({ left: 0, top: 0, width: 100, height: 80, right: 100, bottom: 80 }))
  return grid
}

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return { c, st, ls, doc: jd.window.document, win: jd.window }
}

// ---- 名稱解析走索引 ----

test('卡片標題用完整序列名', async () => {
  const { st, ls, doc, win } = await fresh()
  await st.saveTask(multi())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 'bank#k1' }], options: {} })
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  assert.equal(doc.querySelector('.card-title').textContent, '臺銀 · 美金買入')
})

test('狀態卡只列父任務，不把值當成任務', async () => {
  const { st, ls, doc, win } = await fresh()
  await st.saveTask(multi())
  await st.saveTask(single())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'status', x: 0, y: 0, w: 6, h: 2, source: [], options: {} })
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  const names = [...doc.querySelectorAll('.status-name')].map(el => el.textContent)
  assert.equal(names.length, 2, `狀態卡列任務不列值，實得 ${names.join(' / ')}`)
  assert.ok(!names.some(n => n.includes('·')))
})

test('折線圖例用完整序列名', async () => {
  const { st, ls, doc, win } = await fresh()
  await st.saveTask(multi())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, {
    type: 'line', x: 0, y: 0, w: 12, h: 3,
    source: [{ taskId: 'bank#k1' }, { taskId: 'bank#k2' }], options: {}
  })
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  const labels = [...doc.querySelectorAll('.chart-legend-item')].map(el => el.textContent)
  assert.ok(labels.some(l => l.includes('美金買入')), `圖例：${labels.join(' / ')}`)
})

// ---- 歷史頁 ----

test('歷史頁的任務篩選列出值，父任務可以一次全選', async () => {
  const { st, doc } = await fresh()
  await st.saveTask(multi())
  await st.saveTask(single())
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  await rp.renderFilters()
  const boxes = [...doc.querySelectorAll('#filter-tasks input[type="checkbox"]')]
  const values = boxes.map(b => b.value)
  assert.ok(values.includes('bank#k1') && values.includes('bank#k2'), `篩選要列到值：${values.join(',')}`)
  const parent = boxes.find(b => b.value === 'bank')
  assert.ok(parent, '父任務要有一個一次全選的勾選框')
})

test('歷史樞紐表的欄是序列，多值任務的紀錄不會整批消失', async () => {
  const { st, doc } = await fresh()
  await st.saveTask(multi())
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  const records = [rec('bank#k1', '2026-09-06T09:30', 31.2), rec('bank#k2', '2026-09-06T09:30', 31.3)]
  rp.renderPivot(records, [multi()])
  const headers = [...doc.querySelectorAll('#record-table thead th')].map(el => el.textContent)
  assert.ok(headers.some(h => h.includes('美金買入')), `樞紐表欄標：${headers.join(' / ')}`)
  const cells = [...doc.querySelectorAll('#record-table tbody td')].map(el => el.textContent)
  assert.ok(cells.includes('31.2'), '值要出現在表格裡')
})

test('歷史頁狀態網址帶得動含保留字元的序列 id', async () => {
  const lg = await import('../src/ui/report/logic.js?t=' + Math.random())
  const hash = lg.buildHash({ from: '2026-09-01', to: '2026-09-06', taskIds: ['bank#k1', 'bank#k2'] })
  const parsed = lg.parseHash(hash)
  assert.deepEqual(parsed.taskIds, ['bank#k1', 'bank#k2'], '保留字元要編碼，否則網址會被截斷')
})

// ---- 抽屜（X6：不得靜默丟掉來源）----

test('多值樞紐表在抽屜改標題後欄位一個都不能少', async () => {
  const { st, ls, doc, win } = await fresh()
  await st.saveTask(multi())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  const card = await ls.addCard(did, {
    type: 'table', x: 0, y: 0, w: 12, h: 3,
    source: [{ taskId: 'bank#k1' }, { taskId: 'bank#k2' }], options: { mode: 'pivot' }
  })
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  await dw.openDrawer(did, card.id)
  const title = doc.getElementById('drawer-title')
  title.value = '匯率明細'
  title.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const after = (await ls.getLayout()).dashboards[0].cards.find(c => c.id === card.id)
  assert.deepEqual(after.source.map(s => s.taskId), ['bank#k1', 'bank#k2'])
})

test('抽屜的來源清單列得出多值任務的每個值', async () => {
  const { st, ls, doc, win } = await fresh()
  await st.saveTask(multi())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  const card = await ls.addCard(did, { type: 'line', x: 0, y: 0, w: 12, h: 3, source: [{ taskId: 'bank#k1' }], options: {} })
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  await dw.openDrawer(did, card.id)
  const values = [...doc.querySelectorAll('#drawer-sources input[type="checkbox"]')].map(b => b.value)
  assert.ok(values.includes('bank#k1') && values.includes('bank#k2'), `來源清單：${values.join(',')}`)
  const checked = [...doc.querySelectorAll('#drawer-sources input:checked')].map(b => b.value)
  assert.deepEqual(checked, ['bank#k1'])
})

// ---- 範本（X5：不得清空）----

test('全是多值任務時套用總覽範本不會把儀表板清空', async () => {
  const { st, ls } = await fresh()
  await st.saveTask(multi())
  const tp = await import('../src/ui/report/templates.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  await tp.applyTemplate(did, 'overview')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.ok(cards.length > 0, '多值任務也該產得出範本卡片')
  const sources = cards.flatMap(c => c.source.map(s => s.taskId))
  assert.ok(sources.includes('bank#k1'), '範本要用得到每個值')
})

test('範本產不出卡片時保留原本的版面', async () => {
  const { st, ls } = await fresh()
  await st.saveTask(single('t9', { mode: 'text' }))
  const tp = await import('../src/ui/report/templates.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'text', x: 0, y: 0, w: 3, h: 2, source: [], options: { content: '手寫的' } })
  await tp.applyTemplate(did, 'overview')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1, '產不出東西就不要動使用者的版面')
})

// ---- 側欄與拖曳 ----

test('側欄把多值任務的每個值列成子項', async () => {
  const { st, ls, doc, win } = await fresh()
  await st.saveTask(multi())
  await st.saveTask(single())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await new Promise(r => setTimeout(r, 30))
  const children = [...doc.querySelectorAll('[data-palette-series]')].map(el => el.dataset.paletteSeries)
  assert.ok(children.includes('bank#k1') && children.includes('bank#k2'), `子項：${children.join(',')}`)
})

test('把整個多值任務投放到表格會一次加入全部的值', async () => {
  const dr = await import('../src/ui/report/drop-rules.js?t=' + Math.random())
  assert.equal(typeof dr.applyDropMany, 'function', '要有一次投放多個來源的入口')
  const card = { type: 'table', source: [], options: { mode: 'pivot' } }
  const patch = dr.applyDropMany(card, ['bank#k1', 'bank#k2'], {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['bank#k1', 'bank#k2'])
})

test('折線超過八條時整批拒絕，不留下半套', async () => {
  const dr = await import('../src/ui/report/drop-rules.js?t=' + Math.random())
  const card = { type: 'line', source: Array.from({ length: 7 }, (_, i) => ({ taskId: `t${i}` })), options: {} }
  const patch = dr.applyDropMany(card, ['a', 'b', 'c'], {})
  assert.equal(patch, null, '七條再加三條會爆調色盤，要整批拒絕')
  assert.equal(card.source.length, 7, '拒絕時不得改動原卡片')
})

test('多值任務投放到數值卡取第一個值', async () => {
  const dr = await import('../src/ui/report/drop-rules.js?t=' + Math.random())
  const card = { type: 'number', source: [{ taskId: 'old' }], options: {} }
  const patch = dr.applyDropMany(card, ['bank#k1', 'bank#k2'], {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['bank#k1'])
})

test('既有的單一投放入口不受影響', async () => {
  const dr = await import('../src/ui/report/drop-rules.js?t=' + Math.random())
  const card = { type: 'line', source: [], options: {} }
  const patch = dr.applyDrop(card, 'bank#k1', {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['bank#k1'])
})

test('狀態卡收到值的時候記的是父任務', async () => {
  const dr = await import('../src/ui/report/drop-rules.js?t=' + Math.random())
  const card = { type: 'status', source: [], options: { taskIds: [] } }
  const patch = dr.applyDropMany(card, ['bank#k1', 'bank#k2'], {})
  assert.deepEqual(patch.options.taskIds, ['bank'], '狀態是任務層級的，不是值層級的')
})

// ---- 任務頁 ----

test('任務頁列出多值任務的值名稱', async () => {
  const { st, doc } = await fresh()
  await st.saveTask(multi())
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  ts.renderTasks([multi()], {}, [])
  const row = doc.querySelector('[data-task-id="bank"]')
  assert.ok(row.textContent.includes('美金買入'), `任務列要看得出抓哪些值：${row.textContent}`)
})
