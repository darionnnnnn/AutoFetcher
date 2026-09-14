// AF-15 批次 A：格內子路徑（inner）的產生與解析、網格索引換算、擷取端接 inner
// 對照 docs/AF-15-PLAN.md 批次 A 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import {
  innerPathOf, resolveInner, gridIndexOf, cellAtGridIndex, getDataRows, rowCellsOf
} from '../src/shared/table.js'
import { extractValue } from '../src/shared/extract.js'

// 使用者實站的監控頁：外層每一列的第 3 格各包一張 1×2 小表；
// 第 1 列與最後一列是 colspan=4 的格子（最後一列裡還包著 PublicIP／SLB 小表，是本輪的陷阱）
const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
const HOST_ROW = 2 // 10.231.1.31
const VALUE_COL = 2
const SMALL_TABLE_2ND = [
  { tag: 'table', index: 1 }, { tag: 'tbody', index: 1 }, { tag: 'tr', index: 1 }, { tag: 'td', index: 2 }
]

function monitorTable() {
  return new JSDOM(`<!doctype html><body>${MONITOR}</body>`).window.document.querySelector('table')
}
function el(html) {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body.firstElementChild
}
const cellSpec = (over = {}) => ({
  mode: 'block',
  block: { cell: { row: { index: HOST_ROW, header: '10.231.1.31' }, col: { index: VALUE_COL, header: '' }, ...over } }
})

// ---------- 路徑的產生與解析 ----------

test('A 監控頁：外層格到小表第 2 格的路徑，往返解析回同一個元素', () => {
  const outer = monitorTable()
  const outerTd = getDataRows(outer)[HOST_ROW].cells[VALUE_COL]
  const innerTd = outerTd.querySelector('table').rows[0].cells[1]
  assert.equal(innerTd.textContent.trim(), 'MAX:462', 'fixture 的小表第 2 格應是 MAX:462')
  const path = innerPathOf(outerTd, innerTd)
  assert.deepEqual(path, SMALL_TABLE_2ND, '瀏覽器自動補的 tbody 也要在路徑裡')
  assert.equal(resolveInner(outerTd, path), innerTd)
})

test('A 非表格巢狀：同層同標籤從 1 起算，不同標籤各自計數', () => {
  const table = el('<table><tr><td><div><b>x</b><span>a</span><span>b</span></div></td></tr></table>')
  const cell = table.rows[0].cells[0]
  const target = cell.querySelectorAll('span')[1]
  const path = innerPathOf(cell, target)
  assert.deepEqual(path, [{ tag: 'div', index: 1 }, { tag: 'span', index: 2 }])
  assert.equal(resolveInner(cell, path), target)
})

test('A 目標就是格子本身回空陣列；不在格內回 null', () => {
  const table = el('<table><tr><td><span>a</span></td><td>b</td></tr></table>')
  const [first, second] = table.rows[0].cells
  assert.deepEqual(innerPathOf(first, first), [])
  assert.equal(resolveInner(first, []), first, '空路徑就是格子本身')
  assert.equal(innerPathOf(first, second), null)
  assert.equal(innerPathOf(first, null), null)
})

test('A 路徑形狀不合法或走不到都回 null（不得退回格子本身）', () => {
  const table = el('<table><tr><td><div><span>a</span></div></td></tr></table>')
  const cell = table.rows[0].cells[0]
  const bad = [
    'div', {}, [{ tag: 'div' }], [{ index: 1 }], [{ tag: 'div', index: 0 }],
    [{ tag: 'div', index: 1.5 }], [{ tag: 'div', index: '1' }], [{ tag: 3, index: 1 }],
    [{ tag: 'div', index: 2 }], [{ tag: 'div', index: 1 }, { tag: 'span', index: 2 }], [{ tag: 'p', index: 1 }]
  ]
  assert.ok(bad.length > 0)
  for (const path of bad) {
    assert.equal(resolveInner(cell, path), null, `路徑 ${JSON.stringify(path)} 應回 null`)
  }
})

// ---------- 網格索引 ↔ DOM 格子 ----------

