// AF-24 B1：parseNumber 的負號、全形標點、前導小數點、科學記號
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumber } from '../src/shared/extract.js'

const CASES = [
  // 原本靜默算錯的七種
  ['1.5e3', 1500],
  ['−12', -12],          // U+2212 MINUS SIGN
  ['－12', -12],              // 全形負號
  ['1，234', 1234],           // 全形逗號
  ['1．5', 1.5],              // 全形小數點
  ['- 12', -12],              // 負號後一個空白
  ['.5', 0.5],
  ['-.5', -0.5],
  ['1.2E-3', 0.0012],
  ['3e+2', 300],
  // 反例：不可因為放寬而改變的形狀
  ['10 - 12', 10],            // 兩個數字中間的減號不是負號
  ['v1.5.2', 1.5],
  ['1e', 1],                  // e 後沒有數字不算指數
  ['3e-', 3],
  ['2024e', 2024],
  ['12 e3', 12],              // e 前有空白不算
  ['A-12', -12],              // 維持既有行為
  ['(1，234)', -1234],
  ['１，２３４．５', 1234.5],
  ['-  12', 12],              // 兩個以上空白不視為負號（維持保守）
  ['NT$1,234.50', 1234.5],
  ['2026-09-02', null]
]

for (const [input, expected] of CASES) {
  test(`parseNumber(${JSON.stringify(input)}) === ${expected}`, () => {
    assert.equal(parseNumber(input), expected)
  })
}
