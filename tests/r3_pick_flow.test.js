// AF-9 作業 C：選取模式的直覺化（鎖定解除、單格升級整欄、取代可復原、
// 動作列建一次、面板閃避、狀態指令句）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <p id="para">頁面上的一段文字</p>
  <table id="t">
    <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
    <tbody>
      <tr><td>美金</td><td id="a1">31.2</td><td id="a2">31.8</td></tr>
      <tr><td>日圓</td><td id="b1">0.21</td><td id="b2">0.22</td></tr>
      <tr><td>歐元</td><td id="c1">33.5</td><td id="c2">34.1</td></tr>
    </tbody>
  </table>`

async function enter(opts = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`)
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

const move = (win, el, init = {}) =>
  el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, ...init }))
const click = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }))
const key = (doc, win, k, init = {}) =>
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const tool = (doc, name) => doc.querySelector(`[data-af-tool="${name}"]`)
const panelText = (doc) => doc.querySelector('[data-af-panel]').textContent
const marked = (doc) => Array.from(doc.querySelectorAll('[data-af-cell]'))
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picks = (c) => (sent(c).find(m => m?.type === 'PICKED' && !m.cancelled) || {}).picks

test('C9-1 先點頁面上的非表格元素鎖定，再點「整欄」要解鎖，滑鼠移到表格上仍能標示', async () => {
  const { doc, win } = await enter()
  const para = doc.getElementById('para')
  move(win, para)
  click(win, para) // 非表格：點一下＝鎖定
  click(win, tool(doc, 'col'))
  move(win, doc.getElementById('a1'))

  assert.ok(marked(doc).length > 0, '解鎖後滑鼠移到資料格要標示整欄，否則使用者會覺得「點了沒反應」')
})

test('C9-2 停用的工具列段被點到時，面板要說出原因', async () => {
  const { doc, win } = await enter({ initialTarget: null })
  const before = panelText(doc)
  click(win, tool(doc, 'col'))
  const after = panelText(doc)

  assert.notEqual(after, before, '點停用的按鈕不能靜默沒反應')
  assert.match(after, /表格/, '要說出「先把滑鼠移到表格上」')
})

test('C9-2b 非表格上點「單格」給的理由要是「這裡不是表格」，不能自相矛盾', async () => {
  const { doc, win } = await enter()
  const para = doc.getElementById('para')
  move(win, para)
  click(win, tool(doc, 'cell'))
  const text = panelText(doc)

  assert.match(text, /表格/, '真正的原因是這裡不是表格')
  assert.doesNotMatch(text, /一次只選一個/, '這與用途無關，說成用途限制會跟上一行「非表格：抓整個元素」打架')
})

test('C9-2c 點任何一段工具列都要解除鎖定（包含永遠可點的「單格」）', async () => {
  const { doc, win } = await enter()
  const para = doc.getElementById('para')
  move(win, para)
  click(win, para) // 鎖定
  click(win, tool(doc, 'cell'))
  move(win, doc.getElementById('a1'))

  assert.ok(marked(doc).length > 0, '鎖著的話滑鼠移到表格上完全沒反應')
})

test('C9-3 在非表格上點「整欄」記住意圖，滑鼠移到表格時自動套用', async () => {
  const { doc, win, pm } = await enter({ initialTarget: null })
  click(win, tool(doc, 'col'))
  assert.match(panelText(doc), /自動切成整欄/, '要先告訴使用者這個意圖被記住了')

  move(win, doc.getElementById('a1'))
  assert.equal(pm.currentAxis(), 'col', '移到表格上就該是整欄，不必再點一次工具列')
})

test('C10-1 已選一格後點「整欄」＝把那一格換成整欄（取代，不是加選）', async () => {
  const { doc, win, pm, c } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  assert.equal(pm.selectedCount(), 1)

  click(win, tool(doc, 'col'))
  assert.equal(pm.selectedCount(), 1, '是取代，不是加選')

  key(doc, win, 'Enter')
  const list = picks(c)
  assert.equal(list.length, 1)
  assert.equal(list[0].block?.axis, 'col', '送出的要是整欄')
  assert.equal(list[0].block?.headerText, '買入', '欄標題要跟著那一格走')
  assert.equal(list[0].cell, undefined, '不能還留著儲存格形狀')
})

