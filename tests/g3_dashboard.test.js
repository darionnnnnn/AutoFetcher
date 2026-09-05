process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  return { c, st, ls, db, doc: jd.window.document, win: jd.window }
}

// 以 MouseEvent 合成指標事件（jsdom 25 沒有 PointerEvent）
function pointer(win, el, type, x, y) {
  const ev = new win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  el.dispatchEvent(ev)
  return ev
}

// 讓 jsdom 的容器有可預測的尺寸：12 欄 × 每欄 50px、每格高 80px
function stubGeometry(win, doc, { width = 600 } = {}) {
  const grid = doc.getElementById('dashboard-grid')
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 800, right: width, bottom: 800 })
  Object.defineProperty(win, 'innerWidth', { value: width + 100, configurable: true })
  return grid
}

async function seed(ls, cards) {
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  for (const c of cards) await ls.addCard(did, c)
  return did
}

const card = (over = {}) => ({
  type: 'number', x: 0, y: 0, w: 3, h: 2,
  source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over
})

// ---- 渲染 ----

test('渲染後每張卡片一個節點，帶格線座標', async () => {
  const { db, ls, st, doc, win } = await fresh()
  await st.saveTask(task('t1'))
  const did = await seed(ls, [card(), card({ x: 6, y: 0 })])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  const els = doc.querySelectorAll('#dashboard-grid [data-card-id]')
  assert.equal(els.length, 2)
  assert.equal(els[0].style.getPropertyValue('--card-x'), '0')
  assert.equal(els[1].style.getPropertyValue('--card-x'), '6')
})

test('整頁只讀一次紀錄，不是每張卡片各讀一次', async () => {
  const { db, ls, st, c, doc, win } = await fresh()
  await st.saveTask(task('t1'))
  const did = await seed(ls, [card(), card({ type: 'line' }), card({ type: 'bar' }), card({ type: 'gauge' })])
  stubGeometry(win, doc)
  c.__calls.length = 0
  await db.renderDashboard(did)
  const gets = c.__calls.filter(x => x.api === 'storage.local.get')
  assert.ok(gets.length <= 6, `讀取次數過多（${gets.length}）：資料應一次載入後共用`)
})

test('版面來自較新版本時顯示提示列', async () => {
  const { db, c, doc, win } = await fresh()
  await c.storage.local.set({ layout: { version: 99, dashboards: [{ id: 'd1', name: 'x', cards: [] }] } })
  stubGeometry(win, doc)
  await db.renderDashboard('d1')
  const note = doc.getElementById('layout-version-note')
  assert.ok(note && !note.hidden, '要顯示版面來自較新版本的提示')
})

test('目前版本時不顯示提示列', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  assert.ok(doc.getElementById('layout-version-note').hidden)
})

// ---- 編輯模式 ----

test('預設是瀏覽模式，切換後進入編輯模式', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  assert.equal(db.isEditing(), false)
  doc.getElementById('edit-layout').click()
  assert.equal(db.isEditing(), true)
  assert.ok(doc.getElementById('dashboard-grid').classList.contains('editing'))
})

test('瀏覽模式下卡片沒有縮放把手', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  assert.equal(doc.querySelectorAll('[data-role="resize-handle"]:not([hidden])').length, 0)
  doc.getElementById('edit-layout').click()
  assert.ok(doc.querySelectorAll('[data-role="resize-handle"]:not([hidden])').length > 0)
})

// ---- 拖曳 ----

test('編輯模式拖曳後卡片座標更新並存檔', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el, 'pointerdown', 10, 10)
  pointer(win, grid, 'pointermove', 310, 90)
  pointer(win, grid, 'pointerup', 310, 90)
  await new Promise(r => setTimeout(r, 20))
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards[0].x, 6, `拖到第 6 欄，實得 x=${cards[0].x}`)
  assert.equal(cards[0].y, 1, `拖到第 1 列，實得 y=${cards[0].y}`)
})

test('瀏覽模式拖曳完全無效', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el, 'pointerdown', 10, 10)
  pointer(win, grid, 'pointermove', 310, 90)
  pointer(win, grid, 'pointerup', 310, 90)
  await new Promise(r => setTimeout(r, 20))
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.deepEqual([cards[0].x, cards[0].y], [0, 0])
})

test('拖曳中顯示佔位陰影，放開後移除', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el, 'pointerdown', 10, 10)
  pointer(win, grid, 'pointermove', 160, 90)
  assert.ok(doc.querySelector('.ghost'), '拖曳中要有佔位陰影')
  pointer(win, grid, 'pointerup', 160, 90)
  assert.equal(doc.querySelector('.ghost'), null, '放開後陰影要消失')
})

test('拖曳把被壓到的卡片往下擠，結果不重疊', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card({ x: 0, y: 0, w: 6, h: 2 }), card({ x: 6, y: 0, w: 6, h: 2 })])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const els = doc.querySelectorAll('[data-card-id]')
  els[1].getBoundingClientRect = () => ({ left: 300, top: 0, width: 300, height: 160 })
  pointer(win, els[1], 'pointerdown', 310, 10)
  pointer(win, grid, 'pointermove', 10, 10)
  pointer(win, grid, 'pointerup', 10, 10)
  await new Promise(r => setTimeout(r, 20))
  const cards = (await ls.getLayout()).dashboards[0].cards
  const [a, b] = cards
  const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert.equal(overlap, false, `重疊了：${JSON.stringify(cards.map(c => [c.x, c.y, c.w, c.h]))}`)
})

