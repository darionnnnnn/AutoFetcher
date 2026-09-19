// AF-21 體檢修正段 Y：Picker 面板（批次簽章／進行中重畫／守門殘留／前置動作計數）、
// popup 的「知道了」、站台測試登入換分頁、診斷包匯出失敗、選取模式（代理層失效、中鍵、stale 提示）。
// 每一條都對應體檢探針抓到的實況，測試守的是修好之後的行為。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const SITE_HTML = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
const POPUP_HTML = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')

const URL_ = 'https://rate.test/p'
const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

const batchItem = (key, css, name) => ({
  key, locator: { css }, url: URL_, tabId: 9, nameHint: name, picks: [{ locator: { css } }]
})
const batchKeys = (doc) => Array.from(doc.querySelectorAll('#batch-list [data-batch-item]'))
  .map(r => r.getAttribute('data-batch-key'))
const reasonTexts = (doc) => Array.from(doc.querySelectorAll('#errors button')).map(b => b.textContent)

// ---- 1. 批次的 items 要算進面板重畫簽章 ----

test('Y1 第二輪批次選取：items 變了就要重畫（簽章要含 items）', async () => {
  const { pk, doc } = await freshPicker()
  const first = await pk.renderFromPanelCtx({ kind: 'batch', items: [batchItem('b1', '#a', '甲'), batchItem('b2', '#b', '乙')] })
  assert.equal(first.rendered, true)
  assert.deepEqual(batchKeys(doc), ['b1', 'b2'])
  const second = await pk.renderFromPanelCtx({
    kind: 'batch',
    items: [batchItem('b1', '#a', '甲'), batchItem('b2', '#b', '乙'), batchItem('b3', '#c', '丙')]
  })
  assert.equal(second.rendered, true, '多了一組卻被當成沒變：畫面不更新、全部儲存會存到舊目標')
  assert.deepEqual(batchKeys(doc), ['b1', 'b2', 'b3'])
})

// ---- 2. 批次進行中的重畫只延後、不丟 ----

test('Y2 全部試抓進行中收到重畫：延後到結束後補一次', async () => {
  const { c, pk, doc } = await freshPicker()
  await pk.renderFromPanelCtx({ kind: 'batch', items: [batchItem('b1', '#a', '甲'), batchItem('b2', '#b', '乙')] })
  let release = null
  c.__setRuntimeResponder((m) => (m?.type === 'TEST_TASK'
    ? new Promise(r => { release = () => r({ ok: true, value: 42 }) })
    : undefined))
  const running = pk.handleTestNow()
  await sleep(10)
  assert.equal(typeof release, 'function', '前提：全部試抓已經開始')

  const mid = await pk.renderFromPanelCtx({
    kind: 'batch',
    items: [batchItem('b1', '#a', '甲'), batchItem('b2', '#b', '乙'), batchItem('b3', '#c', '丙')]
  })
  assert.equal(mid.deferred, true, '進行中不得重畫：清單會被換掉、結果寫進孤兒節點')
  assert.deepEqual(batchKeys(doc), ['b1', 'b2'], '進行中清單要維持原樣')

  release()
  await sleep(10)
  if (typeof release === 'function') release()
  await running
  await sleep(10)
  assert.deepEqual(batchKeys(doc), ['b1', 'b2', 'b3'], '被延後的重畫要補畫，不得丟掉')
})

test('Y2b 全部儲存進行中收到重畫：一樣延後到結束後補一次', async () => {
  const { c, pk, doc } = await freshPicker()
  await pk.renderFromPanelCtx({ kind: 'batch', items: [batchItem('b1', '#a', '甲'), batchItem('b2', '#b', '乙')] })
  let release = null
  c.__setRuntimeResponder((m) => (m?.type === 'REBUILD_ALARMS'
    ? new Promise(r => { release = () => r({ ok: true }) })
    : undefined))
  const running = pk.handleSave()
  await sleep(20)
  assert.equal(typeof release, 'function', '前提：全部儲存已經開始（卡在重建排程）')
  const mid = await pk.renderFromPanelCtx({
    kind: 'batch',
    items: [batchItem('b1', '#a', '甲'), batchItem('b2', '#b', '乙'), batchItem('b3', '#c', '丙')]
  })
  assert.equal(mid.deferred, true, '儲存進行中不得重畫')
  release()
  await running
  await sleep(10)
})

