// AF-6 終檢補洞:前置動作的「在頁面上選取」要從最上層開始
// 要點的按鈕跟要抓的值常常不在同一層（值在 iframe 裡、按鈕是外層的頁籤）。
// 進到「任務目標那個 frame」的話，最上層的按鈕就永遠選不到——而且只能往下鑽、回不去。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, pk, doc: jd.window.document }
}

const enterPicks = (c) =>
  c.__calls.filter((x) => x.api === 'runtime.sendMessage' && x.args[0]?.type === 'ENTER_PICK').map((x) => x.args[0])

test('目標在 iframe 內時，前置動作的選取仍要從最上層開始', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, frameId: 7, frameUrl: 'https://b.example/w.html', locator: { css: '#v' } })
  doc.getElementById('preaction-add').click()
  doc.querySelector('[data-action="preaction-pick"]').click()
  const msg = enterPicks(c).at(-1)
  assert.equal(msg.purpose, 'preaction')
  assert.equal(
    msg.frameId, 0,
    '進到值所在的那個 frame 的話，外層的按鈕就選不到了（選取模式只能往下鑽，回不去）'
  )
})

test('目標在最上層時行為不變', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' } })
  doc.getElementById('preaction-add').click()
  doc.querySelector('[data-action="preaction-pick"]').click()
  assert.equal(enterPicks(c).at(-1).frameId, 0)
})
