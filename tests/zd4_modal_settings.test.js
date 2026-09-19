// AF-21 段 4-D：共用確認對話框（ui/modal.js）、五個使用點、設定頁欄位驗證與就地回饋、匯出失敗回饋
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  // jsdom 25 沒有 <dialog> 的 showModal／close：替身只切 open 屬性（正式碼不留退路分支）
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return { c, st, doc: jd.window.document, win: jd.window }
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
const modalOf = (doc) => doc.querySelector('dialog.modal')
const dump = async (c) => JSON.stringify(await c.storage.local.get(null))

// 本地日期 YYYY-MM-DD 往前 n 天
function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ================= 1. 共用對話框 =================

async function modalEnv() {
  const env = await fresh()
  const md = await import('../src/ui/modal.js?t=' + Math.random())
  const trigger = env.doc.createElement('button')
  trigger.id = 'trigger'
  env.doc.body.appendChild(trigger)
  trigger.focus()
  return { ...env, md, trigger }
}

test('驗收1：開啟時焦點在取消鈕、Esc 回傳 false、關閉後焦點回到觸發元素', async () => {
  const { doc, win, md, trigger } = await modalEnv()
  assert.equal(doc.activeElement, trigger, '前置')
  const p = md.confirmDialog({ title: '標題', body: '內文' })
  const dlg = modalOf(doc)
  assert.ok(dlg && dlg.open, '要用 showModal 開成 modal')
  assert.equal(doc.activeElement, dlg.querySelector('[data-action="cancel"]'), '焦點在安全的那顆（取消）')
  dlg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(await p, false)
  assert.equal(modalOf(doc), null, '關掉就移除')
  assert.equal(doc.activeElement, trigger, '焦點回到觸發元素')
})

test('驗收1：原生 cancel 事件（瀏覽器的 Esc）也等於取消', async () => {
  const { doc, win, md, trigger } = await modalEnv()
  const p = md.confirmDialog({ title: 't' })
  modalOf(doc).dispatchEvent(new win.Event('cancel', { cancelable: true }))
  assert.equal(await p, false)
  assert.equal(doc.activeElement, trigger)
})

test('驗收1：確認回傳 true、焦點歸還；extra 回傳自己的 value', async () => {
  const { doc, md, trigger } = await modalEnv()
  const p = md.confirmDialog({ title: 't', body: 'b' })
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  assert.equal(await p, true)
  assert.equal(doc.activeElement, trigger)

  const p2 = md.confirmDialog({ title: 't', extra: { text: '先匯出再刪除', value: 'export' } })
  const extra = modalOf(doc).querySelector('[data-action="extra"]')
  assert.equal(extra.textContent, '先匯出再刪除')
  extra.click()
  assert.equal(await p2, 'export')
})

test('驗收1：danger 時確認鈕有危險類別、沒有 btn-primary；一般時是主要按鈕', async () => {
  const { doc, md } = await modalEnv()
  md.confirmDialog({ title: 't', danger: true })
  const ok = modalOf(doc).querySelector('[data-action="confirm"]')
  assert.ok(ok.classList.contains('btn-danger'), '要有危險類別')
  assert.ok(!ok.classList.contains('btn-primary'), '危險動作的確認鈕不得是主要按鈕')
  md.dismissDialog()
  md.confirmDialog({ title: 't' })
  const ok2 = modalOf(doc).querySelector('[data-action="confirm"]')
  assert.ok(ok2.classList.contains('btn-primary') && !ok2.classList.contains('btn-danger'))
  md.dismissDialog()
})

test('驗收1：內文不經 innerHTML（標記字串原樣顯示）', async () => {
  const { doc, md } = await modalEnv()
  md.confirmDialog({ title: '<i>x</i>', body: '<b>粗體</b><img src=x>' })
  const dlg = modalOf(doc)
  assert.equal(dlg.querySelector('b, i, img'), null, '不得解析成元素')
  assert.ok(dlg.textContent.includes('<b>粗體</b>'))
  md.dismissDialog()
  const src = readFileSync(new URL('../src/ui/modal.js', import.meta.url), 'utf8')
  assert.equal((src.match(/innerHTML|insertAdjacentHTML|outerHTML/g) || []).length, 0)
})

