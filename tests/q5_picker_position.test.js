// AF-8 批次 C：Picker 的位置定位下拉、自動帶入、摘要與回填
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

const LOCATOR = { css: '#t', path: 'body > table:nth-of-type(1)', anchor: null, xpath: '/html[1]/body[1]/table[1]' }

// 5 個資料列的表；使用者點的是最後一列的「成交金額」
const cellPick = (rowIndex, rowHeader) => ({
  cell: {
    row: { index: rowIndex, header: rowHeader },
    col: { index: 2, header: '成交金額' }
  }
})
const ctxFor = (picks, over = {}) => ({
  locator: LOCATOR,
  url: 'https://twse.test/p',
  nameHint: '115年09月 市場成交資訊',
  blockInfo: { kind: 'table', rows: 5, cols: 3, headers: ['日期', '成交股數', '成交金額'] },
  picks,
  ...over
})

const $ = (doc, id) => doc.getElementById(id)

// ---------- P-1 下拉存在且有標籤 ----------

test('P-1 區塊區有列定位與欄定位兩個下拉，各有可見標籤與說明', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07')]))
  const rowPos = $(doc, 'row-pos')
  const colPos = $(doc, 'col-pos')
  assert.ok(rowPos, '要有列定位下拉')
  assert.ok(colPos, '要有欄定位下拉')
  assert.deepEqual(Array.from(rowPos.options).map(o => o.value), ['', 'first', 'last', 'last-1'])
  for (const el of [rowPos, colPos]) {
    const label = el.closest('label')
    assert.ok(label && label.textContent.trim().length > 0, '每個下拉都要有看得見的標籤')
  }
  assert.ok($(doc, 'pos-hint'), '要有一行白話說明')
  assert.ok(/最後/.test($(doc, 'pos-hint').textContent), `說明要講人話，實得 ${JSON.stringify($(doc, 'pos-hint').textContent)}`)
})

// ---------- P-2 自動帶入 ----------

// 不自動改設定：兩列的匯率表點第一列（美金）與每日成交表點最後一列，
// 在資料上長得一樣，猜錯就是默默換掉定位方式。只給建議，決定權留給使用者。
test('P-2 點的是最後一列時給建議，但不動下拉', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07')]))
  assert.equal($(doc, 'row-pos').value, '', '不得替使用者改設定')
  const summary = $(doc, 'block-summary').textContent
  assert.ok(/最後一列/.test(summary), `實得 ${JSON.stringify(summary)}`)
  assert.ok(/最後一筆/.test(summary), `要說出怎麼改，實得 ${JSON.stringify(summary)}`)
  assert.ok(/倒數第二/.test(summary), `要提醒最後一列可能是合計，實得 ${JSON.stringify(summary)}`)
  assert.equal($(doc, 'block-summary').getAttribute('role'), 'status')
})

test('P-2 點的是第一列時建議第一筆', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(0, '115/09/01')]))
  assert.equal($(doc, 'row-pos').value, '')
  assert.ok(/第一筆/.test($(doc, 'block-summary').textContent))
})

test('P-2 點中間那一列時不給建議', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(2, '115/09/03')]))
  assert.equal($(doc, 'row-pos').value, '')
  assert.ok(!/最後一筆|第一筆/.test($(doc, 'block-summary').textContent),
    '中間的列沒有「每天新增」的意思，不要亂建議')
})

// ---------- P-3 存進規格 ----------

test('P-3 儲存時把位置寫進 spec，且不看列標題', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07')]))
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  const values = pk.getFormData()
  const spec = pk.buildSpec(values)
  assert.equal(spec.block.cell.row.pos, 'last', `實得 ${JSON.stringify(spec.block)}`)
  assert.equal(spec.block.cell.col.header, '成交金額', '欄仍照表頭定位')
  assert.equal(spec.block.cell.col.pos, undefined)
})

test('P-3 多值任務每個值的同一軸都寫進同一個位置', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07'), {
    cell: { row: { index: 4, header: '115/09/07' }, col: { index: 1, header: '成交股數' } }
  }]))
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  const spec = pk.buildSpec(pk.getFormData())
  assert.equal(spec.fields.length, 2)
  for (const f of spec.fields) {
    assert.equal(f.cell.row.pos, 'last', `每個值都要跟著任務層級的設定，實得 ${JSON.stringify(f)}`)
  }
})

test('P-3 選「依表頭」時規格裡不留 pos', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07')]))
  $(doc, 'row-pos').value = ''
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  const spec = pk.buildSpec(pk.getFormData())
  assert.equal(spec.block.cell.row.pos, undefined)
  assert.equal(spec.block.cell.row.header, '115/09/07')
})

// ---------- P-4 聚合下拉 ----------

