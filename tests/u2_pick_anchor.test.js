// AF-14 批次 A-2：選取端原文照存；勾回既有的值（preselect）與擷取端共用同一份定位
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

// ---- 送出的 spec：原文照存，拿不拿它定位由擷取端決定 ----

test('A2-1 單列數值表選一格：列標題原文照存、索引正確', async () => {
  const { c, doc, win } = await enter(NUMERIC_PAGE, 't')
  const cell = doc.getElementById('n2')
  move(win, cell)
  click(win, cell)
  dbl(win, cell)
  const p = picks(c)
  assert.ok(Array.isArray(p) && p.length === 1, '要送出一個值')
  assert.equal(p[0].cell.row.header, '4318')
  assert.equal(p[0].cell.row.index, 0)
  assert.equal(p[0].cell.col.index, 1)
})

test('A2-2 文字型列標題照舊存進去', async () => {
  const { c, doc, win } = await enter(TEXT_PAGE, 't2')
  const cell = doc.getElementById('a1')
  move(win, cell)
  click(win, cell)
  dbl(win, cell)
  const p = picks(c)
  assert.equal(p[0].cell.row.header, '美金')
  assert.equal(p[0].cell.col.header, '買入')
})

test('A2-3 面板的已選 chip 要看得到那一格的原文（使用者要認得出自己選了什麼）', async () => {
  const { doc, win } = await enter(NUMERIC_PAGE, 't')
  const cell = doc.getElementById('n2')
  move(win, cell)
  click(win, cell)
  const panel = doc.querySelector('[data-af-panel]')
  assert.ok(panel.textContent.includes('4318'), `實際：${panel.textContent}`)
})

// ---- preselect 回選：與擷取端同一份定位（extract.js 的 locateByHeader）----

test('A2-4 舊任務存的純數值 header 已不在表上：回選時退回索引，不得把值丟掉', async () => {
  const preselect = [{ cell: { row: { index: 0, header: '4318' }, col: { index: 1, header: '' } } }]
  // 頁面上第一格今天已經是 4269
  const page = NUMERIC_PAGE.replace('4318', '4269')
  const { c, doc, win } = await enter(page, 't', { preselect })
  dbl(win, doc.getElementById('n2'))
  const p = picks(c)
  assert.equal(p.length, 1, '純數值 header 不見了不得讓既有的值被丟掉')
  assert.equal(p[0].cell.row.index, 0)
  assert.equal(p[0].cell.col.index, 1)
})

test('A2-5 純數值 header 唯一出現且位移：回選要跟著它走（與擷取端一致）', async () => {
  const page = `<table id="t"><tbody>
    <tr><td>9999</td><td>1</td></tr>
    <tr><td id="k">4318</td><td id="v">38605</td></tr>
  </tbody></table>`
  const preselect = [{ cell: { row: { index: 0, header: '4318' }, col: { index: 1, header: '' } } }]
  const { c, doc, win } = await enter(page, 't', { preselect })
  dbl(win, doc.getElementById('v'))
  const p = picks(c)
  assert.equal(p.length, 1)
  assert.equal(p[0].cell.row.index, 1, '4318 今天在第 1 列，勾回的要是那一列')
})

test('A2-6 純數值 header 在表上重複出現：回選退回索引，不得跳到別列', async () => {
  const page = `<table id="t"><tbody>
    <tr><td>0</td><td>10</td></tr><tr><td>0</td><td>20</td></tr><tr><td>5</td><td id="v">30</td></tr>
  </tbody></table>`
  const preselect = [{ cell: { row: { index: 2, header: '0' }, col: { index: 1, header: '' } } }]
  const { c, doc, win } = await enter(page, 't', { preselect })
  dbl(win, doc.getElementById('v'))
  const p = picks(c)
  assert.equal(p.length, 1)
  assert.equal(p[0].cell.row.index, 2)
})

test('A2-7 文字型 header 不見了仍然略過那個值（既有行為不變）', async () => {
  const preselect = [{ cell: { row: { index: 0, header: '英鎊' }, col: { index: 1, header: '買入' } } }]
  const { c, doc, win } = await enter(TEXT_PAGE, 't2', { preselect })
  dbl(win, doc.getElementById('a1'))
  const p = picks(c)
  // 雙擊 a1 會把它自己選進去；被略過的英鎊不會出現
  assert.ok(p.every(x => x.cell.row.header !== '英鎊'))
})

test('A2-8 連續選兩張表：第二張表的判定不得沿用第一張的狀態', async () => {
  const { c, doc, win, pm } = await enter(NUMERIC_PAGE + TEXT_PAGE, 't')
  const first = doc.getElementById('n2')
  move(win, first)
  click(win, first)
  dbl(win, first)
  assert.equal(picks(c)[0].cell.row.header, '4318')

  pm.exitPickMode()
  resetChromeMock()
  const c2 = installChromeMock()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t2') })
  const second = doc.getElementById('a1')
  move(win, second)
  click(win, second)
  dbl(win, second)
  const p2 = (c2.__calls
    .filter(x => x.api === 'runtime.sendMessage')
    .map(x => x.args[0])
    .find(m => m?.type === 'PICKED' && !m.cancelled) || {}).picks
  assert.ok(Array.isArray(p2) && p2.length === 1, `第二張表要送得出值，實得 ${JSON.stringify(p2)}`)
  assert.equal(p2[0].cell.row.header, '美金', '第二張表有真的列標題，不得被上一張的判定蓋掉')
})

test('A2-9 純數值 header 不見、退回的欄索引已超出表格寬度：那個值要被略過，不得加進一個指不到格子的已選項', async () => {
  // 舊任務存的是第 5 欄；今天這張表只有 2 欄、第一格也變了
  const preselect = [{ cell: { row: { index: 0, header: '4318' }, col: { index: 5, header: '9999' } } }]
  const page = NUMERIC_PAGE.replace('4318', '4269')
  const { c, doc, win } = await enter(page, 't', { preselect })
  dbl(win, doc.getElementById('n2'))
  const p = picks(c)
  assert.ok(Array.isArray(p) && p.length === 1, `只該有雙擊選進來的那一格，實得 ${JSON.stringify(p)}`)
  assert.equal(p[0].cell.col.index, 1)
})
