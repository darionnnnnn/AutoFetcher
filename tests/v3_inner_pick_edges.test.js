// AF-15 批次 B2：選取端周邊——指令句與警語、小表只有 1 列的提示、範圍類加選帶錨點 inner、
// Ctrl+A 不帶、chip 名稱、innerLabel 純函式、preselect 回勾
// 對照 docs/AF-15-PLAN.md 批次 B2 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { innerLabel } from '../src/shared/describe.js'

const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
const PLAIN = `<table id="plain"><thead><tr><th>日期</th><th>金額</th></tr></thead><tbody>
  <tr><td>09/01</td><td id="p1">100</td></tr><tr><td>09/02</td><td id="p2">200</td></tr></tbody></table>`
const SMALL_TABLE_2ND = [
  { tag: 'table', index: 1 }, { tag: 'tbody', index: 1 }, { tag: 'tr', index: 1 }, { tag: 'td', index: 2 }
]

async function boot(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>監控</title></head><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, pm, win: jd.window }
}
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const move = (win, el, init) => fire(win, el, 'mousemove', init)
const click = (win, el, init) => fire(win, el, 'click', init)
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const menuItem = (doc, k) => doc.querySelector(`[data-af-menu-item="${k}"]`)

const outerOf = (doc) => doc.querySelector('table')
const inner2 = (doc, id = 'his_31') => doc.getElementById(id).closest('td')
const outerTdOf = (innerTd) => innerTd.closest('table').closest('td')

async function onOuter() {
  const b = await boot(MONITOR)
  b.pm.enterPickMode({ purpose: 'task', initialTarget: b.doc.body })
  move(b.win, inner2(b.doc))
  key(b.doc, b.win, 'ArrowUp')
  move(b.win, inner2(b.doc))
  assert.equal(b.pm.currentTarget(), outerOf(b.doc), '前置：鎖在外層表（B1）')
  return b
}
const rowsOf = (picks) => picks.map(p => p.cell.row.index)

// ---------- innerLabel：白話標籤唯一一份（純函式） ----------

test('B2 innerLabel：小表格子、非表格元素、沒有路徑', () => {
  assert.equal(innerLabel(SMALL_TABLE_2ND), '小表第 1 列第 2 格')
  assert.equal(innerLabel([{ tag: 'table', index: 1 }, { tag: 'tbody', index: 1 }, { tag: 'tr', index: 3 }, { tag: 'th', index: 1 }]), '小表第 3 列第 1 格')
  assert.equal(innerLabel([{ tag: 'div', index: 1 }, { tag: 'span', index: 1 }]), '內層 span')
  assert.equal(innerLabel([{ tag: 'span', index: 2 }]), '內層 span 2')
  assert.equal(innerLabel([]), '')
  assert.equal(innerLabel(undefined), '')
  assert.equal(innerLabel('td'), '', '形狀不合法時不得拋錯，回空字串')
})

// ---------- 指令句與警語 ----------

test('B2 目標是外層表格子裡的小表：指令句教使用者按 ↑', async () => {
  const { doc, pm, win } = await boot(MONITOR)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), inner2(doc).closest('table'), '前置：目標是內層小表')
  const text = panelText(doc)
  assert.match(text, /外層表格裡的小表/, `實得：${text.slice(0, 200)}`)
  assert.match(text, /按 ↑/)
  pm.exitPickMode()
})

test('B2 守門：一般表格的指令句不變（不得套上小表提示）', async () => {
  const { doc, pm, win } = await boot(PLAIN)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('p1'))
  const text = panelText(doc)
  assert.match(text, /點你要的那一格/)
  assert.doesNotMatch(text, /外層表格裡的小表/)
  pm.exitPickMode()
})

test('B2 外層表為目標、滑鼠在內含表格的外層格自己上：警語改教「移到那一格上」', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, outerTdOf(inner2(doc)))
  const text = panelText(doc)
  assert.match(text, /這一格內含表格/, '既有警語的前半句保留（p1 A-3b 依賴）')
  assert.match(text, /把滑鼠移到那一格上/, `實得：${text.slice(0, 200)}`)
  pm.exitPickMode()
})

test('B2 外層表為目標、滑鼠在子單位上：不得再說「會抓到整串文字」（框的就是那一格）', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, outerTdOf(inner2(doc)))
  assert.match(panelText(doc), /會抓到整串文字/, '前置：停在外層格自己時警語要在')
  move(win, inner2(doc))
  assert.doesNotMatch(panelText(doc), /會抓到整串文字/, `有子單位時警語是假的，實得：${panelText(doc).slice(0, 200)}`)
  click(win, inner2(doc))
  assert.doesNotMatch(panelText(doc), /會抓到整串文字/, '已選之後的面板同一條規則')
  pm.exitPickMode()
})

// ---------- 小表只有 1 列時點整欄 ----------

