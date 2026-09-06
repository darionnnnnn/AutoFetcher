process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const se = await import('../src/shared/settings-io.js?t=' + Math.random())
  return { st, se }
}

const task = (id) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
})
// 現行 schema:密碼一律以本機金鑰加密後存 passwordEnc（storage 內不得有明文）
async function makeSite() {
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  return {
    loginUrl: 'https://a.test/login', userSel: '#u', passSel: '#p', user: 'wayne',
    passwordEnc: await cr.encryptSecret('hunter2')
  }
}

test('匯出不含密碼時,密碼欄位被移除', async () => {
  const { st, se } = await fresh()
  await st.saveSite('https://a.test', await makeSite())
  const json = await se.exportSettings({ includePasswords: false })
  assert.ok(!json.includes('hunter2'), '明文密碼不得出現')
  const obj = JSON.parse(json)
  assert.equal(obj.data.sites['https://a.test'].user, 'wayne', '帳號等其他欄位要保留')
  assert.equal(obj.data.sites['https://a.test'].password, undefined)
  assert.equal(obj.secrets, undefined)
})

test('匯出含密碼時以密語加密,密文中找不到明文', async () => {
  const { st, se } = await fresh()
  await st.saveSite('https://a.test', await makeSite())
  const json = await se.exportSettings({ includePasswords: true, passphrase: 'my-pass-phrase' })
  assert.ok(!json.includes('hunter2'), '密文中不得出現明文密碼')
  const obj = JSON.parse(json)
  assert.equal(obj.secrets.alg, 'AES-GCM')
  assert.ok(obj.secrets.salt && obj.secrets.iv && obj.secrets.ct)
  assert.equal(obj.data.sites['https://a.test'].password, undefined)
})

test('匯出含密碼但沒給密語要丟錯', async () => {
  const { se } = await fresh()
  await assert.rejects(() => se.exportSettings({ includePasswords: true }))
})

test('匯出不含任何紀錄', async () => {
  const { st, se } = await fresh()
  await st.saveTask(task('t1'))
  await st.appendRecord('2026-09-05', { taskId: 't1', slot: '2026-09-05T09:00', value: 1, capturedAt: 'x', status: 'ok' })
  const json = await se.exportSettings({ includePasswords: false })
  assert.ok(!json.includes('capturedAt'))
  const obj = JSON.parse(json)
  assert.ok(!Object.keys(obj.data).some(k => k.startsWith('rec:')))
  assert.equal(JSON.stringify(obj.data).includes('"value":1'), false)
})

test('匯出格式帶識別欄位與版本', async () => {
  const { se } = await fresh()
  const obj = JSON.parse(await se.exportSettings({ includePasswords: false }))
  assert.equal(obj.kind, 'autofetcher-settings')
  assert.equal(obj.version, 1)
  assert.equal(typeof obj.exportedAt, 'string')
})

test('往返:匯出→清空→匯入,任務完全一致且 alarms 重建', async () => {
  const { st, se } = await fresh()
  await st.saveTask(task('t1'))
  await st.saveTask(task('t2'))
  const json = await se.exportSettings({ includePasswords: false })
  const before = await st.getTasks()

  resetChromeMock(); installChromeMock()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  const se2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  await se2.importSettings(json)

  assert.deepEqual(await st2.getTasks(), before)
  assert.equal((await chrome.alarms.getAll()).length, 2, '匯入後必須重建 alarms')
})

test('匯入含密碼:密語正確時還原明文密碼', async () => {
  const { st, se } = await fresh()
  await st.saveSite('https://a.test', await makeSite())
  const json = await se.exportSettings({ includePasswords: true, passphrase: 'pw' })

  resetChromeMock(); installChromeMock()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  const se2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  await se2.importSettings(json, { passphrase: 'pw' })
  const site2 = await st2.getSite('https://a.test')
  assert.equal(site2.password, undefined, 'storage 內不得留明文')
  const cr2 = await import('../src/shared/crypto.js?t=' + Math.random())
  assert.equal(await cr2.decryptSecret(site2.passwordEnc), 'hunter2', '要以新機器的金鑰重新加密')
})

test('匯入含密碼但密語錯誤:丟錯且 storage 完全不變', async () => {
  const { st, se } = await fresh()
  await st.saveSite('https://a.test', await makeSite())
  const json = await se.exportSettings({ includePasswords: true, passphrase: 'right' })

  resetChromeMock(); installChromeMock()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  await st2.saveTask(task('existing'))
  const se2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  await assert.rejects(() => se2.importSettings(json, { passphrase: 'wrong' }))
  assert.deepEqual((await st2.getTasks()).map(t => t.id), ['existing'], '失敗時不得動到既有資料')
  assert.equal(await st2.getSite('https://a.test'), null)
})

test('匯入:同 id 覆蓋、新 id 新增,既有其他任務保留', async () => {
  const { st, se } = await fresh()
  await st.saveTask({ ...task('t1'), name: '匯出版' })
  const json = await se.exportSettings({ includePasswords: false })

  resetChromeMock(); installChromeMock()
  const st2 = await import('../src/shared/storage.js?t=' + Math.random())
  await st2.init()
  await st2.saveTask({ ...task('t1'), name: '本機版' })
  await st2.saveTask(task('keep'))
  const se2 = await import('../src/shared/settings-io.js?t=' + Math.random())
  await se2.importSettings(json)
  const ids = (await st2.getTasks()).map(t => t.id).sort()
  assert.deepEqual(ids, ['keep', 't1'])
  assert.equal((await st2.getTask('t1')).name, '匯出版', '同 id 應被匯入的覆蓋')
})

test('匯入非 AutoFetcher 檔案要丟錯', async () => {
  const { se } = await fresh()
  await assert.rejects(() => se.importSettings('{"kind":"something-else"}'))
  await assert.rejects(() => se.importSettings('not json at all'))
})

test('匯入未來版本要丟錯,不亂猜格式', async () => {
  const { se } = await fresh()
  await assert.rejects(() => se.importSettings(JSON.stringify({ kind: 'autofetcher-settings', version: 99, data: {} })))
})

test('匯入含密碼的檔案但沒給密語:丟錯', async () => {
  const { st, se } = await fresh()
  await st.saveSite('https://a.test', await makeSite())
  const json = await se.exportSettings({ includePasswords: true, passphrase: 'pw' })
  await assert.rejects(() => se.importSettings(json))
})
