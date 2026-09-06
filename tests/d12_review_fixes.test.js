// AF-3 體檢輪:獨立審查抓到的既有缺陷(這輪之前就有,但一直沒人發現)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }
const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  return { c, st }
}

const task = (over = {}) => ({
  id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

// ---- 保留天數的偏好過去存了沒人讀 ----

test('看門狗會清掉超過保留天數的舊紀錄', async () => {
  const { st } = await fresh()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveSettings({ retentionDays: 7 })
  await st.appendRecord('2020-01-01', { taskId: 't1', slot: '2020-01-01T09:00', capturedAt: '2020-01-01T09:00:00Z', value: 1, status: 'ok' })
  await wd.runWatchdog()
  assert.equal((await st.getRecordsByDate('2020-01-01')).length, 0,
    '保留天數是設定頁的偏好,過去 trimOldRecords 定義了卻沒有任何呼叫端')
})

test('清理一天只做一次(它要掃整個 storage,不能每 15 分鐘或每筆寫入都跑)', async () => {
  const { c, st } = await fresh()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveSettings({ retentionDays: 7 })
  await wd.runWatchdog()
  const before = c.__calls.filter(x => x.api === 'storage.local.get' && x.args[0] === null).length
  await wd.runWatchdog()
  await wd.runWatchdog()
  const after = c.__calls.filter(x => x.api === 'storage.local.get' && x.args[0] === null).length
  assert.equal(after, before, '同一天再跑不該再掃一次整個 storage')
})

test('抓取寫入紀錄時不得掃整個 storage', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  c.__calls.length = 0
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  const fullScans = c.__calls.filter(x => x.api === 'storage.local.get' && x.args[0] === null).length
  assert.equal(fullScans, 0, '每筆抓取都把全部歷史載進記憶體是效能回歸')
})

test('保留天數內的紀錄不得被清掉', async () => {
  const { st } = await fresh()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveSettings({ retentionDays: 365 })
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const recent = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  await st.appendRecord(recent, { taskId: 't1', slot: recent + 'T08:00', capturedAt: recent + 'T08:00:00Z', value: 1, status: 'ok' })
  await wd.runWatchdog()
  assert.equal((await st.getRecordsByDate(recent)).length, 1)
})

// ---- popup 的「最後值」過去永遠是破折號 ----

test('抓到值之後 popup 讀得到最後一次的值', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 1234, raw: '1,234', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })

  const last = await st.getLastValues()
  assert.equal(last.t1?.value, 1234, 'popup 讀 lastValues,過去完全沒有寫入端所以永遠顯示破折號')
  assert.ok(last.t1?.capturedAt, '要知道是什麼時候抓的')
})

test('失敗的抓取不得覆蓋掉上一次成功的值', async () => {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 1234, raw: '1,234', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  c.__setTabResponder(() => ({ ok: false, error: 'parse_error', raw: '--' }))
  await fe.runTask(task(), { slot: '2026-09-06T10:00', ...FAST })
  assert.equal((await st.getLastValues()).t1?.value, 1234, '抓失敗時應該還看得到上次的值')
})

// ---- 卡住的執行從來沒被清掉 ----

test('卡超過三分鐘的執行會被看門狗清掉', async () => {
  const { c, st } = await fresh()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveTask(task())
  // fetcher 寫進去的 startedAt 是 ISO 字串（不是數字），過去看門狗比對型別因此永遠不成立
  await chrome.storage.session.set({
    inflight: { 't1:2026-09-06T09:00': { state: 'running', startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() } }
  })
  await wd.runWatchdog()
  const res = await chrome.storage.session.get('inflight')
  assert.deepEqual(res.inflight, {}, '卡住的執行要清掉,否則那個槽永遠不會再跑')
})

test('還沒卡住的執行不得被清掉', async () => {
  const { st } = await fresh()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveTask(task())
  await chrome.storage.session.set({
    inflight: { 't1:x': { state: 'running', startedAt: new Date().toISOString() } }
  })
  await wd.runWatchdog()
  const res = await chrome.storage.session.get('inflight')
  assert.ok(res.inflight['t1:x'], '才剛開始跑的不能清')
})

// ---- 任務頁的下次執行時間 ----

test('任務頁的下次執行時間要是看得懂的時間,不是毫秒數', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(reportHtml, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())

  const when = new Date('2026-09-07T09:00:00+08:00').getTime()
  ts.renderTasks([task()], {}, [], { nextRuns: { t1: when } })
  const cell = jd.window.document.querySelector('[data-task-id="t1"] .task-next')
  assert.ok(cell, '要有下次執行欄位')
  assert.ok(!/^\d{10,}$/.test(cell.textContent.trim()),
    `不能直接印毫秒 timestamp,實得:${cell.textContent}`)
  assert.ok(/9|09/.test(cell.textContent), `要看得出是幾點,實得:${cell.textContent}`)
})

// ---- 匯出格式的佔位文字 ----

test('HTML 報表匯出選項不再是停用的佔位文字', () => {
  assert.ok(!/下一段完成後啟用/.test(reportHtml), 'HTML 報表已經做好了,佔位文字要拿掉')
  const m = reportHtml.match(/<option value="html"[^>]*>/)
  assert.ok(m, '要有 HTML 匯出選項')
  assert.ok(!/disabled/.test(m[0]), `選項不該還停用著,實得:${m[0]}`)
})
