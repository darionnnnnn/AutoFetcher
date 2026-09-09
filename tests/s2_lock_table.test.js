// AF-10 作業 C：已選就鎖表——滑鼠移出表格不再讓工具列反灰，換表要「點」不要「移」。
// 對照 docs/AF-10-PLAN.md 作業 C 的驗收。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// 兩張不相干的表 + 一段非表格文字（模擬「滑鼠往右上角工具列移動時經過的頁面內容」）
const TWO_TABLES = `
  <table id="ta">
    <thead><tr><th>日期</th><th id="ha">成交金額</th></tr></thead>
    <tbody>
      <tr><td>09/01</td><td id="a1">1187571</td></tr>
      <tr><td>09/02</td><td id="a2">976499</td></tr>
    </tbody>
  </table>
  <p id="gap">這裡不是表格，只是滑鼠經過的地方</p>
  <table id="tb">
    <thead><tr><th>幣別</th><th>買入</th></tr></thead>
    <tbody><tr><td>美金</td><td id="b1">31.5</td></tr></tbody>
  </table>`

// 巢狀：同一張表的內層小表（點它不算換表）
const NESTED = `
  <table id="outer"><tbody>
    <tr><td id="o1">15.122</td><td id="o2"><table id="inner"><tbody><tr><td id="i1">25757</td></tr></tbody></table></td></tr>
    <tr><td id="o3">15.131</td><td id="o4">99</td></tr>
  </tbody></table>`

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
const tools = (doc) => Array.from(doc.querySelectorAll('[data-af-tool]'))
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const disabledCount = (doc) => tools(doc).filter(el => el.getAttribute('aria-disabled') === 'true').length
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picked = (c) => sent(c).filter(m => m?.type === 'PICKED' && !m.cancelled)

// ---------- C-1 已選之後，滑鼠移到表格外不得讓工具列反灰 ----------

test('C-1 已選一格後滑鼠移到非表格區域，目標仍鎖在那張表', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  assert.equal(pm.selectedCount(), 1, '前置：要先選到一格')

  move(win, doc.getElementById('gap'))
  assert.equal(pm.currentTarget()?.id, 'ta',
    `已選之後滑鼠經過非表格區域不得換目標，實得 ${pm.currentTarget()?.id}`)
  assert.equal(disabledCount(doc), 0,
    '工具列三段都要維持可用，否則使用者走不到右上角改模式')
  pm.exitPickMode()
})

test('C-1 移出表格後仍可用工具列把已選那一格改成整欄', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('gap'))
  click(win, tool(doc, 'col'))
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 1)
  assert.ok(picks[0].block, `最後一項要升級成整欄，實得 ${JSON.stringify(picks[0])}`)
  assert.equal(picks[0].block.axis, 'col')
  pm.exitPickMode()
})

test('C-1 已選之後移到表格外，hover 標示不得被清掉', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('gap'))
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 1,
    '已選的藍框要留著')
  pm.exitPickMode()
})

// ---------- C-2 換表要「點」不要「移」 ----------

test('C-2 滑鼠移到另一張表格不清空已選', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('b1'))
  assert.equal(pm.selectedCount(), 1,
    '只是滑鼠刮過另一張表，不該把整批已選丟掉')
  pm.exitPickMode()
})

test('C-2 點另一張表的格子才換表，而且留一步反悔', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  assert.equal(pm.selectedCount(), 1, '換表是取代，不是累加')
  assert.equal(doc.getElementById('b1').hasAttribute('data-af-picked'), true, '新表那一格要標記')
  const undoBtn = doc.querySelector('[data-af-undo]')
  assert.ok(undoBtn && !undoBtn.hasAttribute('hidden'), '換表要有復原鈕')
  pm.exitPickMode()
})

test('C-2 換表後 Ctrl+Z 要連目標一起還原回上一張表', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  key(doc, win, 'z', { ctrlKey: true })
  assert.equal(pm.selectedCount(), 1)
  assert.equal(doc.getElementById('a1').hasAttribute('data-af-picked'), true,
    '要還原成上一張表的那一格')
  assert.equal(pm.currentTarget()?.id, 'ta',
    `目標也要跟著回到舊表，否則接下來的索引會配上新表的定位，實得 ${pm.currentTarget()?.id}`)
  pm.exitPickMode()
})

test('C-2 Ctrl 點另一張表的格子不加選，並說出原因', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'), { ctrlKey: true })
  assert.equal(pm.selectedCount(), 1, '跨表不能加選（兩張表的索引配不到同一個定位）')
  assert.equal(doc.getElementById('a1').hasAttribute('data-af-picked'), true, '原本那一格要留著')
  assert.ok(/另一張表|同一張表/.test(panelText(doc)),
    `要說出為什麼沒加選，實得：${panelText(doc).slice(0, 120)}`)
  pm.exitPickMode()
})

test('C-2 反例：點同一張表的巢狀內層格不算換表', async () => {
  const { doc, pm, win } = await boot(NESTED)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('o1'))
  click(win, doc.getElementById('o1'))
  const before = pm.currentTarget()?.id
  move(win, doc.getElementById('i1'))
  assert.equal(pm.currentTarget()?.id, before, '巢狀內外層是同一張表的事，不是換表')
  assert.equal(pm.selectedCount(), 1)
  pm.exitPickMode()
})

