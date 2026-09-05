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
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  return { c, st, se, doc: jd.window.document, win: jd.window }
}

const sent = c => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])

// ---- storage：歷史匯入 ----

test('importRecords 併入日檔並回報新增筆數', async () => {
  const { st } = await fresh()
  const day = { date: '2026-09-01', tasks: { t1: { name: '總量', records: [
    { taskId: 't1', capturedAt: '2026-09-01T09:00:00+08:00', value: 1, status: 'ok' },
    { taskId: 't1', capturedAt: '2026-09-01T10:00:00+08:00', value: 2, status: 'ok' }
  ] } } }
  const res = await st.importRecords([day])
  assert.equal(res.added, 2)
  assert.equal(res.skipped, 0)
  assert.equal((await st.getRecordsByDate('2026-09-01')).length, 2)
})

test('importRecords 以 taskId + capturedAt 去重', async () => {
  const { st } = await fresh()
  await st.appendRecord('2026-09-01', { taskId: 't1', capturedAt: '2026-09-01T09:00:00+08:00', value: 1, status: 'ok' })
  const day = { date: '2026-09-01', tasks: { t1: { records: [
    { taskId: 't1', capturedAt: '2026-09-01T09:00:00+08:00', value: 99, status: 'ok' },
    { taskId: 't1', capturedAt: '2026-09-01T11:00:00+08:00', value: 3, status: 'ok' }
  ] } } }
  const res = await st.importRecords([day])
  assert.equal(res.added, 1)
  assert.equal(res.skipped, 1)
  const all = await st.getRecordsByDate('2026-09-01')
  assert.equal(all.length, 2)
  assert.equal(all.find(r => r.capturedAt.startsWith('2026-09-01T09')).value, 1, '既有紀錄不可被覆蓋')
})

