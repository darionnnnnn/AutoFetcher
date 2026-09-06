// AF-5 批次 A：抓取結果看得見
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

async function freshFetcher() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const he = await import('../src/background/health.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, fe, he }
}

// ---- A1：狀態集合單一來源 ----

test('record-status 匯出警示集合與紅色判定', async () => {
  const rs = await import('../src/shared/record-status.js?t=' + Math.random())
  assert.deepEqual([...rs.WARN_STATUSES].sort(), ['fallback', 'late', 'partial'])
  assert.equal(rs.isWarn({ status: 'partial' }), true)
  assert.equal(rs.isWarn({ status: 'ok' }), false)
  assert.equal(rs.isRed({ status: 'not_found' }), true)
  assert.equal(rs.isRed({ status: 'selector_lost' }), true)
  assert.equal(rs.isRed({ status: 'fallback' }), false, 'fallback 是黃不是紅')
  assert.equal(rs.isRed({ status: 'ok' }), false)
  assert.equal(rs.isRed(null), false)
})

test('record-status 提供紀錄狀態到 health 狀態的唯一對應', async () => {
  const rs = await import('../src/shared/record-status.js?t=' + Math.random())
  assert.equal(rs.healthStatusOf('ok'), 'ok')
  assert.equal(rs.healthStatusOf('fallback'), 'fallback')
  assert.equal(rs.healthStatusOf('late'), 'late')
  assert.equal(rs.healthStatusOf('not_found'), 'selector_lost')
  assert.equal(rs.healthStatusOf('parse_error'), 'parse_error')
  assert.equal(rs.healthStatusOf('login_failed'), 'login_failed')
  assert.equal(rs.healthStatusOf('error'), 'failed')
})

test('health.js 不得自己維護狀態集合字面值', () => {
  const src = readFileSync(new URL('../src/background/health.js', import.meta.url), 'utf8')
  assert.ok(/from '\.\.\/shared\/record-status\.js'/.test(src), 'health.js 必須引用 record-status')
  assert.ok(!/new Set\(\[\s*'login_failed'/.test(src), '紅色集合不得在 health.js 內另寫一份')
  assert.ok(!/new Set\(\[\s*'fallback'/.test(src), '黃色集合不得在 health.js 內另寫一份')
})

test('computeHealth 對各狀態的分級不變', async () => {
  resetChromeMock()
  installChromeMock()
  const he = await import('../src/background/health.js?t=' + Math.random())
  const tasks = [task({ id: 'a' }), task({ id: 'b' })]
  assert.equal(he.computeHealth(tasks, { a: { status: 'partial' } }, []).level, 'yellow', 'partial 是黃燈')
  assert.equal(he.computeHealth(tasks, { a: { status: 'fallback' } }, []).level, 'yellow')
  assert.equal(he.computeHealth(tasks, { a: { status: 'late' } }, []).level, 'yellow')
  assert.equal(he.computeHealth(tasks, { a: { status: 'selector_lost' } }, []).level, 'red')
  assert.equal(he.computeHealth(tasks, { a: { status: 'parse_error' } }, []).level, 'red')
  assert.equal(he.computeHealth(tasks, { a: { status: 'login_failed' } }, []).level, 'red')
  assert.equal(he.computeHealth(tasks, { a: { status: 'failed' } }, []).level, 'red')
  assert.equal(he.computeHealth(tasks, { a: { status: 'ok' } }, []).level, 'green')
})

// ---- A2：手動抓取 ----

test('manual：帳本已有該 slot 仍執行並寫紀錄', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(task())
  await c.storage.local.set({ runs: { t1: { '2026-09-06T09:00': 'ok' } } })
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', reason: 'manual', ...FAST })
  assert.ok(rec, 'manual 不得被冪等帳本擋掉')
  assert.equal(rec.status, 'ok')
  assert.equal((await st.getRecordsByDate('2026-09-06')).length, 1)
})

test('manual：不寫帳本（否則會偷走同一分鐘的排程槽）', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-06T09:00', reason: 'manual', ...FAST })
  const runs = (await c.storage.local.get('runs')).runs || {}
  assert.deepEqual(runs, {}, 'manual 不得在帳本留下任何鍵')
})

test('排程觸發仍寫帳本且維持冪等', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  const runs = (await c.storage.local.get('runs')).runs || {}
  assert.equal(runs.t1?.['2026-09-06T09:00'], 'ok')
  const again = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(again, null, '同一 slot 第二次要略過')
})

test('manual 失敗：寫失敗紀錄、不建重試 alarm、不動 notFoundStreak', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: '<div>' }))
  const rec = await fe.runTask(task(), { slot: '2026-09-06T10:00', reason: 'manual', ...FAST })
  assert.ok(rec, 'manual 失敗也要有紀錄回傳')
  assert.equal(rec.status, 'not_found')
  const records = await st.getRecordsByDate('2026-09-06')
  assert.equal(records.length, 1, '失敗也要寫進紀錄，使用者才看得到')
  const retries = c.__calls.filter(x => x.api === 'alarms.create' && String(x.args[0]).includes(':retry:'))
  assert.equal(retries.length, 0, 'manual 不重試')
  const saved = await st.getTask('t1')
  assert.ok(!saved.notFoundStreak, 'manual 失敗不得累加 notFoundStreak')
  assert.ok(!saved.suggestForeground)
})

