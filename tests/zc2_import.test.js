// AF-21 段 3-A：任務網址 scheme、設定匯入先驗後寫（摘要＋確認＋失敗還原）、紀錄匯入逐筆驗證
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { lockNameOf, heldLocks } from '../src/shared/lock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, over = {}) => ({
  id, name: '任務' + id, url: 'https://a.test/' + id, mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: '', xpath: '' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  return { c, st, io }
}

async function freshPage() {
  const { c, st, io } = await fresh()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  // jsdom 25 沒有 <dialog> 的 showModal／close（批次 4-D 起匯入確認走共用對話框）
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  return { c, st, io, se, doc: jd.window.document }
}

// storage 全部內容的位元組（JSON）
const dump = async (c) => JSON.stringify(await c.storage.local.get(null))

// 依 settings-io 的格式（PBKDF2 100000／SHA-256／AES-GCM）做一份 secrets
const b64 = (u8) => Buffer.from(u8).toString('base64')
async function makeSecrets(passphrase, passwords) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  )
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(passwords)))
  return { alg: 'AES-GCM', kdf: 'PBKDF2', iterations: 100000, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

const fileOf = (data, secrets) => JSON.stringify({ kind: 'autofetcher-settings', version: 1, exportedAt: 'x', data, ...(secrets ? { secrets } : {}) })

// 本機既有：任務 t1、站台 old.test（有本機密文）、保留 90 天
async function seedLocal(st, cr) {
  await st.saveTasks([task('t1')])
  await st.saveSite('https://old.test', { enabled: true, username: 'u', passwordEnc: await cr.encryptSecret('local-pw') })
  await st.saveSettings({ retentionDays: 90 })
}

// 外來設定檔：覆寫 t1、新增 t2、file: 的 t3、javascript: 的 t4；兩個站台都帶外來 passwordEnc，只有 new.test 有 secrets
function foreignData() {
  return {
    schemaVersion: 3,
    tasks: [
      task('t1', { name: '改過的t1' }),
      task('t2'),
      task('t3', { url: 'file:///C:/dash.html' }),
      task('t4', { url: 'javascript:alert(1)' })
    ],
    sites: {
      'https://old.test': { enabled: true, username: 'u2', passwordEnc: { iv: 'AAAA', ct: 'BBBB' } },
      'https://new.test': { enabled: true, username: 'n', passwordEnc: { iv: 'CCCC', ct: 'DDDD' }, password: 'plain' }
    },
    settings: { retentionDays: 0, foo: 1, theme: 'dark', extraDelaySec: 99, alertCooldownMin: 30 },
    layout: { dashboards: [] }
  }
}

// ---------- 1. 網址 scheme ----------

test('驗收1：javascript:／data:／chrome-extension:／chrome: 存檔被拒；https:、file: 可存', async () => {
  const { st } = await fresh()
  for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome-extension://abc/x.html', 'chrome://settings', '不是網址']) {
    await assert.rejects(() => st.saveTask(task('bad', { url })), /任務網址只能是 http、https 或 file/, url)
  }
  assert.equal(await st.getTask('bad'), null)
  await st.saveTask(task('h', { url: 'https://a.test/x' }))
  await st.saveTask(task('f', { url: 'file:///C:/dash.html' }))
  assert.deepEqual((await st.getTasks()).map(t => t.id).sort(), ['f', 'h'])
})

test('驗收1：storage 裡既有的 javascript: 任務升級後 getTasks 仍拿得到（只有下次存檔被擋）', async () => {
  resetChromeMock()
  const c = installChromeMock()
  await c.storage.local.set({ schemaVersion: 3, tasks: [task('old', { url: 'javascript:alert(1)' })] })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const got = await st.getTasks()
  assert.equal(got.length, 1)
  assert.equal(got[0].url, 'javascript:alert(1)')
  // 網址沒變的更新（整批停用、fetcher 回寫）不擋；整份重存（Picker 編輯）才擋——AF-21 Claude 補修
  await st.updateTasks(['old'], t => ({ ...t, enabled: false }))
  assert.equal((await st.getTask('old')).enabled, false)
  const stale = await st.getTask('old')
  await assert.rejects(() => st.saveTask({ ...stale }), /任務網址只能是 http、https 或 file/)
})

// ---------- 2. preview 零寫入＋摘要 ----------

