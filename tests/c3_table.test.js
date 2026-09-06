// AF-3 批次 C:表格解析成二維陣列(SPEC §7)
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { parseTable } from '../src/shared/table.js'

function el(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  return dom.window.document.body.firstElementChild
}

test('基本表格:表頭與資料分開,cells 只放資料列', () => {
  const r = parseTable(el(`<table>
    <thead><tr><th>日期</th><th>數量</th></tr></thead>
    <tbody><tr><td>09-01</td><td>10</td></tr>
           <tr><td>09-02</td><td>32</td></tr></tbody></table>`))
  assert.equal(r.source, 'table')
  assert.deepEqual(r.headers, ['日期', '數量'])
  assert.deepEqual(r.cells, [['09-01', '10'], ['09-02', '32']])
  assert.equal(r.partial, false)
})

test('沒有 thead 時,第一列若全是 th 也算表頭', () => {
  const r = parseTable(el(`<table><tr><th>A</th><th>B</th></tr>
    <tr><td>1</td><td>2</td></tr></table>`))
  assert.deepEqual(r.headers, ['A', 'B'])
  assert.deepEqual(r.cells, [['1', '2']])
})

test('完全沒有表頭時 headers 是空陣列,所有列都是資料', () => {
  const r = parseTable(el('<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>'))
  assert.deepEqual(r.headers, [])
  assert.deepEqual(r.cells, [['1', '2'], ['3', '4']])
})

test('rowspan 展開成實際格子', () => {
  const r = parseTable(el(`<table><tbody>
    <tr><td rowspan="2">甲</td><td>1</td></tr>
    <tr><td>2</td></tr></tbody></table>`))
  assert.deepEqual(r.cells, [['甲', '1'], ['甲', '2']], 'rowspan 的值要複製到下一列')
})

test('colspan 展開成實際格子', () => {
  const r = parseTable(el(`<table><tbody>
    <tr><td colspan="3">合計</td></tr>
    <tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>`))
  assert.deepEqual(r.cells, [['合計', '合計', '合計'], ['1', '2', '3']])
})

test('rowspan 與 colspan 同時出現', () => {
  const r = parseTable(el(`<table><tbody>
    <tr><td rowspan="2" colspan="2">大格</td><td>x</td></tr>
    <tr><td>y</td></tr></tbody></table>`))
  assert.deepEqual(r.cells, [['大格', '大格', 'x'], ['大格', '大格', 'y']])
})

test('巢狀 table 取最內層', () => {
  const r = parseTable(el(`<table><tbody><tr><td>
      <table><tbody><tr><td>1</td><td>2</td></tr>
      <tr><td>3</td><td>4</td></tr></tbody></table>
    </td></tr></tbody></table>`))
  assert.deepEqual(r.cells, [['1', '2'], ['3', '4']])
})

test('ARIA 表格(role=grid)', () => {
  const r = parseTable(el(`<div role="grid">
    <div role="row"><span role="columnheader">A</span><span role="columnheader">B</span></div>
    <div role="row"><span role="cell">1</span><span role="cell">2</span></div>
    <div role="row"><span role="gridcell">3</span><span role="gridcell">4</span></div></div>`))
  assert.equal(r.source, 'aria')
  assert.deepEqual(r.headers, ['A', 'B'])
  assert.deepEqual(r.cells, [['1', '2'], ['3', '4']])
})

test('CSS 假表格(同構容器)', () => {
  const r = parseTable(el(`<div>
    <div><span>09-01</span><span>10</span></div>
    <div><span>09-02</span><span>32</span></div>
    <div><span>09-03</span><span>7</span></div></div>`))
  assert.equal(r.source, 'grid')
  assert.deepEqual(r.cells, [['09-01', '10'], ['09-02', '32'], ['09-03', '7']])
  assert.deepEqual(r.headers, [], '假表格沒有語意上的表頭')
})

test('ul 以空白或 tab 切欄', () => {
  const r = parseTable(el('<ul><li>09-01\t10</li><li>09-02  32</li></ul>'))
  assert.equal(r.source, 'list')
  assert.deepEqual(r.cells, [['09-01', '10'], ['09-02', '32']])
})

test('ol 每項一列;沒有分隔就是單欄', () => {
  const r = parseTable(el('<ol><li>10</li><li>32</li></ol>'))
  assert.deepEqual(r.cells, [['10'], ['32']])
})

test('格子文字去頭尾空白', () => {
  const r = parseTable(el('<table><tr><td>  1,234  </td><td>\n  x \n</td></tr></table>'))
  assert.deepEqual(r.cells, [['1,234', 'x']])
})

test('虛擬捲動表格標記 partial(只渲染了可視列)', () => {
  const container = el(`<div role="grid" style="height:100px">
    <div role="row"><span role="cell">1</span><span role="cell">2</span></div>
    <div role="row"><span role="cell">3</span><span role="cell">4</span></div></div>`)
  Object.defineProperty(container, 'scrollHeight', { value: 900, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
  const r = parseTable(container)
  assert.equal(r.partial, true, '捲動高度遠大於可視高度 → 只抓到一部分')
})

test('沒有捲動時不得標 partial', () => {
  const container = el(`<div role="grid">
    <div role="row"><span role="cell">1</span></div>
    <div role="row"><span role="cell">2</span></div></div>`)
  Object.defineProperty(container, 'scrollHeight', { value: 100, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
  assert.equal(parseTable(container).partial, false)
})

test('不是表格的元素回空結果,不得拋例外', () => {
  const r = parseTable(el('<div>就一段字</div>'))
  assert.deepEqual(r.cells, [])
  assert.deepEqual(r.headers, [])
  assert.equal(parseTable(null).cells.length, 0)
})

test('列與列的欄數不同時,cells 保留各自的長度(不補空字串)', () => {
  const r = parseTable(el(`<table><tbody>
    <tr><td>1</td><td>2</td><td>3</td></tr>
    <tr><td>4</td></tr></tbody></table>`))
  assert.deepEqual(r.cells, [['1', '2', '3'], ['4']])
})
