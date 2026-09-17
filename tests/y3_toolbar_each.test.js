// AF-18 批次 B-2：工具列第四段「整欄→每格」（colEach），與右鍵「這一欄：每格各一個值」共用同一份。
// 對照 docs/AF-18-PLAN.md 批次 B 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
const PAGE = `
  <table id="t">
    <thead><tr><th id="h0">幣別</th><th id="h1">買入</th><th id="h2">賣出</th></tr></thead>
    <tbody>
      <tr><th id="r0" scope="row">美金</th><td id="a1">31.2</td><td id="a2">31.8</td></tr>
      <tr><th id="r1" scope="row">日圓</th><td id="b1">0.21</td><td id="b2">0.22</td></tr>
      <tr><th id="r2" scope="row">歐元</th><td id="c1">33.5</td><td id="c2">34.1</td></tr>
    </tbody>
  </table>`

async function boot(html, opts = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>測試頁</title></head><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body, ...opts })
  return { c, doc, pm, win: jd.window }
}
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const move = (win, el) => fire(win, el, 'mousemove')
const click = (win, el, init) => fire(win, el, 'click', init)
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const pick = (win, el, init) => { move(win, el); click(win, el, init) }
const tools = (doc) => Array.from(doc.querySelectorAll('[data-af-tool]'))
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picked = (c) => sent(c).filter(m => m?.type === 'PICKED' && !m.cancelled)
const keys = (pm) => pm.selectedPicks().map(p => p.cell ? `${p.cell.row.index},${p.cell.col.index}` : `${p.block.axis}${p.block.index}`)
const small1 = (doc, id = 'his_31') => doc.getElementById(id).closest('tr').children[0]

// 選 colEach：先讓目標變成表格（滑鼠移到格子上）再點工具列
function toEach(doc, win, cell) {
  move(win, cell)
  click(win, tool(doc, 'colEach'))
  assert.equal(tool(doc, 'colEach').hasAttribute('data-af-active'), true, '前置：切到整欄→每格')
}

test('B2-1 工具列四段，鍵名與標籤', async () => {
  const { doc, pm } = await boot(PAGE)
  assert.deepEqual(tools(doc).map(t => t.getAttribute('data-af-tool')), ['cell', 'col', 'colEach', 'row'])
  assert.deepEqual(tools(doc).map(t => t.textContent.trim()), ['單格', '整欄→一個值', '整欄→每格', '整列→一個值'])
  for (const t of tools(doc)) assert.ok(t.getAttribute('title'), `${t.textContent} 要有 title 說明`)
  assert.equal(doc.querySelector('[data-af-toolbar]').style.flexWrap, 'wrap', '窄視窗換行，不得超出畫面')
  pm.exitPickMode()
})

test('B2-2 Tab 在四段之間循環', async () => {
  const { doc, pm, win } = await boot(PAGE)
  move(win, doc.getElementById('a1'))
  const active = () => doc.querySelector('[data-af-tool][data-af-active]')?.getAttribute('data-af-tool')
  const seen = [active()]
  for (let i = 0; i < 4; i++) { key(doc, win, 'Tab'); seen.push(active()) }
  assert.deepEqual(seen, ['cell', 'col', 'colEach', 'row', 'cell'])
  pm.exitPickMode()
})

test('B2-3 整欄→每格點一格：該欄每一格各一個值，去頭去尾鈕出現；currentAxis 是 col', async () => {
  const { doc, pm, win } = await boot(PAGE)
  toEach(doc, win, doc.getElementById('b1'))
  assert.equal(pm.currentAxis(), 'col')
  click(win, doc.getElementById('b1'))
  assert.deepEqual(keys(pm), ['0,1', '1,1', '2,1'])
  assert.equal(doc.querySelector('[data-af-trim-head]').hidden, false)
  pm.exitPickMode()
})

