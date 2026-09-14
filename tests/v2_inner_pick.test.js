// AF-15 批次 B1：選取端核心——明確選定的表要鎖、複合格的子單位、網格索引、pick 帶 inner、samePick
// 對照 docs/AF-15-PLAN.md 批次 B1 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { extractValue } from '../src/shared/extract.js'

// 使用者實站的監控頁：外層每一列的第 3 格各包一張 1×2 小表
const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
// 一張與監控頁不相干的表（滑鼠移過去才解除鎖）
const OTHER = '<table id="other"><tbody><tr><td id="ot">1</td><td>2</td></tr></tbody></table>'
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
const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
const click = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }))
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const picked = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  .filter(m => m?.type === 'PICKED' && !m.cancelled)

// 監控頁上的節點
const outerOf = (doc) => doc.querySelector('table')
const inner2 = (doc, id = 'his_31') => doc.getElementById(id).closest('td') // 小表第 2 格（MAX:462）
const outerTdOf = (innerTd) => innerTd.closest('table').closest('td')      // 外層那一格

// 進入選取模式、滑鼠停在小表第 2 格、按 ↑ 切到外層表
async function onOuter(extra = '') {
  const b = await boot(MONITOR + extra)
  b.pm.enterPickMode({ purpose: 'task', initialTarget: b.doc.body })
  move(b.win, inner2(b.doc))
  assert.equal(b.pm.currentTarget(), inner2(b.doc).closest('table'), '前置：滑鼠在小表格子上時目標是內層小表（既有規則不變）')
  key(b.doc, b.win, 'ArrowUp')
  assert.equal(b.pm.currentTarget(), outerOf(b.doc), '前置：↑ 切到外層表')
  return b
}

// ---------- 明確選定的表要鎖 ----------

test('B1 按 ↑ 切到外層表後，滑鼠再移回小表格子，目標仍是外層表', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), outerOf(doc), '↑ 是明確意圖，滑鼠路過不得把目標升回內層小表')
  move(win, inner2(doc, 'his_33'))
  assert.equal(pm.currentTarget(), outerOf(doc), '移到別一列的小表也一樣')
  pm.exitPickMode()
})

test('B1 鎖住之後 ↓ 仍能回到內層小表（backStack 不得被滑鼠移動清掉）', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), outerOf(doc), '前置：滑鼠移動後仍鎖在外層表（否則下面的 ↓ 什麼都沒驗到）')
  key(doc, win, 'ArrowDown')
  assert.equal(pm.currentTarget(), inner2(doc).closest('table'))
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), inner2(doc).closest('table'), '↓ 選定的是內層表，就鎖在內層表')
  pm.exitPickMode()
})

test('B1 滑鼠移到不相干的另一張表才解除鎖', async () => {
  const { doc, pm, win } = await onOuter(OTHER)
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), outerOf(doc), '前置：先確認鎖住了（否則沒有鎖可以解除）')
  move(win, doc.getElementById('ot'))
  assert.equal(pm.currentTarget(), doc.getElementById('other'))
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), inner2(doc).closest('table'), '解除之後照既有規則升到內層小表')
  pm.exitPickMode()
})

test('B1 ↑ 走到非表格時清掉鎖', async () => {
  const { doc, pm, win } = await onOuter()
  key(doc, win, 'ArrowUp')
  assert.equal(pm.currentTarget(), doc.body, '前置：外層表的父層是 body')
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), inner2(doc).closest('table'), '離開表格之後滑鼠照常跟隨')
  pm.exitPickMode()
})

test('B1 離開選取模式要重設鎖：再進來滑鼠照常升到內層小表', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  click(win, inner2(doc))
  key(doc, win, 'Escape')
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), inner2(doc).closest('table'), '上一輪的鎖不得殘留')
  assert.equal(pm.selectedCount(), 0)
  pm.exitPickMode()
})

// ---------- 巢狀表的子單位 ----------

test('B1 外層表為目標、滑鼠在小表第 2 格：只標那一格，外層格不標', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  assert.equal(pm.currentTarget(), outerOf(doc), '前置：目標是外層表（內層小表當目標時標那一格是既有行為，不算子單位）')
  assert.equal(inner2(doc).hasAttribute('data-af-cell'), true, '子單位要帶待選標記')
  assert.equal(outerTdOf(inner2(doc)).hasAttribute('data-af-cell'), false, '外層那一格不得標')
  // 滑鼠在小表格子裡的 span 上：子單位仍是最內層的格子
  move(win, doc.getElementById('his_31'))
  assert.equal(inner2(doc).hasAttribute('data-af-cell'), true)
  assert.equal(doc.getElementById('his_31').hasAttribute('data-af-cell'), false, '巢狀表的子單位是格子，不是格子裡的 span')
  pm.exitPickMode()
})

