// AF-5 批次 B3：選取模式多選（儲存格、Shift 加選、框選、右鍵選單）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const BANK = `
<h2>牌告匯率</h2>
<table id="rate">
  <thead>
    <tr><th rowspan="2">幣別</th><th colspan="2">現金匯率</th><th colspan="2">即期匯率</th></tr>
    <tr><th>買入</th><th>賣出</th><th>買入</th><th>賣出</th></tr>
  </thead>
  <tbody>
    <tr id="r0"><td id="c0-0">美金</td><td id="c0-1">30.9</td><td id="c0-2">31.5</td><td id="c0-3">31.2</td><td id="c0-4">31.3</td></tr>
    <tr id="r1"><td id="c1-0">日圓</td><td id="c1-1">0.208</td><td id="c1-2">0.216</td><td id="c1-3">0.211</td><td id="c1-4">0.213</td></tr>
  </tbody>
</table>
<div id="plain">1234</div>`

async function setup() {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>臺銀</title></head><body>${BANK}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, pm, doc: jd.window.document, win: jd.window }
}

const lastMsg = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).pop()

const clickCell = (doc, id, opts = {}) => {
  const el = doc.getElementById(id)
  el.dispatchEvent(new globalThis.MouseEvent('mousemove', { bubbles: true }))
  el.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, ...opts }))
}

const hover = (doc, id) =>
  doc.getElementById(id).dispatchEvent(new globalThis.MouseEvent('mousemove', { bubbles: true }))

const key = (doc, k, opts = {}) =>
  doc.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))

const enter = (doc, tid = 'rate') => {
  // 先讓選取模式鎖定表格本身
  return doc.getElementById(tid)
}

// ---- 單擊仍是「選一個就確認」----

test('沒按 Shift 的單擊維持原本行為：選一格就確認', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3')
  const msg = lastMsg(c)
  assert.equal(msg.type, 'PICKED')
  assert.equal(msg.picks.length, 1)
  assert.equal(pm.isActive(), false, '確認後要離開選取模式')
})

test('確認送出的是儲存格，帶列與欄的表頭', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3')
  const pick = lastMsg(c).picks[0]
  assert.ok(pick.cell, '預設一格就是一個值')
  assert.equal(pick.cell.col.index, 3)
  assert.equal(pick.cell.col.header, '即期匯率 · 買入')
  assert.equal(pick.cell.row.index, 0)
  assert.equal(pick.cell.row.header, '美金')
})

// ---- Shift 加選 ----

test('Shift 點擊會加選而不是確認', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  assert.equal(pm.isActive(), true, 'Shift 是加選，不該直接送出')
  assert.equal(pm.selectedCount(), 1)
  clickCell(doc, 'c0-4', { shiftKey: true })
  assert.equal(pm.selectedCount(), 2)
  key(doc, 'Enter')
  const picks = lastMsg(c).picks
  assert.equal(picks.length, 2)
  assert.deepEqual(picks.map(p => p.cell.col.index), [3, 4], '順序照選取順序')
})

test('Shift 再點一次同一格是取消選取', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  clickCell(doc, 'c0-3', { shiftKey: true })
  assert.equal(pm.selectedCount(), 0)
})

test('已選的格子有標記，取消後標記消失', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  assert.ok(doc.getElementById('c0-3').hasAttribute('data-af-picked'))
  clickCell(doc, 'c0-3', { shiftKey: true })
  assert.ok(!doc.getElementById('c0-3').hasAttribute('data-af-picked'))
})

// ---- 拖曳框選 ----

const drag = (doc, fromId, toId) => {
  const a = doc.getElementById(fromId)
  const b = doc.getElementById(toId)
  a.dispatchEvent(new globalThis.MouseEvent('mousedown', { bubbles: true }))
  b.dispatchEvent(new globalThis.MouseEvent('mousemove', { bubbles: true, buttons: 1 }))
  b.dispatchEvent(new globalThis.MouseEvent('mouseup', { bubbles: true }))
}

test('拖過多格會把矩形範圍內的格子全部選起來', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  drag(doc, 'c0-3', 'c1-4')
  assert.equal(pm.selectedCount(), 4, '兩列 × 兩欄')
})

test('第二次框選是累加，不會清掉第一次選的', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  drag(doc, 'c0-1', 'c0-2')
  assert.equal(pm.selectedCount(), 2)
  drag(doc, 'c0-3', 'c0-4')
  assert.equal(pm.selectedCount(), 4, '幣別不相鄰時使用者會框選好幾次')
})

test('框選放開時不會被誤判成「單擊確認」', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  drag(doc, 'c0-3', 'c0-4')
  doc.getElementById('c0-4').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  assert.equal(pm.isActive(), true, '拖曳後的 click 要被吃掉')
  assert.equal(pm.selectedCount(), 2)
})

// ---- 右鍵選單 ----

const rightClick = (doc, id) =>
  doc.getElementById(id).dispatchEvent(new globalThis.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

test('表格內右鍵開出完整的選取方式', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  hover(doc, 'c0-3')
  rightClick(doc, 'c0-3')
  const items = [...doc.querySelectorAll('[data-af-menu-item]')].map(el => el.dataset.afMenuItem)
  assert.deepEqual(items, ['cell', 'col-each', 'col', 'row-each', 'row', 'done', 'cancel'],
    '欄與列各有「每格一值」與「整欄一值」兩種，是兩件不同的事')
})

test('右鍵選「選這一欄」加入的是整欄聚合，不是一格', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  hover(doc, 'c0-3')
  rightClick(doc, 'c0-3')
  doc.querySelector('[data-af-menu-item="col"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  assert.equal(pm.selectedCount(), 1)
  key(doc, 'Enter')
  const pick = lastMsg(c).picks[0]
  assert.ok(pick.block, '整欄是聚合型的值')
  assert.equal(pick.block.axis, 'col')
  assert.equal(pick.block.headerText, '即期匯率 · 買入')
})

test('右鍵選「選這一列」加入整列聚合', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  hover(doc, 'c0-3')
  rightClick(doc, 'c0-3')
  doc.querySelector('[data-af-menu-item="row"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  key(doc, 'Enter')
  const pick = lastMsg(c).picks[0]
  assert.equal(pick.block.axis, 'row')
})

test('右鍵選「完成」等同 Enter', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  hover(doc, 'c0-4')
  rightClick(doc, 'c0-4')
  doc.querySelector('[data-af-menu-item="done"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  assert.equal(lastMsg(c).picks.length, 1)
  assert.equal(pm.isActive(), false)
})

test('右鍵選「取消」送出取消訊息', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  hover(doc, 'c0-3')
  rightClick(doc, 'c0-3')
  doc.querySelector('[data-af-menu-item="cancel"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }))
  assert.equal(lastMsg(c).cancelled, true)
})

test('選單開著時再右鍵會換位置，不會開出兩個', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  hover(doc, 'c0-3')
  rightClick(doc, 'c0-3')
  hover(doc, 'c0-4')
  rightClick(doc, 'c0-4')
  assert.equal(doc.querySelectorAll('[data-af-menu]').length, 1)
})

test('非表格元素的右鍵只有兩個選項', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('plain') })
  rightClick(doc, 'plain')
  const items = [...doc.querySelectorAll('[data-af-menu-item]')].map(el => el.dataset.afMenuItem)
  assert.deepEqual(items, ['element', 'cancel'])
})

test('頁面原本的右鍵選單要被擋掉', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  hover(doc, 'c0-3')
  const ev = new globalThis.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  doc.getElementById('c0-3').dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, true)
})

// ---- 鍵盤 ----

test('Shift 加方向鍵沿著欄延伸選取', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  hover(doc, 'c0-3')
  key(doc, 'ArrowRight', { shiftKey: true })
  assert.equal(pm.selectedCount(), 2, '起點那格加上右邊那格')
})

test('Esc 取消整個選取', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  key(doc, 'Escape')
  assert.equal(lastMsg(c).cancelled, true)
  assert.equal(pm.isActive(), false)
})

test('Tab 切換欄列軸時清空已選', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  key(doc, 'Tab')
  assert.equal(pm.selectedCount(), 0, '換了軸，先前選的欄不再適用')
})

// ---- 面板與上限 ----

test('面板顯示已選幾個值與名稱', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  clickCell(doc, 'c0-4', { shiftKey: true })
  const panel = doc.querySelector('[data-af-panel]')
  assert.ok(panel.textContent.includes('已選 2'), `面板要說已選幾個：${panel.textContent}`)
  assert.ok(panel.textContent.includes('美金'), '要看得出選了什麼')
})

test('超過上限時不再加入並在面板說明', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate'), maxPicks: 3 })
  for (const id of ['c0-1', 'c0-2', 'c0-3', 'c0-4']) clickCell(doc, id, { shiftKey: true })
  assert.equal(pm.selectedCount(), 3)
  assert.ok(doc.querySelector('[data-af-panel]').textContent.includes('上限'))
})

// ---- 重繪韌性 ----

test('表格被重畫之後標記能重新貼上', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  // 模擬即時報價把整個 tbody 換掉（元素參照全部失效，索引不變）
  const tbody = doc.querySelector('#rate tbody')
  tbody.innerHTML = tbody.innerHTML
  hover(doc, 'c1-1')
  assert.equal(pm.selectedCount(), 1, '選取狀態存的是索引，不是元素參照')
  const marked = doc.querySelectorAll('#rate [data-af-picked]')
  assert.equal(marked.length, 1, '重畫後標記要貼回去')
})

// ---- 其他用途不支援多選 ----

test('重選、登入欄位、前置動作只送單一目標', async () => {
  for (const purpose of ['repick', 'login-user', 'preaction']) {
    const { c, pm, doc } = await setup()
    pm.enterPickMode({ purpose, initialTarget: doc.getElementById('rate') })
    clickCell(doc, 'c0-3', { shiftKey: true })
    const msg = lastMsg(c)
    assert.equal(msg.purpose, purpose)
    assert.ok(!msg.picks || msg.picks.length <= 1, `${purpose} 不支援多選`)
    assert.equal(pm.isActive(), false, `${purpose} 應該選一個就送出`)
  }
})

test('確認訊息仍帶著舊的 blockInfo 欄位', async () => {
  const { c, pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3')
  const msg = lastMsg(c)
  assert.ok(msg.blockInfo, '既有消費端還在讀它')
  assert.ok(msg.locator, '定位資訊不可少')
})

// ---- 預選 ----

test('帶著 preselect 進來時先把那些格子勾回去', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({
    purpose: 'task',
    initialTarget: doc.getElementById('rate'),
    preselect: [{ cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '即期匯率 · 買入' } } }]
  })
  assert.equal(pm.selectedCount(), 1)
  assert.ok(doc.getElementById('c0-3').hasAttribute('data-af-picked'))
})

test('預選的表頭對不上時仍以表頭為準並提示', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({
    purpose: 'task',
    initialTarget: doc.getElementById('rate'),
    preselect: [{ cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '即期匯率 · 買入' } } }]
  })
  assert.ok(doc.getElementById('c0-3').hasAttribute('data-af-picked'), '跟著表頭走')
  assert.ok(doc.querySelector('[data-af-panel]').textContent.includes('位置已變'),
    '要讓使用者知道欄位搬過家')
})

// ---- 收尾 ----

test('離開選取模式把加上的東西全部清掉', async () => {
  const { pm, doc } = await setup()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  clickCell(doc, 'c0-3', { shiftKey: true })
  hover(doc, 'c0-3')
  rightClick(doc, 'c0-3')
  pm.exitPickMode()
  assert.equal(doc.querySelectorAll('[data-af-overlay]').length, 0)
  assert.equal(doc.querySelectorAll('[data-af-menu]').length, 0)
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 0)
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 0)
  assert.equal(doc.body.style.userSelect, '', '選取期間停用的文字選取要還原')
})
