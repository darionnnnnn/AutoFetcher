// AF-16 作業 B：選取模式的排除（右鍵排除／取消排除、tfoot 預設排除、排除標示、preselect）、
// 每格各一個值的去頭去尾、選取上限 100
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const MONITOR = `
<table id="mon">
  <thead><tr><th id="h0">主機</th><th id="h1">點金靈</th><th id="h2">TSWEB</th></tr></thead>
  <tbody>
    <tr><td id="c0-0">10.0.0.1</td><td id="c0-1">53</td><td id="c0-2">MAX:423</td></tr>
    <tr><td id="c1-0">10.0.0.2</td><td id="c1-1">49</td><td id="c1-2">MAX:425</td></tr>
    <tr><td id="c2-0">10.0.0.3</td><td id="c2-1">48</td><td id="c2-2">MAX:427</td></tr>
  </tbody>
  <tfoot><tr><td id="f0">合計</td><td id="f1">150</td><td id="f2">1275</td></tr></tfoot>
</table>
<table id="plain">
  <thead><tr><th>主機</th><th>值</th></tr></thead>
  <tbody><tr><td id="p0-1">a</td><td id="p0-2">1</td></tr><tr><td>b</td><td id="p1-2">2</td></tr></tbody>
</table>`

async function setup(body = MONITOR) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>監控</title></head><body>${body}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, pm, doc: jd.window.document }
}

const lastMsg = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).pop()
const hover = (doc, id) => doc.getElementById(id).dispatchEvent(new globalThis.MouseEvent('mousemove', { bubbles: true }))
const rightClick = (doc, id) => {
  hover(doc, id)
  doc.getElementById(id).dispatchEvent(new globalThis.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
}
const menuItems = (doc) => [...doc.querySelectorAll('[data-af-menu-item]')].map(el => el.dataset.afMenuItem)
const menuLabel = (doc, key) => doc.querySelector(`[data-af-menu-item="${key}"]`)?.textContent
const menu = (doc, id, key) => {
  rightClick(doc, id)
  const item = doc.querySelector(`[data-af-menu-item="${key}"]`)
  assert.ok(item, `右鍵選單要有 ${key}，實得 ${JSON.stringify(menuItems(doc))}`)
  item.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
}
const key = (doc, k, opts = {}) => doc.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))
const panelText = (doc) => doc.querySelector('[data-af-panel-body]')?.parentElement?.textContent || ''
const confirm = (doc, id = 'c0-1') => menu(doc, id, 'done')
const enter = (pm, doc, opts = {}) => pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById(opts.table || 'mon'), ...opts })

// ---- tfoot 預設排除 ----

test('整欄聚合建立當下：tfoot 的列自動進排除清單，面板說出來', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col')
  assert.match(panelText(doc), /已自動排除表尾 1 列/)
  confirm(doc)
  const msg = lastMsg(c)
  assert.equal(msg.type, 'PICKED')
  assert.deepEqual(msg.picks[0].block.exclude, [{ index: 3, header: '合計' }])
})

test('點表頭選整欄也走同一條：tfoot 自動排除', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  hover(doc, 'h1')
  doc.getElementById('h1').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  confirm(doc)
  assert.deepEqual(lastMsg(c).picks[0].block.exclude, [{ index: 3, header: '合計' }])
})

test('先點一格再按工具列「整欄」（單格升級成整欄）也走同一條：tfoot 自動排除', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  hover(doc, 'c0-1')
  doc.getElementById('c0-1').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  const tool = doc.querySelector('[data-af-tool="col"]')
  assert.ok(tool, '工具列要有整欄那一段')
  tool.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  assert.match(panelText(doc), /已自動排除表尾 1 列/)
  confirm(doc)
  const picks = lastMsg(c).picks
  assert.equal(picks.length, 1, '那一格要被升級取代，不是加選')
  assert.deepEqual(picks[0].block.exclude, [{ index: 3, header: '合計' }])
})

test('沒有 tfoot 的表：不帶 exclude 鍵、不提示', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc, { table: 'plain' })
  menu(doc, 'p0-2', 'col')
  assert.doesNotMatch(panelText(doc), /表尾/)
  confirm(doc, 'p0-2')
  assert.equal('exclude' in lastMsg(c).picks[0].block, false)
})

test('整列聚合沒有表尾：不自動排除', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'row')
  confirm(doc)
  assert.equal('exclude' in lastMsg(c).picks[0].block, false)
})

