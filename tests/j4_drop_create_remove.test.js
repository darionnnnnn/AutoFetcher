// AF-4 C3:拖到空白格建新卡片、把欄位/序列拖出卡片移除
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, name, mode = 'number') => ({
  id, name, url: `https://x.test/${id}`, mode, enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task('t1', '電費'))
  await st.saveTask(task('t2', '水費'))
  await st.saveTask(task('t3', '公告', 'text'))
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  return { st, ls, db, doc: jd.window.document, win: jd.window }
}

const CARD = (type, over = {}) => ({ type, x: 0, y: 0, w: 6, h: 2, source: [], options: {}, ...over })

async function seed(ls, cards) {
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  const ids = []
  for (const c of cards) ids.push((await ls.addCard(did, c)).id)
  return { did, ids }
}

const pointer = (win, type, x, y, over = {}) => {
  const e = new win.Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0, ...over })
  return e
}
const settle = () => new Promise(r => setTimeout(r, 30))

function stubRect(el, rect) {
  el.getBoundingClientRect = () => ({
    left: rect[0], top: rect[1], right: rect[2], bottom: rect[3],
    width: rect[2] - rect[0], height: rect[3] - rect[1], x: rect[0], y: rect[1]
  })
}

async function enterEditMode(doc) {
  doc.getElementById('edit-layout').click()
  await settle()
}

async function dragFrom(doc, win, el, x, y) {
  // 事件派在元素上,會往上冒泡到格線與 document,與真實瀏覽器一致
  el.dispatchEvent(pointer(win, 'pointerdown', 0, 0))
  el.dispatchEvent(pointer(win, 'pointermove', x, y))
  el.dispatchEvent(pointer(win, 'pointerup', x, y))
  await settle()
}

async function dragTaskTo(doc, win, taskId, x, y) {
  const item = doc.querySelector(`[data-palette-task][data-task-id="${taskId}"]`)
  assert.ok(item, `側欄要有任務 ${taskId}`)
  await dragFrom(doc, win, item, x, y)
}

const cardsOf = async (ls, did) => (await ls.getLayout()).dashboards.find(d => d.id === did).cards
const cardOf = async (ls, did, cardId) => (await cardsOf(ls, did)).find(c => c.id === cardId)

async function seedRecords(st, taskIds) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  for (const id of taskIds) {
    await st.appendRecord(day, {
      taskId: id, slot: `${day}T09:00`, capturedAt: `${day}T09:00:00`,
      value: 1, raw: '1', status: 'ok'
    })
  }
}

// ---- 拖到空白格建新卡片 ----

test('數值模式的任務拖到空白處會建一張數值卡', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did } = await seed(ls, [])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  await dragTaskTo(doc, win, 't1', 600, 400)
  const cards = await cardsOf(ls, did)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].type, 'number')
  assert.deepEqual(cards[0].source.map(s => s.taskId), ['t1'])
})

test('文字模式的任務拖到空白處會建一張表格卡', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did } = await seed(ls, [])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  await dragTaskTo(doc, win, 't3', 600, 400)
  const cards = await cardsOf(ls, did)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].type, 'table')
})

test('新卡片不會和既有卡片重疊', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did } = await seed(ls, [CARD('number', { x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1' }] })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  await dragTaskTo(doc, win, 't2', 900, 500)
  const cards = await cardsOf(ls, did)
  assert.equal(cards.length, 2)
  const [a, b] = cards
  const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert.equal(overlap, false, `兩張卡片重疊了:${JSON.stringify([a, b])}`)
})

test('建新卡片可以復原', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did } = await seed(ls, [])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  await dragTaskTo(doc, win, 't1', 600, 400)
  assert.equal((await cardsOf(ls, did)).length, 1)
  await db.undo()
  await settle()
  assert.equal((await cardsOf(ls, did)).length, 0, '復原要把新卡片收回去')
})

test('瀏覽模式拖到空白處不建卡片', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did } = await seed(ls, [])
  await db.renderDashboard(did)
  await dragTaskTo(doc, win, 't1', 600, 400)
  assert.equal((await cardsOf(ls, did)).length, 0)
})

// ---- 拖出移除 ----

test('把表格的欄標拖出卡片會移除該欄', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await seed(ls, [CARD('table', {
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
    options: { mode: 'pivot' }
  })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 600, 200])
  const handle = el.querySelector('[data-remove-source][data-task-id="t1"]')
  assert.ok(handle, '欄標要能當拖曳來源')
  await dragFrom(doc, win, handle, 900, 700)
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t2'])
})

test('把欄標拖到別的地方放開(不在卡片外)不算移除', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await seed(ls, [CARD('table', {
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
    options: { mode: 'pivot' }
  })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 600, 200])
  const handle = el.querySelector('[data-remove-source][data-task-id="t1"]')
  await dragFrom(doc, win, handle, 300, 100)
  assert.equal((await cardOf(ls, did, ids[0])).source.length, 2, '放在卡片內不該移除')
})

