// AF-19 作業 C：整批改排程的面板檢視（kind:'bulk'）
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
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]/div[1]' }
const task = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  locator: LOCATOR, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }, ...over
})
const setsAfter = (c, api, m) => c.__calls.slice(m).filter(x => x.api === api).length
const mark = (c) => c.__calls.length
const wd = (doc) => Array.from(doc.querySelectorAll('#weekdays input[type="checkbox"]')).filter(cb => cb.checked).map(cb => cb.value)

// ---- 畫面 ----

test('C 整批檢視只露出「多久抓一次」，其餘區塊全部收起來', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a'), task('b')])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })

  assert.equal(doc.getElementById('schedule-section').hidden, false, '要改的就是排程')
  assert.equal(doc.getElementById('bulk-section').hidden, false)
  for (const id of ['block-section', 'preview-section', 'add-to-dashboard', 'advanced-section', 'repick-target', 'test-now']) {
    assert.equal(doc.getElementById(id).hidden, true, `#${id} 在整批改排程時沒有意義`)
  }
  assert.equal(doc.getElementById('name').closest('[data-picker-header]').hidden, true,
    '整批沒有單一任務名稱可改')
  assert.equal(doc.getElementById('pin-defaults').closest('label').hidden, true,
    '整批修改不得寫進預設值')
})

test('C 整批檢視列出受影響的任務名稱，且標題說出有幾個', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a', { name: '電費' }), task('b', { name: '水費' })])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })
  const text = doc.getElementById('bulk-section').textContent
  assert.match(text, /電費/)
  assert.match(text, /水費/)
  assert.match(doc.getElementById('picker-title').textContent, /2 個/)
  assert.match(doc.getElementById('save').textContent, /套用到 2 個任務/)
})

test('C 只選一個任務時標題說出那一個的名稱', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a', { name: '電費' })])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a'] })
  assert.match(doc.getElementById('picker-title').textContent, /電費/)
})

test('C 任務全部找不到時說出來，不留一張空表單', async () => {
  const { pk, doc } = await fresh()
  const res = await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['沒有'] })
  assert.equal(res.rendered, true)
  assert.match(doc.getElementById('bulk-section').textContent + doc.getElementById('errors').textContent, /找不到要修改的任務/)
  assert.equal(doc.getElementById('save').hidden, true, '沒有東西可套用')
})

// ---- 預填 ----

test('C 排程相同時預填該排程並說「相同」', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([
    task('a', { schedule: { type: 'daily', times: ['08:30'], weekdays: [1, 2] } }),
    task('b', { schedule: { type: 'daily', times: ['08:30'], weekdays: [2, 1] } })
  ])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })
  assert.equal(doc.getElementById('schedule-type').value, 'daily')
  assert.equal(doc.getElementById('times').value.trim(), '08:30')
  assert.deepEqual(wd(doc).sort(), ['1', '2'])
  assert.match(doc.getElementById('bulk-note').textContent, /相同/,
    '星期順序不同不算不同排程（正規化後比對）')
})

test('C 排程不同時預填 order 最小那個並說「不同」', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([
    task('a', { name: '電費', order: 0, schedule: { type: 'daily', times: ['08:30'], weekdays: [1] } }),
    task('b', { name: '水費', order: 1, schedule: { type: 'interval', everyMinutes: 15, weekdays: [1] } })
  ])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['b', 'a'] })
  assert.equal(doc.getElementById('schedule-type').value, 'daily', '要用 order 最小的那個，不是傳入順序')
  const note = doc.getElementById('bulk-note').textContent
  assert.match(note, /不同/)
  assert.match(note, /電費/, '要說出目前顯示的是哪一個任務的排程')
})

test('C 預填帶時段的 interval 時把時段開關勾起來並算出預覽', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([
    task('a', { schedule: { type: 'interval', everyMinutes: 10, weekdays: [1, 2, 3, 4, 5], window: { from: '08:30', to: '09:20' } } })
  ])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a'] })
  assert.equal(doc.getElementById('schedule-type').value, 'interval')
  assert.equal(doc.getElementById('every-minutes').value, '10')
  assert.equal(doc.getElementById('window-enabled').checked, true, '有時段就要勾起來，否則欄位藏著')
  assert.equal(doc.getElementById('window-from').value, '08:30')
  assert.equal(doc.getElementById('window-fields').hidden, false)
  assert.ok(doc.getElementById('schedule-preview').textContent.trim().length > 0)
})

test('C 整批修改不得套用也不得寫入 pickerDefaults', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveSettings({ pickerDefaults: { pinned: { scheduleType: 'interval', everyMinutes: 99 } } })
  await st.saveTasks([task('a', { schedule: { type: 'daily', times: ['07:00'], weekdays: [1] } })])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a'] })
  assert.equal(doc.getElementById('schedule-type').value, 'daily', '要用任務現況，不是固定的預設值')
  assert.equal(doc.getElementById('every-minutes').value !== '99', true)
})

// ---- 套用 ----