test('preselect 帶回來的整欄值不再自動加表尾（使用者之前取消過的不得復活）', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc, { purpose: 'repick', preselect: [{ block: { axis: 'col', index: 1, headerText: '點金靈' } }] })
  confirm(doc)
  assert.equal('exclude' in lastMsg(c).picks[0].block, false)
})

// ---- 右鍵排除／取消排除 ----

test('右鍵選單：格子在已選整欄範圍內才多一項「從整欄聚合排除這一列」', async () => {
  const { pm, doc } = await setup()
  enter(pm, doc)
  rightClick(doc, 'c0-1')
  assert.equal(menuItems(doc).includes('exclude'), false, '還沒有整欄值時不出現')
  doc.querySelector('[data-af-menu-item="cancel"]') // 關掉選單：點別處
  doc.body.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  menu(doc, 'c0-1', 'col')
  rightClick(doc, 'c1-1')
  assert.ok(menuItems(doc).includes('exclude'))
  assert.equal(menuLabel(doc, 'exclude'), '從整欄聚合排除這一列')
  rightClick(doc, 'c1-2')
  assert.equal(menuItems(doc).includes('exclude') || menuItems(doc).includes('include'), false, '別欄的格子不在範圍內')
})

test('排除一列、再取消：exclude 跟著變，PICKED 帶出最後的狀態', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col')
  menu(doc, 'c0-1', 'exclude')
  rightClick(doc, 'f1')
  assert.equal(menuLabel(doc, 'include'), '取消排除這一列', '已排除的格子要改成取消排除')
  doc.querySelector('[data-af-menu-item="include"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  confirm(doc)
  assert.deepEqual(lastMsg(c).picks[0].block.exclude, [{ index: 0, header: '10.0.0.1' }])
})

test('全部取消排除：PICKED 的 block 不帶 exclude 鍵', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col')
  menu(doc, 'f1', 'include')
  confirm(doc)
  assert.equal('exclude' in lastMsg(c).picks[0].block, false)
})

test('整列聚合：排除的是欄，標籤跟著軸走', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'row')
  rightClick(doc, 'c0-2')
  assert.equal(menuLabel(doc, 'exclude'), '從整列聚合排除這一欄')
  doc.querySelector('[data-af-menu-item="exclude"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  confirm(doc)
  assert.deepEqual(lastMsg(c).picks[0].block.exclude, [{ index: 2, header: 'TSWEB' }])
})

test('同一格被整欄與整列兩個值涵蓋：排除進清單裡最後一個涵蓋它的值', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col')
  menu(doc, 'c0-1', 'row')
  rightClick(doc, 'c0-1')
  assert.equal(menuLabel(doc, 'exclude'), '從整列聚合排除這一欄')
  doc.querySelector('[data-af-menu-item="exclude"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  confirm(doc)
  const [colPick, rowPick] = lastMsg(c).picks
  assert.deepEqual(colPick.block.exclude, [{ index: 3, header: '合計' }], '整欄那個值不得被動到')
  assert.deepEqual(rowPick.block.exclude, [{ index: 1, header: '點金靈' }])
})

test('排除的格子有標示，滑鼠移動後仍在；取消排除後消失', async () => {
  const { pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col')
  hover(doc, 'c2-1')
  const marked = () => [...doc.querySelectorAll('[data-af-excluded]')].map(el => el.id)
  assert.deepEqual(marked(), ['f1'])
  menu(doc, 'c1-1', 'exclude')
  hover(doc, 'c2-2')
  assert.deepEqual(marked().sort(), ['c1-1', 'f1'])
  menu(doc, 'f1', 'include')
  hover(doc, 'c0-0')
  assert.deepEqual(marked(), ['c1-1'])
})

// ---- preselect 回勾 ----

test('preselect：排除項以列標題勾回，表格前面插一列也勾對列', async () => {
  const inserted = MONITOR.replace('<tbody>', '<tbody><tr><td id="n0">10.0.0.9</td><td id="n1">7</td><td>MAX:1</td></tr>')
  const { c, pm, doc } = await setup(inserted)
  enter(pm, doc, { purpose: 'repick', preselect: [{ block: { axis: 'col', index: 1, headerText: '點金靈', exclude: [{ index: 3, header: '合計' }] } }] })
  hover(doc, 'c0-1')
  assert.deepEqual([...doc.querySelectorAll('[data-af-excluded]')].map(el => el.id), ['f1'])
  assert.match(panelText(doc), /位置已變/)
  confirm(doc)
  assert.deepEqual(lastMsg(c).picks[0].block.exclude, [{ index: 4, header: '合計' }])
})

test('preselect：排除項的標題不見了就略過那一項並提示', async () => {
  const noTotal = MONITOR.replace(/<tfoot>.*<\/tfoot>/s, '')
  const { c, pm, doc } = await setup(noTotal)
  enter(pm, doc, { purpose: 'repick', preselect: [{ block: { axis: 'col', index: 1, headerText: '點金靈', exclude: [{ index: 3, header: '合計' }, { index: 0, header: '10.0.0.1' }] } }] })
  assert.match(panelText(doc), /位置已變/)
  confirm(doc)
  assert.deepEqual(lastMsg(c).picks[0].block.exclude, [{ index: 0, header: '10.0.0.1' }])
})

// ---- 每格各一個值的去頭去尾 ----

const trimHead = (doc) => doc.querySelector('[data-af-trim-head]')
const trimTail = (doc) => doc.querySelector('[data-af-trim-tail]')
const click = (el) => el.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))