test('排程失敗維持既有重試策略（前兩次不寫紀錄）', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: '<div>' }))
  const rec = await fe.runTask(task(), { slot: '2026-09-06T11:00', attempt: 1, ...FAST })
  assert.equal(rec, null)
  assert.equal((await st.getRecordsByDate('2026-09-06')).length, 0)
  const retries = c.__calls.filter(x => x.api === 'alarms.create' && String(x.args[0]).includes(':retry:'))
  assert.equal(retries.length, 1, '排程失敗仍要排重試')
})

// ---- A2：health 隨紀錄寫回 ----

test('抓取成功把 health 寫回 ok 並更新燈號', async () => {
  const { c, st, fe, he } = await freshFetcher()
  await st.saveTask(task())
  await he.setTaskHealth('t1', { status: 'selector_lost', reason: '找不到元素' })
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  const health = await he.getHealth()
  assert.equal(health.t1.status, 'ok', '成功後必須清掉舊的紅燈')
  assert.ok(c.__calls.some(x => x.api === 'action.setBadgeText'), '燈號要跟著更新')
})

test('備援抓到寫成黃燈而不是 ok', async () => {
  const { c, st, fe, he } = await freshFetcher()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 5, raw: '5', status: 'fallback', strategyUsed: 'block', layer: 'css' }))
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  const health = await he.getHealth()
  assert.equal(health.t1.status, 'fallback')
})

test('只抓到部分寫成 partial 黃燈，且對應只有一份', async () => {
  const { c, st, fe, he } = await freshFetcher()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 7, raw: '7', status: 'ok', strategyUsed: 'block', layer: 'css', partial: true }))
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.partial, true, 'partial 必須從 content 一路傳到紀錄')
  const health = await he.getHealth()
  assert.equal(health.t1.status, 'partial')
  const src = readFileSync(new URL('../src/background/fetcher.js', import.meta.url), 'utf8')
  const writes = src.match(/setTaskHealth\(/g) || []
  assert.equal(writes.length, 1, 'fetcher 只能有一處寫 health（唯一對應）')
})

test('manual 失敗把 health 寫成紅燈', async () => {
  const { c, st, fe, he } = await freshFetcher()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: '<div>' }))
  await fe.runTask(task(), { slot: '2026-09-06T09:00', reason: 'manual', ...FAST })
  const health = await he.getHealth()
  assert.equal(health.t1.status, 'selector_lost')
})

// ---- A2：content 擷取結果整包轉發（X3）----

test('content 的 EXTRACT 回應不得丟掉 used / skipped / partial', () => {
  const src = readFileSync(new URL('../src/content/main.js', import.meta.url), 'utf8')
  assert.ok(!/value:\s*extracted\.value/.test(src), '不得用白名單逐欄轉發')
  assert.ok(/\.\.\.extracted/.test(src), '要整包展開 extracted')
})

// ---- A3：RUN_TASK 回傳結果 ----

async function freshMain() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  return { c, st }
}

// 走真實的 onMessage 契約：監聽器回傳 true，答案由 sendResponse 回呼送出
function sendTo(c, msg) {
  const listener = [...c.runtime.onMessage._listeners][0]
  return new Promise((resolve, reject) => {
    const ret = listener(msg, {}, resolve)
    if (ret !== true) reject(new Error('onMessage 監聽器必須回傳 true，非同步回覆才不會被丟掉'))
  })
}

test('RUN_TASK 回傳抓取結果，讓 UI 能就地顯示', async () => {
  const { c, st } = await freshMain()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 42, raw: '42', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  const res = await sendTo(c, { type: 'RUN_TASK', taskId: 't1', __testOpts: FAST })
  assert.equal(res.ok, true)
  assert.equal(res.outcome, 'done')
  assert.equal(res.value, 42)
  assert.equal(res.status, 'ok')
})

