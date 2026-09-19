// AF-21 終檢修正段：站台讀-改-寫加鎖、UI 失敗不靜默、儀表板版面讀-改-寫、刪除儀表板走對話框、
// 抽屜套用不讓修剪過的序列復活、通知冷卻撤回、forbidden 診斷節流、repick 核對分頁、同 worker 卡住的 runState、
// 看門狗不被續跑擋住
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { MSG } from '../src/shared/messages.js'
import { BOOT } from '../src/background/fetch-tab.js'

const REPORT_HTML = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const POPUP_HTML = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const api = (c, name) => c.__calls.filter(x => x.api === name)
const ORIGIN = 'https://a.test'

async function freshStore() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  return { c, st }
}

const taskOf = (id, over = {}) => ({
  id, name: '任務' + id, url: `${ORIGIN}/p`, mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

// ======================= 1. 站台的讀-改-寫加鎖 =======================

async function siteOf(cr, over = {}) {
  return {
    loginUrl: `${ORIGIN}/login`,
    selectors: {
      user: { css: '#u', path: '', anchor: null, xpath: '' },
      pass: { css: '#p', path: '', anchor: null, xpath: '' },
      submit: { css: '#go', path: '', anchor: null, xpath: '' }
    },
    loginCheck: { type: 'urlPrefix', value: `${ORIGIN}/login` },
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'wayne',
    passwordEnc: await cr.encryptSecret('old-pass'),
    enabled: true,
    failStreak: 0,
    ...over
  }
}

// 登入流程在「讀站台」與「寫站台」之間（填表那一刻）讓使用者存了新密碼
async function loginWithConcurrentSave({ succeed, startStreak = 0 }) {
  const { c, st } = await freshStore()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const lg = await import('../src/background/login.js?t=' + Math.random())
  await st.saveSite(ORIGIN, await siteOf(cr, { failStreak: startStreak }))
  const newEnc = await cr.encryptSecret('new-pass')
  const tab = await c.tabs.create({ url: `${ORIGIN}/login` })
  c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  c.__setTabResponder(async (tabId, msg) => {
    if (msg.type === 'FILL_LOGIN') {
      const cur = await st.getSite(ORIGIN)
      await st.saveSite(ORIGIN, { ...cur, passwordEnc: newEnc, username: 'wayne2' })
      if (succeed) c.__setTabState(tabId, { url: `${ORIGIN}/home`, status: 'complete' })
      return { ok: true }
    }
    return { ok: true }
  })
  const res = await lg.ensureLoggedIn(tab.id, taskOf('t1'), { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 })
  return { res, site: await st.getSite(ORIGIN), newEnc }
}

test('1 登入失敗計數：途中使用者存的新密碼不被舊副本蓋掉，failStreak 正確', async () => {
  const { res, site, newEnc } = await loginWithConcurrentSave({ succeed: false })
  assert.equal(res.ok, false)
  assert.deepEqual(site.passwordEnc, newEnc, '新密碼被登入流程開頭讀到的舊副本蓋回去了')
  assert.equal(site.username, 'wayne2')
  assert.equal(site.failStreak, 1)
})

test('1 登入成功歸零：途中存的新密碼仍在、failStreak 歸 0', async () => {
  const { res, site, newEnc } = await loginWithConcurrentSave({ succeed: true, startStreak: 2 })
  assert.equal(res.ok, true)
  assert.deepEqual(site.passwordEnc, newEnc)
  assert.equal(site.failStreak, 0)
})

test('1 updateSite：站台不存在不寫、mutator 回 null 不寫', async () => {
  const { st } = await freshStore()
  let called = 0
  await st.updateSite('https://none.test', (s) => { called++; return s })
  assert.equal(called, 0)
  assert.deepEqual(await st.getSites(), {})
  await st.saveSite(ORIGIN, { enabled: true, failStreak: 2 })
  await st.updateSite(ORIGIN, () => null)
  assert.deepEqual(await st.getSite(ORIGIN), { enabled: true, failStreak: 2 })
})

test('1 設定頁站台啟停：在鎖內以最新站台切換，別的欄位（背景剛寫的）不被舊副本蓋掉', async () => {
  const { c, st } = await freshStore()
  await st.saveSite(ORIGIN, { loginUrl: `${ORIGIN}/login`, enabled: false, failStreak: 3, username: 'u1' })
  const jd = new JSDOM(REPORT_HTML, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  await se.renderSettings()
  const btn = jd.window.document.querySelector('#sites-list [data-action="site-toggle"]')
  assert.ok(btn, '前置：站台列有啟停鈕')
  // 畫面畫好之後、按下之前，背景改了使用者名稱
  await st.saveSite(ORIGIN, { ...(await st.getSite(ORIGIN)), username: 'u2' })
  btn.click()
  await sleep(40)
  const site = await st.getSite(ORIGIN)
  assert.equal(site.enabled, true)
  assert.equal(site.failStreak, 0)
  assert.equal(site.username, 'u2')
  void c
})

// ======================= 2. UI 動作失敗不得靜默 =======================

// 讓 runtime.sendMessage 對指定型別回 ok:false（或丟例外），其餘回 undefined
function failOn(c, type, mode, reason) {
  c.__setRuntimeResponder((msg) => {
    if (msg?.type !== type) return undefined
    if (mode === 'reject') throw new Error(reason)
    return { ok: false, error: reason }
  })
}

async function freshPopup() {
  const { c, st } = await freshStore()
  const jd = new JSDOM(POPUP_HTML)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  let closed = 0
  jd.window.close = () => { closed++ }
  globalThis.chrome.tabs.query = async () => [{ id: 7, url: 'https://a.test/p' }]
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  return { c, st, pp, doc: jd.window.document, closed: () => closed }
}

for (const mode of ['okfalse', 'reject']) {
  test(`2 popup「在這個頁面選取」${mode}：說出原因、不關 popup`, async () => {
    const { c, pp, doc, closed } = await freshPopup()
    failOn(c, MSG.ENTER_PICK, mode, '原因甲')
    await pp.render()
    doc.getElementById('pick-here').click()
    await sleep(30)
    assert.match(doc.getElementById('pick-here-note').textContent, /原因甲/)
    assert.equal(closed(), 0, '失敗時不得關掉 popup')
  })
}

test('2 popup「在這個頁面選取」成功才關', async () => {
  const { c, pp, doc, closed } = await freshPopup()
  c.__setRuntimeResponder((msg) => msg?.type === MSG.ENTER_PICK ? { ok: true } : undefined)
  await pp.render()
  doc.getElementById('pick-here').click()
  await sleep(30)
  assert.equal(closed(), 1)
  assert.equal(doc.getElementById('pick-here-note').textContent, '')
})

const gapItem = { taskId: 'i1', taskName: '匯率', kind: 'gap', count: 3, from: '2026-09-18T10:10', slot: '2026-09-18T10:30' }
const intervalTask = { ...taskOf('i1', { name: '匯率' }), schedule: { type: 'interval', everyMinutes: 10, weekdays: [0, 1, 2, 3, 4, 5, 6] } }

for (const mode of ['okfalse', 'reject']) {
  test(`2 popup 空窗「知道了」${mode}：說出原因、那一列留著`, async () => {
    const { c, pp, doc } = await freshPopup()
    failOn(c, MSG.SKIP_ONE, mode, '原因乙')
    pp.render({ health: { level: 'yellow', summary: '' }, tasks: [intervalTask], lastValues: {}, nextRuns: {}, healthMap: {}, missed: [gapItem] })
    doc.querySelector('.missed-gap [data-action="ack-gap"]').click()
    await sleep(20)
    const row = doc.querySelector('.missed-gap')
    assert.ok(row, '失敗時不得移除那一列')
    assert.match(row.textContent, /原因乙/)
  })
}

test('2 popup 空窗「知道了」成功才移除', async () => {
  const { c, pp, doc } = await freshPopup()
  c.__setRuntimeResponder((msg) => msg?.type === MSG.SKIP_ONE ? { ok: true } : undefined)
  pp.render({ health: { level: 'yellow', summary: '' }, tasks: [intervalTask], lastValues: {}, nextRuns: {}, healthMap: {}, missed: [gapItem] })
  doc.querySelector('.missed-gap [data-action="ack-gap"]').click()
  await sleep(20)
  assert.equal(doc.querySelector('.missed-gap'), null)
})

async function freshTasksPage() {
  const { c, st } = await freshStore()
  const jd = new JSDOM(REPORT_HTML, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  ts.renderTasks([intervalTask, taskOf('d1')], {}, [{ taskId: 'd1', slot: '2026-09-18T09:00' }, gapItem])
  return { c, st, ts, doc: jd.window.document }
}

for (const [label, selector, type] of [
  ['補抓勾選項目', '#missed-banner [data-action="catch-up"]', MSG.CATCH_UP_ONE],
  ['略過勾選項目', '#missed-banner [data-action="skip"]', MSG.SKIP_ONE],
  ['空窗知道了', '#missed-banner .missed-gap [data-action="ack-gap"]', MSG.SKIP_ONE]
]) {
  for (const mode of ['okfalse', 'reject']) {
    test(`2 任務頁「${label}」${mode}：#task-note 說出原因`, async () => {
      const { c, doc } = await freshTasksPage()
      failOn(c, type, mode, '原因丙')
      doc.querySelector(selector).click()
      await sleep(20)
      assert.match(doc.getElementById('task-note').textContent, /原因丙/)
    })
  }
}

async function freshPickerForm() {
  const { c, st } = await freshStore()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render({ tabId: 3, url: 'https://a.test/p', locator: { css: '#v' } })
  return { c, st, pk, doc: jd.window.document }
}

for (const mode of ['okfalse', 'reject']) {
  test(`2 Picker 前置動作「在頁面上選取」${mode}：守門區顯示原因`, async () => {
    const { c, doc } = await freshPickerForm()
    failOn(c, MSG.ENTER_PICK, mode, '原因丁')
    doc.getElementById('preaction-add').click()
    doc.querySelector('[data-action="preaction-pick"]').click()
    await sleep(20)
    const box = doc.getElementById('errors')
    assert.equal(box.hidden, false)
    assert.match(box.textContent, /原因丁/)
  })
}

// 真正的面板：走正式接線（網址帶 tabId），chrome.runtime.id 只在匯入那一刻存在
async function freshPanel(tabId, mode) {
  const { c, st } = await freshStore()
  await st.setPanelCtx(tabId, { kind: 'new', ctx: { tabId, url: 'https://a.test/p', locator: { css: '#v' }, picks: [] } })
  const jd = new JSDOM(PICKER_HTML, { url: `chrome-extension://abc/ui/picker/picker.html?tabId=${tabId}`, pretendToBeVisual: true })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  failOn(c, MSG.ENTER_PICK, mode, '原因戊')
  c.runtime.id = 'af-test'
  try {
    await import('../src/ui/picker/picker.js?t=' + Math.random())
  } finally {
    delete c.runtime.id
  }
  await sleep(80)
  return { c, st, doc: jd.window.document }
}

for (const mode of ['okfalse', 'reject']) {
  test(`2 Picker「回頁面重選目標」${mode}：守門區顯示原因`, async () => {
    const { c, doc } = await freshPanel(12, mode)
    doc.getElementById('repick-target').click()
    await sleep(30)
    assert.ok(api(c, 'runtime.sendMessage').some(x => x.args[0]?.type === MSG.ENTER_PICK), '前置：有送出')
    const box = doc.getElementById('errors')
    assert.equal(box.hidden, false)
    assert.match(box.textContent, /原因戊/)
  })
}

// ======================= 3. 儀表板版面的讀-改-寫 =======================

async function freshDashboard() {
  const { c, st } = await freshStore()
  await st.saveTasks([taskOf('t1'), taskOf('t2')])
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(REPORT_HTML, { url: 'chrome-extension://abc/ui/report/report.html' })
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 700, configurable: true })
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  const a = await ls.addCard(did, { type: 'line', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }], options: {} })
  const b = await ls.addCard(did, { type: 'number', x: 0, y: 2, w: 3, h: 2, source: [{ taskId: 't2', aggregation: 'raw' }], options: {} })
  await ls.updateCard(did, a.id, { x: 0, y: 0, w: 3, h: 2 })
  await ls.updateCard(did, b.id, { x: 0, y: 2, w: 3, h: 2 })
  return { c, st, ls, db, dw, did, a, b, doc: jd.window.document, win: jd.window, grid }
}