test('P-4 整欄的值加上位置之後，聚合下拉要隱藏', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([{ block: { axis: 'col', index: 2, headerText: '成交金額' } }]))
  const aggLabel = $(doc, 'block-aggregate').closest('label')
  assert.equal(aggLabel.hidden, false, '整欄聚合本來要選聚合方式')
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  assert.equal(aggLabel.hidden, true, '有位置就是取那一格，沒有東西要聚合')
})

// ---------- P-5 回填 ----------

test('P-5 編輯既有帶位置的任務時把下拉帶回來', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    task: {
      id: 't1', name: '成交金額', url: 'https://twse.test/p', mode: 'block',
      spec: { mode: 'block', block: { cell: { row: { pos: 'last-1' }, col: { index: 2, header: '成交金額' } } } },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [1, 2, 3, 4, 5] }
    }
  })
  assert.equal($(doc, 'row-pos').value, 'last-1')
})

// ---------- P-6 命名（批次 B） ----------

test('P-6 改了定位方式之後，沒手改過的名稱會跟著重算', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07')]))
  assert.equal($(doc, 'name').value, '成交金額')
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  assert.equal($(doc, 'name').value, '成交金額（最後一列）',
    '單值與多值要用同一套命名，否則在 Report 上分不出定位方式')
})

test('P-6 單值只有列標題時，改定位方式會換掉那個會過期的標題', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([{ cell: { row: { index: 4, header: '115/09/07' }, col: { index: 2, header: '' } } }]))
  assert.equal($(doc, 'name').value, '115/09/07')
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  assert.ok(!/115\/09\/07/.test($(doc, 'name').value),
    `會變的日期不該留在名稱裡，實得 ${JSON.stringify($(doc, 'name').value)}`)
})

test('P-6 手改過的名稱不會被重算蓋掉', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07'), {
    cell: { row: { index: 4, header: '115/09/07' }, col: { index: 1, header: '成交股數' } }
  }]))
  const first = doc.querySelector('#field-list [data-field-row] input[data-field-name]')
  first.value = '我自己取的名字'
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  assert.equal(first.value, '我自己取的名字')
})

test('P-6 單值儲存格的預設任務名稱用欄標題', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07')], {
    locator: { ...LOCATOR, anchor: { text: '25530' } }
  }))
  assert.equal($(doc, 'name').value, '成交金額',
    '使用者選的是成交金額，名稱不該是左邊那格或整張表的標題')
})

test('P-6 單值整欄聚合維持用表格名稱', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([{ block: { axis: 'col', index: 2, headerText: '成交金額' } }]))
  assert.equal($(doc, 'name').value, '115年09月 市場成交資訊')
})

test('P-6 多值任務的值名稱在用位置時不放會變的列標題', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07'), {
    cell: { row: { index: 4, header: '115/09/07' }, col: { index: 1, header: '成交股數' } }
  }]))
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  const names = Array.from(doc.querySelectorAll('#field-list [data-field-row] input[data-field-name]')).map(i => i.value)
  assert.deepEqual(names, ['成交金額（最後一列）', '成交股數（最後一列）'],
    `實得 ${JSON.stringify(names)}`)
})

// ---------- P-7 不留靜默無效的設定 ----------

test('P-7 整欄的值不給選「欄定位」，並說明為什麼', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([{ block: { axis: 'col', index: 2, headerText: '成交金額' } }]))
  const colPos = $(doc, 'col-pos')
  assert.equal(colPos.disabled, true, '整欄的欄是使用者自己點的，位置定位對它沒有意義')
  assert.ok(colPos.getAttribute('title'), '停用要說出理由')
  assert.equal($(doc, 'row-pos').disabled, false, '列定位才是「整欄的哪一格」')
})

test('P-7 整列的值不給選「列定位」', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([{ block: { axis: 'row', index: 0, headerText: '115/09/01' } }]))
  assert.equal($(doc, 'row-pos').disabled, true)
  assert.equal($(doc, 'col-pos').disabled, false)
})

test('P-7 整欄設了欄定位不會偷偷藏掉聚合下拉', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([{ block: { axis: 'col', index: 2, headerText: '成交金額' } }]))
  const aggLabel = $(doc, 'block-aggregate').closest('label')
  // 停用的欄定位就算被程式塞值也不該影響聚合下拉
  $(doc, 'col-pos').disabled = false
  $(doc, 'col-pos').value = 'last'
  $(doc, 'col-pos').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  assert.equal(aggLabel.hidden, false, '這個設定不會進規格，聚合仍在生效，就不能藏')
})

test('P-7 儲存格的值兩個定位都可選', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick(4, '115/09/07')]))
  assert.equal($(doc, 'row-pos').disabled, false)
  assert.equal($(doc, 'col-pos').disabled, false)
})
