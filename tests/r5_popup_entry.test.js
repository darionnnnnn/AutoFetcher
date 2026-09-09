// AF-9 作業 D：popup 的主要入口「在這個頁面選取」
// 沒有這顆按鈕，新使用者只會看到一句「去網頁上按右鍵」，
// 而右鍵選單本身沒有任何提示會被發現。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
const MANIFEST = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'))
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

async function fresh(tabUrl = 'https://a.test/p') {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  jd.window.close = () => {}
  globalThis.chrome.tabs.query = async () => (tabUrl ? [{ id: 7, url: tabUrl }] : [])
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  return { c, st, pp, doc: jd.window.document }
}

const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])

test('D1-1 popup 最上面就有「在這個頁面選取」', async () => {
  const { doc } = await fresh()
  const btn = doc.getElementById('pick-here')
  assert.ok(btn, '主要入口不能只藏在右鍵選單裡')
  assert.match(btn.textContent, /選取/)
  const list = doc.getElementById('task-list')
  assert.ok(btn.compareDocumentPosition(list) & 4, '按鈕要排在任務清單之前')
})

test('D1-2 按下去會請 background 在目前分頁進入選取模式', async () => {
  const { c, pp, doc } = await fresh()
  await pp.render()
  doc.getElementById('pick-here').click()
  await new Promise(r => setTimeout(r, 20))

  const msg = sent(c).find(m => m?.type === 'ENTER_PICK')
  assert.ok(msg, '要送出 ENTER_PICK')
  assert.equal(msg.purpose, 'task')
  assert.equal(msg.tabId, 7)
  assert.equal(msg.frameId, 0, '一律從最上層開始，往下鑽由選取模式自己處理')
})

test('D1-3 在 chrome:// 這種頁面上要說明不能選，而不是靜靜失敗', async () => {
  const { c, pp, doc } = await fresh('chrome://extensions')
  await pp.render()
  doc.getElementById('pick-here').click()
  await new Promise(r => setTimeout(r, 20))

  assert.equal(sent(c).find(m => m?.type === 'ENTER_PICK'), undefined, '不該送出')
  assert.match(doc.getElementById('pick-here-note').textContent, /無法選取/)
})

test('D2 版本號兩處一致且格式正確（不釘死數字：釘死只會每輪改測試，證明不了同步）', () => {
  assert.equal(MANIFEST.version, PKG.version, 'manifest 與 package.json 要同步')
  // 不寫死版本號：釘死的話每輪都要改測試，而且改了也證明不了「兩處一致」
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+$/, '版本號格式要正確')
})
