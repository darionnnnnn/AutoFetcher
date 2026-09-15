// AF-17 作業 A 第 1 段：頭尾空白自動略過（skip.blank）與逐格處置明細 items
// 規格見 docs/AF-17-PLAN.md 作業 A 與作業 B「items 的形狀」。
// 「關著時一個位元都不變」的期望值是用 dev@f01f27c 的程式碼實際算出來的，不是憑印象寫的。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { extractValue } from '../src/shared/extract.js'
import { skipOf, putSkip } from '../src/shared/table.js'

const el = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body.firstElementChild
const withoutItems = (r) => { const o = { ...r }; delete o.items; return o }
const uses = (r) => r.items.map(it => it.use)
const count = (r, ...names) => r.items.filter(it => names.includes(it.use)).length
const USES = ['used', 'nonnumeric', 'blank', 'trimmed', 'skipHead', 'skipTail', 'excluded', 'unresolved']

// 四條口徑不變式：明細表上看到的處置與預覽的數字必須是同一件事
function assertInvariants(r, label = '') {
  assert.ok(Array.isArray(r.items) && r.items.length > 0, `${label} 要帶非空的 items`)
  for (const it of r.items) assert.ok(USES.includes(it.use), `${label} 不認得的處置 ${it.use}`)
  assert.equal(count(r, 'used'), r.used, `${label} used`)
  assert.equal(count(r, 'nonnumeric', 'blank', 'unresolved'), r.skipped, `${label} skipped`)
  assert.equal(count(r, 'skipHead', 'skipTail', 'excluded'), r.excluded ?? 0, `${label} excluded`)
  assert.equal(count(r, 'trimmed'), r.blank ?? 0, `${label} blank`)
}

const MONITOR = `<table>
  <thead><tr><th>主機</th><th>點金靈</th><th>TSWEB</th></tr></thead>
  <tbody>
    <tr><td>10.0.0.1</td><td>53</td><td>MAX:423</td></tr>
    <tr><td>10.0.0.2</td><td>49</td><td>MAX:425</td></tr>
    <tr><td>10.0.0.3</td><td>48</td><td>MAX:427</td></tr>
  </tbody>
  <tfoot><tr><td>合計</td><td>150</td><td>1275</td></tr></tfoot>
</table>`

// 頭兩列空白、中段一列空白、最後一列是 NBSP
const BLANKS = `<table><thead><tr><th>主機</th><th>值</th></tr></thead><tbody>
  <tr><td>a</td><td></td></tr>
  <tr><td>b</td><td> </td></tr>
  <tr><td>c</td><td>10</td></tr>
  <tr><td>d</td><td></td></tr>
  <tr><td>e</td><td>20</td></tr>
  <tr><td>f</td><td>&nbsp;</td></tr>
</tbody></table>`

const ROWBLANK = `<table><thead><tr><th>主機</th><th>甲</th><th>乙</th><th>丙</th><th>丁</th></tr></thead><tbody>
  <tr><td>h</td><td></td><td>3</td><td>4</td><td></td></tr>
</tbody></table>`

// 八種處置各至少一列：搭配 skip {head:1, tail:1, blank:true} 與排除 r6
const EIGHT = `<table><thead><tr><th>主機</th><th>值</th></tr></thead><tbody>
  <tr><td>r0</td><td></td></tr>
  <tr><td>r1</td><td>標題</td></tr>
  <tr><td>r2</td><td>10</td></tr>
  <tr><td>r3</td><td>—</td></tr>
  <tr><td>r4</td><td></td></tr>
  <tr><td>r5</td><td>20</td></tr>
  <tr><td>r6</td><td>999</td></tr>
  <tr><td>r7</td><td>99</td></tr>
  <tr><td>r8</td><td></td></tr>
</tbody></table>`

const table2 = (rows) => `<table><thead><tr><th>主機</th><th>值</th></tr></thead><tbody>${
  rows.map(([h, v]) => `<tr><td>${h}</td><td>${v}</td></tr>`).join('')}</tbody></table>`

const col = (html, header, over = {}) => extractValue(el(html),
  { mode: 'block', block: { axis: 'col', index: 1, headerText: header, aggregate: 'sum', ...over } })
const ON = { head: 0, tail: 0, blank: true }