// ---- 3. 守門殘留：換畫面的每個入口都要清 ----

test('Y3a 換目標（retarget 與全新 render）都要清掉守門區', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ locator: LOCATOR, url: URL_ })
  doc.getElementById('name').value = ''
  await pk.handleSave()
  assert.deepEqual(reasonTexts(doc), ['名稱不可空白'], '前提：按儲存會列出原因')
  assert.equal(doc.getElementById('name').getAttribute('aria-invalid'), 'true')

  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: { locator: { css: '#w' }, url: 'https://rate.test/q', picks: [{ locator: { css: '#w' } }] }
  })
  assert.deepEqual(reasonTexts(doc), [], 'retarget 後原因不得殘留（那是上一個目標的事）')
  assert.equal(doc.getElementById('errors').hidden, true)
  assert.equal(doc.getElementById('name').getAttribute('aria-invalid'), null)
  assert.equal(doc.getElementById('save-missing').textContent, '')
  assert.equal(doc.getElementById('save-missing').hidden, true)

  doc.getElementById('name').value = ''
  await pk.handleSave()
  assert.equal(reasonTexts(doc).length, 1)
  await pk.renderFromPanelCtx({ kind: 'new', ctx: { locator: { css: '#z' }, url: URL_, picks: [{ locator: { css: '#z' } }] } })
  assert.deepEqual(reasonTexts(doc), [], '全新 render 後也不得殘留')
  assert.equal(doc.getElementById('save-missing').textContent, '')
})

test('Y3b 單任務守門 → 整批改排程：守門區要清乾淨', async () => {
  const { st, pk, doc } = await freshPicker()
  await st.saveTask({
    id: 't1', name: '甲', url: URL_, locator: LOCATOR,
    schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }, spec: {}
  })
  pk.render({ locator: LOCATOR, url: URL_ })
  doc.getElementById('name').value = ''
  await pk.handleSave()
  assert.equal(reasonTexts(doc).length, 1, '前提：單任務畫面有守門原因')

  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['t1'] })
  assert.deepEqual(reasonTexts(doc), [], '整批改排程畫面沒有名稱欄，原因留著就是指不到的死訊息')
  assert.equal(doc.getElementById('errors').hidden, true)
  assert.equal(doc.getElementById('save-missing').textContent, '')
  assert.equal(doc.getElementById('name').getAttribute('aria-invalid'), null)
  const nameErr = doc.getElementById('name-error')
  if (nameErr) assert.equal(nameErr.textContent, '', '欄位下的錯誤字也要清')
})

test('Y3c 批次守門 → 單任務：守門區要清乾淨', async () => {
  const { pk, doc } = await freshPicker()
  await pk.renderFromPanelCtx({
    kind: 'batch',
    items: [batchItem('b1', '#a', '甲'), { key: 'b2', url: URL_, tabId: 9, nameHint: '乙', picks: [] }]
  })
  await pk.handleSave()
  assert.equal(reasonTexts(doc).length >= 1, true, '前提：批次守門會指名哪一組不行')

  await pk.renderFromPanelCtx({ kind: 'new', ctx: { locator: LOCATOR, url: URL_, picks: [{ locator: LOCATOR }] } })
  assert.deepEqual(reasonTexts(doc), [], '回到單任務不得留著「第 2 組」的原因')
  assert.equal(doc.getElementById('save-missing').textContent, '')
  assert.equal(doc.querySelectorAll('[aria-invalid]').length, 0, '批次那幾列標的 aria-invalid 也要清')
})

