// AF-24 B7：站台面板只收自己分頁的選取；存檔保留表單管不到的既有欄位
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const ORIGIN = 'https://a.test'

async function sitePage(tabId = 9) {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: `https://x/site.html?origin=${encodeURIComponent(ORIGIN)}&tabId=${tabId}` })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const sp = await import('../src/ui/site/site.js?t=' + Math.random())
  return { c, st, sp, doc: jd.window.document }
}

const listenerOf = c => [...c.runtime.onMessage._listeners][0]

test('另一個分頁的選取（直接送或背景轉發）不得改到這個面板的選擇器', async () => {
  const { c, sp, doc } = await sitePage(9)
  await sp.render()
  const listener = listenerOf(c)
  listener({ type: 'PICKED', purpose: 'login-user', locator: { css: '#other-direct' } }, { tab: { id: 12 } }, () => {})
  listener({ type: 'PICKED', purpose: 'login-user', locator: { css: '#other-forward' }, sourceTabId: 12 }, {}, () => {})
  listener({ type: 'PICKED', purpose: 'login-pass', locator: { css: '#no-tab' } }, {}, () => {})
  await new Promise(r => setTimeout(r, 10))
  assert.equal(doc.querySelector('[data-field="user"]').textContent.includes('#other'), false)
  assert.equal(doc.querySelector('[data-field="pass"]').textContent.includes('#no-tab'), false, '說不出來源分頁的一律不收')
  listener({ type: 'PICKED', purpose: 'login-user', locator: { css: '#mine' }, sourceTabId: 9 }, {}, () => {})
  await new Promise(r => setTimeout(r, 10))
  assert.ok(doc.querySelector('[data-field="user"]').textContent.includes('#mine'))
})

test('背景轉發 login-* 選取時帶上來源分頁 id', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  await bg.handleMessage({ type: 'PICKED', purpose: 'login-user', locator: { css: '#u' } }, { tab: { id: 9, url: `${ORIGIN}/login` } })
  const fwd = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).filter(m => m?.purpose === 'login-user')
  assert.equal(fwd.length, 1)
  assert.equal(fwd[0].sourceTabId, 9)
})

test('匯入帶自訂 loginCheck 與額外欄位的站台：編輯存檔後仍保留', async () => {
  const { c, st, sp, doc } = await sitePage(9)
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  await st.saveSite(ORIGIN, {
    loginUrl: `${ORIGIN}/login`,
    selectors: { user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' } },
    loginCheck: { type: 'selector', value: '#login-form' },
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'old', passwordEnc: await cr.encryptSecret('pw'), enabled: false, failStreak: 3,
    note: '匯入檔帶來的欄位'
  })
  await sp.render()
  doc.getElementById('username').value = 'new-user'
  await sp.handleSave({ closeDelayMs: 0 })
  const site = await st.getSite(ORIGIN)
  assert.equal(site.username, 'new-user', doc.getElementById('site-errors')?.textContent || '')
  assert.deepEqual(site.loginCheck, { type: 'selector', value: '#login-form' })
  assert.equal(site.note, '匯入檔帶來的欄位')
  assert.equal(site.enabled, true, '存檔就重新啟用')
  assert.equal(site.failStreak, 0)
})
