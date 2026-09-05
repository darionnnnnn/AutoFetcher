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
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  return { c, st, ts, doc: jd.window.document, win: jd.window }
}

// ---- 純函式：篩選 ----

test('filterTasks 以關鍵字比對名稱', async () => {
  const { ts } = await fresh()
  const list = [task('a', { name: '電費' }), task('b', { name: '水費' })]
  assert.deepEqual(ts.filterTasks(list, { q: '電' }).map(t => t.id), ['a'])
})

test('filterTasks 關鍵字也比對網址且不分大小寫', async () => {
  const { ts } = await fresh()
  const list = [task('a', { url: 'https://Bank.test/x' }), task('b', { url: 'https://mail.test/y' })]
  assert.deepEqual(ts.filterTasks(list, { q: 'bank' }).map(t => t.id), ['a'])
})

test('filterTasks 只看失敗時排除健康與未抓過的任務', async () => {
  const { ts } = await fresh()
  const list = [task('a'), task('b'), task('c')]
  const health = { a: { status: 'not_found' }, b: { status: 'ok' } }
  assert.deepEqual(ts.filterTasks(list, { failedOnly: true }, health).map(t => t.id), ['a'])
})

test('filterTasks 兩個條件同時成立才留下，空條件回全部', async () => {
  const { ts } = await fresh()
  const list = [task('a', { name: '電費' }), task('b', { name: '電表' })]
  const health = { b: { status: 'error' } }
  assert.deepEqual(ts.filterTasks(list, { q: '電', failedOnly: true }, health).map(t => t.id), ['b'])
  assert.equal(ts.filterTasks(list, {}, health).length, 2)
})

// ---- 純函式：複製 ----

test('duplicateTask 產生新 id、名稱加副本、預設停用', async () => {
  const { ts } = await fresh()
  const copy = ts.duplicateTask(task('a', { name: '電費', order: 3 }))
  assert.notEqual(copy.id, 'a')
  assert.ok(copy.id && copy.id.length > 0)
  assert.equal(copy.name, '電費(副本)')
  assert.equal(copy.enabled, false)
})

test('duplicateTask 不沿用原本的健康與排程狀態欄位', async () => {
  const { ts } = await fresh()
  const copy = ts.duplicateTask(task('a', { notFoundStreak: 5, order: 2 }))
  assert.ok(!copy.notFoundStreak, 'notFoundStreak 不可沿用')
  assert.equal(copy.order, undefined, 'order 交由 saveTask 配發')
})

// ---- 渲染 ----

test('renderTasks 每個任務一列，顯示名稱與下次執行', async () => {
  const { ts, doc } = await fresh()
  ts.renderTasks([task('a'), task('b')], {}, [], { nextRuns: { a: '2026-09-07 09:00' } })
  const rows = doc.querySelectorAll('#task-list [data-task-id]')
  assert.equal(rows.length, 2)
  assert.ok(doc.querySelector('#task-list').textContent.includes('任務a'))
  assert.ok(doc.querySelector('#task-list').textContent.includes('2026-09-07 09:00'))
})

test('renderTasks 顯示連續失敗數，最後錯誤放 title 不用 innerHTML', async () => {
  const { ts, doc } = await fresh()
  ts.renderTasks([task('a', { notFoundStreak: 3 })], { a: { status: 'not_found', reason: '找不到元素' } }, [])
  const row = doc.querySelector('[data-task-id="a"]')
  assert.ok(row.textContent.includes('3'), '要顯示連續失敗次數')
  const holder = row.querySelector('[title]')
  assert.ok(holder && holder.getAttribute('title').includes('找不到元素'))
})

test('renderTasks 任務名以 textContent 呈現，HTML 不被解譯', async () => {
  const { ts, doc } = await fresh()
  ts.renderTasks([task('a', { name: '<img src=x onerror=1>' })], {}, [])
  assert.equal(doc.querySelectorAll('#task-list img').length, 0)
  assert.ok(doc.querySelector('#task-list').textContent.includes('<img'))
})

test('啟用開關切換會寫回 storage 並重建排程', async () => {
  const { ts, st, c, doc } = await fresh()
  await st.saveTask(task('a'))
  ts.renderTasks([task('a')], {}, [])
  const box = doc.querySelector('[data-task-id="a"] input[type="checkbox"][data-action="toggle"]')
  box.checked = false
  box.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 10))
  assert.equal((await st.getTask('a')).enabled, false)
  assert.ok(c.__calls.some(x => x.api === 'runtime.sendMessage' && x.args[0]?.type === 'REBUILD_ALARMS'))
})

test('立即抓取送出 RUN_TASK 訊息', async () => {
  const { ts, c, doc } = await fresh()
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="run"]').click()
  await new Promise(r => setTimeout(r, 10))
  const sent = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  assert.ok(sent.some(m => m.type === 'RUN_TASK' && m.taskId === 'a'))
})