function pointer(win, el, type, x, y) {
  const ev = new win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  el.dispatchEvent(ev)
}

// 下一次讀 layout（放開時 dashboard 讀版面）回舊值，並在回傳前讓背景把 t2 修剪完（替身讓出）
function interleavePruneOnNextLayoutRead(c, ls) {
  const orig = c.storage.local.get.bind(c.storage.local)
  let armed = true
  c.storage.local.get = async (keys) => {
    const res = await orig(keys)
    if (armed && keys === 'layout') {
      armed = false
      const stale = structuredClone(res)
      await ls.pruneCardsForTask('t2')
      return stale
    }
    return res
  }
}

async function dragCard(env, cardId) {
  const { doc, win, grid } = env
  const el = doc.querySelector(`[data-card-id="${cardId}"]`)
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 160 })
  pointer(win, el, 'pointerdown', 10, 10)
  pointer(win, grid, 'pointermove', 310, 10)
}

test('3 拖曳放開與背景 pruneCardsForTask 交錯：被修剪的來源與卡片沒有復活，位置照樣寫入', async () => {
  const env = await freshDashboard()
  const { c, ls, db, did, a, b, doc, grid, win } = env
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await dragCard(env, a.id)
  interleavePruneOnNextLayoutRead(c, ls)
  pointer(win, grid, 'pointerup', 310, 10)
  await sleep(60)
  const cards = (await ls.getLayout()).dashboards[0].cards
  const ca = cards.find(x => x.id === a.id)
  assert.deepEqual(ca.source.map(s => s.taskId), ['t1'], '被修剪的 t2 被舊版面蓋回來了')
  assert.equal(cards.some(x => x.id === b.id), false, '被修剪掉的卡片復活了')
  assert.equal(ca.x, 6, '拖曳的位置要寫入')
})

