// AF-19 作業 E：選取模式補強
// 取消要二段確認 / 面板不得撐出視窗 / chip 與格子雙向指涉 / Ctrl+A 截斷要說 / Delete / 動作列不位移 / 工具列預告
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
  </table>`

// 大表：用來驗 Ctrl+A 的截斷提示
function bigTable(rows, cols) {
  let html = '<table id="big"><thead><tr>'
  for (let c = 0; c < cols; c++) html += `<th>欄${c}</th>`
  html += '</tr></thead><tbody>'
  for (let r = 0; r < rows; r++) {
    html += '<tr>'
    for (let c = 0; c < cols; c++) html += `<td id="g${r}_${c}">${r * cols + c}</td>`
    html += '</tr>'
  }
  return html + '</tbody></table>'
}

async function boot(page = PAGE, opts = {}, targetId = 't') {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>測試頁</title></head><body>${page}</body></html>`)
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

const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const move = (win, el) => fire(win, el, 'mousemove')
const click = (win, el, init) => fire(win, el, 'click', init)
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const pick = (win, el, init) => { move(win, el); click(win, el, init) }
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const cancelled = (c) => sent(c).filter(m => m?.type === 'PICKED' && m.cancelled)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const chips = (doc) => Array.from(doc.querySelectorAll('[data-af-chip]'))
const wait = (ms) => new Promise(r => setTimeout(r, ms))

// ================= 取消的二段確認 =================

test('E 已選兩個以上時按一次 Esc 只提示，再按一次才真的取消', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))

  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 0, '第一次只是提示')
  assert.match(panelText(doc), /再按一次/)
  assert.match(panelText(doc), /2 個/, '要說出會丟掉幾個值')

  await wait(450)
  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 1, '第二次才取消')
  pm.exitPickMode()
})

test('E 只選一個時 Esc 直接取消（不值得多按一次）', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 1)
  pm.exitPickMode()
})

test('E 什麼都沒選時 Esc 直接取消', async () => {
  const { c, doc, pm, win } = await boot()
  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 1)
  pm.exitPickMode()
})

test('E 兩次 Esc 之間隔太短不算（習慣性連按兩下不該穿過確認）', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Escape')
  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 0, '連按兩下等於只按了一次')
  pm.exitPickMode()
})

test('E 按住 Esc 不放（key repeat）不得穿過確認', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Escape')
  await wait(450)
  key(doc, win, 'Escape', { repeat: true })
  assert.equal(cancelled(c).length, 0, 'repeat 的按鍵一律忽略')
  pm.exitPickMode()
})

test('E 第一次 Esc 之後又加了值，確認要重來', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Escape')
  pick(win, doc.getElementById('c1'))
  await wait(450)
  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 0, '清單變了就不是原本那次確認')
  pm.exitPickMode()
})

test('E 清單換過但數量相同，確認仍要重來（加減值都算「清單變了」）', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Escape')
  pick(win, doc.getElementById('a1'))   // 取消 a1（剩 1 個）
  pick(win, doc.getElementById('c1'))   // 加 c1（又回到 2 個，但已經不是剛才那兩個）
  await wait(450)
  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 0, '數量碰巧一樣不代表是同一批，不得沿用上一次的確認')
  pm.exitPickMode()
})

test('E 第一次 Esc 之後右鍵開選單點「取消」＝第二步', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Escape')
  await wait(450)
  doc.getElementById('c2').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  const item = doc.querySelector('[data-af-menu-item="cancel"]')
  assert.ok(item, '右鍵選單要有「取消」')
  item.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.equal(cancelled(c).length, 1, '右鍵開選單不得清掉確認，否則選單裡的取消永遠只是第一步')
  pm.exitPickMode()
})