test('RUN_TASK 失敗時回傳 failed 與原因', async () => {
  const { c, st } = await freshMain()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: '<div>' }))
  const res = await sendTo(c, { type: 'RUN_TASK', taskId: 't1', __testOpts: FAST })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.status, 'not_found')
})

test('RUN_TASK 一律以 manual 執行（__testOpts 不得覆蓋 reason）', async () => {
  const { c, st } = await freshMain()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 9, raw: '9', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await c.storage.local.set({ runs: { t1: {} } })
  const res = await sendTo(c, { type: 'RUN_TASK', taskId: 't1', __testOpts: { ...FAST, reason: 'scheduled' } })
  assert.equal(res.outcome, 'done')
  const runs = (await c.storage.local.get('runs')).runs || {}
  assert.deepEqual(runs.t1, {}, 'manual 不寫帳本')
})

// ---- A4：storage 變更訂閱 ----

test('storage 提供訂閱入口，寫紀錄會通知', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  let hits = 0
  const off = st.subscribe(() => { hits++ })
  await st.appendRecord('2026-09-06', { taskId: 't1', slot: '2026-09-06T09:00', capturedAt: 'x', value: 1, status: 'ok' })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(hits, 1)
  off()
  await st.appendRecord('2026-09-06', { taskId: 't1', slot: '2026-09-06T09:01', capturedAt: 'y', value: 2, status: 'ok' })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(hits, 1, '取消訂閱後不得再通知')
})

test('訂閱會去抖：連續寫入只通知一次', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  let hits = 0
  st.subscribe(() => { hits++ })
  for (let i = 0; i < 5; i++) {
    await st.appendRecord('2026-09-06', { taskId: 't1', slot: `2026-09-06T09:0${i}`, capturedAt: String(i), value: i, status: 'ok' })
  }
  await new Promise(r => setTimeout(r, 60))
  assert.equal(hits, 1)
})

test('帳本與診斷的變更不觸發重繪', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  let hits = 0
  st.subscribe(() => { hits++ })
  await c.storage.local.set({ runs: { t1: { s: 'ok' } } })
  await c.storage.local.set({ diag: [1] })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(hits, 0, 'runs／diag 每次抓取都在變，不能拿來觸發重繪')
})

test('UI 仍然不得直接碰 chrome.storage', () => {
  const files = ['report.js', 'dashboard.js', 'cards.js', 'tasks.js', 'settings.js', 'drawer.js']
  for (const f of files) {
    const src = readFileSync(new URL(`../src/ui/report/${f}`, import.meta.url), 'utf8')
    assert.ok(!/chrome\.storage/.test(src), `${f} 不得直接使用 chrome.storage`)
  }
})

// ---- A5：卡片顯示規則 ----

const CARD_HTML = '<!doctype html><body></body>'

async function freshCards() {
  const jd = new JSDOM(CARD_HTML)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return await import('../src/ui/report/cards.js?t=' + Math.random())
}

const rec = (taskId, slot, value, status = 'ok', over = {}) => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status,
  date: slot.slice(0, 10), ...over
})

const ctxOf = (over = {}) => ({
  records: [], tasksById: { t1: { id: 't1', name: '電費', mode: 'number' } },
  health: {}, nextRuns: {}, missed: [],
  range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06', ...over
})

const numCard = (over = {}) => ({
  id: 'c1', type: 'number', x: 0, y: 0, w: 3, h: 2,
  source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over
})

test('只抓到部分時數值卡照顯示值，原因放 title', async () => {
  const CR = await freshCards()
  const ctx = ctxOf({
    records: [rec('t1', '2026-09-06T09:00', 88, 'ok', { partial: true })],
    health: { t1: { status: 'partial', reason: '只抓到部分' } }
  })
  const el = CR.renderCard(numCard(), ctx)
  assert.ok(el.textContent.includes('88'), `黃燈不可把值蓋掉：${el.textContent}`)
  assert.ok(!el.textContent.includes('—'))
})

test('紅燈仍顯示破折號', async () => {
  const CR = await freshCards()
  const ctx = ctxOf({
    records: [rec('t1', '2026-09-06T09:00', null, 'not_found')],
    health: { t1: { status: 'selector_lost', reason: '找不到元素' } }
  })
  const el = CR.renderCard(numCard(), ctx)
  assert.ok(el.textContent.includes('—'))
})

