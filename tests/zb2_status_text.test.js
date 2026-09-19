// AF-21 批次 2 段 B：狀態文字單一來源、interrupted 的消費端、背景錯誤不再靜默
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { statusTextOf } from '../src/shared/record-status.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const popupHtml = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
const pickerHtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function mount(html, modPath, url = 'chrome-extension://abc/page.html') {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const mod = await import(modPath + '?t=' + Math.random())
  return { c, st, mod, doc: jd.window.document }
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

const task = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

// ---- 驗收 1 ----

test('statusTextOf：每個代碼對應白話，表外代碼原樣回傳', () => {
  const expected = {
    ok: '成功', fallback: '用備援方式抓到', late: '遲到', partial: '只抓到部分',
    not_found: '找不到元素', selector_lost: '找不到元素', parse_error: '抓不到數值',
    login_failed: '無法登入', error: '抓取失敗', failed: '抓取失敗', interrupted: '被瀏覽器中斷'
  }
  for (const [code, text] of Object.entries(expected)) assert.equal(statusTextOf(code), text, code)
  assert.equal(statusTextOf('weird_code'), 'weird_code')
  assert.equal(statusTextOf('toString'), 'toString', '原型鏈上的名字不得當成對照')
})

test('health.js 不再有自己的 STATUS_TEXT，摘要句經 statusTextOf', async () => {
  const src = readFileSync(new URL('../src/background/health.js', import.meta.url), 'utf8')
  assert.equal((src.match(/STATUS_TEXT/g) || []).length, 0)
  resetChromeMock()
  installChromeMock()
  const h = await import('../src/background/health.js?t=' + Math.random())
  const s = h.computeHealth([task('a')], { a: { status: 'interrupted' } }, [])
  assert.equal(s.level, 'red')
  assert.match(s.summary, /被瀏覽器中斷/)
})

// ---- 驗收 2 ----

test('任務頁狀態欄顯示白話、代碼放 data-status、title 仍是 reason', async () => {
  const { mod: ts, doc } = await mount(reportHtml, '../src/ui/report/tasks.js')
  ts.renderTasks([task('a'), task('b'), task('c')], {
    a: { status: 'selector_lost', reason: '找不到 #v' },
    b: { status: 'interrupted' }
  }, [])
  const statusOf = id => doc.querySelector(`[data-task-id="${id}"] .task-status`)
    || [...doc.querySelectorAll('.task-status')][['a', 'b', 'c'].indexOf(id)]
  const a = statusOf('a')
  assert.equal(a.textContent, '找不到元素')
  assert.equal(a.getAttribute('data-status'), 'selector_lost')
  assert.equal(a.getAttribute('title'), '找不到 #v')
  assert.equal(statusOf('b').textContent, '被瀏覽器中斷')
  assert.equal(statusOf('b').getAttribute('data-status'), 'interrupted')
  assert.equal(statusOf('c').getAttribute('data-status'), 'ok')
  assert.equal(statusOf('c').textContent, '成功')
})

// ---- 驗收 3 ----

test('歷史頁篩選：有 interrupted 選項，late 標籤是「遲到 (late)」', async () => {
  const { mod: rp, doc } = await mount(reportHtml, '../src/ui/report/report.js', 'https://x.test/report.html')
  await rp.renderFilters()
  const labels = [...doc.querySelectorAll('#filter-statuses label')]
  const labelOf = key => labels.find(l => l.querySelector('input').value === key)?.textContent.trim()
  assert.ok(labelOf('interrupted'), '缺 interrupted 選項')
  assert.equal(labelOf('interrupted'), '被瀏覽器中斷 (interrupted)')
  assert.equal(labelOf('late'), '遲到 (late)')
  assert.ok(!labels.some(l => l.textContent.includes('逾時')))
})

test('歷史頁表格：狀態欄顯示白話', async () => {
  const { mod: rp, doc } = await mount(reportHtml, '../src/ui/report/report.js', 'https://x.test/report.html')
  rp.renderTable([{ date: '2026-09-05', taskId: 't1', taskName: 'x', slot: '2026-09-05T09:00', status: 'interrupted' }],
    [{ key: 'taskName', label: '任務', visible: true }, { key: 'status', label: '狀態', visible: true }])
  const row = doc.querySelector('#record-table tbody tr')
  assert.match(row.textContent, /被瀏覽器中斷/)
  assert.ok(row.classList.contains('failed'), 'interrupted 要標成失敗列')
})

// ---- 驗收 4 ----

test('interrupted 紀錄：只看失敗篩得到、行事曆標失敗、儀表板數值卡顯示 —、healthFromRecords 回 interrupted', async () => {
  const r = { date: '2026-09-05', taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:05+08:00', status: 'interrupted', error: '被中斷' }
  const logic = await import('../src/ui/report/logic.js')
  const { isSuccess } = await import('../src/shared/record-status.js')
  assert.equal(logic.filterRecords([r, { ...r, status: 'ok', value: 1 }], { failedOnly: true }).length, 1)
  assert.equal(logic.buildDateStats([r], isSuccess)['2026-09-05'].hasFail, true)

  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const tasks = { t1: { id: 't1', name: '電費', mode: 'number' } }
  const el = CR.renderCard({ id: 'c1', type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1', aggregation: 'raw' }], options: {} }, {
    records: [r], tasksById: tasks, parentTasksById: tasks, health: {}, nextRuns: {}, missed: [],
    range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06'
  })
  const val = el.querySelector('.card-number-value')
  assert.equal(val.textContent.trim(), '—')
  assert.ok(!/\b0\b/.test(val.textContent))

  resetChromeMock()
  installChromeMock()
  const f = await import('../src/background/fetcher.js?t=' + Math.random())
  assert.equal(f.healthFromRecords([r]).status, 'interrupted')
})

// ---- 驗收 5 ----

test('handleMessage：RUN_TASK 時 storage 讀取丟例外 → 回 ok:false 並寫 message_error', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task('a'))
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const diag = await import('../src/shared/diag.js')
  const realGet = c.storage.local.get
  c.storage.local.get = async (keys) => {
    // 診斷自己的鍵照常讀，其餘一律丟例外
    if (keys === 'diag' || (Array.isArray(keys) && keys.includes('diag'))) return realGet.call(c.storage.local, keys)
    throw new Error('磁碟壞了')
  }
  let res
  try {
    res = await bg.handleMessage({ type: 'RUN_TASK', taskId: 'a' }, {})
  } finally {
    c.storage.local.get = realGet
  }
  assert.equal(res?.ok, false, `實得 ${JSON.stringify(res)}`)
  assert.equal(res.error, '背景處理失敗：磁碟壞了')
  const entries = await diag.getAll()
  const hit = entries.find(e => e.kind === 'message_error')
  assert.ok(hit, '診斷要有 message_error')
  assert.match(String(hit.detail), /RUN_TASK：磁碟壞了/)
})

