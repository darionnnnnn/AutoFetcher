// AF-3 批次 B:選取模式的三端接線(右鍵選單 → content → background → Picker / 任務更新)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#old', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const sentToTab = (c, type) => c.__calls
  .filter(x => x.api === 'tabs.sendMessage')
  .map(x => x.args[1])
  .filter(m => m?.type === type)

// ---- 右鍵選單 ----

test('右鍵選單只有三項,而且沒有「抓取此區塊」', async () => {
  const { c, bg } = await fresh()
  await bg.setupContextMenus()
  const created = c.__calls.filter(x => x.api === 'contextMenus.create').map(x => x.args[0])
  const children = created.filter(m => m.parentId === 'af-root')
  assert.equal(children.length, 3, `子項應為三項,實得 ${children.map(m => m.title).join(' / ')}`)
  assert.equal(created.some(m => m.id === 'af-capture-block'), false, '區塊由選取模式自動判定,不再獨立一項')
  assert.ok(created.some(m => m.id === 'af-pick'), '必須有「選取要抓的內容」')
  assert.ok(created.some(m => m.id === 'af-site-login'), '必須有「設定此站台登入」')
  assert.ok(created.some(m => m.id === 'af-open-report'), '必須有「開啟報表」')
})

test('按下「選取要抓的內容」:注入後送 ENTER_PICK,不再直接開視窗', async () => {
  const { c, bg } = await fresh()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick' }, tab)
  const msgs = sentToTab(c, 'ENTER_PICK')
  assert.equal(msgs.length, 1, '必須送 ENTER_PICK 給 content')
  assert.equal(msgs[0].purpose, 'task')
  assert.equal(c.__calls.filter(x => x.api === 'windows.create').length, 0,
    '此時還不開 Picker,要等使用者在頁面上選完')
  const inject = c.__calls.findIndex(x => x.api === 'scripting.executeScript')
  const send = c.__calls.findIndex(x => x.api === 'tabs.sendMessage')
  assert.ok(inject >= 0 && inject < send, '要先注入再送訊息')
})

test('按下「設定此站台登入」送出 login-user 的選取', async () => {
  const { c, bg } = await fresh()
  const tab = await c.tabs.create({ url: 'https://a.test/login' })
  await bg.handleContextMenu({ menuItemId: 'af-site-login' }, tab)
  const msgs = sentToTab(c, 'ENTER_PICK')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].purpose, 'login-user')
})

// ---- PICKED 的三種去向 ----

test('purpose=task:選完才開 Picker 視窗,且帶上 locator 與區塊資訊', async () => {
  const { c, bg } = await fresh()
  await bg.handleMessage({
    type: 'PICKED', purpose: 'task',
    locator: { css: '#v', path: '', anchor: null, xpath: '' },
    preview: '1,234', previewValue: 1234,
    blockInfo: { kind: 'table', axis: 'col', index: 1, headerText: '數量' }
  }, { tab: { id: 7, url: 'https://a.test/p' } })

  const win = c.__calls.find(x => x.api === 'windows.create')
  assert.ok(win, '必須開 Picker 視窗')
  const url = win.args[0].url
  const ctx = JSON.parse(decodeURIComponent(url.split('ctx=')[1]))
  assert.equal(ctx.locator.css, '#v')
  assert.equal(ctx.previewValue, 1234)
  assert.equal(ctx.blockInfo.headerText, '數量')
  assert.equal(ctx.url, 'https://a.test/p', '目標網址取自送訊息的那個分頁')
})

test('purpose=repick:直接更新任務的 locator,不開視窗', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(task())
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1',
    locator: { css: '#new', path: '', anchor: null, xpath: '' },
    preview: '99', previewValue: 99, blockInfo: { kind: 'number' }
  }, { tab: { id: 7, url: 'https://a.test/p' } })

  assert.equal((await st.getTask('t1')).locator.css, '#new')
  assert.equal(c.__calls.filter(x => x.api === 'windows.create').length, 0)
})

test('purpose=repick 指到不存在的任務時安靜略過,不丟例外也不建任務', async () => {
  const { st, bg } = await fresh()
  await assert.doesNotReject(() => bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 'nope',
    locator: { css: '#new' }, blockInfo: { kind: 'number' }
  }, { tab: { id: 7, url: 'https://a.test/p' } }))
  assert.equal((await st.getTasks()).length, 0)
})

test('取消的選取什麼都不做', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(task())
  await bg.handleMessage({ type: 'PICKED', purpose: 'task', cancelled: true },
    { tab: { id: 7, url: 'https://a.test/p' } })
  await bg.handleMessage({ type: 'PICKED', purpose: 'repick', taskId: 't1', cancelled: true },
    { tab: { id: 7, url: 'https://a.test/p' } })
  assert.equal(c.__calls.filter(x => x.api === 'windows.create').length, 0)
  assert.equal((await st.getTask('t1')).locator.css, '#old', '取消不得改動任務')
})

// ---- 任務頁「重選」 ----

test('任務頁重選:開目標頁 → 等載入 → 注入 → 送 ENTER_PICK(purpose=repick)', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(task())
  await bg.handleMessage({ type: 'ENTER_PICK', taskId: 't1', purpose: 'repick' }, {})
  const created = c.__calls.find(x => x.api === 'tabs.create')
  assert.ok(created, '要開任務的目標頁')
  assert.equal(created.args[0].url, 'https://a.test/p')
  assert.ok(c.__calls.some(x => x.api === 'scripting.executeScript'), '必須注入 content script')
  const msgs = sentToTab(c, 'ENTER_PICK')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].purpose, 'repick')
  assert.equal(msgs[0].taskId, 't1')
  const inject = c.__calls.findIndex(x => x.api === 'scripting.executeScript')
  const send = c.__calls.findIndex(x => x.api === 'tabs.sendMessage')
  assert.ok(inject < send, '注入要在送訊息之前(舊版直接送訊息,所以永遠失敗)')
})

// ---- content 端的訊息路由 ----

test('content 收到 ENTER_PICK 會進入選取模式,收到 EXIT_PICK 會離開', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM('<!doctype html><body><div id="v">1</div></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?t=' + Math.random())

  const listener = [...c.runtime.onMessage._listeners][0]
  listener({ type: 'ENTER_PICK', purpose: 'task' }, {}, () => {})
  assert.ok(jd.window.document.querySelector('[data-af-overlay]'), 'ENTER_PICK 要開啟選取模式')
  listener({ type: 'EXIT_PICK' }, {}, () => {})
  assert.equal(jd.window.document.querySelector('[data-af-overlay]'), null, 'EXIT_PICK 要關閉')
})

test('舊的 REPICK 訊息型別已完全移除', async () => {
  const { MSG } = await import('../src/shared/messages.js?t=' + Math.random())
  assert.equal(MSG.REPICK, undefined, 'REPICK 由 ENTER_PICK 取代')
  assert.ok(MSG.ENTER_PICK && MSG.EXIT_PICK && MSG.PICKED)
})
