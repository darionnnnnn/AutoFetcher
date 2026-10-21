import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { unitOfAxis } from '../src/shared/describe.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const LITERAL = "'格' : '列'"
const count = (s) => s.split(LITERAL).length - 1

test('unitOfAxis：整列數格、整欄數列', () => {
  assert.equal(unitOfAxis('row'), '格')
  assert.equal(unitOfAxis('col'), '列')
})

test('「格 : 列」字面只剩 unitOfAxis 定義那一處', () => {
  assert.equal(count(read('src/shared/describe.js')), 1)
  assert.equal(count(read('src/shared/extract.js')), 0)
  assert.equal(count(read('src/ui/picker/picker.js')), 0)
})
