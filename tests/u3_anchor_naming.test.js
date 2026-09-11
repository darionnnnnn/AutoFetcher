// AF-14 批次 A-3：命名鏈不用純數值標題、摘要卡當場說出「這個數字不一定是標題」、捷徑到定位下拉
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
// 使用者實站那張表：列標題是每天會變的數字，選取端原文照存
const NUMERIC_PICK = { cell: { row: { index: 0, header: '4318' }, col: { index: 1, header: '' } } }
const TEXT_PICK = { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } }
const summary = (doc, id) => doc.getElementById(id).textContent

// ---- describe.js：白話句只有一份 ----

test('A3-1 文字型標題：describeTarget 的輸出與既有行為一字不差', () => {
  const base = { url: 'https://a.test/p', mode: 'block', cell: TEXT_PICK.cell }
  assert.equal(describeTarget(base), '抓 a.test 的表格，取「美金 · 買入」這一格')
})

test('A3-2 純數值列標題：句子要說出那個數字、它不一定是標題、以及解法', () => {
  const text = describeTarget({ url: 'https://a.test/p', mode: 'block', cell: NUMERIC_PICK.cell })
  assert.ok(text.includes('4318'), `要說出使用者在畫面上看得到的那個值，實際：${text}`)
  assert.ok(text.includes('不一定是標題'), text)
  assert.ok(text.includes('列定位'), `要指向解法，實際：${text}`)
})

test('A3-3 欄那一側是純數值時說的是欄與欄定位', () => {
  const text = describeTarget({
    url: 'https://a.test/p', mode: 'block',
    cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '2025' } }
  })
  assert.ok(text.includes('2025'), text)
  assert.ok(text.includes('欄定位'), `欄是數字就不能叫使用者去改列定位，實際：${text}`)
})

test('A3-4 整欄聚合的 headerText 是純數值時也提示', () => {
  const text = describeTarget({
    url: 'https://a.test/p', mode: 'block',
    block: { axis: 'col', index: 1, headerText: '2025', aggregate: 'sum' }
  })
  assert.ok(text.includes('2025') && text.includes('欄定位'), text)
})

// ---- Picker 摘要卡與捷徑 ----

test('A3-5 摘要卡把這句話顯示出來，並給到得了定位下拉的入口', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [NUMERIC_PICK] })
  pk.updateSetupSummary()
  const text = summary(doc, 'summary-target')
  assert.ok(text.includes('4318') && text.includes('列定位'), `摘要卡要說出來，實際：${text}`)
  const btn = doc.getElementById('goto-rowpos')
  assert.equal(btn.hidden, false)
  assert.equal(btn.dataset.target, 'row-pos')
  assert.ok(btn.textContent.includes('列定位'), btn.textContent)
  // 真的把焦點送過去（下拉在「抓什麼」區，不是進階區）
  pk.focusPositionSelect(btn.dataset.target)
  assert.equal(doc.activeElement?.id, 'row-pos')
})

test('A3-6 一般表格不出現這句話也不出現入口', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [TEXT_PICK] })
  pk.updateSetupSummary()
  assert.ok(!summary(doc, 'summary-target').includes('不一定是標題'))
  assert.equal(doc.getElementById('goto-rowpos').hidden, true)
})

test('A3-7 欄那一側是純數值時，入口指向欄定位', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR, url: 'https://rate.test/x',
    picks: [{ cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '2025' } } }]
  })
  pk.updateSetupSummary()
  const btn = doc.getElementById('goto-rowpos')
  assert.equal(btn.dataset.target, 'col-pos')
  assert.ok(btn.textContent.includes('欄定位'), btn.textContent)
})

// ---- 命名鏈 ----

test('A3-8 純數值標題不進預設任務名稱，退回 nameHint', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', nameHint: '成交統計', picks: [NUMERIC_PICK] })
  const name = doc.getElementById('name').value
  assert.ok(!name.includes('4318'), `4318 是明天就會變的數字，不該變成任務名字，實際：${name}`)
  assert.equal(name, '成交統計')
})

test('A3-9 文字型標題照舊當名稱', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', nameHint: '匯率', picks: [TEXT_PICK] })
  assert.equal(doc.getElementById('name').value, '買入')
})

test('A3-10 規格原文照存：不因為命名不用它就把 header 洗掉（擷取端還要靠它判斷唯一出現）', async () => {
  const { pk } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x', picks: [NUMERIC_PICK] })
  const spec = pk.buildSpec(pk.getFormData())
  assert.equal(spec.block.cell.row.header, '4318')
})
