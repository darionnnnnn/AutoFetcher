// AF-8 批次 F1：選取模式的操作習慣（點選／雙擊確認／Ctrl 加選／Shift 範圍／點表頭／完成取消鈕）
// 對照 docs/AF-8-PLAN.md 批次 F 的驗收。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <h2>匯率表</h2>
  <table id="t">
    <thead><tr><th id="h0">幣別</th><th id="h1">買入</th><th id="h2">賣出</th></tr></thead>
    <tbody>
      <tr><th id="r0" scope="row">美金</th><td id="a1">31.2</td><td id="a2">31.8</td></tr>
      <tr><th id="r1" scope="row">日圓</th><td id="b1">0.21</td><td id="b2">0.22</td></tr>
      <tr><th id="r2" scope="row">歐元</th><td id="c1">33.5</td><td id="c2">34.1</td></tr>
    </tbody>
  </table>
  <div id="plain">今日總量 1,234</div>
  <div id="blank">別的地方</div>`

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

const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
const click = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }))
const dblclick = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, ...init }))
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picked = (c) => sent(c).filter(m => m?.type === 'PICKED' && !m.cancelled)
const cancelled = (c) => sent(c).filter(m => m?.type === 'PICKED' && m.cancelled)
const chips = (doc) => Array.from(doc.querySelectorAll('[data-af-chip]'))
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const doneBtn = (doc) => doc.querySelector('[data-af-done]')
const cancelBtn = (doc) => doc.querySelector('[data-af-cancel]')

// 選一格：滑鼠先移過去再點（真實瀏覽器一定是這個順序）
function pick(win, el, init = {}) {
  move(win, el)
  click(win, el, init)
}

// ---------- F-1 點一下＝選取，不送出 ----------

test('F-1 點一格只選取，不送出', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  assert.equal(picked(c).length, 0, '點一下不該直接送出')
  assert.equal(chips(doc).length, 1, `要有一個已選 chip，實得 ${chips(doc).length}`)
  pm.exitPickMode()
})

test('F-1 再點另一格＝取代，清單仍只有一個', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b2'))
  assert.equal(chips(doc).length, 1, '點一下是取代不是加選')
  assert.ok(/日圓 · 賣出/.test(panelText(doc)), `chip 要換成新那格，實得 ${JSON.stringify(panelText(doc))}`)
  pm.exitPickMode()
})

test('F-1 再點同一格維持已選，不移除', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('a1'))
  assert.equal(chips(doc).length, 1, '再點同一格不該把它移除')
  pm.exitPickMode()
})

// ---------- F-2 Ctrl 加選／取消 ----------

test('F-2 Ctrl＋點加選，Ctrl＋點已選取消', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'), { ctrlKey: true })
  assert.equal(chips(doc).length, 2, `Ctrl 要加選，實得 ${chips(doc).length}`)
  pick(win, doc.getElementById('b1'), { ctrlKey: true })
  assert.equal(chips(doc).length, 1, 'Ctrl 點已選的要取消它')
  pm.exitPickMode()
})

test('F-2 macOS 的 Cmd 等同 Ctrl', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'), { metaKey: true })
  assert.equal(chips(doc).length, 2)
  pm.exitPickMode()
})

// ---------- F-3 Shift 範圍 ----------

test('F-3 Shift＋點從上一個已選格拉出矩形範圍', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('c2'), { shiftKey: true })
  assert.equal(chips(doc).length, 6, `3 列 × 2 欄要 6 格，實得 ${chips(doc).length}`)
  pm.exitPickMode()
})

test('F-3 沒有已選時 Shift＋點等同點一下', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('b2'), { shiftKey: true })
  assert.equal(chips(doc).length, 1)
  pm.exitPickMode()
})

// ---------- F-4 雙擊／Enter／完成鈕送出 ----------

test('F-4 雙擊送出目前已選', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'), { ctrlKey: true })
  dblclick(win, doc.getElementById('b1'))
  const msgs = picked(c)
  assert.equal(msgs.length, 1, '雙擊要送出一則')
  assert.equal(msgs[0].picks.length, 2, `送出的是已選那兩格，實得 ${msgs[0].picks.length}`)
  pm.exitPickMode()
})

test('F-4 空清單時 hover 一格直接雙擊＝選它並送出', async () => {
  const { c, doc, pm, win } = await boot()
  move(win, doc.getElementById('c2'))
  dblclick(win, doc.getElementById('c2'))
  const msgs = picked(c)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].picks.length, 1)
  assert.equal(msgs[0].picks[0].cell.row.index, 2)
  pm.exitPickMode()
})

test('F-4 空清單時 hover 一格按 Enter 也送出（鍵盤快速路徑）', async () => {
  const { c, doc, pm, win } = await boot()
  move(win, doc.getElementById('b2'))
  key(doc, win, 'Enter')
  assert.equal(picked(c).length, 1, '鍵盤使用者不必先點一下')
  pm.exitPickMode()
})

test('F-4 完成鈕送出、取消鈕送 cancelled', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  click(win, doneBtn(doc))
  assert.equal(picked(c).length, 1, '完成鈕要送出')
  pm.exitPickMode()

  const b = await boot()
  click(b.win, cancelBtn(b.doc))
  assert.equal(cancelled(b.c).length, 1, '取消鈕要送 cancelled')
  b.pm.exitPickMode()
})

test('F-4 完成鈕顯示已選數量；表格上沒選時停用', async () => {
  const { doc, pm, win } = await boot()
  assert.equal(doneBtn(doc).getAttribute('aria-disabled'), 'true', '表格上還沒選就不能完成')
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'), { ctrlKey: true })
  pick(win, doc.getElementById('c1'), { ctrlKey: true })
  assert.ok(/3/.test(doneBtn(doc).textContent), `完成鈕要帶數量，實得 ${doneBtn(doc).textContent}`)
  assert.notEqual(doneBtn(doc).getAttribute('aria-disabled'), 'true')
  pm.exitPickMode()
})

// ---------- F-5 點表頭選整欄／整列 ----------

test('F-5 點表頭列的儲存格＝選整欄', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('h1'))
  dblclick(win, doc.getElementById('h1'))
  const p = picked(c)[0].picks[0]
  assert.ok(p.block, `要是欄列聚合規格，實得 ${JSON.stringify(p)}`)
  assert.equal(p.block.axis, 'col')
  assert.equal(p.block.headerText, '買入', `實得 ${p.block.headerText}`)
  pm.exitPickMode()
})

test('F-5 點資料列的列標題格＝選整列', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('r1'))
  dblclick(win, doc.getElementById('r1'))
  const p = picked(c)[0].picks[0]
  assert.ok(p.block, `要是欄列聚合規格，實得 ${JSON.stringify(p)}`)
  assert.equal(p.block.axis, 'row')
  assert.equal(p.block.headerText, '日圓', `實得 ${p.block.headerText}`)
  pm.exitPickMode()
})

test('F-5 Ctrl＋點表頭可以加選多欄', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('h1'))
  pick(win, doc.getElementById('h2'), { ctrlKey: true })
  assert.equal(chips(doc).length, 2, `兩欄要各一個 chip，實得 ${chips(doc).length}`)
  pm.exitPickMode()
})

// ---------- F-6 非表格：鎖定 ----------

test('F-6 非表格點一下鎖定，滑鼠移開目標不變；雙擊送出', async () => {
  const { c, doc, pm, win } = await boot({ initialTarget: null })
  pick(win, doc.getElementById('plain'))
  assert.equal(picked(c).length, 0, '點一下不送出')
  move(win, doc.getElementById('blank'))
  assert.ok(/plain/.test(panelText(doc)), `鎖定後滑鼠移開目標不該換，實得 ${JSON.stringify(panelText(doc))}`)
  dblclick(win, doc.getElementById('plain'))
  assert.equal(picked(c).length, 1, '雙擊送出')
  pm.exitPickMode()
})

test('F-6 鎖定後在別處點一下＝解除鎖定', async () => {
  const { doc, pm, win } = await boot({ initialTarget: null })
  pick(win, doc.getElementById('plain'))
  pick(win, doc.getElementById('blank'))
  move(win, doc.getElementById('plain'))
  assert.ok(/plain/.test(panelText(doc)), '解除鎖定後目標要跟著滑鼠')
  pm.exitPickMode()
})

test('F-6 非表格沒有已選時完成鈕仍可按', async () => {
  const { c, doc, pm, win } = await boot({ initialTarget: null })
  move(win, doc.getElementById('plain'))
  assert.notEqual(doneBtn(doc).getAttribute('aria-disabled'), 'true', '非表格是抓整個元素，隨時可完成')
  click(win, doneBtn(doc))
  assert.equal(picked(c).length, 1)
  pm.exitPickMode()
})

// ---------- F-7 其他用途維持點一下送出 ----------

test('F-7 前置動作／登入用途點一下就送出', async () => {
  for (const purpose of ['preaction', 'login-user']) {
    const { c, doc, pm, win } = await boot({ purpose, initialTarget: null })
    pick(win, doc.getElementById('plain'))
    assert.equal(picked(c).length, 1, `${purpose} 一次只選一個，點一下就該送出`)
    pm.exitPickMode()
  }
})

test('F-7 重選（repick）跟新任務同一套：點一下不送出、可 Ctrl 加選', async () => {
  const { c, doc, pm, win } = await boot({ purpose: 'repick', taskId: 'x' })
  pick(win, doc.getElementById('a1'))
  assert.equal(picked(c).length, 0, '重選要能多值，點一下不送出')
  pick(win, doc.getElementById('b1'), { ctrlKey: true })
  assert.equal(chips(doc).length, 2)
  pm.exitPickMode()
})

// ---------- F-8 鍵盤 ----------

test('F-8 Ctrl＋A 全選該表資料格', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('a1'))
  key(doc, win, 'a', { ctrlKey: true })
  assert.equal(chips(doc).length, 6, `3 列 × 2 資料欄，實得 ${chips(doc).length}`)
  pm.exitPickMode()
})

test('F-8 Ctrl＋A 超過上限時截斷並提示', async () => {
  const { doc, pm, win } = await boot({ maxPicks: 4 })
  move(win, doc.getElementById('a1'))
  key(doc, win, 'a', { ctrlKey: true })
  assert.equal(chips(doc).length, 4, '要停在上限')
  assert.ok(/上限/.test(panelText(doc)), '要說出為什麼只選了一部分')
  pm.exitPickMode()
})

test('F-8 Ctrl＋Z 移除最後一項；清單空時不攔', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'), { ctrlKey: true })
  key(doc, win, 'z', { ctrlKey: true })
  assert.equal(chips(doc).length, 1)
  let prevented = false
  const ev = new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
  key(doc, win, 'z', { ctrlKey: true })
  const ev2 = new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
  doc.dispatchEvent(ev2)
  prevented = ev2.defaultPrevented
  assert.equal(prevented, false, '清單空了就把按鍵放給頁面')
  void ev
  pm.exitPickMode()
})

// ---------- F-9 preselect 取代要先確認 ----------

test('F-9 帶 preselect 進來時，點一下不會直接洗掉多個已選', async () => {
  const preselect = [
    { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
    { cell: { row: { index: 1, header: '日圓' }, col: { index: 1, header: '買入' } } },
    { cell: { row: { index: 2, header: '歐元' }, col: { index: 1, header: '買入' } } }
  ]
  const { doc, pm, win } = await boot({ purpose: 'repick', taskId: 'x', preselect })
  assert.equal(chips(doc).length, 3, '先勾回三個')
  pick(win, doc.getElementById('a2'))
  assert.equal(chips(doc).length, 3, '第一次點只提示，不取代')
  assert.ok(/取代/.test(panelText(doc)), `面板要提示，實得 ${JSON.stringify(panelText(doc))}`)
  pick(win, doc.getElementById('a2'))
  assert.equal(chips(doc).length, 1, '再點一次才真的取代')
  pm.exitPickMode()
})

// ---------- F-9b 拖曳框選之後補的點擊不該湊成雙擊 ----------

test('F-9b 拖曳框選放開後的雙擊不送出', async () => {
  const { c, doc, pm, win } = await boot()
  const down = (el) => el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, button: 0 }))
  const up = (el) => el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }))
  move(win, doc.getElementById('a1'))
  down(doc.getElementById('a1'))
  doc.getElementById('b2').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, buttons: 1 }))
  up(doc.getElementById('b2'))
  assert.equal(chips(doc).length, 4, `2 列 × 2 欄要 4 格，實得 ${chips(doc).length}`)
  dblclick(win, doc.getElementById('b2'))
  assert.equal(picked(c).length, 0, '剛拖曳完的那個雙擊是瀏覽器補的，不是使用者要送出')
  pm.exitPickMode()
})

// ---------- F-10 面板提示依狀態切換 ----------

test('F-10 面板提示：沒選時教怎麼開始，選了之後教怎麼完成', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('a1'))
  assert.ok(/點一格/.test(panelText(doc)), `實得 ${JSON.stringify(panelText(doc))}`)
  pick(win, doc.getElementById('a1'))
  assert.ok(/雙擊|Enter/.test(panelText(doc)), `選了之後要教怎麼送出，實得 ${JSON.stringify(panelText(doc))}`)
  pm.exitPickMode()
})

// ---------- F-11 不殘留 ----------

test('F-11 鎖定狀態不會殘留到下一次選取', async () => {
  const { doc, pm, win } = await boot({ initialTarget: null })
  pick(win, doc.getElementById('plain'))
  pm.exitPickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: null })
  move(win, doc.getElementById('blank'))
  assert.ok(/blank/.test(panelText(doc)), '新的一次選取不該還鎖在上一個元素上')
  pm.exitPickMode()
})
