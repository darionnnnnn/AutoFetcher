// AF-19 作業 D：編輯既有任務的忠實度
// 執行期欄位不得遺失 / 換目標要保住名稱與進階設定 / 編輯模式不給「回頁面重選」/ 移除值的孤兒序列清理
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, ls, pk, doc: jd.window.document, win: jd.window }
}

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, ls, bg }
}

const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]/div[1]' }
const base = (over = {}) => ({
  name: '總量', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
  scheduleType: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5],
  everyMinutes: 15, ...over
})
const cellPick = (r, c, over = {}) => ({
  cell: { row: { index: r, header: `列${r}` }, col: { index: c, header: `欄${c}` }, ...over }
})

// ================= D-1 執行期欄位跟著既有任務走 =================

test('D-1 編輯既有任務時 enabled / foreground 等執行期欄位原樣保留', async () => {
  const { pk } = await fresh()
  const existing = {
    id: 't1', enabled: false, foreground: true, suggestForeground: true,
    notFoundStreak: 3, precheckLeadMinutes: 10, order: 2
  }
  const t = pk.buildTask(base(), LOCATOR, existing)
  assert.equal(t.id, 't1')
  assert.equal(t.enabled, false, '停用中的任務不得因為編輯就被復活')
  assert.equal(t.foreground, true, '使用者按過「改用前景抓取」的設定不得消失')
  assert.equal(t.suggestForeground, true)
  assert.equal(t.notFoundStreak, 3)
  assert.equal(t.precheckLeadMinutes, 10)
  assert.equal(t.order, 2)
})

test('D-1 既有任務沒有的執行期欄位不得憑空長出來', async () => {
  const { pk } = await fresh()
  const t = pk.buildTask(base(), LOCATOR, { id: 't1', enabled: true })
  assert.equal(t.enabled, true)
  assert.ok(!('foreground' in t), '既有任務沒有 foreground，產出也不該有')
  assert.ok(!('notFoundStreak' in t))
  assert.ok(!('precheckLeadMinutes' in t))
})

test('D-1 新建任務維持 enabled 為 true 且不帶執行期欄位', async () => {
  const { pk } = await fresh()
  const t = pk.buildTask(base(), LOCATOR, undefined)
  assert.equal(t.enabled, true)
  assert.ok(!('foreground' in t))
  assert.ok(!('suggestForeground' in t))
})

test('D-1 編輯停用中的任務時標題列說出它目前停用', async () => {
  const { pk, doc } = await fresh()
  pk.render({ task: { id: 't1', name: '電費', url: 'https://a.test/p', enabled: false, spec: {}, schedule: { type: 'daily', times: ['09:00'] } }, locator: LOCATOR, url: 'https://a.test/p' })
  const note = doc.getElementById('task-status-note')
  assert.ok(note, '要有 #task-status-note')
  assert.equal(note.hidden, false, '停用中的任務要看得出來')
  assert.match(note.textContent, /停用/)
})

test('D-1 編輯啟用中的任務不顯示停用提示', async () => {
  const { pk, doc } = await fresh()
  pk.render({ task: { id: 't1', name: '電費', url: 'https://a.test/p', enabled: true, spec: {}, schedule: { type: 'daily', times: ['09:00'] } }, locator: LOCATOR, url: 'https://a.test/p' })
  assert.equal(doc.getElementById('task-status-note').hidden, true)
})

test('D-1 停用任務的儲存回饋不得說「下次抓取」', async () => {
  const { pk, doc } = await fresh()
  const task = { id: 't1', name: '電費', url: 'https://a.test/p', enabled: false, spec: {}, schedule: { type: 'daily', times: ['09:00'] } }
  await pk.showSavedFeedback(task, { nextRunMs: Date.now() + 60000, closeDelayMs: null })
  const text = doc.getElementById('picker-form').textContent
  assert.match(text, /停用/, '要說出它目前停用、不會排程')
  assert.ok(!/下次抓取/.test(text), '停用的任務不會抓，說「下次抓取」是誤導')
})

test('D-1 啟用任務的儲存回饋照舊說下次抓取', async () => {
  const { pk, doc } = await fresh()
  const task = { id: 't1', name: '電費', url: 'https://a.test/p', enabled: true, spec: {}, schedule: { type: 'daily', times: ['09:00'] } }
  await pk.showSavedFeedback(task, { nextRunMs: Date.now() + 60000, closeDelayMs: null })
  assert.match(doc.getElementById('picker-form').textContent, /下次抓取/)
})

