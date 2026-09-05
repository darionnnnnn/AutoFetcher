import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { parseNumber, extractValue } from '../src/shared/extract.js'

const dom = html => new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document

test('parseNumber:各種真實寫法', () => {
  const cases = [
    ['1,234', 1234], ['$1,234.56', 1234.56], ['NT$ 1,234', 1234], ['12%', 12],
    ['１２３', 123], ['(1,234)', -1234], ['-5', -5], ['3.14', 3.14],
    ['12.5 元', 12.5], ['1 234', 1234], ['0', 0], ['-0.5%', -0.5],
    ['餘額:1,234 元', 1234], ['0.00', 0]
  ]
  for (const [input, want] of cases) assert.equal(parseNumber(input), want, `parseNumber(${JSON.stringify(input)})`)
})

test('parseNumber:解析不出來一律回 null,不回 0', () => {
  for (const bad of ['--', '', '   ', 'abc', 'N/A', '—', null, undefined])
    assert.equal(parseNumber(bad), null, `parseNumber(${JSON.stringify(bad)}) 應為 null`)
})

test('策略 auto:取第一個數字', () => {
  const d = dom('<div id="v">今日 1,234 筆 / 昨日 999 筆</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'auto' })
  assert.equal(r.ok, true)
  assert.equal(r.value, 1234)
  assert.equal(r.strategyUsed, 'auto')
  assert.equal(r.raw, '今日 1,234 筆 / 昨日 999 筆')
})

test('策略 regex:取第一個群組', () => {
  const d = dom('<div id="v">總計 A=12 B=34</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'regex', regex: 'B=(\\d+)' })
  assert.equal(r.value, 34)
  assert.equal(r.strategyUsed, 'regex')
})

test('策略 regex:正則語法錯誤時不丟例外,走備援', () => {
  const d = dom('<div id="v">55</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'regex', regex: '([' })
  assert.equal(r.ok, true)
  assert.equal(r.value, 55)
  assert.equal(r.status, 'fallback')
})

test('策略 attr:讀屬性,精確值優先於畫面四捨五入', () => {
  const d = dom('<span id="v" data-value="1234.5678">1,235</span>')
  const r = extractValue(d.getElementById('v'), { strategy: 'attr', attr: 'data-value' })
  assert.equal(r.value, 1234.5678)
  assert.equal(r.strategyUsed, 'attr')
})

test('策略 child:取內部子節點', () => {
  const d = dom('<div id="v"><span class="unit">元</span><b class="num">88</b></div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'child', childSel: '.num' })
  assert.equal(r.value, 88)
  assert.equal(r.strategyUsed, 'child')
})

test('策略 label:標籤右側的值', () => {
  const d = dom('<table><tr><td>今日總量</td><td>1,234</td></tr></table>')
  const r = extractValue(d.querySelector('table'), { strategy: 'label', labelText: '今日總量' })
  assert.equal(r.value, 1234)
  assert.equal(r.strategyUsed, 'label')
})

test('主策略失敗時自動備援,並標記 fallback 與實際策略', () => {
  const d = dom('<div id="v">1,234</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'attr', attr: 'data-nope' })
  assert.equal(r.ok, true)
  assert.equal(r.value, 1234)
  assert.equal(r.status, 'fallback')
  assert.equal(r.strategyUsed, 'auto')
})

test('主策略成功時 status 為 ok,不標 fallback', () => {
  const d = dom('<div id="v">7</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'auto' })
  assert.equal(r.status, 'ok')
})

test('全部策略失敗回 parse_error 並保留原文,不寫 0', () => {
  const d = dom('<div id="v">--</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'auto' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'parse_error')
  assert.equal(r.raw, '--')
  assert.equal(r.value, undefined, '失敗時不得有 value 欄位')
})

test('後處理:乘數與小數位', () => {
  const d = dom('<div id="v">1.5</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'auto', multiplier: 1000 })
  assert.equal(r.value, 1500)
  const r2 = extractValue(d.getElementById('v'), { strategy: 'auto', multiplier: 1 / 3, decimals: 2 })
  assert.equal(r2.value, 0.5)
  const d3 = dom('<div id="v">10</div>')
  const r3 = extractValue(d3.getElementById('v'), { strategy: 'auto', multiplier: 1 / 3, decimals: 3 })
  assert.equal(r3.value, 3.333)
})

test('後處理不改變 raw', () => {
  const d = dom('<div id="v">1.5</div>')
  const r = extractValue(d.getElementById('v'), { strategy: 'auto', multiplier: 1000 })
  assert.equal(r.raw, '1.5')
})

test('text 模式:extractValue 以 mode text 回原文,不解析數字', () => {
  const d = dom('<div id="v">尚未開盤</div>')
  const r = extractValue(d.getElementById('v'), { mode: 'text' })
  assert.equal(r.ok, true)
  assert.equal(r.value, '尚未開盤')
  assert.equal(r.raw, '尚未開盤')
})

test('text 模式空白內容視為失敗', () => {
  const d = dom('<div id="v">   </div>')
  const r = extractValue(d.getElementById('v'), { mode: 'text' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'parse_error')
})

test('元素為 null 時回 not_found,不丟例外', () => {
  const r = extractValue(null, { strategy: 'auto' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
})
