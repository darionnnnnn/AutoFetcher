// AF-10 作業 D：表格判準收成一份（shared/table.js），選取端與擷取端看到同一張表。
// 對照 docs/AF-10-PLAN.md 作業 D 的驗收。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import {
  tableOf, cellOf, isHeaderCell, tableRowsOf, rowCellsOf, isHeaderRowOf,
  innermostTable, parseTable, getDataRows
} from '../src/shared/table.js'
import { detectKind } from '../src/shared/block-detect.js'
import { extractValue } from '../src/shared/extract.js'
import { resolve as resolveLocator } from '../src/shared/selector.js'

// 純包裝：外層表只有一格，那一格除了內層表沒有自己的文字
const PURE_WRAPPER = `
  <table id="outer"><tbody><tr><td id="wrap">
    <table id="inner"><tbody>
      <tr><th>名稱</th><th>數量</th></tr>
      <tr><td id="c1">甲</td><td id="c2">4200</td></tr>
      <tr><td id="c3">乙</td><td id="c4">5300</td></tr>
    </tbody></table>
  </td></tr></tbody></table>`

// 非純包裝：外層每一列的第二格各包一張小表（外層自己就是資料表）
const PER_ROW_TABLES = `
  <table id="outer2"><tbody>
    <tr><td id="o1">15.122</td><td id="o2"><table id="in1"><tbody><tr><td id="p1">25757</td><td id="p2">39806</td></tr></tbody></table></td></tr>
    <tr><td id="o3">15.131</td><td id="o4"><table id="in2"><tbody><tr><td id="q1">25530</td><td id="q2">39800</td></tr></tbody></table></td></tr>
  </tbody></table>`

const jsdom = (html) => new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document

