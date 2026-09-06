// AF-3 體檢輪:站台密碼的匯出/匯入往返,以及舊格式站台的遷移
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const ORIGIN = 'https://a.test'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  return { c, st, cr, io }
}

const newSite = async (cr, over = {}) => ({
  loginUrl: `${ORIGIN}/login`,
  selectors: { user: { css: '#u' }, pass: { css: '#p' }, submit: { css: '#go' } },
  loginCheck: { type: 'urlPrefix', value: `${ORIGIN}/login` },
  successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
  username: 'wayne',
  passwordEnc: await cr.encryptSecret('hunter2'),
  enabled: true,
  failStreak: 0,
  ...over
})

// ---- 匯出 ----

test('預設匯出不含密碼,連密文都不留', async () => {
  const { st, cr, io } = await fresh()
  await st.saveSite(ORIGIN, await newSite(cr))
  const json = await io.exportSettings()
  assert.ok(!json.includes('passwordEnc'), '密文欄位不該出現在檔案裡')
  assert.ok(!json.includes('hunter2'))
  assert.ok(json.includes('wayne'), '帳號等其他設定照樣要匯出')
})

test('勾選含密碼時,密碼真的進得了 secrets(過去這裡是空的)', async () => {
  const { st, cr, io } = await fresh()
  await st.saveSite(ORIGIN, await newSite(cr))
  const json = await io.exportSettings({ includePasswords: true, passphrase: '換機密語' })
  const parsed = JSON.parse(json)
  assert.ok(parsed.secrets?.ct, '要有加密後的密碼包')
  assert.ok(!json.includes('hunter2'), '密語加密後不得看得到明文')
  assert.ok(!json.includes('passwordEnc'), '本機金鑰的密文不該一起帶走,換機也解不開')
})

// ---- 往返 ----

test('含密碼匯出 → 換一台機器匯入 → 自動登入拿得到原本的密碼', async () => {
  const { st, cr, io } = await fresh()
  await st.saveSite(ORIGIN, await newSite(cr))
  const json = await io.exportSettings({ includePasswords: true, passphrase: '換機密語' })

  // 換一台機器:清空 storage(含本機金鑰)
  await chrome.storage.local.clear()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  const io2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  const cr2 = await import('../src/shared/crypto.js?t=' + Math.random())
  await io2.importSettings(json, { passphrase: '換機密語' })

  const site = await st2.getSite(ORIGIN)
  assert.ok(site, '站台要匯得進來')
  assert.equal(site.username, 'wayne')
  assert.equal(site.password, undefined, '不得把明文寫進 storage')
  assert.ok(site.passwordEnc?.ct, '要以新機器的金鑰重新加密')
  assert.equal(await cr2.decryptSecret(site.passwordEnc), 'hunter2', '登入端解得開才算真的匯進來')
})

test('密語錯誤時整批不寫入', async () => {
  const { st, cr, io } = await fresh()
  await st.saveSite(ORIGIN, await newSite(cr))
  const json = await io.exportSettings({ includePasswords: true, passphrase: '對的密語' })
  await chrome.storage.local.clear()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  const io2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  await assert.rejects(() => io2.importSettings(json, { passphrase: '錯的密語' }))
  assert.equal(await st2.getSite(ORIGIN), null, '解不開就不該寫進去半套設定')
})

test('不含密碼的匯出檔匯入後,站台其他設定都在,只是沒有密碼', async () => {
  const { st, cr, io } = await fresh()
  await st.saveSite(ORIGIN, await newSite(cr))
  const json = await io.exportSettings()
  await chrome.storage.local.clear()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  const io2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  await io2.importSettings(json)
  const site = await st2.getSite(ORIGIN)
  assert.equal(site.username, 'wayne')
  assert.equal(site.selectors.user.css, '#u')
  assert.equal(site.passwordEnc, undefined, '沒帶密碼就是沒有,使用者重新輸入即可')
})

// ---- 舊格式遷移 ----

test('舊版的明文 password 欄位在初始化時會被加密並移除', async () => {
  resetChromeMock()
  installChromeMock()
  await chrome.storage.local.set({
    schemaVersion: 1,
    sites: {
      [ORIGIN]: {
        loginPageUrlPrefix: `${ORIGIN}/login`,
        password: 'old-plain',
        username: 'wayne'
      }
    }
  })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())

  const site = await st.getSite(ORIGIN)
  assert.equal(site.password, undefined, '明文欄位要清掉')
  assert.ok(site.passwordEnc?.ct, '要轉成密文')
  assert.equal(await cr.decryptSecret(site.passwordEnc), 'old-plain', '密碼不能在遷移中弄丟')
})

test('舊版的 loginPageUrlPrefix 會轉成 loginCheck', async () => {
  resetChromeMock()
  installChromeMock()
  await chrome.storage.local.set({
    schemaVersion: 1,
    sites: { [ORIGIN]: { loginPageUrlPrefix: `${ORIGIN}/login`, username: 'wayne' } }
  })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const site = await st.getSite(ORIGIN)
  assert.deepEqual(site.loginCheck, { type: 'urlPrefix', value: `${ORIGIN}/login` })
  assert.equal(site.loginPageUrlPrefix, undefined, '舊欄位要清掉,不然兩份來源會不一致')
})

test('遷移只做一次,版本升上去之後不再動', async () => {
  resetChromeMock()
  installChromeMock()
  await chrome.storage.local.set({
    schemaVersion: 1,
    sites: { [ORIGIN]: { password: 'old-plain', username: 'wayne' } }
  })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const first = await st.getSite(ORIGIN)
  await st.init()
  const second = await st.getSite(ORIGIN)
  assert.deepEqual(second.passwordEnc, first.passwordEnc, '第二次初始化不該重新加密')
  assert.ok((await st.getSchemaVersion()) >= 2)
})

test('已經是新格式的站台不受遷移影響', async () => {
  const { st, cr } = await fresh()
  const original = await newSite(cr)
  await st.saveSite(ORIGIN, original)
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  const site = await st2.getSite(ORIGIN)
  assert.deepEqual(site.passwordEnc, original.passwordEnc)
  assert.deepEqual(site.loginCheck, original.loginCheck)
})

test('匯入舊版設定檔時,站台的 loginPageUrlPrefix 也要轉成 loginCheck', async () => {
  const { st, io } = await fresh()
  const legacy = JSON.stringify({
    kind: 'autofetcher-settings', version: 1, exportedAt: '2026-01-01T00:00:00Z',
    data: { tasks: [], sites: { [ORIGIN]: { loginPageUrlPrefix: `${ORIGIN}/login`, username: 'wayne' } }, settings: {}, layout: { dashboards: [] } }
  })
  await io.importSettings(legacy)
  const s = await st.getSite(ORIGIN)
  assert.deepEqual(s.loginCheck, { type: 'urlPrefix', value: `${ORIGIN}/login` }, '匯入要走與 init 相同的搬移')
  assert.equal(s.loginPageUrlPrefix, undefined)
})
