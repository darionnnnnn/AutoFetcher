// AF-14 批次 B：試抓失敗時匯出診斷包（content 產生 → fetcher 彙整 → Picker 匯出）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

// ---- 產生端：content script 擷取失敗時要附上頁面現況 ----

async function contentWith(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`,
    { url: 'https://target.test/inner?token=abc' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  // content script 有「同一頁不重複註冊」的冪等守衛，換一份文件要跟著重設
  delete globalThis.__afContentLoaded
  await import('../src/content/main.js?t=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  return { c, listener, doc: jd.window.document }
}

const send = (listener, msg) => new Promise((resolve) => {
  const ret = listener(msg, {}, resolve)
  if (ret !== true) resolve(undefined)
})

const TABLE = `<table id="t">
  <thead><tr><th>幣別</th><th>買入</th></tr></thead>
  <tbody><tr><td>歐元</td><td>34.1</td></tr><tr><td>日圓</td><td>0.21</td></tr></tbody></table>`

const LOC = { css: '#t', path: 'body > table', anchor: null, xpath: '/html[1]/body[1]/table[1]' }
const MISS_SPEC = {
  mode: 'block',
  block: { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } }
}

test('B1-1 擷取失敗要附上頁面現況：表格摘要與 HTML 片段', async () => {
  const { listener } = await contentWith(TABLE)
  const res = await send(listener, { type: 'EXTRACT', locator: LOC, spec: MISS_SPEC })
  assert.equal(res.ok, false)
  const page = res.debug?.page
  assert.ok(page, '沒有現況就等於使用者回報「抓不到」時我們什麼都看不到')
  assert.equal(page.table.source, 'table')
  assert.deepEqual(page.table.headers, ['幣別', '買入'])
  assert.deepEqual(page.table.rowHeaders, ['歐元', '日圓'], '列標題要是原文，不是過濾過的錨點')
  assert.equal(page.table.rowCount, 2)
  assert.ok(Array.isArray(page.table.cells) && page.table.cells.length === 2)
  assert.ok(page.html.includes('<table'), 'HTML 片段要看得到那張表')
  assert.equal(page.truncated, false)
})

test('B1-2 成功時不得附診斷（沒有消費端的資料就是浪費訊息大小）', async () => {
  const { listener } = await contentWith(TABLE)
  const spec = {
    mode: 'block',
    block: { cell: { row: { index: 0, header: '歐元' }, col: { index: 1, header: '買入' } } }
  }
  const res = await send(listener, { type: 'EXTRACT', locator: LOC, spec })
  assert.equal(res.ok, true)
  assert.equal(res.debug, undefined)
})

test('B1-3 HTML 片段超過上限要截斷並標記，不得靜默截掉', async () => {
  const filler = 'x'.repeat(200)
  const rows = Array.from({ length: 40 }, (_, i) =>
    `<tr><td>列${i}${filler}</td><td>${i}</td></tr>`).join('')
  const big = `<table id="t"><thead><tr><th>名稱</th><th>值</th></tr></thead><tbody>${rows}</tbody></table>`
  const { listener } = await contentWith(big)
  const res = await send(listener, { type: 'EXTRACT', locator: LOC, spec: MISS_SPEC })
  const page = res.debug.page
  assert.ok(page.html.length <= 4000, `實際 ${page.html.length}`)
  assert.equal(page.truncated, true)
  assert.ok(page.table.cells.length <= 20, '列數要收斂，不能把整張表倒進來')
  assert.equal(page.table.rowCount, 40, '真正的總列數仍要說出來')
})

// ---- 彙整端：background 的 dryRun 出口 ----

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fetcher = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, fetcher }
}

const TASK = {
  id: '__preview',
  name: '試抓',
  url: 'https://target.test/page',
  locator: LOC,
  spec: MISS_SPEC,
  frame: { url: 'https://target.test/inner' }
}

test('B2-1 試抓失敗的回應要帶得出分頁網址、框架候選與錯誤', async () => {
  const { c, fetcher } = await freshBg()
  // 真的建一個分頁：它的網址帶 query，與任務設定的網址不同字，
  // 才驗得出診斷讀的是「分頁實際網址」而不是任務設定
  const tab = await c.tabs.create({ url: 'https://target.test/page?session=7' })
  c.__setTabState(tab.id, { status: 'complete' })
  c.__setScriptResponder((opts) => (opts?.target?.allFrames === true
    ? [{ frameId: 0, result: 'https://target.test/page?session=7' },
       { frameId: 7, result: 'https://target.test/inner?token=zzz' }]
    : []))
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    return {
      ok: false,
      error: 'not_found',
      message: '標題「美金」找不到；目前這張表的列標題是：歐元',
      debug: { page: { table: { headers: ['幣別'] }, html: '<table></table>', truncated: false } }
    }
  })
  const res = await fetcher.runTask(TASK, { dryRun: true, reason: 'manual', tabId: tab.id, ...FAST })
  assert.equal(res.ok, false)
  const d = res.debug
  assert.ok(d, '沒有 debug 就沒有匯出的東西')
  assert.ok(typeof d.at === 'string' && d.at.includes('T'))
  assert.equal(d.tabUrl, 'https://target.test/page?session=7', '要讀分頁實際網址，不是任務設定的網址')
  assert.equal(d.frame.frameId, 7)
  assert.equal(d.frame.matchedBy, 'path')
  assert.ok(Array.isArray(d.frame.candidates) && d.frame.candidates.length === 2)
  assert.equal(d.task.spec.block.cell.row.header, '美金')
  assert.ok(d.error.message.includes('目前這張表的列標題是'))
  assert.ok(d.page, 'content 給的頁面現況要一路帶上來')
  assert.ok(d.version, '版本由 background 填（回報時要對得上是哪一版程式碼）')
})

test('B2-2 找不到框架時也要有診斷（候選清單正是使用者要看的東西）', async () => {
  const { c, fetcher } = await freshBg()
  c.__setTabState(1, { url: 'https://target.test/page', status: 'complete' })
  c.__setScriptResponder((opts) => (opts?.target?.allFrames === true
    ? [{ frameId: 0, result: 'https://target.test/page' },
       { frameId: 3, result: 'https://other.test/x' }]
    : []))
  c.__setTabResponder(() => ({ ok: false, error: 'not_found' }))
  const res = await fetcher.runTask(TASK, { dryRun: true, reason: 'manual', tabId: 1, ...FAST, frameTimeoutMs: 20 })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'frame_not_found')
  assert.ok(res.debug, '框架找不到時最需要診斷，這裡缺席等於白做')
  assert.equal(res.debug.frame.frameId, null)
  assert.ok(res.debug.frame.candidates.some(f => f.url.includes('other.test')))
})

test('B2-3 正式抓取（非試抓）不得帶診斷，紀錄裡也不得有這個欄位', async () => {
  const { c, st, fetcher } = await freshBg()
  c.__setTabState(1, { url: 'https://target.test/page', status: 'complete' })
  c.__setScriptResponder(() => [])
  // content script 是不分模式一律附 debug.page 的，所以這裡要真的回一份，
  // 否則「紀錄裡沒有 debug」在任何實作下都成立（假通過）
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT'
    ? {
      ok: false,
      error: 'not_found',
      message: '標題「美金」找不到',
      debug: { page: { table: { headers: ['幣別'] }, html: '<table></table>', truncated: false } }
    }
    : { ok: true }))
  const task = { ...TASK, id: 't1', frame: undefined }
  await st.saveTask(task)
  const rec = await fetcher.runTask(task, { reason: 'manual', slot: '2026-09-10T09:00', tabId: 1, ...FAST })
  assert.ok(rec, '應該要寫出一筆紀錄')
  assert.equal(rec.debug, undefined, '診斷包不得寫進紀錄（會被存進 storage 一直累積）')
  const diagList = (await chrome.storage.local.get('diag')).diag || []
  assert.equal(diagList.length, 0, '試抓診斷不得占用 500 筆的環形緩衝')
})

// ---- 消費端：Picker 的匯出按鈕 ----

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, pk, doc: jd.window.document }
}

const DEBUG = {
  version: '0.13.0',
  at: '2026-09-10T01:00:00.000Z',
  tabUrl: 'https://target.test/page',
  frame: { frameId: 7, matchedBy: 'path', candidates: [{ frameId: 7, url: 'https://target.test/inner' }] },
  task: { spec: MISS_SPEC, locator: LOC },
  error: { error: 'not_found', message: '標題「美金」找不到' },
  page: { table: { headers: ['幣別', '買入'], rowHeaders: ['歐元'] }, html: '<table></table>', truncated: false }
}

test('B3-1 試抓失敗時出現匯出按鈕，成功時不出現', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ locator: LOC, url: 'https://target.test/page' })
  const btn = doc.getElementById('export-diag')
  assert.ok(btn, 'Picker 要有匯出診斷的入口')
  assert.equal(btn.hidden, true, '還沒測試之前不該出現')

  c.__setRuntimeResponder((msg) => (msg?.type === 'TEST_TASK'
    ? { ok: false, error: 'not_found', message: '標題「美金」找不到', debug: DEBUG }
    : undefined))
  await pk.handleTestNow()
  assert.equal(btn.hidden, false, '失敗時要拿得到診斷')

  c.__setRuntimeResponder((msg) => (msg?.type === 'TEST_TASK' ? { ok: true, value: 31.2 } : undefined))
  await pk.handleTestNow()
  assert.equal(btn.hidden, true, '成功之後上一次的診斷要收起來，不然使用者會匯出到舊的')
})

test('B3-2 按下匯出：檔名可辨識、內容是可讀的 JSON、含關鍵欄位', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ locator: LOC, url: 'https://target.test/page' })
  c.__setRuntimeResponder((msg) => (msg?.type === 'TEST_TASK'
    ? { ok: false, error: 'not_found', message: '標題「美金」找不到', debug: DEBUG }
    : undefined))
  await pk.handleTestNow()

  await pk.handleExportDiag()

  const dl = c.__calls.filter(x => x.api === 'downloads.download')
  assert.equal(dl.length, 1, '要真的送出下載')
  const arg = dl[0].args[0]
  assert.ok(/autofetcher-diag-.*\.json$/.test(arg.filename), `檔名：${arg.filename}`)
  assert.equal(arg.saveAs, true, '檔案一律使用者手動存（SPEC §5）')
  const json = JSON.parse(decodeURIComponent(arg.url.split(',')[1]))
  assert.equal(json.tabUrl, 'https://target.test/page')
  assert.ok(json.version, '要記下擴充功能版本，否則回報時對不上程式碼')
  assert.equal(json.frame.matchedBy, 'path')
  assert.ok(json.error.message.includes('美金'))
})

test('B3-3 按鈕旁要說出診斷包含頁面內容（使用者要知道自己送出的是什麼）', async () => {
  const { doc } = await freshPicker()
  const text = doc.getElementById('export-diag-note')?.textContent || ''
  assert.ok(text.includes('HTML') || text.includes('網址'),
    `要明講內含頁面片段與網址，實際：${text}`)
})

test('B3-4 匯出鈕要真的接上去（mock 沒有 runtime.id，模組層級的接線在測試環境不會執行）', () => {
  const src = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  const wired = src.match(/getElementById\('export-diag'\)\?\.addEventListener/g) || []
  assert.equal(wired.length, 1, '按鈕沒接事件的話，功能寫好了也沒人叫得動')
  assert.ok(/handleExportDiag\(\)/.test(src), '接的要是匯出那個函式')
})

test('B2-4 多值任務個別值失敗時也要有診斷（本輪主打的情境正是多值表格）', async () => {
  const { c, fetcher } = await freshBg()
  c.__setTabState(1, { url: 'https://target.test/page', status: 'complete' })
  c.__setScriptResponder(() => [])
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT'
    ? {
      ok: true,
      fields: {
        a: { ok: true, value: 1 },
        b: { ok: false, error: 'not_found', message: '標題「美金」找不到；目前這張表的列標題是：歐元' }
      }
    }
    : { ok: true }))
  const task = { ...TASK, frame: undefined, spec: { mode: 'block', fields: [{ key: 'a' }, { key: 'b' }] } }
  const res = await fetcher.runTask(task, { dryRun: true, reason: 'manual', tabId: 1, ...FAST })
  assert.equal(res.ok, true, '表格解析得出來就是 ok（SPEC §7），只有個別值失敗')
  assert.ok(res.debug, '整體 ok 但有值失敗時仍要附診斷，否則多值任務永遠匯不出來')
  // 要是 background 真的組的那一份，不是把 content 的回應原樣轉發
  assert.ok(res.debug.version, '診斷包要有版本（只有 background 拿得到 manifest）')
  assert.ok(res.debug.tabUrl, '診斷包要有分頁實際網址')
  assert.ok(res.debug.frame, '診斷包要有框架資訊')
})

test('B2-5 多值任務全部成功時不附診斷', async () => {
  const { c, fetcher } = await freshBg()
  c.__setTabState(1, { url: 'https://target.test/page', status: 'complete' })
  c.__setScriptResponder(() => [])
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT'
    ? { ok: true, fields: { a: { ok: true, value: 1 }, b: { ok: true, value: 2 } } }
    : { ok: true }))
  const task = { ...TASK, frame: undefined, spec: { mode: 'block', fields: [{ key: 'a' }, { key: 'b' }] } }
  const res = await fetcher.runTask(task, { dryRun: true, reason: 'manual', tabId: 1, ...FAST })
  assert.equal(res.debug, undefined)
})

test('B3-5 換了目標之後，上一個目標的診斷不得還留在畫面上', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ locator: LOC, url: 'https://a.test/one' })
  c.__setRuntimeResponder((msg) => (msg?.type === 'TEST_TASK'
    ? { ok: false, error: 'not_found', message: 'x', debug: DEBUG }
    : undefined))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('export-diag').hidden, false)

  // 右鍵重選另一個目標：面板不重開，表單留著，但診斷屬於上一頁
  pk.render({ locator: { css: '#other' }, url: 'https://b.test/two' })
  assert.equal(doc.getElementById('export-diag').hidden, true,
    '按下去會匯出上一頁的網址與 HTML 片段')
})

test('B1-4 多值任務裡有值失敗時，content 也要附頁面現況（整體 ok 不代表沒事）', async () => {
  const { listener } = await contentWith(TABLE)
  const spec = {
    mode: 'block',
    fields: [
      { key: 'a', cell: { row: { index: 0, header: '歐元' }, col: { index: 1, header: '買入' } } },
      { key: 'b', cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } }
    ]
  }
  const res = await send(listener, { type: 'EXTRACT', locator: LOC, spec })
  assert.equal(res.ok, true, '表格解析得出來就是 ok（SPEC §7）')
  assert.equal(res.fields.b.ok, false)
  assert.ok(res.debug?.page?.table, '有值失敗就要附現況，否則診斷包看不到那張表')
  assert.deepEqual(res.debug.page.table.rowHeaders, ['歐元', '日圓'])
})

test('B1-5 多值任務全部成功時不附現況', async () => {
  const { listener } = await contentWith(TABLE)
  const spec = {
    mode: 'block',
    fields: [{ key: 'a', cell: { row: { index: 0, header: '歐元' }, col: { index: 1, header: '買入' } } }]
  }
  const res = await send(listener, { type: 'EXTRACT', locator: LOC, spec })
  assert.equal(res.ok, true)
  assert.equal(res.debug, undefined)
})

test('B2-6 最外層例外（頁面被換掉）的出口也要帶診斷', async () => {
  const { c, fetcher } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://target.test/page' })
  c.__setTabState(tab.id, { status: 'complete' })
  c.__setScriptResponder(() => [])
  // 一直送不到：存活重試耗盡後走最外層 catch（訊息轉成中文那一條路）
  c.__setTabResponder((tabId, msg) => {
    if (msg.type !== 'EXTRACT') return { ok: true }
    throw new Error('Could not establish connection. Receiving end does not exist.')
  })
  const task = { ...TASK, frame: undefined }
  const res = await fetcher.runTask(task, {
    dryRun: true, reason: 'manual', tabId: tab.id, ...FAST, reviveDelaysMs: [1, 1, 1]
  })
  assert.equal(res.ok, false)
  assert.ok(res.debug, '例外出口沒有診斷的話，最難查的那一類失敗反而查不到')
  assert.equal(res.debug.tabUrl, 'https://target.test/page', '例外時仍要讀得到分頁網址')
  assert.ok(res.debug.error.raw, '轉成中文之前的原文要留著，沒有它就沒有線索')
  assert.ok(res.debug.version)
  // 框架其實找到了（最上層），是擷取階段斷線：診斷包不能長得跟「找不到框架」一樣
  assert.equal(res.debug.frame.frameId, 0)
  assert.equal(res.debug.frame.matchedBy, 'top')
})

// ---- 訊息要一路走到紀錄（PLAN：產生端到畫面）----

test('B2-7 正式抓取失敗時，新訊息要寫進紀錄的 error（使用者在歷史頁看得到怎麼辦）', async () => {
  const { c, st, fetcher } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://target.test/page' })
  c.__setTabState(tab.id, { status: 'complete' })
  c.__setScriptResponder(() => [])
  c.__setTabResponder((tabId, msg) => (msg.type === 'EXTRACT'
    ? {
      ok: false,
      error: 'not_found',
      message: '標題「美金」找不到；目前這張表的列標題是：歐元、日圓；若這張表每天新增一列，請到任務設定改用位置定位（第一筆／最後一筆／倒數第二筆）'
    }
    : { ok: true }))
  const task = { ...TASK, id: 'rec1', frame: undefined }
  await st.saveTask(task)
  const rec = await fetcher.runTask(task, { reason: 'manual', slot: '2026-09-11T09:00', tabId: tab.id, ...FAST })
  assert.equal(rec.status, 'not_found')
  assert.ok(String(rec.error).includes('目前這張表的列標題是'),
    `只寫 not_found 等於告訴使用者「壞了」卻不說能怎麼辦，實得 ${rec.error}`)
})
