// AF-21 批次 4 段 C：站台登入設定——判定值必填與一鍵帶入、測試登入、存檔重置失敗狀態
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const ORIGIN = 'https://a.test'
const LOGIN = `${ORIGIN}/login`
const OPTS = { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0, checkTimeoutMs: 200, fillTimeoutMs: 200 }
const SECRET = 'Pw-TEST-7f3c9e-secret'
const SELECTORS = { user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' } }

const callsOf = (c, api) => c.__calls.filter(x => x.api === api)
const sentToTab = (c, type) => callsOf(c, 'tabs.sendMessage').map(x => x.args[1]).filter(m => m?.type === type)
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

async function storedSite(st, cr, over = {}) {
  const site = {
    loginUrl: LOGIN,
    selectors: SELECTORS,
    loginCheck: { type: 'urlPrefix', value: LOGIN },
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'wayne',
    passwordEnc: await cr.encryptSecret('stored-pass'),
    enabled: true,
    failStreak: 0,
    ...over
  }
  await st.saveSite(ORIGIN, site)
  return site
}

// tabUrl：先建一個面板所屬的分頁（網址＝轉址後的實際位置），面板服務的就是它
async function sitePage({ tabUrl } = {}) {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const tabId = tabUrl ? (await c.tabs.create({ url: tabUrl })).id : 9
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const html = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: `https://x/site.html?origin=${encodeURIComponent(ORIGIN)}&tabId=${tabId}` })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const sp = await import('../src/ui/site/site.js?t=' + Math.random())
  return { c, st, cr, sp, doc: jd.window.document }
}

function pickAll(c) {
  const listener = [...c.runtime.onMessage._listeners][0]
  for (const [purpose, css] of [['login-user', '#u'], ['login-pass', '#p'], ['login-submit', '#go']]) {
    listener({ type: 'PICKED', purpose, locator: { css } }, {}, () => {})
  }
}

function fill(doc, { loginUrl = LOGIN, password = 'hunter2', successValue = `${ORIGIN}/home`, successType = 'urlPrefix' } = {}) {
  doc.getElementById('username').value = 'wayne'
  doc.getElementById('password').value = password
  doc.getElementById('login-url').value = loginUrl
  doc.getElementById('success-type').value = successType
  doc.getElementById('success-value').value = successValue
}

const snapshot = async () => JSON.stringify(await chrome.storage.local.get(null))
const reasonTexts = (doc) => [...doc.querySelectorAll('#site-errors [data-reason]')].map(b => b.textContent)

// ---------- 驗收 1：判定值必填、與登入頁互為前綴不可存 ----------

test('1a 判定值空白 → 零寫入、原因可點並跳到判定值欄', async () => {
  const { c, sp, doc } = await sitePage()
  await sp.render()
  pickAll(c)
  fill(doc, { successValue: '' })
  const before = await snapshot()
  await sp.handleSave({ closeDelayMs: 0 })
  assert.equal(await snapshot(), before, '判定值空白時不得寫入')
  const box = doc.getElementById('site-errors')
  assert.equal(box.hidden, false, '原因區要展開')
  assert.equal(box.getAttribute('role'), 'alert')
  const btn = box.querySelector('[data-reason="success-value"]')
  assert.ok(btn, `要有判定值的原因，實得 ${JSON.stringify(reasonTexts(doc))}`)
  doc.getElementById('username').focus()
  btn.click()
  assert.equal(doc.activeElement?.id, 'success-value', '點了原因要跳到判定值欄')
  assert.equal(doc.getElementById('site-save').disabled, false, '儲存鈕不 disabled')
})

test('1b 原因區放在捲動區外、固定列正上方，空的時候 hidden', async () => {
  const { sp, doc } = await sitePage()
  await sp.render()
  const box = doc.getElementById('site-errors')
  assert.equal(box.hidden, true, '沒有原因時不佔版面')
  assert.ok(!box.closest('.settings-body'), '不得在捲動區內')
  assert.equal(box.nextElementSibling?.tagName, 'FOOTER', '要緊貼在固定列正上方')
})

