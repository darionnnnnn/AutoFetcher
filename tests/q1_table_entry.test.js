// AF-8 批次 A：表格模式進入規則（滑鼠停在格子上即進入該表格的表格模式）
// 對照 docs/AF-8-PLAN.md 批次 A 的驗收。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// 一般表格
const FLAT = `
  <h2>市場成交資訊</h2>
  <table id="t">
    <thead><tr><th>日期</th><th>成交股數</th><th>成交金額</th></tr></thead>
    <tbody>
      <tr><td>115/09/01</td><td id="a1">13000</td><td id="a2"><span id="a2s">1187571</span></td></tr>
      <tr><td>115/09/02</td><td id="b1">10824</td><td id="b2">976499</td></tr>
    </tbody>
  </table>`

// 巢狀：外層每一列的第二格各包一張小表
const NESTED = `
  <table id="outer">
    <tbody>
      <tr>
        <td id="oc1">15.122</td>
        <td id="oc2"><table id="inner"><tbody><tr><td id="i1">25757</td><td id="i2">39806</td></tr></tbody></table></td>
      </tr>
      <tr>
        <td id="oc3">15.131</td>
        <td id="oc4"><table id="inner2"><tbody><tr><td id="j1">25530</td><td id="j2">39806</td></tr></tbody></table></td>
      </tr>
    </tbody>
  </table>`

async function boot(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>測試頁</title></head><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, pm, win: jd.window }
}

const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
const click = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }))
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picked = (c) => sent(c).filter(m => m?.type === 'PICKED' && !m.cancelled)
const tools = (doc) => Array.from(doc.querySelectorAll('[data-af-tool]'))
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''

// ---------- A-1 滑鼠停在格子上就是表格模式 ----------

test('A-1 滑鼠移到 td 上即進入表格模式，工具列可用', async () => {
  const { doc, pm, win } = await boot(FLAT)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a2'))
  const disabled = tools(doc).filter(el => el.getAttribute('aria-disabled') === 'true')
  assert.equal(disabled.length, 0, `滑鼠在格子上時三段都要能點，實得停用 ${disabled.length} 段`)
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 1, '待選標記落在那一格')
  assert.equal(doc.getElementById('a2').hasAttribute('data-af-cell'), true, '標的是滑鼠下的那一格')
  assert.equal(pm.currentAxis(), 'col', '表格模式的 currentAxis 不得是 null')
  pm.exitPickMode()
})

test('A-1 送出的規格是那一格的列欄索引，且帶 nameHint', async () => {
  const { c, doc, pm, win } = await boot(FLAT)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('b2'))
  key(doc, win, 'Enter')
  const msgs = picked(c)
  assert.equal(msgs.length, 1, '確認要送出一則 PICKED')
  const cell = msgs[0].picks?.[0]?.cell
  assert.ok(cell, `要是儲存格規格，實得 ${JSON.stringify(msgs[0].picks)}`)
  assert.equal(cell.row.index, 1, '第二個資料列')
  assert.equal(cell.col.index, 2, '第三欄')
  assert.equal(cell.col.header, '成交金額', `欄標題要對，實得 ${cell.col.header}`)
  assert.equal(msgs[0].nameHint, '市場成交資訊', `表格模式要帶 nameHint，實得 ${msgs[0].nameHint}`)
  pm.exitPickMode()
})

test('A-1 滑鼠停在格子內的 span 上也算那一格', async () => {
  const { doc, pm, win } = await boot(FLAT)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a2s'))
  assert.equal(doc.getElementById('a2').hasAttribute('data-af-cell'), true, '標記要落在祖先儲存格上')
  assert.equal(tools(doc).filter(el => el.getAttribute('aria-disabled') === 'true').length, 0)
  pm.exitPickMode()
})

test('A-1 右鍵預選的元素是格子時，一進入就是表格模式', async () => {
  const { doc, pm } = await boot(FLAT)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('a1') })
  assert.equal(tools(doc).filter(el => el.getAttribute('aria-disabled') === 'true').length, 0,
    '右鍵在格子上進來就該是表格模式')
  pm.exitPickMode()
})

// ---------- A-2 巢狀表格 ----------

test('A-2 滑鼠移到內層表格的格子時，目標是內層表格', async () => {
  const { c, doc, pm, win } = await boot(NESTED)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('outer') })
  move(win, doc.getElementById('i2'))
  assert.equal(doc.getElementById('i2').hasAttribute('data-af-cell'), true, '標記要落在內層那一格')
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg.picks[0].cell.col.index, 1, '內層表格的第二欄')
  assert.equal(msg.preview, '39806', `預覽是那一格的文字，實得 ${JSON.stringify(msg.preview)}`)
  pm.exitPickMode()
})

test('A-2 從內層表格按 ↑ 回到外層表格，↓ 回內層', async () => {
  const { c, doc, pm, win } = await boot(NESTED)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('outer') })
  move(win, doc.getElementById('i1'))
  key(doc, win, 'ArrowUp')
  move(win, doc.getElementById('oc1'))
  key(doc, win, 'Enter')
  let msg = picked(c)[0]
  assert.equal(msg.preview, '15.122', `↑ 之後要能選到外層那一格，實得 ${JSON.stringify(msg.preview)}`)
  pm.exitPickMode()

  const b = await boot(NESTED)
  b.pm.enterPickMode({ purpose: 'task', initialTarget: b.doc.getElementById('outer') })
  move(b.win, b.doc.getElementById('i1'))
  key(b.doc, b.win, 'ArrowUp')
  key(b.doc, b.win, 'ArrowDown')
  move(b.win, b.doc.getElementById('i2'))
  key(b.doc, b.win, 'Enter')
  msg = picked(b.c)[0]
  assert.equal(msg.preview, '39806', '↓ 要回到內層表格')
  b.pm.exitPickMode()
})

test('A-2 已選了外層表格的值之後，移到內層格子不換表', async () => {
  const { c, doc, pm, win } = await boot(NESTED)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('outer') })
  move(win, doc.getElementById('oc1'))
  click(win, doc.getElementById('oc1'), { shiftKey: true })
  move(win, doc.getElementById('i1'))
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg.picks.length, 1, '已選的那一個值')
  assert.equal(msg.picks[0].cell.col.index, 0, '仍是外層表格的第一欄，不是內層的')
  pm.exitPickMode()
})

// ---------- A-3 用途分流 ----------

test('A-3 前置動作用途不升級目標，仍指向原始元素', async () => {
  const { doc, pm, win } = await boot(FLAT)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  assert.equal(tools(doc).every(el => el.getAttribute('aria-disabled') === 'true'), true,
    '前置動作要點的是那個元素本身，不是表格')
  assert.ok(/非表格/.test(panelText(doc)), '面板要說明為什麼點不動')
  pm.exitPickMode()
})

// ---------- A-4 不殘留 ----------

test('A-4 連續兩次選取不沿用上一張表的狀態', async () => {
  const { c, doc, pm, win } = await boot(NESTED)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('outer') })
  move(win, doc.getElementById('i1'))
  pm.exitPickMode()

  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('outer') })
  move(win, doc.getElementById('oc3'))
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg.picks.length, 1)
  assert.equal(msg.picks[0].cell.row.index, 1, '第二次選的是外層第二列')
  assert.equal(msg.picks[0].cell.col.index, 0)
  pm.exitPickMode()
})
