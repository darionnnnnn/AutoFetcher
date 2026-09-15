// AF-17 作業 A 第 2 段：Picker 的「自動略過頭尾空白」勾選框、收集、回填、預覽，以及 background 重選保留
// 規格見 docs/AF-17-PLAN.md 作業 A。第 1 段只驗到 extractValue；這一段從表單一路驗到規格與重選。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

const LOCATOR = { css: '#mon', path: 'body > table:nth-of-type(1)', anchor: null, xpath: '/html[1]/body[1]/table[1]' }
const ON = { head: 0, tail: 0, blank: true }
const colPick = (over = {}) => ({ block: { axis: 'col', index: 1, headerText: '點金靈', ...over } })
const cellPick = { cell: { row: { index: 0, header: '10.0.0.1' }, col: { index: 1, header: '點金靈' } } }
const ctxFor = (picks, over = {}) => ({
  locator: LOCATOR, url: 'https://mon.test/p', nameHint: '監控',
  blockInfo: { kind: 'table', rows: 4, cols: 3, headers: ['主機', '點金靈', 'TSWEB'] },
  picks, ...over
})
const $ = (doc, id) => doc.getElementById(id)
const fire = (doc, id, type) => $(doc, id).dispatchEvent(new globalThis.window.Event(type, { bubbles: true }))
const setNum = (doc, id, v) => { $(doc, id).value = String(v); fire(doc, id, 'input'); fire(doc, id, 'change') }
const setCheck = (doc, id, v) => { $(doc, id).checked = v; fire(doc, id, 'input'); fire(doc, id, 'change') }
const setPos = (doc, id, v) => { $(doc, id).value = v; fire(doc, id, 'change') }
const blockOf = (pk) => pk.buildSpec(pk.getFormData()).block
const editTask = (spec, over = {}) => ({
  locator: LOCATOR,
  task: {
    id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block', spec,
    schedule: { type: 'daily', times: ['09:30'], weekdays: [1, 2, 3, 4, 5] }, ...over
  }
})

// ---- 勾選框本身 ----

test('勾選框在略過欄位那一列裡、新建時預設勾選、有看得見的標籤', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  const box = $(doc, 'skip-blank')
  assert.ok(box, '要有 #skip-blank')
  assert.equal(box.type, 'checkbox')
  assert.equal(box.checked, true, '預設勾選')
  assert.ok(box.closest('[data-skip-row]'), '與略過欄位同一列，顯示條件才會一致')
  const label = box.closest('label') || doc.querySelector('label[for="skip-blank"]')
  assert.ok(label && /空白/.test(label.textContent), '標籤要說出這是「空白」')
})

// ---- 收集成規格 ----

test('單值整欄新建：規格帶 skip.blank，而且形狀帶 head 與 tail', async () => {
  const { pk } = await fresh()
  pk.render(ctxFor([colPick()]))
  assert.deepEqual(blockOf(pk).skip, ON)
})

test('取消勾選、略過都是 0：規格不帶 skip 鍵', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  setCheck(doc, 'skip-blank', false)
  assert.equal('skip' in blockOf(pk), false)
})

test('取消勾選、略過結尾 1：形狀與 AF-16 一字不差', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  setCheck(doc, 'skip-blank', false)
  setNum(doc, 'skip-tail', 1)
  assert.deepEqual(blockOf(pk).skip, { head: 0, tail: 1 })
})

test('勾選且略過開頭 1：兩者一起進規格', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  setNum(doc, 'skip-head', 1)
  assert.deepEqual(blockOf(pk).skip, { head: 1, tail: 0, blank: true })
})

test('多值：每個整欄整列的值都帶 blank，儲存格值不帶', async () => {
  const { pk } = await fresh()
  pk.render(ctxFor([colPick(), { block: { axis: 'col', index: 2, headerText: 'TSWEB' } }, cellPick]))
  const spec = pk.buildSpec(pk.getFormData())
  assert.equal(spec.fields.length, 3)
  assert.deepEqual(spec.fields[0].block.skip, ON)
  assert.deepEqual(spec.fields[1].block.skip, ON)
  assert.equal('skip' in spec.fields[2].cell, false)
})

test('位置定位把略過列藏起來時，勾著也不寫 skip', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  assert.equal($(doc, 'skip-blank').checked, true, '前提：勾著')
  setPos(doc, 'row-pos', 'last')
  assert.equal($(doc, 'skip-blank').closest('[data-skip-row]').hidden, true, '前提：藏起來了')
  assert.equal('skip' in blockOf(pk), false, '看不見的設定不得偷偷生效')
})

// ---- 編輯既有任務：顯示真實狀態 ----

test('編輯沒有 blank 的舊任務：不勾，重存形狀不變', async () => {
  const { pk, doc } = await fresh()
  pk.render(editTask({ mode: 'block', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: { head: 0, tail: 1 } } }))
  assert.equal($(doc, 'skip-blank').checked, false, '舊任務沒有這個設定，勾起來就是替使用者改了抓法')
  assert.equal($(doc, 'skip-tail').value, '1')
  assert.deepEqual(blockOf(pk).skip, { head: 0, tail: 1 })
})