test('1c 判定值＝登入頁網址 → 零寫入、原因正確', async () => {
  const { c, sp, doc } = await sitePage()
  await sp.render()
  pickAll(c)
  fill(doc, { successValue: LOGIN })
  const before = await snapshot()
  await sp.handleSave({ closeDelayMs: 0 })
  assert.equal(await snapshot(), before)
  assert.ok(reasonTexts(doc).some(t => t.includes('成功判定值不能是登入頁的網址')), JSON.stringify(reasonTexts(doc)))
})

test('1d 登入頁網址以判定值開頭（判定值較短）→ 零寫入、原因正確', async () => {
  const { c, sp, doc } = await sitePage()
  await sp.render()
  pickAll(c)
  fill(doc, { successValue: `${ORIGIN}/log` })
  const before = await snapshot()
  await sp.handleSave({ closeDelayMs: 0 })
  assert.equal(await snapshot(), before)
  assert.ok(reasonTexts(doc).some(t => t.includes('成功判定值不能是登入頁的網址')))
})

test('1e 判定值以登入頁網址開頭（判定值較長）也擋；型別是元素存在時不比網址', async () => {
  const { c, st, sp, doc } = await sitePage()
  await sp.render()
  pickAll(c)
  fill(doc, { successValue: `${LOGIN}/done` })
  const before = await snapshot()
  await sp.handleSave({ closeDelayMs: 0 })
  assert.equal(await snapshot(), before, '互為前綴：判定值以登入頁開頭同樣在登入頁上就成立')

  fill(doc, { successType: 'element', successValue: LOGIN })
  await sp.handleSave({ closeDelayMs: 0 })
  assert.ok(await st.getSite(ORIGIN), '元素存在的判定值不是網址，不做前綴比對')
})

test('1f 合法值 → 存檔成功、原因區收起', async () => {
  const { c, st, sp, doc } = await sitePage()
  await sp.render()
  pickAll(c)
  fill(doc, { successValue: '' })
  await sp.handleSave({ closeDelayMs: 0 })
  assert.equal(doc.getElementById('site-errors').hidden, false, '前置：先被擋一次')
  doc.getElementById('success-value').value = `${ORIGIN}/home`
  await sp.handleSave({ closeDelayMs: 0 })
  const site = await st.getSite(ORIGIN)
  assert.equal(site?.successCheck?.value, `${ORIGIN}/home`)
  assert.equal(doc.getElementById('site-errors').hidden, true)
})

test('1g 缺選擇器、缺密碼都成為可點的原因；選擇器那條跳到該列的「在頁面上選取」鈕', async () => {
  const { sp, doc } = await sitePage()
  await sp.render()
  fill(doc, { password: '' })
  await sp.handleSave({ closeDelayMs: 0 })
  const ids = [...doc.querySelectorAll('#site-errors [data-reason]')].map(b => b.dataset.reason)
  for (const id of ['selector-user', 'selector-pass', 'selector-submit', 'password']) {
    assert.ok(ids.includes(id), `缺 ${id}，實得 ${JSON.stringify(ids)}`)
  }
  doc.querySelector('#site-errors [data-reason="selector-pass"]').click()
  assert.equal(doc.activeElement?.getAttribute('data-action'), 'pick-pass')
  doc.querySelector('#site-errors [data-reason="password"]').click()
  assert.equal(doc.activeElement?.id, 'password')
})

// ---------- 驗收 2：一鍵帶入 ----------

test('2 一鍵帶入：讀分頁的實際網址（不是設定裡的網址）→ origin＋路徑、型別切成網址開頭', async () => {
  const { c, st, cr, sp, doc } = await sitePage({ tabUrl: 'https://a.test/home?x=1' })
  await storedSite(st, cr, { successCheck: { type: 'element', value: '#me' } })
  await sp.render()
  assert.equal(doc.getElementById('success-type').value, 'element', '前置：原本是元素存在')
  doc.getElementById('use-current-url').click()
  await tick()
  assert.equal(doc.getElementById('success-value').value, 'https://a.test/home')
  assert.equal(doc.getElementById('success-type').value, 'urlPrefix')
  assert.ok(callsOf(c, 'tabs.get').length > 0, '要讀 chrome.tabs.get(tabId).url')
})