// dev@f01f27c 實際算出的結果（見檔頭說明）
const BASE = {
  blanks: { ok: true, value: 30, raw: ', , 10, , 20, ', status: 'ok', strategyUsed: 'block', used: 2, skipped: 4, partial: false },
  blanksHead1: { ok: true, value: 30, raw: ', 10, , 20, ', status: 'ok', strategyUsed: 'block', used: 2, skipped: 3, partial: false, excluded: 1 },
  monitorTail1Exclude: { ok: true, value: 150, raw: '53, 49, 48', status: 'ok', strategyUsed: 'block', used: 3, skipped: 0, partial: false, excluded: 1 },
  monitorHead2Tail2: { ok: false, error: 'not_found', message: '略過開頭 2 列、結尾 2 列後沒有剩下的格子（這一欄只有 4 列）' },
  shortRow: { ok: false, error: 'not_found' },
  rowBlanks: { ok: true, value: 7, raw: 'h, , 3, 4, ', status: 'ok', strategyUsed: 'block', used: 2, skipped: 3, partial: false },
  blanksCount: { ok: true, value: 2, raw: ', , 10, , 20, ', status: 'ok', strategyUsed: 'block', used: 2, skipped: 4, partial: false },
  allExcluded: { ok: false, error: 'not_found', message: '略過與排除共 2 列後沒有剩下的格子' },
  parseError: { ok: false, error: 'parse_error', raw: '—, x' }
}

// ---- 判準：怎樣算開、怎麼存 ----

test('skipOf：blank 只認字面 true；其餘一律 false，且一律回 head／tail／blank 三欄', () => {
  assert.equal(skipOf({ blank: true }).blank, true)
  assert.equal(skipOf({ skip: { blank: true } }).blank, true, 'block 物件也要讀得到')
  for (const bad of [{ blank: 'true' }, { blank: 1 }, {}, null, undefined, { skip: null }]) {
    const s = skipOf(bad)
    assert.equal(s.blank, false, JSON.stringify(bad))
    assert.equal(s.head, 0)
    assert.equal(s.tail, 0)
  }
})

test('putSkip：只開 blank 也放鍵，形狀一律帶 head 與 tail', () => {
  const b = {}
  putSkip(b, { blank: true })
  assert.deepEqual(b.skip, { head: 0, tail: 0, blank: true })
})

test('putSkip：blank 關著時形狀與 AF-16 一字不差（不帶 blank 鍵）', () => {
  const b = {}
  putSkip(b, { head: 1, blank: false })
  assert.deepEqual(b.skip, { head: 1, tail: 0 })
  const c = {}
  putSkip(c, { tail: 2, blank: 'true' })
  assert.deepEqual(c.skip, { head: 0, tail: 2 }, '字串 true 不算開')
  for (const bad of [{ head: 0, tail: 0, blank: false }, { blank: 1 }, { blank: null }]) {
    const d = {}
    putSkip(d, bad)
    assert.equal('skip' in d, false, JSON.stringify(bad))
  }
})

// ---- 關著時：擷取結果（除了 items）與 dev@f01f27c 逐位元相同 ----

test('關著：沒有 skip、blank:false、blank 非字面 true，結果與改動前相同', () => {
  for (const over of [{}, { skip: { head: 0, tail: 0, blank: false } }, { skip: { blank: 'true' } }, { skip: { blank: 1 } }]) {
    const r = col(BLANKS, '值', over)
    assert.deepEqual(withoutItems(r), BASE.blanks, JSON.stringify(over))
  }
})

test('關著：略過、排除、整列、count、失敗訊息都與改動前相同', () => {
  assert.deepEqual(withoutItems(col(BLANKS, '值', { skip: { head: 1, tail: 0 } })), BASE.blanksHead1)
  assert.deepEqual(withoutItems(col(MONITOR, '點金靈', { skip: { head: 0, tail: 1 }, exclude: [{ index: 3, header: '合計' }] })), BASE.monitorTail1Exclude)
  assert.deepEqual(withoutItems(col(MONITOR, '點金靈', { skip: { head: 2, tail: 2 } })), BASE.monitorHead2Tail2)
  assert.deepEqual(withoutItems(col(BLANKS, '值', { aggregate: 'count' })), BASE.blanksCount)
  const row = extractValue(el(ROWBLANK), { mode: 'block', block: { axis: 'row', index: 0, headerText: 'h', aggregate: 'sum' } })
  assert.deepEqual(withoutItems(row), BASE.rowBlanks)
})

// ---- 開著：只剝頭尾連續的空白 ----

test('開著：頭尾空白不計入，中段空白照舊計成非數字；數值不變', () => {
  const r = col(BLANKS, '值', { skip: ON })
  assert.equal(r.ok, true)
  assert.equal(r.value, 30)
  assert.equal(r.status, 'ok')
  assert.equal(r.used, 2)
  assert.equal(r.skipped, 1, '只剩中段那一格空白')
  assert.equal(r.blank, 3, '開頭兩格、結尾一格（NBSP 也算空白）')
  assert.equal('excluded' in r, false, '沒設略過與排除的人不能看到「略過與排除 N 格」')
  assert.equal('message' in r, false)
  assertInvariants(r, 'BLANKS 開著')
})