async function bootPicker(html) {
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
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const picked = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage')
  .map(x => x.args[0]).filter(m => m?.type === 'PICKED' && !m.cancelled)

// ---------- D-1 選取端與擷取端看到同一張表 ----------

test('D-1 滑鼠落在純包裝的外層格上，目標升級成內層資料表', async () => {
  const { doc, pm, win } = await bootPicker(PURE_WRAPPER)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  // 指到包裝用的那一格自己（不是內層的格子）
  move(win, doc.getElementById('wrap'))
  assert.equal(pm.currentTarget()?.id, 'inner',
    `純包裝的外層要鑽到內層資料表，實得 ${pm.currentTarget()?.id}`)
  pm.exitPickMode()
})

test('D-1 外層每列各包小表時不鑽進去，外層就是資料表', async () => {
  const { doc, pm, win } = await bootPicker(PER_ROW_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('o1'))
  assert.equal(pm.currentTarget()?.id, 'outer2', '外層自己有資料，不是純包裝')
  pm.exitPickMode()
})

test('D-1 端到端：純包裝外層被指到，送出的規格擷取回來是使用者看到的那一格', async () => {
  const { c, doc, pm, win } = await bootPicker(PURE_WRAPPER)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  // 先落在包裝格（模擬點在 td 的 padding 上），再點內層那一格送出
  move(win, doc.getElementById('wrap'))
  move(win, doc.getElementById('c4'))
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.ok(msg, '要送出 PICKED')
  const pick = msg.picks[0]
  assert.ok(pick.cell, '應為單格規格')

  // 用送出的 locator 回頭定位，再走 block 擷取：值必須是使用者指到的那一格
  const found = resolveLocator(doc, msg.locator)
  assert.ok(found?.el, '送出的 locator 要定位得回來')
  const res = extractValue(found.el, { mode: 'block', block: { cell: pick.cell } })
  assert.equal(String(res.value), '5300',
    `選取索引與擷取索引必須指向同一張表，實得 ${JSON.stringify(res.value)}`)
  pm.exitPickMode()
})

// ---------- D-2 巢狀過濾：列與格只算自己這張表的 ----------

test('D-2 外層表的列數不含內層小表的列', () => {
  const doc = jsdom(PER_ROW_TABLES)
  const outer = doc.getElementById('outer2')
  assert.equal(tableRowsOf(outer).length, 2, '外層只有兩列')
  assert.equal(rowCellsOf(tableRowsOf(outer)[0]).length, 2, '第一列只有兩格')
})

test('D-2 role=table 容器內含真表格時，不把內層的列算成自己的（多張並列不猜）', () => {
  const doc = jsdom(`<div id="host" role="table">
      <table id="t1"><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>
      <table id="t2"><tbody><tr><td>3</td></tr></tbody></table>
    </div>`)
  const host = doc.getElementById('host')
  assert.equal(tableRowsOf(host).length, 0,
    '兩張並列的小表不能挑第一張當自己的列（會少算且無從得知挑了哪張）')
})

test('D-2 容器只包一張表時以那張表為準', () => {
  const doc = jsdom(`<div id="box"><table id="t"><tbody>
      <tr><td>1</td></tr><tr><td>2</td></tr></tbody></table></div>`)
  assert.equal(tableRowsOf(doc.getElementById('box')).length, 2)
})

test('D-2 ARIA 表格（沒有原生 rows）走 querySelectorAll 那條路，也要做巢狀過濾', () => {
  // ARIA 表格沒有 .rows，一定走退路；第二列的格子裡再包一個 ARIA 表格，
  // 它的列不算外層這張表的列
  const doc = jsdom(`<div id="g" role="grid">
      <div role="row"><span role="cell">甲</span></div>
      <div role="row"><span role="cell">
        <div role="table"><div role="row"><span role="cell">內1</span></div>
          <div role="row"><span role="cell">內2</span></div></div>
      </span></div>
    </div>`)
  const rows = tableRowsOf(doc.getElementById('g'))
  assert.equal(rows.length, 2,
    `外層只有兩列，內層小表的兩列不算，實得 ${rows.length} 列`)
})

test('D-2 ARIA 列（沒有原生 cells）的格子不含巢狀子表格的格子', () => {
  // ARIA 表格沒有 .cells，一定走 querySelectorAll 那條路；
  // 第二格裡包著一個小的 ARIA 表格，它的格子不算外層這一列的
  const doc = jsdom(`<div id="g" role="grid">
      <div id="r" role="row">
        <span role="cell">甲</span>
        <span role="cell"><div role="row"><span role="cell">x</span><span role="cell">y</span></div></span>
      </div>
    </div>`)
  const cells = rowCellsOf(doc.getElementById('r'))
  assert.equal(cells.length, 2,
    `退路不得把格內小表的格子一起吃進來，實得 ${cells.length} 格`)
})

// ---------- D-3 ARIA 判準兩端一致 ----------

test('D-3 role=columnheader 整列算表頭列，資料列不含它', () => {
  const doc = jsdom(`<div id="g" role="grid">
      <div id="h" role="row"><span role="columnheader">甲</span><span role="columnheader">乙</span></div>
      <div id="r1" role="row"><span role="cell">1</span><span role="cell">2</span></div>
    </div>`)
  assert.equal(isHeaderRowOf(doc.getElementById('h')), true, 'role=columnheader 整列就是表頭列')
  assert.equal(isHeaderRowOf(doc.getElementById('r1')), false)
  const dataRows = getDataRows(doc.getElementById('g'))
  assert.equal(dataRows.length, 1, `資料列不該含表頭列，實得 ${dataRows.length}`)
})

test('D-3 isHeaderCell 同時認 th 與 role=columnheader', () => {
  const doc = jsdom('<table><tr><th id="a">x</th><td id="b" role="columnheader">y</td><td id="c">z</td></tr></table>')
  assert.equal(isHeaderCell(doc.getElementById('a')), true)
  assert.equal(isHeaderCell(doc.getElementById('b')), true)
  assert.equal(isHeaderCell(doc.getElementById('c')), false)
})

test('D-3 tableOf / cellOf 認 HTML 與 ARIA 兩種寫法', () => {
  const doc = jsdom(`<table id="t"><tr><td id="td">1</td></tr></table>
    <div id="g" role="grid"><div role="row"><span id="ce" role="cell">2</span></div></div>`)
  assert.equal(tableOf(doc.getElementById('td'))?.id, 't')
  assert.equal(tableOf(doc.getElementById('ce'))?.id, 'g')
  assert.equal(cellOf(doc.getElementById('td'))?.id, 'td')
  assert.equal(cellOf(doc.getElementById('ce'))?.id, 'ce')
})

// ---------- D-4 面板描述與可選索引同源 ----------

test('D-4 detectKind 對純包裝外層回報的規模，與 parseTable 的資料一致', () => {
  const doc = jsdom(PURE_WRAPPER)
  const outer = doc.getElementById('outer')
  const kind = detectKind(outer)
  const parsed = parseTable(innermostTable(outer))
  assert.equal(kind.kind, 'table')
  assert.equal(kind.cols, parsed.headers.length,
    `面板欄數 ${kind.cols} 要等於解析出的欄數 ${parsed.headers.length}`)
  assert.equal(kind.rows - 1, parsed.cells.length,
    '面板列數扣掉表頭列，等於資料列數')
})

test('D-4 掃描：每張表的資料列數 = 全部列數 - 表頭列數（集合非空）', () => {
  const doc = jsdom(`${PURE_WRAPPER}${PER_ROW_TABLES}
    <table id="t3"><thead><tr><th>a</th><th>b</th></tr></thead>
      <tbody><tr><td>1</td><td>2</td></tr></tbody></table>`)
  const tables = Array.from(doc.querySelectorAll('table'))
  assert.ok(tables.length >= 5, `掃描集合不得是空的，實得 ${tables.length} 張表`)
  for (const t of tables) {
    const rows = tableRowsOf(t)
    const headerRows = rows.filter(isHeaderRowOf)
    const data = getDataRows(t)
    if (innermostTable(t) !== t) continue // 純包裝外層的資料列來自內層，另案驗
    assert.equal(data.length, rows.length - headerRows.length,
      `表 ${t.id}：資料列 ${data.length} ≠ 總列 ${rows.length} - 表頭 ${headerRows.length}`)
  }
})

// ---------- D-5 舊的三份判準不得留在原地 ----------

test('D-5 picker-mode 與 block-detect 不再自己定義表格列格判準', () => {
  const pm = readFileSync(new URL('../src/content/picker-mode.js', import.meta.url), 'utf8')
  const bd = readFileSync(new URL('../src/shared/block-detect.js', import.meta.url), 'utf8')
  for (const [name, src] of [['picker-mode.js', pm], ['block-detect.js', bd]]) {
    for (const fn of ['function getRowCells', 'function isHeaderRow', 'function getTableRows', 'function getRows']) {
      assert.equal(src.includes(fn), false, `${name} 不該再有 ${fn}（判準已收進 shared/table.js）`)
    }
  }
  assert.ok(pm.includes("from '../shared/table.js'"), 'picker-mode 要改用 shared/table.js')
  assert.ok(bd.includes("from './table.js'"), 'block-detect 要改用 shared/table.js')
})

test('D-3b ARIA 的 role=rowheader 也算一格（漏掉會讓整列索引位移）', () => {
  const doc = jsdom(`<div id="g" role="grid">
      <div id="r" role="row">
        <span role="rowheader">美金</span><span role="cell">31.5</span><span role="cell">32.0</span>
      </div>
    </div>`)
  const cells = rowCellsOf(doc.getElementById('r'))
  assert.equal(cells.length, 3,
    `列標題格不算格的話，這一列的欄索引會整排少一格，實得 ${cells.length}`)
})
