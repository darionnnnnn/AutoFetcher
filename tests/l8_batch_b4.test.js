// AF-5 批次 B4：Picker 多值表單
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

const PICKS = [
  { cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '即期匯率 · 買入' } } },
  { cell: { row: { index: 0, header: '美金' }, col: { index: 4, header: '即期匯率 · 賣出' } } }
]

const ctxOf = (over = {}) => ({
  url: 'https://bank.test/rate',
  locator: { css: '#rate' },
  nameHint: '臺銀牌告匯率',
  blockInfo: { kind: 'table', rows: 2, cols: 5 },
  picks: PICKS,
  ...over
})

const rows = (doc) => [...doc.querySelectorAll('[data-field-row]')]

// ---- 值清單 ----

test('挑了兩個值時列出兩列可命名的欄位', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxOf())
  assert.equal(rows(doc).length, 2)
  const names = rows(doc).map(r => r.querySelector('input[data-field-name]').value)
  assert.deepEqual(names, ['美金 · 即期匯率 · 買入', '美金 · 即期匯率 · 賣出'],
    '值的名稱預設用「列標題 · 欄標題」')
})

test('任務名稱只填一次，用選取時算出的提示', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxOf())
  assert.equal(doc.getElementById('name').value, '臺銀牌告匯率')
})

test('只挑一個值時不顯示值清單（維持單值任務）', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxOf({ picks: [PICKS[0]] }))
  assert.equal(rows(doc).length, 0)
})

test('整欄聚合的值名稱用欄表頭', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxOf({
    picks: [
      { block: { axis: 'col', index: 3, headerText: '即期匯率 · 買入' } },
      { block: { axis: 'row', index: 0, headerText: '美金' } }
    ]
  }))
  const names = rows(doc).map(r => r.querySelector('input[data-field-name]').value)
  assert.deepEqual(names, ['即期匯率 · 買入', '美金'])
})

test('名稱重複時自動加序號，存進去的 key 各自獨立', async () => {
  const { st, pk, doc } = await fresh()
  pk.render(ctxOf({
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '買入' } } },
      { cell: { row: { index: 1, header: '美金' }, col: { index: 3, header: '買入' } } }
    ]
  }))
  const names = rows(doc).map(r => r.querySelector('input[data-field-name]').value)
  assert.notEqual(names[0], names[1], `兩個值不能同名：${names.join(' / ')}`)
})

// ---- 存檔 ----

async function saveWith(pk, doc, ctx = ctxOf()) {
  pk.render(ctx)
  doc.getElementById('name').value = '臺銀牌告匯率'
  doc.getElementById('url').value = ctx.url
  const sel = doc.getElementById('dashboard-select')
  if (sel) sel.value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
}

test('存檔後是一個任務、兩個值', async () => {
  const { st, pk, doc } = await fresh()
  await saveWith(pk, doc)
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 1, '多值是一個任務，不是兩個')
  assert.equal(tasks[0].fields.length, 2)
  assert.equal(tasks[0].mode, 'block')
})

test('每個值有唯一的 key，擷取規格帶得出來', async () => {
  const { st, pk, doc } = await fresh()
  await saveWith(pk, doc)
  const t = (await st.getTasks())[0]
  const keys = t.fields.map(f => f.key)
  assert.equal(new Set(keys).size, 2)
  assert.equal(t.spec.fields.length, 2)
  assert.deepEqual(t.spec.fields.map(f => f.key), keys, '規格與顯示清單要對得起來')
  assert.ok(t.spec.fields[0].cell, '儲存格型的值')
  assert.equal(t.spec.mode, 'block')
})

test('多值任務不得留下單值用的 spec.block', async () => {
  const { st, pk, doc } = await fresh()
  await saveWith(pk, doc)
  const t = (await st.getTasks())[0]
  assert.equal(t.spec.block, undefined)
})

test('使用者改過的值名稱會被存下來', async () => {
  const { st, pk, doc } = await fresh()
  pk.render(ctxOf())
  rows(doc)[0].querySelector('input[data-field-name]').value = '美金買入'
  doc.getElementById('name').value = '臺銀'
  doc.getElementById('url').value = 'https://bank.test/rate'
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = (await st.getTasks())[0]
  assert.equal(t.fields[0].name, '美金買入')
})

// ---- 編輯既有多值任務 ----

const savedMulti = () => ({
  id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
  spec: {
    strategy: 'auto', mode: 'block',
    fields: [
      { key: 'k1', cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '即期 · 買入' } } },
      { key: 'k2', cell: { row: { index: 0, header: '美金' }, col: { index: 4, header: '即期 · 賣出' } } }
    ]
  },
  fields: [{ key: 'k1', name: '美金買入' }, { key: 'k2', name: '美金賣出' }],
  schedule: { type: 'daily', times: ['09:30'], weekdays: [1, 2, 3, 4, 5] }
})

test('編輯多值任務時值清單會回填', async () => {
  const { pk, doc } = await fresh()
  pk.render({ task: savedMulti(), locator: {}, url: 'https://bank.test/rate' })
  const names = rows(doc).map(r => r.querySelector('input[data-field-name]').value)
  assert.deepEqual(names, ['美金買入', '美金賣出'])
})