test('3 復原：拖曳後背景刪掉一張卡，復原只還原位置，不讓已刪的卡片回來', async () => {
  const env = await freshDashboard()
  const { ls, db, did, a, b, doc, grid, win } = env
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  await dragCard(env, a.id)
  pointer(win, grid, 'pointerup', 310, 10)
  await sleep(60)
  assert.equal((await ls.getLayout()).dashboards[0].cards.find(x => x.id === a.id).x, 6, '前置：拖過去了')
  await ls.pruneCardsForTask('t2')
  await db.undo()
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.some(x => x.id === b.id), false, '復原讓已刪的卡片回來了')
  const ca = cards.find(x => x.id === a.id)
  assert.equal(ca.x, 0, '位置要還原')
  assert.deepEqual(ca.source.map(s => s.taskId), ['t1'], '被修剪的來源不得復活')
  await db.redo()
  assert.equal((await ls.getLayout()).dashboards[0].cards.find(x => x.id === a.id).x, 6, '重做回到拖曳後')
})

test('3 自動排列：背景同時修剪的來源不被舊副本蓋回', async () => {
  const env = await freshDashboard()
  const { c, ls, db, did, a, b, doc } = env
  await db.renderDashboard(did)
  doc.getElementById('edit-layout').click()
  interleavePruneOnNextLayoutRead(c, ls)
  doc.getElementById('auto-arrange').click()
  await sleep(60)
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.deepEqual(cards.find(x => x.id === a.id).source.map(s => s.taskId), ['t1'])
  assert.equal(cards.some(x => x.id === b.id), false)
})