// ================= D-2 shared/field-match.js（同一格的判定只有一份）=================

test('D-2 sameSpec：同一格改了定位方式仍是同一個值', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const a = { cell: { row: { index: 1, header: '列1', pos: 'last' }, col: { index: 2, header: '欄2' } } }
  const b = cellPick(1, 2)
  assert.equal(fm.sameSpec(a, b), true)
})

test('D-2 sameSpec：整欄值改了排除清單與略過仍是同一個值', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const a = { block: { axis: 'col', index: 2, headerText: '買入', exclude: [{ index: 9 }], skip: { head: 1 } } }
  const b = { block: { axis: 'col', index: 2, headerText: '買入' } }
  assert.equal(fm.sameSpec(a, b), true)
})

test('D-2 sameSpec：格內子路徑不同就是不同的值', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const a = cellPick(1, 2, { inner: [{ tag: 'td', i: 0 }] })
  const b = cellPick(1, 2, { inner: [{ tag: 'td', i: 1 }] })
  assert.equal(fm.sameSpec(a, b), false)
  assert.equal(fm.sameSpec(a, cellPick(1, 2)), false, '有子路徑與整格是兩個值')
})

test('D-2 reconcileFields：對得回去的值沿用 key 與名稱，新的值給新 key', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const prev = [
    { key: 'k1', name: '美金買入', spec: cellPick(1, 2) },
    { key: 'k2', name: '日圓買入', spec: cellPick(2, 2) }
  ]
  const picks = [cellPick(2, 2), cellPick(3, 2), cellPick(1, 2)]
  const out = fm.reconcileFields(prev, picks)
  assert.equal(out.length, 3)
  assert.equal(out[0].key, 'k2')
  assert.equal(out[0].name, '日圓買入')
  assert.equal(out[0].kept, true)
  assert.equal(out[1].kept, false, '沒對到的是新值')
  assert.equal(out[1].name, null, '新值的名稱交給呼叫端算預設名')
  assert.notEqual(out[1].key, 'k1')
  assert.notEqual(out[1].key, 'k2')
  assert.equal(out[2].key, 'k1')
  assert.equal(out[2].name, '美金買入')
})

test('D-2 reconcileFields：同一個舊值不會被兩個 pick 同時認領', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const prev = [{ key: 'k1', name: '美金', spec: cellPick(1, 2) }]
  const out = fm.reconcileFields(prev, [cellPick(1, 2), cellPick(1, 2)])
  assert.equal(out[0].key, 'k1')
  assert.notEqual(out[1].key, 'k1', '第二個相同的 pick 不能再認領同一個 key')
})

test('D-2 reconcileFields 回報被移除的舊值', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const prev = [
    { key: 'k1', name: '一', spec: cellPick(1, 2) },
    { key: 'k2', name: '二', spec: cellPick(2, 2) }
  ]
  const out = fm.reconcileFields(prev, [cellPick(1, 2)])
  assert.deepEqual(out.removed, ['k2'], '呼叫端要知道哪些 key 沒了才清得掉孤兒')
})

test('D-2 background 的重選改用 shared/field-match，不自己留一份', async () => {
  const src = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8')
  assert.match(src, /field-match\.js/, 'main.js 要 import shared/field-match.js')
  assert.equal((src.match(/function sameSpec\s*\(/g) || []).length, 0, 'main.js 不得再自己寫一份 sameSpec')
  assert.equal((src.match(/function stripPos\s*\(/g) || []).length, 0, 'main.js 不得再自己寫一份 stripPos')
})

// ================= D-3 換目標要保住名稱、告警與前置動作 =================

// 前置一定要走面板路徑：`retarget` 分支只在「面板已經畫過一次」時成立
async function renderThreeFields(pk) {
  await pk.renderFromPanelCtx({
    kind: 'new',
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2), cellPick(3, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })
}

test('D-3 換目標後使用者改過的值名稱與 key 都留著', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  const rows = () => Array.from(doc.querySelectorAll('#field-list [data-field-row]'))
  const before = rows()
  assert.equal(before.length, 3)
  const keys = before.map(r => r.dataset.fieldKey)
  before.forEach((r, i) => { r.querySelector('input[data-field-name]').value = ['美金', '日圓', '歐元'][i] })

  // 回頁面加選一格之後送回來的新目標：原三格還在，多了第四格
  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2), cellPick(3, 2), cellPick(4, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })

  const after = rows()
  assert.equal(after.length, 4)
  assert.deepEqual(after.slice(0, 3).map(r => r.querySelector('input[data-field-name]').value),
    ['美金', '日圓', '歐元'], '改過的名稱不得被打回預設')
  assert.deepEqual(after.slice(0, 3).map(r => r.dataset.fieldKey), keys,
    'key 重生會讓歷史序列斷掉')
  assert.ok(after[3].querySelector('input[data-field-name]').value, '新的值要有預設名')
})

