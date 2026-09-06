// AutoFetcher 站台密碼加解密（SPEC §6）：僅防誤讀，不防同機惡意程式

// Base64 與位元組陣列互轉
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

// 把原始金鑰位元組還原成可用的 AES-GCM 金鑰
function importKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

// 讀出既有金鑰；沒有就回 null（解密時不得順手產生新的，那會讓舊密文永遠解不開）
async function loadKey() {
  const stored = await chrome.storage.local.get('cryptoKey')
  if (!stored.cryptoKey) return null
  return await importKey(fromBase64(stored.cryptoKey))
}

// 取得金鑰，沒有就產生一把並存起來
async function getOrCreateKey() {
  const existing = await loadKey()
  if (existing) return existing

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const exported = await crypto.subtle.exportKey('raw', key)
  await chrome.storage.local.set({ cryptoKey: toBase64(new Uint8Array(exported)) })
  return key
}

// 以 AES-GCM 加密字串，每次都用新的隨機 iv
export async function encryptSecret(plain) {
  const key = await getOrCreateKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)
  )
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) }
}

// 解密；金鑰不存在或密文被竄改都會拋出，不得回半調子的結果
export async function decryptSecret(enc) {
  const key = await loadKey()
  if (!key) throw new Error('找不到加密金鑰，無法解密')

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(enc.iv) }, key, fromBase64(enc.ct)
  )
  return new TextDecoder().decode(decrypted)
}
