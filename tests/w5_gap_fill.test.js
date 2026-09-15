// AF-16 規劃比對補缺口：任務頁與 popup 的描述句、Picker 儲存摘要的略過說明、預覽的黃字警告
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { describeTarget, targetOfTask, exclusionOfTarget } from '../src/shared/describe.js'

const TOTAL = { index: 3, header: '合計' }
const blockTask = (over = {}) => ({
  id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block', enabled: true,
  locator: { css: '#t', path: '', anchor: null, xpath: '' },
  spec: { mode: 'block', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: { head: 0, tail: 1 }, exclude: [TOTAL] } },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})
const multiTask = () => blockTask({
  fields: [{ key: 'g', name: '點金靈' }, { key: 'w', name: 'TSWEB' }],
  spec: {
    mode: 'block',
    fields: [
      { key: 'g', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: { head: 0, tail: 1 } } },
      { key: 'w', block: { axis: 'col', index: 2, headerText: 'TSWEB', aggregate: 'sum', skip: { head: 0, tail: 1 } } }
    ]
  }
})

// ---- describe.js：已存任務轉描述輸入（任務頁與 popup 共用） ----

test('targetOfTask：單值整欄帶出 block；排除片段與 describeTarget 句中那一段一字不差', () => {
  const target = targetOfTask(blockTask())
  assert.equal(target.mode, 'block')
  assert.equal(target.block.headerText, '點金靈')
  const piece = exclusionOfTarget(target)
  assert.equal(piece, '，略過結尾 1 列、排除 1 列')
  assert.ok(describeTarget(target).includes(piece), '兩處各組一份就會長得不一樣')
})

test('targetOfTask：整欄的 pos 是列定位——有位置就是取那一格，不說略過排除', () => {
  const t = blockTask()
  t.spec.block.pos = 'last'
  const target = targetOfTask(t)
  assert.equal(target.rowPos, 'last')
  assert.equal(exclusionOfTarget(target), '')
})

test('targetOfTask：多值取第一個值、帶值的數量，單位是「筆」且只說略過', () => {
  const target = targetOfTask(multiTask())
  assert.equal(target.fieldCount, 2)
  assert.equal(exclusionOfTarget(target), '，略過結尾 1 筆')
})

test('targetOfTask：多值任務第一個值是儲存格、第二個是帶略過的整欄——略過說明不得消失', () => {
  const t = multiTask()
  t.spec.fields.unshift({ key: 'c', cell: { row: { index: 0, header: '10.0.0.1' }, col: { index: 1, header: '點金靈' } } })
  t.fields.unshift({ key: 'c', name: '第一台' })
  const target = targetOfTask(t)
  assert.equal(target.fieldCount, 3)
  assert.equal(exclusionOfTarget(target), '，略過結尾 1 筆')
})

test('targetOfTask：數值任務與儲存格任務沒有排除片段', () => {
  assert.equal(exclusionOfTarget(targetOfTask({ id: 'n', url: 'https://a.test', mode: 'number', spec: { strategy: 'auto' } })), '')
  assert.equal(exclusionOfTarget(targetOfTask(blockTask({ spec: { mode: 'block', block: { cell: { row: { index: 0, header: 'a' }, col: { index: 1, header: 'b' } } } } }))), '')
})

// ---- 任務頁 ----

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
async function tasksPage() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(reportHtml, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  return { ts, doc: jd.window.document }
}

test('任務頁：區塊任務的模式欄看得出略過與排除，title 是完整白話句', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([blockTask()], {}, [])
  const el = doc.querySelector('[data-task-id="t1"] .task-mode')
  assert.ok(el, '沒有模式欄的話下面的斷言會真空成立')
  assert.match(el.textContent, /點金靈/, '原本的欄名與聚合方式要留著')
  assert.match(el.textContent, /略過結尾 1 列、排除 1 列/)
  assert.equal(el.title, describeTarget(targetOfTask(blockTask())))
})

test('任務頁：多值任務也說出任務層級的略過', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([multiTask()], {}, [])
  assert.match(doc.querySelector('[data-task-id="t1"] .task-mode').textContent, /略過結尾 1 筆/)
})

// ---- popup ----