test('E 面板的「取消」鈕走同一條二段確認', async () => {
  const { c, doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  const btn = doc.querySelector('[data-af-cancel]')
  click(win, btn)
  assert.equal(cancelled(c).length, 0)
  await wait(450)
  click(win, btn)
  assert.equal(cancelled(c).length, 1)
  pm.exitPickMode()
})

test('E 一次只選一個的用途（前置動作）不套二段確認', async () => {
  const { c, doc, pm, win } = await boot(PAGE, { purpose: 'preaction' })
  key(doc, win, 'Escape')
  assert.equal(cancelled(c).length, 1)
  pm.exitPickMode()
})

// ================= 面板高度 =================

test('E chip 清單有高度上限且可捲動，動作列永遠看得到', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  const panel = doc.querySelector('[data-af-panel]')
  const list = doc.querySelector('[data-af-chip-list]')
  assert.ok(list, 'chip 清單要有識別得出來的容器')
  assert.ok(list.style.maxHeight, '沒有上限的話 60 個值會把面板撐出視窗上緣')
  assert.equal(list.style.overflowY, 'auto')
  assert.ok(panel.style.maxHeight, '面板自己也要有保險上限')
  const actions = doc.querySelector('[data-af-done]')?.parentElement
  assert.equal(actions?.parentElement, panel, '動作列要留在面板底層，不得被捲進清單裡')
  pm.exitPickMode()
})

// ================= chip 與格子雙向指涉 =================

test('E 滑過 chip 會在頁面上標出那一格，移開就收掉', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b2'))
  const chip = chips(doc)[0]
  fire(win, chip, 'mouseenter')
  assert.equal(doc.getElementById('a1').hasAttribute('data-af-chip-hover'), true,
    '已選 30 個時光看 chip 認不出是哪一格')
  assert.equal(doc.getElementById('b2').hasAttribute('data-af-chip-hover'), false)
  fire(win, chip, 'mouseleave')
  assert.equal(doc.getElementById('a1').hasAttribute('data-af-chip-hover'), false)
  pm.exitPickMode()
})

test('E 整欄值的 chip 會標出整欄每一格', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('h1'))
  click(win, doc.getElementById('h1'))
  const chip = chips(doc)[0]
  fire(win, chip, 'mouseenter')
  for (const id of ['a1', 'b1', 'c1']) {
    assert.equal(doc.getElementById(id).hasAttribute('data-af-chip-hover'), true, `${id} 屬於這一欄`)
  }
  pm.exitPickMode()
})

test('E 點 chip 會把那一格捲進畫面', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  let scrolled = null
  doc.getElementById('a1').scrollIntoView = () => { scrolled = 'a1' }
  click(win, chips(doc)[0])
  assert.equal(scrolled, 'a1')
  pm.exitPickMode()
})

test('E 點 chip 的移除鈕仍然是移除（不得被捲動搶走）', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  click(win, doc.querySelector('[data-af-chip-remove]'))
  assert.equal(pm.selectedPicks().length, 1)
  pm.exitPickMode()
})

// ================= Ctrl+A 的截斷提示 =================

test('E Ctrl+A 選不完時要說出這張表有幾格、只選到幾格', async () => {
  const { doc, pm, win } = await boot(bigTable(40, 4), { maxPicks: 10 }, 'big')
  move(win, doc.getElementById('g0_0'))
  key(doc, win, 'a', { ctrlKey: true })
  const text = panelText(doc)
  assert.match(text, /160 格/, '要說出這張表實際有多少格')
  assert.match(text, /10/, '要說出只選到幾格')
  pm.exitPickMode()
})

test('E Ctrl+A 全部選得完時不出現截斷提示', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('a1'))
  key(doc, win, 'a', { ctrlKey: true })
  assert.ok(!/只選到/.test(panelText(doc)))
  pm.exitPickMode()
})

// ================= Delete =================

test('E Delete 與 Backspace 一樣移除最後一項', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Delete')
  assert.equal(pm.selectedPicks().length, 1)
  pm.exitPickMode()
})

test('E 清單空的時候 Delete 不攔截（頁面上的輸入框還要用）', async () => {
  const { doc, pm, win } = await boot()
  const ev = new win.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
  doc.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, false)
  pm.exitPickMode()
})

