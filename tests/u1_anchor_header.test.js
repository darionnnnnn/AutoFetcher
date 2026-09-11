// AF-14 批次 A-1：純數值標題不當定位錨點（判準一份 + 擷取端 + 失敗訊息帶現況）
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { isAnchorText, rowHeader } from '../src/shared/table.js'
import { extractValue } from '../src/shared/extract.js'

function el(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  return dom.window.document.body.firstElementChild
}

// ---- 判準本身 ----

// 純數值＝去掉千分位逗號與空白後整段就是一個數字，沒有任何別的字。
const NOT_ANCHOR = ['4318', '4269', '1,234', '-5', '3.5', '0', ' 38605 ', '1 234']
// 這些都含數字以外的字，是站台上真的會拿來當列名的東西，必須留著當錨點。
const IS_ANCHOR = ['2024年度', 'No.4318', 'A-100', '09/02', '2026-09-02', '合計', '美金', 'Q1', '第 3 季']

test('純數值的文字不能當定位錨點', () => {
  assert.ok(NOT_ANCHOR.length > 0, '樣本集合不得為空，否則這個迴圈恆過')
  for (const text of NOT_ANCHOR) {
    assert.equal(isAnchorText(text), false, `${JSON.stringify(text)} 是純數值，不該當錨點`)
  }
})

test('含數字以外字元的標題仍然是錨點（parseNumber 解得出數字不代表它是純數值）', () => {
  assert.ok(IS_ANCHOR.length > 0, '樣本集合不得為空，否則這個迴圈恆過')
  for (const text of IS_ANCHOR) {
    assert.equal(isAnchorText(text), true, `${JSON.stringify(text)} 是合法的標題，不該被當成純數值丟掉`)
  }
})

test('空字串與非字串不是錨點', () => {
  for (const text of ['', '   ', null, undefined, 123]) {
    assert.equal(isAnchorText(text), false)
  }
})

test('rowHeader 本身不受判準影響（label 顯示仍要看得到 4318）', () => {
  const numeric = el('<table><tr><td>4318</td><td>38605</td></tr></table>').querySelector('tr')
  assert.equal(rowHeader(numeric), '4318')
})

// ---- 擷取端：舊任務零遷移 ----

// 使用者實站那張表：單列、無表頭、第一格本身就是每天會變的數值
const SINGLE_ROW = (first) => `<table class="type2"><tbody>
  <tr align="center"><td width="70">${first}</td><td>38605</td></tr>
</tbody></table>`

const cellSpec = (over = {}) => ({
  mode: 'block',
  block: { cell: { row: { index: 0, header: '4318' }, col: { index: 1, header: '' } } },
  ...over
})

// ---- 純數值標題：當下唯一出現才拿來定位，否則走 index ----

test('純數值標題還在表上、位置沒變 → ok', () => {
  const r = extractValue(el(SINGLE_ROW('4318')), cellSpec())
  assert.equal(r.ok, true, r.message || r.error)
  assert.equal(r.value, 38605)
  assert.equal(r.status, 'ok')
})

test('年度欄前面插了一欄：純數值標題唯一出現就跟著它走並標 fallback（不得靜默抓到隔壁年度）', () => {
  const html = `<table>
    <thead><tr><th>項目</th><th>2026</th><th>2025</th><th>2024</th></tr></thead>
    <tbody><tr><td>營收</td><td>30</td><td>20</td><td>10</td></tr></tbody></table>`
  // 選取當時 2025 在第 1 欄；今天前面插了 2026
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '營收' }, col: { index: 1, header: '2025' } } } }
  const r = extractValue(el(html), spec)
  assert.equal(r.value, 20, '要跟著 2025 走，不是照索引抓到 2026 的值')
  assert.equal(r.status, 'fallback', '位移要亮黃燈讓使用者看得到')
})

test('純數值標題在表上重複出現（第一欄是小整數）→ 視同沒有標題，走 index、狀態 ok', () => {
  const html = `<table><tbody>
    <tr><td>0</td><td>10</td></tr><tr><td>0</td><td>20</td></tr><tr><td>5</td><td>30</td></tr>
  </tbody></table>`
  // 存的是第 2 列（index 2），當時第一格是 0；今天那一列變成 5、前兩列都是 0——
  // 拿 0 去比對會跳到最近的第 1 列（值 20），照索引才是同一列（值 30）
  const spec = { mode: 'block', block: { cell: { row: { index: 2, header: '0' }, col: { index: 1, header: '' } } } }
  const r = extractValue(el(html), spec)
  assert.equal(r.value, 30, '重複的數字不是鍵，不得跳到別列')
  assert.equal(r.status, 'ok')
})

test('存了純數值列標題的舊任務，第一格變了照樣抓得到（走 index、狀態 ok）', () => {
  const r = extractValue(el(SINGLE_ROW('4269')), cellSpec())
  assert.equal(r.ok, true, r.message || r.error)
  assert.equal(r.value, 38605)
  // fallback 屬警示狀態會每天亮黃燈，這裡不是備援，是那個標題本來就不該當錨點
  assert.equal(r.status, 'ok')
})

test('選取當下就存空標題的新任務一樣抓得到', () => {
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '' }, col: { index: 1, header: '' } } } }
  assert.equal(extractValue(el(SINGLE_ROW('4269')), spec).value, 38605)
})

test('純數值的欄標題同樣不當錨點', () => {
  const html = `<table>
    <thead><tr><th>4318</th><th>38605</th></tr></thead>
    <tbody><tr><td>10</td><td>20</td></tr></tbody></table>`
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '' }, col: { index: 1, header: '38605' } } } }
  const r = extractValue(el(html), spec)
  assert.equal(r.ok, true, r.message || r.error)
  assert.equal(r.value, 20)
  assert.equal(r.status, 'ok')
})