// ======================= 4. 刪除儀表板的確認 =======================

test('4 刪除儀表板走對話框（danger）、取消零刪除；確認才刪；頁面內確認列已移除', async () => {
  const env = await freshDashboard()
  const { c, ls, db, did, doc } = env
  assert.equal(doc.getElementById('dashboard-delete-confirm'), null, '頁面內確認列要移除')
  await ls.addDashboard('第二個')
  await db.renderDashboard(did)
  const before = JSON.stringify(await c.storage.local.get('layout'))
  doc.querySelector(`#dashboard-tabs [data-dash-id="${did}"] [data-action="delete"]`).click()
  await sleep(20)
  const dlg = doc.querySelector('dialog.modal')
  assert.ok(dlg && dlg.open, '要出現共用對話框')
  const ok = dlg.querySelector('[data-action="confirm"]')
  assert.ok(ok.classList.contains('btn-danger') && !ok.classList.contains('btn-primary'))
  dlg.querySelector('[data-action="cancel"]').click()
  await sleep(30)
  assert.equal(JSON.stringify(await c.storage.local.get('layout')), before, '取消零寫入')
  doc.querySelector(`#dashboard-tabs [data-dash-id="${did}"] [data-action="delete"]`).click()
  await sleep(20)
  doc.querySelector('dialog.modal [data-action="confirm"]').click()
  await sleep(40)
  const l = await ls.getLayout()
  assert.equal(l.dashboards.length, 1)
  assert.notEqual(l.dashboards[0].id, did)
})