// ================= 動作列不位移 =================

test('E 完成與取消永遠是動作列的前兩顆（後面才是會出現消失的鈕）', async () => {
  const { doc, pm, win } = await boot()
  const actions = () => doc.querySelector('[data-af-done]').parentElement
  const order = () => Array.from(actions().children).map(b =>
    b.hasAttribute('data-af-done') ? 'done'
      : b.hasAttribute('data-af-cancel') ? 'cancel'
        : b.hasAttribute('data-af-undo') ? 'undo' : 'other')
  assert.deepEqual(order().slice(0, 2), ['done', 'cancel'])
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  key(doc, win, 'Backspace')   // 產生復原快照，「復原」會冒出來
  assert.deepEqual(order().slice(0, 2), ['done', 'cancel'],
    '正要按「完成」時手不能落空')
  pm.exitPickMode()
})

// ================= 工具列預告 =================

test('E 已選之後工具列說出會換掉哪一個值', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  const t = doc.querySelector('[data-af-tool="col"]')
  assert.match(t.getAttribute('title'), /換/, '按下去會取代最後選的那一個，要先說')
  assert.match(t.getAttribute('title'), /美金 · 買入/, '要說出會被換掉的是哪一個值（與 chip 同名）')
  pm.exitPickMode()
})

test('E 清單空的時候工具列回到一般說明', async () => {
  const { doc, pm, win } = await boot()
  const t = doc.querySelector('[data-af-tool="col"]')
  const before = t.getAttribute('title')
  pick(win, doc.getElementById('a1'))
  key(doc, win, 'Backspace')
  assert.equal(doc.querySelector('[data-af-tool="col"]').getAttribute('title'), before)
  pm.exitPickMode()
})

// ================= Enter 的提示 =================

test('E 已選非空又停在沒選的格子上時，面板要說 Enter 只會送已選的', async () => {
  const { doc, pm, win } = await boot()
  pick(win, doc.getElementById('a1'))
  move(win, doc.getElementById('c2'))
  assert.match(panelText(doc), /先點它|不會算進去|只送/, '停在第 4 格按 Enter 只送前 3 個是可預期的誤會')
  pm.exitPickMode()
})

// ================= 批次模式的組名 =================

const BATCH_PAGE = `
  <table id="t">
    <caption>匯率</caption>
    <thead><tr><th>幣別</th><th>買入</th></tr></thead>
    <tbody><tr><th scope="row">美金</th><td id="a1">31.2</td></tr><tr><th scope="row">日圓</th><td id="b1">0.21</td></tr></tbody>
  </table>
  <div id="plain">今日總量 1,234</div>`

test('E 批次模式的元素組也帶名稱提示，與面板上的組標題同一個', async () => {
  const { c, doc, pm, win } = await boot(BATCH_PAGE, { batch: true })
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('plain'))
  const groupTitle = Array.from(doc.querySelectorAll('[data-af-group]'))[1]?.textContent || ''
  key(doc, win, 'Enter')
  const msg = sent(c).find(m => m?.type === 'PICKED' && Array.isArray(m.batch))
  assert.ok(msg, '要送出批次')
  const hint = msg.batch[1].nameHint
  assert.ok(hint, '元素組要帶名稱提示，否則 Picker 自己另算一個名字')
  assert.ok(groupTitle.includes(hint), `面板組標題「${groupTitle}」要與送出的名稱提示「${hint}」一致`)
})

test('E 單任務模式選非表格元素仍不帶名稱提示（預設名規則不變）', async () => {
  const { c, doc, win } = await boot(BATCH_PAGE, {}, 'plain')
  pick(win, doc.getElementById('plain'))
  key(doc, win, 'Enter')
  const msg = sent(c).find(m => m?.type === 'PICKED' && !m.cancelled)
  assert.ok(msg)
  assert.equal(msg.nameHint, undefined)
})
