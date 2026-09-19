// AF-19 作業 B：任務頁多選與整批動作、就地改名、排程欄可點
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
  // jsdom 25 沒有 <dialog> 的 showModal／close（AF-21 4-D 共用 modal）：替身只切 open 屬性
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  return { c, st, ts, doc: jd.window.document, win: jd.window }
}

const setsAfter = (c, m) => c.__calls.slice(m).filter(x => x.api === 'storage.local.set').length
const mark = (c) => c.__calls.length
const rowOf = (doc, id) => doc.querySelector(`[data-task-id="${id}"]`)
const boxOf = (doc, id) => rowOf(doc, id)?.querySelector('[data-action="select"]')
const tick = () => new Promise(r => setTimeout(r, 20))

// 勾選一列（可帶 shiftKey）
function pick(win, doc, id, shift = false) {
  const box = boxOf(doc, id)
  box.checked = !box.checked
  box.dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: shift }))
}

async function withTasks(ids) {
  const env = await fresh()
  const list = ids.map(id => task(id))
  await env.st.saveTasks(list)
  env.ts.renderTasks(list, {}, [], { nextRuns: {} })
  return env
}

// ================= 多選 =================

test('B 每一列有勾選框，勾了之後動作列說出已選幾個', async () => {
  const { ts, doc, win } = await withTasks(['a', 'b', 'd'])
  const bar = doc.getElementById('task-bulk-bar')
  assert.ok(bar, '要有整批動作列')
  assert.equal(bar.hidden, true, '沒選任何東西時不該佔版面')

  pick(win, doc, 'a')
  pick(win, doc, 'b')
  assert.equal(bar.hidden, false)
  assert.match(bar.textContent, /已選 2 個/)
  assert.ok(rowOf(doc, 'a').classList.contains('selected'))
  assert.ok(!rowOf(doc, 'd').classList.contains('selected'))
  assert.ok(boxOf(doc, 'a').getAttribute('aria-label'), '勾選框要有說得出是哪個任務的標籤')
  void ts
})

test('B 選取狀態跨重畫保留（抓取一次就會重畫整頁）', async () => {
  const { ts, st, doc, win } = await withTasks(['a', 'b', 'd'])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  // health 每抓一次就變，任務頁會整份重畫
  ts.renderTasks(await st.getTasks(), { a: { status: 'ok' } }, [], { nextRuns: {} })
  assert.equal(boxOf(doc, 'a').checked, true, '重畫不得把選取清掉')
  assert.equal(boxOf(doc, 'b').checked, true)
  assert.equal(boxOf(doc, 'd').checked, false)
  assert.match(doc.getElementById('task-bulk-bar').textContent, /已選 2 個/)
})

test('B 被刪掉的任務要從選取裡剔除', async () => {
  const { ts, st, doc, win } = await withTasks(['a', 'b'])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  await st.deleteTasks(['b'])
  ts.renderTasks(await st.getTasks(), {}, [], { nextRuns: {} })
  assert.match(doc.getElementById('task-bulk-bar').textContent, /已選 1 個/)
})

test('B Shift＋點從上一次點的那列做範圍加選', async () => {
  const { doc, win } = await withTasks(['a', 'b', 'd', 'e'])
  pick(win, doc, 'a')
  pick(win, doc, 'e', true)
  for (const id of ['a', 'b', 'd', 'e']) {
    assert.equal(boxOf(doc, id).checked, true, `${id} 要在範圍內`)
  }
})

test('B Shift＋點在已選的列上是整段取消', async () => {
  const { doc, win } = await withTasks(['a', 'b', 'd', 'e'])
  pick(win, doc, 'a')
  pick(win, doc, 'e', true)
  // 現在四個都選了；從 e 往回 Shift 點 b → b～e 取消
  pick(win, doc, 'b', true)
  assert.equal(boxOf(doc, 'a').checked, true)
  assert.equal(boxOf(doc, 'b').checked, false)
  assert.equal(boxOf(doc, 'd').checked, false)
  assert.equal(boxOf(doc, 'e').checked, false)
})