test('C10-2 已選一格後點「整列」＝換成該列', async () => {
  const { doc, win, pm } = await enter()
  move(win, doc.getElementById('b1'))
  click(win, doc.getElementById('b1'))
  click(win, tool(doc, 'row'))

  assert.equal(pm.selectedCount(), 1)
  assert.equal(pm.selectedPicks()[0].block?.axis, 'row')
})

test('C10-3 清單是空的時候點整欄只切模式，不憑空生出一個值', async () => {
  const { doc, win, pm } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, tool(doc, 'col'))
  assert.equal(pm.selectedCount(), 0)
  assert.equal(pm.currentAxis(), 'col')
})

test('C11-1 取代可以復原：Ctrl+Z 把被換掉的那一批找回來', async () => {
  const { doc, win, pm } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('a2'))
  click(win, doc.getElementById('a2')) // 點一下＝取代
  assert.deepEqual(pm.selectedPicks().map(p => p.cell.col.index), [2])

  key(doc, win, 'z', { ctrlKey: true })
  assert.deepEqual(pm.selectedPicks().map(p => p.cell.col.index), [1], '要還原成被換掉的那一格')
})

test('C11-2 沒有可還原的取代時，Ctrl+Z 維持「移除最後一項」', async () => {
  const { doc, win, pm } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('a2'))
  click(win, doc.getElementById('a2'), { ctrlKey: true }) // 加選：快照要失效
  assert.equal(pm.selectedCount(), 2)

  key(doc, win, 'z', { ctrlKey: true })
  assert.equal(pm.selectedCount(), 1, '加選之後 Ctrl+Z 是移除最後一項')
})

test('C11-3 升級成整欄之後也能復原回原本那一格', async () => {
  const { doc, win, pm } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  click(win, tool(doc, 'col'))
  assert.equal(pm.selectedPicks()[0].block?.axis, 'col')

  key(doc, win, 'z', { ctrlKey: true })
  assert.equal(pm.selectedPicks()[0].cell?.col.index, 1)
})

test('C11-4 有可復原的取代時，面板上要有「復原」鈕；沒有就不顯示', async () => {
  const { doc, win } = await enter()
  const undo = doc.querySelector('[data-af-undo]')
  assert.ok(undo, '動作列要有復原鈕')
  assert.equal(undo.hidden, true, '沒有取代過就不顯示')

  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('a2'))
  click(win, doc.getElementById('a2'))
  assert.equal(doc.querySelector('[data-af-undo]').hidden, false)
  assert.match(panelText(doc), /復原/)
})

test('C11-5 點「復原」鈕跟 Ctrl+Z 同一條路徑', async () => {
  const { doc, win, pm } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('a2'))
  click(win, doc.getElementById('a2'))
  click(win, doc.querySelector('[data-af-undo]'))

  assert.deepEqual(pm.selectedPicks().map(p => p.cell.col.index), [1])
})

test('C12 動作列建一次：連續 hover 之後「完成」還是同一個節點', async () => {
  const { doc, win } = await enter()
  const first = doc.querySelector('[data-af-done]')
  move(win, doc.getElementById('a1'))
  move(win, doc.getElementById('b1'))
  move(win, doc.getElementById('c1'))
  const after = doc.querySelector('[data-af-done]')

  assert.equal(after, first, '每次 hover 重建按鈕會讓使用者按到一半的鈕被換掉')
  click(win, doc.getElementById('a1'))
  assert.equal(doc.querySelector('[data-af-done]'), first, '選取之後也不重建')
  assert.match(first.textContent, /1 個值/, '只更新文字')
})

test('C13-1 面板閃避：游標靠近時換到另一角', async () => {
  const { doc, win } = await enter()
  const panel = doc.querySelector('[data-af-panel]')
  panel.getBoundingClientRect = () => ({ left: 800, right: 980, top: 600, bottom: 700, width: 180, height: 100 })
  assert.equal(panel.style.right, '16px')

  move(win, doc.getElementById('a1'), { clientX: 810, clientY: 620 })
  assert.equal(panel.style.left, '16px', '游標壓在面板上要閃到左邊')
  assert.equal(panel.style.right, '')
})

