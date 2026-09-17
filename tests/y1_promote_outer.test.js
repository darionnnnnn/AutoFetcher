// AF-18 批次 A：巢狀表格的已選值無損升到外層（P1、P2、P4 的根因）。
// 對照 docs/AF-18-PLAN.md 批次 A 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { extractValue } from '../src/shared/extract.js'
import { resolve } from '../src/shared/selector.js'

// 使用者實站的監控頁：外層每一列的第 3 格各包一張 1×2 小表
const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
// 從外層那一格走到小表第 1 格（42）的完整路徑
const PATH_TO_1ST = [
  { tag: 'table', index: 1 }, { tag: 'tbody', index: 1 }, { tag: 'tr', index: 1 }, { tag: 'td', index: 1 }
]

async function boot(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>監控</title></head><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, pm, win: jd.window }
}
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const move = (win, el) => fire(win, el, 'mousemove')
const click = (win, el, init) => fire(win, el, 'click', init)
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const picked = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  .filter(m => m?.type === 'PICKED' && !m.cancelled)
const texts = (doc, attr) => Array.from(doc.querySelectorAll(`[${attr}]`)).map(e => e.textContent.trim())

const outerOf = (doc) => doc.querySelector('table')
// 小表第 1 格（42／43／41…），依那一列 span 的 id 找
const small1 = (doc, id = 'his_31') => doc.getElementById(id).closest('tr').children[0]
const smallOf = (doc, id = 'his_31') => doc.getElementById(id).closest('table')
// 外層那一列的「時間」格
const timeTd = (doc, id = 'his_31') => smallOf(doc, id).closest('td').parentElement.children[3]
const MONITOR_COL = ['42', '43', '41', '41', '40', '3610']

// 小表上選好 42（單格），前置狀態斷言完才回傳
async function picked42() {
  const b = await boot(MONITOR)
  b.pm.enterPickMode({ purpose: 'task', initialTarget: b.doc.body })
  move(b.win, small1(b.doc))
  click(b.win, small1(b.doc))
  assert.equal(b.pm.currentTarget(), smallOf(b.doc), '前置：預設目標是內層小表（既有規則不變）')
  assert.equal(b.pm.selectedCount(), 1, '前置：選到 42')
  assert.deepEqual(b.pm.selectedPicks()[0].cell.col.index, 0, '前置：選的是小表座標')
  return b
}

// ---------- 觸發 3：已選之後按 ↑ ----------

test('A1 小表已選 42 → ↑ → 滑鼠移回 42：目標仍是外層表，值換成外層座標＋完整路徑，藍框仍在 42', async () => {
  const { doc, pm, win } = await picked42()
  key(doc, win, 'ArrowUp')
  assert.equal(pm.currentTarget(), outerOf(doc), '↑ 換到外層表')
  move(win, small1(doc))
  assert.equal(pm.currentTarget(), outerOf(doc), '已選之後按 ↑ 是明確意圖：滑鼠一動不得被拉回小表（P1 根因）')
  const [p] = pm.selectedPicks()
  assert.equal(pm.selectedCount(), 1)
  assert.equal(p.cell.row.index, 2, `外層第 3 列（實得 ${JSON.stringify(p)}）`)
  assert.equal(p.cell.col.index, 2)
  assert.deepEqual(p.cell.inner, PATH_TO_1ST)
  assert.deepEqual(texts(doc, 'data-af-picked'), ['42'], '藍框仍在 42')
  pm.exitPickMode()
})

test('A2 ↑／↓ 之後不移動滑鼠，hover 標示立刻重畫', async () => {
  const { doc, pm, win } = await boot(MONITOR)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, small1(doc))
  assert.deepEqual(texts(doc, 'data-af-cell'), ['42'], '前置：單格模式標 42')
  key(doc, win, 'ArrowUp')
  assert.equal(pm.currentTarget(), outerOf(doc), '前置：↑ 到外層')
  assert.deepEqual(texts(doc, 'data-af-cell'), ['42'], '↑ 之後不必等滑鼠移動，標示立刻畫回停留的那一格（以前是空的，看起來像沒反應）')
  key(doc, win, 'ArrowDown')
  assert.deepEqual(texts(doc, 'data-af-cell'), ['42'], '↓ 同一條規則')
  pm.exitPickMode()
})

// ---------- 觸發 1：單列小表上要整欄 ----------