test('B Shift 的錨點被搜尋濾掉時只切換被點的那一列', async () => {
  const { doc, win } = await withTasks(['a', 'b', 'd'])
  pick(win, doc, 'a')
  const search = doc.getElementById('task-search')
  search.value = '任務d'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  pick(win, doc, 'd', true)
  assert.equal(boxOf(doc, 'd').checked, true)
  assert.match(doc.getElementById('task-bulk-bar').textContent, /已選 2 個/)
})

test('B 全選只作用在目前篩選出來的列', async () => {
  const { doc, win } = await withTasks(['a', 'b', 'd'])
  const search = doc.getElementById('task-search')
  search.value = '任務a'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))

  const all = doc.getElementById('task-select-all')
  assert.ok(all, '工具列要有全選')
  all.checked = true
  all.dispatchEvent(new win.Event('change', { bubbles: true }))
  assert.match(doc.getElementById('task-bulk-bar').textContent, /已選 1 個/)
})

test('B 部分選取時全選框是 indeterminate', async () => {
  const { doc, win } = await withTasks(['a', 'b', 'd'])
  pick(win, doc, 'a')
  assert.equal(doc.getElementById('task-select-all').indeterminate, true)
})

test('B 已選的列不在目前篩選中時要說出來', async () => {
  const { doc, win } = await withTasks(['a', 'b', 'd'])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  const search = doc.getElementById('task-search')
  search.value = '任務d'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  const text = doc.getElementById('task-bulk-bar').textContent
  assert.match(text, /已選 2 個/)
  assert.match(text, /2 個不在目前篩選中/, '看不到的已選會被一起刪掉，一定要說')
})

// ================= 整批啟用／停用 =================

test('B 整批停用只寫一次，未選的任務原樣', async () => {
  const { c, st, doc, win } = await withTasks(['a', 'b', 'd'])
  await st.saveTasks([task('a', { foreground: true, notFoundStreak: 2 }), task('b'), task('d')])
  pick(win, doc, 'a')
  pick(win, doc, 'b')

  const m = mark(c)
  doc.querySelector('#task-bulk-bar [data-action="bulk-disable"]').click()
  await tick()

  assert.equal(setsAfter(c, m), 1, '兩個任務不該寫兩次')
  const rebuilds = c.__calls.slice(m).filter(x => x.api === 'runtime.sendMessage' && x.args[0]?.type === 'REBUILD_ALARMS')
  assert.equal(rebuilds.length, 1)
  const a = await st.getTask('a')
  assert.equal(a.enabled, false)
  assert.equal(a.foreground, true, '整批停用不得重組任務')
  assert.equal(a.notFoundStreak, 2)
  assert.equal((await st.getTask('d')).enabled, true, '沒選的不動')
})

test('B 整批啟用把停用的任務打開', async () => {
  const { st, doc, win } = await withTasks(['a', 'b'])
  await st.saveTasks([task('a', { enabled: false }), task('b', { enabled: false })])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  doc.querySelector('#task-bulk-bar [data-action="bulk-enable"]').click()
  await tick()
  assert.ok((await st.getTasks()).every(t => t.enabled === true))
})

test('B 整批動作進行中按鈕要鎖住', async () => {
  const { doc, win } = await withTasks(['a', 'b'])
  pick(win, doc, 'a')
  const btn = doc.querySelector('#task-bulk-bar [data-action="bulk-disable"]')
  btn.click()
  assert.equal(btn.disabled, true, '進行中不得連按')
  await tick()
  assert.equal(btn.disabled, false)
})

test('B 整批動作完成後說出改了幾個', async () => {
  const { doc, win } = await withTasks(['a', 'b'])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  doc.querySelector('#task-bulk-bar [data-action="bulk-disable"]').click()
  await tick()
  assert.match(doc.getElementById('task-note').textContent, /已停用 2 個任務/)
})

test('B 取消選取把動作列收起來', async () => {
  const { doc, win } = await withTasks(['a', 'b'])
  pick(win, doc, 'a')
  doc.querySelector('#task-bulk-bar [data-action="bulk-clear"]').click()
  assert.equal(doc.getElementById('task-bulk-bar').hidden, true)
  assert.equal(boxOf(doc, 'a').checked, false)
})

// ================= 整批刪除 =================

