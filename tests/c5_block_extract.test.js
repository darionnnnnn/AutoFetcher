// AF-3 批次 C:block 模式的端到端擷取與紀錄欄位
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { extractValue } from '../src/shared/extract.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

function el(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  return dom.window.document.body.firstElementChild
}

const TABLE = `<table>
  <thead><tr><th>日期</th><th>數量</th><th>金額</th></tr></thead>
  <tbody>
    <tr><td>09-01</td><td>10</td><td>1,000</td></tr>
    <tr><td>09-02</td><td>32</td><td>3,200</td></tr>
    <tr><td>09-03</td><td>7</td><td>700</td></tr>
  </tbody></table>`

const blockSpec = (over = {}) => ({
  mode: 'block',
  block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum', ...over }
})

// ---- extract 的 block 分支 ----

test('取某一欄加總', () => {
  const r = extractValue(el(TABLE), blockSpec())
  assert.equal(r.ok, true)
  assert.equal(r.value, 49)
  assert.equal(r.status, 'ok')
  assert.equal(r.strategyUsed, 'block')
})

test('取某一列加總(不含表頭那格)', () => {
  const r = extractValue(el(TABLE), blockSpec({ axis: 'row', index: 1, headerText: '09-02' }))
  assert.equal(r.ok, true)
  assert.equal(r.value, 3232, '32 + 3200;日期那格解析不出來要跳過')
  assert.equal(r.skipped, 1)
})

test('其他聚合方式', () => {
  assert.equal(extractValue(el(TABLE), blockSpec({ aggregate: 'max' })).value, 32)
  assert.equal(extractValue(el(TABLE), blockSpec({ aggregate: 'min' })).value, 7)
  assert.equal(extractValue(el(TABLE), blockSpec({ aggregate: 'count' })).value, 3)
})

test('表頭漂移:索引位置的表頭變了,改用表頭文字找回來並標 fallback', () => {
  const moved = `<table>
    <thead><tr><th>日期</th><th>金額</th><th>數量</th></tr></thead>
    <tbody><tr><td>09-01</td><td>1,000</td><td>10</td></tr>
           <tr><td>09-02</td><td>3,200</td><td>32</td></tr></tbody></table>`
  const r = extractValue(el(moved), blockSpec())
  assert.equal(r.ok, true)
  assert.equal(r.value, 42, '「數量」欄搬到第 3 欄了,要跟著走')
  assert.equal(r.status, 'fallback', '靠表頭文字救回來的要標 fallback')
})

test('表頭整個消失時回 not_found,不要默默抓錯欄', () => {
  const gone = `<table>
    <thead><tr><th>日期</th><th>金額</th></tr></thead>
    <tbody><tr><td>09-01</td><td>1,000</td></tr></tbody></table>`
  const r = extractValue(el(gone), blockSpec())
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
})

test('整欄都解析不出數字時回 parse_error', () => {
  const t = `<table><thead><tr><th>備註</th></tr></thead>
    <tbody><tr><td>N/A</td></tr><tr><td>—</td></tr></tbody></table>`
  const r = extractValue(el(t), { mode: 'block', block: { axis: 'col', index: 0, headerText: '備註', aggregate: 'sum' } })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'parse_error')
})

test('沒有表頭的表格用索引取,照樣可以', () => {
  const t = '<table><tr><td>1</td><td>10</td></tr><tr><td>2</td><td>32</td></tr></table>'
  const r = extractValue(el(t), { mode: 'block', block: { axis: 'col', index: 1, headerText: '', aggregate: 'sum' } })
  assert.equal(r.value, 42)
  assert.equal(r.status, 'ok')
})

test('index 超出範圍時回 not_found', () => {
  const r = extractValue(el(TABLE), blockSpec({ index: 9, headerText: '' }))
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
})