const popupHtml = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
test('popup：任務名稱的 title 是抓什麼的白話句，含略過與排除', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(popupHtml)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  pp.render({ health: { level: 'green', redCount: 0, yellowCount: 0, summary: '一切正常' }, tasks: [blockTask()], lastValues: {}, nextRuns: {}, healthMap: {} })
  const name = jd.window.document.querySelector('#task-list .task-name')
  assert.ok(name, '沒有任務列的話下面的斷言會真空成立')
  assert.match(name.title, /略過結尾 1 列、排除 1 列/)
  // 與任務頁同一條守門：數值任務不設（句子沒有新資訊）
  pp.render({ health: { level: 'green', redCount: 0, yellowCount: 0, summary: '一切正常' }, tasks: [{ id: 'n', name: '電費', url: 'https://a.test', mode: 'number', spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:00'] } }], lastValues: {}, nextRuns: {}, healthMap: {} })
  assert.equal(jd.window.document.querySelector('#task-list .task-name').title, '')
})

// ---- Picker：儲存摘要與預覽警告 ----

const pickerHtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
async function picker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(pickerHtml)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, pk, doc: jd.window.document }
}
const ctxFor = (picks, over = {}) => ({
  locator: { css: '#mon', path: '', anchor: null, xpath: '' }, url: 'https://mon.test/p', nameHint: '監控',
  blockInfo: { kind: 'table', rows: 4, cols: 3, headers: ['主機', '點金靈', 'TSWEB'] }, picks, ...over
})
const col = (index, headerText, over = {}) => ({ block: { axis: 'col', index, headerText, ...over } })
const change = (doc, id, v) => {
  doc.getElementById(id).value = String(v)
  doc.getElementById(id).dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
}

test('儲存摘要：改了略過設定當下就說出來；藏起來（改用位置定位）時不說', async () => {
  const { pk, doc } = await picker()
  pk.render(ctxFor([col(1, '點金靈'), col(2, 'TSWEB')]))
  const summary = doc.getElementById('save-summary')
  assert.equal(summary.textContent, '將建立 1 個任務、2 個值', '前提：沒有略過時一字不差')
  change(doc, 'skip-tail', 1)
  assert.equal(summary.textContent, '將建立 1 個任務、2 個值，略過結尾 1 列')
  change(doc, 'row-pos', 'last')
  assert.equal(summary.textContent, '將建立 1 個任務、2 個值', '有位置就是取那一格，看不見的設定不能說成會生效')
})

test('預覽：單值排除項找不到——預覽與提示行都是警告色，不是成功的綠', async () => {
  const { c, pk, doc } = await picker()
  pk.render(ctxFor([col(1, '點金靈', { exclude: [TOTAL] })], { tabId: 5 }))
  c.__setRuntimeResponder(() => ({ ok: true, value: 300, raw: '53, 49, 48, 150', status: 'fallback', strategyUsed: 'block', used: 4, skipped: 0, message: '有 1 個排除項在目前的頁面找不到（合計）' }))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('preview').dataset.state, 'warn')
  assert.equal(doc.getElementById('test-note').dataset.state, 'warn')
  assert.match(doc.getElementById('test-note').textContent, /找不到（合計）/)
})

test('預覽：沒有排除訊息時照舊是 ok，提示行不帶警告狀態（下一次測試不得殘留）', async () => {
  const { c, pk, doc } = await picker()
  pk.render(ctxFor([col(1, '點金靈', { exclude: [TOTAL] })], { tabId: 5 }))
  c.__setRuntimeResponder(() => ({ ok: true, value: 300, raw: '1', status: 'fallback', strategyUsed: 'block', used: 4, skipped: 0, message: '有 1 個排除項在目前的頁面找不到（合計）' }))
  await pk.handleTestNow()
  c.__setRuntimeResponder(() => ({ ok: true, value: 150, raw: '1', status: 'ok', strategyUsed: 'block', used: 3, skipped: 0, excluded: 1 }))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('preview').dataset.state, 'ok')
  assert.equal('state' in doc.getElementById('test-note').dataset, false)
})

test('預覽：多值有一個值排除項找不到——預覽是警告色', async () => {
  const { c, pk, doc } = await picker()
  pk.render(ctxFor([col(1, '點金靈', { exclude: [TOTAL] }), col(2, 'TSWEB')], { tabId: 5 }))
  const keys = [...doc.querySelectorAll('#field-list [data-field-row]')].map(r => r.dataset.fieldKey)
  c.__setRuntimeResponder(() => ({
    ok: true,
    fields: {
      [keys[0]]: { ok: true, value: 300, raw: '1', status: 'fallback', used: 4, skipped: 0, message: '有 1 個排除項在目前的頁面找不到（合計）' },
      [keys[1]]: { ok: true, value: 1275, raw: '1', status: 'ok', used: 3, skipped: 0 }
    }
  }))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('preview').dataset.state, 'warn')
})

test('picker.html 有警告狀態的樣式，而且只用色彩變數', () => {
  assert.match(pickerHtml, /#preview\[data-state="warn"\]\s*\{[^}]*var\(--warn\)/)
  assert.match(pickerHtml, /#test-note\[data-state="warn"\]\s*\{[^}]*var\(--warn\)/)
})