test('B 整批刪除的對話框說出幾個任務與合計幾筆紀錄', async () => {
  const { st, doc, win } = await withTasks(['a', 'b', 'd'])
  await st.appendRecords('2026-09-05', [
    { taskId: 'a', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 1, status: 'ok' },
    { taskId: 'b', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 2, status: 'ok' },
    { taskId: 'd', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 3, status: 'ok' }
  ])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  doc.querySelector('#task-bulk-bar [data-action="bulk-delete"]').click()
  await tick()

  const dlg = doc.querySelector('dialog.modal')
  assert.equal(dlg?.open, true)
  const msg = dlg.querySelector('.modal-body').textContent
  assert.match(msg, /2 個任務/)
  assert.match(msg, /2 筆/)
})

test('B 整批刪除只掃一次紀錄算筆數', async () => {
  const { c, st, doc, win } = await withTasks(['a', 'b'])
  await st.appendRecords('2026-09-05', [
    { taskId: 'a', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 1, status: 'ok' }
  ])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  const m = mark(c)
  doc.querySelector('#task-bulk-bar [data-action="bulk-delete"]').click()
  await tick()
  const fullScans = c.__calls.slice(m).filter(x => (x.api === 'storage.local.getKeys' || (x.api === 'storage.local.get' && (x.args[0] === null || x.args[0] === undefined)))).length
  assert.equal(fullScans, 1, '不得對每個任務各掃一次')
})

test('B 整批刪除確認後那幾個任務與紀錄都消失，其餘原樣', async () => {
  const { st, doc, win } = await withTasks(['a', 'b', 'd'])
  await st.appendRecords('2026-09-05', [
    { taskId: 'a', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 1, status: 'ok' },
    { taskId: 'd', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 3, status: 'ok' }
  ])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  doc.querySelector('#task-bulk-bar [data-action="bulk-delete"]').click()
  await tick()
  doc.querySelector('dialog.modal [data-action="confirm"]').click()
  await tick()

  assert.deepEqual((await st.getTasks()).map(t => t.id), ['d'])
  assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['d'])
  assert.equal(doc.getElementById('task-bulk-bar').hidden, true, '刪完選取要清掉')
})

test('B 整批刪除取消時什麼都不動', async () => {
  const { st, doc, win } = await withTasks(['a', 'b'])
  const before = JSON.stringify(await st.getTasks())
  pick(win, doc, 'a')
  doc.querySelector('#task-bulk-bar [data-action="bulk-delete"]').click()
  await tick()
  doc.querySelector('dialog.modal [data-action="cancel"]').click()
  await tick()
  assert.equal(JSON.stringify(await st.getTasks()), before)
})

test('B 單一任務的刪除鈕仍然走同一個對話框，訊息維持單數句', async () => {
  const { st, doc } = await withTasks(['a'])
  rowOf(doc, 'a').querySelector('[data-action="delete"]').click()
  await tick()
  const msg = doc.querySelector('dialog.modal .modal-body').textContent
  assert.match(msg, /任務a/, '單一任務要說出名稱')
  doc.querySelector('dialog.modal [data-action="confirm"]').click()
  await tick()
  assert.equal((await st.getTasks()).length, 0)
})

// ================= 就地改名 =================

test('B 改名鈕把名稱換成輸入框，Enter 存檔', async () => {
  const { st, doc, win } = await withTasks(['a'])
  await st.saveTasks([task('a', { foreground: true, enabled: false })])
  rowOf(doc, 'a').querySelector('[data-action="rename"]').click()
  const input = rowOf(doc, 'a').querySelector('input[data-rename-input]')
  assert.ok(input, '要換成輸入框')
  input.value = '電費'
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await tick()

  const saved = await st.getTask('a')
  assert.equal(saved.name, '電費')
  assert.equal(saved.enabled, false, '改名不得動到別的欄位')
  assert.equal(saved.foreground, true)
})

test('B 改名按 Esc 不存檔', async () => {
  const { st, doc, win } = await withTasks(['a'])
  rowOf(doc, 'a').querySelector('[data-action="rename"]').click()
  const input = rowOf(doc, 'a').querySelector('input[data-rename-input]')
  input.value = '不要存我'
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await tick()
  assert.equal((await st.getTask('a')).name, '任務a')
  assert.equal(rowOf(doc, 'a').querySelector('input[data-rename-input]'), null, '要換回文字')
})