test('Y3d 批次守門 → 等待態：離開批次畫面就要清掉守門區', async () => {
  const { pk, doc } = await freshPicker()
  await pk.renderFromPanelCtx({
    kind: 'batch',
    items: [batchItem('b1', '#a', '甲'), { key: 'b2', url: URL_, tabId: 9, nameHint: '乙', picks: [] }]
  })
  await pk.handleSave()
  assert.equal(reasonTexts(doc).length >= 1, true, '前提：批次守門會指名哪一組不行')

  // 使用者回頁面重新選（面板回到等待態）：這裡不經 render，只有 setBatchView(false)
  await pk.renderFromPanelCtx({ kind: 'waiting', batch: true })
  assert.deepEqual(reasonTexts(doc), [], '等待態上留著上一輪的原因，使用者按不到也改不掉')
  assert.equal(doc.getElementById('save-missing').textContent, '')
})

// ---- 4. 前置動作「已設定 N 步」計數殘留 ----

const taskWithPre = {
  name: 'T', url: URL_, spec: {},
  preActions: [{ type: 'wait', sec: 2 }, { type: 'wait', sec: 3 }],
  schedule: { type: 'daily', times: ['09:00'], weekdays: [1] }
}

test('Y4a 單任務 → 批次：前置動作列清空了，「已設定 N 步」要跟著歸零', async () => {
  const { pk, doc } = await freshPicker()
  await pk.renderFromPanelCtx({
    kind: 'new',
    ctx: { locator: { css: '#a' }, url: URL_, picks: [{ locator: { css: '#a' } }], task: taskWithPre }
  })
  const cnt = doc.getElementById('preaction-count')
  assert.equal(cnt.textContent, '已設定 2 步', '前提：單任務畫面有兩步')

  await pk.renderFromPanelCtx({ kind: 'batch', items: [batchItem('b1', '#a', '甲'), batchItem('b2', '#b', '乙')] })
  assert.equal(doc.querySelectorAll('#preaction-list [data-preaction-row]').length, 0, '前提：批次會清空共用的前置動作列')
  assert.equal(cnt.textContent, '', '列都沒了卻還說「已設定 2 步」')
  assert.equal(cnt.hidden, true)
})

test('Y4b 切到整批改排程：「已設定 N 步」依現況重算', async () => {
  const { st, pk, doc } = await freshPicker()
  await st.saveTask({
    id: 't1', name: '甲', url: URL_, locator: LOCATOR,
    schedule: { type: 'daily', times: ['09:00'], weekdays: [1] }, spec: {}
  })
  await pk.renderFromPanelCtx({
    kind: 'new',
    ctx: { locator: { css: '#a' }, url: URL_, picks: [{ locator: { css: '#a' } }], task: taskWithPre }
  })
  const cnt = doc.getElementById('preaction-count')
  assert.equal(cnt.textContent, '已設定 2 步')
  // 列被清掉（整批改排程沒有前置動作這一區），計數是另一處資料
  doc.getElementById('preaction-list').replaceChildren()
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['t1'] })
  assert.equal(cnt.textContent, '', 'setBulkView 要重算計數')
})

// ---- 5. popup 的「知道了」 ----

async function freshPopup() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(POPUP_HTML)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  return { c, pp, doc: jd.window.document }
}

const POPUP_CTX = {
  health: { level: 'yellow', summary: 's' },
  tasks: [{ id: 'T1', name: 'T1', url: URL_, enabled: true, schedule: { type: 'daily', times: ['09:00'], weekdays: [1] } }],
  lastValues: {}, nextRuns: {}, missed: [], sites: {},
  healthMap: { T1: { status: 'selector_lost', reason: '找不到', read: false } }
}