test('編輯多值任務什麼都不改直接存，規格逐位不變', async () => {
  const { st, pk, doc } = await fresh()
  const orig = savedMulti()
  await st.saveTask(orig)
  pk.render({ task: orig, locator: {}, url: orig.url })
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = await st.getTask('bank')
  assert.deepEqual(t.fields, orig.fields, '值清單不得被洗掉')
  assert.deepEqual(t.spec.fields, orig.spec.fields, '擷取規格不得被洗掉')
  assert.equal(t.spec.block, undefined, '不得誤生出空的 block 規格')
})

test('改名不改 key', async () => {
  const { st, pk, doc } = await fresh()
  const orig = savedMulti()
  await st.saveTask(orig)
  pk.render({ task: orig, locator: {}, url: orig.url })
  rows(doc)[0].querySelector('input[data-field-name]').value = '美金即期買入'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = await st.getTask('bank')
  assert.equal(t.fields[0].name, '美金即期買入')
  assert.equal(t.fields[0].key, 'k1', 'key 一旦寫進紀錄就不能變')
})

test('移除一個值後只剩一個，紀錄不受影響', async () => {
  const { st, pk, doc } = await fresh()
  const orig = savedMulti()
  await st.saveTask(orig)
  await st.appendRecord('2026-09-06', { taskId: 'bank#k2', slot: '2026-09-06T09:30', capturedAt: 'a', value: 31.3, status: 'ok' })
  pk.render({ task: orig, locator: {}, url: orig.url })
  rows(doc)[1].querySelector('[data-field-remove]').click()
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = await st.getTask('bank')
  assert.equal(t.fields.length, 1)
  assert.equal(t.fields[0].key, 'k1')
  assert.equal((await st.getRecordsByDate('2026-09-06')).length, 1, '舊紀錄保留，只是不再抓新的')
})

test('值可以上下移動改順序', async () => {
  const { st, pk, doc } = await fresh()
  const orig = savedMulti()
  await st.saveTask(orig)
  pk.render({ task: orig, locator: {}, url: orig.url })
  rows(doc)[1].querySelector('[data-field-up]').click()
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = await st.getTask('bank')
  assert.deepEqual(t.fields.map(f => f.key), ['k2', 'k1'])
  assert.deepEqual(t.spec.fields.map(f => f.key), ['k2', 'k1'], '規格順序要跟著走')
})

// ---- 單值任務不受影響 ----

test('單值任務存檔後沒有 fields', async () => {
  const { st, pk, doc } = await fresh()
  pk.render({ url: 'https://x.test/a', locator: { css: '#v' }, preview: '1234' })
  doc.getElementById('name').value = '總量'
  doc.getElementById('url').value = 'https://x.test/a'
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = (await st.getTasks())[0]
  assert.equal(t.fields, undefined)
  assert.equal(t.spec.fields, undefined)
})

test('單值的區塊任務仍走 spec.block', async () => {
  const { st, pk, doc } = await fresh()
  pk.render(ctxOf({ picks: [{ block: { axis: 'col', index: 1, headerText: '數量' } }] }))
  doc.getElementById('name').value = '用電'
  doc.getElementById('url').value = 'https://x.test/a'
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = (await st.getTasks())[0]
  assert.ok(t.spec.block, '單值仍用 block')
  assert.equal(t.spec.fields, undefined)
  assert.equal(t.fields, undefined)
})

// ---- 告警指定值 ----

test('多值任務的告警可以指定套用到哪一個值', async () => {
  const { st, pk, doc } = await fresh()
  const orig = savedMulti()
  await st.saveTask(orig)
  pk.render({ task: orig, locator: {}, url: orig.url })
  doc.getElementById('alert-add').click()
  const row = doc.querySelector('[data-alert-row]')
  const fieldSel = row.querySelector('select[data-alert-field]')
  assert.ok(fieldSel, '多值任務的告警要能指定值')
  const opts = [...fieldSel.options].map(o => o.value)
  assert.deepEqual(opts, ['', 'k1', 'k2'], '空字串代表套用到全部')
  fieldSel.value = 'k2'
  row.querySelector('.alert-value').value = '31'
  row.querySelector('select.alert-type').value = 'gt'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = await st.getTask('bank')
  assert.equal(t.alerts[0].field, 'k2')
})

test('單值任務的告警沒有這個下拉', async () => {
  const { pk, doc } = await fresh()
  pk.render({ url: 'https://x.test/a', locator: { css: '#v' } })
  doc.getElementById('alert-add').click()
  assert.equal(doc.querySelector('[data-alert-row] select[data-alert-field]'), null)
})

// ---- 儲存前的確認 ----

test('多值儲存前顯示摘要讓使用者確認', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxOf())
  const summary = doc.getElementById('save-summary')
  assert.ok(summary, '要有一個地方說明將建立什麼')
  assert.ok(summary.textContent.includes('2'), `摘要要說有幾個值：${summary.textContent}`)
  assert.equal(summary.hidden, false)
})

test('單值時不顯示摘要', async () => {
  const { pk, doc } = await fresh()
  pk.render({ url: 'https://x.test/a', locator: { css: '#v' } })
  assert.equal(doc.getElementById('save-summary').hidden, true)
})