test('A colspan：網格索引與 DOM 格子互換（探針那張表）', () => {
  const table = el('<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>' +
    '<tbody><tr><td colspan="2">ab</td><td>c1</td></tr></tbody></table>')
  const row = table.tBodies[0].rows[0]
  const [ab, c1] = row.cells
  assert.equal(gridIndexOf(row, ab), 0)
  assert.equal(gridIndexOf(row, c1), 2, 'c1 在網格上是第 3 欄，不是 DOM 的第 2 個')
  assert.equal(cellAtGridIndex(row, 0), ab)
  assert.equal(cellAtGridIndex(row, 1), ab, '被 colspan 涵蓋的欄就是那一格')
  assert.equal(cellAtGridIndex(row, 2), c1)
  assert.equal(cellAtGridIndex(row, 3), null)
  assert.equal(cellAtGridIndex(row, -1), null)
})

test('A 監控頁欄名列（服務主機 colspan=2）：PORT:443 的網格索引是 2', () => {
  const row = getDataRows(monitorTable())[1]
  const port = rowCellsOf(row)[1]
  assert.equal(port.textContent.trim(), 'PORT:443')
  assert.equal(gridIndexOf(row, port), 2)
  assert.equal(cellAtGridIndex(row, 2), port)
})

test('A ARIA 列不展開 aria-colspan（擷取端本來就不展開，兩端要一致）', () => {
  const table = el('<div role="table"><div role="row">' +
    '<div role="cell" aria-colspan="2">x</div><div role="cell">y</div></div></div>')
  const row = table.firstElementChild
  const [, y] = rowCellsOf(row)
  assert.equal(gridIndexOf(row, y), 1)
  assert.equal(cellAtGridIndex(row, 1), y)
  assert.equal(cellAtGridIndex(row, 2), null)
})

// ---------- 擷取端接 inner ----------

test('A 單格帶 inner：抓到小表第 2 格，不是整格串接', () => {
  const res = extractValue(monitorTable(), cellSpec({ inner: SMALL_TABLE_2ND }))
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.raw, 'MAX:462')
  assert.equal(res.value, 462)
  assert.equal(res.status, 'ok')
})

test('A 多值規格（fields）的儲存格與聚合都接 inner', () => {
  const res = extractValue(monitorTable(), {
    mode: 'block',
    fields: [
      { key: 'a', cell: { row: { index: HOST_ROW, header: '10.231.1.31' }, col: { index: VALUE_COL, header: '' }, inner: SMALL_TABLE_2ND } },
      { key: 'b', block: { axis: 'col', index: VALUE_COL, headerText: '', aggregate: 'min', inner: SMALL_TABLE_2ND } }
    ]
  })
  assert.equal(res.fields.a.value, 462, JSON.stringify(res.fields.a))
  assert.equal(res.fields.b.value, 460, JSON.stringify(res.fields.b))
  assert.equal(res.fields.b.used, 6)
  assert.equal(res.fields.b.skipped, 3)
})

