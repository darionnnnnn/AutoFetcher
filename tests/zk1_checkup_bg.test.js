// AF-21 體檢修正段 X：background 與 shared
// 1 錯過清單的 createdAt 守衛／2 離線重試上限／3 錯過清單只加不減／4 gap 的略過比不到
// 5 恢復正常清掉合併名單／6 已有重試 alarm 就不續跑／7 匯入同 id 保留執行期欄位
// 8 密語錯誤的訊息／9 取鎖逾時不等診斷／10 mutator 不得改 id／11 範圍讀的日期形狀
// 12 同一筆在兩種鍵裡要都刪掉／13 pickerDefaults 的子欄位／14 interrupted 寫診斷
// 15 擷取短等待的檢查合併／16 已知壞掉的任務不等短等待
process.env.TZ = 'Asia/Taipei'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// 假時鐘下把排在微任務佇列裡的東西（MutationObserver 回呼、await 鏈）跑完
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }
const OLD = new Date(2020, 0, 1).getTime()

const daily = (id, times = ['09:00'], over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times, weekdays: [0, 1, 2, 3, 4, 5, 6] },
  createdAt: OLD, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  return { c, st }
}

async function freshFetcher() {
  const { c, st } = await fresh()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, fe }
}

// ===================== 1. computeMissedSlots 的 createdAt 守衛 =====================

test('X1 錯過清單不回溯到任務建立之前；沒有 createdAt 的舊任務照舊全算', async () => {
  const { st } = await fresh()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  const from = new Date(2026, 8, 1, 0, 0).getTime()
  const to = new Date(2026, 8, 5, 12, 0).getTime()
  const createdAt = new Date(2026, 8, 4, 0, 0).getTime()

  const withCreated = ms.computeMissedSlots([daily('t1', ['09:00'], { createdAt })], {}, from, to)
  assert.deepEqual(withCreated.map(x => x.slot), ['2026-09-04T09:00', '2026-09-05T09:00'],
    '建立之前的 09-01～09-03 三格不得列入')

  const legacy = daily('t1', ['09:00'])
  delete legacy.createdAt
  const withoutCreated = ms.computeMissedSlots([legacy], {}, from, to)
  assert.equal(withoutCreated.length, 5, '沒有 createdAt 的舊任務維持原行為')

  // 真的走一次 refreshMissed：新建的任務第一次跑不得被回溯成一週錯過
  const now = new Date(2026, 8, 5, 12, 0).getTime()
  await st.saveTask(daily('t1', ['09:00'], { createdAt: now - 60 * 60 * 1000 }))
  await ms.refreshMissed(now, now - 7 * 86400000)
  assert.deepEqual(await st.getMissedList(), [], '一小時前才建立的任務沒有任何錯過的格子')
  assert.ok(st)
})

// ===================== 2. 離線重試有上限 =====================

test('X2 離線時重試最多三次，用盡就寫一筆「目前離線」的紀錄（含帳本與 health）', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(daily('t1'))
  globalThis.navigator = { onLine: false }

  const first = await fe.runTask(daily('t1'), { slot: '2026-09-05T09:00', attempt: 1, ...FAST })
  assert.equal(first, null)
  assert.equal(c.__calls.filter(x => x.api === 'alarms.create').length, 1, '第一次要排重試')

  const last = await fe.runTask(daily('t1'), { slot: '2026-09-05T10:00', attempt: 3, ...FAST })
  assert.equal(c.__calls.filter(x => x.api === 'alarms.create').length, 1, '第三次不得再排下一個 alarm')
  assert.equal(last.status, 'error')
  assert.equal(last.error, '目前離線')
  assert.equal(await st.getRunStatus('t1', '2026-09-05T10:00'), 'error', '要寫帳本')
  const health = await st.getHealthMap()
  assert.ok(health.t1, '要更新燈號')
  globalThis.navigator = { onLine: true }
})