test('D-3 換目標後告警條件原樣留著', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  const keys = Array.from(doc.querySelectorAll('#field-list [data-field-row]')).map(r => r.dataset.fieldKey)
  doc.getElementById('alert-add').click()
  const row = doc.querySelector('#alert-list [data-alert-row]')
  row.querySelector('select.alert-type').value = 'lt'
  row.querySelector('input.alert-value').value = '30'
  const fieldSel = row.querySelector('[data-alert-field]')
  fieldSel.value = keys[1]

  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2), cellPick(3, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })

  const rows2 = doc.querySelectorAll('#alert-list [data-alert-row]')
  assert.equal(rows2.length, 1, '換目標不該把告警條件清空')
  assert.equal(rows2[0].querySelector('select.alert-type').value, 'lt')
  assert.equal(rows2[0].querySelector('input.alert-value').value, '30')
  assert.equal(rows2[0].querySelector('[data-alert-field]').value, keys[1], '告警綁的值還在，就要綁回同一個')
})

test('D-3 告警綁的值在換目標後不見了就退回「全部值」', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  const keys = Array.from(doc.querySelectorAll('#field-list [data-field-row]')).map(r => r.dataset.fieldKey)
  doc.getElementById('alert-add').click()
  doc.querySelector('#alert-list [data-alert-field]').value = keys[2]

  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })
  const sel = doc.querySelector('#alert-list [data-alert-field]')
  assert.equal(sel.value, '', '對不到的值要退回「全部值」，不能留著指向不存在的 key')
})

test('D-3 換目標後前置動作原樣留著', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  doc.getElementById('preaction-add').click()
  const pa = doc.querySelector('#preaction-list [data-preaction-row]')
  pa.querySelector('select').value = 'wait'
  pa.querySelector('select').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  const num = pa.querySelector('input[type="number"]')
  if (num) num.value = '5'

  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2), cellPick(3, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })
  const rows2 = doc.querySelectorAll('#preaction-list [data-preaction-row]')
  assert.equal(rows2.length, 1, '換目標不該把前置動作清空')
  assert.equal(rows2[0].querySelector('select').value, 'wait')
})

test('D-3 換目標的提示句要說出真的留了什麼', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2), cellPick(3, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })
  const note = doc.getElementById('retarget-note')
  assert.equal(note.hidden, false)
  assert.match(note.textContent, /告警/, '提示句要與實際保留的內容相符')
  assert.match(note.textContent, /前置動作/)
})

test('D-3 換目標少掉的值要在提示句裡說出來', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })
  assert.match(doc.getElementById('retarget-note').textContent, /移除了 1 個/)
})

// ================= D-4 編輯模式不給「回頁面重選目標」 =================

test('D-4 編輯既有任務時隱藏「回頁面重選目標」', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTask({
    id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: LOCATOR, spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:00'] }
  })
  await pk.renderFromPanelCtx({ kind: 'edit', taskId: 't1' })
  assert.equal(doc.getElementById('repick-target').hidden, true,
    '面板開在報表分頁旁，重選會存成新任務；一律走任務頁的「重選」')
  assert.equal(doc.getElementById('test-now').hidden, true)
})

test('D-4 新建任務時「回頁面重選目標」照常可用', async () => {
  const { pk, doc } = await fresh()
  await pk.renderFromPanelCtx({
    kind: 'new',
    ctx: { url: 'https://a.test/p', locator: LOCATOR, picks: [cellPick(1, 2), cellPick(2, 2)], blockInfo: { kind: 'table', rows: 5, cols: 4 } }
  })
  assert.equal(doc.getElementById('repick-target').hidden, false)
})

test('D-4 舊網址參數 ?taskId= 的退路同樣隱藏', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTask({
    id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: LOCATOR, spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:00'] }
  })
  await pk.initFromQuery('?taskId=t1')
  assert.equal(doc.getElementById('repick-target').hidden, true)
})

