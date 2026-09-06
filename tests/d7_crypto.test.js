// AF-3 批次 D:站台密碼加密(SPEC §6;僅防誤讀,不防同機惡意程式)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const cr = await import('../src/shared/crypto.js?t=' + Math.random())
  return { c, cr }
}

test('加密後解得回原文', async () => {
  const { cr } = await fresh()
  const enc = await cr.encryptSecret('hunter2')
  assert.notEqual(JSON.stringify(enc), undefined)
  assert.equal(await cr.decryptSecret(enc), 'hunter2')
})

test('密文裡不得出現明文', async () => {
  const { cr } = await fresh()
  const enc = await cr.encryptSecret('hunter2')
  assert.ok(!JSON.stringify(enc).includes('hunter2'), `密文不能看得到原文:${JSON.stringify(enc)}`)
})

test('同一個明文每次加密的密文都不同(iv 要隨機)', async () => {
  const { cr } = await fresh()
  const a = await cr.encryptSecret('same')
  const b = await cr.encryptSecret('same')
  assert.notDeepEqual(a, b)
  assert.equal(await cr.decryptSecret(a), 'same')
  assert.equal(await cr.decryptSecret(b), 'same')
})

test('金鑰首次使用時自動產生並存在 storage.local', async () => {
  const { c, cr } = await fresh()
  const before = await chrome.storage.local.get('cryptoKey')
  assert.equal(before.cryptoKey, undefined)
  await cr.encryptSecret('x')
  const after = await chrome.storage.local.get('cryptoKey')
  assert.ok(after.cryptoKey, '金鑰要存起來,不然下次解不開')
})

test('第二次加密沿用同一把金鑰(不是每次都換)', async () => {
  const { cr } = await fresh()
  const enc = await cr.encryptSecret('x')
  const key1 = (await chrome.storage.local.get('cryptoKey')).cryptoKey
  await cr.encryptSecret('y')
  const key2 = (await chrome.storage.local.get('cryptoKey')).cryptoKey
  assert.deepEqual(key1, key2)
  assert.equal(await cr.decryptSecret(enc), 'x', '換過金鑰就解不開了')
})

test('密文被竄改時解密失敗,不得回錯的明文', async () => {
  const { cr } = await fresh()
  const enc = await cr.encryptSecret('hunter2')
  const tampered = { ...enc, ct: enc.ct.slice(0, -2) + (enc.ct.endsWith('AA') ? 'BB' : 'AA') }
  await assert.rejects(() => cr.decryptSecret(tampered))
})

test('空字串與中文都處理得了', async () => {
  const { cr } = await fresh()
  assert.equal(await cr.decryptSecret(await cr.encryptSecret('')), '')
  assert.equal(await cr.decryptSecret(await cr.encryptSecret('密碼一二三')), '密碼一二三')
})

test('沒有金鑰卻要解密時明確失敗', async () => {
  const { cr } = await fresh()
  const enc = await cr.encryptSecret('x')
  await chrome.storage.local.remove('cryptoKey')
  await assert.rejects(() => cr.decryptSecret(enc))
})