test('B1 點一下：pick 帶外層列欄索引與到小表第 2 格的路徑，裡面沒有任何 DOM 節點', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  click(win, inner2(doc))
  const [pick] = pm.selectedPicks()
  assert.ok(pick?.cell, JSON.stringify(pick))
  assert.equal(pick.cell.row.index, 2, '監控頁第 3 個資料列是 10.231.1.31')
  assert.equal(pick.cell.row.header, '10.231.1.31')
  assert.equal(pick.cell.col.index, 2)
  assert.deepEqual(pick.cell.inner, SMALL_TABLE_2ND)
  assert.deepEqual(JSON.parse(JSON.stringify(pick)), pick, 'pick 只能是純資料（不存元素參照）')
  pm.exitPickMode()
})

test('B1 送出後 held 藍框留在子單位上，不在外層格', async () => {
  const { c, doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  click(win, inner2(doc))
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.deepEqual(msg.picks[0].cell.inner, SMALL_TABLE_2ND)
  assert.equal(msg.preview, 'MAX:462', `預覽是子單位的文字，實得 ${JSON.stringify(msg.preview)}`)
  assert.equal(msg.previewValue, 462)
  assert.equal(inner2(doc).getAttribute('data-af-held'), 'task')
  assert.equal(outerTdOf(inner2(doc)).hasAttribute('data-af-held'), false)
  pm.exitPickMode()
})

test('B1 Enter 快速路徑（沒點就按 Enter）也帶滑鼠下的子單位', async () => {
  const { c, doc, pm, win } = await onOuter()
  move(win, doc.getElementById('his_31'))
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.ok(msg, '要送出一則 PICKED')
  assert.deepEqual(msg.picks[0].cell?.inner, SMALL_TABLE_2ND, `Enter 不得退回外層整格，實得 ${JSON.stringify(msg.picks[0])}`)
  pm.exitPickMode()
})

test('B1 雙擊送出也帶子單位', async () => {
  const { c, doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  inner2(doc).dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }))
  const msg = picked(c)[0]
  assert.deepEqual(msg?.picks?.[0]?.cell?.inner, SMALL_TABLE_2ND, JSON.stringify(msg?.picks))
  pm.exitPickMode()
})

