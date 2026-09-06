// AF-3 批次 D:自動登入流程(SPEC §6)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, cr, fe }
}

const ORIGIN = 'https://a.test'

async function saveSite(st, cr, over = {}) {
  const site = {
    loginUrl: `${ORIGIN}/login`,
    selectors: {
      user: { css: '#u', path: '', anchor: null, xpath: '' },
      pass: { css: '#p', path: '', anchor: null, xpath: '' },
      submit: { css: '#go', path: '', anchor: null, xpath: '' }
    },
    loginCheck: { type: 'urlPrefix', value: `${ORIGIN}/login` },
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'wayne',
    passwordEnc: await cr.encryptSecret('hunter2'),
    enabled: true,
    failStreak: 0,
    ...over
  }
  await st.saveSite(ORIGIN, site)
  return site
}

const task = (over = {}) => ({
  id: 't1', name: '電費', url: `${ORIGIN}/p`, mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const sent = (c, type) => c.__calls
  .filter(x => x.api === 'tabs.sendMessage')
  .map(x => x.args[1])
  .filter(m => m?.type === type)

// 讓分頁在被「導向」時換 URL：模擬登入成功後轉址
function respondLogin(c, { afterLoginUrl } = {}) {
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'FILL_LOGIN') {
      if (afterLoginUrl) c.__setTabState(tabId, { url: afterLoginUrl, status: 'complete' })
      return { ok: true }
    }
    return { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
  })
}

// ---- 判定是否需要登入 ----

test('分頁沒有停在登入頁時,完全不做登入', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr)
  await st.saveTask(task())
  respondLogin(c)
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(sent(c, 'FILL_LOGIN').length, 0)
})

test('用分頁被轉址後的實際網址判定,不是任務設定的網址', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr)
  await st.saveTask(task())
  respondLogin(c, { afterLoginUrl: `${ORIGIN}/home` })
  // 任務網址是 /p，但分頁被導到 /login（沒登入時常見）
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(sent(c, 'FILL_LOGIN').length, 1, '被導到登入頁就要自動登入')
})

test('沒有站台設定時不嘗試登入', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: true, value: 1, raw: '1', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(sent(c, 'FILL_LOGIN').length, 0)
  assert.equal(rec.status, 'ok', '沒設定登入就照常擷取')
})

// ---- 登入流程 ----

test('登入時把帳號與解密後的密碼送給 content,storage 內仍是密文', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr)
  await st.saveTask(task())
  respondLogin(c, { afterLoginUrl: `${ORIGIN}/home` })
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })

  const msg = sent(c, 'FILL_LOGIN')[0]
  assert.equal(msg.username, 'wayne')
  assert.equal(msg.password, 'hunter2', '要送明文給 content 才填得進去')
  const stored = JSON.stringify(await st.getSite(ORIGIN))
  assert.ok(!stored.includes('hunter2'), `storage 內不得有明文密碼:${stored}`)
})

test('登入成功後 failStreak 歸零並照常擷取', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr, { failStreak: 2 })
  await st.saveTask(task())
  respondLogin(c, { afterLoginUrl: `${ORIGIN}/home` })
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.equal((await st.getSite(ORIGIN)).failStreak, 0)
})

test('登入後仍停在登入頁 → 紀錄 login_failed,不重試', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr)
  await st.saveTask(task())
  respondLogin(c)
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.status, 'login_failed')
  assert.equal(rec.value, undefined, '登入失敗沒有值')
  const alarms = await c.alarms.getAll()
  assert.equal(alarms.filter(a => a.name.includes('retry')).length, 0, '登入失敗不重試')
})

test('login_failed 不算成功狀態', async () => {
  const { isSuccess } = await import('../src/shared/record-status.js?t=' + Math.random())
  assert.equal(isSuccess({ status: 'login_failed' }), false)
})

test('連續 3 次登入失敗後停用該站台並通知一次', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr)
  await st.saveTask(task())
  respondLogin(c)
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })

  for (const slot of ['2026-09-06T09:00', '2026-09-06T10:00', '2026-09-06T11:00']) {
    await fe.runTask(task(), { slot, ...FAST })
  }
  const site = await st.getSite(ORIGIN)
  assert.equal(site.failStreak, 3)
  assert.equal(site.enabled, false, '連三次失敗要停用,避免一直用錯密碼嘗試')
  assert.equal(c.__calls.filter(x => x.api === 'notifications.create').length, 1, '只通知一次')
})

test('站台被停用後不再嘗試登入,直接記 login_failed', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr, { enabled: false, failStreak: 3 })
  await st.saveTask(task())
  respondLogin(c)
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(sent(c, 'FILL_LOGIN').length, 0)
  assert.equal(rec.status, 'login_failed')
})

test('content 說找不到欄位時當登入失敗,不當成功', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr)
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'FILL_LOGIN') return { ok: false, missing: 'pass' }
    return { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
  })
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.status, 'login_failed')
  assert.equal((await st.getSite(ORIGIN)).failStreak, 1)
})

test('成功判定用「某元素存在」時也要能過', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr, {
    successCheck: { type: 'element', value: '#logout' },
    loginCheck: { type: 'urlPrefix', value: `${ORIGIN}/login` }
  })
  await st.saveTask(task())
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'FILL_LOGIN') return { ok: true }
    if (msg.type === 'CHECK_ELEMENT') return { ok: true, found: true }
    return { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
  })
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  const rec = await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
})

test('演練(dryRun)也會走登入流程,但不寫紀錄', async () => {
  const { c, st, cr, fe } = await fresh()
  await saveSite(st, cr)
  await st.saveTask(task())
  respondLogin(c, { afterLoginUrl: `${ORIGIN}/home` })
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  await fe.runTask(task(), { slot: 'precheck', dryRun: true, ...FAST })
  assert.equal(sent(c, 'FILL_LOGIN').length, 1, '預檢就是要提早發現登不進去')
  assert.equal((await st.getRecordsByDate('2026-09-06')).length, 0)
})