test('C13-1b 連續在同一處移動不會來回彈跳（換角後要離開才再換）', async () => {
  const { doc, win } = await enter()
  const panel = doc.querySelector('[data-af-panel]')
  // 面板換角之後，游標仍在原處：舊實作會用「移動前的位置」再判一次而翻回去
  panel.getBoundingClientRect = () => ({ left: 800, right: 980, top: 600, bottom: 700, width: 180, height: 100 })
  move(win, doc.getElementById('a1'), { clientX: 810, clientY: 620 })
  assert.equal(panel.style.left, '16px')

  // 只再移動「一次」：移動兩次的話彈回去又彈回來，最終位置剛好一樣，測不出抖動
  move(win, doc.getElementById('a1'), { clientX: 812, clientY: 622 })
  assert.equal(panel.style.left, '16px', '游標沿邊緣移動時面板不該左右抖動')
  assert.equal(panel.style.right, '', '仍應停在左邊')
})

test('C13-2 滑鼠在面板自己身上時不閃避（否則按鈕會從指尖跑掉）', async () => {
  const { doc, win } = await enter()
  const panel = doc.querySelector('[data-af-panel]')
  panel.getBoundingClientRect = () => ({ left: 800, right: 980, top: 600, bottom: 700, width: 180, height: 100 })
  move(win, panel, { clientX: 810, clientY: 620 })

  assert.equal(panel.style.right, '16px', '面板不該在自己被指到時跑掉')
})

test('C14-1 指令句：目標還沒出現時教使用者先讓內容載入', async () => {
  const { doc } = await enter({ initialTarget: null })
  const text = panelText(doc)
  assert.match(text, /把滑鼠移到要抓的內容上/)
  assert.match(text, /Esc/, 'iframe 要先點頁籤才載入的情況要有出路')
})

test('C14-2 指令句：在表格上還沒選時教怎麼開始', async () => {
  const { doc, win } = await enter()
  move(win, doc.getElementById('a1'))
  assert.match(panelText(doc), /點你要的那一格/)
})

test('C14-3 指令句：選了之後教怎麼送出', async () => {
  const { doc, win } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  const text = panelText(doc)
  assert.match(text, /已選 1 個值/)
  assert.match(text, /完成/)
})

test('C15 exitPickMode 清掉本輪新增的狀態（連續兩次選取不互相污染）', async () => {
  const { doc, win, pm } = await enter()
  move(win, doc.getElementById('a1'))
  click(win, doc.getElementById('a1'))
  move(win, doc.getElementById('a2'))
  click(win, doc.getElementById('a2')) // 產生復原快照
  // 先讓面板真的翻到左邊，這樣「角落狀態有沒有被重設」才有訊號
  const oldPanel = doc.querySelector('[data-af-panel]')
  oldPanel.getBoundingClientRect = () => ({ left: 800, right: 980, top: 600, bottom: 700, width: 180, height: 100 })
  move(win, doc.getElementById('a1'), { clientX: 810, clientY: 620 })
  assert.equal(oldPanel.style.left, '16px', '前提：這一次已經翻到左邊')
  pm.exitPickMode()

  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  assert.equal(doc.querySelector('[data-af-undo]').hidden, true, '上一次的復原快照不得留到下一次')

  // 面板位置要驗的是 panelCorner 這個變數本身：新面板一律寫死 right=16px，
  // 只看 style.right 的話，就算殘留了上一次的角落也照樣是 16px
  const panel = doc.querySelector('[data-af-panel]')
  panel.getBoundingClientRect = () => ({ left: 800, right: 980, top: 600, bottom: 700, width: 180, height: 100 })
  move(win, doc.getElementById('a1'), { clientX: 810, clientY: 620 })
  assert.equal(panel.style.left, '16px', '重進之後第一次靠近應該往左閃（角落狀態已重設）')
})