test('B1 整欄模式：每一列解析同一條路徑，解析得到的才標；送出的 block 帶 inner', async () => {
  const { c, doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  click(win, tool(doc, 'col'))
  move(win, inner2(doc))
  const marked = Array.from(doc.querySelectorAll('[data-af-cell]'))
  // 5 台主機＋合計列；標題列、欄名列（PORT:443）、PublicIP 列都不標
  assert.equal(marked.length, 6, `實得 ${marked.map(m => m.textContent.trim()).join(' | ')}`)
  assert.ok(marked.every(m => m.closest('table') !== outerOf(doc)), '標的都是小表裡的格子，不是外層格')
  assert.ok(!marked.some(m => /203\.69/.test(m.textContent)), 'PublicIP 列是 colspan=4、起點不在這一欄')
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  const block = msg.picks[0].block
  assert.ok(block, JSON.stringify(msg.picks[0]))
  assert.equal(block.axis, 'col')
  assert.equal(block.index, 2)
  assert.deepEqual(block.inner, SMALL_TABLE_2ND)
  assert.match(msg.preview, /6 格/, `整欄描述的格數是解析得到的格數，實得 ${JSON.stringify(msg.preview)}`)
  pm.exitPickMode()
})

test('B1 先點一格再按整欄：升級出來的 block 帶同一條 inner', async () => {
  const { doc, pm, win } = await onOuter()
  move(win, inner2(doc))
  click(win, inner2(doc))
  click(win, tool(doc, 'col'))
  const [pick] = pm.selectedPicks()
  assert.ok(pick?.block, JSON.stringify(pick))
  assert.deepEqual(pick.block.inner, SMALL_TABLE_2ND)
  pm.exitPickMode()
})

test('B1 滑鼠停在外層格自己（不在小表上）：標整格，pick 沒有 inner 這個鍵', async () => {
  const { doc, pm, win } = await onOuter()
  const outerTd = outerTdOf(inner2(doc))
  move(win, outerTd)
  assert.equal(outerTd.hasAttribute('data-af-cell'), true)
  click(win, outerTd)
  const [pick] = pm.selectedPicks()
  assert.ok(pick?.cell)
  assert.equal('inner' in pick.cell, false, `沒有子單位時不帶 inner（也不帶空陣列），實得 ${JSON.stringify(pick)}`)
  pm.exitPickMode()
})

test('B1 同一格的「整格」與「格內第 2 格」是兩個值；Ctrl 點同一個子單位是移除', async () => {
  const { doc, pm, win } = await onOuter()
  const outerTd = outerTdOf(inner2(doc))
  move(win, outerTd)
  click(win, outerTd)
  move(win, inner2(doc))
  click(win, inner2(doc), { ctrlKey: true })
  assert.equal(pm.selectedCount(), 2, 'samePick 要比 inner，否則第二個會被當成重複')
  click(win, inner2(doc), { ctrlKey: true })
  assert.equal(pm.selectedCount(), 1)
  assert.equal('inner' in pm.selectedPicks()[0].cell, false, '移除的是子單位那一個，整格留著')
  pm.exitPickMode()
})

// ---------- 非表格的複合格 ----------

const COMPOSITE = `<table id="t2"><tbody>
  <tr><td>甲</td><td id="d1"><div id="wrap1"><b>MAX</b><span id="sp1">462</span></div></td><td id="s1"><span id="lone1">31.5</span></td></tr>
  <tr><td>乙</td><td><div><b>MAX</b><span id="sp2">460</span></div></td><td><span>32.1</span></td></tr>
</tbody></table>`

test('B1 複合格（格內兩個以上帶文字的元素）：子單位是滑鼠下帶文字的那個元素', async () => {
  const { doc, pm, win } = await boot(COMPOSITE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('sp1'))
  assert.equal(pm.currentTarget(), doc.getElementById('t2'))
  assert.equal(doc.getElementById('sp1').hasAttribute('data-af-cell'), true)
  assert.equal(doc.getElementById('d1').hasAttribute('data-af-cell'), false)
  click(win, doc.getElementById('sp1'))
  assert.deepEqual(pm.selectedPicks()[0].cell.inner, [{ tag: 'div', index: 1 }, { tag: 'span', index: 1 }])
  pm.exitPickMode()
})

test('B1 複合格裡停在沒有自己文字的包裝元素上：不算子單位（整格）', async () => {
  const { doc, pm, win } = await boot(COMPOSITE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('wrap1'))
  click(win, doc.getElementById('wrap1'))
  assert.equal('inner' in pm.selectedPicks()[0].cell, false, JSON.stringify(pm.selectedPicks()[0]))
  pm.exitPickMode()
})

test('B1 守門：只包一個元素的格子（<td><span>31.5</span></td>）維持整格，不長出 inner', async () => {
  const { c, doc, pm, win } = await boot(COMPOSITE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('lone1'))
  assert.equal(doc.getElementById('s1').hasAttribute('data-af-cell'), true, '標的是那一格')
  click(win, doc.getElementById('lone1'))
  key(doc, win, 'Enter')
  const pick = picked(c)[0].picks[0]
  assert.equal('inner' in pick.cell, false, `一般表格的包裝標籤不得變成子路徑（網站改個 span 就抓不到），實得 ${JSON.stringify(pick)}`)
  pm.exitPickMode()
})

test('B1 複合格整欄：兩列的 span 都標，送出後擷取端抓得到', async () => {
  const { c, doc, pm, win } = await boot(COMPOSITE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('sp1'))
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('sp1'))
  assert.equal(doc.getElementById('sp1').hasAttribute('data-af-cell'), true)
  assert.equal(doc.getElementById('sp2').hasAttribute('data-af-cell'), true)
  key(doc, win, 'Enter')
  const block = picked(c)[0].picks[0].block
  const res = extractValue(doc.getElementById('t2'), { mode: 'block', block: { ...block, aggregate: 'sum' } })
  assert.equal(res.value, 922, `選取端送出的規格要讓擷取端抓到同一批格子，實得 ${JSON.stringify(res)}`)
  pm.exitPickMode()
})

// ---------- CSS 假表格與 ARIA 表也適用子單位（規劃定案：判定通用於三種表） ----------

const CSS_GRID = `<div id="g">
  <div><span>甲</span><span id="g1"><b>MAX</b><i id="gi1">10</i></span></div>
  <div><span>乙</span><span><b>MAX</b><i id="gi2">20</i></span></div>
  <div><span>丙</span><span><b>MAX</b><i id="gi3">30</i></span></div>
</div>`