test('B2 內層小表只有 1 列時點「整欄」：照做，但提示整欄只有 1 格、要跨外層每一列請按 ↑', async () => {
  const { doc, pm, win } = await boot(MONITOR)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, inner2(doc))
  click(win, tool(doc, 'col'))
  assert.equal(tool(doc, 'col').hasAttribute('data-af-active'), true, '模式照切，不擋')
  const text = panelText(doc)
  assert.match(text, /只有 1 列/, `實得：${text.slice(0, 200)}`)
  assert.match(text, /按 ↑/)
  pm.exitPickMode()
})

test('B2 小表 1 列的提示也出現在右鍵「整欄聚合」', async () => {
  const { doc, pm, win } = await boot(MONITOR)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, inner2(doc))
  fire(win, inner2(doc), 'contextmenu')
  click(win, menuItem(doc, 'col'))
  assert.ok(pm.selectedPicks()[0]?.block, '照做：加入整欄')
  assert.match(panelText(doc), /只有 1 列/)
  pm.exitPickMode()
})

test('B2 守門：一般的多列表格點整欄不出現小表提示', async () => {
  const { doc, pm, win } = await boot(PLAIN)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('p1'))
  click(win, tool(doc, 'col'))
  assert.doesNotMatch(panelText(doc), /只有 1 列/)
  pm.exitPickMode()
})

// ---------- 範圍類加選帶錨點的 inner ----------

test('B2 右鍵「這一欄：每格各一個值」：每一列各一個值、帶錨點的 inner，解析不到的列不建', async () => {
  const { doc, pm, win } = await onOuter()
  fire(win, inner2(doc), 'contextmenu')
  click(win, menuItem(doc, 'col-each'))
  const picks = pm.selectedPicks()
  assert.deepEqual(rowsOf(picks), [2, 3, 4, 5, 6, 7], `5 台主機＋合計列，實得 ${JSON.stringify(picks)}`)
  assert.ok(picks.every(p => JSON.stringify(p.cell.inner) === JSON.stringify(SMALL_TABLE_2ND)))
  pm.exitPickMode()
})

test('B2 右鍵「這一列：每格各一個值」：只有路徑解析得到的那一欄', async () => {
  const { doc, pm, win } = await onOuter()
  fire(win, inner2(doc), 'contextmenu')
  click(win, menuItem(doc, 'row-each'))
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 1, `實得 ${JSON.stringify(picks)}`)
  assert.equal(picks[0].cell.col.index, 2)
  assert.deepEqual(picks[0].cell.inner, SMALL_TABLE_2ND)
  pm.exitPickMode()
})

test('B2 Shift 點：矩形範圍內每格帶錨點（最後一個已選格）的 inner', async () => {
  const { doc, pm, win } = await onOuter()
  click(win, inner2(doc))
  move(win, inner2(doc, 'his_33'))
  click(win, inner2(doc, 'his_33'), { shiftKey: true })
  const picks = pm.selectedPicks()
  assert.deepEqual(rowsOf(picks), [2, 3, 4], JSON.stringify(picks))
  assert.ok(picks.every(p => JSON.stringify(p.cell.inner) === JSON.stringify(SMALL_TABLE_2ND)))
  pm.exitPickMode()
})

test('B2 Shift 點跨到沒有小表的欄：那一欄的格子解析不到，不建 pick', async () => {
  const { doc, pm, win } = await onOuter()
  click(win, inner2(doc))
  const ip33 = doc.querySelector('span[title="service ip:10.231.1.33"]')
  move(win, ip33)
  click(win, ip33, { shiftKey: true })
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 3, `3 列 × 2 欄只有小表那一欄解析得到，實得 ${JSON.stringify(picks)}`)
  assert.ok(picks.every(p => p.cell.col.index === 2))
  pm.exitPickMode()
})

test('B2 拖曳框選：範圍內每格帶 mousedown 那一格的 inner', async () => {
  const { doc, pm, win } = await onOuter()
  fire(win, inner2(doc), 'mousedown', { button: 0, buttons: 1 })
  move(win, inner2(doc, 'his_33'), { buttons: 1 })
  fire(win, inner2(doc, 'his_33'), 'mouseup', { button: 0 })
  const picks = pm.selectedPicks()
  assert.deepEqual(rowsOf(picks), [2, 3, 4], JSON.stringify(picks))
  assert.ok(picks.every(p => JSON.stringify(p.cell.inner) === JSON.stringify(SMALL_TABLE_2ND)))
  pm.exitPickMode()
})

test('B2 Shift＋方向鍵：從滑鼠所在格往下加選，帶同一條 inner', async () => {
  const { doc, pm, win } = await onOuter()
  key(doc, win, 'ArrowDown', { shiftKey: true })
  const picks = pm.selectedPicks()
  assert.deepEqual(rowsOf(picks), [2, 3], JSON.stringify(picks))
  assert.ok(picks.every(p => JSON.stringify(p.cell.inner) === JSON.stringify(SMALL_TABLE_2ND)))
  pm.exitPickMode()
})