test('B2-4 再點同一欄任一格：整組移除', async () => {
  const { doc, pm, win } = await boot(PAGE)
  toEach(doc, win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  assert.equal(pm.selectedCount(), 3, '前置')
  pick(win, doc.getElementById('c1'))
  assert.equal(pm.selectedCount(), 0)
  pm.exitPickMode()
})

test('B2-5 已有其中 1 格時點：補齊、不重複', async () => {
  const { doc, pm, win } = await boot(PAGE)
  pick(win, doc.getElementById('a1'))
  key(doc, win, 'Tab'); key(doc, win, 'Tab')
  assert.equal(tool(doc, 'colEach').hasAttribute('data-af-active'), true, '前置：用 Tab 切模式（不升級）')
  pick(win, doc.getElementById('c1'))
  assert.deepEqual(keys(pm).sort(), ['0,1', '1,1', '2,1'])
  pm.exitPickMode()
})

test('B2-6 上限截斷要說明', async () => {
  const { doc, pm, win } = await boot(PAGE, { maxPicks: 2 })
  toEach(doc, win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  assert.equal(pm.selectedCount(), 2)
  assert.match(panelText(doc), /上限/)
  pm.exitPickMode()
})

test('B2-7 點表頭列的格：同一欄整組切換（此模式不建立聚合值）', async () => {
  const { doc, pm, win } = await boot(PAGE)
  toEach(doc, win, doc.getElementById('b1'))
  pick(win, doc.getElementById('h2'))
  assert.deepEqual(keys(pm), ['0,2', '1,2', '2,2'])
  pm.exitPickMode()
})

test('B2-8 已選最後一項是單格時點「整欄→每格」：展開成該欄每格，可復原', async () => {
  const { doc, pm, win } = await boot(PAGE)
  pick(win, doc.getElementById('b1'))
  click(win, tool(doc, 'colEach'))
  assert.deepEqual(keys(pm).sort(), ['0,1', '1,1', '2,1'])
  key(doc, win, 'z', { ctrlKey: true })
  assert.deepEqual(keys(pm), ['1,1'])
  pm.exitPickMode()
})

test('B2-9 清單空時 Enter：送出該欄每一格', async () => {
  const { c, doc, pm, win } = await boot(PAGE)
  toEach(doc, win, doc.getElementById('b1'))
  move(win, doc.getElementById('b1'))
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg?.picks?.length, 3, JSON.stringify(msg?.picks))
  assert.ok(msg.picks.every(p => p.cell && p.cell.col.index === 1))
  pm.exitPickMode()
})

test('B2-10 與右鍵「這一欄：每格各一個值」產生的清單完全相同（同一份邏輯）', async () => {
  const a = await boot(PAGE)
  toEach(a.doc, a.win, a.doc.getElementById('b1'))
  click(a.win, a.doc.getElementById('b1'))
  const viaTool = JSON.stringify(a.pm.selectedPicks())
  a.pm.exitPickMode()

  const b = await boot(PAGE)
  move(b.win, b.doc.getElementById('b1'))
  fire(b.win, b.doc.getElementById('b1'), 'contextmenu')
  click(b.win, b.doc.querySelector('[data-af-menu-item="col-each"]'))
  assert.equal(JSON.stringify(b.pm.selectedPicks()), viaTool)
  b.pm.exitPickMode()
})

test('B2-11 監控頁：單列小表上「整欄→每格」＝外層每一列各一個帶路徑的值（與右鍵同）', async () => {
  const a = await boot(MONITOR)
  toEach(a.doc, a.win, small1(a.doc))
  move(a.win, small1(a.doc))
  click(a.win, small1(a.doc))
  const picks = a.pm.selectedPicks()
  assert.equal(picks.length, 6, JSON.stringify(picks))
  assert.ok(picks.every(p => p.cell.col.index === 2 && p.cell.inner?.length === 4))
  assert.equal(new Set(picks.map(p => p.cell.row.index)).size, 6)
  const viaTool = JSON.stringify(picks)
  a.pm.exitPickMode()

  const b = await boot(MONITOR)
  move(b.win, small1(b.doc))
  fire(b.win, small1(b.doc), 'contextmenu')
  click(b.win, b.doc.querySelector('[data-af-menu-item="col-each"]'))
  assert.equal(JSON.stringify(b.pm.selectedPicks()), viaTool)
  b.pm.exitPickMode()
})

test('B2-12 前置動作用途：整欄→每格停用，點了要說原因', async () => {
  const { doc, pm, win } = await boot(PAGE, { purpose: 'preaction' })
  move(win, doc.getElementById('b1'))
  assert.equal(tool(doc, 'colEach').getAttribute('aria-disabled'), 'true')
  click(win, tool(doc, 'colEach'))
  assert.match(panelText(doc), /一次只選一個/)
  pm.exitPickMode()
})

test('體檢 B2-13 上限截斷之後再點同一欄：整組取消（不然再也點不掉）；提示的格數是實際選到的', async () => {
  const { doc, pm, win } = await boot(MONITOR, { maxPicks: 3 })
  toEach(doc, win, small1(doc))
  fire(win, small1(doc), 'mousemove')
  click(win, small1(doc))
  assert.equal(pm.selectedCount(), 3, '前置：外層這一欄 6 格，被上限截到 3')
  assert.match(panelText(doc), /同一個位置（3 格）/, `說的是選到的格數：${panelText(doc).slice(0, 120)}`)
  fire(win, small1(doc), 'mousemove')
  click(win, small1(doc))
  assert.equal(pm.selectedCount(), 0)
  pm.exitPickMode()
})
