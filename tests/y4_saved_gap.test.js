// AF-18 批次 D：儲存成功到面板關閉之間的缺口（ctx 收成 kind:'saved'）。
// 對照 docs/AF-18-PLAN.md 批次 D 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const TASK = { id: 't1', name: '甲', schedule: { type: 'interval', everyMinutes: 30, weekdays: [] } }
const CTX = { locator: { css: '#a' }, url: 'https://a.test/p', preview: '1', nameHint: '新目標', picks: [] }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function freshPanel() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
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
const sessionOf = async (tabId) => (await chrome.storage.session.get(`panel:${tabId}`))[`panel:${tabId}`]
const closeCalls = (c, tabId) => c.__calls.filter(x => x.api === 'runtime.sendMessage')
  .map(x => x.args[0]).filter(m => m?.type === 'CLOSE_PANEL' && m.tabId === tabId)

test('D-1 儲存成功當下 ctx 收成 kind:saved，不留表單內容與草稿；到期照常關面板', async () => {
  const { c, st, pk } = await freshPanel()
  await st.setPanelCtx(7, { kind: 'new', ctx: CTX, draft: { name: '甲' } })
  await pk.showSavedFeedback(TASK, { closeDelayMs: 10, tabId: 7 })
  const entry = await sessionOf(7)
  assert.equal(entry?.kind, 'saved', JSON.stringify(entry))
  assert.equal(entry.ctx, undefined, '不帶表單內容')
  assert.equal(entry.draft, undefined, '不帶草稿')
  assert.match(String(entry.text || ''), /已儲存/, '面板重載時要畫得回同一句')
  await sleep(40)
  assert.equal(closeCalls(c, 7).length, 1, '沒人動的話 1.5 秒（這裡縮短）後照常關')
})

test('D-2 到期前使用者已經開始下一輪（session 不再是 saved）：到期不得關面板', async () => {
  const { c, st, pk } = await freshPanel()
  await st.setPanelCtx(7, { kind: 'new', ctx: CTX })
  await pk.showSavedFeedback(TASK, { closeDelayMs: 20, tabId: 7 })
  await st.setPanelCtx(7, { kind: 'waiting', purpose: 'task' })
  await sleep(50)
  assert.equal(closeCalls(c, 7).length, 0, '會把使用者剛開始的新一輪連面板一起關掉')
})

test('D-3 面板文件在 saved 態被重載：畫得出回饋區，不得是空白或一張空表單', async () => {
  const { pk, doc } = await freshPanel()
  const r = await pk.renderFromPanelCtx({ kind: 'saved', text: '已儲存。下次抓取：14:05' })
  assert.equal(r?.rendered, true)
  const box = doc.getElementById('saved-feedback')
  assert.ok(box, '要有回饋區')
  assert.match(box.textContent, /已儲存。下次抓取：14:05/)
  assert.equal(doc.getElementById('panel-waiting').hidden, true)
  const save = doc.getElementById('save')
  assert.ok(!save || save.closest('[hidden]'), '沒有表單可存：儲存鈕不得出現')
  const name = doc.getElementById('name')
  assert.ok(!name || name.closest('[hidden]'), '不得露出一張空表單')
})

test('D-4 右鍵與 ENTER_PICK（popup、面板）在 saved 態都寫等待態', async () => {
  const { c, st, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await st.setPanelCtx(tab.id, { kind: 'saved', text: '已儲存。' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  assert.equal((await sessionOf(tab.id))?.kind, 'waiting', '右鍵')
  await st.setPanelCtx(tab.id, { kind: 'saved', text: '已儲存。' })
  await bg.handleMessage({ type: 'ENTER_PICK', purpose: 'task', tabId: tab.id, frameId: 0 }, {})
  assert.equal((await sessionOf(tab.id))?.kind, 'waiting', 'ENTER_PICK 訊息')
})

test('D-5 鏈結：存完任務甲立刻右鍵再選 → 新的 PICKED 是完整新表單，不是換目標', async () => {
  const { c, st, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await st.setPanelCtx(tab.id, { kind: 'saved', text: '已儲存。' })
  await st.saveSettings({ pickerDefaults: { last: { scheduleType: 'interval', everyMinutes: 30, times: [], weekdays: [] } } })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  await bg.handleMessage({ type: 'PICKED', purpose: 'task', ...CTX }, { tab: { id: tab.id, url: 'https://a.test/p' } })
  const entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'new')
  assert.equal(entry.retarget, false, '上一個任務已經存了，不能當成換目標')
  assert.equal(entry.draft, undefined, '上一個任務的草稿不得跟過來')

  // 面板端：用這份 ctx 畫出來的是新表單
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  const doc = jd.window.document
  await pk.renderFromPanelCtx(entry)
  assert.equal(doc.getElementById('name').value, '新目標', '名稱是新目標的預設名，不是「甲」')
  assert.equal(doc.getElementById('schedule-type').value, 'interval', '排程沿用上次（pickerDefaults.last）')
  assert.equal(doc.getElementById('retarget-note').hidden, true, '沒有「已換成新的目標」提示')
})
