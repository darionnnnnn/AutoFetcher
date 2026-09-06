// AF-3 批次 B:頁面內選取模式(像 F12 那樣直接在頁面上選,高亮 + ↑/↓ + Enter/Esc)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <h1 id="title">報表</h1>
  <div id="wrap">
    <div id="box"><span id="label">今日總量</span><span id="v">1,234</span></div>
  </div>
  <table id="t">
    <thead><tr><th>日期</th><th>數量</th></tr></thead>
    <tbody>
      <tr><td id="c11">09-01</td><td id="c12">10</td></tr>
      <tr><td id="c21">09-02</td><td id="c22">32</td></tr>
    </tbody>
  </table>`

async function setup() {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  // 記錄 document 上實際掛了幾個監聽、拆了幾個（離開時必須拆乾淨，否則每開一次選取模式就漏一組）
  const doc = jd.window.document
  const listeners = { added: {}, removed: {} }
  const origAdd = doc.addEventListener.bind(doc)
  const origRemove = doc.removeEventListener.bind(doc)
  doc.addEventListener = (type, ...a) => { listeners.added[type] = (listeners.added[type] || 0) + 1; return origAdd(type, ...a) }
  doc.removeEventListener = (type, ...a) => { listeners.removed[type] = (listeners.removed[type] || 0) + 1; return origRemove(type, ...a) }
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc, win: jd.window, pm, listeners }
}

const $ = (doc, sel) => doc.querySelector(sel)
const overlay = (doc) => doc.querySelector('[data-af-overlay]')
const highlightTarget = (pm) => pm.currentTarget()

function move(doc, el) {
  el.dispatchEvent(new globalThis.MouseEvent('mousemove', { bubbles: true }))
}
function key(doc, k) {
  doc.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: k, bubbles: true }))
}
function picked(c) {
  return c.__calls
    .filter(x => x.api === 'runtime.sendMessage')
    .map(x => x.args[0])
    .filter(m => m?.type === 'PICKED')
}

// ---- 進入與離開 ----

test('進入選取模式時把右鍵處的元素當成預選,並畫出高亮', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  assert.ok(overlay(doc), '必須建立 overlay')
  assert.equal(highlightTarget(pm), $(doc, '#v'), '預選就是右鍵處的元素')
})

test('沒有預選元素時仍可進入,等使用者移動滑鼠', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task' })
  assert.ok(overlay(doc))
  assert.equal(highlightTarget(pm), null)
})

test('Esc 取消:移除 overlay 並回報取消', async () => {
  const { c, doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  key(doc, 'Escape')
  assert.equal(overlay(doc), null, 'overlay 要移除乾淨')
  const msgs = picked(c)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].cancelled, true)
})

test('離開後不再回應滑鼠與鍵盤(監聽要拆乾淨)', async () => {
  const { c, doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  key(doc, 'Escape')
  move(doc, $(doc, '#title'))
  key(doc, 'Enter')
  assert.equal(picked(c).length, 1, '取消之後不該再送出任何 PICKED')
  assert.equal(overlay(doc), null)
})

test('離開時 document 上的監聽要拆得跟掛的一樣多', async () => {
  const { doc, pm, listeners } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  for (const type of ['mousemove', 'keydown', 'click']) {
    assert.ok(listeners.added[type] > 0, `必須掛上 ${type}`)
  }
  pm.exitPickMode()
  // jsdom 自己會在派發滑鼠事件時掛 mouseover/mouseout，只看選取模式自己掛的那三種
  for (const type of ['mousemove', 'keydown', 'click']) {
    assert.ok(
      (listeners.removed[type] || 0) >= listeners.added[type],
      `${type} 掛了 ${listeners.added[type]} 次只拆了 ${listeners.removed[type] || 0} 次,長時間使用會累積`
    )
  }
})

test('重複進入不會疊出兩層 overlay', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#title') })
  assert.equal(doc.querySelectorAll('[data-af-overlay]').length, 1)
  assert.equal(highlightTarget(pm), $(doc, '#title'), '第二次進入以新的預選為準')
})

// ---- 選取:滑鼠與鍵盤 ----

test('滑鼠移到別的元素就改選它', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  move(doc, $(doc, '#title'))
  assert.equal(highlightTarget(pm), $(doc, '#title'))
})

test('↑ 擴大到父層,↓ 回到剛才那一層', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  key(doc, 'ArrowUp')
  assert.equal(highlightTarget(pm), $(doc, '#box'), '↑ 要選到父層')
  key(doc, 'ArrowUp')
  assert.equal(highlightTarget(pm), $(doc, '#wrap'))
  key(doc, 'ArrowDown')
  assert.equal(highlightTarget(pm), $(doc, '#box'), '↓ 要沿著剛才上來的那條路回去')
  key(doc, 'ArrowDown')
  assert.equal(highlightTarget(pm), $(doc, '#v'))
})

test('↓ 到底(沒有上去過)時維持不動,不會選到隨便一個子元素', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  key(doc, 'ArrowDown')
  assert.equal(highlightTarget(pm), $(doc, '#v'))
})

test('↑ 到 body 就停住,不會跑到 html 或 document', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  for (let i = 0; i < 10; i++) key(doc, 'ArrowUp')
  assert.equal(highlightTarget(pm), doc.body)
})

test('滑鼠改選之後,↑ 是從新選的元素往上,不是從舊的', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  key(doc, 'ArrowUp')
  move(doc, $(doc, '#label'))
  key(doc, 'ArrowUp')
  assert.equal(highlightTarget(pm), $(doc, '#box'))
})

test('overlay 自己不會被選成目標', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  move(doc, overlay(doc))
  assert.equal(highlightTarget(pm), $(doc, '#v'), '移到 overlay 上時維持原選取')
})

// ---- 確認:送出 PICKED ----

test('Enter 確認:送出 locator、預覽與型別,並收掉 overlay', async () => {
  const { c, doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  key(doc, 'Enter')
  const msgs = picked(c)
  assert.equal(msgs.length, 1)
  const m = msgs[0]
  assert.equal(m.purpose, 'task')
  assert.equal(m.cancelled, undefined)
  assert.equal(m.locator.css, '#v', 'locator 由 selector.describe 產生')
  assert.equal(m.preview, '1,234')
  assert.equal(m.previewValue, 1234)
  assert.equal(m.blockInfo.kind, 'number')
  assert.equal(overlay(doc), null)
})

test('點擊也算確認,而且不會把點擊傳給頁面本身', async () => {
  const { c, doc, pm } = await setup()
  let pageSaw = false
  $(doc, '#title').addEventListener('click', () => { pageSaw = true })
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#title') })
  $(doc, '#title').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(picked(c).length, 1, '點擊要確認選取')
  assert.equal(pageSaw, false, '不得讓頁面收到這一下點擊(可能是連結或按鈕)')
})

test('沒有選任何東西時 Enter 不送出', async () => {
  const { c, doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task' })
  key(doc, 'Enter')
  assert.equal(picked(c).length, 0)
  assert.ok(overlay(doc), '還沒選就不該關掉選取模式')
})

test('purpose 與 taskId 會原樣帶回', async () => {
  const { c, doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'repick', taskId: 't7', initialTarget: $(doc, '#v') })
  key(doc, 'Enter')
  const m = picked(c)[0]
  assert.equal(m.purpose, 'repick')
  assert.equal(m.taskId, 't7')
})

// ---- 表格:直接在頁面上點欄或列 ----

test('選到表格時面板顯示表格資訊,預設以「欄」為軸', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#t') })
  const panel = doc.querySelector('[data-af-panel]')
  assert.ok(panel.textContent.includes('表格'), `面板要說明這是表格,實得:${panel.textContent}`)
  assert.equal(pm.currentAxis(), 'col')
})

test('第二個資料列的索引是 1(列索引與欄索引一樣 0-based)', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#t') })
  move(doc, $(doc, '#c22'))
  key(doc, 'Tab')
  assert.equal(pm.currentCellIndex(), 1)
})

test('在表格內移動滑鼠時,整欄被標示為待選', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#t') })
  move(doc, $(doc, '#c12'))
  assert.equal(pm.currentCellIndex(), 1, '第 2 欄(索引 1)')
  const marked = doc.querySelectorAll('[data-af-cell]')
  assert.equal(marked.length, 2, '同一欄的兩個資料格都要標示')
})

test('換到另一欄時,上一欄的標示要先清掉', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#t') })
  move(doc, $(doc, '#c12'))
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 2)
  move(doc, $(doc, '#c11'))
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 2, '只能標示目前這一欄,不能累加')
  assert.equal(pm.currentCellIndex(), 0)
})

test('Tab 切換成以「列」為軸', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#t') })
  move(doc, $(doc, '#c12'))
  key(doc, 'Tab')
  assert.equal(pm.currentAxis(), 'row')
  assert.equal(pm.currentCellIndex(), 0, '第一個資料列的索引是 0,與欄索引一樣是 0-based')
})

test('在表格格子上點擊 → 送出 blockInfo 的軸、索引與表頭文字', async () => {
  const { c, doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#t') })
  move(doc, $(doc, '#c12'))
  $(doc, '#c12').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }))
  const m = picked(c)[0]
  assert.equal(m.blockInfo.kind, 'table')
  assert.equal(m.blockInfo.axis, 'col')
  assert.equal(m.blockInfo.index, 1)
  assert.equal(m.blockInfo.headerText, '數量')
  assert.equal(m.locator.css || m.locator.path || m.locator.xpath, '#t',
    'locator 仍然指向表格容器本身,不是那一格')
})

test('表格選取後所有 [data-af-cell] 標示都要清乾淨', async () => {
  const { doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#t') })
  move(doc, $(doc, '#c12'))
  key(doc, 'Enter')
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 0)
})

test('非表格目標不產生 axis 與 index', async () => {
  const { c, doc, pm } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: $(doc, '#v') })
  key(doc, 'Enter')
  const m = picked(c)[0]
  assert.equal(m.blockInfo.axis, undefined)
  assert.equal(m.blockInfo.index, undefined)
})