test('開著：count 聚合的值與關著時相同（空白本來就不算一筆）', () => {
  const r = col(BLANKS, '值', { skip: ON, aggregate: 'count' })
  assert.equal(r.value, 2)
})

test('開著但表上沒有空白：不放 blank 鍵', () => {
  const r = col(MONITOR, '點金靈', { skip: ON })
  assert.equal(r.value, 300)
  assert.equal('blank' in r, false)
})

test('順序：先剝頭尾空白再略過開頭——略過的是第一個有內容的列', () => {
  // 先剝空白：拿掉空白列後略過「5」→ 1 + 2 = 3；先略過再剝：略過的是空白列 → 5 + 1 + 2 = 8
  const r = col(table2([['a', ''], ['b', '5'], ['c', '1'], ['d', '2']]), '值', { skip: { head: 1, tail: 0, blank: true } })
  assert.equal(r.value, 3)
  assert.equal(r.blank, 1)
  assert.equal(r.excluded, 1)
  assertInvariants(r, '先剝後略過開頭')
})

test('順序：先剝頭尾空白再略過結尾', () => {
  const r = col(table2([['a', '1'], ['b', '2'], ['c', '9'], ['d', '']]), '值', { skip: { head: 0, tail: 1, blank: true } })
  assert.equal(r.value, 3)
  assert.equal(r.blank, 1)
  assert.equal(r.excluded, 1)
})

test('整列：只剝結尾那一格空白，開頭的列標題不是空白', () => {
  const r = extractValue(el(ROWBLANK), { mode: 'block', block: { axis: 'row', index: 0, headerText: 'h', aggregate: 'sum', skip: ON } })
  assert.equal(r.value, 7)
  assert.equal(r.used, 2)
  assert.equal(r.skipped, 2, '「h」是非數字、「甲」是中段空白')
  assert.equal(r.blank, 1)
  assertInvariants(r, '整列')
  assert.deepEqual(r.items.map(it => it.header), ['主機', '甲', '乙', '丙', '丁'], '整列的明細標題是欄標題')
})

test('全部都是空白 → not_found，訊息說出這一欄有幾列都是空白', () => {
  const r = col(table2([['a', ''], ['b', ' '], ['c', '&nbsp;']]), '值', { skip: ON })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
  assert.ok(r.message.includes('這一欄的 3 列都是空白格'), r.message)
  assert.deepEqual(uses(r), ['trimmed', 'trimmed', 'trimmed'])
})

test('剝完空白後不夠略過 → not_found，訊息說出去掉幾列空白後剩幾列', () => {
  const r = col(table2([['a', ''], ['b', '1'], ['c', '']]), '值', { skip: { head: 1, tail: 1, blank: true } })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
  assert.ok(r.message.includes('去掉頭尾 2 列空白後只有 1 列'), r.message)
  assert.deepEqual(uses(r), ['trimmed', 'skipHead', 'trimmed'])
})

test('開著但沒有空白可剝時，略過太多的訊息與改動前一字不差', () => {
  const r = col(MONITOR, '點金靈', { skip: { head: 2, tail: 2, blank: true } })
  assert.equal(r.message, BASE.monitorHead2Tail2.message)
  assert.deepEqual(uses(r), ['skipHead', 'skipHead', 'skipTail', 'skipTail'])
})

test('排除項指到被剝掉的空白列：算找到、只算一次、不亮黃燈', () => {
  const r = col(table2([['a', ''], ['b', '1'], ['c', '2']]), '值', { skip: ON, exclude: [{ index: 0, header: 'a' }] })
  assert.equal(r.ok, true)
  assert.equal(r.value, 3)
  assert.equal(r.status, 'ok')
  assert.equal('message' in r, false)
  assert.equal('excluded' in r, false, '那一列已經算在空白裡，不能再算一次排除')
  assert.equal(r.blank, 1)
  assert.equal(r.items[0].use, 'trimmed')
  assertInvariants(r, '排除指到空白')
})

