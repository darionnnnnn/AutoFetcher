// AF-15 體檢輪：換網格索引帶進的退化（欄數上限仍用 DOM 格數、子單位狀態不同步、skipped 虛報、位置定位的探測）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { extractValue } from '../src/shared/extract.js'
import { gridStartsOf } from '../src/shared/table.js'

// 無表頭＋首格 colspan：DOM 3 格、網格寬 4
const COLSPAN_ROW = `<table id="t"><tbody>
  <tr><td colspan="2" id="x"><span>9</span></td><td id="a"><span>5</span></td><td id="b"><span>6</span></td></tr>
  <tr><td colspan="2"><span>1</span></td><td><span>2</span></td><td><span>3</span></td></tr>
</tbody></table>`
// 兩欄都是複合格
const COMPOSITE2 = `<table id="t"><tbody>
  <tr><td><b>A</b><span id="s00">1</span></td><td><b>B</b><span id="s01">2</span></td></tr>
  <tr><td><b>A</b><span id="s10">3</span></td><td><b>B</b><span id="s11">4</span></td></tr>
</tbody></table>`

async function boot(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window; globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event; globalThis.MouseEvent = jd.window.MouseEvent; globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, pm, win: jd.window }
}
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const move = (win, el) => fire(win, el, 'mousemove')
const click = (win, el, init) => fire(win, el, 'click', init)
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const el = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body.firstElementChild

test('gridStartsOf：每格一次的網格起點', () => {
  const row = el(COLSPAN_ROW).rows[0]
  assert.deepEqual(gridStartsOf(row), [0, 2, 3])
})

test('右鍵「這一列：每格各一個值」在無表頭＋colspan 的列：每格一個、不重複、不漏最後一欄', async () => {
  const { doc, pm, win } = await boot(COLSPAN_ROW)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a'))
  fire(win, doc.getElementById('a'), 'contextmenu')
  click(win, doc.querySelector('[data-af-menu-item="row-each"]'))
  assert.deepEqual(pm.selectedPicks().map(p => p.cell.col.index), [0, 2, 3], `實得 ${JSON.stringify(pm.selectedPicks())}`)
  pm.exitPickMode()
})

test('Shift＋→ 在 colspan 的列走得到最後一欄', async () => {
  const { doc, pm, win } = await boot(COLSPAN_ROW)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a'))
  key(doc, win, 'ArrowRight', { shiftKey: true })
  assert.deepEqual(pm.selectedPicks().map(p => p.cell.col.index), [2, 3], `最後一欄的網格索引是 3，實得 ${JSON.stringify(pm.selectedPicks())}`)
  pm.exitPickMode()
})

test('Shift＋→ 移到下一格：待選框與 pick 都是同一個子單位（markCells 不得自己再判一次）', async () => {
  const { doc, pm, win } = await boot(COMPOSITE2)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('s00'))
  key(doc, win, 'ArrowRight', { shiftKey: true })
  const picks = pm.selectedPicks()
  assert.deepEqual(picks.map(p => p.cell.col.index), [0, 1])
  assert.ok(picks.every(p => JSON.stringify(p.cell.inner) === JSON.stringify([{ tag: 'span', index: 1 }])))
  assert.equal(doc.getElementById('s01').hasAttribute('data-af-cell'), true, '待選框要在 (0,1) 的子單位上')
  assert.equal(doc.getElementById('s01').closest('td').hasAttribute('data-af-cell'), false, '不得框整格')
  pm.exitPickMode()
})

test('Ctrl+A 之後子單位狀態要清：接著 Tab 切整欄，框的是整格不是格內元素', async () => {
  const { doc, pm, win } = await boot(COMPOSITE2)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('s00'))
  key(doc, win, 'a', { ctrlKey: true })
  assert.equal(pm.selectedCount(), 4)
  key(doc, win, 'Tab')
  const marked = Array.from(doc.querySelectorAll('[data-af-cell]'))
  assert.ok(marked.length > 0, '前置：Tab 切整欄要有待選框')
  assert.ok(marked.every(m => m.tagName === 'TD'), `全選的是整格，框卻落在 ${marked.map(m => m.tagName).join(',')}`)
  pm.exitPickMode()
})

test('整列聚合帶 inner：被 colspan 涵蓋的欄不計成 skipped', () => {
  const res = extractValue(el(COLSPAN_ROW), { mode: 'block', block: { axis: 'row', index: 0, headerText: '', aggregate: 'sum', inner: [{ tag: 'span', index: 1 }] } })
  assert.equal(res.value, 20, JSON.stringify(res))
  assert.equal(res.used, 3)
  assert.equal(res.skipped, 0, `一格都沒略過，實得 skipped=${res.skipped}`)
})

test('診斷包：欄用位置定位＋inner 時不逐列報 resolved:false，改標未探測', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${COLSPAN_ROW}</body></html>`, { url: 'https://x.test/p' })
  globalThis.window = jd.window; globalThis.document = jd.window.document
  delete globalThis.__afContentLoaded
  await import('../src/content/main.js?t=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  const res = await new Promise((resolve) => listener({
    type: 'EXTRACT', locator: { css: '#t', path: '', anchor: null, xpath: '' },
    spec: { mode: 'block', block: { cell: { row: { index: 5, header: '' }, col: { pos: 'last' }, inner: [{ tag: 'span', index: 1 }] } } }
  }, {}, resolve))
  assert.equal(res.ok, false, '前置：第 6 列不存在要失敗')
  const probe = res.debug?.page?.table?.innerProbe
  assert.ok(Array.isArray(probe) && probe.length === 1, JSON.stringify(probe))
  assert.equal(probe[0].unprobed, 'pos')
  assert.deepEqual(probe[0].rows, [])
})

test('選取模式 chip 的格內標籤走 describe.js 的 withInnerLabel（不自己組字）', () => {
  const src = readFileSync(new URL('../src/content/picker-mode.js', import.meta.url), 'utf8')
  assert.ok(src.includes('withInnerLabel('), 'getPickName 要呼叫 withInnerLabel')
  assert.ok(!/innerLabel\(inner\)/.test(src), '不得另外呼叫 innerLabel 自己拼「 · 」')
})