test('A 整欄聚合帶 inner：解析不到的列算 skipped；被 colspan 從左邊涵蓋的格子不算這一欄', () => {
  const res = extractValue(monitorTable(), {
    mode: 'block',
    block: { axis: 'col', index: VALUE_COL, headerText: '', aggregate: 'min', inner: SMALL_TABLE_2ND }
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  // 5 台主機（462/460/460/462/460）＋合計列的 40583；
  // 標題列與 PublicIP 列都是 colspan=4、起點在第 1 欄，不是這一欄的格子；PORT:443 那格沒有小表
  assert.equal(res.value, 460, `最後一列的 203.69.51.90 會被解析成 203.69 混進來，實得 ${res.value}`)
  assert.equal(res.used, 6)
  assert.equal(res.skipped, 3)
  assert.ok(!String(res.raw).includes('203.69'), `raw 不得含 PublicIP 小表的值：${res.raw}`)
  assert.ok(String(res.raw).includes('MAX:460'))
})

test('A 整欄＋位置定位帶 inner：取那一格的子路徑', () => {
  const res = extractValue(monitorTable(), {
    mode: 'block',
    block: { axis: 'col', index: VALUE_COL, headerText: '', pos: 'last-1', aggregate: 'max', inner: SMALL_TABLE_2ND }
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.value, 40583, '倒數第二列是合計列，小表第 2 格是 40583（沒有 inner 時是串接的 361040583）')
  assert.equal(res.used, 1)
})

test('A 單格 inner 解析不到：not_found，訊息帶那一格現在的文字', () => {
  const res = extractValue(monitorTable(), {
    mode: 'block',
    block: { cell: { row: { index: 1, header: '' }, col: { index: VALUE_COL, header: '' }, inner: SMALL_TABLE_2ND } }
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not_found')
  assert.ok(String(res.message).includes('找不到'), `訊息要說找不到：${res.message}`)
  assert.ok(String(res.message).includes('PORT:443'), `訊息要帶那一格現在的文字：${res.message}`)
})

test('A 單格 inner 解析不到、而那一格是空的：訊息仍以「找不到原本的位置」開頭', () => {
  // 合計列的第 1 格是空的 <td></td>
  const res = extractValue(monitorTable(), {
    mode: 'block',
    block: { cell: { row: { index: 7, header: '' }, col: { index: 0, header: '' }, inner: SMALL_TABLE_2ND } }
  })
  assert.equal(res.error, 'not_found')
  assert.equal(res.message, '這一格裡找不到原本的位置；目前這一格是空的')
})

test('A resolveInnerAt 是選取端與擷取端共用的唯一判定：起點不在這一欄的格子不算', async () => {
  const { resolveInnerAt, hasInner } = await import('../src/shared/table.js')
  const rows = getDataRows(monitorTable())
  const host = resolveInnerAt(rows[HOST_ROW], VALUE_COL, SMALL_TABLE_2ND)
  assert.equal(host.target?.textContent.trim(), 'MAX:462')
  const publicIp = resolveInnerAt(rows[8], VALUE_COL, SMALL_TABLE_2ND)
  assert.deepEqual(publicIp, { cell: null, target: null }, 'colspan=4 的 PublicIP 列起點在第 1 欄')
  const port = resolveInnerAt(rows[1], VALUE_COL, SMALL_TABLE_2ND)
  assert.equal(port.cell?.textContent.trim(), 'PORT:443')
  assert.equal(port.target, null)
  assert.equal(resolveInnerAt(null, 0, SMALL_TABLE_2ND).target, null)
  assert.deepEqual([undefined, null, [], [{ tag: 'td' }], 'x'].map(hasInner), [false, false, false, true, true])
  const extractSrc = readFileSync(new URL('../src/shared/extract.js', import.meta.url), 'utf8')
  assert.equal((extractSrc.match(/cellAtGridIndex|gridIndexOf/g) || []).length, 0,
    'extract.js 不得自己組「列＋欄＋起點」判定，一律走 resolveInnerAt')
})

test('A 整欄 inner 一格都解析不到：not_found，訊息說幾格都找不到', () => {
  const table = el('<table><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></table>')
  const res = extractValue(table, {
    mode: 'block',
    block: { axis: 'col', index: 0, headerText: '', aggregate: 'sum', inner: SMALL_TABLE_2ND }
  })
  assert.equal(res.ok, false, `不得退回整格文字加總成 6：${JSON.stringify(res)}`)
  assert.equal(res.error, 'not_found')
  assert.ok(String(res.message).includes('3 格'), `訊息要說 3 格都找不到：${res.message}`)
})

test('A inner 形狀不合法：not_found，不得靜默退回整格文字', () => {
  for (const inner of [[{ tag: 'td' }], 'td', { tag: 'td', index: 1 }]) {
    const res = extractValue(monitorTable(), cellSpec({ inner }))
    assert.equal(res.ok, false, `inner=${JSON.stringify(inner)} 不得抓到值：${JSON.stringify(res)}`)
    assert.equal(res.error, 'not_found')
  }
})

test('A CSS 假表格也能帶 inner（列元素與選取端同源，不是空的 getDataRows）', () => {
  const grid = el('<div>' +
    '<div><span>a</span><span><b>1</b><i>10</i></span></div>' +
    '<div><span>b</span><span><b>2</b><i>20</i></span></div>' +
    '<div><span>c</span><span><b>3</b><i>30</i></span></div></div>')
  const inner = [{ tag: 'i', index: 1 }]
  const one = extractValue(grid, { mode: 'block', block: { cell: { row: { index: 1, header: '' }, col: { index: 1, header: '' }, inner } } })
  assert.equal(one.ok, true, JSON.stringify(one))
  assert.equal(one.value, 20)
  const sum = extractValue(grid, { mode: 'block', block: { axis: 'col', index: 1, headerText: '', aggregate: 'sum', inner } })
  assert.equal(sum.value, 60, JSON.stringify(sum))
})

// ---------- 守門：沒有 inner 的規格一個位元都不變 ----------
// 基準值是改動前（dev@c5303b3）對同一份規格實跑的輸出

test('A 守門：沒有 inner（缺省、null、空陣列）的擷取結果與改動前逐欄位相等', () => {
  const cellBase = { ok: true, value: 42, raw: '42MAX:462', status: 'ok', strategyUsed: 'cell' }
  assert.deepEqual(extractValue(monitorTable(), cellSpec()), cellBase)
  assert.deepEqual(extractValue(monitorTable(), cellSpec({ inner: null })), cellBase)
  assert.deepEqual(extractValue(monitorTable(), cellSpec({ inner: [] })), cellBase)

  const colMin = extractValue(monitorTable(), { mode: 'block', block: { axis: 'col', index: VALUE_COL, headerText: '', aggregate: 'min' } })
  assert.deepEqual(colMin, {
    ok: true, value: 0,
    raw: '[ IS(Android)客戶區 ]MR_IS_ANDR_CUST(0), PORT:443, 42MAX:462, 43MAX:460, 41MAX:460, 41MAX:462, 40MAX:460, 361040583, PublicIP:203.69.51.90SLB:10.231.80.75FQDN:NexusAnd.yuanta.com.tw',
    status: 'ok', strategyUsed: 'block', used: 9, skipped: 0, partial: false
  })

  const cross = extractValue(monitorTable(), { mode: 'block', block: { axis: 'col', index: VALUE_COL, headerText: '', pos: 'last-1', aggregate: 'max' } })
  assert.deepEqual(cross, {
    ok: true, value: 361040583, raw: '361040583', status: 'ok', strategyUsed: 'block',
    label: '361040583', used: 1, skipped: 0, partial: false
  })

  const grid = el('<div><div><span>a</span><span><b>1</b><i>10</i></span></div>' +
    '<div><span>b</span><span><b>2</b><i>20</i></span></div><div><span>c</span><span><b>3</b><i>30</i></span></div></div>')
  const plain = extractValue(grid, { mode: 'block', block: { cell: { row: { index: 1, header: '' }, col: { index: 1, header: '' } } } })
  assert.equal(plain.raw, '220', '假表格沒有 inner 時維持整格文字')
})

// ---------- 慣例：唯一一份 ----------

test('A 慣例：同層同標籤計數只有一份（table.js 與 selector.js 其中一處定義 getTagIndex）', () => {
  const tableSrc = readFileSync(new URL('../src/shared/table.js', import.meta.url), 'utf8')
  const selectorSrc = readFileSync(new URL('../src/shared/selector.js', import.meta.url), 'utf8')
  const defs = [tableSrc, selectorSrc].map((s) => (s.match(/function\s+getTagIndex\s*\(/g) || []).length)
  assert.equal(defs[0] + defs[1], 1, `getTagIndex 應剛好定義一次，實得 table.js ${defs[0]}、selector.js ${defs[1]}`)
  assert.ok(!tableSrc.includes('previousElementSibling') || defs[0] === 1,
    'table.js 沒有定義 getTagIndex 時不得自己數兄弟節點')
})