test('B1 CSS 假表格的複合格：子單位是帶文字的元素，整欄擷取抓得到同一批', async () => {
  const { c, doc, pm, win } = await boot(CSS_GRID)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  // 純 CSS 假表格沒有格子選擇器可升級：指到子元素時目標跟著滑鼠走（既有行為），
  // 要用 ↑ 走到容器，明確選定的鎖才會留住它——這正是鎖對假表格也要有效的理由
  move(win, doc.getElementById('gi1'))
  for (let i = 0; i < 3 && pm.currentTarget() !== doc.getElementById('g'); i++) key(doc, win, 'ArrowUp')
  assert.equal(pm.currentTarget(), doc.getElementById('g'), '前置：↑ 到假表格容器')
  move(win, doc.getElementById('gi1'))
  assert.equal(pm.currentTarget(), doc.getElementById('g'), '鎖住之後指到子元素不得換目標')
  assert.equal(doc.getElementById('gi1').hasAttribute('data-af-cell'), true, '子單位要被框')
  assert.equal(doc.getElementById('g1').hasAttribute('data-af-cell'), false)
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('gi1'))
  assert.equal(doc.getElementById('gi3').hasAttribute('data-af-cell'), true, '整欄要框到第 3 列的子單位')
  key(doc, win, 'Enter')
  const block = picked(c)[0].picks[0].block
  assert.deepEqual(block.inner, [{ tag: 'i', index: 1 }])
  const res = extractValue(doc.getElementById('g'), { mode: 'block', block: { ...block, aggregate: 'sum' } })
  assert.equal(res.value, 60, `擷取端要抓到同一批子單位，實得 ${JSON.stringify(res)}`)
  pm.exitPickMode()
})

const ARIA = `<div role="table" id="a">
  <div role="row"><div role="cell">甲</div><div role="cell" id="a1"><b>MAX</b><i id="ai1">7</i></div></div>
  <div role="row"><div role="cell">乙</div><div role="cell"><b>MAX</b><i id="ai2">8</i></div></div>
</div>`

test('B1 ARIA 表的複合格：子單位與擷取端一致', async () => {
  const { c, doc, pm, win } = await boot(ARIA)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('a') })
  move(win, doc.getElementById('ai1'))
  assert.equal(doc.getElementById('ai1').hasAttribute('data-af-cell'), true)
  click(win, doc.getElementById('ai1'))
  key(doc, win, 'Enter')
  const cell = picked(c)[0].picks[0].cell
  assert.deepEqual(cell.inner, [{ tag: 'i', index: 1 }])
  assert.equal(cell.col.index, 1)
  const res = extractValue(doc.getElementById('a'), { mode: 'block', block: { cell } })
  assert.equal(res.value, 7, JSON.stringify(res))
  pm.exitPickMode()
})

// ---------- colspan：選取端改用網格索引 ----------

const COLSPAN = `<table id="cs"><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody>
  <tr><td colspan="2" id="ab">ab</td><td id="c1">c1</td></tr>
  <tr><td>a2</td><td id="b2">b2</td><td id="c2">c2</td></tr>
</tbody></table>`

test('B1 colspan：點 c1 存網格索引 2 與表頭 C，擷取端抓到同一格', async () => {
  const { c, doc, pm, win } = await boot(COLSPAN)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('c1'))
  click(win, doc.getElementById('c1'))
  assert.equal(doc.getElementById('c1').hasAttribute('data-af-picked'), true, '已選標記要貼在 c1')
  assert.equal(doc.getElementById('ab').hasAttribute('data-af-picked'), false, '不得貼到網格索引 1 的 ab')
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  const cell = msg.picks[0].cell
  assert.equal(cell.col.index, 2, `實得 ${JSON.stringify(cell)}`)
  assert.equal(cell.col.header, 'C')
  assert.equal(msg.preview, 'c1')
  const got = extractValue(doc.getElementById('cs'), { mode: 'block', block: { cell } })
  assert.equal(got.raw, 'c1', `選取端與擷取端要是同一格，實得 ${JSON.stringify(got)}`)
  pm.exitPickMode()
})

test('B1 colspan：整欄模式標 c1 與 c2，不標 b2', async () => {
  const { doc, pm, win } = await boot(COLSPAN)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('c1'))
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('c1'))
  assert.equal(doc.getElementById('c1').hasAttribute('data-af-cell'), true)
  assert.equal(doc.getElementById('c2').hasAttribute('data-af-cell'), true)
  assert.equal(doc.getElementById('b2').hasAttribute('data-af-cell'), false)
  pm.exitPickMode()
})