// ===================== 3. 錯過清單只加不減 =====================

test('X3 refreshMissed 會丟掉帳本已有的格子與任務已不存在的項目（含 gap）', async () => {
  const { c, st } = await fresh()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  const now = new Date(2026, 8, 5, 12, 0).getTime()
  await st.saveTask(daily('t1', ['09:00']))
  await st.setRunStatus('t1', '2026-09-05T09:00', 'ok')
  await c.storage.local.set({
    missed: [
      { taskId: 't1', taskName: 't1', slot: '2026-09-05T09:00' },
      { taskId: 'gone', taskName: 'gone', slot: '2026-09-05T08:00' },
      { taskId: 'gone', taskName: 'gone', kind: 'gap', count: 3, from: '2026-09-05T07:00', slot: '2026-09-05T08:00' }
    ]
  })
  await ms.refreshMissed(now, now - 6 * 3600 * 1000)
  const list = await st.getMissedList()
  assert.ok(!list.some(m => m.taskId === 'gone'), '任務已不存在的項目（含 gap）要丟掉')
  assert.ok(!list.some(m => m.taskId === 't1' && m.slot === '2026-09-05T09:00'), '帳本已有那一格就不再算錯過')
})

test('X3b deleteTasks 之後 alertLog／notifyLog／health／missed 立刻乾淨，不等看門狗', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('t1'))
  await c.storage.local.set({
    alertLog: { t1: { at: 1 }, keep: { at: 1 } },
    notifyLog: { t1: { status: 'error', at: 1 }, 'site:https://a.test': { status: 'x', at: 1 } },
    health: { t1: { level: 'red' } },
    missed: [{ taskId: 't1', slot: '2026-09-05T09:00' }, { taskId: 't1', kind: 'gap', slot: '2026-09-05T10:00' }]
  })
  await st.deleteTasks(['t1'])
  const all = await c.storage.local.get(null)
  assert.deepEqual(Object.keys(all.alertLog), [], '已刪任務的告警紀錄要清')
  assert.deepEqual(Object.keys(all.notifyLog), [], '已刪任務與不存在站台的冷卻紀錄要清')
  assert.deepEqual(Object.keys(all.health), [], '燈號要清')
  assert.deepEqual(await st.getMissedList(), [], '錯過清單（含 gap）要清')
})

// ===================== 4. gap 的略過只比 taskId =====================

test('X4 skipOne 對 gap 只比 taskId（slot 已經延伸過照樣移得掉）並回傳移除筆數', async () => {
  const { c, st } = await fresh()
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  await c.storage.local.set({
    missed: [{ taskId: 'i1', taskName: 'i1', kind: 'gap', count: 5, from: '2026-09-05T07:00', slot: '2026-09-05T11:30' }]
  })
  // UI 手上是上一輪的舊 slot
  const removed = await ms.skipOne('i1', '2026-09-05T09:00')
  assert.equal(removed, 1)
  assert.deepEqual(await st.getMissedList(), [])

  // 一般的排程槽項目仍然要比對 slot
  await c.storage.local.set({
    missed: [{ taskId: 'd1', taskName: 'd1', slot: '2026-09-05T09:00' }]
  })
  assert.equal(await ms.skipOne('d1', '2026-09-05T10:00'), 0, '比不到就不得亂刪')
  assert.equal((await st.getMissedList()).length, 1)
  assert.equal(await ms.skipOne('d1', '2026-09-05T09:00'), 1)
})

