// AF-14 批次 A-3：命名鏈退回下一層、摘要卡當場說出「這裡沒有標題可用」、rawHeader 不得進規格
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { describeTarget } from '../src/shared/describe.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]' }
// 使用者實站那張表：列標題是每天會變的數字，選取端已把 header 存成空字串、原文放 rawHeader
const NUMERIC_PICK = {
  cell: {
    row: { index: 0, header: '', rawHeader: '4318' },
    col: { index: 1, header: '' }
  }
}
const TEXT_PICK = { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } }
const summary = (doc, id) => doc.getElementById(id).textContent

// ---- describe.js：白話句只有一份 ----

test('A3-1 沒有 rawHeader 時，describeTarget 的輸出與既有行為一字不差', () => {
  const base = { url: 'https://a.test/p', mode: 'block', cell: TEXT_PICK.cell }
  assert.equal(describeTarget(base), '抓 a.test 的表格，取「美金 · 買入」這一格')
})

test('A3-2 帶 rawHeader 時，句子要說出那個數字、不能當標題、以及解法', () => {
  const text = describeTarget({
    url: 'https://a.test/p', mode: 'block', cell: NUMERIC_PICK.cell, rawHeader: '4318'
  })
  assert.ok(text.includes('4318'), `要說出使用者在畫面上看得到的那個值，實際：${text}`)
  assert.ok(text.includes('標題'), `要說出它不能當標題，實際：${text}`)
  assert.ok(text.includes('列定位'), `要指向解法，實際：${text}`)
})

test('A3-3 欄那一側被擋下時說的是欄與欄定位', () => {
  const text = describeTarget({
    url: 'https://a.test/p', mode: 'block',
    cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '', rawHeader: '4319' } },
    rawHeader: '4319', rawHeaderAxis: 'col'
  })
  assert.ok(text.includes('4319'), text)
  assert.ok(text.includes('欄定位'), `欄被擋下就不能叫使用者去改列定位，實際：${text}`)
})

// ---- Picker 摘要卡 ----

test('A3-4 摘要卡把這句話顯示出來', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [NUMERIC_PICK] })
  pk.updateSetupSummary()
  const text = summary(doc, 'summary-target')
  assert.ok(text.includes('4318'), `摘要卡要說出來，實際：${text}`)
  assert.ok(text.includes('列定位'), text)
})

test('A3-5 一般表格不得出現這句話', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [TEXT_PICK] })
  pk.updateSetupSummary()
  const text = summary(doc, 'summary-target')
  assert.ok(!text.includes('不能當標題'), `沒有問題的表格不該被加一句話嚇人，實際：${text}`)
})

// ---- rawHeader 不得進規格 ----

test('A3-6 rawHeader 只是顯示用，不得寫進任務規格', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [NUMERIC_PICK] })
  const values = pk.getFormData()
  const spec = pk.buildSpec(values)
  const json = JSON.stringify(spec)
  assert.ok(!json.includes('rawHeader'), `規格會被存進 storage 並參與比對，不能夾帶顯示用欄位：${json}`)
  assert.ok(!json.includes('4318'), `那個數字本身也不能漏進規格，否則下一輪又被當成錨點：${json}`)
})

// ---- 命名鏈 ----

test('A3-7 純數值標題不進預設任務名稱，退回 nameHint', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR, url: 'https://rate.test/x', nameHint: '成交統計',
    picks: [{ cell: { row: { index: 0, header: '4318' }, col: { index: 1, header: '' } } }]
  })
  const name = doc.getElementById('name').value
  assert.ok(!name.includes('4318'), `4318 是明天就會變的數字，不該變成任務名字，實際：${name}`)
  assert.equal(name, '成交統計')
})

test('A3-8 文字型標題照舊當名稱', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', nameHint: '匯率', picks: [TEXT_PICK] })
  assert.equal(doc.getElementById('name').value, '買入')
})

// ---- 選取面板的已選 chip（A-2 之後 header 是空的，chip 不能因此變成沒有內容的「儲存格」）----

test('A3-9 已選 chip 仍要看得到原本那格的文字', async () => {
  const { JSDOM: JD } = await import('jsdom')
  const { installChromeMock: mock, resetChromeMock: reset } = await import('./chrome-mock.js')
  reset(); mock()
  const jd = new JD(`<!doctype html><html><body>
    <table id="t"><tbody><tr><td id="n1">4318</td><td id="n2">38605</td></tr></tbody></table>
  </body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  const cell = doc.getElementById('n2')
  cell.dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new jd.window.MouseEvent('click', { bubbles: true }))
  const panel = doc.querySelector('[data-af-panel]')
  assert.ok(panel.textContent.includes('4318'),
    `使用者要能從面板認出自己選了哪一格，實際：${panel.textContent}`)
})

test('A3-10 說了「請改用列定位」就要讓使用者到得了那個下拉', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [NUMERIC_PICK] })
  pk.updateSetupSummary()
  const btn = doc.getElementById('goto-rowpos')
  assert.ok(btn, '要有到得了那個下拉的入口')
  assert.equal(btn.hidden, false)
  assert.equal(btn.dataset.target, 'row-pos')
  assert.ok(btn.textContent.includes('列定位'), btn.textContent)

  // 真的把焦點送過去（下拉在「抓什麼」區，不是進階區）
  pk.focusPositionSelect(btn.dataset.target)
  assert.equal(doc.activeElement?.id, 'row-pos')
})

test('A3-11 一般表格不出現這個入口', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [TEXT_PICK] })
  pk.updateSetupSummary()
  assert.equal(doc.getElementById('goto-rowpos').hidden, true)
})

test('A3-12 欄那一側被擋下時，入口指向欄定位', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    url: 'https://rate.test/x',
    picks: [{ cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '', rawHeader: '4319' } } }]
  })
  pk.updateSetupSummary()
  const btn = doc.getElementById('goto-rowpos')
  assert.equal(btn.dataset.target, 'col-pos')
  assert.ok(btn.textContent.includes('欄定位'), btn.textContent)
})