test('數值卡片的唯一來源不可拖出', async () => {
  const { ls, db, doc } = await fresh()
  const { did, ids } = await seed(ls, [CARD('number', { source: [{ taskId: 't1', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  assert.equal(el.querySelector('[data-remove-source]'), null, '數值卡至少要留一個來源')
})

test('折線卡片的圖例可以拖出移除', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await seed(ls, [CARD('line', {
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }]
  })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 600, 200])
  const handle = el.querySelector('[data-remove-source][data-task-id="t2"]')
  assert.ok(handle, '圖例要能當拖曳來源')
  await dragFrom(doc, win, handle, 900, 700)
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1'])
})

test('拖出移除可以復原', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await seed(ls, [CARD('table', {
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
    options: { mode: 'pivot' }
  })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragFrom(doc, win, doc.querySelector('[data-remove-source][data-task-id="t1"]'), 900, 700)
  await db.undo()
  await settle()
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t1', 't2'])
})

test('表格移除到零欄時卡片仍在,並顯示空狀態提示', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1'])
  const { did, ids } = await seed(ls, [CARD('table', {
    source: [{ taskId: 't1', aggregation: 'raw' }], options: { mode: 'pivot' }
  })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragFrom(doc, win, doc.querySelector('[data-remove-source][data-task-id="t1"]'), 900, 700)
  assert.equal((await cardOf(ls, did, ids[0])).source.length, 0, '卡片不該被刪掉')
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  const emptyEl = el.querySelector('.card-table-empty')
  assert.ok(emptyEl, '要有空狀態節點,不能只靠卡片文字碰巧含關鍵字')
  assert.ok(/拖/.test(emptyEl.textContent), `空狀態要告訴使用者可以拖進來,實得:${emptyEl.textContent}`)
})

test('瀏覽模式看不到拖出把手', async () => {
  const { st, ls, db, doc } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await seed(ls, [CARD('table', {
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
    options: { mode: 'pivot' }
  })])
  await db.renderDashboard(did)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  const handles = [...el.querySelectorAll('[data-remove-source]')]
  assert.ok(handles.length === 0 || handles.every(h => h.hidden), '瀏覽模式不該出現移除把手')
})

test('把欄標拖到別張卡片上也算移除(不是落空)', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await seed(ls, [
    CARD('table', {
      source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
      options: { mode: 'pivot' }
    }),
    CARD('number', { source: [{ taskId: 't2', aggregation: 'raw' }] })
  ])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  const tableEl = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  const numberEl = doc.querySelector(`[data-card-id="${ids[1]}"]`)
  stubRect(tableEl, [0, 0, 600, 200])
  stubRect(numberEl, [700, 0, 900, 200])
  await dragFrom(doc, win, tableEl.querySelector('[data-remove-source][data-task-id="t1"]'), 800, 100)
  assert.deepEqual((await cardOf(ls, did, ids[0])).source.map(s => s.taskId), ['t2'])
  assert.deepEqual((await cardOf(ls, did, ids[1])).source.map(s => s.taskId), ['t2'], '目標卡片不該被改到')
})

test('拖到不肯收的卡片上,不會在它底下偷偷長出新卡片', async () => {
  const { ls, db, doc, win } = await fresh()
  const { did, ids } = await seed(ls, [CARD('line', { source: [{ taskId: 't1', aggregation: 'raw' }] })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  stubRect(doc.querySelector(`[data-card-id="${ids[0]}"]`), [0, 0, 600, 200])
  await dragTaskTo(doc, win, 't1', 300, 100)
  assert.equal((await cardsOf(ls, did)).length, 1, '卡片數不該增加')
})

test('拖移除把手時卡片本身不可跟著被搬動', async () => {
  const { st, ls, db, doc, win } = await fresh()
  await seedRecords(st, ['t1', 't2'])
  const { did, ids } = await seed(ls, [CARD('table', {
    x: 0, y: 0, w: 6, h: 2,
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
    options: { mode: 'pivot' }
  })])
  await db.renderDashboard(did)
  await enterEditMode(doc)
  const el = doc.querySelector(`[data-card-id="${ids[0]}"]`)
  stubRect(el, [0, 0, 600, 200])
  const before = await cardOf(ls, did, ids[0])
  await dragFrom(doc, win, el.querySelector('[data-remove-source][data-task-id="t1"]'), 1000, 700)
  const after = await cardOf(ls, did, ids[0])
  assert.deepEqual(after.source.map(s => s.taskId), ['t2'], '該移除欄位')
  assert.deepEqual([after.x, after.y], [before.x, before.y], '卡片位置不該被一起改掉')
})
