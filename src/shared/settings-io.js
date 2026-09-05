// AutoFetcher 設定匯出/匯入模組 (SPEC §5)
// 負責任務、站台與全域設定的備份匯出與還原匯入，支援 PBKDF2 + AES-GCM 加解密

import { exportAll, saveTask, saveSite, saveSettings } from './storage.js'
import { rebuildAlarms } from '../background/scheduler.js'

// 加解密演算法常數
const PBKDF2_ITERATIONS = 100000
const SALT_BYTE_LENGTH = 16
const IV_BYTE_LENGTH = 12

// 二進位資料（ArrayBuffer 或 Uint8Array）轉為 Base64 字串
function bytesToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// Base64 字串轉為 Uint8Array
function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// 透過 PBKDF2 從使用者密語與 salt 導出 AES-GCM 256-bit 金鑰
async function deriveAesKey(passphrase, salt, usages) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
  )
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, usages
  )
}

// 匯出設定為 JSON 字串
export async function exportSettings({ includePasswords = false, passphrase } = {}) {
  if (includePasswords && (!passphrase || typeof passphrase !== 'string' || passphrase.trim() === '')) {
    throw new Error('匯出密碼時必須提供非空密語')
  }

  // 1. 取得現有所有設定並深拷貝，移除站台密碼以防明文洩漏
  const allData = await exportAll()
  const data = structuredClone(allData)
  const passwords = {}

  if (data.sites && typeof data.sites === 'object') {
    for (const [origin, site] of Object.entries(data.sites)) {
      if (site && site.password !== undefined) {
        passwords[origin] = site.password
        delete site.password
      }
    }
  }

  // 2. 基本匯出結構
  const exportedAt = new Date().toISOString()
  const result = { kind: 'autofetcher-settings', version: 1, exportedAt, data }

  // 3. 若需包含密碼，使用 AES-GCM 加密對照表
  if (includePasswords) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH))
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
    const key = await deriveAesKey(passphrase, salt, ['encrypt'])
    const ctBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(passwords))
    )

    result.secrets = {
      alg: 'AES-GCM',
      kdf: 'PBKDF2',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(ctBuffer)
    }
  }

  // 4. 回傳格式化 JSON 字串
  return JSON.stringify(result, null, 2)
}

// 匯入 JSON 字串設定並合併至現有儲存空間
export async function importSettings(json, { passphrase } = {}) {
  // 1. 解析與格式驗證
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('無效的 JSON 格式')
  }

  if (!parsed || typeof parsed !== 'object') throw new Error('匯入資料非有效物件')
  if (parsed.kind !== 'autofetcher-settings') throw new Error('未知的檔案類型')
  if (parsed.version !== 1) throw new Error('不支援的設定版本')
  if (!parsed.data || typeof parsed.data !== 'object') throw new Error('缺少設定內容')
  const data = parsed.data

  // 2. 處理加密密碼（若有 secrets）
  let decryptedPasswords = null
  if (parsed.secrets) {
    if (!passphrase || typeof passphrase !== 'string' || passphrase.trim() === '') {
      throw new Error('匯入加密設定時必須提供密語')
    }
    const { salt, iv, ct } = parsed.secrets
    if (!salt || !iv || !ct) throw new Error('加密資料欄位不完整')

    const saltBytes = base64ToBytes(salt)
    const ivBytes = base64ToBytes(iv)
    const ctBytes = base64ToBytes(ct)

    const key = await deriveAesKey(passphrase, saltBytes, ['decrypt'])
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes }, key, ctBytes
    )
    decryptedPasswords = JSON.parse(new TextDecoder().decode(decryptedBuf))
  }

  // 3. 驗證與解密完全成功後寫入儲存層
  if (Array.isArray(data.tasks)) {
    for (const t of data.tasks) {
      if (t) await saveTask(t)
    }
  }

  if (data.sites && typeof data.sites === 'object') {
    for (const [origin, site] of Object.entries(data.sites)) {
      if (!site || typeof site !== 'object') continue
      const siteToSave = { ...site }
      if (decryptedPasswords && decryptedPasswords[origin] !== undefined) {
        siteToSave.password = decryptedPasswords[origin]
      }
      await saveSite(origin, siteToSave)
    }
  }

  if (data.settings && typeof data.settings === 'object') {
    await saveSettings(data.settings)
  }

  if (data.layout !== undefined) {
    await chrome.storage.local.set({ layout: data.layout })
  }

  // 4. 重建所有 alarms
  await rebuildAlarms()
}