// ================= D-5 移除值的孤兒序列清理 =================

test('D-5 編輯移除一個值後存檔，卡片來源與 lastValues 跟著清掉、紀錄留著', async () => {
  const { st, ls, pk, doc } = await fresh()
  await st.saveTask({
    id: 't1', name: '匯率', url: 'https://a.test/p', mode: 'block', enabled: true,
    locator: LOCATOR,
    fields: [{ key: 'k1', name: '美金' }, { key: 'k2', name: '日圓' }],
    spec: { mode: 'block', fields: [{ key: 'k1', ...cellPick(1, 2) }, { key: 'k2', ...cellPick(2, 2) }] },
    schedule: { type: 'daily', times: ['09:00'] }
  })
  await st.setLastValues({ 't1#k1': { value: 1 }, 't1#k2': { value: 2 } })
  await st.appendRecords('2026-09-05', [
    { taskId: 't1#k1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 1, status: 'ok' },
    { taskId: 't1#k2', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:00+08:00', value: 2, status: 'ok' }
  ])
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'line', x: 0, y: 0, w: 4, h: 3, source: [{ taskId: 't1#k1', aggregation: 'raw' }, { taskId: 't1#k2', aggregation: 'raw' }], options: {} })

  await pk.renderFromPanelCtx({ kind: 'edit', taskId: 't1' })
  const rows = doc.querySelectorAll('#field-list [data-field-row]')
  assert.equal(rows.length, 2)
  rows[1].querySelector('[data-field-remove]').click()
  await pk.handleSave()

  const saved = await st.getTask('t1')
  assert.deepEqual(saved.fields.map(f => f.key), ['k1'])
  assert.deepEqual(Object.keys(await st.getLastValues()), ['t1#k1'], '移除的值不該留著最後一次的值')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.deepEqual(cards[0].source.map(s => s.taskId), ['t1#k1'], '卡片來源要清掉不存在的序列')
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 2, '歷史紀錄一律保留，等保留天數自然到期')
})

test('D-5 移除值之後的儲存回饋要說出來', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTask({
    id: 't1', name: '匯率', url: 'https://a.test/p', mode: 'block', enabled: true,
    locator: LOCATOR,
    fields: [{ key: 'k1', name: '美金' }, { key: 'k2', name: '日圓' }],
    spec: { mode: 'block', fields: [{ key: 'k1', ...cellPick(1, 2) }, { key: 'k2', ...cellPick(2, 2) }] },
    schedule: { type: 'daily', times: ['09:00'] }
  })
  await pk.renderFromPanelCtx({ kind: 'edit', taskId: 't1' })
  doc.querySelectorAll('#field-list [data-field-row]')[1].querySelector('[data-field-remove]').click()
  await pk.handleSave()
  const text = doc.getElementById('picker-form').textContent
  assert.match(text, /移除了 1 個值|已移除 1 個值/, '少掉一個值是使用者要知道的事')
})

test('D-5 沒有移除任何值時不得出現移除提示', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTask({
    id: 't1', name: '匯率', url: 'https://a.test/p', mode: 'block', enabled: true,
    locator: LOCATOR,
    fields: [{ key: 'k1', name: '美金' }],
    spec: { mode: 'block', fields: [{ key: 'k1', ...cellPick(1, 2) }] },
    schedule: { type: 'daily', times: ['09:00'] }
  })
  await pk.renderFromPanelCtx({ kind: 'edit', taskId: 't1' })
  await pk.handleSave()
  assert.ok(!/移除了/.test(doc.getElementById('picker-form').textContent))
})