test('A3 單格選 42 → 工具列「整欄」→ 外層整欄＋路徑，藍框 6 格（P2）', async () => {
  const { doc, pm, win } = await picked42()
  click(win, tool(doc, 'col'))
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 1, JSON.stringify(picks))
  assert.equal(picks[0].block?.axis, 'col')
  assert.equal(picks[0].block.index, 2, '外層第 3 欄')
  assert.deepEqual(picks[0].block.inner, PATH_TO_1ST)
  assert.deepEqual(texts(doc, 'data-af-picked'), MONITOR_COL)
  assert.match(panelText(doc), /已改選外層表這一欄的同一個位置（6 格）/)
  pm.exitPickMode()
})

test('A4 整欄模式不按 ↑ 直接點 42：點之前 hover 就是外層 6 格，點下去得到外層整欄；舊提示「請按 ↑」不再出現', async () => {
  const { doc, pm, win } = await boot(MONITOR)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, small1(doc))
  click(win, tool(doc, 'col'))
  move(win, small1(doc))
  assert.deepEqual(texts(doc, 'data-af-cell'), MONITOR_COL, '畫面框到的＝點下去會選到的')
  click(win, small1(doc))
  const [p] = pm.selectedPicks()
  assert.equal(p?.block?.index, 2, JSON.stringify(pm.selectedPicks()))
  assert.deepEqual(p.block.inner, PATH_TO_1ST)
  assert.match(panelText(doc), /已改選外層表這一欄/)
  assert.doesNotMatch(panelText(doc), /要跨外層每一列請按 ↑/)
  pm.exitPickMode()
})

// ---------- 觸發 2：跨到同一張外層表的別處 ----------

test('A5 小表已選 42 → Ctrl 點第 5 列小表的 41 → 兩個值都是外層座標，不擋', async () => {
  const { doc, pm, win } = await picked42()
  move(win, small1(doc, 'his_33'))
  click(win, small1(doc, 'his_33'), { ctrlKey: true })
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 2, `實得 ${JSON.stringify(picks)}；面板：${panelText(doc).slice(0, 120)}`)
  assert.deepEqual(picks.map(p => p.cell.row.index), [2, 4])
  assert.deepEqual(picks.map(p => p.cell.col.index), [2, 2])
  for (const p of picks) assert.deepEqual(p.cell.inner, PATH_TO_1ST)
  assert.doesNotMatch(panelText(doc), /一個任務只能抓同一張表格/)
  assert.deepEqual(texts(doc, 'data-af-picked'), ['42', '41'])
  pm.exitPickMode()
})

test('A6 小表已選 42 → 滑鼠移到別列的小表：藍框仍在 42、不得跑到 41（已選標記畫錯表）', async () => {
  const { doc, pm, win } = await picked42()
  move(win, small1(doc, 'his_33'))
  assert.equal(small1(doc).hasAttribute('data-af-picked'), true, '42 仍是已選')
  assert.equal(small1(doc, 'his_33').hasAttribute('data-af-picked'), false, '41 沒有被選')
  pm.exitPickMode()
})

test('A7 小表已選 42 → Ctrl 點同一列外層的「時間」格 → 升級後的 42 加上外層單格（無路徑）', async () => {
  const { doc, pm, win } = await picked42()
  move(win, timeTd(doc))
  assert.equal(pm.currentTarget(), outerOf(doc), '指到外層自己的格子時，目標指向外層表')
  click(win, timeTd(doc), { ctrlKey: true })
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 2, JSON.stringify(picks))
  assert.deepEqual(picks[0].cell.inner, PATH_TO_1ST)
  assert.equal(picks[1].cell.row.index, 2)
  assert.equal(picks[1].cell.col.index, 3)
  assert.equal(picks[1].cell.inner, undefined, '外層的普通格不帶路徑')
  pm.exitPickMode()
})

test('A8 升級＋加選之後 Ctrl+Z：一步回到升級前（清單、目標、已選那張表一起回去）', async () => {
  const { doc, pm, win } = await picked42()
  move(win, small1(doc, 'his_33'))
  click(win, small1(doc, 'his_33'), { ctrlKey: true })
  assert.equal(pm.selectedCount(), 2, '前置：升級並加選')
  key(doc, win, 'z', { ctrlKey: true })
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 1, JSON.stringify(picks))
  assert.equal(picks[0].cell.col.index, 0, '回到小表座標')
  assert.equal(picks[0].cell.inner, undefined)
  assert.equal(pm.currentTarget(), smallOf(doc), '目標回到小表')
  assert.deepEqual(texts(doc, 'data-af-picked'), ['42'])
  pm.exitPickMode()
})

