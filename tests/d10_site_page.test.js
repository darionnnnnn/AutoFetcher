// AF-3 批次 D:站台登入設定視窗(右鍵「設定此站台登入」的去處)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const ORIGIN = 'https://a.test'

async function sitePage(search = `?origin=${encodeURIComponent(ORIGIN)}&tabId=9`) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const html = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'https://x/site.html' + search })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const sp = await import('../src/ui/site/site.js?t=' + Math.random())
  return { c, st, cr, sp, doc: jd.window.document, win: jd.window }
}

const sentMsgs = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])

test('三個欄位各有一個「在頁面上選取」按鈕,送出正確的 purpose', async () => {
  const { c, sp, doc } = await sitePage()
  await sp.render()
  for (const [field, purpose] of [['user', 'login-user'], ['pass', 'login-pass'], ['submit', 'login-submit']]) {
    const btn = doc.querySelector(`[data-action="pick-${field}"]`)
    assert.ok(btn, `缺少 ${field} 的選取按鈕`)
    btn.click()
    await new Promise(r => setTimeout(r, 20))
    const msg = sentMsgs(c).filter(m => m?.type === 'ENTER_PICK').pop()
    assert.equal(msg.purpose, purpose)
    assert.equal(msg.tabId, 9, '要在原本那個登入頁上選,不要另開分頁')
  }
})

test('收到選取結果後填進對應欄位', async () => {
  const { c, sp, doc } = await sitePage()
  await sp.render()
  const listener = [...c.runtime.onMessage._listeners][0]
  listener({ type: 'PICKED', purpose: 'login-pass', locator: { css: '#pwd', path: '', anchor: null, xpath: '' } }, {}, () => {})
  await new Promise(r => setTimeout(r, 20))
  const shown = doc.querySelector('[data-field="pass"]').textContent
  assert.ok(shown.includes('#pwd'), `要顯示選到的元素,實得:${shown}`)
})

test('取消的選取不得清掉已經選好的欄位', async () => {
  const { c, sp, doc } = await sitePage()
  await sp.render()
  const listener = [...c.runtime.onMessage._listeners][0]
  listener({ type: 'PICKED', purpose: 'login-user', locator: { css: '#u' } }, {}, () => {})
  listener({ type: 'PICKED', purpose: 'login-user', cancelled: true }, {}, () => {})
  await new Promise(r => setTimeout(r, 20))
  assert.ok(doc.querySelector('[data-field="user"]').textContent.includes('#u'))
})

test('存檔:密碼加密後才寫進 storage,明文不得留下', async () => {
  const { c, st, sp, doc } = await sitePage()
  await sp.render()
  const listener = [...c.runtime.onMessage._listeners][0]
  for (const [purpose, css] of [['login-user', '#u'], ['login-pass', '#p'], ['login-submit', '#go']]) {
    listener({ type: 'PICKED', purpose, locator: { css } }, {}, () => {})
  }
  doc.getElementById('username').value = 'wayne'
  doc.getElementById('password').value = 'hunter2'
  doc.getElementById('login-url').value = `${ORIGIN}/login`
  doc.getElementById('success-value').value = `${ORIGIN}/home`
  await sp.handleSave()

  const site = await st.getSite(ORIGIN)
  assert.ok(site, '要存得起來')
  assert.equal(site.username, 'wayne')
  assert.ok(site.passwordEnc?.ct, '密碼要以密文欄位存放')
  assert.ok(!JSON.stringify(site).includes('hunter2'), `不得有明文:${JSON.stringify(site)}`)
  assert.equal(site.selectors.user.css, '#u')
  assert.equal(site.selectors.submit.css, '#go')
  assert.equal(site.enabled, true)
  assert.equal(site.failStreak, 0)
})

test('三個欄位沒選完不得存檔,並顯示原因', async () => {
  const { st, sp, doc } = await sitePage()
  await sp.render()
  doc.getElementById('username').value = 'wayne'
  doc.getElementById('password').value = 'hunter2'
  await sp.handleSave()
  assert.equal(await st.getSite(ORIGIN), null, '選擇器不齊全的設定存了也不能用')
  assert.ok(doc.getElementById('site-note').textContent.length > 0, '要告訴使用者缺什麼')
})

test('編輯既有站台時帶出現況,密碼欄留空表示不變更', async () => {
  const { st, cr, sp, doc } = await sitePage()
  await st.saveSite(ORIGIN, {
    loginUrl: `${ORIGIN}/login`,
    selectors: { user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' } },
    loginCheck: { type: 'urlPrefix', value: `${ORIGIN}/login` },
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'wayne',
    passwordEnc: await cr.encryptSecret('old-pass'),
    enabled: true,
    failStreak: 0
  })
  await sp.render()
  assert.equal(doc.getElementById('username').value, 'wayne')
  assert.equal(doc.getElementById('password').value, '', '密碼不回填到畫面上')

  doc.getElementById('username').value = 'wayne2'
  await sp.handleSave()
  const site = await st.getSite(ORIGIN)
  assert.equal(site.username, 'wayne2')
  assert.equal(await cr.decryptSecret(site.passwordEnc), 'old-pass', '沒填新密碼就保留舊的')
})

test('頁面明白寫出密碼保護的限度', () => {
  const html = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
  assert.ok(/誤讀|不防/.test(html), '輸入密碼的地方就要說清楚保護到什麼程度')
})

test('站台設定頁不得出現色碼字面值', () => {
  const html = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
  assert.deepEqual(html.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [])
  assert.ok(html.includes('theme.css'))
})

test('background 收到 login-* 的選取結果會轉發給設定視窗', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  await bg.handleMessage(
    { type: 'PICKED', purpose: 'login-user', locator: { css: '#u' } },
    { tab: { id: 9, url: `${ORIGIN}/login` } }
  )
  const forwarded = sentMsgs(c).filter(m => m?.type === 'PICKED' && m.purpose === 'login-user')
  assert.equal(forwarded.length, 1, '設定視窗是另一個頁面,要靠 runtime 訊息轉發')
})

test('右鍵「設定此站台登入」會開設定視窗並帶上 origin 與分頁', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: `${ORIGIN}/login` })
  await bg.handleContextMenu({ menuItemId: 'af-site-login' }, tab)
  const win = c.__calls.find(x => x.api === 'windows.create')
  assert.ok(win, '要開站台設定視窗')
  const url = String(win.args[0].url)
  assert.match(url, /site\.html/)
  assert.ok(url.includes(encodeURIComponent(ORIGIN)), `要帶上 origin,實得 ${url}`)
  assert.ok(url.includes(`tabId=${tab.id}`), `要帶上分頁 id,實得 ${url}`)
})