test('B2 Ctrl+A：全選整格，不帶 inner', async () => {
  const { doc, pm, win } = await onOuter()
  key(doc, win, 'a', { ctrlKey: true })
  const picks = pm.selectedPicks()
  assert.ok(picks.length > 0, '前置：全選要選到東西')
  assert.ok(picks.every(p => !('inner' in p.cell)), JSON.stringify(picks.filter(p => 'inner' in p.cell)))
  pm.exitPickMode()
})

test('B2 Ctrl+A 在 colspan 表存網格索引（DOM 迴圈變數會錯位）', async () => {
  const { doc, pm, win } = await boot(`<table id="cs"><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody>
    <tr><td colspan="2" id="ab">ab</td><td id="c1">c1</td></tr>
    <tr><td>a2</td><td>b2</td><td id="c2">c2</td></tr></tbody></table>`)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('c1'))
  key(doc, win, 'a', { ctrlKey: true })
  const cols = pm.selectedPicks().map(p => `${p.cell.row.index}:${p.cell.col.index}`)
  assert.deepEqual(cols, ['0:0', '0:2', '1:0', '1:1', '1:2'], `c1 在網格上是第 3 欄，實得 ${JSON.stringify(cols)}`)
  assert.equal(doc.getElementById('c1').hasAttribute('data-af-picked'), true)
  pm.exitPickMode()
})

// ---------- chip 名稱 ----------

test('B2 已選 chip 的名稱帶格內標籤（與整格分得開）', async () => {
  const { doc, pm, win } = await onOuter()
  click(win, inner2(doc))
  move(win, outerTdOf(inner2(doc)))
  click(win, outerTdOf(inner2(doc)), { ctrlKey: true })
  const chips = Array.from(doc.querySelectorAll('[data-af-chip]')).map(c => c.textContent.replace('×', '').trim())
  assert.equal(chips.length, 2)
  assert.match(chips[0], /10\.231\.1\.31/)
  assert.match(chips[0], /小表第 1 列第 2 格/, `實得 ${JSON.stringify(chips)}`)
  assert.doesNotMatch(chips[1], /小表/, '整格那一個不得帶格內標籤')
  pm.exitPickMode()
})

// ---------- preselect 回勾 ----------

test('B2 preselect 帶 inner 的儲存格：勾回同一個子單位', async () => {
  const { doc, pm } = await boot(MONITOR)
  pm.enterPickMode({
    purpose: 'repick', initialTarget: doc.querySelector('table'),
    preselect: [{ cell: { row: { index: 2, header: '10.231.1.31' }, col: { index: 2, header: '' }, inner: SMALL_TABLE_2ND } }]
  })
  assert.equal(pm.selectedCount(), 1)
  assert.deepEqual(pm.selectedPicks()[0].cell.inner, SMALL_TABLE_2ND)
  assert.equal(inner2(doc).hasAttribute('data-af-picked'), true)
  assert.equal(outerTdOf(inner2(doc)).hasAttribute('data-af-picked'), false)
  pm.exitPickMode()
})

test('B2 preselect 帶 inner 的整欄：勾回來，標記落在每一列的小表格子', async () => {
  const { doc, pm } = await boot(MONITOR)
  pm.enterPickMode({
    purpose: 'repick', initialTarget: doc.querySelector('table'),
    preselect: [{ block: { axis: 'col', index: 2, headerText: '', inner: SMALL_TABLE_2ND } }]
  })
  assert.equal(pm.selectedCount(), 1)
  assert.deepEqual(pm.selectedPicks()[0].block.inner, SMALL_TABLE_2ND)
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 6)
  pm.exitPickMode()
})

test('B2 preselect 的 inner 解析不到：略過那一項並提示位置已變', async () => {
  const { doc, pm } = await boot(MONITOR)
  const gone = [{ tag: 'table', index: 1 }, { tag: 'tbody', index: 1 }, { tag: 'tr', index: 1 }, { tag: 'td', index: 9 }]
  pm.enterPickMode({
    purpose: 'repick', initialTarget: doc.querySelector('table'),
    preselect: [
      { cell: { row: { index: 2, header: '10.231.1.31' }, col: { index: 2, header: '' }, inner: gone } },
      { cell: { row: { index: 3, header: '10.231.1.32' }, col: { index: 2, header: '' }, inner: SMALL_TABLE_2ND } }
    ]
  })
  assert.equal(pm.selectedCount(), 1, '解析不到的那一項不得勾回整格')
  assert.equal(pm.selectedPicks()[0].cell.row.index, 3)
  assert.match(panelText(doc), /位置已變/)
  pm.exitPickMode()
})
