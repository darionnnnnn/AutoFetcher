process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })

const validMulti = (over = {}) => ({
  id: 'mixed', name: '跨來源', url: 'https://a.test/mixed', mode: 'multi', enabled: true,
  spec: {
    mode: 'multi',
    fields: [
      { key: 'num', mode: 'number', source: { locator: locator('#num') }, spec: { strategy: 'auto' } },
      { key: 'txt', mode: 'text', source: { locator: locator('#txt'), frame: { url: 'https://b.test/frame' } }, spec: { mode: 'text' } },
      { key: 'blk', mode: 'block', source: { locator: locator('#table') }, spec: { mode: 'block', block: { axis: 'col', index: 1, aggregate: 'sum' } } }
    ]
  },
  fields: [{ key: 'num', name: '數值' }, { key: 'txt', name: '文字' }, { key: 'blk', name: '區塊' }],
  schedule: { type: 'daily', times: ['09:00'] },
  ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  return { c, st, io }
}

test('新 multi、舊 number/text/block 與舊同表多值格式皆可通過驗證', async () => {
  const { st } = await fresh()
  st.validateTask(validMulti())
  st.validateTask({ id: 'n', name: '數字', url: 'https://x.test', mode: 'number', spec: { strategy: 'auto' } })
  st.validateTask({ id: 't', name: '文字', url: 'https://x.test', mode: 'text', spec: { mode: 'text' } })
  st.validateTask({ id: 'b', name: '區塊', url: 'https://x.test', mode: 'block', spec: { mode: 'block', block: {} } })
  st.validateTask({
    id: 'old', name: '舊多值', url: 'https://x.test', mode: 'block',
    locator: locator('#table'), fields: [{ key: 'a', name: '甲' }],
    spec: { mode: 'block', fields: [{ key: 'a', cell: { row: {}, col: {} } }] }
  })
})

test('validateMultiTask 保留既有 fields metadata name 的寬鬆相容規則', async () => {
  const { validateMultiTask } = await import('../src/shared/task-source.js?t=' + Math.random())
  const task = validMulti({
    fields: [{ key: 'num', name: '' }, { key: 'txt' }, { key: 'blk', name: null }]
  })
  assert.doesNotThrow(() => validateMultiTask(task), '既有契約只要求 key，name 可空或缺省')
})

test('新 multi 需要非空 fields、雙方 key 一一對應且 key 不含 #', async () => {
  const { st } = await fresh()
  const cases = [
    [{ mode: 'multi', spec: { mode: 'multi', fields: [] }, fields: [] }, /multi|field/i],
    [{ mode: 'multi', spec: { mode: 'multi', fields: validMulti().spec.fields }, fields: [] }, /key|field/i],
    [{ mode: 'multi', spec: { mode: 'multi', fields: [{ ...validMulti().spec.fields[0], key: 'other' }] }, fields: validMulti().fields }, /key/i],
    [{ mode: 'multi', spec: { mode: 'multi', fields: validMulti().spec.fields }, fields: [{ key: 'num', name: '一' }, { key: 'num', name: '二' }, { key: 'blk', name: '三' }] }, /key/i],
    [{ mode: 'multi', spec: { mode: 'multi', fields: [{ ...validMulti().spec.fields[0], key: 'n#o' }, ...validMulti().spec.fields.slice(1)] }, fields: validMulti().fields }, /#/i]
  ]
  for (const [extra, error] of cases) assert.throws(() => st.validateTask({ ...validMulti(), ...extra }), error)
})

test('新 multi 深驗 source locator、frame、field mode 與遞迴 spec', async () => {
  const { st } = await fresh()
  const mutateField = (change) => ({ ...validMulti(), spec: { ...validMulti().spec, fields: validMulti().spec.fields.map((f, i) => i === 0 ? { ...f, ...change } : f) } })
  assert.throws(() => st.validateTask(mutateField({ source: undefined })), /source/i)
  assert.throws(() => st.validateTask(mutateField({ source: { locator: {} } })), /locator/i)
  assert.throws(() => st.validateTask(mutateField({ source: { locator: locator('#x'), frame: { url: '' } } })), /frame|url/i)
  assert.throws(() => st.validateTask(mutateField({ source: { locator: locator('#x'), frame: { url: 'https://x.test', frameId: 3 } } })), /frameId/i)
  assert.throws(() => st.validateTask(mutateField({ mode: 'unknown' })), /mode/i)
  assert.throws(() => st.validateTask(mutateField({ spec: { mode: 'multi', fields: [] } })), /multi|recurs/i)
})

test('新 multi 的 task.mode 與 spec.mode 必須同時是 multi，頂層網址仍守既有 scheme 規則', async () => {
  const { st } = await fresh()
  assert.throws(() => st.validateTask({ ...validMulti(), mode: 'multi', spec: { ...validMulti().spec, mode: 'block' } }), /multi|mode/i)
  assert.throws(() => st.validateTask({ ...validMulti(), mode: 'number' }), /multi|mode/i)
  assert.throws(() => st.validateTask({ ...validMulti(), url: 'javascript:alert(1)' }), /網址|http|https/i)
  assert.throws(() => st.validateTask({ ...validMulti(), url: 'not a url' }), /網址|http|https/i)
})

test('schema 升到 4 不做資料遷移，匯出再匯入新 multi 可完整往返且設定包 version 不變', async () => {
  const { c, st, io } = await fresh()
  assert.equal(st.SCHEMA_VERSION, 4)
  assert.equal((await c.storage.local.get('schemaVersion')).schemaVersion, 4)
  await st.saveTask(validMulti())
  const exported = JSON.parse(await io.exportSettings({ includePasswords: false }))
  assert.equal(exported.version, 1)
  assert.equal(exported.data.schemaVersion, 4)
  assert.deepEqual(exported.data.tasks[0].spec.mode, 'multi')

  resetChromeMock(); installChromeMock()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  const io2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  await io2.importSettings(JSON.stringify(exported))
  assert.deepEqual((await st2.getTask('mixed')).spec, exported.data.tasks[0].spec)
  assert.deepEqual((await st2.getTask('mixed')).fields, exported.data.tasks[0].fields)
  await assert.rejects(() => io2.importSettings(JSON.stringify({ ...exported, data: { ...exported.data, schemaVersion: 5 } })), /較新|更新|schema/i)
})