test('X4b SKIP_ONE 回應帶 removed；一筆都沒移除時回 ok:false 與可讀的原因', async () => {
  const { c, st } = await fresh()
  await st.saveTask(daily('d1'))
  await c.storage.local.set({ missed: [{ taskId: 'd1', taskName: 'd1', slot: '2026-09-05T09:00' }] })
  const bg = await import('../src/background/main.js?t=' + Math.random())

  const miss = await bg.handleMessage({ type: 'SKIP_ONE', taskId: 'd1', slot: '2026-09-05T23:00' })
  assert.equal(miss.ok, false)
  assert.match(miss.error, /重新整理/)

  const hit = await bg.handleMessage({ type: 'SKIP_ONE', taskId: 'd1', slot: '2026-09-05T09:00' })
  assert.deepEqual(hit, { ok: true, removed: 1 }, '舊的 {taskId, slot} 呼叫形狀仍然可用')
})

// ===================== 5. 恢復正常時清掉合併名單 =====================

test('X5 clearNotifyLog 同時把該任務從 failMerge 的名單拿掉', async () => {
  const { c, st } = await fresh()
  const nt = await import('../src/background/notify.js?t=' + Math.random())
  await c.storage.session.set({
    failMerge: {
      'https://a.test': { at: Date.now(), items: [{ id: 't1', name: '甲' }, { id: 't2', name: '乙' }] },
      'https://b.test': { at: Date.now(), items: [{ id: 't1', name: '甲' }] }
    }
  })
  await c.storage.local.set({ notifyLog: { t1: { status: 'error', at: 1 } } })
  await nt.clearNotifyLog('t1')
  const merge = (await c.storage.session.get('failMerge')).failMerge
  assert.deepEqual(merge['https://a.test'].items.map(x => x.id), ['t2'], '恢復正常的任務不得留在合併名單')
  assert.equal(merge['https://b.test'], undefined, '名單空掉的站台整筆移除')
  assert.deepEqual((await c.storage.local.get('notifyLog')).notifyLog, {})
  assert.ok(st)
})

// ===================== 6. 已有重試 alarm 就不續跑 =====================

test('X6 recoverRunState：同任務同 slot 已排著重試 alarm 時只移除登記、不續跑', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(daily('t1'))
  await c.storage.session.set({
    runState: { 't1@2026-09-05T09:00': { state: 'running', at: Date.now(), boot: 'other-worker', attempt: 1, reason: 'scheduled' } }
  })
  await c.alarms.create('t1:retry:1@2026-09-05T09:00', { when: Date.now() + 60000 })
  await fe.recoverRunState(FAST)
  assert.deepEqual(await st.getRunState(), {}, 'runState 項目要移除')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0, '不得續跑（交給那個 alarm）')
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 0, '也不得寫 interrupted')
})

test('X6b 沒有那個重試 alarm 時照樣續跑', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(daily('t1'))
  await c.storage.session.set({
    runState: { 't1@2026-09-05T09:00': { state: 'running', at: Date.now(), boot: 'other-worker', attempt: 1, reason: 'scheduled' } }
  })
  await c.alarms.create('t1:retry:1@2026-09-05T23:00', { when: Date.now() + 60000 })
  await fe.recoverRunState(FAST)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 1, '別的格子的重試 alarm 不算')
})

// ===================== 14. interrupted 寫診斷 =====================

test('X14 寫 interrupted 紀錄時同時寫一筆 diag', async () => {
  const { c, st, fe } = await freshFetcher()
  await st.saveTask(daily('t1'))
  const diag = await import('../src/shared/diag.js?t=' + Math.random())
  await c.storage.session.set({
    runState: { 't1@2026-09-05T09:00': { state: 'running', at: Date.now() - 60 * 60 * 1000, boot: 'other-worker' } }
  })
  await fe.recoverRunState(FAST)
  const rec = (await st.getRecordsByDate('2026-09-05'))[0]
  assert.equal(rec.status, 'interrupted')
  const entries = (await diag.getAll()).filter(e => e.kind === 'interrupted')
  assert.deepEqual(entries.map(e => e.detail), ['t1@2026-09-05T09:00'])
})

// ===================== 7／8／13 設定匯入 =====================

const fileOf = (data, secrets) => JSON.stringify({ kind: 'autofetcher-settings', version: 1, exportedAt: 'x', data, ...(secrets ? { secrets } : {}) })

