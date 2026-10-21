import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { unitOfAxis } from '../src/shared/describe.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
// 不論引號、空白與順序：「? 格 : 列」或「? 列 : 格」都算一份單位選字
const UNIT_PICK = /\?\s*['"`](格|列)['"`]\s*:\s*['"`](格|列)['"`]/g
const count = (s) => [...s.matchAll(UNIT_PICK)].filter(m => m[1] !== m[2]).length

test('unitOfAxis：整列數格、整欄數列', () => {
  assert.equal(unitOfAxis('row'), '格')
  assert.equal(unitOfAxis('col'), '列')
})

test('「格 : 列」字面只剩 unitOfAxis 定義那一處', () => {
  assert.equal(count(read('src/shared/describe.js')), 1)
  assert.equal(count(read('src/shared/extract.js')), 0)
  assert.equal(count(read('src/ui/picker/picker.js')), 0)
})