test('2b 一鍵帶入得到登入頁網址 → 照樣填入，守門擋下並說明；欄位旁有提示', async () => {
  const { c, sp, doc } = await sitePage({ tabUrl: `${LOGIN}?next=/home` })
  await sp.render()
  pickAll(c)
  fill(doc, { successValue: '' })
  doc.getElementById('use-current-url').click()
  await tick()
  assert.equal(doc.getElementById('success-value').value, LOGIN, '照樣填入')
  const before = await snapshot()
  await sp.handleSave({ closeDelayMs: 0 })
  assert.equal(await snapshot(), before)
  assert.ok(reasonTexts(doc).some(t => t.includes('成功判定值不能是登入頁的網址')))
  assert.match(doc.body.textContent, /登入後在這一頁按這顆/)
})

// ---------- 驗收 3～5：測試登入（背景） ----------

async function freshBg({ settings } = {}) {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  if (settings) await st.saveSettings(settings)
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, cr, bg }
}

const testMsg = (over = {}) => ({
  type: 'TEST_LOGIN',
  site: {
    loginUrl: LOGIN,
    selectors: SELECTORS,
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'wayne'
  },
  password: SECRET,
  ...over
})

// 模擬站台：FILL_LOGIN 之後把分頁導到 afterUrl（undefined＝頁面不動）
function respond(c, { fill = { ok: true }, afterUrl } = {}) {
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'FILL_LOGIN') {
      if (afterUrl && fill.ok) c.__setTabState(tabId, { url: afterUrl, status: 'complete' })
      return fill
    }
    return { ok: true, found: false }
  })
}

test('3a 全部成功 → ok，四步都打勾', async () => {
  const { c, bg } = await freshBg()
  respond(c, { afterUrl: `${ORIGIN}/home` })
  const res = await bg.handleMessage(testMsg(), {}, OPTS)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(res.steps.map(s => [s.step, s.ok]), [['open', true], ['fields', true], ['submit', true], ['verify', true]])
  assert.equal(sentToTab(c, 'FILL_LOGIN')[0].password, SECRET, '明文密碼要送到 content 填表')
})

test('3b 四步各自失敗的回報文字不同，失敗的那一步正確', async () => {
  const cases = {}

  { // 開不了頁
    const { c, bg } = await freshBg()
    // mock 是跨測試共用的同一個物件：換掉的方法一定要換回來
    const origCreate = c.tabs.create
    c.__windowCreateHook = () => { throw new Error('boom-window') }
    c.tabs.create = async () => { throw new Error('boom-tab') }
    respond(c)
    try {
      cases.open = await bg.handleMessage(testMsg(), {}, OPTS)
    } finally {
      c.tabs.create = origCreate
      c.__windowCreateHook = null
    }
  }
  { // 找不到欄位
    const { c, bg } = await freshBg()
    respond(c, { fill: { ok: false, missing: 'pass' } })
    cases.fields = await bg.handleMessage(testMsg(), {}, OPTS)
  }
  { // 送出後頁面沒變
    const { c, bg } = await freshBg()
    respond(c)
    cases.submit = await bg.handleMessage(testMsg(), {}, OPTS)
  }
  { // 判定不成立（換頁了，但不是判定值那一頁）
    const { c, bg } = await freshBg()
    respond(c, { afterUrl: `${ORIGIN}/error` })
    cases.verify = await bg.handleMessage(testMsg(), {}, OPTS)
  }

  const details = []
  for (const [step, res] of Object.entries(cases)) {
    assert.equal(res.ok, false, `${step}：${JSON.stringify(res)}`)
    assert.notEqual(res.alreadyLoggedIn, true)
    const failed = res.steps.filter(s => s.ok === false)
    assert.equal(failed.length, 1, `${step} 只能有一步失敗：${JSON.stringify(res.steps)}`)
    assert.equal(failed[0].step, step, `${step} 失敗的步驟不對：${JSON.stringify(res.steps)}`)
    assert.ok(failed[0].detail, `${step} 要有白話原因`)
    assert.equal(res.steps.at(-1).step, step, '失敗之後的步驟不再往下走')
    details.push(failed[0].detail)
  }
  assert.equal(new Set(details).size, 4, `四步的回報文字要不同：${JSON.stringify(details)}`)
  assert.match(cases.fields.steps.at(-1).detail, /密碼欄位/, '要說出是哪個欄位找不到')
})

