// AF-14 批次 A-2：選取端不把純數值標題存進 spec（草稿，等 A-1 驗收後搬進 tests/）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// 使用者實站那種表：單列、無表頭、第一格本身就是每天會變的數值
const NUMERIC_PAGE = `
  <table id="t" class="type2"><tbody>
    <tr align="center"><td id="n1" width="70">4318</td><td id="n2">38605</td></tr>
  </tbody></table>`

// 對照組：第一格是真正的標籤
const TEXT_PAGE = `
  <table id="t2">
    <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
    <tbody>
      <tr><td>美金</td><td id="a1">31.2</td><td id="a2">31.8</td></tr>
      <tr><td>日圓</td><td id="b1">0.21</td><td id="b2">0.22</td></tr>
    </tbody></table>`

async function enter(page, targetId, opts = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${page}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById(targetId), ...opts })
  return { c, doc, pm, win: jd.window }
}

const move = (win, el, init = {}) =>
  el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, ...init }))
const click = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }))
const dbl = (win, el) => el.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }))
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picks = (c) => (sent(c).find(m => m?.type === 'PICKED' && !m.cancelled) || {}).picks

// ---- 送出的 spec ----

test('A2-1 單列數值表選一格：送出的列標題是空字串，索引照舊正確', async () => {
  const { c, doc, win } = await enter(NUMERIC_PAGE, 't')
  const cell = doc.getElementById('n2')
  move(win, cell)
  click(win, cell)
  dbl(win, cell)
  const p = picks(c)
  assert.ok(Array.isArray(p) && p.length === 1, '要送出一個值')
  assert.equal(p[0].cell.row.header, '', '4318 是純數值，不得當錨點存進去')
  assert.equal(p[0].cell.row.index, 0)
  assert.equal(p[0].cell.col.index, 1)
})

test('A2-2 文字型列標題照舊存進去（本輪只改純數值那一類）', async () => {
  const { c, doc, win } = await enter(TEXT_PAGE, 't2')
  const cell = doc.getElementById('a1')
  move(win, cell)
  click(win, cell)
  dbl(win, cell)
  const p = picks(c)
  assert.equal(p[0].cell.row.header, '美金')
  assert.equal(p[0].cell.col.header, '買入')
})

test('A2-3 整列聚合的 headerText 是純數值時也不存', async () => {
  const { c, doc, win } = await enter(NUMERIC_PAGE, 't')
  click(win, tool(doc, 'row'))
  const cell = doc.getElementById('n2')
  move(win, cell)
  click(win, cell)
  dbl(win, cell)
  const p = picks(c)
  assert.equal(p[0].block.axis, 'row')
  assert.equal(p[0].block.headerText, '')
  assert.equal(p[0].block.index, 0)
})

test('A2-4 純數值的欄標題也不存', async () => {
  const page = `<table id="t3">
    <thead><tr><th>4318</th><th>4319</th></tr></thead>
    <tbody><tr><td id="x1">10</td><td id="x2">20</td></tr></tbody></table>`
  const { c, doc, win } = await enter(page, 't3')
  click(win, tool(doc, 'col'))
  const cell = doc.getElementById('x2')
  move(win, cell)
  click(win, cell)
  dbl(win, cell)
  const p = picks(c)
  assert.equal(p[0].block.headerText, '')
  assert.equal(p[0].block.index, 1)
})

// ---- preselect 回選與重存 ----

test('A2-5 帶 header:"" 的既有任務回選：勾得回同一格', async () => {
  const preselect = [{ cell: { row: { index: 0, header: '' }, col: { index: 1, header: '' } } }]
  const { c, doc, win } = await enter(NUMERIC_PAGE, 't', { preselect })
  dbl(win, doc.getElementById('n2'))
  const p = picks(c)
  assert.equal(p.length, 1, '既有的值要被勾回來，不能整個消失')
  assert.equal(p[0].cell.row.index, 0)
  assert.equal(p[0].cell.col.index, 1)
})

test('A2-6 回選後重存，不得把當下的數值第一格補回 header', async () => {
  const preselect = [{ cell: { row: { index: 0, header: '' }, col: { index: 1, header: '' } } }]
  const { c, doc, win } = await enter(NUMERIC_PAGE, 't', { preselect })
  dbl(win, doc.getElementById('n2'))
  assert.equal(picks(c)[0].cell.row.header, '', '重存又把 4318 塞回去的話，明天照樣壞')
})

test('A2-7 舊任務存的是純數值 header：回選時照樣找得到那一列', async () => {
  const preselect = [{ cell: { row: { index: 0, header: '4318' }, col: { index: 1, header: '' } } }]
  const { c, doc, win } = await enter(NUMERIC_PAGE, 't', { preselect })
  dbl(win, doc.getElementById('n2'))
  const p = picks(c)
  assert.equal(p.length, 1, '純數值 header 不得讓既有的值被丟掉')
  assert.equal(p[0].cell.row.header, '', '重存時要改成空的')
})

test('A2-8 送出的 picks 可以帶顯示用的原文，但那是唯一的例外欄位', async () => {
  const { c, doc, win } = await enter(NUMERIC_PAGE, 't')
  const cell = doc.getElementById('n2')
  move(win, cell)
  click(win, cell)
  dbl(win, cell)
  const p = picks(c)
  // 顯示端要看得到 4318（面板 chip、Picker 摘要卡）
  assert.equal(p[0].cell.row.rawHeader, '4318')
  // 但定位欄位必須是空的
  assert.equal(p[0].cell.row.header, '')
})
