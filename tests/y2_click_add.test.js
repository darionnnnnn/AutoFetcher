// AF-18 批次 B-1：表格內點一下＝加選、再點＝取消；換表仍取代（已選 ≥2 要再點一次確認）；移除類動作留復原。
// 對照 docs/AF-18-PLAN.md 批次 B 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <table id="t">
    <thead><tr><th id="h0">幣別</th><th id="h1">買入</th><th id="h2">賣出</th></tr></thead>
    <tbody>
      <tr><th id="r0" scope="row">美金</th><td id="a1">31.2</td><td id="a2">31.8</td></tr>
      <tr><th id="r1" scope="row">日圓</th><td id="b1">0.21</td><td id="b2">0.22</td></tr>
      <tr><th id="r2" scope="row">歐元</th><td id="c1">33.5</td><td id="c2">34.1</td></tr>
    </tbody>
  </table>
  <table id="t2"><thead><tr><th>品項</th><th>數量</th></tr></thead>
    <tbody><tr><td>甲</td><td id="y1">7</td></tr><tr><td>乙</td><td id="y2">8</td></tr></tbody></table>`

async function boot(opts = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>測試頁</title></head><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t'), ...opts })
  return { c, doc, pm, win: jd.window }
}
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const move = (win, el) => fire(win, el, 'mousemove')
const click = (win, el, init) => fire(win, el, 'click', init)
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const pick = (win, el, init) => { move(win, el); click(win, el, init) }
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picked = (c) => sent(c).filter(m => m?.type === 'PICKED' && !m.cancelled)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const keys = (pm) => pm.selectedPicks().map(p => p.cell ? `${p.cell.row.index},${p.cell.col.index}` : `${p.block.axis}${p.block.index}`)
const undoBtn = (doc) => doc.querySelector('[data-af-undo]')

// ---------- 點一下＝加選、再點＝取消 ----------

test('B1-1 點 A、點 B → 兩個值；再點 A → 取消 A、B 還在', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b2'))
  assert.deepEqual(keys(pm), ['0,1', '1,2'], '點一下是加選')
  pick(win, doc.getElementById('a1'))
  assert.deepEqual(keys(pm), ['1,2'], '再點已選的＝取消')
  assert.match(panelText(doc), /點其他格可加選/, '指令句說出新的語意')
  pm.exitPickMode()
})

test('B1-2 Ctrl 點維持同義（不報錯、不另教學）', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'), { ctrlKey: true })
  pick(win, doc.getElementById('b1'), { ctrlKey: true })
  assert.equal(pm.selectedCount(), 2)
  pick(win, doc.getElementById('a1'), { ctrlKey: true })
  assert.deepEqual(keys(pm), ['1,1'])
  pm.exitPickMode()
})

test('B1-3 清單空時第一次點不長出復原鈕', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  assert.equal(undoBtn(doc).hidden, true)
  pm.exitPickMode()
})

// ---------- 換表 ----------

test('B1-4 已選 1 個時點另一張表：直接換表（取代），可復原且目標一起回去', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('y1'))
  assert.equal(pm.selectedCount(), 1)
  assert.equal(doc.getElementById('y1').hasAttribute('data-af-picked'), true, '換到第二張表')
  assert.equal(undoBtn(doc).hidden, false, '換表留一步反悔')
  key(doc, win, 'z', { ctrlKey: true })
  assert.deepEqual(keys(pm), ['0,1'])
  assert.equal(pm.currentTarget()?.id, 't')
  pm.exitPickMode()
})

test('B1-5 已選 3 個時點另一張表：第一次只提示、清單不變；再點同一格才換表', async () => {
  const { doc, pm, win } = await boot()
  for (const id of ['a1', 'b1', 'c1']) pick(win, doc.getElementById(id))
  assert.equal(pm.selectedCount(), 3, '前置')
  pick(win, doc.getElementById('y1'))
  assert.equal(pm.selectedCount(), 3, '誤點旁邊另一張表不得一次清光')
  assert.match(panelText(doc), /再點一次才會換到這張表（會取代 3 個已選值）/)
  pick(win, doc.getElementById('y1'))
  assert.equal(pm.selectedCount(), 1, '再點同一格才換')
  assert.equal(doc.getElementById('y1').hasAttribute('data-af-picked'), true)
  pm.exitPickMode()
})

test('B1-6 帶 3 個 preselect 進來點同表第 4 格：直接加選，不出現確認提示', async () => {
  const preselect = ['a1', 'b1', 'c1'].map((_, r) => ({ cell: { row: { index: r, header: ['美金', '日圓', '歐元'][r] }, col: { index: 1, header: '買入' } } }))
  const { doc, pm, win } = await boot({ purpose: 'repick', taskId: 'x', preselect })
  assert.equal(pm.selectedCount(), 3, '前置：勾回三個')
  pick(win, doc.getElementById('a2'))
  assert.equal(pm.selectedCount(), 4)
  assert.doesNotMatch(panelText(doc), /取代/)
  pm.exitPickMode()
})

// ---------- 雙擊：結果式 ----------

test('B1-7 雙擊一個沒選過的格：送出，而且 picks 含這一格（瀏覽器是 click、click、dblclick）', async () => {
  const { c, doc, win } = await boot()
  pick(win, doc.getElementById('a2'))
  const b1 = doc.getElementById('b1')
  move(win, b1); click(win, b1); click(win, b1); fire(win, b1, 'dblclick')
  const msg = picked(c)[0]
  assert.ok(msg, '送出')
  const got = msg.picks.map(p => `${p.cell.row.index},${p.cell.col.index}`)
  assert.ok(got.includes('1,1'), `雙擊的那一格一定在（實得 ${JSON.stringify(got)}）`)
  assert.ok(got.includes('0,2'), '原本選的也在')
})

test('B1-8 雙擊一個已選的格：送出，而且 picks 仍含這一格', async () => {
  const { c, doc, win } = await boot()
  const a1 = doc.getElementById('a1')
  pick(win, a1)
  click(win, a1); click(win, a1); fire(win, a1, 'dblclick')
  const msg = picked(c)[0]
  assert.ok(msg, '送出')
  assert.deepEqual(msg.picks.map(p => `${p.cell.row.index},${p.cell.col.index}`), ['0,1'])
})

// ---------- 移除類動作留復原 ----------

test('B1-9 選 A、B、C → 誤點 B 取消 → Ctrl+Z 回到 A、B、C（不是再刪掉 C）', async () => {
  const { doc, pm, win } = await boot()
  for (const id of ['a1', 'b1', 'c1']) pick(win, doc.getElementById(id))
  pick(win, doc.getElementById('b1'))
  assert.equal(pm.selectedCount(), 2, '前置：B 被取消')
  assert.equal(undoBtn(doc).hidden, false, '取消之後有復原鈕')
  key(doc, win, 'z', { ctrlKey: true })
  assert.deepEqual(keys(pm).sort(), ['0,1', '1,1', '2,1'])
  pm.exitPickMode()
})

test('B1-10 chip 的 × 也留復原', async () => {
  const { doc, pm, win } = await boot()
  for (const id of ['a1', 'b1', 'c1']) pick(win, doc.getElementById(id))
  click(win, doc.querySelector('[data-af-chip="1"] [data-af-chip-remove]'))
  assert.equal(pm.selectedCount(), 2, '前置')
  key(doc, win, 'z', { ctrlKey: true })
  assert.equal(pm.selectedCount(), 3)
  pm.exitPickMode()
})

test('B1-11 Backspace 移除最後一項也留復原；復原鈕同一條路', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Backspace')
  assert.equal(pm.selectedCount(), 1, '前置')
  click(win, undoBtn(doc))
  assert.deepEqual(keys(pm), ['0,1', '1,1'])
  pm.exitPickMode()
})

test('B1-12 Ctrl+A 之後 Ctrl+Z 回到全選前', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  key(doc, win, 'a', { ctrlKey: true })
  assert.equal(pm.selectedCount(), 6, '前置：全選 3×2 資料格')
  key(doc, win, 'z', { ctrlKey: true })
  assert.deepEqual(keys(pm), ['0,1'])
  pm.exitPickMode()
})

test('B1-13 連按 Ctrl+Z：選 A、B → 剩 A → 清空，B 不得復活（Ctrl+Z 自己的移除不存快照）', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'z', { ctrlKey: true })
  assert.deepEqual(keys(pm), ['0,1'])
  key(doc, win, 'z', { ctrlKey: true })
  assert.deepEqual(keys(pm), [], '連按兩次不得互相抵銷')
  pm.exitPickMode()
})

// ---------- 工具列「升級最後一格」 ----------

test('B1-14 已選 A1、B2 時點「整欄→一個值」：B2 換成它那一欄、A1 不動，面板說出換了哪一格', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b2'))
  click(win, tool(doc, 'col'))
  assert.deepEqual(keys(pm), ['0,1', 'col2'], '不得殘留 B2 單格')
  assert.match(panelText(doc), /換成「賣出」整欄，其他已選不變/)
  pm.exitPickMode()
})

test('體檢 B1-15 整欄已選後單格模式點同欄的格：加成獨立的值是允許的，但要說清楚（指令句說「點已選的可取消」）', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('b1'))
  click(win, tool(doc, 'col'))
  pick(win, doc.getElementById('b1'))
  click(win, tool(doc, 'cell'))
  pick(win, doc.getElementById('c1'))
  assert.deepEqual(keys(pm), ['col1', '2,1'])
  assert.match(panelText(doc), /這一格已經算在「.*」裡；現在另外加成獨立的一個值（再點一次取消）/)
  pick(win, doc.getElementById('c1'))
  assert.deepEqual(keys(pm), ['col1'], '再點一次取消')
  pm.exitPickMode()
})