test('importRecords 接受 days 打包格式', async () => {
  const { st } = await fresh()
  const pack = { days: [
    { date: '2026-09-01', tasks: { t1: { records: [{ taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' }] } } },
    { date: '2026-09-02', tasks: { t1: { records: [{ taskId: 't1', capturedAt: 'b', value: 2, status: 'ok' }] } } }
  ] }
  const res = await st.importRecords(pack)
  assert.equal(res.added, 2)
  assert.deepEqual((await st.listDates()), ['2026-09-01', '2026-09-02'])
})

test('importRecords 遇到壞資料丟錯且不寫入任何東西', async () => {
  const { st } = await fresh()
  await assert.rejects(() => st.importRecords([{ nope: true }]))
  assert.deepEqual(await st.listDates(), [])
})

// ---- storage：用量統計 ----

test('getStorageStats 空庫回零值不丟錯', async () => {
  const { st } = await fresh()
  const s = await st.getStorageStats()
  assert.equal(s.recordCount, 0)
  assert.equal(s.oldestDate, null)
  assert.equal(typeof s.bytes, 'number')
})

test('getStorageStats 回報筆數與最舊日期', async () => {
  const { st } = await fresh()
  await st.appendRecord('2026-09-03', { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' })
  await st.appendRecord('2026-09-01', { taskId: 't1', capturedAt: 'b', value: 2, status: 'ok' })
  await st.appendRecord('2026-09-01', { taskId: 't1', capturedAt: 'c', value: 3, status: 'ok' })
  const s = await st.getStorageStats()
  assert.equal(s.recordCount, 3)
  assert.equal(s.oldestDate, '2026-09-01')
})

// ---- 匯出區 ----

test('匯出按鈕依所選格式呼叫下載一次', async () => {
  const { se, st, c, doc } = await fresh()
  await st.saveTask(task('t1'))
  await st.appendRecord('2026-09-05', { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' })
  await se.renderSettings()
  doc.getElementById('export-from').value = '2026-09-05'
  doc.getElementById('export-to').value = '2026-09-05'
  doc.getElementById('export-format').value = 'csv'
  doc.getElementById('export-run').click()
  await new Promise(r => setTimeout(r, 40))
  const dl = c.__calls.filter(x => x.api === 'downloads.download')
  assert.equal(dl.length, 1)
  assert.ok(String(dl[0].args[0].filename).endsWith('.csv'))
})

test('HTML 報表格式本段先停用', async () => {
  const { se, doc } = await fresh()
  await se.renderSettings()
  const opt = doc.querySelector('#export-format option[value="html"]')
  assert.ok(opt, '要有 html 選項')
  assert.ok(opt.disabled, 'K1 完成前 html 選項要停用')
})

test('匯出成功後把時間戳寫進設定', async () => {
  const { se, st, doc } = await fresh()
  await st.saveTask(task('t1'))
  await st.appendRecord('2026-09-05', { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' })
  await se.renderSettings()
  doc.getElementById('export-from').value = '2026-09-05'
  doc.getElementById('export-to').value = '2026-09-05'
  doc.getElementById('export-run').click()
  await new Promise(r => setTimeout(r, 40))
  const s = await st.getSettings()
  assert.ok(s.lastRecordsExportAt, '要記下最後一次紀錄匯出時間')
})

// ---- 設定匯出匯入 ----

test('設定匯出觸發下載，未勾選含密碼時不要求密語', async () => {
  const { se, st, c, doc } = await fresh()
  await st.saveTask(task('t1'))
  await se.renderSettings()
  doc.getElementById('settings-export').click()
  await new Promise(r => setTimeout(r, 40))
  assert.equal(c.__calls.filter(x => x.api === 'downloads.download').length, 1)
  const s = await st.getSettings()
  assert.ok(s.lastSettingsExportAt)
})

test('設定匯入後任務被寫入並重建排程', async () => {
  const { se, st, c, doc } = await fresh()
  await se.renderSettings()
  const json = JSON.stringify({
    kind: 'autofetcher-settings', version: 1, exportedAt: 'x',
    data: { schemaVersion: 1, tasks: [task('imported')], sites: {}, settings: {}, layout: { dashboards: [] } }
  })
  await se.handleSettingsImport(json)
  assert.ok(await st.getTask('imported'))
  assert.ok(doc.getElementById('settings-import-result').textContent.length > 0, '要顯示匯入結果')
  void c
})

test('設定匯入壞 JSON 時顯示錯誤且不寫入', async () => {
  const { se, st, doc } = await fresh()
  await se.renderSettings()
  await se.handleSettingsImport('{ not json')
  assert.equal((await st.getTasks()).length, 0)
  assert.ok(doc.getElementById('settings-import-result').textContent.length > 0)
})

test('歷史匯入顯示新增與略過筆數', async () => {
  const { se, st, doc } = await fresh()
  await st.appendRecord('2026-09-01', { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' })
  await se.renderSettings()
  await se.handleRecordsImport([JSON.stringify({ date: '2026-09-01', tasks: { t1: { records: [
    { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' },
    { taskId: 't1', capturedAt: 'b', value: 2, status: 'ok' }
  ] } } })])
  const txt = doc.getElementById('records-import-result').textContent
  assert.ok(txt.includes('1'), `要顯示新增 1 筆，實得：${txt}`)
  assert.equal((await st.getRecordsByDate('2026-09-01')).length, 2)
})

// ---- 偏好 ----

test('保留天數變更立即寫入設定', async () => {
  const { se, st, doc, win } = await fresh()
  await se.renderSettings()
  const el = doc.getElementById('pref-retention')
  el.value = '30'
  el.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await st.getSettings()).retentionDays, 30)
})

test('通知開關與額外等待秒數變更立即寫入設定', async () => {
  const { se, st, doc, win } = await fresh()
  await se.renderSettings()
  const n = doc.getElementById('pref-notifications')
  n.checked = false
  n.dispatchEvent(new win.Event('change', { bubbles: true }))
  const d = doc.getElementById('pref-extra-delay')
  d.value = '7'
  d.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  const s = await st.getSettings()
  assert.equal(s.notifications, false)
  assert.equal(s.extraDelaySec, 7)
})

test('深色模式選擇立即寫入設定並套到 data-theme', async () => {
  const { se, st, doc, win } = await fresh()
  await se.renderSettings()
  const el = doc.getElementById('pref-theme')
  el.value = 'dark'
  el.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await st.getSettings()).theme, 'dark')
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark')
})

// ---- 排程健康 ----

test('健康區列出每個任務的下次觸發時間', async () => {
  const { se, st, c, doc } = await fresh()
  await st.saveTask(task('t1'))
  await c.alarms.create('t1:0', { when: Date.now() + 3600000 })
  await se.renderSettings()
  const box = doc.getElementById('health-next-runs')
  assert.ok(box.textContent.includes('任務t1'))
  assert.ok(box.querySelector('[data-task-id="t1"]'))
})

test('健康區顯示最近 20 筆診斷，超過就截斷', async () => {
  const { se, c, doc } = await fresh()
  const entries = Array.from({ length: 25 }, (_, i) => ({ at: `2026-09-0${(i % 9) + 1}`, kind: 'k', detail: `d${i}` }))
  await c.storage.local.set({ diag: entries })
  await se.renderSettings()
  const rows = doc.querySelectorAll('#health-diag [data-diag]')
  assert.equal(rows.length, 20)
})

test('立即自檢按鈕送出 SELF_CHECK 訊息', async () => {
  const { se, c, doc } = await fresh()
  await se.renderSettings()
  doc.getElementById('health-selfcheck').click()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(sent(c).some(m => m.type === 'SELF_CHECK'))
})

test('GET_NEXT_RUNS 與 SELF_CHECK 訊息在 background 有處理', async () => {
  const { st } = await fresh()
  await st.saveTask(task('t1'))
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const res = await bg.handleMessage({ type: 'GET_NEXT_RUNS' })
  assert.ok(res && typeof res.nextRuns === 'object', 'GET_NEXT_RUNS 要回 nextRuns 物件')
  const res2 = await bg.handleMessage({ type: 'SELF_CHECK' })
  assert.ok(res2 && res2.ok === true)
})

test('messages.js 有兩個新訊息型別', async () => {
  const { MSG } = await import('../src/shared/messages.js?t=' + Math.random())
  assert.equal(MSG.GET_NEXT_RUNS, 'GET_NEXT_RUNS')
  assert.equal(MSG.SELF_CHECK, 'SELF_CHECK')
})

// ---- 用量與隱私 ----

test('設定頁顯示儲存用量、紀錄筆數與最舊日期', async () => {
  const { se, st, doc } = await fresh()
  await st.appendRecord('2026-09-01', { taskId: 't1', capturedAt: 'a', value: 1, status: 'ok' })
  await se.renderSettings()
  const txt = doc.getElementById('storage-stats').textContent
  assert.ok(txt.includes('2026-09-01'), `要顯示最舊日期，實得：${txt}`)
  assert.ok(/\b1\b/.test(txt), '要顯示紀錄筆數')
})

test('設定頁有隱私與權限說明，且明講不連伺服器', async () => {
  const { se, doc } = await fresh()
  await se.renderSettings()
  const txt = doc.getElementById('privacy-note').textContent
  assert.ok(txt.includes('伺服器'), '要說明不連任何伺服器')
  assert.ok(txt.includes('本機'), '要說明資料只在本機')
  for (const p of ['alarms', 'downloads', 'notifications', 'storage', 'tabs', 'scripting']) {
    assert.ok(txt.includes(p), `要說明權限 ${p} 的用途`)
  }
})

test('站台登入管理保留佔位，明講留待下一輪', async () => {
  const { se, doc } = await fresh()
  await se.renderSettings()
  assert.ok(doc.getElementById('sites-placeholder'))
})

test('設定頁不使用 innerHTML 也不寫死色碼', () => {
  const src = readFileSync(new URL('../src/ui/report/settings.js', import.meta.url), 'utf8')
  assert.equal((src.match(/innerHTML/g) || []).length, 0)
  assert.equal((src.match(/#[0-9a-fA-F]{3,6}\b/g) || []).length, 0)
})