test('整欄聚合的純數值 headerText 也走索引（欄分支不得是唯一沒套判準的路徑）', () => {
  const html = `<table>
    <thead><tr><th>4318</th><th>4319</th></tr></thead>
    <tbody><tr><td>1</td><td>10</td></tr><tr><td>2</td><td>20</td></tr></tbody></table>`
  const spec = { mode: 'block', block: { axis: 'col', index: 1, headerText: '9999', aggregate: 'sum' } }
  const r = extractValue(el(html), spec)
  assert.equal(r.ok, true, r.message || r.error)
  assert.equal(r.value, 30)
  assert.equal(r.status, 'ok')
})

test('整列聚合的純數值 headerText 也走索引', () => {
  const spec = { mode: 'block', block: { axis: 'row', index: 0, headerText: '4318', aggregate: 'sum' } }
  const r = extractValue(el(SINGLE_ROW('4269')), spec)
  assert.equal(r.ok, true, r.message || r.error)
  assert.equal(r.value, 4269 + 38605)
})

// ---- 文字型標題維持既有的硬性失敗（本輪只改純數值那一類）----

const RATE_TABLE = (rows) => `<table>
  <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
  <tbody>${rows}</tbody></table>`

test('文字型列標題搬家 → 跟著標題走並標 fallback', () => {
  const html = RATE_TABLE('<tr><td>歐元</td><td>34.1</td><td>34.9</td></tr><tr><td>美金</td><td>31.2</td><td>31.8</td></tr>')
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } } }
  const r = extractValue(el(html), spec)
  assert.equal(r.value, 31.2)
  assert.equal(r.status, 'fallback')
})

test('文字型列標題整個不見 → 仍然硬性失敗，不得因為本輪改動變成靜默走索引', () => {
  const html = RATE_TABLE('<tr><td>歐元</td><td>34.1</td><td>34.9</td></tr>')
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } } }
  const r = extractValue(el(html), spec)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
})

// ---- 失敗訊息要說出現況 ----

test('列標題找不到時，訊息要列出目前這張表的列標題與原本的指路', () => {
  const html = RATE_TABLE('<tr><td>歐元</td><td>34.1</td><td>34.9</td></tr><tr><td>日圓</td><td>0.21</td><td>0.23</td></tr>')
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } } }
  const msg = extractValue(el(html), spec).message
  assert.ok(msg.startsWith('標題「美金」找不到'), `訊息要以原句開頭，實際：${msg}`)
  assert.ok(msg.includes('目前這張表的列標題是：'), `要說出現況，實際：${msg}`)
  assert.ok(msg.includes('歐元') && msg.includes('日圓'), `現況要是真的標題，實際：${msg}`)
  assert.ok(msg.includes('位置定位'), '原本的指路不能因為加了現況就被拿掉')
})

test('欄標題找不到時列出目前的欄標題', () => {
  const html = RATE_TABLE('<tr><td>美金</td><td>31.2</td><td>31.8</td></tr>')
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '現金買入' } } } }
  const msg = extractValue(el(html), spec).message
  assert.ok(msg.startsWith('標題「現金買入」找不到'), msg)
  assert.ok(msg.includes('目前這張表的欄標題是：'), msg)
  assert.ok(msg.includes('幣別') && msg.includes('買入') && msg.includes('賣出'), msg)
})

test('現況標題超過 5 個時只列 5 個並說出總數', () => {
  const rows = ['甲', '乙', '丙', '丁', '戊', '己', '庚']
    .map((n) => `<tr><td>${n}</td><td>1</td><td>2</td></tr>`).join('')
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } } }
  const msg = extractValue(el(RATE_TABLE(rows)), spec).message
  assert.ok(msg.includes('甲') && msg.includes('戊'), `前五個要列出來，實際：${msg}`)
  assert.ok(!msg.includes('己') && !msg.includes('庚'), `第六個以後不列，實際：${msg}`)
  assert.ok(msg.includes('共 7'), `要說出總數，實際：${msg}`)
})

test('整欄聚合的欄標題找不到時，訊息與儲存格模式是同一句（收斂成一份的證據）', () => {
  const html = RATE_TABLE('<tr><td>美金</td><td>31.2</td><td>31.8</td></tr>')
  const spec = { mode: 'block', block: { axis: 'col', index: 1, headerText: '現金買入', aggregate: 'sum' } }
  const msg = extractValue(el(html), spec).message
  assert.ok(msg.startsWith('標題「現金買入」找不到'), msg)
  assert.ok(msg.includes('目前這張表的欄標題是：'), msg)
})

// ---- 多值任務：每個值各自帶訊息（既有規格，本輪不得弄丟）----

test('多值任務裡純數值標題的那個值走索引、文字型找不到的那個值仍帶指路訊息', () => {
  const html = RATE_TABLE('<tr><td>歐元</td><td>34.1</td><td>34.9</td></tr>')
  const spec = {
    mode: 'block',
    fields: [
      { key: 'a', cell: { row: { index: 0, header: '34.1' }, col: { index: 2, header: '賣出' } } },
      { key: 'b', cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } }
    ]
  }
  const r = extractValue(el(html), spec)
  assert.equal(r.ok, true)
  assert.equal(r.fields.a.ok, true, '純數值標題那個值要走索引')
  assert.equal(r.fields.a.value, 34.9)
  assert.equal(r.fields.b.ok, false)
  assert.ok(r.fields.b.message.includes('目前這張表的列標題是：'), r.fields.b.message)
})