test('驗收2：previewSettingsImport 零寫入（get(null) 前後位元組相同）且摘要正確', async () => {
  const { c, st, io } = await fresh()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  await seedLocal(st, cr)
  const secrets = await makeSecrets('pw', { 'https://new.test': 'new-pw' })
  const before = await dump(c)
  const setsBefore = c.__calls.filter(x => x.api === 'storage.local.set' || x.api === 'storage.local.remove').length

  const { plan, summary } = await io.previewSettingsImport(fileOf(foreignData(), secrets), { passphrase: 'pw' })

  assert.equal(await dump(c), before, 'preview 不得改動 storage')
  assert.equal(c.__calls.filter(x => x.api === 'storage.local.set' || x.api === 'storage.local.remove').length, setsBefore, 'preview 不得呼叫 set／remove')
  assert.ok(plan && typeof plan === 'object')

  assert.equal(summary.tasks.add, 1, '新增 t2')
  assert.equal(summary.tasks.update, 1, '覆寫 t1')
  assert.deepEqual(summary.tasks.skipped, [
    { name: '任務t3', reason: '外來設定檔不接受本機檔案網址' },
    { name: '任務t4', reason: '任務網址只能是 http、https 或 file' }
  ])
  assert.equal(summary.sites.add, 1)
  assert.equal(summary.sites.update, 1)
  assert.deepEqual(summary.sites.needPassword, [], 'old.test 沒帶密碼但本機已有（沿用）；new.test 有 secrets')
  assert.deepEqual(summary.settings.applied.sort(), ['alertCooldownMin', 'theme'])
  assert.deepEqual(summary.settings.rejected.map(r => r.key).sort(), ['extraDelaySec', 'foo', 'retentionDays'])
  for (const r of summary.settings.rejected) assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${r.key} 要有原因`)
  assert.equal(summary.layout, true)
})

test('preview：密語錯誤丟例外且零寫入；沒有 secrets 時所有站台都要重輸密碼', async () => {
  const { c, st, io } = await fresh()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  await seedLocal(st, cr)
  const before = await dump(c)
  const secrets = await makeSecrets('pw', { 'https://new.test': 'new-pw' })
  await assert.rejects(() => io.previewSettingsImport(fileOf(foreignData(), secrets), { passphrase: 'wrong' }))
  assert.equal(await dump(c), before)
  const { summary } = await io.previewSettingsImport(fileOf(foreignData()))
  assert.deepEqual(summary.sites.needPassword.sort(), ['https://new.test'], 'old.test 本機已有密碼，沿用')
  assert.equal(await dump(c), before)
})

// ---------- 3. 匯入結果 ----------

test('驗收3：retentionDays 0 與 foo 不寫；file: 任務被略過；外來 passwordEnc 不留、secrets 解得開的重新加密', async () => {
  const { st, io } = await fresh()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  await seedLocal(st, cr)
  const secrets = await makeSecrets('pw', { 'https://new.test': 'new-pw' })
  const { plan } = await io.previewSettingsImport(fileOf(foreignData(), secrets), { passphrase: 'pw' })
  await io.applySettingsImport(plan)

  const s = await st.getSettings()
  assert.equal(s.retentionDays, 90, 'retentionDays 0 被拒，維持原值')
  assert.equal('foo' in s, false, '未知鍵不寫')
  assert.equal(s.extraDelaySec, 3, '超出範圍不寫')
  assert.equal(s.theme, 'dark')
  assert.equal(s.alertCooldownMin, 30)

  const ids = (await st.getTasks()).map(t => t.id).sort()
  assert.deepEqual(ids, ['t1', 't2'])
  assert.equal((await st.getTask('t1')).name, '改過的t1')

  const oldSite = await st.getSite('https://old.test')
  assert.equal(await cr.decryptSecret(oldSite.passwordEnc), 'local-pw', '外來 passwordEnc 不得留下；本機原有的密碼沿用')
  assert.equal(oldSite.username, 'u2')
  const newSite = await st.getSite('https://new.test')
  assert.equal('password' in newSite, false)
  assert.equal(await cr.decryptSecret(newSite.passwordEnc), 'new-pw', '以本機金鑰重新加密')
})

test('importSettings 舊介面＝preview＋apply，回傳 skippedTasks 與 summary', async () => {
  const { st, io } = await fresh()
  const res = await io.importSettings(fileOf(foreignData()))
  assert.equal(res.skippedTasks, 2)
  assert.equal(res.summary.tasks.add, 2)
  assert.deepEqual((await st.getTasks()).map(t => t.id).sort(), ['t1', 't2'])
})

// ---------- 4. 失敗還原 ----------

test('驗收4：第三個鍵寫入時丟例外 → 錯誤往外丟、storage 與匯入前位元組相同；寫入與還原都在該鍵的鎖內', async () => {
  const { c, st, io } = await fresh()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  await seedLocal(st, cr)
  // 不帶 secrets：apply 不會加密（不會產生 cryptoKey 之類的額外寫入）
  const { plan } = await io.previewSettingsImport(fileOf(foreignData()))
  const before = await dump(c)

  const origSet = c.storage.local.set.bind(c.storage.local)
  const origRemove = c.storage.local.remove.bind(c.storage.local)
  const lockViolations = []
  const checkLock = (k) => {
    const held = heldLocks()
    if (!held.has(lockNameOf(k))) lockViolations.push(`${k} 寫入時沒有持有自己的鎖`)
    else if (held.size !== 1) lockViolations.push(`${k} 寫入時同時持有 ${held.size} 把鎖`)
  }
  let n = 0
  const written = []
  c.storage.local.set = async (items) => {
    for (const k of Object.keys(items)) checkLock(k)
    n++
    if (n === 3) throw new Error('替身：第三個鍵寫入失敗')
    written.push(...Object.keys(items))
    return origSet(items)
  }
  c.storage.local.remove = async (keys) => {
    for (const k of (Array.isArray(keys) ? keys : [keys])) checkLock(k)
    return origRemove(keys)
  }

  await assert.rejects(() => io.applySettingsImport(plan), /替身：第三個鍵寫入失敗/)
  assert.deepEqual(written.slice(0, 2), ['tasks', 'sites'], '前兩個鍵真的寫過了（還原才有意義）')
  c.storage.local.set = origSet
  c.storage.local.remove = origRemove
  assert.equal(await dump(c), before, 'storage 要還原成匯入前的位元組')
  assert.deepEqual(lockViolations, [])
})

test('還原：匯入前不存在的鍵（layout）寫入後失敗要刪掉', async () => {
  const { c, io } = await fresh()
  await c.storage.local.remove('layout')
  const { plan } = await io.previewSettingsImport(fileOf({ settings: { theme: 'dark' }, layout: { dashboards: [] } }))
  const before = await dump(c)
  const origSet = c.storage.local.set.bind(c.storage.local)
  let n = 0
  // settings(1) → layout 原始(2) → layout 正規化(3) 失敗
  c.storage.local.set = async (items) => { n++; if (n === 3) throw new Error('boom'); return origSet(items) }
  await assert.rejects(() => io.applySettingsImport(plan), /boom/)
  c.storage.local.set = origSet
  assert.equal(await dump(c), before)
})

// ---------- 5. 設定頁 ----------

test('驗收5：選檔後出現摘要與兩顆按鈕、storage 未變；取消零寫入並清掉摘要', async () => {
  const { c, st, se, doc } = await freshPage()
  await st.saveSettings({ retentionDays: 90 })
  await se.renderSettings()
  const before = await dump(c)
  await se.handleSettingsImport(fileOf({ ...foreignData(), settings: { retentionDays: 30, foo: 1 } }))

  const box = doc.getElementById('settings-import-result')
  const text = box.textContent
  assert.ok(text.includes('新增 2 個'), text)
  assert.ok(text.includes('任務t3') && text.includes('外來設定檔不接受本機檔案網址'), '略過的任務與原因')
  assert.ok(text.includes('https://old.test') && text.includes('重新輸入密碼'), '要重輸密碼的站台')
  assert.ok(text.includes('foo'), '被拒的設定')
  const confirmBtn = doc.getElementById('settings-import-confirm')
  const cancelBtn = doc.getElementById('settings-import-cancel')
  assert.equal(confirmBtn?.textContent, '確認匯入')
  assert.equal(cancelBtn?.textContent, '取消')
  assert.equal(await dump(c), before, '選檔後不得寫入')

  cancelBtn.click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(await dump(c), before, '取消零寫入')
  assert.equal(box.textContent, '', '取消清掉摘要')
  assert.equal(doc.getElementById('settings-import-confirm'), null)
})

test('驗收5：按確認後寫入、重畫設定頁（保留天數欄位顯示匯入後的值）', async () => {
  const { st, se, doc } = await freshPage()
  await st.saveSettings({ retentionDays: 90 })
  await se.renderSettings()
  assert.equal(doc.getElementById('pref-retention').value, '90')
  await se.handleSettingsImport(fileOf({ tasks: [task('t2')], settings: { retentionDays: 30 } }))
  doc.getElementById('settings-import-confirm').click()
  await new Promise(r => setTimeout(r, 60))
  assert.equal((await st.getSettings()).retentionDays, 30)
  assert.ok(await st.getTask('t2'))
  assert.equal(doc.getElementById('pref-retention').value, '30', '欄位要顯示匯入後的值')
  assert.ok(doc.getElementById('settings-import-result').textContent.includes('設定匯入成功'))
})

test('設定頁：確認後寫入失敗 → 顯示原因與「已還原成匯入前的設定」、storage 不變', async () => {
  const { c, st, se, doc } = await freshPage()
  await st.saveTasks([task('t1')])
  await se.renderSettings()
  await se.handleSettingsImport(fileOf({ tasks: [task('t2')], sites: { 'https://x.test': { enabled: true } }, settings: { theme: 'dark' } }))
  const before = await dump(c)
  const origSet = c.storage.local.set.bind(c.storage.local)
  let n = 0
  c.storage.local.set = async (items) => { n++; if (n === 3) throw new Error('寫不進去'); return origSet(items) }
  doc.getElementById('settings-import-confirm').click()
  await new Promise(r => setTimeout(r, 60))
  c.storage.local.set = origSet
  const text = doc.getElementById('settings-import-result').textContent
  assert.ok(text.includes('寫不進去'), text)
  assert.ok(text.includes('已還原成匯入前的設定'), text)
  assert.equal(await dump(c), before)
})

// ---------- 6. 紀錄匯入逐筆驗證 ----------

const good = (over = {}) => ({ taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z', value: 1, status: 'ok', ...over })
const badDay = () => ({ date: '2026-09-05', tasks: { t1: { records: [
  good(),
  good({ taskId: 't1#a#b', capturedAt: '2026-09-05T02:00:00.000Z' }),
  good({ capturedAt: undefined, slot: '2026-09-05T11:00' }),
  good({ capturedAt: '2026-09-05T04:00:00.000Z', status: 'weird' }),
  good({ taskId: 't1#k', capturedAt: '2026-09-05T05:00:00.000Z', status: 'interrupted' })
] } } })

test('驗收6：兩個分隔字元／缺 capturedAt／未知 status 各一筆 → skipped、invalid 列原因，其餘照常寫入', async () => {
  const { st } = await fresh()
  const res = await st.importRecords([badDay()])
  assert.equal(res.added, 2)
  assert.equal(res.skipped, 3)
  assert.equal(res.invalid.length, 3)
  assert.deepEqual(res.invalid.map(v => v.taskId), ['t1#a#b', 't1', 't1'])
  assert.ok(res.invalid.every(v => v.date === '2026-09-05' && typeof v.reason === 'string' && v.reason.length > 0))
  assert.match(res.invalid[0].reason, /#/)
  assert.match(res.invalid[1].reason, /capturedAt/)
  assert.match(res.invalid[2].reason, /weird/)
  assert.deepEqual((await st.getRecordsByDate('2026-09-05')).map(r => r.taskId), ['t1', 't1#k'])
})

test('紀錄匯入：invalid 最多 5 筆，skipped 照實計', async () => {
  const { st } = await fresh()
  const records = Array.from({ length: 8 }, (_, i) => good({ capturedAt: '2026-09-05T0' + i + ':00:00.000Z', status: 'nope' }))
  const res = await st.importRecords([{ date: '2026-09-05', tasks: { t1: { records } } }])
  assert.equal(res.skipped, 8)
  assert.equal(res.invalid.length, 5)
})

test('驗收6：設定頁的歷史紀錄匯入結果顯示前幾筆原因', async () => {
  const { se, doc } = await freshPage()
  await se.renderSettings()
  await se.handleRecordsImport([JSON.stringify(badDay())])
  const text = doc.getElementById('records-import-result').textContent
  assert.ok(text.includes('已新增 2 筆、略過 3 筆'), text)
  assert.ok(text.includes('t1#a#b'), text)
  assert.ok(text.includes('capturedAt'), text)
  assert.ok(text.includes('weird'), text)
})

test('AF-21 補修：舊資料裡的怪網址任務，只改別的欄位（fetcher 回寫、整批啟停）不會被擋', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await c.storage.local.set({ tasks: [{ id: 'bad', name: '舊', url: 'javascript:alert(1)', order: 0, enabled: true }] })
  await st.updateTasks(['bad'], t => ({ ...t, notFoundStreak: 2 }))
  assert.equal((await st.getTask('bad')).notFoundStreak, 2)
  await assert.rejects(() => st.updateTasks(['bad'], t => ({ ...t, url: 'data:text/html,x' })), /http、https 或 file/)
})

test('AF-21 補修：同一台機器再匯入沒帶密碼的設定檔，本機既有站台的密碼保留、不列入要重新輸入', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  await st.saveSite('https://a.test', { loginUrl: 'https://a.test/login', username: 'u', passwordEnc: { iv: 'x', ct: 'y' }, enabled: true })
  const json = JSON.stringify({ kind: 'autofetcher-settings', version: 1, data: { schemaVersion: 3, tasks: [], sites: { 'https://a.test': { loginUrl: 'https://a.test/login', username: 'u2' } }, settings: {} } })
  const { plan, summary } = await io.previewSettingsImport(json)
  assert.deepEqual(summary.sites.needPassword, [])
  await io.applySettingsImport(plan)
  const site = await st.getSite('https://a.test')
  assert.equal(site.username, 'u2')
  assert.deepEqual(site.passwordEnc, { iv: 'x', ct: 'y' })
})
