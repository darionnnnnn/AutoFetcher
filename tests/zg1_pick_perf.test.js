// AF-21 段 7-A：選取模式在大表上的 hover 效能——以計數驗、不以時間驗
// 1. 同一張表連續 hover，整表描述（detectKind）與資料列只算一次
// 2. 表格內容變動（插一列）後快取失效，選取結果是新的列
// 3. 已選標示差異更新：hover 換欄不會把已選標示全拆再全畫
// 4. 連續進出選取模式兩次：第二次的快取與觀察器是新的，第一次的觀察器已 disconnect
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { detectKind } from '../src/shared/block-detect.js'

const ROWS = 30
const COLS = 4
function tableHtml() {
  const head = `<thead><tr>${Array.from({ length: COLS }, (_, c) => `<th>H${c}</th>`).join('')}</tr></thead>`
  const body = Array.from({ length: ROWS }, (_, r) =>
    `<tr id="r${r}">${Array.from({ length: COLS }, (_, c) => `<td id="c${r}-${c}">${r * 10 + c}</td>`).join('')}</tr>`).join('')
  return `<table id="t">${head}<tbody>${body}</tbody></table>`
}

async function boot() {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>測試頁</title></head><body>${tableHtml()}</body></html>`)
  const win = jd.window
  // 觀察器替身：記下每一個被建立的觀察器與它有沒有 disconnect（掛在這個 jsdom 視窗上，不動原型）
  const observers = []
  const RealMO = win.MutationObserver
  win.MutationObserver = class extends RealMO {
    constructor(cb) {
      super(cb)
      this.disconnected = false
      observers.push(this)
    }
    disconnect() {
      this.disconnected = true
      return super.disconnect()
    }
  }
  globalThis.window = win
  globalThis.document = win.document
  globalThis.Event = win.Event
  globalThis.MouseEvent = win.MouseEvent
  globalThis.KeyboardEvent = win.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: win.document, pm, win, observers }
}
const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const cellEl = (doc, r, c) => doc.getElementById(`c${r}-${c}`)

// 在一個列元素實例上數 `cells` 被讀幾次（整表描述與資料列判定都會逐列讀它）。
// 只包這一個實例的屬性，不改 jsdom 的原型
function spyRowCells(win, row) {
  const get = Object.getOwnPropertyDescriptor(win.HTMLTableRowElement.prototype, 'cells').get
  const spy = { n: 0 }
  Object.defineProperty(row, 'cells', { configurable: true, get() { spy.n++; return get.call(this) } })
  return spy
}

// 在一組格子實例上數 data-af-picked 被加上／拿掉幾次
function spyPickedOps(cells) {
  const ops = { add: 0, remove: 0 }
  for (const cell of cells) {
    const set = cell.setAttribute.bind(cell)
    const rm = cell.removeAttribute.bind(cell)
    cell.setAttribute = (name, v) => { if (name === 'data-af-picked') ops.add++; return set(name, v) }
    cell.removeAttribute = (name) => { if (name === 'data-af-picked') ops.remove++; return rm(name) }
  }
  return ops
}

test('7A-1 同一張表連續 hover 10 格：整表描述與資料列只算一次', async () => {
  const { doc, pm, win } = await boot()
  const table = doc.getElementById('t')
  // 不會被 hover 的那一列：只有「整表掃描」（型別描述逐列數格、資料列逐列判表頭）才會讀到它
  const far = doc.getElementById('r25')
  // 基準：一次 detectKind 會讀這一列幾次（直接呼叫既有匯出量出來）
  const probe = spyRowCells(win, far)
  detectKind(table)
  const perDescribe = probe.n
  assert.ok(perDescribe > 0, '前提：整表描述確實會逐列讀格子，否則這個計數器量不到東西')
  probe.n = 0

  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, cellEl(doc, 0, 0))
  assert.equal(pm.currentTarget()?.id, 't', '前提：目標要升級成那張表')
  const afterFirst = probe.n
  assert.ok(afterFirst >= perDescribe, `第一次 hover 至少要做一次整表描述（${afterFirst} < ${perDescribe}）`)

  for (let i = 1; i < 10; i++) move(win, cellEl(doc, i, i % COLS))
  assert.equal(probe.n, afterFirst,
    `後 9 次 hover 不得再掃整表：第一次讀 ${afterFirst} 次、10 次後共 ${probe.n} 次（一次整表描述＝${perDescribe} 次）`)
  // 行為不變：最後一格照常被標成待選
  assert.ok(cellEl(doc, 9, 1).hasAttribute('data-af-cell'), '最後 hover 的那一格要被標成待選')
  pm.exitPickMode()
})

test('7A-2 表格插一列後下一次 hover 重新計算，選到的是新的列', async () => {
  const { doc, pm, win } = await boot()
  const far = doc.getElementById('r25')
  const probe = spyRowCells(win, far)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, cellEl(doc, 0, 0))
  move(win, cellEl(doc, 1, 1))
  const warm = probe.n
  move(win, cellEl(doc, 2, 1))
  assert.equal(probe.n, warm, '前提：快取已經熱了')

  // 在最前面插一列（網頁自己更新表格）
  const tbody = doc.querySelector('#t tbody')
  const fresh = doc.createElement('tr')
  fresh.innerHTML = '<td id="n0">新</td><td id="n1">777</td><td id="n2">8</td><td id="n3">9</td>'
  tbody.insertBefore(fresh, tbody.firstChild)

  move(win, doc.getElementById('n1'))
  assert.ok(probe.n > warm, '表格內容變了，下一次 hover 必須重新計算（快取失效）')
  click(win, doc.getElementById('n1'))
  move(win, cellEl(doc, 5, 2))
  click(win, cellEl(doc, 5, 2))
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 2, `兩格都要選得到：${JSON.stringify(picks)}`)
  assert.equal(picks[0].cell.row.index, 0, '新插入的那一列是第 0 列')
  assert.equal(picks[0].cell.col.index, 1)
  assert.equal(picks[1].cell.row.index, 6, '原本第 5 列往下推成第 6 列')
  assert.ok(doc.getElementById('n1').hasAttribute('data-af-picked'), '新列那一格要被標成已選')
  pm.exitPickMode()
})

test('7A-3 已選 20 格後 hover 換欄：已選標示不全拆再全畫，增刪只跟差集有關', async () => {
  const { doc, pm, win } = await boot()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  for (let r = 0; r < 20; r++) {
    move(win, cellEl(doc, r, 0))
    click(win, cellEl(doc, r, 0))
  }
  assert.equal(pm.selectedCount(), 20, '前提：已選 20 格')
  const pickedCells = Array.from({ length: 20 }, (_, r) => cellEl(doc, r, 0))
  assert.ok(pickedCells.every(el => el.hasAttribute('data-af-picked')), '前提：20 格都有已選標示')

  const all = Array.from(doc.querySelectorAll('#t td'))
  const ops = spyPickedOps(all)
  // hover 從 B 欄移到 C 欄、再到 D 欄（三次 hover，已選集合沒變）
  move(win, cellEl(doc, 3, 1))
  move(win, cellEl(doc, 3, 2))
  move(win, cellEl(doc, 7, 3))
  assert.deepEqual(ops, { add: 0, remove: 0 }, `已選集合沒變，hover 不得增刪已選標示：${JSON.stringify(ops)}`)
  assert.ok(pickedCells.every(el => el.hasAttribute('data-af-picked')), '20 格的已選標示都還在')

  // 再加一格：只多畫那一格
  click(win, cellEl(doc, 7, 3))
  assert.deepEqual(ops, { add: 1, remove: 0 }, `加一格只該新增一個標示：${JSON.stringify(ops)}`)
  // 再點一次取消：只拿掉那一格
  move(win, cellEl(doc, 7, 3))
  click(win, cellEl(doc, 7, 3))
  assert.deepEqual(ops, { add: 1, remove: 1 }, `取消一格只該移除一個標示：${JSON.stringify(ops)}`)
  assert.ok(!cellEl(doc, 7, 3).hasAttribute('data-af-picked'))
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 20, '畫面上的已選標示仍是那 20 格')
  pm.exitPickMode()
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 0, '離開選取模式後已選標示全部清掉')
})

test('7A-4 連續進出兩次：第二次快取與觀察器是新的，選取結果正確', async () => {
  const { doc, pm, win, observers } = await boot()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, cellEl(doc, 2, 1))
  click(win, cellEl(doc, 2, 1))
  assert.equal(pm.selectedPicks()[0].cell.row.index, 2)
  assert.equal(observers.length, 1, '第一輪要觀察那張表')
  pm.exitPickMode()
  assert.equal(observers[0].disconnected, true, '離開選取模式時第一輪的觀察器要 disconnect')

  // 兩輪之間網頁改了表格：這時沒有任何觀察器在看，只有「快取整個換新」才不會沿用舊列清單
  const tbody = doc.querySelector('#t tbody')
  const fresh = doc.createElement('tr')
  fresh.innerHTML = '<td>新</td><td>1</td><td>2</td><td>3</td>'
  tbody.insertBefore(fresh, tbody.firstChild)

  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, cellEl(doc, 2, 1))
  click(win, cellEl(doc, 2, 1))
  const picks = pm.selectedPicks()
  assert.equal(picks.length, 1)
  assert.equal(picks[0].cell.row.index, 3, `第二輪要用新的列清單（原第 2 列已變第 3 列），實得 ${picks[0].cell.row.index}`)
  assert.equal(observers.length, 2, '第二輪要建新的觀察器')
  assert.notEqual(observers[1], observers[0])
  assert.equal(observers[1].disconnected, false)
  pm.exitPickMode()
  assert.equal(observers[1].disconnected, true)
})
