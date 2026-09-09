// AF-7 批次 A:單格選取修正（巢狀表格、預覽取所選值、Picker 認得單格、重選勾得回來）
// 對照 docs/AF-7-PLAN.md 批次 A 的驗收 A-1 ~ A-6。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { parseTable, columnHeaders, getDataRows, rowHeader } from '../src/shared/table.js'
import { detectKind } from '../src/shared/block-detect.js'
import { extractValue } from '../src/shared/extract.js'

const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

function el(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`)
  return dom.window.document.body.firstElementChild
}

function monitorTable() {
  const dom = new JSDOM(`<!doctype html><body>${MONITOR}</body>`)
  return dom.window.document.querySelector('table')
}

// 第一台主機（10.231.1.31）在外層表格的第幾個資料列：標題列、欄名列之後
const FIRST_IP_ROW = 2
const VALUE_COL = 2

// ---------- A-1 純包裝表才往內鑽 ----------

test('A-1 外層表格自己就是資料表時不得鑽進格子裡的小表格', () => {
  const t = parseTable(monitorTable())
  const row = t.cells[FIRST_IP_ROW]
  assert.ok(Array.isArray(row), `第 ${FIRST_IP_ROW} 列要存在，實得 ${t.cells.length} 列`)
  assert.equal(row.length, 4, '外層表格是 4 欄（colspan 展開後）')
  assert.equal(row[1], '10.231.1.31')
  assert.equal(row[VALUE_COL], '42MAX:462', '格內小表格的文字扁平化成那一格的內容')
  assert.ok(t.cells.length >= 8, `每台主機各一列，實得 ${t.cells.length} 列`)
})

test('A-1 純包裝的表格（只有一格、格內就是表格）仍要鑽到內層', () => {
  const r = parseTable(el(`<table><tbody><tr><td>
      <table><tbody><tr><td>1</td><td>2</td></tr>
      <tr><td>3</td><td>4</td></tr></tbody></table>
    </td></tr></tbody></table>`))
  assert.deepEqual(r.cells, [['1', '2'], ['3', '4']])
})

test('A-1 另一格有文字就不是純包裝，不得往內鑽', () => {
  const r = parseTable(el(`<table><tbody><tr><td>甲</td><td>
      <table><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
    </td></tr></tbody></table>`))
  assert.deepEqual(r.cells, [['甲', '12']], '外層才是資料表，內層表格只是那一格的內容')
})

test('A-1 兩格各有一張表格也不是純包裝', () => {
  const r = parseTable(el(`<table><tbody><tr>
      <td><table><tbody><tr><td>1</td></tr></tbody></table></td>
      <td><table><tbody><tr><td>2</td></tr></tbody></table></td>
    </tr></tbody></table>`))
  assert.deepEqual(r.cells, [['1', '2']])
})

test('A-1 rowHeader 取那一列第一個非空文字（外層第一格是空 span）', () => {
  const rows = getDataRows(monitorTable())
  assert.equal(rowHeader(rows[FIRST_IP_ROW]), '10.231.1.31')
})

test('A-1 外層容器（div）包著表格時仍找得到欄名與資料列', () => {
  const wrap = el(`<div><table>
      <thead><tr><th>甲</th><th>乙</th></tr></thead>
      <tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>`)
  assert.deepEqual(columnHeaders(wrap), ['甲', '乙'], '選取模式常把容器當目標，不能因此變成空的')
  assert.equal(getDataRows(wrap).length, 1)
})

test('A-1 沒有 th 的表格 columnHeaders 是空陣列，定位只能靠索引', () => {
  assert.deepEqual(columnHeaders(monitorTable()), [])
})

// ---------- A-1b 端到端：這一格抓得到 42 ----------

test('A-1b 以單格規格擷取監控頁的值', () => {
  const res = extractValue(monitorTable(), {
    mode: 'block',
    block: {
      cell: {
        row: { index: FIRST_IP_ROW, header: '10.231.1.31' },
        col: { index: VALUE_COL, header: '' }
      }
    }
  })
  assert.equal(res.ok, true, `應抓得到值，實得 ${JSON.stringify(res)}`)
  assert.equal(res.value, 42)
  assert.equal(res.raw, '42MAX:462')
  assert.equal(res.status, 'ok')
})

test('A-1b 主機換位置時跟著列標題走並標示備援', () => {
  const dom = new JSDOM(`<!doctype html><body>${MONITOR}</body>`)
  const table = dom.window.document.querySelector('table')
  const tbody = table.querySelector('tbody')
  const rows = Array.from(tbody.querySelectorAll('tr')).filter(r => r.closest('table') === table)
  // 把第一台主機那一列搬到最後
  tbody.appendChild(rows[FIRST_IP_ROW])
  const res = extractValue(table, {
    mode: 'block',
    block: {
      cell: {
        row: { index: FIRST_IP_ROW, header: '10.231.1.31' },
        col: { index: VALUE_COL, header: '' }
      }
    }
  })
  assert.equal(res.ok, true)
  assert.equal(res.value, 42, '跟著列標題走，不是照舊索引拿到別台主機的值')
  assert.equal(res.status, 'fallback')
})

// ---------- A-2 型別偵測 ----------

test('A-2 detectKind 對監控頁回報外層表格的規模', () => {
  const info = detectKind(monitorTable())
  assert.equal(info.kind, 'table')
  assert.equal(info.cols, 4)
  assert.ok(info.rows >= 8, `列數要是主機數量等級，實得 ${info.rows}`)
})

test('A-2 純包裝表格仍描述內層', () => {
  const info = detectKind(el(`<table><tbody><tr><td>
      <table><tbody><tr><td>1</td><td>2</td></tr>
      <tr><td>3</td><td>4</td></tr></tbody></table>
    </td></tr></tbody></table>`))
  assert.equal(info.cols, 2)
  assert.equal(info.rows, 2)
})

// ---------- A-3 選取模式:點內層小表格的數字要對到外層那一格 ----------

async function enterOnMonitor() {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${MONITOR}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  const outer = doc.querySelector('table')
  pm.enterPickMode({ purpose: 'task', initialTarget: outer })
  return { c, doc, pm, outer, win: jd.window }
}

// 第一台主機那一格裡、顯示 42 的那個內層 td
const valueCell = (doc) => doc.querySelectorAll('table table td')[0]

function fire(win, el, type, init = {}) {
  el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
}

const pickedMsgs = (c) => c.__calls
  .filter(x => x.api === 'runtime.sendMessage')
  .map(x => x.args[0])
  .filter(m => m?.type === 'PICKED')

// AF-8 批次 A 推翻 AF-7 的「格子歸屬一律以外層目標表格為準」：
// 外層那一格的文字是內層小表整串接起來的（這裡是 42MAX:462，實站是 2553039806），
// 解析出來的數字只是「碰巧第一個」。改成點哪一格就是哪一格，外層仍可用 ↑ 取回。
test('A-3 點內層小表格的數字，送出的就是內層那一格', async () => {
  const { c, doc, pm, win } = await enterOnMonitor()
  const cell = valueCell(doc)
  assert.equal(cell.textContent.trim(), '42', 'fixture 的第一個內層格子應該是 42')
  fire(win, cell, 'mousemove')
  fire(win, cell, 'click')
  fire(win, cell, 'dblclick')
  const msgs = pickedMsgs(c)
  assert.equal(msgs.length, 1, '要送出一則 PICKED')
  const pick = msgs[0].picks[0]
  assert.ok(pick.cell, `要是單一儲存格，實得 ${JSON.stringify(pick)}`)
  assert.equal(pick.cell.col.index, 0, '內層小表的第一欄')
  assert.equal(msgs[0].previewValue, 42)
  pm.exitPickMode()
})

test('A-3 預覽是所選那一格的文字，不是整格串接', async () => {
  const { c, doc, pm, win } = await enterOnMonitor()
  fire(win, valueCell(doc), 'mousemove')
  fire(win, valueCell(doc), 'click')
  fire(win, valueCell(doc), 'dblclick')
  const msg = pickedMsgs(c)[0]
  assert.equal(msg.preview, '42', `實得 ${JSON.stringify(msg.preview)}`)
  assert.equal(msg.previewValue, 42)
  pm.exitPickMode()
})

test('A-3 按 ↑ 可以改選外層表格的那一格（保留 AF-7 的用法）', async () => {
  const { c, doc, pm, win } = await enterOnMonitor()
  fire(win, valueCell(doc), 'mousemove')
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  fire(win, valueCell(doc).closest('table').parentElement, 'mousemove')
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const msg = pickedMsgs(c)[0]
  assert.ok(msg.picks[0].cell, `實得 ${JSON.stringify(msg.picks[0])}`)
  assert.equal(msg.picks[0].cell.row.header, '10.231.1.31', '外層表格才有主機當列標題')
  assert.equal(msg.picks[0].cell.col.index, VALUE_COL)
  pm.exitPickMode()
})

test('A-3b 外層那一格內含表格時，面板要先說出「會抓到整串文字」（AF-10 作業 D）', async () => {
  const { doc, pm, win } = await enterOnMonitor()
  fire(win, valueCell(doc), 'mousemove')
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  fire(win, valueCell(doc).closest('table').parentElement, 'mousemove')
  const text = doc.querySelector('[data-af-panel]')?.textContent || ''
  assert.ok(text.includes('這一格內含表格'),
    `外層格的文字是內層小表串接起來的，面板要說出來，實得：${text.slice(0, 200)}`)
  pm.exitPickMode()
})

test('A-3 選整欄時預覽描述那一欄，不帶整張表的數字', async () => {
  const { c, doc, pm, win } = await enterOnMonitor()
  fire(win, valueCell(doc), 'mousemove')
  fire(win, valueCell(doc), 'contextmenu')
  doc.querySelector('[data-af-menu-item="col"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const msg = pickedMsgs(c)[0]
  assert.ok(msg.picks[0].block, '要是整欄聚合')
  assert.equal(msg.previewValue, undefined, '整欄沒有單一數值可預覽')
  assert.ok(/欄/.test(msg.preview), `預覽要描述那一欄，實得 ${JSON.stringify(msg.preview)}`)
  pm.exitPickMode()
})

// ---------- A-4 Picker 認得單格 ----------

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, pk, doc: jd.window.document }
}

const CELL = {
  row: { index: FIRST_IP_ROW, header: '10.231.1.31' },
  col: { index: VALUE_COL, header: '' }
}

test('A-4 單格 pick 要組成單格規格，不得變成整欄聚合', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({
    tabId: 1,
    locator: { css: '#t' },
    preview: '42MAX:462',
    previewValue: 42,
    picks: [{ cell: CELL }],
    blockInfo: { kind: 'table', rows: 9, cols: 4 }
  })
  doc.getElementById('name').value = '客戶區連線數'
  const values = pk.getFormData()
  assert.deepEqual(values.block?.cell, CELL, `要帶單格規格，實得 ${JSON.stringify(values.block)}`)
  assert.equal(values.block.axis, undefined, '單格沒有軸')
  const spec = pk.buildSpec(values)
  assert.equal(spec.mode, 'block')
  assert.deepEqual(spec.block, { cell: CELL }, `實得 ${JSON.stringify(spec.block)}`)
})

test('A-4 只有一格時聚合下拉要隱藏', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ tabId: 1, locator: { css: '#t' }, picks: [{ cell: CELL }] })
  const aggRow = doc.getElementById('block-aggregate')?.closest('label, div, tr')
  assert.ok(aggRow, '找得到聚合下拉那一列')
  assert.equal(aggRow.hidden, true, '一格就是一個值，沒有東西要聚合')
})

test('A-4 摘要要說出選了哪一格', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ tabId: 1, locator: { css: '#t' }, picks: [{ cell: CELL }] })
  const summary = doc.getElementById('block-summary').textContent
  assert.ok(/這一格/.test(summary), `摘要要說是一格，實得 ${JSON.stringify(summary)}`)
  assert.ok(summary.includes('10.231.1.31'), `摘要要說是哪一格，實得 ${JSON.stringify(summary)}`)
})

test('A-4 編輯既有單格任務時摘要與規格都保住', async () => {
  const { pk } = await freshPicker()
  const task = {
    id: 't1', name: '客戶區', url: 'https://x.example/', order: 1,
    mode: 'block', locator: { css: '#t' },
    spec: { mode: 'block', block: { cell: CELL } }
  }
  pk.render({ task, locator: task.locator, url: task.url })
  const spec = pk.buildSpec(pk.getFormData())
  assert.deepEqual(spec.block, { cell: CELL }, '編輯不得把單格改成整欄')
})

// ---------- A-5 重選勾得回原本那一格 ----------

test('A-5 單格任務的 preselect 形狀是 { cell }', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask({
    id: 't1', name: '客戶區', url: 'https://x.example/', order: 1, enabled: true,
    mode: 'block', locator: { css: '#t' },
    spec: { mode: 'block', block: { cell: CELL } }
  })
  await import('../src/background/main.js?t=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  await new Promise((resolve, reject) => {
    const ret = listener({ type: 'ENTER_PICK', tabId: 5, taskId: 't1', purpose: 'repick' }, {}, resolve)
    if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
  })
  const enter = c.__calls
    .filter(x => x.api === 'tabs.sendMessage')
    .map(x => x.args[1])
    .find(m => m?.type === 'ENTER_PICK')
  assert.ok(enter, '要對頁面送 ENTER_PICK')
  assert.deepEqual(enter.preselect, [{ cell: CELL }], `實得 ${JSON.stringify(enter.preselect)}`)
})

test('A-5 選取模式收到單格 preselect 要勾得回來', async () => {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${MONITOR}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const outer = jd.window.document.querySelector('table')
  pm.enterPickMode({ purpose: 'repick', initialTarget: outer, preselect: [{ cell: CELL }] })
  assert.equal(pm.selectedCount(), 1, '原本那一格要勾回來')
  pm.exitPickMode()
})

// ---------- A-6 鏈結:PICKED 的單格一路到 Picker 的規格 ----------

test('A-6 PICKED{picks:[{cell}]} 一路走到 Picker 的 buildSpec', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  await new Promise((resolve, reject) => {
    const ret = listener({
      type: 'PICKED', purpose: 'task',
      locator: { css: '#t' }, preview: '42MAX:462', previewValue: 42,
      blockInfo: { kind: 'table', rows: 9, cols: 4 },
      picks: [{ cell: CELL }]
    }, { tab: { id: 3, url: 'https://x.example/' } }, resolve)
    if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
  })
  const created = c.__calls.find(x => x.api === 'windows.create')
  const url = created.args[0].url
  const ctx = JSON.parse(decodeURIComponent(url.split('?ctx=')[1]))
  assert.deepEqual(ctx.picks, [{ cell: CELL }], 'background 不得丟掉單格')

  const jd = new JSDOM(PICKER_HTML)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render(ctx)
  jd.window.document.getElementById('name').value = '客戶區連線數'
  const spec = pk.buildSpec(pk.getFormData())
  assert.deepEqual(spec.block, { cell: CELL }, '從選取到規格，單格不得中途變成整欄')
})