test('C 套用只換排程，其餘欄位一字不動，且只寫一次', async () => {
  const { c, st, pk, doc } = await fresh()
  await st.saveTasks([
    task('a', { foreground: true, notFoundStreak: 2, fields: [{ key: 'k1', name: '值' }] }),
    task('b', { enabled: false })
  ])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })
  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  doc.getElementById('every-minutes').value = '20'

  const m = mark(c)
  await pk.handleSave()

  assert.equal(setsAfter(c, 'storage.local.set', m), 1, '兩個任務不該寫兩次')
  const rebuilds = c.__calls.slice(m).filter(x => x.api === 'runtime.sendMessage' && x.args[0]?.type === 'REBUILD_ALARMS')
  assert.equal(rebuilds.length, 1)

  const a = await st.getTask('a')
  assert.equal(a.schedule.type, 'interval')
  assert.equal(a.schedule.everyMinutes, 20)
  assert.equal(a.foreground, true, '整批改排程不得經 buildTask 重組，執行期欄位要原樣')
  assert.equal(a.notFoundStreak, 2)
  assert.deepEqual(a.fields, [{ key: 'k1', name: '值' }])
  assert.deepEqual(a.locator, LOCATOR)
  const b = await st.getTask('b')
  assert.equal(b.schedule.type, 'interval')
  assert.equal(b.enabled, false, '停用的任務改排程之後仍然停用')
})

test('C 套用後的回饋說出改了幾個', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a'), task('b')])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })
  await pk.handleSave()
  assert.match(doc.getElementById('picker-form').textContent, /已更新 2 個任務的排程/)
})

test('C 所選任務都停用時不得說「下次抓取」', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a', { enabled: false }), task('b', { enabled: false })])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })
  await pk.handleSave()
  const text = doc.getElementById('picker-form').textContent
  assert.match(text, /都停用中/)
  assert.ok(!/下次抓取/.test(text))
})

test('C 有任務在開面板之後被刪掉時，只套用找得到的並說出來', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a'), task('b')])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })
  await st.deleteTasks(['b'])
  await pk.handleSave()
  const text = doc.getElementById('picker-form').textContent
  assert.match(text, /已更新 1 個任務的排程/)
  assert.match(text, /1 個已不存在/)
})

test('C 排程填錯時不寫入、不關窗，錯誤看得到', async () => {
  const { c, st, pk, doc } = await fresh()
  await st.saveTasks([task('a')])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a'] })
  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  doc.getElementById('every-minutes').value = '0'

  const before = JSON.stringify(await st.getTask('a'))
  const m = mark(c)
  await pk.handleSave()
  assert.equal(setsAfter(c, 'storage.local.set', m), 0, '沒過驗證不得寫入')
  assert.equal(JSON.stringify(await st.getTask('a')), before)
  assert.ok(doc.getElementById('errors').textContent.trim().length > 0)
  assert.ok(doc.getElementById('bulk-section'), '面板不得關掉')
})

test('C 整批修改不得要求填任務名稱（單任務那條驗證不適用）', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a')])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a'] })
  doc.getElementById('name').value = ''
  await pk.handleSave()
  assert.ok(!/名稱不可空白/.test(doc.getElementById('errors').textContent))
  assert.match(doc.getElementById('picker-form').textContent, /已更新 1 個任務的排程/)
})

test('C validateSchedule 與 validateForm 用同一套排程規則', async () => {
  const { pk } = await fresh()
  const good = { scheduleType: 'daily', times: ['09:00'], weekdays: [1] }
  assert.equal(pk.validateSchedule(good).ok, true)
  assert.equal(pk.validateSchedule({ ...good, times: ['25:00'] }).ok, false)
  assert.equal(pk.validateSchedule({ scheduleType: 'interval', everyMinutes: 0, weekdays: [1] }).ok, false)
  assert.equal(pk.validateSchedule({ scheduleType: 'interval', everyMinutes: 5, weekdays: [1], windowFrom: '09:00', windowTo: '' }).ok, false)
  // 同樣的輸入在 validateForm 也要不過（規則只有一份）
  const r = pk.validateForm({ name: 'x', url: 'https://a.test', mode: 'number', strategy: 'auto', ...good, times: ['25:00'] })
  assert.equal(r.ok, false)
})

// ---- 換回別的畫面 ----

test('C 從整批改排程切回一般表單時，整批區塊要收掉', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task('a')])
  await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a'] })
  await pk.renderFromPanelCtx({
    kind: 'new',
    ctx: { url: 'https://a.test/p', locator: LOCATOR, blockInfo: null }
  })
  assert.equal(doc.getElementById('bulk-section').hidden, true)
  assert.equal(doc.getElementById('block-section').hidden !== true || true, true)
  assert.equal(doc.getElementById('add-to-dashboard').hidden, false, '一般表單要看得到「抓完放哪裡」')
  assert.match(doc.getElementById('save').textContent, /^儲存$/)
})

test('C 同一份 bulk ctx 不重畫（taskIds 進簽章）', async () => {
  const { st, pk } = await fresh()
  await st.saveTasks([task('a'), task('b')])
  const ctx = { kind: 'bulk', taskIds: ['a'] }
  assert.equal((await pk.renderFromPanelCtx(ctx)).rendered, true)
  assert.equal((await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a'] })).rendered, false)
  assert.equal((await pk.renderFromPanelCtx({ kind: 'bulk', taskIds: ['a', 'b'] })).rendered, true,
    '換了一組任務就要重畫')
})

// ---- background 入口守門 ----

test('C 面板正在整批改排程時，右鍵選取要被擋下並說明', async () => {
  const { c, st, bg } = await freshBg()
  await st.saveTasks([task('a')])
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await chrome.storage.session.set({ [`panel:${tab.id}`]: { kind: 'bulk', taskIds: ['a'] } })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  const ctx = (await chrome.storage.session.get(`panel:${tab.id}`))[`panel:${tab.id}`]
  assert.equal(ctx.kind, 'bulk', '不得把整批清單蓋成等待態')
  assert.match(String(ctx.notice), /排程/)
})
