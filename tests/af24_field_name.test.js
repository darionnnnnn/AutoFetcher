// AF-24 F7：值的預設名稱、位置後綴只有 describe.js 一份（Picker 與 background 重選共用）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { defaultFieldName, posSuffix, anchorOnly } from '../src/shared/describe.js'

const cell = (row, col, extra = {}) => ({ cell: { row: { index: 0, header: row }, col: { index: 1, header: col }, ...extra } })

test('一般儲存格：列標題 · 欄標題', () => {
  assert.equal(defaultFieldName(cell('美金', '買入'), 1), '美金 · 買入')
})

test('用位置定位的軸不放標題，名稱帶後綴；兩軸都定位時退成「值」', () => {
  assert.equal(defaultFieldName(cell('2026-10-21', '收盤'), 1, { rowPos: 'last' }), '收盤（最後一列）')
  assert.equal(defaultFieldName(cell('a', 'b'), 3, { rowPos: 'last', colPos: 'first' }), '值（最後一列、第一欄）')
})

test('純數值標題不進名稱；什麼都沒有時退成「值 n」', () => {
  assert.equal(anchorOnly('4318'), '')
  assert.equal(defaultFieldName(cell('4318', '2025'), 2), '值 2')
  assert.equal(defaultFieldName({ block: { headerText: '成交量' } }, 1), '成交量')
  assert.equal(defaultFieldName({}, 5), '值 5')
  assert.equal(posSuffix({}), '')
})

test('Picker 與 background 不再各自保留一張位置字表或命名函式', () => {
  const picker = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8')
  for (const [name, s] of [['picker.js', picker], ['main.js', main]]) {
    assert.equal(/POS_LABELS|POS_NAMES/.test(s), false, `${name} 不得再有自己的位置字表`)
    assert.equal(/function anchorOnly/.test(s), false, `${name} 不得再有自己的 anchorOnly`)
  }
  assert.equal(/function defaultFieldName/.test(main), false)
})