test('C-2 反例：點表格的縫隙什麼都不做', async () => {
  const { c, doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  click(win, doc.getElementById('ta'))
  assert.equal(pm.selectedCount(), 1, '點在格子之間不得改變已選')
  assert.equal(picked(c).length, 0, '點縫隙不得送出')
  pm.exitPickMode()
})

// ---------- C-3 整欄／整列模式不得落在非表格元素上 ----------

test('C-3 整欄模式下點非表格元素不鎖定、不送出，並說明只能在表格上選', async () => {
  const { c, doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('gap'))
  click(win, doc.getElementById('gap'))
  assert.ok(!/已鎖定/.test(panelText(doc)),
    `整欄模式下不該把非表格元素鎖定（鎖了滑鼠就再也移不動），實得：${panelText(doc).slice(0, 150)}`)
  key(doc, win, 'Enter')
  assert.equal(picked(c).length, 0,
    '整欄模式送出一個非表格元素等於把使用者選的模式靜靜丟掉')
  assert.ok(/整欄|整列/.test(panelText(doc)) && /表格/.test(panelText(doc)),
    `要說出整欄只能在表格上選，實得：${panelText(doc).slice(0, 150)}`)
  pm.exitPickMode()
})

test('C-3 單格模式下同一個非表格元素仍可鎖定並送出', async () => {
  const { c, doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('gap'))
  click(win, doc.getElementById('gap'))
  key(doc, win, 'Enter')
  assert.equal(picked(c).length, 1, '單格模式抓整個元素是既有行為，不得被守門擋掉')
  pm.exitPickMode()
})

// ---------- C-4 pendingMode 兌現要與直接點一致 ----------

test('C-4 在非表格上點整欄記住意圖，回到表格後最後一項也要升級成整欄', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('gap') })
  // 先在表格上選一格，再回到非表格點整欄（此時工具列因為鎖表仍可用，
  // 所以改由「還沒選任何值」的路徑觸發 pendingMode）
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  const picks = pm.selectedPicks()
  assert.ok(picks[0]?.block, `兌現後選到的要是整欄，實得 ${JSON.stringify(picks[0])}`)
  pm.exitPickMode()
})

test('C-4 點「單格」段要取消先前記住的整欄意圖', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('gap') })
  click(win, tool(doc, 'col'))
  click(win, tool(doc, 'cell'))
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  const picks = pm.selectedPicks()
  assert.ok(picks[0]?.cell, `取消意圖後應選到單格，實得 ${JSON.stringify(picks[0])}`)
  pm.exitPickMode()
})

// ---------- C-5 鍵盤 ↑↓ 是明確意圖，不受鎖表限制 ----------

test('C-5 已選之後按 ↑ 仍可離開這張表', async () => {
  const { doc, pm, win } = await boot(NESTED)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('i1'))
  click(win, doc.getElementById('i1'))
  const inner = pm.currentTarget()?.id
  key(doc, win, 'ArrowUp')
  assert.notEqual(pm.currentTarget()?.id, inner,
    '鍵盤 ↑ 是明確意圖，不該被鎖表擋住')
  pm.exitPickMode()
})

// ---------- C-6 repick 帶 preselect 進來就鎖表 ----------

test('C-6 repick 帶既有的值進來，滑鼠移到表格外工具列仍可用', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({
    purpose: 'repick',
    initialTarget: doc.getElementById('a1'),
    preselect: [{ cell: { row: { index: 0, header: '09/01' }, col: { index: 1, header: '成交金額' } } }]
  })
  assert.equal(pm.selectedCount(), 1, '前置：preselect 要勾回來')
  move(win, doc.getElementById('gap'))
  assert.equal(disabledCount(doc), 0, 'repick 一進來就有已選，同樣要鎖表')
  pm.exitPickMode()
})

// ---------- C-7 終檢補件：規劃寫了但原本沒被守住的三條 ----------

test('C-7 用 ↑ 把目標帶到非表格之後，工具列仍以「已選那張表」判定（不得反灰）', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  assert.ok(pm.selectedPicks()[0]?.cell, '前置：先選一格')

  // `↑` 是明確意圖，不受鎖表限制：一路往上會走到非表格的祖先
  for (let i = 0; i < 5 && pm.currentTarget() && pm.currentTarget().tagName !== 'BODY'; i++) {
    key(doc, win, 'ArrowUp')
  }
  assert.equal(pm.selectedCount(), 1, '前置：已選還在')
  assert.equal(disabledCount(doc), 0,
    `已選非空時工具列一律以那張表判定，實得停用 ${disabledCount(doc)} 段`)

  // 而且此時點整欄，最後一項要真的升級（走的是「可用」那條路）
  click(win, tool(doc, 'col'))
  assert.ok(pm.selectedPicks()[0]?.block, '整欄要套到已選那一格上')
  pm.exitPickMode()
})

test('C-7 換表的提示要說得出「換到另一張表格」，不是通用的換選取', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  assert.match(panelText(doc), /另一張表格/,
    `跳到別張表是很大的動作，提示要說得出來，實得：${panelText(doc).slice(0, 150)}`)
  pm.exitPickMode()
})

test('C-7 工具列的判定來源是「已選那張表」，不是滑鼠底下那個元素', async () => {
  const { doc, pm, win } = await boot(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  // 直接把目標塞成非表格（繞過 upgradeTarget 的鎖表），工具列仍要可用
  pm.enterPickMode({ purpose: 'repick', initialTarget: doc.getElementById('a1'),
    preselect: [{ cell: { row: { index: 0, header: '09/01' }, col: { index: 1, header: '成交金額' } } }] })
  assert.equal(pm.selectedCount(), 1)
  move(win, doc.getElementById('gap'))
  assert.equal(disabledCount(doc), 0, '已選非空時三段一律可用')
  pm.exitPickMode()
})