test('X7 匯入同 id 任務時，匯入檔沒帶的執行期欄位沿用本機既有值', async () => {
  const { st } = await fresh()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  await st.saveTasks([daily('t1', ['09:00'], {
    enabled: false, foreground: true, suggestForeground: true, notFoundStreak: 2, createdAt: 111
  })])

  // 手改過／舊版的匯入檔沒有這些執行期欄位
  const incoming = daily('t1', ['10:00'])
  for (const f of ['createdAt', 'enabled', 'foreground', 'suggestForeground', 'notFoundStreak']) delete incoming[f]
  const { plan } = await io.previewSettingsImport(fileOf({ tasks: [incoming] }))
  await io.applySettingsImport(plan)

  const saved = await st.getTask('t1')
  assert.equal(saved.schedule.times[0], '10:00', '匯入檔帶的欄位照樣覆蓋')
  assert.equal(saved.enabled, false, '停用中的任務不得被匯入復活')
  assert.equal(saved.foreground, true)
  assert.equal(saved.suggestForeground, true)
  assert.equal(saved.notFoundStreak, 2)
  assert.equal(saved.createdAt, 111)
})

test('X7b 匯入檔自己帶了那些欄位時以匯入檔為準', async () => {
  const { st } = await fresh()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  await st.saveTasks([daily('t1', ['09:00'], { enabled: false, notFoundStreak: 2, createdAt: 111 })])
  const incoming = daily('t1', ['09:00'], { enabled: true, notFoundStreak: 0, createdAt: 222 })
  const { plan } = await io.previewSettingsImport(fileOf({ tasks: [incoming] }))
  await io.applySettingsImport(plan)
  const saved = await st.getTask('t1')
  assert.equal(saved.enabled, true)
  assert.equal(saved.notFoundStreak, 0)
  assert.equal(saved.createdAt, 222)
})

test('X8 密語錯誤時給看得懂的中文，不露出 WebCrypto 原文', async () => {
  const { st } = await fresh()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  await st.saveSettings({ retentionDays: 30 })
  const exported = await io.exportSettings({ includePasswords: true, passphrase: 'right-pass' })
  await assert.rejects(
    () => io.previewSettingsImport(exported, { passphrase: 'wrong-pass' }),
    (err) => {
      assert.equal(err.message, '密語錯誤或加密資料已損毀，請確認密語')
      return true
    }
  )
  // 密語對的時候照樣解得開
  const { plan } = await io.previewSettingsImport(exported, { passphrase: 'right-pass' })
  assert.ok(plan)
})

test('X13 pickerDefaults 的 pinned／last 不是物件時整個 pickerDefaults 不收', async () => {
  const { st } = await fresh()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  const bad = await io.previewSettingsImport(fileOf({ settings: { pickerDefaults: { pinned: ['a'], last: {} } } }))
  assert.ok(!bad.summary.settings.applied.includes('pickerDefaults'))
  assert.ok(bad.summary.settings.rejected.some(r => r.key === 'pickerDefaults'))
  assert.equal(bad.plan.settings, null, '不得寫進計畫')

  const ok = await io.previewSettingsImport(fileOf({ settings: { pickerDefaults: { pinned: { a: 1 }, last: {} } } }))
  assert.deepEqual(ok.summary.settings.applied, ['pickerDefaults'])
  assert.ok(st)
})

// ===================== 9. 取鎖逾時不等診斷 =====================