test('虛擬捲動的表格要回報 partial', () => {
  const container = el(`<div role="grid">
    <div role="row"><span role="columnheader">量</span></div>
    <div role="row"><span role="cell">10</span></div>
    <div role="row"><span role="cell">32</span></div></div>`)
  Object.defineProperty(container, 'scrollHeight', { value: 900, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
  const r = extractValue(container, { mode: 'block', block: { axis: 'col', index: 0, headerText: '量', aggregate: 'sum' } })
  assert.equal(r.ok, true)
  assert.equal(r.value, 42)
  assert.equal(r.partial, true)
})

test('block 模式不走數值策略鏈(strategy 一律被忽略)', () => {
  const r = extractValue(el(TABLE), { ...blockSpec(), strategy: 'regex', regex: '(\\d+)' })
  assert.equal(r.value, 49, '不得被 regex 策略影響')
  assert.equal(r.strategyUsed, 'block')
})

// ---- fetcher 把 partial / skipped / used 寫進紀錄 ----

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, fe }
}

const task = (over = {}) => ({
  id: 't1', name: '每日數量', url: 'https://a.test/p', mode: 'block', enabled: true,
  locator: { css: '#t', path: '', anchor: null, xpath: '' },
  spec: blockSpec(),
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

test('partial 的擷取結果:紀錄留 partial,健康燈號轉黃', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder(() => ({
    ok: true, value: 42, raw: '10,32', status: 'ok', strategyUsed: 'block',
    layer: 'css', partial: true, skipped: 1, used: 2
  }))
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.status, 'ok', '抓到值就是成功')
  assert.equal(rec.partial, true)
  assert.equal(rec.skipped, 1)
  assert.equal(rec.used, 2)
  const health = await st.getHealthMap()
  assert.equal(health.t1?.status, 'partial', '只抓到一部分要讓使用者知道')
})

test('沒有 partial 時紀錄不得多出這些鍵', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 49, raw: '', status: 'ok', strategyUsed: 'block', layer: 'css', used: 3, skipped: 0 }))
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.partial, undefined)
  assert.equal(rec.used, 3)
})

// ---- 報表顯示 ----

test('歷史頁的狀態篩選要涵蓋所有真的會產生的狀態', async () => {
  resetChromeMock()
  installChromeMock()
  const { readFileSync } = await import('node:fs')
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  await rp.renderFilters()
  const keys = [...jd.window.document.querySelectorAll('#filter-statuses input[type="checkbox"]')].map(cb => cb.value)
  for (const k of ['ok', 'fallback', 'late', 'not_found', 'parse_error', 'login_failed', 'error']) {
    assert.ok(keys.includes(k), `狀態篩選缺少 ${k}(實際會寫出這個狀態卻篩不到),實得 ${keys.join(',')}`)
  }
})

test('歷史列的策略欄對 block 模式要說明取了哪一欄與聚合方式', async () => {
  resetChromeMock()
  installChromeMock()
  const { readFileSync } = await import('node:fs')
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  rp.renderTable([{
    taskId: 't1', slot: '2026-09-06T09:00', capturedAt: '2026-09-06T09:00:05+08:00',
    value: 49, status: 'ok', strategyUsed: 'block', used: 3, skipped: 1, partial: true
  }])
  const row = jd.window.document.querySelector('#record-table tbody tr:not(.detail)')
  row.click()
  const detail = jd.window.document.querySelector('#record-table tbody tr.detail')
  assert.ok(detail, '要能展開細節')
  const text = detail.textContent
  assert.ok(text.includes('3'), `要看得到用了幾格,實得:${text}`)
  assert.ok(/略過|skipped/.test(text), `要看得到跳過幾格,實得:${text}`)
  assert.ok(/部分|partial/.test(text), `partial 要讓使用者知道只抓到一部分,實得:${text}`)
})

// ---- 端到端:Picker 存出來的任務,擷取時要真的走 block ----

test('Picker 建立的區塊任務,拿去擷取要得到聚合值(不是整張表的第一個數字)', async () => {
  resetChromeMock()
  installChromeMock()
  const { readFileSync } = await import('node:fs')
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())

  const task = pk.buildTask(
    { name: '每日數量', url: 'https://a.test/p', mode: 'block', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6],
      block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum' } },
    { css: '#t', path: '', anchor: null, xpath: '' }
  )
  // 這一步是重點:直接把 buildTask 產出的 spec 交給擷取,不自己補欄位
  const r = extractValue(el(TABLE), task.spec)
  assert.equal(r.strategyUsed, 'block', `任務存出來的 spec 必須走 block 分支,實得 ${r.strategyUsed}`)
  assert.equal(r.value, 49)
})