test('D-5 任務頁重選少掉一格時同樣清掉孤兒並記診斷', async () => {
  const { c, st, ls, bg } = await freshBg()
  await st.saveTask({
    id: 't1', name: '匯率', url: 'https://a.test/p', mode: 'block', enabled: true,
    locator: LOCATOR,
    fields: [{ key: 'k1', name: '美金' }, { key: 'k2', name: '日圓' }],
    spec: { mode: 'block', fields: [{ key: 'k1', ...cellPick(1, 2) }, { key: 'k2', ...cellPick(2, 2) }] },
    schedule: { type: 'daily', times: ['09:00'] }
  })
  await st.setLastValues({ 't1#k1': { value: 1 }, 't1#k2': { value: 2 } })
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'line', x: 0, y: 0, w: 4, h: 3, source: [{ taskId: 't1#k2', aggregation: 'raw' }], options: {} })

  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await chrome.storage.session.set({ repickTabs: { 't1': tab.id } })
  await bg.handleMessage(
    { type: 'PICKED', purpose: 'repick', taskId: 't1', locator: LOCATOR, picks: [cellPick(1, 2)] },
    { tab }
  )

  const saved = await st.getTask('t1')
  assert.deepEqual(saved.fields.map(f => f.key), ['k1'])
  assert.deepEqual(Object.keys(await st.getLastValues()), ['t1#k1'])
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0, '來源歸零的卡片要整張移除')
  const diag = await st.getDiagList()
  assert.ok(diag.some(d => d.kind === 'fields_pruned'), '少掉的值要留下紀錄，否則查不出卡片為何不見')
})

test('D-5 重選沒有少值時不做清理', async () => {
  const { c, st, ls, bg } = await freshBg()
  await st.saveTask({
    id: 't1', name: '匯率', url: 'https://a.test/p', mode: 'block', enabled: true,
    locator: LOCATOR,
    fields: [{ key: 'k1', name: '美金' }, { key: 'k2', name: '日圓' }],
    spec: { mode: 'block', fields: [{ key: 'k1', ...cellPick(1, 2) }, { key: 'k2', ...cellPick(2, 2) }] },
    schedule: { type: 'daily', times: ['09:00'] }
  })
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'line', x: 0, y: 0, w: 4, h: 3, source: [{ taskId: 't1#k2', aggregation: 'raw' }], options: {} })
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await chrome.storage.session.set({ repickTabs: { 't1': tab.id } })
  await bg.handleMessage(
    { type: 'PICKED', purpose: 'repick', taskId: 't1', locator: LOCATOR, picks: [cellPick(1, 2), cellPick(2, 2)] },
    { tab }
  )
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 1, '沒有值被移除就不該動卡片')
  assert.deepEqual((await st.getTask('t1')).fields.map(f => f.key), ['k1', 'k2'], 'key 不得重生')
})

// ================= D-6 上下移停用時要說原因 =================

test('D-6 第一列的上移鈕停用時點下去要說原因，不得靜默無事', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  const rows = doc.querySelectorAll('#field-list [data-field-row]')
  const up = rows[0].querySelector('[data-field-up]')
  assert.equal(up.getAttribute('aria-disabled'), 'true', '用 aria-disabled 才點得到、才說得出原因')
  assert.ok(!up.disabled, '原生 disabled 會讓點擊完全沒回饋')
  up.click()
  assert.match(doc.getElementById('field-list').textContent + doc.getElementById('block-summary').textContent, /已經是第一個/)
  assert.deepEqual(Array.from(doc.querySelectorAll('#field-list [data-field-row]')).length, 3, '停用的動作不得改變清單')
})

test('D-6 最後一列的下移鈕同理', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  const rows = doc.querySelectorAll('#field-list [data-field-row]')
  const down = rows[2].querySelector('[data-field-down]')
  assert.equal(down.getAttribute('aria-disabled'), 'true')
  down.click()
  assert.match(doc.getElementById('field-list').textContent + doc.getElementById('block-summary').textContent, /已經是最後一個/)
})

test('D-6 中間那列的上下移照常可用', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  const rows = doc.querySelectorAll('#field-list [data-field-row]')
  const keys = Array.from(rows).map(r => r.dataset.fieldKey)
  rows[1].querySelector('[data-field-up]').click()
  const after = Array.from(doc.querySelectorAll('#field-list [data-field-row]')).map(r => r.dataset.fieldKey)
  assert.deepEqual(after, [keys[1], keys[0], keys[2]])
})

// ================= 鏈結：後台收到選取結果 → session → 面板換目標 =================