test('多值卡片的 health 查父任務，不會查子序列 id', async () => {
  const CR = await freshCards()
  const ctx = ctxOf({
    records: [rec('t1#buy', '2026-09-06T09:00', null, 'not_found')],
    tasksById: { 't1#buy': { id: 't1#buy', name: '台銀 · 買入', mode: 'block' } },
    health: { t1: { status: 'selector_lost', reason: '找不到元素' } }
  })
  const el = CR.renderCard(numCard({ source: [{ taskId: 't1#buy' }] }), ctx)
  const valueEl = el.querySelector('.card-number-value')
  assert.equal(valueEl.getAttribute('title'), '找不到元素', 'health 要以父任務 id 查得到')
})

// ---- A6：series-index ----

test('series-index 組合與拆解', async () => {
  const si = await import('../src/shared/series-index.js?t=' + Math.random())
  assert.equal(si.seriesIdOf('abc', 'buy'), 'abc#buy')
  assert.equal(si.seriesIdOf('abc'), 'abc', '沒有 key 就是單值任務')
  assert.equal(si.parentIdOf('abc#buy'), 'abc')
  assert.equal(si.parentIdOf('abc'), 'abc', '單值任務原樣回傳')
  assert.equal(si.parentIdOf('abcd'), 'abcd')
  assert.equal(si.fieldKeyOf('abc#buy'), 'buy')
  assert.equal(si.fieldKeyOf('abc'), '')
})

// ---- A7：立即抓取的就地回饋 ----

const TASKS_HTML = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

async function freshTasks() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(TASKS_HTML, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  return { c, st, ts, doc: jd.window.document }
}

const uiTask = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }, ...over
})

test('立即抓取成功後就地顯示抓到的值', async () => {
  const { c, ts, doc } = await freshTasks()
  c.__setRuntimeResponder(m => m.type === 'RUN_TASK' ? { ok: true, outcome: 'done', status: 'ok', value: 31.2 } : undefined)
  ts.renderTasks([uiTask('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="run"]').click()
  await new Promise(r => setTimeout(r, 30))
  const box = doc.querySelector('[data-task-id="a"] .task-run-result')
  assert.ok(box, '要有一個顯示結果的位置')
  assert.ok(box.textContent.includes('31.2'), `應顯示抓到的值：${box.textContent}`)
})

test('立即抓取失敗後就地顯示原因', async () => {
  const { c, ts, doc } = await freshTasks()
  c.__setRuntimeResponder(m => m.type === 'RUN_TASK' ? { ok: true, outcome: 'failed', status: 'not_found', error: '找不到目標元素' } : undefined)
  ts.renderTasks([uiTask('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="run"]').click()
  await new Promise(r => setTimeout(r, 30))
  const box = doc.querySelector('[data-task-id="a"] .task-run-result')
  assert.ok(box.textContent.includes('找不到目標元素'), `應顯示失敗原因：${box.textContent}`)
})

test('立即抓取執行中按鈕停用，結束後恢復', async () => {
  const { c, ts, doc } = await freshTasks()
  let release
  const gate = new Promise(r => { release = r })
  c.__setRuntimeResponder(async m => {
    if (m.type !== 'RUN_TASK') return undefined
    await gate
    return { ok: true, outcome: 'done', status: 'ok', value: 1 }
  })
  ts.renderTasks([uiTask('a')], {}, [])
  const btn = doc.querySelector('[data-task-id="a"] [data-action="run"]')
  btn.click()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(btn.disabled, true, '執行中要停用，避免連按')
  release()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(btn.disabled, false)
})

// ---- A4：報表自動重繪的接線 ----

test('report 以 storage 訂閱入口接線，不自己碰 chrome.storage', () => {
  const src = readFileSync(new URL('../src/ui/report/report.js', import.meta.url), 'utf8')
  assert.ok(/subscribe\s*\(/.test(src), 'report.js 必須訂閱 storage 變更')
  assert.ok(!/chrome\.storage/.test(src))
})

test('refreshCurrentView 只重繪目前頁籤，編輯模式中不重繪', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(TASKS_HTML, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  assert.equal(typeof rp.refreshCurrentView, 'function', 'report 要匯出可測的重繪入口')

  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  assert.equal(typeof db.isEditing, 'function')

  // 停在任務頁時不得去畫儀表板
  rp.showTab('tasks')
  await new Promise(r => setTimeout(r, 10))
  const before = jd.window.document.getElementById('dashboard-grid')?.textContent ?? ''
  await rp.refreshCurrentView()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(jd.window.document.getElementById('dashboard-grid')?.textContent ?? '', before,
    '目前在任務頁，儀表板不該被重畫')
})