// ======================= 5. 抽屜「套用」 =======================

test('5 抽屜開著時修剪一個序列，套用後它不在 source', async () => {
  const env = await freshDashboard()
  const { st, ls, db, dw, did, b, doc } = env
  await db.renderDashboard(did)
  await dw.openDrawer(did, b.id)
  // 抽屜草稿：把 t1 也拖進來（來源改變，套用時要寫 source）
  assert.ok(await dw.mergeIntoDraft(did, b.id, { source: [{ taskId: 't2', aggregation: 'raw' }, { taskId: 't1', aggregation: 'raw' }] }))
  // 抽屜開著時 t2 被刪（背景修剪卡片來源）
  await st.deleteTasks(['t2'])
  await ls.pruneSeries(['t2'])
  doc.getElementById('drawer-apply').click()
  await sleep(40)
  const card = (await ls.getLayout()).dashboards[0].cards.find(x => x.id === b.id)
  // 卡片 b 原本只有 t2、已被修剪刪除：套用不得讓它帶著 t2 回來
  if (card) assert.deepEqual(card.source.map(s => s.taskId), ['t1'])
  const all = (await ls.getLayout()).dashboards[0].cards.flatMap(x => x.source.map(s => s.taskId))
  assert.equal(all.includes('t2'), false, '修剪過的序列復活了')
})

test('5 抽屜套用：卡片還在時，草稿裡已刪的序列丟掉、其餘照寫', async () => {
  const env = await freshDashboard()
  const { st, ls, db, dw, did, a, doc } = env
  await db.renderDashboard(did)
  await dw.openDrawer(did, a.id)
  assert.ok(await dw.mergeIntoDraft(did, a.id, { source: [{ taskId: 't2', aggregation: 'raw' }, { taskId: 't1', aggregation: 'raw' }] }))
  await st.deleteTasks(['t2'])
  await ls.pruneSeries(['t2'])
  doc.getElementById('drawer-apply').click()
  await sleep(40)
  const card = (await ls.getLayout()).dashboards[0].cards.find(x => x.id === a.id)
  assert.deepEqual(card.source.map(s => s.taskId), ['t1'])
})

// ======================= 6. 通知冷卻 =======================

test('6 notifications.create 丟例外後，同狀態下一次仍會通知（notifyFailure 與 notifySiteFailure）', async () => {
  const { c } = await freshStore()
  const nt = await import('../src/background/notify.js?t=' + Math.random())
  const origCreate = c.notifications.create
  c.notifications.create = async () => { throw new Error('boom') }
  assert.equal(await nt.notifyFailure('t1', 'error', { title: 'x', message: 'y' }), false)
  assert.equal(await nt.notifySiteFailure(ORIGIN, { id: 't2', name: 'B' }, 'error'), false)
  c.notifications.create = origCreate
  assert.equal(await nt.notifyFailure('t1', 'error', { title: 'x', message: 'y' }), true, '建立失敗那一次不得佔住冷卻')
  assert.equal(await nt.notifySiteFailure(ORIGIN, { id: 't2', name: 'B' }, 'error'), true)
  // 成功之後照常冷卻
  assert.equal(await nt.notifyFailure('t1', 'error', { title: 'x', message: 'y' }), false)
})

test('6 撤回時原本有舊紀錄就放回舊的（換狀態那次失敗，舊狀態的冷卻不被抹掉）', async () => {
  const { c, st } = await freshStore()
  const nt = await import('../src/background/notify.js?t=' + Math.random())
  assert.equal(await nt.notifyFailure('t1', 'error', { title: 'x', message: 'y', nowMs: 1000 }), true)
  const origCreate = c.notifications.create
  c.notifications.create = async () => { throw new Error('boom') }
  assert.equal(await nt.notifyFailure('t1', 'not_found', { title: 'x', message: 'y', nowMs: 2000 }), false)
  c.notifications.create = origCreate
  assert.deepEqual((await st.getNotifyLog()).t1, { status: 'error', at: 1000 })
})

