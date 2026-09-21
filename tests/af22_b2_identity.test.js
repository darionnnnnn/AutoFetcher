process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'

const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })
const cell = (row = 1, col = 2, extra = {}) => ({
  cell: {
    row: { index: row, header: `列${row}` },
    col: { index: col, header: `欄${col}` },
    ...extra
  }
})
const source = (css, frame = {}) => ({
  locator: locator(css),
  ...(Object.keys(frame).length > 0 ? { frame } : {})
})
const pick = (src, spec = cell()) => ({ source: src, ...spec })

test('B2：相同表座標但來源 locator 不同，不得共用 field key', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const a = source('#table-a')
  const b = source('#table-b')
  const out = fm.reconcileFields([{ key: 'a1', name: '甲', source: a, spec: cell() }], [pick(b)])
  assert.equal(out[0].kept, false)
  assert.notEqual(out[0].key, 'a1')
  assert.deepEqual(out.removed, ['a1'])
})

test('B2：相同 locator 但不同 frame／document identity，不得共用 field key', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const frame = { url: 'https://a.test/embed' }
  const oldSource = { ...source('#same', frame), documentGeneration: 'doc-a' }
  const newSource = { ...source('#same', frame), documentGeneration: 'doc-b' }
  const out = fm.reconcileFields([
    { key: 'a1', name: '甲', source: oldSource, spec: cell() }
  ], [pick(newSource)])
  assert.equal(out[0].kept, false)
  assert.notEqual(out[0].key, 'a1')
})

test('B2：reconcile 輸出保留頂層文件世代，但 frame 只留穩定 url', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const out = fm.reconcileFields([], [pick({
    ...source('#same', {
      url: 'https://a.test/embed',
      frameId: 7,
      documentId: 'runtime-doc-a'
    }),
    frameId: 7,
    documentGeneration: 'generation-a'
  })])
  assert.deepEqual(out[0].source.frame, { url: 'https://a.test/embed' })
  assert.equal(out[0].source.documentGeneration, 'generation-a')
  assert.equal('frameId' in out[0].source, false)
  assert.equal('frameId' in out[0].source.frame, false)
  assert.equal('documentId' in out[0].source.frame, false)
})

test('B2：名稱與 skip/exclude 調整不是值身分，重選仍沿用 key', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const src = source('#table')
  const old = {
    key: 'k1', name: '使用者名稱', source: src,
    spec: { block: { axis: 'col', index: 2, headerText: '價格', skip: { head: 1 }, exclude: [{ index: 3 }] } }
  }
  const next = pick(src, { block: { axis: 'col', index: 2, headerText: '價格', skip: { tail: 2 }, exclude: [{ index: 8 }] } })
  const out = fm.reconcileFields([old], [next])
  assert.equal(out[0].key, 'k1')
  assert.equal(out[0].name, '使用者名稱')
  assert.equal(out[0].kept, true)
})

test('B2：來源升到帶等價身分的外層 locator，仍沿用已選 key', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const oldSource = { ...source('#inner-table'), identity: 'table-document-1' }
  const outerSource = { ...source('#outer-wrapper'), identity: 'table-document-1' }
  const out = fm.reconcileFields([
    { key: 'k1', name: '內層值', source: oldSource, spec: cell(1, 2, { inner: [{ tag: 'td', i: 0 }] }) }
  ], [pick(outerSource, cell(1, 2, { inner: [{ tag: 'td', i: 0 }] }))])
  assert.equal(out[0].key, 'k1')
  assert.equal(out[0].kept, true)
})

test('B2：移除一值只回報該 field key，其他值仍可認領', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const src = source('#table')
  const prev = [
    { key: 'k1', name: '甲', source: src, spec: cell(1, 2) },
    { key: 'k2', name: '乙', source: src, spec: cell(2, 2) },
    { key: 'k3', name: '丙', source: source('#other'), spec: cell(1, 2) }
  ]
  const out = fm.reconcileFields(prev, [pick(src, cell(1, 2)), pick(source('#other'), cell(1, 2))])
  assert.deepEqual(out.map(row => row.key), ['k1', 'k3'])
  assert.deepEqual(out.removed, ['k2'])
})

test('B2：來源判準是實際比對門檻，變更來源時 mutation 必須失敗', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  assert.equal(fm.sameSpec(
    { source: source('#a'), spec: cell() },
    { source: source('#b'), spec: cell() }
  ), false)
})