test('Y5a 知道了：背景丟例外時就地說原因，不得靜默也不得本地重算', async () => {
  const { c, pp, doc } = await freshPopup()
  pp.render({ ...POPUP_CTX })
  c.__setRuntimeResponder((m) => {
    if (m?.type === 'MARK_READ') throw new Error('背景沒有回應')
    return undefined
  })
  await pp.acknowledge(['T1'], { reportEl: doc.getElementById('task-list') })
  assert.match(doc.getElementById('task-list').textContent, /知道了沒有完成：背景沒有回應/)
  assert.equal(pp.getState().healthMap.T1.read, false, '沒存成就不得在畫面上當成已知悉')
})

test('Y5b 知道了：背景回 ok:false 時顯示它給的原因', async () => {
  const { c, pp, doc } = await freshPopup()
  pp.render({ ...POPUP_CTX })
  c.__setRuntimeResponder((m) => (m?.type === 'MARK_READ' ? { ok: false, error: '沒存成' } : undefined))
  await pp.acknowledge(['T1'], { reportEl: doc.getElementById('task-list') })
  assert.match(doc.getElementById('task-list').textContent, /知道了沒有完成：沒存成/)
  assert.equal(doc.getElementById('task-list').textContent.includes('已知悉'), false)
  assert.equal(pp.getState().healthMap.T1.read, false)
})

test('Y5c 知道了：背景成功時照舊就地標成已讀', async () => {
  const { pp } = await freshPopup()
  pp.render({ ...POPUP_CTX })
  await pp.acknowledge(['T1'])
  assert.equal(pp.getState().healthMap.T1.read, true)
})

// ---- 6. 空窗列的「知道了」要帶 kind:'gap' ----

test('Y6 空窗列的知道了：SKIP_ONE 帶 kind gap，失敗時顯示背景的原因', async () => {
  const { c, pp, doc } = await freshPopup()
  const gap = { taskId: 'T1', slot: '2026-09-19T03:00', kind: 'gap', from: '2026-09-19T01:00', to: '2026-09-19T03:00' }
  pp.render({ ...POPUP_CTX, missed: [gap] })
  const row = doc.querySelector('#missed-gaps .missed-gap')
  assert.ok(row, '前提：空窗列畫得出來')
  c.__setRuntimeResponder((m) => (m?.type === 'SKIP_ONE' ? { ok: false, error: '找不到那個空窗' } : undefined))
  row.querySelector('[data-action="ack-gap"]').click()
  await sleep(10)
  const sent = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).find(m => m?.type === 'SKIP_ONE')
  assert.equal(sent?.kind, 'gap', '背景要分得出這是休眠空窗的知道了')
  assert.match(row.textContent, /知道了沒有完成：找不到那個空窗/)
  assert.ok(row.isConnected, '失敗不得把那一列移掉（使用者會以為處理完了）')
})

// ---- 7. 站台測試登入途中切分頁 ----

test('Y7 測試登入進行中切到另一個站台：舊結果要丟掉、按鈕要復原', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const A = 'https://a.test'
  const B = 'https://b.test'
  await st.saveSite(A, {
    loginUrl: A + '/login',
    selectors: { user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' } },
    successCheck: { type: 'urlPrefix', value: A + '/home' },
    username: 'wayne', passwordEnc: await cr.encryptSecret('x'), enabled: true, failStreak: 0
  })
  const jd = new JSDOM(SITE_HTML, { url: `https://x/site.html?origin=${encodeURIComponent(A)}&tabId=9` })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const sp = await import('../src/ui/site/site.js?t=' + Math.random())
  const doc = jd.window.document
  await sp.render()

  let resolveIt = null
  c.__setRuntimeResponder((m) => (m?.type === 'TEST_LOGIN' ? new Promise(r => { resolveIt = r }) : undefined))
  const running = sp.handleTestLogin()
  await sleep(5)
  assert.equal(doc.getElementById('site-test-login').textContent, '測試中…', '前提：測試進行中')

  jd.reconfigure({ url: `https://x/site.html?origin=${encodeURIComponent(B)}&tabId=10` })
  await sp.render()
  assert.equal(doc.getElementById('origin').textContent, B, '前提：畫面已經換成 B 站')
  assert.equal(doc.getElementById('site-test-login').textContent, '測試登入', 'render 要重設按鈕文字')

  resolveIt({ ok: true, steps: [{ step: 'open', ok: true }, { step: 'verify', ok: true }] })
  await running
  await sleep(5)
  assert.equal(doc.getElementById('test-login-result').textContent, '', 'A 站的結果不得畫在 B 站的表單上')
  assert.equal(doc.getElementById('test-login-result').hidden, true)
  assert.equal(doc.querySelectorAll('#test-login-steps li').length, 0)

  // testing 旗標也要重設：沒重設的話 handleTestLogin 第一行就 return，按了完全沒反應
  c.__setRuntimeResponder(() => undefined)
  await sp.handleTestLogin()
  assert.ok(doc.querySelectorAll('#site-errors button').length > 0,
    'B 站還沒填完，這一次要走到守門（卡在 testing 的話是靜默無事）')
})

