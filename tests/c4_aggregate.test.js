// AF-3 批次 C:區塊聚合(SPEC §7)
import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateCells } from '../src/shared/aggregate.js'

test('五種聚合方式', () => {
  const v = ['10', '32', '7']
  assert.equal(aggregateCells(v, 'max').value, 32)
  assert.equal(aggregateCells(v, 'min').value, 7)
  assert.equal(aggregateCells(v, 'sum').value, 49)
  assert.equal(aggregateCells(v, 'count').value, 3)
  assert.equal(aggregateCells(v, 'avg').value, 49 / 3)
})

test('沿用 parseNumber:千分位、貨幣、百分號、全形、會計負數都要吃得下', () => {
  const r = aggregateCells(['1,234', 'NT$500', '20%', '１２３', '（50）'], 'sum')
  assert.equal(r.skipped, 0, '五個都該解析得出來')
  assert.equal(r.value, 1234 + 500 + 20 + 123 - 50)
})

test('解析不出來的格子跳過並計數', () => {
  const r = aggregateCells(['10', 'N/A', '—', '', '32'], 'sum')
  assert.equal(r.value, 42)
  assert.equal(r.skipped, 3)
  assert.equal(r.used, 2)
})

test('avg 是除以「解析得出來的格子數」,不是全部格子數', () => {
  const r = aggregateCells(['10', 'N/A', '—', '20'], 'avg')
  assert.equal(r.value, 15, '(10+20)/2,不是 /4')
  assert.equal(r.used, 2)
})

test('count 只算解析得出來的格子', () => {
  const r = aggregateCells(['10', 'N/A', '32'], 'count')
  assert.equal(r.value, 2)
  assert.equal(r.skipped, 1)
})

test('全部都解析不出來時 value 是 null(交給呼叫端當 parse_error)', () => {
  const r = aggregateCells(['N/A', '—'], 'sum')
  assert.equal(r.value, null)
  assert.equal(r.skipped, 2)
  assert.equal(r.used, 0)
})

test('空陣列不得拋例外', () => {
  const r = aggregateCells([], 'sum')
  assert.equal(r.value, null)
  assert.equal(r.used, 0)
})

test('不認識的聚合方式回 null,不要亂猜', () => {
  assert.equal(aggregateCells(['1', '2'], 'median').value, null)
})

test('沒指定聚合方式時預設 sum', () => {
  assert.equal(aggregateCells(['1', '2']).value, 3)
})

test('負數與小數', () => {
  const r = aggregateCells(['-1.5', '2.25'], 'sum')
  assert.equal(r.value, 0.75)
  assert.equal(aggregateCells(['-1.5', '2.25'], 'min').value, -1.5)
})

test('單一格子', () => {
  const r = aggregateCells(['42'], 'avg')
  assert.equal(r.value, 42)
  assert.equal(r.used, 1)
})

test('不得改動傳進來的陣列', () => {
  const input = ['3', '1', '2']
  aggregateCells(input, 'min')
  assert.deepEqual(input, ['3', '1', '2'], '純函式不得排序原陣列')
})
