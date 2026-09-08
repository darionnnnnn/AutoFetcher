// AF-8 批次 C：位置定位（第一筆／最後一筆／倒數第二筆）與整列聚合改走表頭定位
// 對照 docs/AF-8-PLAN.md 批次 C 的驗收。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { extractValue } from '../src/shared/extract.js'

// 每天在最後新增一列的表（證交所市場成交資訊那種）
function marketTable(rows) {
  const body = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')
  const dom = new JSDOM(`<!doctype html><body><table id="t">
    <thead><tr><th>日期</th><th>成交股數</th><th>成交金額</th></tr></thead>
    <tbody>${body}</tbody></table></body>`)
  return dom.window.document.getElementById('t')
}

const DAYS = [
  ['115/09/01', '13000', '1187571'],
  ['115/09/02', '10824', '976499'],
  ['115/09/03', '11201', '993261'],
  ['115/09/04', '9267', '858244'],
  ['115/09/07', '11024', '997944']
]

const cellSpec = (row, col) => ({ mode: 'block', block: { cell: { row, col } } })

// ---------- C-1 列的位置定位 ----------

test('C-1 最後一列：不看列標題，每次都取當下的最後一筆', () => {
  const spec = cellSpec({ pos: 'last' }, { index: 2, header: '成交金額' })
  let res = extractValue(marketTable(DAYS), spec)
  assert.equal(res.ok, true, `實得 ${JSON.stringify(res)}`)
  assert.equal(res.value, 997944)

  // 隔天多了一列
  const tomorrow = [...DAYS, ['115/09/08', '12000', '1050000']]
  res = extractValue(marketTable(tomorrow), spec)
  assert.equal(res.value, 1050000, '新增一列之後要取到新的那一筆')
})

test('C-1 第一列與倒數第二列', () => {
  const first = extractValue(marketTable(DAYS), cellSpec({ pos: 'first' }, { index: 2, header: '成交金額' }))
  assert.equal(first.value, 1187571)
  const secondLast = extractValue(marketTable(DAYS), cellSpec({ pos: 'last-1' }, { index: 2, header: '成交金額' }))
  assert.equal(secondLast.value, 858244, '最後一列常是合計，所以要能取倒數第二筆')
})

test('C-1 位置定位的狀態一律 ok（沒有備援的概念）', () => {
  const res = extractValue(marketTable(DAYS), cellSpec({ pos: 'last' }, { index: 2, header: '成交金額' }))
  assert.equal(res.status, 'ok')
})

test('C-1 資料列不夠時回 not_found，不會靜靜取到別列', () => {
  const one = extractValue(marketTable([DAYS[0]]), cellSpec({ pos: 'last-1' }, { index: 2, header: '成交金額' }))
  assert.equal(one.ok, false)
  assert.equal(one.error, 'not_found')
})

test('C-1 位置上那一格是空的就回 parse_error，不往前找', () => {
  const withBlank = [...DAYS, ['115/09/08', '12000', '']]
  const res = extractValue(marketTable(withBlank), cellSpec({ pos: 'last' }, { index: 2, header: '成交金額' }))
  assert.equal(res.ok, false)
  assert.equal(res.error, 'parse_error')
})

// ---------- C-2 欄的位置定位 ----------

test('C-2 最後一欄：右邊多一欄之後仍取最後一欄', () => {
  const spec = cellSpec({ index: 0, header: '115/09/01' }, { pos: 'last' })
  let res = extractValue(marketTable(DAYS), spec)
  assert.equal(res.value, 1187571)

  const dom = new JSDOM(`<!doctype html><body><table id="t">
    <thead><tr><th>日期</th><th>成交股數</th><th>成交金額</th><th>漲跌</th></tr></thead>
    <tbody><tr><td>115/09/01</td><td>13000</td><td>1187571</td><td>55</td></tr></tbody></table></body>`)
  res = extractValue(dom.window.document.getElementById('t'), spec)
  assert.equal(res.value, 55, '新增一欄之後要取到新的最後一欄')
})

// ---------- C-3 整欄／整列 + 位置＝那一格，不聚合 ----------

test('C-3 整欄加上位置＝該欄那一格，聚合方式被忽略', () => {
  const res = extractValue(marketTable(DAYS), {
    mode: 'block',
    block: { axis: 'col', index: 2, headerText: '成交金額', pos: 'last', aggregate: 'sum' }
  })
  assert.equal(res.ok, true, `實得 ${JSON.stringify(res)}`)
  assert.equal(res.value, 997944, '有位置就不是加總，是那一格')
  assert.equal(res.used, 1)
})

test('C-3 整列加上位置＝該列那一格', () => {
  const res = extractValue(marketTable(DAYS), {
    mode: 'block',
    block: { axis: 'row', index: 0, headerText: '115/09/01', pos: 'last', aggregate: 'sum' }
  })
  assert.equal(res.ok, true, `實得 ${JSON.stringify(res)}`)
  assert.equal(res.value, 1187571, '第一列 × 最後一欄')
})

