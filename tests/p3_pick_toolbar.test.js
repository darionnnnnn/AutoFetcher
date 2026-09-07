// AF-7 批次 C:選取模式的工具列（單格／整欄／整列）與已選清單（chip、移除最後一項、Backspace）
// 對照 docs/AF-7-PLAN.md 批次 C 的驗收 C-1 ~ C-8。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <table id="t">
    <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
    <tbody>
      <tr><td>美金</td><td id="a1">31.2</td><td id="a2">31.8</td></tr>
      <tr><td>日圓</td><td id="b1">0.21</td><td id="b2">0.22</td></tr>
      <tr><td>歐元</td><td id="c1">33.5</td><td id="c2">34.1</td></tr>
    </tbody>
  </table>`

async function enter(opts = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t'), ...opts })
  return { c, doc, pm, win: jd.window }
}

const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
const click = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }))
const key = (doc, win, k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }))
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picked = (c) => sent(c).filter(m => m?.type === 'PICKED' && !m.cancelled)
const tools = (doc) => Array.from(doc.querySelectorAll('[data-af-tool]'))
const chips = (doc) => Array.from(doc.querySelectorAll('[data-af-chip]'))

// ---------- C-1 工具列 ----------

test('C-1 工具列有單格／整欄／整列三段，預設是單格', async () => {
  const { doc, pm } = await enter()
  const keys = tools(doc).map(el => el.getAttribute('data-af-tool'))
  assert.deepEqual(keys, ['cell', 'col', 'row'], `實得 ${JSON.stringify(keys)}`)
  const active = tools(doc).filter(el => el.hasAttribute('data-af-active')).map(el => el.getAttribute('data-af-tool'))
  assert.deepEqual(active, ['cell'], '預設值的單位是儲存格')
  pm.exitPickMode()
})

test('C-1 單格模式只標一格，整欄模式標整欄', async () => {
  const { doc, pm, win } = await enter()
  move(win, doc.getElementById('b1'))
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 1, '單格模式只標滑鼠那一格')
  click(win, tools(doc).find(el => el.getAttribute('data-af-tool') === 'col'))
  move(win, doc.getElementById('b1'))
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 3, '整欄模式標滿三個資料列')
  assert.equal(pm.currentAxis(), 'col')
  pm.exitPickMode()
})

test('C-1 整列模式標整列', async () => {
  const { doc, pm, win } = await enter()
  click(win, tools(doc).find(el => el.getAttribute('data-af-tool') === 'row'))
  move(win, doc.getElementById('b1'))
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 3, '整列有三欄')
  assert.equal(pm.currentAxis(), 'row')
  pm.exitPickMode()
})

// ---------- C-2 切換不清空 ----------

test('C-2 Tab 在三段之間循環', async () => {
  const { doc, pm, win } = await enter()
  move(win, doc.getElementById('a1'))
  const activeKey = () => tools(doc).find(el => el.hasAttribute('data-af-active'))?.getAttribute('data-af-tool')
  assert.equal(activeKey(), 'cell')
  key(doc, win, 'Tab')
  assert.equal(activeKey(), 'col')
  key(doc, win, 'Tab')
  assert.equal(activeKey(), 'row')
  key(doc, win, 'Tab')
  assert.equal(activeKey(), 'cell', '循環回單格')
  pm.exitPickMode()
})

test('C-2 切換模式不得清空已選（本輪推翻 SPEC §2 舊規則）', async () => {
  const { doc, pm, win } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'), { shiftKey: true })
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'), { shiftKey: true })
  assert.equal(pm.selectedCount(), 2)
  key(doc, win, 'Tab')
  assert.equal(pm.selectedCount(), 2, '欄列與儲存格可以混在同一個任務裡，不必清空')
  click(win, tools(doc).find(el => el.getAttribute('data-af-tool') === 'row'))
  assert.equal(pm.selectedCount(), 2, '用工具列切換一樣不清空')
  pm.exitPickMode()
})

// ---------- C-3 點已選的格子等於取消 ----------

test('C-3 不按 Shift 點已選的格子＝取消它，而且不送出', async () => {
  const { c, doc, pm, win } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'), { shiftKey: true })
  assert.equal(pm.selectedCount(), 1)
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  assert.equal(pm.selectedCount(), 0, '再點一次就是取消')
  assert.equal(picked(c).length, 0, '取消不得順手送出')
  pm.exitPickMode()
})

test('C-3 點沒選過的格子仍是「選它並送出」', async () => {
  const { c, doc, pm, win } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  assert.equal(picked(c).length, 1)
  assert.ok(picked(c)[0].picks[0].cell)
  pm.exitPickMode()
})

// ---------- C-4 已選清單 chip ----------

test('C-4 每個已選的值有一個 chip，×可以移除指定項', async () => {
  const { doc, pm, win } = await enter()
  for (const id of ['a1', 'b1', 'c1']) {
    move(win, doc.getElementById(id))
    click(win, doc.getElementById(id), { shiftKey: true })
  }
  assert.equal(pm.selectedCount(), 3)
  assert.equal(chips(doc).length, 3, `每個值一個 chip，實得 ${chips(doc).length}`)
  const remove = chips(doc)[1].querySelector('[data-af-chip-remove]')
  assert.ok(remove, 'chip 上要有移除鈕')
  click(win, remove)
  assert.equal(pm.selectedCount(), 2)
  assert.equal(chips(doc).length, 2)
  const names = chips(doc).map(el => el.textContent)
  assert.ok(names[0].includes('美金'), `剩下的順序不變，實得 ${JSON.stringify(names)}`)
  assert.ok(names[1].includes('歐元'), `剩下的順序不變，實得 ${JSON.stringify(names)}`)
  pm.exitPickMode()
})

test('C-4 移除最後一項按鈕與 Backspace 等效', async () => {
  const { doc, pm, win } = await enter()
  for (const id of ['a1', 'b1', 'c1']) {
    move(win, doc.getElementById(id))
    click(win, doc.getElementById(id), { shiftKey: true })
  }
  key(doc, win, 'Backspace')
  assert.equal(pm.selectedCount(), 2, 'Backspace 移除最後一項')
  const btn = doc.querySelector('[data-af-remove-last]')
  assert.ok(btn, '面板要有「移除最後一項」')
  click(win, btn)
  assert.equal(pm.selectedCount(), 1)
  click(win, doc.querySelector('[data-af-remove-last]'))
  assert.equal(pm.selectedCount(), 0)
  pm.exitPickMode()
})

test('C-4 沒有已選時 Backspace 不做事也不送出', async () => {
  const { c, doc, pm, win } = await enter()
  key(doc, win, 'Backspace')
  assert.equal(pm.selectedCount(), 0)
  assert.equal(sent(c).length, 0)
  pm.exitPickMode()
})

// ---------- C-5 面板與工具列上的點擊不得送出 ----------

test('C-5 點面板或工具列不得當成確認', async () => {
  const { c, doc, pm, win } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.querySelector('[data-af-panel]'))
  click(win, tools(doc)[0])
  assert.equal(picked(c).length, 0, 'overlay 自己的元件不是選取目標')
  pm.exitPickMode()
})

// ---------- C-6 整欄／整列模式的送出形狀 ----------

test('C-6 整欄模式點一格＝整欄聚合', async () => {
  const { c, doc, pm, win } = await enter()
  click(win, tools(doc).find(el => el.getAttribute('data-af-tool') === 'col'))
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  const pick = picked(c)[0].picks[0]
  assert.ok(pick.block, `要是聚合，實得 ${JSON.stringify(pick)}`)
  assert.equal(pick.block.axis, 'col')
  assert.equal(pick.block.index, 1)
  assert.equal(pick.block.headerText, '買入')
  pm.exitPickMode()
})

test('C-6 整列模式點一格＝整列聚合', async () => {
  const { c, doc, pm, win } = await enter()
  click(win, tools(doc).find(el => el.getAttribute('data-af-tool') === 'row'))
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  const pick = picked(c)[0].picks[0]
  assert.ok(pick.block)
  assert.equal(pick.block.axis, 'row')
  assert.equal(pick.block.index, 1)
  assert.equal(pick.block.headerText, '日圓')
  pm.exitPickMode()
})

// ---------- C-7 非 task 用途 ----------

test('C-7 重選／前置動作／登入只選一個元素，整欄整列要停用', async () => {
  const { doc, pm, win } = await enter({ purpose: 'repick' })
  const col = tools(doc).find(el => el.getAttribute('data-af-tool') === 'col')
  assert.equal(col.getAttribute('aria-disabled'), 'true')
  click(win, col)
  assert.equal(pm.currentAxis(), 'col', '停用時不得切換（單格模式對外仍報 col 軸）')
  const active = tools(doc).filter(el => el.hasAttribute('data-af-active')).map(el => el.getAttribute('data-af-tool'))
  assert.deepEqual(active, ['cell'], '仍停在單格')
  pm.exitPickMode()
})

// ---------- 非表格目標 ----------

test('C-8 目標不是表格時工具列停用並說明', async () => {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM('<!doctype html><html><body><div id="d">今日總量 1,234</div></body></html>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('d') })
  assert.equal(tools(doc).length, 3, '工具列仍在，只是停用')
  for (const el of tools(doc)) {
    assert.equal(el.getAttribute('aria-disabled'), 'true', '非表格沒有欄列可選')
  }
  pm.exitPickMode()
})

test('C-8 離開選取模式時工具列與 chip 一起清乾淨', async () => {
  const { doc, pm, win } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'), { shiftKey: true })
  assert.equal(tools(doc).length, 3, '離開前工具列在')
  assert.equal(chips(doc).length, 1, '離開前 chip 在')
  pm.exitPickMode()
  assert.equal(tools(doc).length, 0)
  assert.equal(chips(doc).length, 0)
  assert.equal(doc.querySelectorAll('[data-af-overlay]').length, 0)
})