test('B 改名留空不存檔並說原因', async () => {
  const { st, doc, win } = await withTasks(['a'])
  rowOf(doc, 'a').querySelector('[data-action="rename"]').click()
  const input = rowOf(doc, 'a').querySelector('input[data-rename-input]')
  input.value = '   '
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await tick()
  assert.equal((await st.getTask('a')).name, '任務a')
  assert.match(doc.getElementById('task-note').textContent, /名稱不能空白/)
})

test('B 改名打到一半遇到重畫，輸入中的文字與焦點都要留著', async () => {
  const { ts, st, doc } = await withTasks(['a', 'b'])
  rowOf(doc, 'a').querySelector('[data-action="rename"]').click()
  const input = rowOf(doc, 'a').querySelector('input[data-rename-input]')
  input.value = '電費上'
  input.focus()

  // 任何一次抓取都會讓 health 變動而整份重畫
  ts.renderTasks(await st.getTasks(), { a: { status: 'ok' } }, [], { nextRuns: {} })

  const after = rowOf(doc, 'a').querySelector('input[data-rename-input]')
  assert.ok(after, '重畫不得把改名中的那一列變回文字')
  assert.equal(after.value, '電費上', '打到一半的字不得被洗掉')
  assert.equal(doc.activeElement, after, '焦點要還在輸入框上')
})

test('B 改名輸入框上的指標事件不得啟動拖曳排序', async () => {
  const { st, doc, win } = await withTasks(['a', 'b', 'd'])
  const before = (await st.getTasks()).map(t => t.order)
  rowOf(doc, 'a').querySelector('[data-action="rename"]').click()
  const input = rowOf(doc, 'a').querySelector('input[data-rename-input]')
  const ev = new win.Event('pointerdown', { bubbles: true })
  Object.defineProperty(ev, 'target', { value: input })
  input.dispatchEvent(ev)
  await tick()
  assert.deepEqual((await st.getTasks()).map(t => t.order), before)
})

// ================= 改排程入口 =================

test('B 動作列的「改排程」把 taskIds 寫進面板並開面板', async () => {
  const { c, doc, win } = await withTasks(['a', 'b'])
  c.__setCurrentTab({ id: 42, url: 'chrome-extension://abc/ui/report/report.html' })
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  doc.querySelector('#task-bulk-bar [data-action="bulk-schedule"]').click()
  await tick()

  const ctx = (await chrome.storage.session.get('panel:42'))['panel:42']
  assert.equal(ctx.kind, 'bulk')
  assert.deepEqual(ctx.taskIds.sort(), ['a', 'b'])
  assert.ok(c.__calls.some(x => x.api === 'sidePanel.open'), '要在點擊的手勢裡直接開面板')
})

test('B 列上的排程欄可以直接點開改排程，只帶那一個任務', async () => {
  const { c, doc } = await withTasks(['a', 'b'])
  c.__setCurrentTab({ id: 42, url: 'chrome-extension://abc/ui/report/report.html' })
  const btn = rowOf(doc, 'a').querySelector('[data-action="edit-schedule"]')
  assert.ok(btn, '排程欄要點得動')
  btn.click()
  await tick()
  const ctx = (await chrome.storage.session.get('panel:42'))['panel:42']
  assert.deepEqual(ctx.taskIds, ['a'])
})

test('B 排程欄仍然顯示白話句（點得動不代表看不到內容）', async () => {
  const { doc } = await withTasks(['a'])
  const btn = rowOf(doc, 'a').querySelector('[data-action="edit-schedule"]')
  assert.match(btn.textContent, /每日 09:00/)
})

test('B 任務頁重畫好幾次之後，按一次整批停用仍然只做一次（監聽不得累加）', async () => {
  const { c, ts, st, doc, win } = await withTasks(['a', 'b'])
  for (let i = 0; i < 3; i++) ts.renderTasks(await st.getTasks(), {}, [], { nextRuns: {} })
  pick(win, doc, 'a')
  const m = mark(c)
  doc.querySelector('#task-bulk-bar [data-action="bulk-disable"]').click()
  await tick()
  assert.equal(setsAfter(c, m), 1, '每重畫一次多綁一個監聽，按一下就會寫好幾次')
})