// ---- 驗收 6 ----

async function popupWithRow(c, pp, doc) {
  pp.render({
    health: { level: 'red', redCount: 1, yellowCount: 0, summary: 'x' },
    tasks: [task('t1')], lastValues: {}, nextRuns: {},
    healthMap: { t1: { status: 'selector_lost' } }
  })
  doc.querySelector('#task-list .task-row .retry').click()
  await flush()
  return doc.querySelector('#task-list .task-row .task-run-result')?.textContent || ''
}

test('popup 立即抓取：背景回 ok:false → 有字', async () => {
  const { c, mod: pp, doc } = await mount(popupHtml, '../src/ui/popup/popup.js')
  c.__setRuntimeResponder(() => ({ ok: false, error: '背景處理失敗：磁碟壞了' }))
  assert.match(await popupWithRow(c, pp, doc), /背景處理失敗：磁碟壞了/)
})

test('popup 立即抓取：sendMessage 丟例外 → 抓取被中斷，請再試一次', async () => {
  const { c, mod: pp, doc } = await mount(popupHtml, '../src/ui/popup/popup.js')
  c.__setRuntimeResponder(() => { throw new Error('Could not establish connection') })
  assert.equal(await popupWithRow(c, pp, doc), '抓取被中斷，請再試一次')
})