test('X9 取鎖逾時時不等診斷寫完：diag 鎖也塞住也不會讓等待加倍', async () => {
  await fresh()
  // 一定要用 diag.js 實際載到的那一份 lock 模組（帶 ?t= 會是另一個實例，佔不到同一把 diag 鎖）
  const lk = await import('../src/shared/lock.js')
  let releaseDiag
  const diagHeld = new Promise((resolve) => { releaseDiag = resolve })
  // diag 鎖整段時間都被佔著
  const diagHolder = lk.withLock('diag', () => diagHeld)
  // 目標鎖也被佔著，讓 withLock 走「取鎖逾時」那條路
  let releaseTarget
  const targetHeld = new Promise((resolve) => { releaseTarget = resolve })
  const targetHolder = lk.withLock('k', () => targetHeld)
  await sleep(5)

  const startedAt = Date.now()
  let ran = false
  await lk.withLock('k', () => { ran = true }, { timeoutMs: 30 })
  const elapsed = Date.now() - startedAt
  assert.equal(ran, true, '逾時要不帶鎖照做')
  assert.ok(elapsed < 200, `不得再等 diag 鎖，實測 ${elapsed}ms`)

  releaseTarget()
  releaseDiag()
  await targetHolder
  await diagHolder
})

// ===================== 10～12 storage =====================

test('X10 updateTasks 的 mutator 改了 id 要丟例外，而且不得多出一筆任務', async () => {
  const { st } = await fresh()
  await st.saveTasks([daily('t1')])
  await assert.rejects(
    () => st.updateTasks(['t1'], (t) => { t.id = 't9'; return t }),
    /不得在 mutator 內改任務 id/
  )
  const tasks = await st.getTasks()
  assert.deepEqual(tasks.map(t => t.id), ['t1'])
})