test('3c 開啟後不在登入頁（已登入）→ alreadyLoggedIn、不填表、不回報成功', async () => {
  const { c, bg } = await freshBg()
  respond(c, { afterUrl: `${ORIGIN}/home` })
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/home`, status: 'complete' })
  const res = await bg.handleMessage(testMsg(), {}, OPTS)
  assert.equal(res.ok, false, '已登入狀態不得回報成功')
  assert.equal(res.alreadyLoggedIn, true)
  assert.equal(sentToTab(c, 'FILL_LOGIN').length, 0, '不得填表')
})

test('3d 面板：已登入狀態顯示「已經是登入狀態」，不顯示成功', async () => {
  const { c, sp, doc } = await sitePage()
  c.__setRuntimeResponder((msg) => msg?.type === 'TEST_LOGIN'
    ? { ok: false, alreadyLoggedIn: true, steps: [{ step: 'open', ok: true, detail: '開啟後停在首頁' }] }
    : undefined)
  await sp.render()
  pickAll(c)
  fill(doc)
  await sp.handleTestLogin()
  const result = doc.getElementById('test-login-result')
  assert.equal(result.hidden, false)
  assert.match(result.textContent, /目前已經是登入狀態，無法驗證帳密；請先在該站登出再測/)
  assert.doesNotMatch(result.textContent, /登入成功/)
  assert.notEqual(result.dataset.ok, 'true')
})

test('3e 面板：四步結果就地顯示（✓／✗＋原因），成功時說成功', async () => {
  const { c, sp, doc } = await sitePage()
  const steps = [
    { step: 'open', ok: true, detail: '已開啟登入頁' },
    { step: 'fields', ok: true, detail: '找到' },
    { step: 'submit', ok: false, detail: '頁面沒有變化' }
  ]
  let reply = { ok: false, steps }
  c.__setRuntimeResponder((msg) => msg?.type === 'TEST_LOGIN' ? reply : undefined)
  await sp.render()
  pickAll(c)
  fill(doc)
  await sp.handleTestLogin()
  const lis = [...doc.querySelectorAll('#test-login-steps li')]
  const items = lis.map(li => (li.querySelector('svg')?.getAttribute('aria-label') || '') + li.textContent)
  assert.equal(items.length, 3)
  assert.match(items[0], /^成功/)
  assert.match(items[2], /^失敗.*頁面沒有變化/)
  assert.doesNotMatch(doc.getElementById('test-login-result').textContent, /登入成功/)

  reply = { ok: true, steps: [...steps.slice(0, 2), { step: 'submit', ok: true, detail: '' }, { step: 'verify', ok: true, detail: '' }] }
  await sp.handleTestLogin()
  assert.match(doc.getElementById('test-login-result').textContent, /登入成功/)
})

test('3f 面板：sendMessage 被拒絕或回 ok:false 沒有 steps 都要有字；測試中防連按', async () => {
  const { c, sp, doc } = await sitePage()
  let release
  const gate = new Promise(r => { release = r })
  let calls = 0
  c.__setRuntimeResponder(async (msg) => {
    if (msg?.type !== 'TEST_LOGIN') return undefined
    calls++
    await gate
    throw new Error('Receiving end does not exist')
  })
  await sp.render()
  pickAll(c)
  fill(doc)
  const p = sp.handleTestLogin()
  await tick()
  const btn = doc.getElementById('site-test-login')
  assert.match(btn.textContent, /測試中/, '測試中要顯示進行狀態')
  btn.click()
  await sp.handleTestLogin()
  assert.equal(calls, 1, '測試中再按不得再送一次')
  release()
  await p
  assert.match(doc.getElementById('test-login-result').textContent, /測試沒有完成.*Receiving end/)
  assert.doesNotMatch(btn.textContent, /測試中/)

  c.__setRuntimeResponder((msg) => msg?.type === 'TEST_LOGIN' ? { ok: false, error: '登入頁網址不是合法的網址' } : undefined)
  await sp.handleTestLogin()
  assert.match(doc.getElementById('test-login-result').textContent, /登入頁網址不是合法的網址/)
})

test('3g 面板送出的是尚未儲存的表單內容；密碼欄留空且有已存密文 → useSaved', async () => {
  const { c, st, cr, sp, doc } = await sitePage()
  await storedSite(st, cr)
  const got = []
  c.__setRuntimeResponder((msg) => { if (msg?.type === 'TEST_LOGIN') got.push(msg); return msg?.type === 'TEST_LOGIN' ? { ok: false, steps: [] } : undefined })
  await sp.render()
  doc.getElementById('login-url').value = `${ORIGIN}/signin`
  doc.getElementById('success-value').value = `${ORIGIN}/dash`
  await sp.handleTestLogin()
  assert.equal(got.length, 1)
  assert.equal(got[0].site.loginUrl, `${ORIGIN}/signin`)
  assert.deepEqual(got[0].site.successCheck, { type: 'urlPrefix', value: `${ORIGIN}/dash` })
  assert.equal(got[0].site.selectors.user.css, '#u')
  assert.equal(got[0].useSaved, true)
  assert.equal(got[0].password, undefined, '沒填就不送密碼欄')

  doc.getElementById('password').value = SECRET
  await sp.handleTestLogin()
  assert.equal(got[1].password, SECRET)
  assert.equal(got[1].useSaved, undefined)
  assert.match(doc.body.textContent, /只在這台電腦上測試，不會儲存/)
})

test('3h useSaved：背景解密已存密文來填表', async () => {
  const { c, st, cr, bg } = await freshBg()
  await storedSite(st, cr)
  respond(c, { afterUrl: `${ORIGIN}/home` })
  const res = await bg.handleMessage(testMsg({ password: undefined, useSaved: true }), {}, OPTS)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(sentToTab(c, 'FILL_LOGIN')[0].password, 'stored-pass')
})

test('3i TEST_LOGIN 不在 content script 可送的清單，網頁送來會被擋', async () => {
  const { CONTENT_ALLOWED, MSG } = await import('../src/shared/messages.js')
  assert.equal(MSG.TEST_LOGIN, 'TEST_LOGIN')
  assert.equal(CONTENT_ALLOWED.has(MSG.TEST_LOGIN), false)
  const { c, bg } = await freshBg()
  respond(c, { afterUrl: `${ORIGIN}/home` })
  const res = await bg.handleMessage(testMsg(), { tab: { id: 3, url: `${ORIGIN}/p` }, url: `${ORIGIN}/p` }, OPTS)
  assert.equal(res.error, 'forbidden')
  assert.equal(sentToTab(c, 'FILL_LOGIN').length, 0)
})

test('4 測試登入全程（面板→背景）：storage.local／session 找不到密碼、failStreak 不變、沒有通知', async () => {
  for (const scenario of ['fail', 'ok']) {
    const { c, st, cr, sp, doc } = await sitePage()
    const bg = await import('../src/background/main.js?t=' + Math.random())
    await storedSite(st, cr, { failStreak: 2 })
    // 登記一個面板 ctx，確認測試不會把密碼帶進去
    await st.setPanelCtx(9, { kind: 'site', origin: ORIGIN, tabId: 9 })
    c.__setRuntimeResponder((msg) => msg?.type === 'TEST_LOGIN' ? bg.handleMessage(msg, {}, OPTS) : undefined)
    respond(c, scenario === 'ok' ? { afterUrl: `${ORIGIN}/home` } : {})
    await sp.render()
    doc.getElementById('password').value = SECRET
    await sp.handleTestLogin()
    assert.ok(sentToTab(c, 'FILL_LOGIN').length === 1, `${scenario}：前置：真的走到填表`)
    assert.equal(sentToTab(c, 'FILL_LOGIN')[0].password, SECRET, '前置：密碼有送到')
    assert.notEqual(doc.getElementById('test-login-result').textContent, '', '前置：面板有結果')
    await tick()

    const local = JSON.stringify(await chrome.storage.local.get(null))
    const session = JSON.stringify(await chrome.storage.session.get(null))
    assert.ok(local.length > 2 && session.length > 2, '前置：兩個 storage 都有東西')
    assert.ok(!local.includes(SECRET), `${scenario}：storage.local 不得出現密碼`)
    assert.ok(!session.includes(SECRET), `${scenario}：storage.session 不得出現密碼`)
    assert.equal((await st.getSite(ORIGIN)).failStreak, 2, `${scenario}：failStreak 不變`)
    assert.equal((await st.getSite(ORIGIN)).enabled, true)
    assert.equal(callsOf(c, 'notifications.create').length, 0, `${scenario}：不得通知`)
  }
})

test('4b 測試登入連續失敗 3 次也不停用、不通知', async () => {
  const { c, st, cr, bg } = await freshBg()
  await storedSite(st, cr, { failStreak: 2 })
  respond(c)
  for (let i = 0; i < 3; i++) {
    const res = await bg.handleMessage(testMsg(), {}, OPTS)
    assert.equal(res.ok, false)
  }
  const site = await st.getSite(ORIGIN)
  assert.equal(site.failStreak, 2)
  assert.equal(site.enabled, true)
  assert.equal(callsOf(c, 'notifications.create').length, 0)
})

test('5 測試登入走 enqueueForOrigin：同站台抓取還沒結束就不動頁面；結束後分頁被釋放', async () => {
  const { c, bg } = await freshBg({ settings: { fetchTabMode: 'window' } })
  const ft = await import('../src/background/fetch-tab.js')
  respond(c, { afterUrl: `${ORIGIN}/home` })
  let release
  const gate = new Promise(r => { release = r })
  const busy = ft.enqueueForOrigin(ORIGIN, () => gate)
  const p = bg.handleMessage(testMsg(), {}, OPTS)
  await tick(40)
  assert.equal(callsOf(c, 'windows.create').length + callsOf(c, 'tabs.create').length, 0, '排在同站台抓取後面，不得先開頁')
  assert.equal(sentToTab(c, 'FILL_LOGIN').length, 0)
  release()
  await busy
  const res = await p
  assert.equal(res.ok, true, JSON.stringify(res))
  const created = callsOf(c, 'windows.create')
  assert.equal(created.length, 1)
  assert.equal(created[0].args[0].url, LOGIN, '開的是登入頁')
  await tick(20)
  assert.equal(callsOf(c, 'windows.remove').length, 1, '佇列清空後要釋放抓取頁面')
  const reg = (await chrome.storage.session.get('fetchTabs')).fetchTabs || []
  assert.deepEqual(reg, [], '登記表要清空')
})

// ---------- 驗收 6：存站台重置失敗狀態 ----------

test('6 儲存站台後 failStreak 0、enabled true、site:<origin> 健康項目不存在、請 background 重整燈號', async () => {
  const { c, st, cr, sp, doc } = await sitePage()
  await storedSite(st, cr, { failStreak: 3, enabled: false })
  await chrome.storage.local.set({ health: { [`site:${ORIGIN}`]: { status: 'login_failed', reason: '無法登入' }, t1: { status: 'ok' } } })
  await sp.render()
  doc.getElementById('password').value = 'new-pass'
  await sp.handleSave({ closeDelayMs: 0 })
  const site = await st.getSite(ORIGIN)
  assert.equal(site.failStreak, 0)
  assert.equal(site.enabled, true)
  const health = (await chrome.storage.local.get('health')).health || {}
  assert.equal(`site:${ORIGIN}` in health, false, '紅燈項目要刪掉')
  assert.equal(health.t1?.status, 'ok', '別的健康項目不動')
  assert.ok(callsOf(c, 'runtime.sendMessage').some(x => x.args[0]?.type === 'REBUILD_ALARMS'), '存完要請 background 重整燈號')
})

// ---------- 驗收 7：自動登入的失敗計數仍在 ensureLoggedIn 那一層 ----------

test('7 ensureLoggedIn 改呼叫 attemptLogin：失敗計數、停用、通知只在 ensureLoggedIn', () => {
  const src = readFileSync(new URL('../src/background/login.js', import.meta.url), 'utf8')
  const attempt = src.slice(src.indexOf('export async function attemptLogin'), src.indexOf('export async function ensureLoggedIn'))
  assert.ok(attempt.length > 100, '前置：切得到 attemptLogin')
  assert.doesNotMatch(attempt, /recordLoginFailure|notify\(|saveSite\(/, 'attemptLogin 不得碰失敗計數與通知')
  const ensure = src.slice(src.indexOf('export async function ensureLoggedIn'))
  assert.match(ensure, /attemptLogin\(/)
})