// ---------- 反例：換算不了、不該升級 ----------

// 每一列各包一張 2×2 小表（同型、重複）：外層可升級，但小表的整欄值有 2 列，換算不了
const MULTI = `<table id="mo"><tbody>
  <tr><td>A</td><td><table id="m1"><tbody><tr><td id="m1a">1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></td></tr>
  <tr><td>B</td><td><table id="m2"><tbody><tr><td id="m2a">5</td><td>6</td></tr><tr><td>7</td><td>8</td></tr></tbody></table></td></tr>
  <tr><td>C</td><td><table id="m3"><tbody><tr><td>9</td><td>10</td></tr><tr><td>11</td><td>12</td></tr></tbody></table></td></tr>
</tbody></table>`

test('A9 反例：多列小表的整欄值 → ↑ 照樣離開（AF-10 C-5），但值不升、說原因、清單不變（全有或全無）', async () => {
  const { doc, pm, win } = await boot(MULTI)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('m1a'))
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('m1a'))
  click(win, doc.getElementById('m1a'))
  const before = JSON.stringify(pm.selectedPicks())
  assert.equal(pm.selectedPicks()[0]?.block?.axis, 'col', `前置：小表整欄值（${before}）`)
  key(doc, win, 'ArrowUp')
  assert.equal(pm.currentTarget(), doc.getElementById('mo'), '↑ 是明確意圖，照樣到外層')
  assert.equal(JSON.stringify(pm.selectedPicks()), before, '清單不變')
  assert.match(panelText(doc), /換不到外層表/)
  pm.exitPickMode()
})

test('A10 反例：repick 用途不升級（值的 key 會重生、歷史接不上）；↑ 照樣離開但值不動，Ctrl 點別列被擋，都要說原因', async () => {
  const { doc, pm, win } = await boot(MONITOR)
  pm.enterPickMode({
    purpose: 'repick', taskId: 't1', initialTarget: smallOf(doc),
    preselect: [{ cell: { row: { index: 0, header: '42' }, col: { index: 0, header: '' } } }]
  })
  assert.equal(pm.selectedCount(), 1, '前置：preselect 勾回 42')
  key(doc, win, 'ArrowUp')
  assert.equal(pm.currentTarget(), outerOf(doc), '↑ 照樣到外層（AF-10 C-5）')
  assert.equal(pm.selectedPicks()[0].cell.inner, undefined, '但值不升')
  assert.match(panelText(doc), /重選既有任務時不能換到外層表/)
  move(win, small1(doc, 'his_33'))
  click(win, small1(doc, 'his_33'), { ctrlKey: true })
  assert.equal(pm.selectedCount(), 1, 'repick 不升級、不混進別張表的索引')
  assert.equal(pm.selectedPicks()[0].cell.inner, undefined)
  assert.match(panelText(doc), /重選既有任務時不能換到外層表/)
  pm.exitPickMode()
})

test('A11 已升級之後按 ↓：目標不變、說原因（不得「換了、滑鼠一動又回來」）', async () => {
  const { doc, pm, win } = await picked42()
  key(doc, win, 'ArrowUp')
  assert.equal(pm.selectedPicks()[0].cell.inner?.length, 4, '前置：已升級')
  key(doc, win, 'ArrowDown')
  assert.equal(pm.currentTarget(), outerOf(doc))
  assert.match(panelText(doc), /已選的值在外層表/)
  pm.exitPickMode()
})

// 版面表格：同一列兩格各放一張資料表（並排）
const SIDE = `<table id="lay"><tbody><tr>
  <td><table id="ta"><tbody><tr><td id="ta1">1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></td>
  <td><table id="tb"><tbody><tr><td id="tb1">5</td><td>6</td></tr><tr><td>7</td><td>8</td></tr></tbody></table></td>
</tr></tbody></table>`

test('A11d 版面表格（不可升級）：已選後 ↑ 到外層，滑鼠一動仍留在外層、值不動（P1 對版面表同樣成立）', async () => {
  const { doc, pm, win } = await boot(SIDE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('ta1'))
  click(win, doc.getElementById('ta1'))
  key(doc, win, 'ArrowUp')
  assert.equal(pm.currentTarget(), doc.getElementById('lay'), '前置：↑ 到版面表')
  move(win, doc.getElementById('ta1'))
  assert.equal(pm.currentTarget(), doc.getElementById('lay'), '滑鼠一動不得被拉回甲表')
  assert.equal(pm.selectedPicks()[0].cell.inner, undefined)
  assert.match(panelText(doc), /已選的值留在原表/)
  pm.exitPickMode()
})