// ---- 縮放 ----

test('拖右下把手放大卡片，寬高更新', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card({ w: 3, h: 2 })])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  const handle = el.querySelector('[data-role="resize-handle"]')
  pointer(win, handle, 'pointerdown', 150, 160)
  pointer(win, grid, 'pointermove', 300, 320)
  pointer(win, grid, 'pointerup', 300, 320)
  await new Promise(r => setTimeout(r, 20))
  const c0 = (await ls.getLayout()).dashboards[0].cards[0]
  assert.equal(c0.w, 6, `寬度應變成 6，實得 ${c0.w}`)
  assert.equal(c0.h, 4, `高度應變成 4，實得 ${c0.h}`)
})

test('縮放超過上限時被夾住', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card({ w: 3, h: 2 })])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el.querySelector('[data-role="resize-handle"]'), 'pointerdown', 150, 160)
  pointer(win, grid, 'pointermove', 5000, 5000)
  pointer(win, grid, 'pointerup', 5000, 5000)
  await new Promise(r => setTimeout(r, 20))
  const c0 = (await ls.getLayout()).dashboards[0].cards[0]
  assert.equal(c0.w, 12)
  assert.equal(c0.h, 6)
})

// ---- 復原重做 ----

test('undo 回到拖曳前的位置，redo 再回來', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el, 'pointerdown', 10, 10)
  pointer(win, grid, 'pointermove', 310, 10)
  pointer(win, grid, 'pointerup', 310, 10)
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 6)
  await db.undo()
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 0)
  await db.redo()
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 6)
})

test('沒有可復原的動作時 undo 不丟錯也不改變版面', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await db.undo()
  await db.redo()
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 0)
})

test('復原步數上限 50', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  for (let i = 0; i < 60; i++) await db.pushHistory()
  assert.ok(db.historySize() <= 50, `上限 50，實得 ${db.historySize()}`)
})

test('離開編輯模式時清空復原歷史', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await db.pushHistory()
  assert.ok(db.historySize() > 0)
  doc.getElementById('edit-layout').click()
  assert.equal(db.historySize(), 0)
})

test('編輯模式下 Ctrl/Cmd+Z 觸發復原', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el, 'pointerdown', 10, 10)
  pointer(win, grid, 'pointermove', 310, 10)
  pointer(win, grid, 'pointerup', 310, 10)
  await new Promise(r => setTimeout(r, 20))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 0)
})

test('焦點在輸入框時不攔截 Ctrl+Z', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  const grid = stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  const el = doc.querySelector('[data-card-id]')
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el, 'pointerdown', 10, 10)
  pointer(win, grid, 'pointermove', 310, 10)
  pointer(win, grid, 'pointerup', 310, 10)
  await new Promise(r => setTimeout(r, 20))
  const input = doc.createElement('input')
  doc.body.appendChild(input)
  input.focus()
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 6, '在輸入框內不可觸發復原')
})

test('瀏覽模式下 Ctrl+Z 不做任何事', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card({ x: 3 })])
  stubGeometry(win, doc)
  await db.renderDashboard(did)
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await ls.getLayout()).dashboards[0].cards[0].x, 3)
})

// ---- 響應式 ----

test('視窗寬度小於 900 時單欄疊放，但存檔座標不變', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card({ x: 6, y: 2 })])
  stubGeometry(win, doc, { width: 700 })
  Object.defineProperty(win, 'innerWidth', { value: 800, configurable: true })
  await db.renderDashboard(did)
  assert.ok(doc.getElementById('dashboard-grid').classList.contains('single-column'))
  const c0 = (await ls.getLayout()).dashboards[0].cards[0]
  assert.deepEqual([c0.x, c0.y], [6, 2], '響應式不可改動存檔版面')
})

test('寬視窗不加單欄類別', async () => {
  const { db, ls, doc, win } = await fresh()
  const did = await seed(ls, [card()])
  stubGeometry(win, doc, { width: 1200 })
  Object.defineProperty(win, 'innerWidth', { value: 1400, configurable: true })
  await db.renderDashboard(did)
  assert.ok(!doc.getElementById('dashboard-grid').classList.contains('single-column'))
})

// ---- 安全 ----

test('dashboard.js 不使用 innerHTML', () => {
  const src = readFileSync(new URL('../src/ui/report/dashboard.js', import.meta.url), 'utf8')
  assert.equal((src.match(/innerHTML/g) || []).length, 0)
})

test('拖曳接線只讀座標欄位，且 setPointerCapture 存在才呼叫', () => {
  const src = readFileSync(new URL('../src/ui/report/dashboard.js', import.meta.url), 'utf8')
  if (src.includes('setPointerCapture')) {
    assert.ok(/setPointerCapture\s*(\?\.|&&|\)\s*\{)|typeof[^\n]*setPointerCapture/.test(src),
      'setPointerCapture 必須做存在性檢查')
  }
})
