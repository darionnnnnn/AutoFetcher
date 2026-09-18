// AF-20 作業 A3:每日站台檢查改經抓取分頁入口,並進同站台佇列(與抓取互斥)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const ORIGIN = 'https://a.test'
const OPTS = { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  return { c, st, cr }
}

async function site(st, cr, origin = ORIGIN) {
  await st.saveSite(origin, {
    loginUrl: `${origin}/login`,
    selectors: { user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' } },
    loginCheck: { type: 'urlPrefix', value: `${origin}/login` },
    successCheck: { type: 'urlPrefix', value: `${origin}/home` },
    username: 'wayne',
    passwordEnc: await cr.encryptSecret('hunter2'),
    enabled: true,
    failStreak: 0
  })
}

const callsOf = (c, api) => c.__calls.filter(x => x.api === api)
const opened = (c, url) => [
  ...callsOf(c, 'windows.create').filter(x => x.args[0]?.url === url),
  ...callsOf(c, 'tabs.create').filter(x => x.args[0]?.url === url),
  ...callsOf(c, 'tabs.update').filter(x => x.args[1]?.url === url)
]

test('站台檢查在專用視窗開登入頁,檢查完關掉整個視窗', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr)
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true }))
  // 已登入:打開登入頁會被轉到首頁
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/home`, status: 'complete' })
  await sc.runSiteCheck(OPTS)
  assert.equal(callsOf(c, 'windows.create').length, 1)
  assert.equal(callsOf(c, 'windows.create')[0].args[0].url, `${ORIGIN}/login`)
  assert.equal(callsOf(c, 'tabs.create').length, 0, '不在使用者的視窗開分頁')
  assert.equal(callsOf(c, 'windows.remove').length, 1)
  assert.equal((await st.getHealthMap())[`site:${ORIGIN}`]?.status, 'ok')
})

test('兩個站台各自一個視窗,各自關掉', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr, 'https://a.test')
  await site(st, cr, 'https://b.test')
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true }))
  await sc.runSiteCheck(OPTS)
  assert.equal(callsOf(c, 'windows.create').length, 2)
  assert.equal(callsOf(c, 'windows.remove').length, 2)
})

test('與同站台的抓取互斥:抓取還沒結束,站台檢查不得開始動那個站台', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr)
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  let open
  const gate = new Promise((r) => { open = r })
  c.__setTabResponder(async (tabId, msg) => {
    if (msg.type === 'EXTRACT') {
      await gate
      return { ok: true, value: 1, raw: '1', status: 'ok', strategyUsed: 'auto', layer: 'css' }
    }
    return { ok: true }
  })
  const t = {
    id: 't1', name: '總量', url: `${ORIGIN}/p`, mode: 'number', enabled: true,
    locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  }
  await st.saveTask(t)
  const fetching = fe.runTask(t, { slot: '2026-09-05T09:00', ...OPTS, extractTimeoutMs: 5000 })
  // 等抓取卡在擷取那一步
  for (let i = 0; i < 200 && !callsOf(c, 'tabs.sendMessage').some(x => x.args[1]?.type === 'EXTRACT'); i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(callsOf(c, 'tabs.sendMessage').some(x => x.args[1]?.type === 'EXTRACT'), '前提:抓取已經卡在擷取')
  const checking = sc.runSiteCheck(OPTS)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(opened(c, `${ORIGIN}/login`).length, 0, '抓取還在跑,不得打開登入頁')
  open()
  await Promise.all([fetching, checking])
  assert.ok(opened(c, `${ORIGIN}/login`).length > 0, '抓取結束後才輪到站台檢查')
  assert.equal(callsOf(c, 'windows.create').length, 1, '同站台共用同一個專用視窗')
  assert.equal(callsOf(c, 'windows.remove').length, 1, '佇列清空才關')
})

test('站台檢查之後的同站台抓取:頁面可能按過登入,要重載(不直接沿用)', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr)
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  let open
  const gate = new Promise((r) => { open = r })
  let first = true
  c.__setTabResponder(async (tabId, msg) => {
    // 讓站台檢查卡住,抓取排在它後面
    if (first) { first = false; await gate }
    if (msg.type === 'EXTRACT') return { ok: true, value: 1, raw: '1', status: 'ok', strategyUsed: 'auto', layer: 'css' }
    return { ok: true }
  })
  const t = {
    id: 't1', name: '總量', url: `${ORIGIN}/login`, mode: 'number', enabled: true,
    locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  }
  await st.saveTask(t)
  const checking = sc.runSiteCheck(OPTS)
  await new Promise((r) => setTimeout(r, 30))
  const fetching = fe.runTask(t, { slot: '2026-09-05T09:00', ...OPTS })
  open()
  await Promise.all([checking, fetching])
  const reloads = callsOf(c, 'tabs.reload').length + callsOf(c, 'tabs.update').filter(x => typeof x.args[1]?.url === 'string').length
  assert.ok(reloads >= 1, '同一頁也要重載:站台檢查可能填過表單、按過送出')
})

test('sitecheck.js 不再自己開關分頁', () => {
  const src = readFileSync(new URL('../src/background/sitecheck.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  assert.equal(/chrome\.(tabs\.create|tabs\.remove|windows\.create|windows\.remove)/.test(src), false)
})