test('編輯開啟 Picker 並帶 taskId 參數', async () => {
  const { ts, c, doc } = await fresh()
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="edit"]').click()
  await new Promise(r => setTimeout(r, 10))
  const opened = c.__calls.filter(x => x.api === 'tabs.create' || x.api === 'windows.create')
  const urls = JSON.stringify(opened)
  assert.ok(urls.includes('taskId=a'), `應以 ?taskId=a 開啟 picker，實得 ${urls}`)
})

test('複製任務寫入 storage 且不自動啟用', async () => {
  const { ts, st, doc } = await fresh()
  await st.saveTask(task('a'))
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="duplicate"]').click()
  await new Promise(r => setTimeout(r, 20))
  const all = await st.getTasks()
  assert.equal(all.length, 2)
  const copy = all.find(t => t.id !== 'a')
  assert.equal(copy.enabled, false)
})

// ---- 刪除保護 ----

test('刪除對話框顯示將一併刪除的紀錄筆數', async () => {
  const { ts, st, doc } = await fresh()
  await st.saveTask(task('a'))
  await st.appendRecord('2026-09-05', { taskId: 'a', capturedAt: 'x', value: 1, status: 'ok' })
  await st.appendRecord('2026-09-05', { taskId: 'a', capturedAt: 'y', value: 2, status: 'ok' })
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
  await new Promise(r => setTimeout(r, 20))
  const dlg = doc.getElementById('task-delete-dialog')
  assert.ok(dlg && !dlg.hidden, '要出現刪除確認對話框')
  assert.ok(dlg.textContent.includes('2'), `對話框要顯示 2 筆紀錄，實得：${dlg.textContent}`)
})

test('刪除對話框取消時 storage 完全不變', async () => {
  const { ts, st, doc } = await fresh()
  await st.saveTask(task('a'))
  await st.appendRecord('2026-09-05', { taskId: 'a', capturedAt: 'x', value: 1, status: 'ok' })
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
  await new Promise(r => setTimeout(r, 20))
  doc.querySelector('#task-delete-dialog [data-action="cancel"]').click()
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await st.getTasks()).length, 1)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 1)
})

test('刪除對話框確認後任務與紀錄都清掉', async () => {
  const { ts, st, doc } = await fresh()
  await st.saveTask(task('a'))
  await st.appendRecord('2026-09-05', { taskId: 'a', capturedAt: 'x', value: 1, status: 'ok' })
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
  await new Promise(r => setTimeout(r, 20))
  doc.querySelector('#task-delete-dialog [data-action="confirm"]').click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await st.getTasks()).length, 0)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 0)
})

test('先匯出再刪除會呼叫下載後才刪任務', async () => {
  const { ts, st, c, doc } = await fresh()
  await st.saveTask(task('a'))
  await st.appendRecord('2026-09-05', { taskId: 'a', capturedAt: 'x', value: 1, status: 'ok' })
  ts.renderTasks([task('a')], {}, [])
  doc.querySelector('[data-task-id="a"] [data-action="delete"]').click()
  await new Promise(r => setTimeout(r, 20))
  doc.querySelector('#task-delete-dialog [data-action="export-then-delete"]').click()
  await new Promise(r => setTimeout(r, 40))
  assert.ok(c.__calls.some(x => x.api === 'downloads.download'), '要先觸發下載')
  assert.equal((await st.getTasks()).length, 0, '下載後才刪除任務')
})

// ---- 錯過清單橫幅 ----

test('錯過清單橫幅逐筆列出，沒有錯過時不顯示', async () => {
  const { ts, doc } = await fresh()
  ts.renderTasks([task('a')], {}, [])
  assert.ok(doc.getElementById('missed-banner').hidden, '沒有錯過時橫幅要隱藏')
  ts.renderTasks([task('a')], {}, [{ taskId: 'a', slot: '2026-09-05T09:00' }, { taskId: 'a', slot: '2026-09-05T10:00' }])
  const banner = doc.getElementById('missed-banner')
  assert.equal(banner.hidden, false)
  assert.equal(banner.querySelectorAll('input[type="checkbox"]').length, 2)
})

test('補抓勾選只送出被勾選的那幾筆', async () => {
  const { ts, c, doc } = await fresh()
  ts.renderTasks([task('a')], {}, [
    { taskId: 'a', slot: '2026-09-05T09:00' },
    { taskId: 'a', slot: '2026-09-05T10:00' }
  ])
  const boxes = doc.querySelectorAll('#missed-banner input[type="checkbox"]')
  boxes[0].checked = true
  boxes[1].checked = false
  doc.querySelector('#missed-banner [data-action="catch-up"]').click()
  await new Promise(r => setTimeout(r, 20))
  const sent = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
    .filter(m => m.type === 'CATCH_UP_ONE')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].slot, '2026-09-05T09:00')
})