test('格內子路徑解析不到的頭一格不是空白：照舊計成找不到', () => {
  const html = `<table><thead><tr><th>主機</th><th>狀態</th></tr></thead><tbody>
    <tr><td>a</td><td><span>x</span></td></tr>
    <tr><td>b</td><td><span>b</span><span>5</span></td></tr>
    <tr><td>c</td><td><span>c</span><span>7</span></td></tr></tbody></table>`
  const r = col(html, '狀態', { inner: [{ tag: 'span', index: 2 }], skip: ON })
  assert.equal(r.value, 12)
  assert.equal(r.skipped, 1)
  assert.equal('blank' in r, false)
  assert.equal(r.items[0].use, 'unresolved')
  assert.equal('raw' in r.items[0], false, '解析不到的格子沒有內容')
  assertInvariants(r, 'inner 解析不到')
})

test('格內子路徑解析得到但內容是空白：算頭尾空白', () => {
  const html = `<table><thead><tr><th>主機</th><th>狀態</th></tr></thead><tbody>
    <tr><td>a</td><td><span>a</span><span> </span></td></tr>
    <tr><td>b</td><td><span>b</span><span>5</span></td></tr>
    <tr><td>c</td><td><span>c</span><span>7</span></td></tr></tbody></table>`
  const r = col(html, '狀態', { inner: [{ tag: 'span', index: 2 }], skip: ON })
  assert.equal(r.value, 12)
  assert.equal(r.blank, 1)
  assert.equal(r.items[0].use, 'trimmed')
})

test('0、—、N/A、- 都不是空白：開著也不會被剝掉', () => {
  const r = col(table2([['a', '0'], ['b', '—'], ['c', 'N/A'], ['d', '-'], ['e', '5']]), '值', { skip: ON })
  assert.equal('blank' in r, false)
  assert.equal(r.used, 2, '0 與 5')
  assert.deepEqual(uses(r), ['used', 'nonnumeric', 'nonnumeric', 'nonnumeric', 'used'])
})

// ---- items：逐格處置明細 ----

test('items 形狀：順序、另一軸索引與標題、採用列帶解析出的數字', () => {
  const r = col(BLANKS, '值', { skip: ON })
  assert.deepEqual(r.items.map(it => [it.index, it.header, it.use]), [
    [0, 'a', 'trimmed'], [1, 'b', 'trimmed'], [2, 'c', 'used'], [3, 'd', 'blank'], [4, 'e', 'used'], [5, 'f', 'trimmed']
  ])
  assert.equal(r.items[2].raw, '10')
  assert.equal(r.items[2].number, 10)
  assert.equal(typeof r.items[4].number, 'number', '數字要是數值，不是原始字串')
  for (const it of r.items.filter(x => x.use !== 'used')) {
    assert.equal('number' in it, false, `只有採用的格子帶 number：${JSON.stringify(it)}`)
  }
})

