// AF-3 批次 D:每日站台健康檢查(SPEC §4.2)與設定頁的站台登入管理(§8.5)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const ORIGIN = 'https://a.test'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  return { c, st, cr }
}

async function site(st, cr, origin = ORIGIN, over = {}) {
  await st.saveSite(origin, {
    loginUrl: `${origin}/login`,
    selectors: {
      user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' }
    },
    loginCheck: { type: 'urlPrefix', value: `${origin}/login` },
    successCheck: { type: 'urlPrefix', value: `${origin}/home` },
    username: 'wayne',
    passwordEnc: await cr.encryptSecret('hunter2'),
    enabled: true,
    failStreak: 0,
    ...over
  })
}

// ---- 每日站台檢查 ----

test('安裝時會建立每日站台檢查的 alarm,而且用 when 不用 periodInMinutes', async () => {
  const { c, st } = await fresh()
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  await sc.scheduleSiteCheck()
  const alarms = await c.alarms.getAll()
  const a = alarms.find(x => x.name === '__sitecheck')
  assert.ok(a, '必須有 __sitecheck alarm')
  assert.equal(a.periodInMinutes, undefined, '每日排程用 periodInMinutes 會因日光節約漂移')
  assert.ok(a.scheduledTime > Date.now(), '要排在未來')
})

test('檢查時間可用設定調整', async () => {
  const { c, st } = await fresh()
  await st.saveSettings({ siteCheckTime: '23:30' })
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  await sc.scheduleSiteCheck()
  const a = (await c.alarms.getAll()).find(x => x.name === '__sitecheck')
  const d = new Date(a.scheduledTime)
  assert.equal(d.getHours(), 23)
  assert.equal(d.getMinutes(), 30)
})

test('執行檢查:對每個啟用的站台各跑一次,結果寫進健康狀態', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr, 'https://a.test')
  await site(st, cr, 'https://b.test')
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true }))
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${new URL(tab.url).origin}/home`, status: 'complete' })
  await sc.runSiteCheck({ pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 })

  const health = await st.getHealthMap()
  assert.equal(health['site:https://a.test']?.status, 'ok')
  assert.equal(health['site:https://b.test']?.status, 'ok')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 2, '兩個站台各開一次')
})

test('停用的站台不檢查', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr, ORIGIN, { enabled: false })
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  await sc.runSiteCheck({ pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 })
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
})

test('檢查失敗時健康狀態轉紅並通知', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr)
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true }))
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  await sc.runSiteCheck({ pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 })
  const health = await st.getHealthMap()
  assert.equal(health[`site:${ORIGIN}`]?.status, 'login_failed')
  assert.ok(c.__calls.some(x => x.api === 'notifications.create'), '要讓使用者知道密碼可能過期了')
})

test('檢查用的分頁用完要關掉', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr)
  const sc = await import('../src/background/sitecheck.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true }))
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/home`, status: 'complete' })
  await sc.runSiteCheck({ pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 })
  assert.equal(c.__calls.filter(x => x.api === 'tabs.remove').length, 1)
})