// ---- 8. 診斷包匯出失敗不得靜默 ----

const DIAG_DEFAULT = '內含目標表格的 HTML 片段與頁面網址，請自行確認後再提供給他人。'

// 診斷包是立即測試失敗時帶回來的：走真正的那條路把它準備好
async function pickerWithDiag() {
  const ctx = await freshPicker()
  ctx.pk.render({ locator: LOCATOR, url: URL_ })
  ctx.c.__setRuntimeResponder((m) => (m?.type === 'TEST_TASK'
    ? { ok: false, error: 'not_found', debug: { page: '<table></table>' } }
    : undefined))
  await ctx.pk.handleTestNow()
  ctx.c.__setRuntimeResponder(() => undefined)
  assert.equal(ctx.doc.getElementById('export-diag').hidden, false, '前提：診斷包匯出鈕露出來了')
  return ctx
}

test('Y8a 診斷包存不成：原因寫進說明列，不得靜默', async () => {
  const { c, pk, doc } = await pickerWithDiag()
  c.downloads.download = async () => { throw new Error('磁碟沒有空間') }
  await pk.handleExportDiag()
  const note = doc.getElementById('export-diag-note')
  assert.match(note.textContent, /診斷包沒有存成：磁碟沒有空間/)
  assert.equal(note.hidden, false)
})

test('Y8b 使用者在另存視窗按取消：不當成錯誤', async () => {
  const { c, pk, doc } = await pickerWithDiag()
  c.downloads.download = async () => { throw new Error('Download canceled by the user') }
  await pk.handleExportDiag()
  const note = doc.getElementById('export-diag-note')
  assert.equal(note.textContent, DIAG_DEFAULT, '按取消是使用者自己的決定，不該被說成失敗')
})

test('Y8c 存成功之後說明列回到原文', async () => {
  const { c, pk, doc } = await pickerWithDiag()
  c.downloads.download = async () => { throw new Error('磁碟沒有空間') }
  await pk.handleExportDiag()
  assert.match(doc.getElementById('export-diag-note').textContent, /沒有存成/)
  c.downloads.download = async () => 7
  await pk.handleExportDiag()
  assert.equal(doc.getElementById('export-diag-note').textContent, DIAG_DEFAULT)
})

// ---- 9~11. 選取模式 ----

async function pickMode(body) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, pm, doc: jd.window.document, win: jd.window }
}
const msgsOf = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const hoverEl = (el) => el.dispatchEvent(new globalThis.MouseEvent('mousemove', { bubbles: true }))
const clickEl = (el) => { hoverEl(el); el.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true })) }

const TABLE = `<table id="t"><thead><tr><th>H0</th><th>H1</th></tr></thead><tbody>
<tr><td id="c0-0">n0</td><td id="c0-1">10</td></tr>
<tr><td id="c1-0">n1</td><td id="c1-1">20</td></tr>
</tbody></table>`

