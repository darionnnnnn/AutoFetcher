// AF-3 批次 B:區塊型別偵測(純函式,選取模式面板與 §7 區塊聚合共用同一份判定)
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { detectKind } from '../src/shared/block-detect.js'

function el(html, sel) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  return sel ? dom.window.document.querySelector(sel) : dom.window.document.body.firstElementChild
}

test('純數字元素判定為 number,並帶解析後的值', () => {
  const r = detectKind(el('<div>1,234 元</div>'))
  assert.equal(r.kind, 'number')
  assert.equal(r.value, 1234)
})

test('會計負數與全形數字也算 number', () => {
  assert.equal(detectKind(el('<span>（500）</span>')).kind, 'number')
  assert.equal(detectKind(el('<span>１２３</span>')).value, 123)
})

test('沒有數字的元素判定為 text', () => {
  const r = detectKind(el('<div>今日總量</div>'))
  assert.equal(r.kind, 'text')
  assert.equal(r.value, null)
})

test('table 判定為 table,並回報列數欄數與表頭', () => {
  const r = detectKind(el(`<table>
    <thead><tr><th>日期</th><th>數量</th><th>備註</th></tr></thead>
    <tbody><tr><td>09-01</td><td>10</td><td>a</td></tr>
           <tr><td>09-02</td><td>32</td><td>b</td></tr></tbody></table>`))
  assert.equal(r.kind, 'table')
  assert.equal(r.cols, 3)
  assert.equal(r.rows, 3, '含表頭列')
  assert.deepEqual(r.headers, ['日期', '數量', '備註'])
})

test('ARIA 表格(role=grid/table)也判定為 table', () => {
  const r = detectKind(el(`<div role="grid">
    <div role="row"><span role="columnheader">A</span><span role="columnheader">B</span></div>
    <div role="row"><span role="cell">1</span><span role="cell">2</span></div></div>`))
  assert.equal(r.kind, 'table')
  assert.equal(r.cols, 2)
  assert.equal(r.rows, 2)
  assert.deepEqual(r.headers, ['A', 'B'])
})

test('ARIA 表格沒有表頭時,欄數仍要從資料列(role=cell)數出來', () => {
  const r = detectKind(el(`<div role="table">
    <div role="row"><span role="cell">1</span><span role="cell">2</span><span role="cell">3</span></div>
    <div role="row"><span role="cell">4</span><span role="cell">5</span><span role="cell">6</span></div></div>`))
  assert.equal(r.kind, 'table')
  assert.equal(r.cols, 3, 'role="cell" 也是資料格,不能只認 gridcell')
  assert.equal(r.rows, 2)
  assert.deepEqual(r.headers, [])
})

test('role=gridcell 一樣要算進欄數', () => {
  const r = detectKind(el(`<div role="grid">
    <div role="row"><span role="gridcell">1</span><span role="gridcell">2</span></div>
    <div role="row"><span role="gridcell">3</span><span role="gridcell">4</span></div></div>`))
  assert.equal(r.cols, 2)
})

test('ul / ol 判定為 list 並回報項目數', () => {
  const r = detectKind(el('<ul><li>a</li><li>b</li><li>c</li></ul>'))
  assert.equal(r.kind, 'list')
  assert.equal(r.rows, 3)
})

test('同構子節點的容器判定為 grid', () => {
  const r = detectKind(el(`<div>
    <div><span>09-01</span><span>10</span></div>
    <div><span>09-02</span><span>32</span></div>
    <div><span>09-03</span><span>7</span></div></div>`))
  assert.equal(r.kind, 'grid')
  assert.equal(r.rows, 3)
  assert.equal(r.cols, 2)
})

test('子節點結構不一致的容器不算 grid', () => {
  const r = detectKind(el(`<div>
    <div><span>a</span></div>
    <div><span>b</span><span>c</span></div>
    <div><span>d</span><span>e</span><span>f</span></div></div>`))
  assert.notEqual(r.kind, 'grid')
})

test('每列只有一欄的容器不算 grid(那只是普通的區塊排版)', () => {
  const r = detectKind(el(`<div>
    <div><span>甲</span></div>
    <div><span>乙</span></div>
    <div><span>丙</span></div></div>`))
  assert.notEqual(r.kind, 'grid', '單欄不成表格,聚合也沒有意義')
})

test('只有兩個同構子節點不算 grid(太容易誤判)', () => {
  const r = detectKind(el(`<div>
    <div><span>a</span><span>1</span></div>
    <div><span>b</span><span>2</span></div></div>`))
  assert.notEqual(r.kind, 'grid')
})

test('巢狀 table 取最內層那一個', () => {
  const outer = el(`<table><tbody><tr><td>
      <table id="inner"><tbody><tr><td>1</td><td>2</td></tr>
      <tr><td>3</td><td>4</td></tr></tbody></table>
    </td></tr></tbody></table>`)
  const r = detectKind(outer)
  assert.equal(r.kind, 'table')
  assert.equal(r.cols, 2, '應描述最內層的表格')
  assert.equal(r.rows, 2)
})

test('null / undefined 不得拋例外', () => {
  assert.equal(detectKind(null).kind, 'text')
  assert.equal(detectKind(undefined).kind, 'text')
})

test('表格沒有表頭列時 headers 為空陣列而不是 undefined', () => {
  const r = detectKind(el('<table><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>'))
  assert.equal(r.kind, 'table')
  assert.deepEqual(r.headers, [])
})