test('A11a 反例（並排版面表）：甲表已選 → 點乙表 → 走換表規則，不產生外層座標', async () => {
  const { doc, pm, win } = await boot(SIDE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('ta1'))
  click(win, doc.getElementById('ta1'))
  assert.equal(pm.selectedCount(), 1, '前置')
  move(win, doc.getElementById('tb1'))
  click(win, doc.getElementById('tb1'))
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 1, JSON.stringify(picks))
  assert.equal(picks[0].cell.inner, undefined, '不得升到版面表')
  assert.equal(pm.currentTarget(), doc.getElementById('tb'), '換到乙表')
  pm.exitPickMode()
})

// 版面表格：同一欄上下疊一張單列摘要表與一張多列資料表（不同型）
const STACK = `<table id="lay2"><tbody>
  <tr><td><table id="sum"><tbody><tr><td id="s1">100</td><td>200</td><td>300</td></tr></tbody></table></td></tr>
  <tr><td><table id="big"><thead><tr><th>日期</th><th>值</th></tr></thead><tbody>
    <tr><td id="b1">09-01</td><td>7</td></tr><tr><td>09-02</td><td>8</td></tr><tr><td>09-03</td><td>9</td></tr>
  </tbody></table></td></tr>
</tbody></table>`

test('A11b 反例（疊放不同型）：摘要表上整欄模式點格 → 不升級，只框摘要表那 1 格、下面那張表不得被框', async () => {
  const { doc, pm, win } = await boot(STACK)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('s1'))
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('s1'))
  assert.deepEqual(texts(doc, 'data-af-cell'), ['100'], 'hover 只框摘要表那 1 格')
  click(win, doc.getElementById('s1'))
  const [p] = pm.selectedPicks()
  assert.equal(p?.block?.axis, 'col', JSON.stringify(pm.selectedPicks()))
  assert.equal(p.block.inner, undefined, '不得升到版面表')
  assert.equal(p.block.index, 0)
  assert.deepEqual(texts(doc, 'data-af-picked'), ['100'])
  assert.match(panelText(doc), /只有 1 列/, '原提示句照舊')
  pm.exitPickMode()
})

test('A11c 連續選兩次：可升級的判定不得沿用上一輪（頁面變了就要重算）', async () => {
  const { c, doc, pm, win } = await picked42()
  click(win, tool(doc, 'col'))
  assert.equal(pm.selectedPicks()[0].block?.inner?.length, 4, '前置：第一輪升級成外層整欄')
  key(doc, win, 'Enter')
  assert.equal(picked(c).length, 1, '前置：第一輪送出')
  // 頁面重畫：別列的小表不見了，只剩第一列那一張——外層不再是「每列重複同一種小表」
  for (const id of ['his_32', 'his_33', 'his_121', 'his_122']) smallOf(doc, id).remove()
  const last = Array.from(outerOf(doc).querySelectorAll('table')).find(t => t.textContent.includes('3610'))
  last.remove()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, small1(doc))
  click(win, small1(doc))
  click(win, tool(doc, 'col'))
  const [p] = pm.selectedPicks()
  assert.equal(p?.block?.inner, undefined, `第二輪不得沿用上一輪的「可升級」（實得 ${JSON.stringify(p)}）`)
  pm.exitPickMode()
})

// ---------- 送出：選取端到擷取端 ----------

test('A12 升級後送出：locator 指向外層表、picks 為外層座標，擷取到的格數＝畫面藍框數', async () => {
  const { c, doc, pm, win } = await picked42()
  click(win, tool(doc, 'col'))
  assert.equal(texts(doc, 'data-af-picked').length, 6, '前置：畫面框 6 格')
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.ok(msg, '有送出')
  assert.equal(resolve(doc, msg.locator).el, outerOf(doc), 'locator 指向外層表')
  assert.equal(msg.picks.length, 1)
  const block = msg.picks[0].block
  assert.deepEqual(block.inner, PATH_TO_1ST)
  const res = extractValue(outerOf(doc), { mode: 'block', block: { ...block, aggregate: 'sum' } })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.used, 6, '擷取端用到的格數與選取端框到的一樣')
  pm.exitPickMode()
})