test('每格各一個值之後出現「去掉第一格／最後一格」，可連按', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  assert.ok(trimHead(doc) && trimTail(doc), '按鈕建一次，一開始就在（只是藏著）')
  assert.equal(trimHead(doc).hidden, true)
  menu(doc, 'c0-1', 'col-each')
  assert.equal(trimHead(doc).hidden, false)
  assert.equal(trimTail(doc).hidden, false)
  click(trimHead(doc))
  click(trimTail(doc))
  click(trimTail(doc))
  confirm(doc)
  const rows = lastMsg(c).picks.map(p => p.cell.row.index)
  assert.deepEqual(rows, [1], '4 格去頭 1、去尾 2')
})

test('去頭去尾可以 Ctrl+Z 反悔一步', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col-each')
  click(trimTail(doc))
  key(doc, 'z', { ctrlKey: true })
  confirm(doc)
  assert.equal(lastMsg(c).picks.length, 4)
})

test('之後改用別的方式加選：兩顆鈕收起來', async () => {
  const { pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col-each')
  menu(doc, 'c0-2', 'cell')
  assert.equal(trimHead(doc).hidden, true)
  assert.equal(trimTail(doc).hidden, true)
})

test('只剩一個值：兩顆鈕停用、點了不動並說出原因', async () => {
  const body = `<table id="mon"><thead><tr><th>a</th><th>b</th></tr></thead><tbody>
    <tr><td>x</td><td id="c0-1">1</td></tr><tr><td>y</td><td id="c1-1">2</td></tr></tbody></table>`
  const { c, pm, doc } = await setup(body)
  enter(pm, doc)
  menu(doc, 'c0-1', 'col-each')
  click(trimHead(doc))
  assert.equal(trimHead(doc).getAttribute('aria-disabled'), 'true')
  click(trimTail(doc))
  assert.match(panelText(doc), /只剩一個值/)
  confirm(doc, 'c1-1')
  assert.equal(lastMsg(c).picks.length, 1)
})

test('整列的每格各一個值也適用（去掉第一格＝列標題那一格）', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'row-each')
  click(trimHead(doc))
  confirm(doc)
  assert.deepEqual(lastMsg(c).picks.map(p => p.cell.col.index), [1, 2])
})

// ---- 上限 100 ----

test('上限 100：101 列的表每格各一個值只選到 100 個，面板顯示計數', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => `<tr><td>h${i}</td><td id="r${i}">${i}</td></tr>`).join('')
  const { c, pm, doc } = await setup(`<table id="mon"><thead><tr><th>主機</th><th>值</th></tr></thead><tbody>${rows}</tbody></table>`)
  enter(pm, doc)
  assert.match(doc.querySelector('[data-af-count]')?.textContent || '', /已選 0／100/)
  menu(doc, 'r0', 'col-each')
  assert.match(doc.querySelector('[data-af-count]').textContent, /已選 100／100/)
  assert.match(panelText(doc), /已達選取上限/)
  confirm(doc, 'r0')
  assert.equal(lastMsg(c).picks.length, 100)
})

// ---- exitPickMode 重設 ----

test('連續選兩次：排除、去頭去尾狀態與計數不得殘留到下一次', async () => {
  const { c, pm, doc } = await setup()
  enter(pm, doc)
  menu(doc, 'c0-1', 'col-each')
  pm.exitPickMode()
  enter(pm, doc)
  assert.equal(trimHead(doc).hidden, true, '上一次的「最近動作是每格各一個值」不得殘留')
  assert.match(doc.querySelector('[data-af-count]').textContent, /已選 0／100/)
  menu(doc, 'c0-1', 'row')
  confirm(doc)
  const picks = lastMsg(c).picks
  assert.equal(picks.length, 1)
  assert.equal('exclude' in picks[0].block, false)
})
