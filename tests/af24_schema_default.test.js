// AF-24 B2：缺 schemaVersion 視為 1，遷移冪等
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const ORIGIN = 'https://bank.example'

async function load() {
  return import('../src/shared/storage.js?t=' + Math.random())
}

test('沒有 schemaVersion 又帶明文密碼：init 會加密並補成現行版本', async () => {
  resetChromeMock()
  installChromeMock()
  await chrome.storage.local.set({
    sites: { [ORIGIN]: { loginPageUrlPrefix: `${ORIGIN}/login`, password: 'old-plain', username: 'u' } }
  })
  const st = await load()
  await st.init()
  const raw = (await chrome.storage.local.get('sites')).sites[ORIGIN]
  assert.equal(raw.password, undefined, '明文不得留在 storage')
  assert.ok(raw.passwordEnc?.ct, '要轉成密文')
  assert.equal(await st.getSchemaVersion(), 4)
})

test('init 連跑兩次：第二次不改任何資料（不重新加密、不重寫帳本）', async () => {
  resetChromeMock()
  installChromeMock()
  await chrome.storage.local.set({
    sites: { [ORIGIN]: { loginPageUrlPrefix: `${ORIGIN}/login`, password: 'p', username: 'u' } },
    tasks: [{ id: 't1', name: 'x', url: `${ORIGIN}/a`, mode: 'number', schedule: { type: 'daily', times: ['09:30'] } }]
  })
  const st = await load()
  await st.init()
  const first = JSON.stringify(await chrome.storage.local.get(null))
  await st.init()
  const second = JSON.stringify(await chrome.storage.local.get(null))
  assert.equal(second, first)
})

test('全新安裝（空 storage）：版本寫成 4、不產生站台', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await load()
  await st.init()
  assert.equal(await st.getSchemaVersion(), 4)
  assert.equal((await chrome.storage.local.get('sites')).sites, undefined)
})

test('getSchemaVersion 對缺省回 1（與 init 同一份判定）', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await load()
  assert.equal(await st.getSchemaVersion(), 1)
})
