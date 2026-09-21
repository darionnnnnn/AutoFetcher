process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'

const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })

const oldSingle = (over = {}) => ({
  id: 'single', name: '單值', url: 'https://a.test/value', mode: 'number',
  locator: locator('#value'), frame: { url: 'https://a.test/frame' },
  spec: { strategy: 'auto' }, ...over
})

const oldMulti = (over = {}) => ({
  id: 'table', name: '同表多值', url: 'https://a.test/table', mode: 'block',
  locator: locator('#table'),
  spec: {
    strategy: 'auto', mode: 'block',
    fields: [
      { key: 'buy', cell: { row: { index: 0 }, col: { index: 1 } } },
      { key: 'sell', block: { axis: 'col', index: 2, aggregate: 'sum' } }
    ]
  },
  fields: [{ key: 'buy', name: '買入' }, { key: 'sell', name: '賣出' }],
  ...over
})

const newMulti = (over = {}) => ({
  id: 'mixed', name: '跨來源', url: 'https://a.test/mixed', mode: 'multi',
  spec: {
    mode: 'multi',
    fields: [
      { key: 'price', mode: 'number', source: { locator: locator('#price') }, spec: { strategy: 'auto' } },
      { key: 'label', mode: 'text', source: { locator: locator('#label'), frame: { url: 'https://b.test/embed' } }, spec: { mode: 'text' } },
      { key: 'total', mode: 'block', source: { locator: locator('#other-table') }, spec: { mode: 'block', block: { axis: 'col', index: 1, aggregate: 'sum' } } }
    ]
  },
  fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }, { key: 'total', name: '合計' }],
  ...over
})

test('normalizeTaskSources 將舊單值映射為單一統一 source field', async () => {
  const { normalizeTaskSources } = await import('../src/shared/task-source.js?t=' + Math.random())
  const task = oldSingle()
  const before = structuredClone(task)
  assert.deepEqual(normalizeTaskSources(task), [{
    key: '', name: '單值', mode: 'number',
    source: { locator: locator('#value'), frame: { url: 'https://a.test/frame' } },
    spec: { strategy: 'auto' }
  }])
  assert.deepEqual(task, before, '正規化不得修改輸入')
})

test('normalizeTaskSources 將舊同表 block fields 映射為每欄一個 source field', async () => {
  const { normalizeTaskSources } = await import('../src/shared/task-source.js?t=' + Math.random())
  const result = normalizeTaskSources(oldMulti())
  assert.deepEqual(result.map(({ key, name, mode }) => ({ key, name, mode })), [
    { key: 'buy', name: '買入', mode: 'block' },
    { key: 'sell', name: '賣出', mode: 'block' }
  ])
  assert.deepEqual(result[0].source, { locator: locator('#table') })
  assert.deepEqual(result[0].spec, { mode: 'block', cell: { row: { index: 0 }, col: { index: 1 } } })
  assert.deepEqual(result[1].spec, { mode: 'block', block: { axis: 'col', index: 2, aggregate: 'sum' } })
})

test('normalizeTaskSources 保留新 multi 每 field 的跨表 locator、frame 與單目標 spec', async () => {
  const { normalizeTaskSources } = await import('../src/shared/task-source.js?t=' + Math.random())
  const task = newMulti()
  const result = normalizeTaskSources(task)
  assert.deepEqual(result.map(({ key, name, mode }) => ({ key, name, mode })), [
    { key: 'price', name: '價格', mode: 'number' },
    { key: 'label', name: '標籤', mode: 'text' },
    { key: 'total', name: '合計', mode: 'block' }
  ])
  assert.deepEqual(result[1].source, { locator: locator('#label'), frame: { url: 'https://b.test/embed' } })
  assert.deepEqual(result[2].spec, { mode: 'block', block: { axis: 'col', index: 1, aggregate: 'sum' } })
  assert.deepEqual(task, newMulti(), '正規化不得改寫新格式')
})

test('series-index 對新 multi 依每個 field mode 建立序列，舊單值仍 byte-compatible', async () => {
  const { buildSeriesIndex } = await import('../src/shared/series-index.js?t=' + Math.random())
  const idx = buildSeriesIndex([oldSingle(), newMulti()])
  assert.deepEqual(idx.seriesIds, ['single', 'mixed#price', 'mixed#label', 'mixed#total'])
  assert.equal(idx.byId.single.name, '單值')
  assert.equal(idx.byId.single.mode, 'number')
  assert.equal(idx.byId['mixed#price'].mode, 'number')
  assert.equal(idx.byId['mixed#label'].mode, 'text')
  assert.equal(idx.byId['mixed#total'].mode, 'block')
})