// ======================= 7. forbidden 診斷節流 =======================

const CONTENT = { tab: { id: 5, url: 'https://evil.test/x' }, url: 'https://evil.test/x', frameId: 0 }

test('7 同來源同型別連送 5 次 → diag 一筆；回應照舊 forbidden；換型別另記一筆', async () => {
  const { st } = await freshStore()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  for (let i = 0; i < 5; i++) {
    const res = await bg.handleMessage({ type: MSG.RUN_TASK, taskId: 't1' }, CONTENT)
    assert.deepEqual(res, { ok: false, error: 'forbidden' })
  }
  const forb = () => st.getDiagList().then(l => l.filter(e => e.kind === 'forbidden'))
  assert.equal((await forb()).length, 1)
  await bg.handleMessage({ type: MSG.SELF_CHECK }, CONTENT)
  assert.equal((await forb()).length, 2)
})

// ======================= 8. repick 核對分頁 =======================

test('8 重選開的分頁會登記；別的分頁送 purpose:repick 被拒、任務不變、記診斷；正確分頁照常', async () => {
  const { c, st } = await freshStore()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  await st.saveTask(taskOf('t1'))
  await bg.handleMessage({ type: MSG.ENTER_PICK, purpose: 'repick', taskId: 't1' }, {}, { contentTimeoutMs: 50 })
  const repickTab = (await st.getRepickTabs()).t1
  assert.equal(typeof repickTab, 'number', '重選流程要把自己開的分頁登記進 repickTabs')
  const pick = { type: MSG.PICKED, purpose: 'repick', taskId: 't1', locator: { css: '#new', path: '', anchor: null, xpath: '' }, picks: [] }

  const bad = await bg.handleMessage(pick, { tab: { id: repickTab + 100, url: 'https://evil.test/x' }, url: 'https://evil.test/x', frameId: 0 })
  assert.deepEqual(bad, { ok: false, error: 'forbidden' })
  assert.equal((await st.getTask('t1')).locator.css, '#v', '任務不得被改')
  assert.ok((await st.getDiagList()).some(e => e.kind === 'forbidden'))
  assert.equal(api(c, 'tabs.remove').length, 0, '不是它的分頁，不得收掉重選分頁')

  const good = await bg.handleMessage(pick, { tab: { id: repickTab, url: `${ORIGIN}/p` }, url: `${ORIGIN}/p`, frameId: 0 })
  assert.deepEqual(good, { ok: true })
  assert.equal((await st.getTask('t1')).locator.css, '#new')
})

test('8 沒有登記過重選分頁（使用者自己開的分頁）送 repick 也被拒', async () => {
  const { st } = await freshStore()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  await st.saveTask(taskOf('t1'))
  const res = await bg.handleMessage({ type: MSG.PICKED, purpose: 'repick', taskId: 't1', locator: { css: '#new' }, picks: [] },
    { tab: { id: 3, url: `${ORIGIN}/p` }, url: `${ORIGIN}/p`, frameId: 0 })
  assert.deepEqual(res, { ok: false, error: 'forbidden' })
  assert.equal((await st.getTask('t1')).locator.css, '#v')
})

// ======================= 9. 同一 worker 卡住的 runState =======================

test('9 同 boot、running、開始跑在 6 分鐘前 → interrupted（daily 進錯過清單、移除）；2 分鐘前 → 不碰', async () => {
  const { st } = await freshStore()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTasks([taskOf('d1'), taskOf('d2')])
  const now = Date.now()
  await st.updateRunState(() => ({
    'd1@2026-09-18T09:00': { state: 'running', at: now - 6 * 60000, runningAt: now - 6 * 60000, boot: BOOT, attempt: 1, reason: 'scheduled' },
    'd2@2026-09-18T09:00': { state: 'running', at: now - 2 * 60000, runningAt: now - 2 * 60000, boot: BOOT, attempt: 1, reason: 'scheduled' }
  }))
  await fe.recoverRunState()
  const recs = await st.getRecordsByDate('2026-09-18')
  assert.deepEqual(recs.map(r => [r.taskId, r.status]), [['d1', 'interrupted']])
  const rs = await st.getRunState()
  assert.deepEqual(Object.keys(rs), ['d2@2026-09-18T09:00'], '卡住的移除、還在時限內的不碰')
  assert.ok((await st.getMissedList()).some(m => m.taskId === 'd1' && m.slot === '2026-09-18T09:00'))
})