test('__sitecheck 觸發時會跑檢查,而且不會被當成任務 alarm', async () => {
  const { c, st, cr } = await fresh()
  await site(st, cr)
  const bg = await import('../src/background/main.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true }))
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/home`, status: 'complete' })
  await bg.handleAlarm({ name: '__sitecheck' }, { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0 })
  const health = await st.getHealthMap()
  assert.equal(health[`site:${ORIGIN}`]?.status, 'ok')
})

test('站台檢查的 alarm 不會混進「下次執行時間」', async () => {
  const { c, st } = await fresh()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  await c.alarms.create('__sitecheck', { when: Date.now() + 3600000 })
  const res = await bg.handleMessage({ type: 'GET_NEXT_RUNS' }, {})
  assert.deepEqual(Object.keys(res.nextRuns), [], '這不是任務的排程')
})

// ---- 設定頁:站台登入管理(§8.5) ----

async function settings() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const jd = new JSDOM(reportHtml, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  globalThis.window = jd.window
  return { c, st, cr, se, doc: jd.window.document }
}

test('設定頁列出站台,不再是佔位文字', async () => {
  const { st, cr, se, doc } = await settings()
  await site(st, cr)
  await se.renderSettings()
  const list = doc.getElementById('sites-list')
  assert.ok(list, '必須有站台清單容器')
  assert.equal(doc.getElementById('sites-placeholder'), null, '佔位文字要拿掉')
  assert.ok(list.textContent.includes('a.test'), `要列出站台,實得:${list.textContent}`)
  assert.ok(list.textContent.includes('wayne'), '要看得到帳號')
})

test('設定頁明示密碼保護的限度(僅防誤讀)', async () => {
  const { st, cr, se, doc } = await settings()
  await site(st, cr)
  await se.renderSettings()
  const text = doc.querySelector('#sites-list')?.closest('.settings-section')?.textContent || ''
  assert.ok(/誤讀|不防|風險/.test(text), `必須說清楚保護到什麼程度,實得:${text}`)
})

test('可以停用與重新啟用站台;重新啟用會清掉失敗次數', async () => {
  const { st, cr, se, doc } = await settings()
  await site(st, cr, ORIGIN, { enabled: false, failStreak: 3 })
  await se.renderSettings()
  const btn = doc.querySelector('#sites-list [data-action="site-toggle"]')
  assert.ok(btn, '要有啟用/停用按鈕')
  btn.click()
  await new Promise(r => setTimeout(r, 30))
  const s = await st.getSite(ORIGIN)
  assert.equal(s.enabled, true)
  assert.equal(s.failStreak, 0, '重新啟用要給它乾淨的重試機會')
})

test('可以刪除站台', async () => {
  const { st, cr, se, doc } = await settings()
  await site(st, cr)
  await se.renderSettings()
  doc.querySelector('#sites-list [data-action="site-delete"]').click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(await st.getSite(ORIGIN), null)
})

test('站台清單不得直接讀 chrome.storage', async () => {
  const src = readFileSync(new URL('../src/ui/report/settings.js', import.meta.url), 'utf8')
  assert.ok(!/chrome\.storage/.test(src), 'UI 一律經 shared/storage')
})

test('設定匯出不含站台密碼', async () => {
  const { st, cr } = await fresh()
  await site(st, cr)
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  const json = await io.exportSettings()
  assert.ok(!json.includes('passwordEnc'), `匯出檔不得含密碼欄位:${json.slice(0, 400)}`)
  assert.ok(!json.includes('hunter2'))
})

// ---- 新設定項要設定得到(AF-2 回顧:有人消費、沒人設定得到是最常見的跨段斷鏈) ----

test('設定頁能調整告警冷卻分鐘數與站台檢查時間', async () => {
  const { st, se, doc } = await settings()
  await se.renderSettings()

  const cooldown = doc.getElementById('pref-alert-cooldown')
  assert.ok(cooldown, '告警冷卻分鐘數要設定得到(background 已經在讀它)')
  cooldown.value = '15'
  cooldown.dispatchEvent(new globalThis.window.Event('change'))
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await st.getSettings()).alertCooldownMin, 15)

  const checkTime = doc.getElementById('pref-site-check-time')
  assert.ok(checkTime, '每日站台檢查時間要設定得到')
  checkTime.value = '07:15'
  checkTime.dispatchEvent(new globalThis.window.Event('change'))
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await st.getSettings()).siteCheckTime, '07:15')
})

test('這兩個設定的預設值要顯示出來,不是空白', async () => {
  const { se, doc } = await settings()
  await se.renderSettings()
  assert.equal(doc.getElementById('pref-alert-cooldown').value, '60')
  assert.equal(doc.getElementById('pref-site-check-time').value, '08:00')
})

// ---- 站台的健康狀態要進燈號(規劃批次 D 改動第 9 項) ----

test('站台登入失敗會讓燈號變紅,摘要說得出是哪個站台', async () => {
  const { computeHealth } = await import('../src/background/health.js?t=' + Math.random())
  const tasks = [{ id: 't1', name: '電費', enabled: true }]
  const health = {
    't1': { status: 'ok' },
    'site:https://a.test': { status: 'login_failed', reason: '無法登入' }
  }
  const res = computeHealth(tasks, health, [])
  assert.equal(res.level, 'red', '站台登不進去等於所有靠它的任務都會失敗,不能只跳一次通知就沒了')
  assert.equal(res.redCount, 1)
  assert.ok(res.summary.includes('a.test'), `摘要要說得出是哪個站台,實得:${res.summary}`)
})

test('站台正常時不影響燈號', async () => {
  const { computeHealth } = await import('../src/background/health.js?t=' + Math.random())
  const res = computeHealth(
    [{ id: 't1', name: '電費', enabled: true }],
    { 't1': { status: 'ok' }, 'site:https://a.test': { status: 'ok' } },
    []
  )
  assert.equal(res.level, 'green')
})

test('站台的健康項目已讀後不再計入(與任務一致)', async () => {
  const { computeHealth } = await import('../src/background/health.js?t=' + Math.random())
  const res = computeHealth(
    [{ id: 't1', name: '電費', enabled: true }],
    { 'site:https://a.test': { status: 'login_failed', read: true } },
    []
  )
  assert.equal(res.level, 'green')
})

test('沒有任何任務時,站台異常也不該讓燈號亮(整體已暫停)', async () => {
  const { computeHealth } = await import('../src/background/health.js?t=' + Math.random())
  const res = computeHealth([], { 'site:https://a.test': { status: 'login_failed' } }, [])
  assert.equal(res.level, 'off')
})