test('Y9 代理層代表的 iframe 被拿掉：不得拿失效的目標送出', async () => {
  const { c, pm, doc } = await pickMode(`<div id="v">1</div><iframe id="fr" src="https://b.example/w.html"></iframe>`)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('v') })
  const proxy = doc.querySelector('[data-af-frame-proxy]')
  assert.ok(proxy, '前提：iframe 上有代理層')
  hoverEl(proxy)
  // SPA 把 iframe 換掉：代理層自己還連在 body 上，看它的 isConnected 看不出來
  doc.getElementById('fr').remove()
  assert.equal(proxy.isConnected, true, '前提：代理層本身還在文件裡')
  proxy.dispatchEvent(new globalThis.MouseEvent('dblclick', { bubbles: true }))
  assert.equal(msgsOf(c).filter(m => m.type === 'DESCEND_FRAME').length, 0, '那個框架已經不在了，不得鑽進去')
  const panel = doc.querySelector('[data-af-panel-body]')?.parentElement?.textContent || ''
  assert.match(panel, /頁面剛剛更新過/, '要告訴使用者頁面變過、請重新點選')
  pm.exitPickMode()
})

test('Y10a 中鍵按下要擋掉（自動捲動），overlay 自己的元素照舊放行', async () => {
  const { pm, doc } = await pickMode(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  const cell = doc.getElementById('c0-1')
  hoverEl(cell)
  const mid = new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
  cell.dispatchEvent(mid)
  assert.equal(mid.defaultPrevented, true, '中鍵不擋就會開始自動捲動，高亮跟著亂跑')

  const own = doc.querySelector('[data-af-toolbar] button') || doc.querySelector('[data-af-panel] button')
  if (own) {
    const onOwn = new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
    own.dispatchEvent(onOwn)
    assert.equal(onOwn.defaultPrevented, false, 'overlay 自己的按鈕照舊交給瀏覽器')
  }
  pm.exitPickMode()
})

test('Y10b 右鍵按下不擋：選單是 contextmenu 開的', async () => {
  const { pm, doc } = await pickMode(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  const cell = doc.getElementById('c0-1')
  hoverEl(cell)
  const right = new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 })
  cell.dispatchEvent(right)
  assert.equal(right.defaultPrevented, false)
  cell.dispatchEvent(new globalThis.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  assert.ok(doc.querySelector('[data-af-menu-item]'), '右鍵選單要開得起來')
  pm.exitPickMode()
})

test('Y10c auxclick：中鍵與上一頁／下一頁鍵都要擋', async () => {
  const { pm, doc } = await pickMode(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  const cell = doc.getElementById('c0-1')
  hoverEl(cell)
  for (const button of [1, 3, 4]) {
    const ev = new globalThis.MouseEvent('auxclick', { bubbles: true, cancelable: true, button })
    cell.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, true, `button ${button} 沒擋：頁面會被換掉或開新分頁`)
  }
  pm.exitPickMode()
})

test('Y11 「頁面剛剛更新過」的提示：滑鼠移動不清，真的加選了才清', async () => {
  const { pm, doc } = await pickMode(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  clickEl(doc.getElementById('c0-1'))
  assert.equal(pm.selectedCount(), 1, '前提：已選一格')
  const old = doc.getElementById('t')
  old.replaceWith(old.cloneNode(true))
  doc.getElementById('c0-1').dispatchEvent(new globalThis.MouseEvent('dblclick', { bubbles: true }))
  const panelText = () => doc.querySelector('[data-af-panel-body]')?.parentElement?.textContent || ''
  assert.match(panelText(), /頁面剛剛更新過/, '前提：提示已經出現')

  hoverEl(doc.getElementById('c1-0'))
  hoverEl(doc.getElementById('c1-1'))
  assert.match(panelText(), /頁面剛剛更新過/, '滑鼠一動就消失的話，使用者根本來不及讀')

  clickEl(doc.getElementById('c1-1'))
  assert.equal(pm.selectedCount(), 1, '前提：重新加選了一格')
  assert.equal(/頁面剛剛更新過/.test(panelText()), false, '真的重新點選之後提示就功成身退')
  pm.exitPickMode()
})
