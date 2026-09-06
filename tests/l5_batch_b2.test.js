// AF-5 批次 B2：表頭解析單一來源 + 擷取端多值
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

// 仿銀行牌告：兩層表頭（現金匯率／即期匯率 各有買入賣出），第一格是國旗圖沒有文字
const BANK_TABLE = `
<table id="rate">
  <thead>
    <tr><th rowspan="2">幣別</th><th colspan="2">現金匯率</th><th colspan="2">即期匯率</th></tr>
    <tr><th>買入</th><th>賣出</th><th>買入</th><th>賣出</th></tr>
  </thead>
  <tbody>
    <tr><td><img alt=""> 美金 (USD)</td><td>30.9</td><td>31.5</td><td>31.2</td><td>31.3</td></tr>
    <tr><td><img alt=""> 日圓 (JPY)</td><td>0.208</td><td>0.216</td><td>0.211</td><td>0.213</td></tr>
  </tbody>
</table>`

const SIMPLE_TABLE = `
<table id="t">
  <thead><tr><th>日期</th><th>數量</th></tr></thead>
  <tbody><tr><td>09-01</td><td>10</td></tr><tr><td>09-02</td><td>32</td></tr></tbody>
</table>`

function domOf(html) {
  const jd = new JSDOM(`<!doctype html><body>${html}</body>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return jd.window.document
}

const TB = await import('../src/shared/table.js')
const EX = await import('../src/shared/extract.js')

// ---- X4：多層表頭要對得上欄位 ----

test('兩層表頭時，欄位表頭與資料欄一一對齊', () => {
  const doc = domOf(BANK_TABLE)
  const headers = TB.columnHeaders(doc.getElementById('rate'))
  assert.equal(headers.length, 5, '五個資料欄就要有五個表頭')
  assert.equal(headers[0], '幣別')
  assert.equal(headers[1], '現金匯率 · 買入')
  assert.equal(headers[2], '現金匯率 · 賣出')
  assert.equal(headers[3], '即期匯率 · 買入')
  assert.equal(headers[4], '即期匯率 · 賣出',
    '四個欄的下層都叫買入賣出，只有帶上群組才分得出是哪一組')
})

test('單層表頭不受影響', () => {
  const doc = domOf(SIMPLE_TABLE)
  assert.deepEqual(TB.columnHeaders(doc.getElementById('t')), ['日期', '數量'])
})

test('沒有表頭時回空陣列', () => {
  const doc = domOf('<table id="t"><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
  assert.deepEqual(TB.columnHeaders(doc.getElementById('t')), [])
})

test('parseTable 的 headers 就是對齊後的欄位表頭', () => {
  const doc = domOf(BANK_TABLE)
  const r = TB.parseTable(doc.getElementById('rate'))
  assert.deepEqual(r.headers, ['幣別', '現金匯率 · 買入', '現金匯率 · 賣出', '即期匯率 · 買入', '即期匯率 · 賣出'])
  assert.equal(r.cells.length, 2, '表頭列不得混進資料列')
})

test('列標題取第一個有文字的格子（第一格是圖片時要跳過）', () => {
  const doc = domOf(BANK_TABLE)
  const rows = doc.querySelectorAll('#rate tbody tr')
  assert.equal(TB.rowHeader(rows[0]), '美金 (USD)')
  assert.equal(TB.rowHeader(rows[1]), '日圓 (JPY)')
})

test('整列都沒有文字時列標題是空字串', () => {
  const doc = domOf('<table id="t"><tbody><tr id="r"><td> </td><td> </td></tr></tbody></table>')
  assert.equal(TB.rowHeader(doc.getElementById('r')), '')
})

// ---- 欄位漂移偵測用完整表頭 ----

test('欄位沒搬家時就是 ok，不得誤判成備援', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block', block: { axis: 'col', index: 3, headerText: '即期匯率 · 買入', aggregate: 'max' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.status, 'ok', '同名的「買入」有四個，靠完整表頭才認得出沒搬家')
  assert.equal(res.value, 31.2)
})

test('欄位真的搬家時跟著表頭走並標記備援', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block', block: { axis: 'col', index: 1, headerText: '即期匯率 · 買入', aggregate: 'max' }
  })
  assert.equal(res.status, 'fallback')
  assert.equal(res.value, 31.2, '要抓到搬家後的那一欄，不是原本索引的那一欄')
})

test('表頭整個不見時回找不到，不得默默抓隔壁', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block', block: { axis: 'col', index: 3, headerText: '不存在的欄', aggregate: 'max' }
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not_found')
})

// ---- 儲存格取值 ----

test('取單一儲存格的值（列 × 欄）', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block',
    block: { cell: { row: { index: 0, header: '美金 (USD)' }, col: { index: 3, header: '即期匯率 · 買入' } } }
  })
  assert.equal(res.ok, true)
  assert.equal(res.value, 31.2)
  assert.equal(res.status, 'ok')
})

test('列搬家時依列標題跟著走並標記備援', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block',
    block: { cell: { row: { index: 1, header: '美金 (USD)' }, col: { index: 3, header: '即期匯率 · 買入' } } }
  })
  assert.equal(res.status, 'fallback')
  assert.equal(res.value, 31.2)
})

test('列標題不見時回找不到', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block',
    block: { cell: { row: { index: 0, header: '歐元' }, col: { index: 3, header: '即期匯率 · 買入' } } }
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not_found')
})

test('儲存格不是數字時回解析錯誤', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block',
    block: { cell: { row: { index: 0, header: '美金 (USD)' }, col: { index: 0, header: '幣別' } } }
  })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'parse_error')
})

// ---- 多值擷取 ----

const FIELDS = [
  { key: 'a', cell: { row: { index: 0, header: '美金 (USD)' }, col: { index: 3, header: '即期匯率 · 買入' } } },
  { key: 'b', cell: { row: { index: 0, header: '美金 (USD)' }, col: { index: 4, header: '即期匯率 · 賣出' } } },
  { key: 'c', block: { axis: 'col', index: 1, headerText: '現金匯率 · 買入', aggregate: 'max' } }
]

test('一次擷取多個值，各自帶回結果', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), { mode: 'block', fields: FIELDS })
  assert.equal(res.ok, true)
  assert.equal(res.fields.a.ok, true)
  assert.equal(res.fields.a.value, 31.2)
  assert.equal(res.fields.b.value, 31.3)
  assert.equal(res.fields.c.value, 30.9, '欄聚合的值也走同一條路')
})

test('個別值失敗不影響其他值，整體仍算成功', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block',
    fields: [FIELDS[0], { key: 'bad', cell: { row: { index: 0, header: '歐元' }, col: { index: 3, header: '即期匯率 · 買入' } } }]
  })
  assert.equal(res.ok, true, '表格找得到就是找得到，個別值的失敗不該觸發重試')
  assert.equal(res.fields.a.value, 31.2)
  assert.equal(res.fields.bad.ok, false)
  assert.equal(res.fields.bad.error, 'not_found')
})

test('全部值都失敗，表格本身仍算找得到', () => {
  const doc = domOf(BANK_TABLE)
  const res = EX.extractValue(doc.getElementById('rate'), {
    mode: 'block',
    fields: [{ key: 'x', cell: { row: { index: 0, header: '歐元' }, col: { index: 0, header: '幣別' } } }]
  })
  assert.equal(res.ok, true)
  assert.equal(res.fields.x.ok, false)
})

test('表格本身找不到時整體失敗（這才該重試）', () => {
  const doc = domOf('<div id="nope">不是表格</div>')
  const res = EX.extractValue(doc.getElementById('nope'), { mode: 'block', fields: FIELDS })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'not_found')
})

test('單一 block 的舊路徑完全不受影響', () => {
  const doc = domOf(SIMPLE_TABLE)
  const res = EX.extractValue(doc.getElementById('t'), {
    mode: 'block', block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum' }
  })
  assert.equal(res.value, 42)
  assert.equal(res.fields, undefined, '單值不得多出 fields 欄位')
})

// ---- 表頭解析只有一份 ----

test('表頭解析不得在別的檔案各寫一份', () => {
  const pm = readFileSync(new URL('../src/content/picker-mode.js', import.meta.url), 'utf8')
  assert.ok(/from '\.\.\/shared\/table\.js'/.test(pm), 'picker-mode 要用 table.js 的表頭解析')
  const bd = readFileSync(new URL('../src/shared/block-detect.js', import.meta.url), 'utf8')
  assert.ok(/from '\.\/table\.js'/.test(bd), 'block-detect 要用 table.js 的表頭解析')
})

// ---- 終檢抓到的表格解析缺陷 ----

const SEPARATOR_TABLE = `
<table id="sep">
  <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
  <tbody>
    <tr><th colspan="3">亞洲貨幣</th></tr>
    <tr><td>日圓</td><td>0.208</td><td>0.216</td></tr>
    <tr><th colspan="3">歐美貨幣</th></tr>
    <tr><td>美金</td><td>31.2</td><td>31.3</td></tr>
  </tbody>
</table>`

test('表格中間的分組標題列不得把表頭洗掉', () => {
  const doc = domOf(SEPARATOR_TABLE)
  const headers = TB.columnHeaders(doc.getElementById('sep'))
  assert.deepEqual(headers, ['幣別', '買入', '賣出'],
    '只有開頭那幾列是表頭，中間的分組列是資料的一部分')
})

const SPAN_TABLE = `
<table id="span">
  <thead><tr><th>項目</th><th>甲</th><th>乙</th><th>丙</th></tr></thead>
  <tbody>
    <tr><td>第一列</td><td colspan="2">合併</td><td>7</td></tr>
    <tr><td>第二列</td><td>3</td><td>4</td><td>9</td></tr>
  </tbody>
</table>`

test('資料列有合併儲存格時，欄位索引仍然對得上表頭', () => {
  const doc = domOf(SPAN_TABLE)
  const r = TB.parseTable(doc.getElementById('span'))
  assert.equal(r.headers[3], '丙')
  // 第一列的「丙」欄應該是 7（合併格佔了甲乙兩欄）
  assert.equal(r.cells[0][3], '7')
  assert.equal(r.cells[1][3], '9')
})

test('選取合併儲存格右邊那一欄時，抓到的是同一欄的值', () => {
  const doc = domOf(SPAN_TABLE)
  const res = EX.extractValue(doc.getElementById('span'), {
    mode: 'block',
    block: { cell: { row: { index: 1, header: '第二列' }, col: { index: 3, header: '丙' } } }
  })
  assert.equal(res.ok, true)
  assert.equal(res.value, 9)
})