test('ui.css 有 modal 遮罩與危險按鈕樣式，紅色走 --danger', () => {
  const css = readFileSync(new URL('../src/ui/ui.css', import.meta.url), 'utf8')
  assert.match(css, /dialog::backdrop\s*\{/)
  const m = css.match(/\.btn-danger[^{]*\{([^}]*)\}/)
  assert.ok(m, '要有 .btn-danger')
  assert.match(m[1], /var\(--danger\)/)
})

// ================= 2. 五個使用點：任務／紀錄／站台刪除 =================

async function tasksEnv(ids = ['a']) {
  const env = await fresh()
  await env.st.saveTasks(ids.map(id => task(id)))
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  ts.renderTasks(await env.st.getTasks(), {}, [])
  return { ...env, ts }
}

test('驗收2：舊的區塊式確認框已移除', async () => {
  const { doc } = await fresh()
  assert.equal(doc.getElementById('task-delete-dialog'), null)
  assert.equal(doc.getElementById('record-delete-confirm'), null)
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
  assert.ok(!css.includes('#task-delete-dialog') && !css.includes('#record-delete-confirm'), '專屬樣式要一起移除')
})

test('驗收2：任務刪除 → 對話框（不在任務清單裡），取消零刪除', async () => {
  const { c, st, doc } = await tasksEnv(['a'])
  await st.appendRecord('2026-09-05', { taskId: 'a', capturedAt: 'x', value: 1, status: 'ok' })
  const before = await dump(c)
  doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
  await tick()
  const dlg = modalOf(doc)
  assert.ok(dlg && dlg.open, '要出現對話框')
  assert.equal(dlg.closest('#panel-tasks'), null, '不是清單尾端的區塊')
  assert.match(dlg.textContent, /1 筆/)
  const ok = dlg.querySelector('[data-action="confirm"]')
  assert.ok(ok.classList.contains('btn-danger') && !ok.classList.contains('btn-primary'))
  dlg.querySelector('[data-action="cancel"]').click()
  await tick()
  assert.equal(await dump(c), before, '取消零寫入')
})

test('驗收2：任務刪除確認就刪', async () => {
  const { st, doc } = await tasksEnv(['a', 'b'])
  doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
  await tick()
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await tick()
  assert.deepEqual((await st.getTasks()).map(t => t.id), ['b'])
})

test('驗收2：先匯出再刪除——下載成功才刪；匯出失敗不刪並說出來', async () => {
  const { c, st, doc } = await tasksEnv(['a', 'b'])
  const orig = chrome.downloads.download
  chrome.downloads.download = async () => { throw new Error('Download canceled by the user') }
  try {
    doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
    await tick()
    modalOf(doc).querySelector('[data-action="extra"]').click()
    await tick(50)
  } finally {
    chrome.downloads.download = orig
  }
  assert.equal((await st.getTasks()).length, 2, '匯出失敗不得刪')
  assert.match(doc.getElementById('task-note').textContent, /匯出沒有完成.*還沒有刪除/)

  doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
  await tick()
  modalOf(doc).querySelector('[data-action="extra"]').click()
  await tick(50)
  assert.ok(c.__calls.some(x => x.api === 'downloads.download'), '要先下載')
  assert.deepEqual((await st.getTasks()).map(t => t.id), ['b'])
})

test('驗收2：紀錄刪除走對話框，取消不刪、確認才刪', async () => {
  const { st, doc } = await fresh()
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  await st.appendRecord('2026-09-01', { taskId: 't1', slot: '2026-09-01T09:00', capturedAt: '2026-09-01T09:00:00+08:00', value: 1, raw: '1', status: 'ok' })
  rp.renderTable(await st.getRecordsInRange('2026-09-01', '2026-09-01'))
  doc.querySelector('#record-table tbody tr').click()
  await tick()
  doc.querySelector('#record-table [data-action="delete-record"]').click()
  await tick()
  let dlg = modalOf(doc)
  assert.ok(dlg && dlg.open, '要出現對話框')
  assert.ok(dlg.querySelector('[data-action="confirm"]').classList.contains('btn-danger'))
  dlg.querySelector('[data-action="cancel"]').click()
  await tick()
  assert.equal((await st.getRecordsByDate('2026-09-01')).length, 1, '取消不刪')

  doc.querySelector('#record-table [data-action="delete-record"]').click()
  await tick()
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await tick(50)
  assert.equal((await st.getRecordsByDate('2026-09-01')).length, 0, '確認才刪')
})

async function settingsEnv() {
  const env = await fresh()
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  return { ...env, se }
}

test('驗收2：站台刪除要二段確認，取消不刪、確認才刪', async () => {
  const { st, se, doc } = await settingsEnv()
  await st.saveSite('https://s.test', { username: 'u', enabled: true, loginCheck: { type: 'urlPrefix', value: 'https://s.test/home' } })
  await se.renderSettings()
  const del = () => doc.querySelector('#sites-list [data-action="site-delete"]')
  del().click()
  await tick()
  const dlg = modalOf(doc)
  assert.ok(dlg && dlg.open, '要出現對話框')
  assert.match(dlg.textContent, /https:\/\/s\.test/)
  assert.ok(dlg.querySelector('[data-action="confirm"]').classList.contains('btn-danger'))
  dlg.querySelector('[data-action="cancel"]').click()
  await tick()
  assert.ok(await st.getSite('https://s.test'), '取消不刪')

  del().click()
  await tick()
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await tick()
  assert.equal(await st.getSite('https://s.test'), null, '確認才刪')
})

// ================= 3. 保留天數 =================

const change = (win, el, value) => {
  el.value = value
  el.dispatchEvent(new win.Event('change', { bubbles: true }))
}

test('驗收3：清空保留天數 → 不寫入、欄位下有原因、blur 後回到舊值', async () => {
  const { c, se, doc, win } = await settingsEnv()
  await se.renderSettings()
  const el = doc.getElementById('pref-retention')
  assert.equal(el.value, '365')
  const before = await dump(c)
  change(win, el, '')
  await tick()
  assert.equal(await dump(c), before, 'storage 值不變')
  const errId = el.getAttribute('aria-describedby')
  const err = errId && doc.getElementById(errId)
  assert.ok(err && !err.hidden && err.textContent.includes('空白'), `欄位下要說原因：${err?.textContent}`)
  assert.equal(modalOf(doc), null, '非法值不出對話框')
  el.dispatchEvent(new win.Event('blur'))
  assert.equal(el.value, '365', 'blur 後回到上一個有效值')
})

test('驗收3：超出範圍（0、3651）不寫入並說出值域', async () => {
  const { st, se, doc, win } = await settingsEnv()
  await se.renderSettings()
  const el = doc.getElementById('pref-retention')
  for (const v of ['0', '3651', '1.5']) {
    change(win, el, v)
    await tick()
    assert.equal((await st.getSettings()).retentionDays, 365, `${v} 不得寫入`)
    assert.ok(doc.getElementById(el.getAttribute('aria-describedby')).textContent.length > 0)
    el.dispatchEvent(new win.Event('blur'))
    assert.equal(el.value, '365')
  }
  const d = doc.getElementById('pref-extra-delay')
  change(win, d, '61')
  await tick()
  assert.equal((await st.getSettings()).extraDelaySec, 3)
  const a = doc.getElementById('pref-alert-cooldown')
  change(win, a, '')
  await tick()
  assert.equal((await st.getSettings()).alertCooldownMin, undefined, '空白不得存成 0')
})

test('驗收3：365→30 先確認，內文含「30 天以前」與筆數；取消值不變、欄位回 365', async () => {
  const { c, st, se, doc, win } = await settingsEnv()
  await st.appendRecord(daysAgo(100), { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' })
  await st.appendRecord(daysAgo(100), { taskId: 't1', capturedAt: 'b', value: 2, status: 'ok' })
  await st.appendRecord(daysAgo(40), { taskId: 't1', capturedAt: 'c', value: 3, status: 'ok' })
  await st.appendRecord(daysAgo(5), { taskId: 't1', capturedAt: 'd', value: 4, status: 'ok' })
  await se.renderSettings()
  const el = doc.getElementById('pref-retention')
  const before = await dump(c)
  change(win, el, '30')
  await tick()
  const dlg = modalOf(doc)
  assert.ok(dlg && dlg.open, '調低要先確認')
  assert.match(dlg.textContent, /30 天以前/)
  assert.match(dlg.textContent, /約 3 筆/, dlg.textContent)
  assert.ok(dlg.querySelector('[data-action="confirm"]').classList.contains('btn-danger'))
  assert.equal(await dump(c), before, '確認前不得寫入')
  dlg.querySelector('[data-action="cancel"]').click()
  await tick()
  assert.equal(await dump(c), before, '取消不寫入')
  assert.equal(el.value, '365', '欄位回到原值')
})

test('驗收3：365→30 確認才寫入 30；之後再調高不出對話框', async () => {
  const { st, se, doc, win } = await settingsEnv()
  await se.renderSettings()
  const el = doc.getElementById('pref-retention')
  change(win, el, '30')
  await tick()
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await tick()
  assert.equal((await st.getSettings()).retentionDays, 30)
  change(win, el, '400')
  await tick()
  assert.equal(modalOf(doc), null, '調高不問')
  assert.equal((await st.getSettings()).retentionDays, 400)
})

test('驗收3：調低時的筆數不一次讀進全部紀錄（分批、只讀截止日以前的鍵）', async () => {
  const { c, st, se, doc, win } = await settingsEnv()
  await st.appendRecord(daysAgo(100), { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' })
  await st.appendRecord(daysAgo(1), { taskId: 't1', capturedAt: 'b', value: 2, status: 'ok' })
  await se.renderSettings()
  const m = c.__calls.length
  change(win, doc.getElementById('pref-retention'), '30')
  await tick()
  const full = c.__calls.slice(m).filter(x => x.api === 'storage.local.get' && (x.args[0] === null || x.args[0] === undefined))
  assert.equal(full.length, 0, '不得 get(null)')
  const read = c.__calls.slice(m).filter(x => x.api === 'storage.local.get' && Array.isArray(x.args[0])).flatMap(x => x.args[0])
  assert.ok(read.every(k => !String(k).includes(daysAgo(1))), `不該讀截止日之後的紀錄鍵：${read}`)
  assert.match(modalOf(doc).textContent, /約 1 筆/)
})

// ================= 4. 已儲存 =================

test('驗收4：偏好寫入成功後欄位旁出現「已儲存」（role=status）', async () => {
  const { se, doc, win } = await settingsEnv()
  await se.renderSettings()
  const cases = [
    ['pref-notifications', (el) => { el.checked = false }],
    ['pref-extra-delay', (el) => { el.value = '7' }],
    ['pref-theme', (el) => { el.value = 'dark' }],
    ['pref-fetch-tab-mode', (el) => { el.value = 'window' }]
  ]
  for (const [id, set] of cases) {
    const el = doc.getElementById(id)
    set(el)
    el.dispatchEvent(new win.Event('change', { bubbles: true }))
    await tick()
    const row = el.closest('.settings-row')
    const status = row.querySelector('[role="status"]')
    assert.ok(status && status.textContent.includes('已儲存'), `${id} 要有已儲存回饋：${status?.textContent}`)
  }
})

test('驗收4：寫入失敗說原因、不顯示已儲存', async () => {
  const { c, se, doc, win } = await settingsEnv()
  await se.renderSettings()
  const origSet = c.storage.local.set.bind(c.storage.local)
  c.storage.local.set = async () => { throw new Error('配額用完') }
  const el = doc.getElementById('pref-notifications')
  el.checked = false
  try {
    el.dispatchEvent(new win.Event('change', { bubbles: true }))
    await tick()
  } finally {
    c.storage.local.set = origSet
  }
  const row = el.closest('.settings-row')
  assert.ok(!row.querySelector('[role="status"]').textContent.includes('已儲存'))
  assert.match(row.textContent, /配額用完/)
})

// ================= 5. 匯出 =================

test('驗收5：紀錄匯出 download 丟例外 → 說「匯出沒有完成」、時間不更新；成功 → 「已開始下載」、時間更新', async () => {
  const { st, se, doc } = await settingsEnv()
  await se.renderSettings()
  const btn = doc.getElementById('export-run')
  const orig = chrome.downloads.download
  chrome.downloads.download = async () => { throw new Error('Download canceled by the user') }
  try {
    btn.click()
    await tick(60)
  } finally {
    chrome.downloads.download = orig
  }
  const row = btn.closest('.settings-row')
  assert.match(row.textContent, /匯出沒有完成：Download canceled by the user/)
  assert.equal((await st.getSettings()).lastRecordsExportAt, undefined, '失敗不得更新時間')

  btn.click()
  await tick(60)
  assert.match(row.textContent, /已開始下載/)
  assert.doesNotMatch(row.textContent, /匯出沒有完成/)
  assert.ok((await st.getSettings()).lastRecordsExportAt, '成功才更新時間')
})

test('驗收5：設定匯出沒拿到下載 id 也算沒完成', async () => {
  const { st, se, doc } = await settingsEnv()
  await se.renderSettings()
  const btn = doc.getElementById('settings-export')
  const orig = chrome.downloads.download
  chrome.downloads.download = async () => undefined
  try {
    btn.click()
    await tick(60)
  } finally {
    chrome.downloads.download = orig
  }
  assert.match(btn.closest('.settings-row').textContent, /匯出沒有完成/)
  assert.equal((await st.getSettings()).lastSettingsExportAt, undefined)
  btn.click()
  await tick(60)
  assert.match(btn.closest('.settings-row').textContent, /已開始下載/)
  assert.ok((await st.getSettings()).lastSettingsExportAt)
})

// ================= 6. 設定匯入 =================

const settingsFile = (data) => JSON.stringify({
  kind: 'autofetcher-settings', version: 1, exportedAt: 'x',
  data: { schemaVersion: 3, tasks: [], sites: {}, settings: {}, layout: { dashboards: [] }, ...data }
})

test('驗收6：選檔 → 對話框顯示摘要；取消零寫入', async () => {
  const { c, se, doc } = await settingsEnv()
  await se.renderSettings()
  const before = await dump(c)
  await se.handleSettingsImport(settingsFile({ tasks: [task('t9')], settings: { retentionDays: 30 } }))
  const dlg = modalOf(doc)
  assert.ok(dlg && dlg.open, '要用對話框確認')
  assert.match(dlg.textContent, /新增 1 個/)
  assert.equal(dlg.querySelector('[data-action="confirm"]').textContent, '確認匯入')
  assert.equal(await dump(c), before, '確認前零寫入')
  dlg.querySelector('[data-action="cancel"]').click()
  await tick()
  assert.equal(await dump(c), before, '取消零寫入')
  assert.equal(modalOf(doc), null)
})

test('驗收6：確認寫入並重畫（欄位顯示匯入後的值、不另問保留天數）', async () => {
  const { st, se, doc } = await settingsEnv()
  await se.renderSettings()
  await se.handleSettingsImport(settingsFile({ tasks: [task('t9')], settings: { retentionDays: 30 } }))
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await tick(80)
  assert.ok(await st.getTask('t9'))
  assert.equal((await st.getSettings()).retentionDays, 30)
  assert.equal(doc.getElementById('pref-retention').value, '30', '重畫後欄位顯示匯入值')
  assert.match(doc.getElementById('settings-import-result').textContent, /設定匯入成功/)
  assert.equal(modalOf(doc), null)
})

test('匯入重畫後，保留天數的「上一個有效值」跟著換成匯入值', async () => {
  const { st, se, doc, win } = await settingsEnv()
  await se.renderSettings()
  await se.handleSettingsImport(settingsFile({ settings: { retentionDays: 30 } }))
  modalOf(doc).querySelector('[data-action="confirm"]').click()
  await tick(80)
  const el = doc.getElementById('pref-retention')
  change(win, el, '')
  await tick()
  el.dispatchEvent(new win.Event('blur'))
  assert.equal(el.value, '30')
  change(win, el, '60')
  await tick()
  assert.equal(modalOf(doc), null, '30→60 是調高，不問')
  assert.equal((await st.getSettings()).retentionDays, 60)
})

// ================= 數值域同一份 =================

test('數值域常數只有一份：settings-io 匯出、設定頁引用，兩邊不各寫一份', async () => {
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  assert.deepEqual({ ...io.NUMERIC_SETTING_RANGES.retentionDays }, { min: 1, max: 3650, integer: true })
  assert.deepEqual({ ...io.NUMERIC_SETTING_RANGES.extraDelaySec }, { min: 0, max: 60, integer: false })
  assert.deepEqual({ ...io.NUMERIC_SETTING_RANGES.alertCooldownMin }, { min: 0, max: 1440, integer: false })
  const ioSrc = readFileSync(new URL('../src/shared/settings-io.js', import.meta.url), 'utf8')
  assert.ok(!/inRange\(\s*1\s*,\s*3650/.test(ioSrc), '白名單要引用常數')
  const setSrc = readFileSync(new URL('../src/ui/report/settings.js', import.meta.url), 'utf8')
  assert.ok(!/3650|1440/.test(setSrc), '設定頁不得自己寫值域')
  assert.ok(setSrc.includes('numericSettingProblem'))
  assert.ok(!/Number\(\w+El\.value\)/.test(setSrc), '不得再 Number(欄位值) 直接存')
})