test('items 八種處置：略過、排除、頭尾空白同時存在時每一格各歸其位', () => {
  const r = col(EIGHT, '值', { skip: { head: 1, tail: 1, blank: true }, exclude: [{ index: 6, header: 'r6' }] })
  assert.equal(r.ok, true)
  assert.deepEqual(uses(r), ['trimmed', 'skipHead', 'used', 'nonnumeric', 'blank', 'used', 'excluded', 'skipTail', 'trimmed'])
  assert.equal(r.value, 30)
  assert.equal(r.used, 2)
  assert.equal(r.skipped, 2)
  assert.equal(r.excluded, 3)
  assert.equal(r.blank, 2)
  assert.deepEqual(r.items.map(it => it.header), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'])
  assertInvariants(r, '八態')
})

test('items 在關著時也帶：頭尾空白標成 blank，不是 trimmed', () => {
  const r = col(BLANKS, '值')
  assert.deepEqual(uses(r), ['blank', 'blank', 'used', 'blank', 'used', 'blank'])
  assertInvariants(r, '關著')
})

test('items 與 skip 重疊的排除只標一次：標略過不標排除', () => {
  const r = col(MONITOR, '點金靈', { skip: { head: 0, tail: 1 }, exclude: [{ index: 3, header: '合計' }] })
  assert.deepEqual(uses(r), ['used', 'used', 'used', 'skipTail'])
  assertInvariants(r, 'skip 與 exclude 重疊')
})

// ---- 失敗回傳：清單已經產生就帶 items ----

test('失敗也帶 items：全被排除、全部非數字、略過太多，沒有一格是採用', () => {
  const allEx = extractValue(el(table2([['a', '1'], ['b', '2']])), { mode: 'block', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum', exclude: [{ index: 0, header: 'a' }, { index: 1, header: 'b' }] } })
  assert.deepEqual(withoutItems(allEx), BASE.allExcluded)
  assert.deepEqual(uses(allEx), ['excluded', 'excluded'])

  const pe = col(table2([['a', '—'], ['b', 'x']]), '值')
  assert.deepEqual(withoutItems(pe), BASE.parseError)
  assert.deepEqual(uses(pe), ['nonnumeric', 'nonnumeric'])

  const tooMany = col(MONITOR, '點金靈', { skip: { head: 4, tail: 0 } })
  assert.equal(tooMany.ok, false)
  assert.deepEqual(uses(tooMany), ['skipHead', 'skipHead', 'skipHead', 'skipHead'])
})

test('失敗也帶 items：剩下的全部找不到子路徑', () => {
  const html = `<table><thead><tr><th>主機</th><th>狀態</th></tr></thead><tbody>
    <tr><td>a</td><td><span>x</span></td></tr><tr><td>b</td><td><span>y</span></td></tr></tbody></table>`
  const r = col(html, '狀態', { inner: [{ tag: 'span', index: 2 }] })
  assert.equal(r.ok, false)
  assert.deepEqual(uses(r), ['unresolved', 'unresolved'])
})

test('本來就沒有格子的失敗不帶 items（與改動前一字不差）', () => {
  const r = col(`<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`, 'b')
  assert.deepEqual(r, BASE.shortRow)
})

test('位置定位取那一格與儲存格都不帶 items、不帶 blank', () => {
  const pos = col(MONITOR, '點金靈', { pos: 'last', skip: ON })
  assert.equal(pos.ok, true)
  assert.equal('items' in pos, false)
  assert.equal('blank' in pos, false)
  const cell = extractValue(el(MONITOR), { mode: 'block', block: { cell: { row: { index: 0, header: '10.0.0.1' }, col: { index: 1, header: '點金靈' } } } })
  assert.equal(cell.ok, true)
  assert.equal('items' in cell, false)
})

// ---- 多值：逐值結果是擷取端白名單組出來的，兩鍵要一起抄 ----

test('多值：block 值帶 blank 與 items；失敗的 block 值也帶 items；儲存格值兩鍵都不帶', () => {
  const r = extractValue(el(BLANKS), {
    mode: 'block',
    fields: [
      { key: 'on', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum', skip: ON } },
      { key: 'off', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum' } },
      { key: 'fail', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum', skip: { head: 9, tail: 0 } } },
      { key: 'cell', cell: { row: { index: 2, header: 'c' }, col: { index: 1, header: '值' } } }
    ]
  })
  assert.equal(r.ok, true)
  assert.equal(r.fields.on.blank, 3)
  assertInvariants(r.fields.on, '多值 on')
  assert.equal('blank' in r.fields.off, false)
  assertInvariants(r.fields.off, '多值 off')
  assert.equal(r.fields.fail.ok, false)
  assert.equal(r.fields.fail.items.length, 6, '失敗的值也要看得到這一欄有哪些格子')
  assert.equal('items' in r.fields.cell, false)
  assert.equal('blank' in r.fields.cell, false)
})

// ---- 整列版的兩則訊息：單位是「格」、主詞是「這一列」（文件終檢補）----

const rowOf = (cells) => extractValue(el(`<table><thead><tr><th>甲</th><th>乙</th><th>丙</th></tr></thead><tbody><tr>${
  cells.map(c => `<td>${c}</td>`).join('')}</tr></tbody></table>`),
{ mode: 'block', block: { axis: 'row', index: 0, headerText: '', aggregate: 'sum', skip: ON } })

test('整列全部空白 → 訊息說「這一列的 N 格都是空白格」', () => {
  const r = rowOf(['', ' ', '&nbsp;'])
  assert.equal(r.ok, false)
  assert.equal(r.message, '這一列的 3 格都是空白格')
  assert.deepEqual(uses(r), ['trimmed', 'trimmed', 'trimmed'])
  assert.deepEqual(r.items.map(it => it.header), ['甲', '乙', '丙'])
})

test('整列剝完空白後不夠略過 → 訊息單位是格', () => {
  const r = extractValue(el(`<table><thead><tr><th>甲</th><th>乙</th><th>丙</th></tr></thead><tbody><tr><td></td><td>1</td><td></td></tr></tbody></table>`),
    { mode: 'block', block: { axis: 'row', index: 0, headerText: '', aggregate: 'sum', skip: { head: 1, tail: 1, blank: true } } })
  assert.equal(r.ok, false)
  assert.equal(r.message, '略過開頭 1 格、結尾 1 格後沒有剩下的格子（這一列去掉頭尾 2 格空白後只有 1 格）')
  assert.deepEqual(uses(r), ['trimmed', 'skipHead', 'trimmed'])
})