// ---------- C-4 B1：整列聚合改走表頭定位 ----------

function currencyTable(order) {
  const rows = order.map(([name, a, b]) => `<tr><td>${name}</td><td>${a}</td><td>${b}</td></tr>`).join('')
  const dom = new JSDOM(`<!doctype html><body><table id="t">
    <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
    <tbody>${rows}</tbody></table></body>`)
  return dom.window.document.getElementById('t')
}
const ROWS = [['美金', '30', '31'], ['日圓', '0.2', '0.3'], ['歐元', '33', '34']]

test('C-4 整列聚合：列標題對得上原索引就是 ok', () => {
  const res = extractValue(currencyTable(ROWS), {
    mode: 'block', block: { axis: 'row', index: 1, headerText: '日圓', aggregate: 'sum' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.status, 'ok')
  assert.ok(Math.abs(res.value - 0.5) < 1e-9, `實得 ${res.value}`)
})

test('C-4 整列聚合：列搬家了要跟著列標題走並標記備援', () => {
  const moved = [['日圓', '0.2', '0.3'], ['美金', '30', '31'], ['歐元', '33', '34']]
  const res = extractValue(currencyTable(moved), {
    mode: 'block', block: { axis: 'row', index: 1, headerText: '日圓', aggregate: 'sum' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.status, 'fallback', '跟著表頭走要標記備援')
  assert.ok(Math.abs(res.value - 0.5) < 1e-9, `抓的要是日圓那一列，實得 ${res.value}`)
})

test('C-4 整列聚合：列標題整個不見就 not_found，錯誤訊息要指路', () => {
  const gone = [['美金', '30', '31'], ['歐元', '33', '34']]
  const res = extractValue(currencyTable(gone), {
    mode: 'block', block: { axis: 'row', index: 1, headerText: '日圓', aggregate: 'sum' }
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not_found')
  assert.ok(/日圓/.test(res.message || ''), `訊息要說出是哪個標題，實得 ${JSON.stringify(res.message)}`)
  assert.ok(/位置/.test(res.message || ''), `訊息要告訴使用者可以改用位置定位，實得 ${JSON.stringify(res.message)}`)
})

test('C-4 整列聚合沒有 headerText 時維持原本的照索引取值', () => {
  const res = extractValue(currencyTable(ROWS), {
    mode: 'block', block: { axis: 'row', index: 1, aggregate: 'sum' }
  })
  assert.equal(res.ok, true)
  assert.ok(Math.abs(res.value - 0.5) < 1e-9)
})

// ---------- C-5 label：位置定位抓到的值要能追溯是哪一列 ----------

test('C-5 位置定位帶 label，說出抓的是哪一列', () => {
  const res = extractValue(marketTable(DAYS), cellSpec({ pos: 'last' }, { index: 2, header: '成交金額' }))
  assert.equal(res.label, '115/09/07', `實得 ${JSON.stringify(res.label)}`)
})

test('C-5 欄也用位置時 label 是「列 · 欄」', () => {
  const res = extractValue(marketTable(DAYS), cellSpec({ pos: 'last' }, { pos: 'last' }))
  assert.equal(res.label, '115/09/07 · 成交金額', `實得 ${JSON.stringify(res.label)}`)
})

test('C-5 依表頭定位的沒有 label（規格裡已經有了）', () => {
  const res = extractValue(marketTable(DAYS), cellSpec(
    { index: 0, header: '115/09/01' }, { index: 2, header: '成交金額' }))
  assert.equal(res.label, undefined)
})

// ---------- C-6 多值任務 ----------

test('C-6 多值任務每個值各自帶位置與 label', () => {
  const res = extractValue(marketTable(DAYS), {
    mode: 'block',
    fields: [
      { key: 'amt', cell: { row: { pos: 'last' }, col: { index: 2, header: '成交金額' } } },
      { key: 'vol', cell: { row: { pos: 'last' }, col: { index: 1, header: '成交股數' } } }
    ]
  })
  assert.equal(res.ok, true)
  assert.equal(res.fields.amt.value, 997944)
  assert.equal(res.fields.vol.value, 11024)
  assert.equal(res.fields.amt.label, '115/09/07')
})

// ---------- C-7 錯誤訊息要一路走到使用者眼前 ----------

test('C-7 多值任務的失敗值也帶著可行動的訊息', () => {
  const gone = [['美金', '30', '31'], ['歐元', '33', '34']]
  const res = extractValue(currencyTable(gone), {
    mode: 'block',
    fields: [{ key: 'jpy', block: { axis: 'row', index: 1, headerText: '日圓', aggregate: 'sum' } }]
  })
  assert.equal(res.ok, true, '表格解析得出來就不是暫時性失敗')
  assert.equal(res.fields.jpy.ok, false)
  assert.ok(/日圓/.test(res.fields.jpy.message || ''),
    `每個值各自的失敗也要說出是哪個標題，實得 ${JSON.stringify(res.fields.jpy.message)}`)
})