test('D-3 鏈結：面板已有多值表單時回頁面加選一格，後台寫的 session 讓面板保住原本的名稱與 key', async () => {
  // 面板那一端
  const { pk, doc } = await fresh()
  const first = {
    url: 'https://a.test/p', tabId: 7, locator: LOCATOR,
    picks: [cellPick(1, 2), cellPick(2, 2)], blockInfo: { kind: 'table', rows: 5, cols: 4 }
  }
  await chrome.storage.session.set({ 'panel:7': { kind: 'new', ctx: first } })
  await pk.renderFromPanelCtx({ kind: 'new', ctx: first })
  const rows = () => Array.from(doc.querySelectorAll('#field-list [data-field-row]'))
  rows()[0].querySelector('input[data-field-name]').value = '美金'
  rows()[1].querySelector('input[data-field-name]').value = '日圓'
  const keys = rows().map(r => r.dataset.fieldKey)

  // 後台那一端：同一份 chrome 替身，直接送 PICKED（頁面上多選了一格）
  const bg = await import('../src/background/main.js?t=' + Math.random())
  await bg.handleMessage(
    { type: 'PICKED', purpose: 'task', locator: LOCATOR, picks: [cellPick(1, 2), cellPick(2, 2), cellPick(3, 2)], blockInfo: first.blockInfo },
    { tab: { id: 7, url: 'https://a.test/p' }, frameId: 0 }
  )
  const session = (await chrome.storage.session.get('panel:7'))['panel:7']
  assert.equal(session.retarget, true, '後台要把它標成換目標，不是新表單')

  await pk.renderFromPanelCtx(session)
  const after = rows()
  assert.equal(after.length, 3)
  assert.deepEqual(after.slice(0, 2).map(r => r.querySelector('input[data-field-name]').value), ['美金', '日圓'])
  assert.deepEqual(after.slice(0, 2).map(r => r.dataset.fieldKey), keys)
})

// ================= 收尾體檢（探針實測抓到的）=================

test('D-5 單值任務重選成多值：原本那條序列（id 就是任務 id）的卡片來源與 lastValues 也要清', async () => {
  const { c, st, ls, bg } = await freshBg()
  await st.saveTask({
    id: 't2', name: '總量', url: 'https://a.test/p', mode: 'block', enabled: true, locator: LOCATOR,
    spec: { mode: 'block', block: { cell: cellPick(1, 2).cell } }, schedule: { type: 'daily', times: ['09:00'] }
  })
  await st.setLastValues({ t2: { value: 7 }, 'other#k': { value: 1 } })
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't2', aggregation: 'raw' }], options: {} })
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await chrome.storage.session.set({ repickTabs: { 't2': tab.id } })
  await bg.handleMessage(
    { type: 'PICKED', purpose: 'repick', taskId: 't2', locator: LOCATOR, picks: [cellPick(1, 2), cellPick(2, 2)] },
    { tab }
  )
  assert.equal((await st.getTask('t2')).fields.length, 2, '前置：變成多值')
  assert.deepEqual(Object.keys(await st.getLastValues()), ['other#k'])
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0, '指著舊序列的卡片不會再有新資料')
})

test('D-3 換目標後使用者排過的順序也留著，新加的值接在後面', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  const rows = () => Array.from(doc.querySelectorAll('#field-list [data-field-row]'))
  rows().forEach((r, i) => { r.querySelector('input[data-field-name]').value = ['甲', '乙', '丙'][i] })
  rows()[2].querySelector('[data-field-up]').click()   // 甲 丙 乙
  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: {
      url: 'https://a.test/p', locator: LOCATOR,
      picks: [cellPick(1, 2), cellPick(2, 2), cellPick(3, 2), cellPick(4, 2)],
      blockInfo: { kind: 'table', rows: 5, cols: 4 }
    }
  })
  const names = rows().map(r => r.querySelector('input[data-field-name]').value)
  assert.deepEqual(names.slice(0, 3), ['甲', '丙', '乙'])
  assert.equal(names.length, 4)
})

test('D-3 多值換成單值時，提示句不說「移除了 N 個」', async () => {
  const { pk, doc } = await fresh()
  await renderThreeFields(pk)
  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: { url: 'https://a.test/p', locator: LOCATOR, picks: [cellPick(1, 2)], blockInfo: { kind: 'table', rows: 5, cols: 4 } }
  })
  const text = doc.getElementById('retarget-note').textContent
  assert.ok(!/移除了/.test(text), text)
  assert.match(text, /只抓一個值/)
})

test('D-2 reconcileFields：認不得的 pick 不得與認不得的舊值配成一對', async () => {
  const fm = await import('../src/shared/field-match.js?t=' + Math.random())
  const out = fm.reconcileFields([{ key: 'k1', name: '壞掉的', spec: null }], [{}])
  assert.equal(out[0].kept, false)
  assert.deepEqual(out.removed, ['k1'])
})