test('編輯完全沒有 skip 的舊任務：不勾，重存不帶 skip', async () => {
  const { pk, doc } = await fresh()
  pk.render(editTask({ mode: 'block', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum' } }))
  assert.equal($(doc, 'skip-blank').checked, false)
  assert.equal('skip' in blockOf(pk), false)
})

test('編輯帶 blank 的單值任務：勾著', async () => {
  const { pk, doc } = await fresh()
  pk.render(editTask({ mode: 'block', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: ON } }))
  assert.equal($(doc, 'skip-blank').checked, true)
  assert.deepEqual(blockOf(pk).skip, ON)
})

test('編輯帶 blank 的多值任務：從第一個帶 skip 的整欄值回填', async () => {
  const { pk, doc } = await fresh()
  pk.render(editTask({
    mode: 'block',
    fields: [
      { key: 'c1', cell: { row: { index: 0, header: '10.0.0.1' }, col: { index: 1, header: '點金靈' } } },
      { key: 'g', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: ON } }
    ]
  }, { fields: [{ key: 'c1', name: '主機 A' }, { key: 'g', name: '點金靈' }] }))
  assert.equal($(doc, 'skip-blank').checked, true)
  assert.deepEqual(pk.buildSpec(pk.getFormData()).fields[1].block.skip, ON)
})

test('換目標（render 再跑一次）：勾選框與略過數字欄位同一種待遇', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  setCheck(doc, 'skip-blank', false)
  setNum(doc, 'skip-tail', 1)
  pk.render(ctxFor([{ block: { axis: 'col', index: 2, headerText: 'TSWEB' } }]))
  const tailKept = $(doc, 'skip-tail').value === '1'
  const boxKept = $(doc, 'skip-blank').checked === false
  assert.equal(boxKept, tailKept, `勾選框${boxKept ? '保留' : '重設'}、略過欄位${tailKept ? '保留' : '重設'}，兩者不能一個留一個丟`)
})

// ---- 白話描述不提空白 ----

test('摘要卡與儲存摘要不因預設勾選而多出「略過」或「空白」', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  assert.equal($(doc, 'skip-blank').checked, true, '前提：勾著')
  assert.doesNotMatch($(doc, 'summary-target').textContent, /略過|空白/)
  const save = $(doc, 'save-summary')
  if (save) assert.doesNotMatch(save.textContent, /略過|空白/)
})

// ---- 立即測試預覽 ----

test('單值預覽：沒有 blank 時字串與改動前一字不差', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick()], { tabId: 5 }))
  c.__setRuntimeResponder(() => ({ ok: true, value: 150, raw: '53, 49, 48', status: 'ok', strategyUsed: 'block', used: 3, skipped: 1, excluded: 1 }))
  await pk.handleTestNow()
  assert.equal($(doc, 'preview').textContent, '150（用了 3 格、非數字 1 格、略過與排除 1 格）')
})

test('單值預覽：有 blank 時在非數字之後說出空白幾格', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick()], { tabId: 5 }))
  c.__setRuntimeResponder(() => ({ ok: true, value: 30, raw: '10, , 20', status: 'ok', strategyUsed: 'block', used: 2, skipped: 1, blank: 3 }))
  await pk.handleTestNow()
  const text = $(doc, 'preview').textContent
  assert.ok(text.includes('非數字 1 格、空白 3 格'), text)
  assert.ok(text.includes('略過與排除 0 格'), text)
})

test('多值預覽：block 值那一行也說出空白幾格', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick(), cellPick], { tabId: 5 }))
  const keys = [...doc.querySelectorAll('#field-list [data-field-row]')].map(r => r.dataset.fieldKey)
  c.__setRuntimeResponder(() => ({
    ok: true,
    fields: {
      [keys[0]]: { ok: true, value: 30, raw: '10, , 20', status: 'ok', used: 2, skipped: 1, blank: 2 },
      [keys[1]]: { ok: true, value: 53, raw: '53', status: 'ok' }
    }
  }))
  await pk.handleTestNow()
  const lines = $(doc, 'preview').textContent.split('\n')
  assert.ok(lines[0].includes('空白 2 格'), lines[0])
  assert.doesNotMatch(lines[1], /空白/)
})

// ---- background 重選：blank 跟著 skip 從舊任務保回來 ----

const sender = { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0 }
const bgTask = (spec, over = {}) => ({
  id: 't1', name: '監控', url: 'https://a.test/p', mode: 'block', enabled: true,
  locator: { css: '#t', path: '', anchor: null, xpath: '' }, spec,
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

test('單值重選：舊任務的 skip.blank 保回來', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask(bgTask({ mode: 'block', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'max', skip: ON } }))
  await bg.handleMessage({ type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' }, picks: [colPick()] }, sender)
  const back = await st.getTask('t1')
  assert.deepEqual(back.spec.block.skip, ON)
})

test('多值重選：只設 blank 的舊任務，key 不變、每個值（含新加的）都保有 blank', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask(bgTask({
    mode: 'block',
    fields: [{ key: 'gold', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'max', skip: ON } }]
  }, { fields: [{ key: 'gold', name: '點金靈' }] }))
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [colPick(), { block: { axis: 'col', index: 2, headerText: 'TSWEB' } }]
  }, sender)
  const back = await st.getTask('t1')
  assert.equal(back.fields[0].key, 'gold', '空白設定不是值的身分，key 重生會切斷歷史序列')
  assert.equal(back.spec.fields.length, 2)
  for (const f of back.spec.fields) assert.deepEqual(f.block.skip, ON)
})