test('略過勾選送出 SKIP_ONE', async () => {
  const { ts, c, doc } = await fresh()
  ts.renderTasks([task('a')], {}, [{ taskId: 'a', slot: '2026-09-05T09:00' }])
  doc.querySelector('#missed-banner input[type="checkbox"]').checked = true
  doc.querySelector('#missed-banner [data-action="skip"]').click()
  await new Promise(r => setTimeout(r, 20))
  const sent = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  assert.ok(sent.some(m => m.type === 'SKIP_ONE' && m.slot === '2026-09-05T09:00'))
})

// ---- 搜尋列接線 ----

test('搜尋框輸入後只留下符合的列', async () => {
  const { ts, doc, win } = await fresh()
  ts.renderTasks([task('a', { name: '電費' }), task('b', { name: '水費' })], {}, [])
  const q = doc.getElementById('task-search')
  q.value = '水'
  q.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 10))
  const ids = [...doc.querySelectorAll('#task-list [data-task-id]')].map(e => e.dataset.taskId)
  assert.deepEqual(ids, ['b'])
})

test('只看失敗勾選後只留下異常任務', async () => {
  const { ts, doc, win } = await fresh()
  ts.renderTasks([task('a'), task('b')], { a: { status: 'not_found' } }, [])
  const box = doc.getElementById('task-failed-only')
  box.checked = true
  box.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 10))
  const ids = [...doc.querySelectorAll('#task-list [data-task-id]')].map(e => e.dataset.taskId)
  assert.deepEqual(ids, ['a'])
})

// ---- 排序 ----

test('applyOrder 依給定順序寫回連續 order', async () => {
  const { ts, st } = await fresh()
  await st.saveTask(task('a'))
  await st.saveTask(task('b'))
  await st.saveTask(task('c'))
  await ts.applyOrder(['c', 'a', 'b'])
  const all = await st.getTasks()
  assert.deepEqual(all.map(t => t.id), ['c', 'a', 'b'])
  assert.deepEqual(all.map(t => t.order), [0, 1, 2])
})

// ---- background：單筆補抓 ----

test('catchUpOne 只補抓指定那一筆並從清單移除', async () => {
  const { st, c } = await fresh()
  await st.saveTask(task('a'))
  await c.storage.local.set({ missed: [
    { taskId: 'a', slot: '2026-09-05T09:00' },
    { taskId: 'a', slot: '2026-09-05T10:00' }
  ] })
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  const ran = []
  await ms.catchUpOne('a', '2026-09-05T09:00', (t, opts) => { ran.push(opts.slot) })
  assert.deepEqual(ran, ['2026-09-05T09:00'])
  const left = await ms.getMissed()
  assert.deepEqual(left.map(m => m.slot), ['2026-09-05T10:00'])
})

test('catchUpOne 對不存在的項目不執行也不丟錯', async () => {
  const { st, c } = await fresh()
  await st.saveTask(task('a'))
  await c.storage.local.set({ missed: [{ taskId: 'a', slot: '2026-09-05T09:00' }] })
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  const ran = []
  await ms.catchUpOne('a', '2026-09-05T23:00', (t, opts) => { ran.push(opts.slot) })
  assert.deepEqual(ran, [])
  assert.equal((await ms.getMissed()).length, 1, '不存在時不可清掉別人')
})

test('CATCH_UP_ONE 與 SKIP_ONE 訊息在 background 有處理', async () => {
  const { st, c } = await fresh()
  await st.saveTask(task('a'))
  await c.storage.local.set({ missed: [{ taskId: 'a', slot: '2026-09-05T09:00' }] })
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const res = await bg.handleMessage({ type: 'SKIP_ONE', taskId: 'a', slot: '2026-09-05T09:00' })
  assert.deepEqual(res, { ok: true })
  const ms = await import('../src/background/missed.js?t=' + Math.random())
  assert.equal((await ms.getMissed()).length, 0)
  const res2 = await bg.handleMessage({ type: 'CATCH_UP_ONE', taskId: 'a', slot: '2026-09-05T11:00' })
  assert.deepEqual(res2, { ok: true })
})

test('messages.js 有三個新訊息型別', async () => {
  const { MSG } = await import('../src/shared/messages.js?t=' + Math.random())
  assert.equal(MSG.CATCH_UP_ONE, 'CATCH_UP_ONE')
  assert.equal(MSG.SKIP_ONE, 'SKIP_ONE')
  assert.equal(MSG.REPICK, 'REPICK')
})

// ---- Picker 以 taskId 開啟 ----

test('Picker 以 ?taskId= 開啟時載入該任務並帶入表單', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task('a', { name: '電費' }))
  const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html?taskId=a' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  await pk.initFromQuery('?taskId=a')
  assert.equal(jd.window.document.getElementById('name').value, '電費')
  assert.ok(jd.window.document.getElementById('test-now').hidden, '沒有分頁時要隱藏立即測試')
  void c
})