test('9 同 boot 的 queued（排隊中）不算卡住；卡住判定從開始跑算，不從進佇列算', async () => {
  const { st } = await freshStore()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTasks([taskOf('d1'), taskOf('d2')])
  const now = Date.now()
  await st.updateRunState(() => ({
    'd1@2026-09-18T09:00': { state: 'queued', at: now - 6 * 60000, boot: BOOT, attempt: 1, reason: 'scheduled' },
    'd2@2026-09-18T09:00': { state: 'running', at: now - 8 * 60000, runningAt: now - 60000, boot: BOOT, attempt: 1, reason: 'scheduled' }
  }))
  await fe.recoverRunState()
  assert.equal((await st.getRecordsByDate('2026-09-18')).length, 0)
  assert.equal(Object.keys(await st.getRunState()).length, 2)
})

// ======================= 10. 看門狗不被續跑擋住 =======================

test('10 看門狗一輪在續跑未完成前就完成 refreshMissed；續跑之後照樣完成', async () => {
  const { c, st } = await freshStore()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await st.saveTask(taskOf('d1'))
  const now = Date.now()
  await st.setLastSeenAt(now - 3 * 3600000)
  await st.updateRunState(() => ({
    'd1@2026-09-18T09:00': { state: 'queued', at: now - 60000, boot: 'other-worker', attempt: 1, reason: 'scheduled' }
  }))
  let release
  const gate = new Promise(r => { release = r })
  let extractAsked = false
  c.__setTabResponder(async (tabId, msg) => {
    if (msg.type === MSG.EXTRACT) {
      extractAsked = true
      await gate
    }
    return { ok: true, value: 7, raw: '7', status: 'ok', strategyUsed: 'auto', layer: 'css' }
  })
  await wd.runWatchdog({ pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 3000 })
  const seen = await st.getLastSeenAt()
  assert.ok(seen > now - 3 * 3600000, 'refreshMissed 要在這一輪完成（lastSeenAt 前移）')
  assert.ok((await st.getDiagList()).some(e => e.kind === 'watchdog'), '整輪巡檢要跑完')
  assert.equal((await st.getRecordsByDate('2026-09-18')).length, 0, '續跑此時還沒完成（看門狗沒有等它）')
  // 放行：續跑照樣寫完
  for (let i = 0; i < 100 && !extractAsked; i++) await sleep(10)
  release()
  let recs = []
  for (let i = 0; i < 200 && recs.length === 0; i++) {
    await sleep(10)
    recs = await st.getRecordsByDate('2026-09-18')
  }
  assert.equal(recs.length, 1)
  assert.equal(recs[0].taskId, 'd1')
})

test('AF-21 補修：匯出退路不得自我引用（CSS 循環＝整個值無效）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/shared/export.js', import.meta.url), 'utf8')
  const self = [...src.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)[,)]/g)].filter(m => m[1] === m[2])
  assert.deepEqual(self.map(m => m[1]), [])
})

test('AF-21 補修：別的網頁送重選「取消」不得收掉我們開的重選分頁；重選分頁自己取消才收', async () => {
  const { c, st } = await freshStore()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  await st.saveTask(taskOf('t1'))
  await bg.handleMessage({ type: MSG.ENTER_PICK, purpose: 'repick', taskId: 't1' }, {}, { contentTimeoutMs: 50 })
  const repickTab = (await st.getRepickTabs()).t1
  const cancel = { type: MSG.PICKED, purpose: 'repick', taskId: 't1', cancelled: true }
  await bg.handleMessage(cancel, { tab: { id: repickTab + 100, url: 'https://evil.test/x' }, url: 'https://evil.test/x', frameId: 0 })
  assert.equal(api(c, 'tabs.remove').length, 0)
  assert.equal((await st.getRepickTabs()).t1, repickTab)
  await bg.handleMessage(cancel, { tab: { id: repickTab, url: `${ORIGIN}/p` }, url: `${ORIGIN}/p`, frameId: 0 })
  assert.equal(api(c, 'tabs.remove').length, 1)
})