test('X11 getRecordsInRange 的 from／to 不是 YYYY-MM-DD 時回空陣列，不掃整個 storage', async () => {
  const { c, st } = await fresh()
  await st.appendRecord('2026-09-05', { taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z', status: 'ok', value: 1 })
  const before = c.__calls.length
  for (const [from, to] of [['', '2026-09-05'], ['2026-09-05', ''], ['2026-9-5', '2026-09-05'], [undefined, undefined]]) {
    assert.deepEqual(await st.getRecordsInRange(from, to), [], `${from}～${to} 要回空陣列`)
  }
  const after = c.__calls.slice(before)
  assert.equal(after.filter(x => x.api === 'local.getKeys' || x.api === 'local.get').length, 0,
    '形狀不對就不該讀 storage（退去掃整庫的話紀錄可能有 MB 級）')
  // 形狀正確的範圍照舊讀得到
  assert.equal((await st.getRecordsInRange('2026-09-05', '2026-09-05')).length, 1)
})

test('X12 同一筆同時在舊日鍵與小時鍵時 deleteRecord 要兩邊都刪掉', async () => {
  const { c, st } = await fresh()
  const rec = { taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z', status: 'ok', value: 1 }
  const other = { taskId: 't2', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T02:00:00.000Z', status: 'ok', value: 2 }
  await c.storage.local.set({
    'rec:2026-09-05': [rec],
    'rec2:2026-09-05:01': [rec, other]
  })
  await st.deleteRecord('2026-09-05', 't1', rec.capturedAt)
  const left = await st.getRecordsByDate('2026-09-05')
  assert.deepEqual(left.map(r => r.taskId), ['t2'], '兩種鍵裡的那一筆都要刪掉')
  const all = await c.storage.local.get(null)
  assert.equal(all['rec:2026-09-05'], undefined, '空掉的鍵要移除')
})

// ===================== 15／16 擷取短等待 =====================

async function contentPage(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MutationObserver = jd.window.MutationObserver
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?t=' + Math.random())
  return { c, doc: jd.window.document }
}

const LOC = { css: '#late', path: '', anchor: null, xpath: '' }

// 會自己重繪的頁面：每 5 毫秒動一次 DOM
async function churn(doc, times, stepMs = 5) {
  for (let i = 0; i < times; i++) {
    const el = doc.createElement('span')
    el.textContent = String(i)
    doc.body.appendChild(el)
    await sleep(stepMs)
  }
}

test('X15 擷取短等待的檢查要合併：DOM 一直變也不是每次都全文件掃一遍', async () => {
  const { c, doc } = await contentPage('<div id="v">1</div>')
  let scans = 0
  const orig = doc.querySelectorAll.bind(doc)
  doc.querySelectorAll = (sel) => {
    if (sel === '#late') scans++
    return orig(sel)
  }
  const done = c.__emitMessage({ type: 'EXTRACT', locator: LOC, spec: { strategy: 'auto' }, settleMs: 400 })
  await churn(doc, 40)
  const res = await done
  assert.equal(res.ok, false, '這一輪本來就找不到')
  assert.ok(scans >= 2, `前提：要真的有檢查過（實得 ${scans}）`)
  assert.ok(scans <= 10, `400 毫秒內最多檢查 4～5 次，實得 ${scans}`)
})

test('X15b 合併之後晚來的元素照樣等得到（含逾時前的最後一次檢查）', async () => {
  const { c, doc } = await contentPage('<div id="v">1</div>')
  const done = c.__emitMessage({ type: 'EXTRACT', locator: LOC, spec: { strategy: 'auto' }, settleMs: 500 })
  await sleep(60)
  const el = doc.createElement('div')
  el.id = 'late'
  el.textContent = '77'
  doc.body.appendChild(el)
  const res = await done
  assert.equal(res.ok, true, '晚 60 毫秒才出現的元素要抓得到')
  assert.equal(res.value, 77)
})

test('X15c 最後一次變動落在節流窗裡時，逾時前的最後一次檢查要抓到它', async () => {
  const { c, doc } = await contentPage('<div id="v">1</div>')
  // 假時鐘：這一條要的是「變動時刻與逾時時刻的相對位置」，用真時鐘會偶發
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  try {
    const done = c.__emitMessage({ type: 'EXTRACT', locator: LOC, spec: { strategy: 'auto' }, settleMs: 280 })
    await flush()
    // t=200 一次變動（立刻檢查，節流窗從這裡重新算）
    mock.timers.tick(200)
    doc.body.appendChild(doc.createElement('span'))
    await flush()
    // t=220 元素才出現：節流排的下一次檢查在 t=320，比 280 的逾時還晚
    mock.timers.tick(20)
    const el = doc.createElement('div')
    el.id = 'late'
    el.textContent = '88'
    doc.body.appendChild(el)
    await flush()
    // t=280 逾時
    mock.timers.tick(60)
    const res = await done
    assert.equal(res.ok, true, '逾時前要再檢查最後一次')
    assert.equal(res.value, 88)
  } finally {
    mock.timers.reset()
  }
})

test('X16 EXTRACT 帶 settleMs:0 時不等短等待', async () => {
  const { c, doc } = await contentPage('<div id="v">1</div>')
  const startedAt = Date.now()
  const res = await c.__emitMessage({ type: 'EXTRACT', locator: LOC, spec: { strategy: 'auto' }, settleMs: 0 })
  const elapsed = Date.now() - startedAt
  assert.equal(res.ok, false)
  assert.ok(elapsed < 200, `不得再等 3 秒，實測 ${elapsed}ms`)
  assert.ok(doc)
})

test('X16b fetcher 在 notFoundStreak >= 1 時帶 settleMs:0，沒壞過的任務不帶', async () => {
  const { c, st, fe } = await freshFetcher()
  const seen = []
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'EXTRACT') seen.push(msg)
    return { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
  })
  await st.saveTask(daily('t1'))
  await fe.runTask(daily('t1'), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(seen.at(-1).settleMs, undefined, '沒壞過的任務照舊等短等待')

  await st.saveTask(daily('t2', ['09:00'], { notFoundStreak: 1 }))
  await fe.runTask(daily('t2', ['09:00'], { notFoundStreak: 1 }), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(seen.at(-1).settleMs, 0, '已知找不到元素的任務不必每次多等 3 秒')
})