test('B 整批停用寫入失敗時要說出來，不得靜默', async () => {
  const { st, doc, win } = await withTasks(['a', 'b'])
  pick(win, doc, 'a')
  const orig = chrome.storage.local.set
  chrome.storage.local.set = async () => { throw new Error('配額已滿') }
  try {
    doc.querySelector('#task-bulk-bar [data-action="bulk-disable"]').click()
    await tick()
  } finally {
    chrome.storage.local.set = orig
  }
  assert.match(doc.getElementById('task-note').textContent, /失敗/)
  assert.equal(doc.querySelector('#task-bulk-bar [data-action="bulk-disable"]').disabled, false, '按鈕要還原')
  assert.equal((await st.getTask('a')).enabled, true)
})

test('B 排程欄按鈕有「修改排程」的說明', async () => {
  const { doc } = await withTasks(['a'])
  assert.equal(rowOf(doc, 'a').querySelector('[data-action="edit-schedule"]').title, '修改排程')
})

test('B 剛按改名時原值是全選的（直接打字就取代）', async () => {
  const { doc } = await withTasks(['a'])
  rowOf(doc, 'a').querySelector('[data-action="rename"]').click()
  const input = rowOf(doc, 'a').querySelector('input[data-rename-input]')
  assert.equal(input.selectionStart, 0)
  assert.equal(input.selectionEnd, input.value.length)
})

// ================= 收尾體檢（探針實測抓到的）=================

test('B 整批刪除對話框開著時選取變了，對話框要收掉（確認鈕刪的必須是訊息說的那幾個）', async () => {
  const { st, doc, win } = await withTasks(['a', 'b', 'd'])
  pick(win, doc, 'a')
  pick(win, doc, 'b')
  doc.querySelector('#task-bulk-bar [data-action="bulk-delete"]').click()
  await tick()
  assert.equal(doc.querySelector('dialog.modal')?.open, true, '前置')
  pick(win, doc, 'a')   // 取消 a
  pick(win, doc, 'd')   // 改勾 d：動作列現在說的是 b、d
  assert.equal(doc.querySelector('dialog.modal'), null,
    '不收掉的話，按確認刪掉的是 a、b，畫面上勾的卻是 b、d')
  assert.match(doc.getElementById('task-note').textContent, /再按一次/)
  assert.equal((await st.getTasks()).length, 3)
})

test('B 單列刪除的對話框不受選取變動影響', async () => {
  const { doc, win } = await withTasks(['a', 'b'])
  rowOf(doc, 'a').querySelector('[data-action="delete"]').click()
  await tick()
  pick(win, doc, 'b')
  assert.equal(doc.querySelector('dialog.modal')?.open, true)
})

test('B 先匯出再刪除：下載沒成功就不刪，而且要說出來', async () => {
  const { st, doc, win } = await withTasks(['a', 'b'])
  pick(win, doc, 'a')
  doc.querySelector('#task-bulk-bar [data-action="bulk-delete"]').click()
  await tick()
  const orig = chrome.downloads.download
  chrome.downloads.download = async () => { throw new Error('Download canceled by the user') }
  try {
    doc.querySelector('dialog.modal [data-action="extra"]').click()
    await tick()
  } finally {
    chrome.downloads.download = orig
  }
  assert.equal((await st.getTasks()).length, 2, '沒匯出成功不得刪')
  assert.match(doc.getElementById('task-note').textContent, /還沒有刪除/)
})

test('B 同一時間只會有一列在改名；換列時上一列先存檔', async () => {
  const { st, doc } = await withTasks(['a', 'b'])
  rowOf(doc, 'a').querySelector('[data-action="rename"]').click()
  await tick()
  rowOf(doc, 'a').querySelector('input[data-rename-input]').value = '電費'
  rowOf(doc, 'b').querySelector('[data-action="rename"]').click()
  await tick()
  const inputs = doc.querySelectorAll('#task-list input[data-rename-input]')
  assert.equal(inputs.length, 1, '兩個輸入框共用一份改名狀態，存其中一個會把另一個的編輯丟掉')
  assert.equal(inputs[0].closest('[data-task-id]').dataset.taskId, 'b')
  assert.equal(inputs[0].value, '任務b', '上一列打的字不得灌進這一列')
  assert.equal((await st.getTask('a')).name, '電費', '上一列要先存檔')
})