async function tasksRun(c, ts, doc) {
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-action="run"]').click()
  await flush()
  return doc.querySelector('.task-run-result')?.textContent || ''
}

test('任務頁立即抓取：背景回 ok:false → 有字', async () => {
  const { c, mod: ts, doc } = await mount(reportHtml, '../src/ui/report/tasks.js')
  c.__setRuntimeResponder(() => ({ ok: false, error: '背景處理失敗：磁碟壞了' }))
  assert.match(await tasksRun(c, ts, doc), /背景處理失敗：磁碟壞了/)
})

test('任務頁立即抓取：sendMessage 丟例外 → 抓取被中斷，請再試一次', async () => {
  const { c, mod: ts, doc } = await mount(reportHtml, '../src/ui/report/tasks.js')
  c.__setRuntimeResponder(() => { throw new Error('Could not establish connection') })
  assert.equal(await tasksRun(c, ts, doc), '抓取被中斷，請再試一次')
})

const LOCATOR = { css: '#v', path: 'body > div:nth-of-type(1)', anchor: null, xpath: '/html[1]/body[1]/div[1]' }

test('Picker 立即測試：背景回 ok:false → 有字', async () => {
  const { c, mod: pk, doc } = await mount(pickerHtml, '../src/ui/picker/picker.js')
  c.__setRuntimeResponder(() => ({ ok: false, error: '背景處理失敗：磁碟壞了' }))
  pk.render({ locator: LOCATOR, preview: '1', previewValue: 1, url: 'https://a.test/p', tabId: 7 })
  await pk.handleTestNow()
  assert.match(doc.getElementById('errors').textContent, /背景處理失敗：磁碟壞了/)
})

test('Picker 立即測試：sendMessage 丟例外 → 抓取被中斷，請再試一次', async () => {
  const { c, mod: pk, doc } = await mount(pickerHtml, '../src/ui/picker/picker.js')
  c.__setRuntimeResponder(() => { throw new Error('Could not establish connection') })
  pk.render({ locator: LOCATOR, preview: '1', previewValue: 1, url: 'https://a.test/p', tabId: 7 })
  await pk.handleTestNow()
  assert.equal(doc.getElementById('errors').textContent, '抓取被中斷，請再試一次')
})

test('Picker 立即測試：背景回狀態代碼時顯示白話', async () => {
  const { c, mod: pk, doc } = await mount(pickerHtml, '../src/ui/picker/picker.js')
  c.__setRuntimeResponder(() => ({ ok: false, error: 'interrupted' }))
  pk.render({ locator: LOCATOR, preview: '1', previewValue: 1, url: 'https://a.test/p', tabId: 7 })
  await pk.handleTestNow()
  assert.equal(doc.getElementById('errors').textContent, '被瀏覽器中斷')
})

// ---- 設定頁自檢 ----

test('設定頁立即自檢：ok:false 與 sendMessage 丟例外都有字', async () => {
  const { c, mod: sp, doc } = await mount(reportHtml, '../src/ui/report/settings.js')
  await sp.renderSettings?.()
  const btn = doc.getElementById('health-selfcheck')
  assert.ok(btn && btn._afBound, '自檢按鈕要已綁定（renderSettings 名稱不同時要跟著改）')
  c.__setRuntimeResponder(m => m.type === 'SELF_CHECK' ? { ok: false, error: '背景處理失敗：x' } : undefined)
  btn.click()
  await flush()
  assert.match(doc.getElementById('health-diag').textContent, /自檢失敗：背景處理失敗：x/)
  c.__setRuntimeResponder(m => { if (m.type === 'SELF_CHECK') throw new Error('gone') })
  btn.click()
  await flush()
  assert.match(doc.getElementById('health-diag').textContent, /自檢沒有完成，請再試一次/)
})
