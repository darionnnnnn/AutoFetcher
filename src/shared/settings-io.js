// AutoFetcher 設定匯出/匯入模組 (SPEC §5)
// 負責任務、站台與全域設定的備份匯出與還原匯入，支援 PBKDF2 + AES-GCM 加解密

import {
  exportAll, getTasks, getSites, saveTasks, saveSites, saveSettings, setRawLayout, normalizeSiteShape,
  validateTask, taskUrlProtocolOf, snapshotImportKeys, restoreImportKeys, SCHEMA_VERSION
} from './storage.js'
import { encryptSecret, decryptSecret } from './crypto.js'
import { getLayout, saveLayout } from './layout-store.js'
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
      if (!site) continue
      // 本機金鑰的密文換一台機器解不開，所以要先解回明文，
      // 再用使用者給的密語重新加密；不含密碼時就整個丟掉。
      if (includePasswords && site.passwordEnc !== undefined) {
        try {
          passwords[origin] = await decryptSecret(site.passwordEnc)
        } catch {
          // 解不開（例如金鑰被清掉）就跳過這一個站台，不要讓整份匯出失敗
        }
      }
      delete site.password
      delete site.passwordEnc
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

// ---- 設定匯入：先驗後寫（AF-21 批次 3 定案 2）----

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// 設定白名單與數值域：鍵＝storage.js 的 DEFAULT_SETTINGS 鍵＋程式裡實際有讀的其他設定鍵；
// 值回傳空字串＝合格，否則是拒絕原因
const inRange = (min, max, integer = false) => (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '必須是數字'
  if (integer && !Number.isInteger(v)) return '必須是整數'
  if (v < min || v > max) return `必須介於 ${min}～${max}`
  return ''
}
const oneOf = (...options) => (v) => options.includes(v) ? '' : `只能是 ${options.join('、')}`
const isBool = (v) => typeof v === 'boolean' ? '' : '必須是 true 或 false'
const isObj = (v) => isPlainObject(v) ? '' : '必須是物件'
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? '' : '必須是 HH:MM'
const isDateText = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? '' : '必須是可解析的時間'

const SETTINGS_RULES = {
  retentionDays: inRange(1, 3650, true),
  notifications: isBool,
  extraDelaySec: inRange(0, 60),
  theme: oneOf('system', 'light', 'dark'),
  fetchTabMode: oneOf('tab', 'window'),
  alertCooldownMin: inRange(0, 1440),
  siteCheckTime: isTime,
  showHelpMenu: isBool,
  pickerDefaults: isObj,
  history: isObj,
  lastSettingsExportAt: isDateText,
  lastRecordsExportAt: isDateText
}

// 解析檔案、解開 secrets（不寫入）；回傳 { data, passwords|null }
async function parseSettingsFile(json, passphrase) {
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
  // 比程式新的檔案可能帶著這版看不懂的形狀，寫進去就是半套資料
  if (typeof data.schemaVersion === 'number' && data.schemaVersion > SCHEMA_VERSION) {
    throw new Error('這個設定檔來自較新的版本，請先更新 AutoFetcher')
  }

  let passwords = null
  if (parsed.secrets) {
    if (!passphrase || typeof passphrase !== 'string' || passphrase.trim() === '') {
      throw new Error('匯入加密設定時必須提供密語')
    }
    const { salt, iv, ct } = parsed.secrets
    if (!salt || !iv || !ct) throw new Error('加密資料欄位不完整')

    const key = await deriveAesKey(passphrase, base64ToBytes(salt), ['decrypt'])
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(ct)
    )
    const decoded = JSON.parse(new TextDecoder().decode(decryptedBuf))
    passwords = isPlainObject(decoded) ? decoded : {}
  }
  return { data, passwords }
}

/**
 * 設定匯入第一步：解析、解密、驗證，產生寫入計畫與摘要。**零寫入**。
 * plan 內含解開的明文密碼（只在記憶體裡，apply 時才以本機金鑰加密），不得落地或送出頁面。
 * @returns {Promise<{ plan: object, summary: object }>}
 */
export async function previewSettingsImport(json, { passphrase } = {}) {
  const { data, passwords } = await parseSettingsFile(json, passphrase)

  const summary = {
    tasks: { add: 0, update: 0, skipped: [] },
    sites: { add: 0, update: 0, needPassword: [] },
    settings: { applied: [], rejected: [] },
    layout: false
  }
  const plan = { tasks: [], sites: {}, passwords: {}, settings: null, layout: undefined, hasLayout: false }

  // 任務：沿用寫入口的 validateTask；外來檔另拒 file:
  if (Array.isArray(data.tasks)) {
    const existing = new Set((await getTasks()).map(t => t.id))
    const planned = new Set()
    for (const t of data.tasks) {
      const name = typeof t?.name === 'string' && t.name.trim() !== '' ? t.name
        : (typeof t?.id === 'string' && t.id !== '' ? t.id : '（未命名）')
      try {
        validateTask(t)
      } catch (err) {
        summary.tasks.skipped.push({ name, reason: err.message })
        continue
      }
      if (taskUrlProtocolOf(t.url) === 'file:') {
        summary.tasks.skipped.push({ name, reason: '外來設定檔不接受本機檔案網址' })
        continue
      }
      if (existing.has(t.id) || planned.has(t.id)) summary.tasks.update++
      else summary.tasks.add++
      planned.add(t.id)
      plan.tasks.push(structuredClone(t))
    }
  }

  // 站台：外來的 passwordEnc／password 一律丟掉；secrets 解得開那個 origin 才留明文待 apply 加密
  if (isPlainObject(data.sites)) {
    const existing = await getSites()
    for (const [origin, site] of Object.entries(data.sites)) {
      if (!isPlainObject(site)) continue
      const next = normalizeSiteShape(site)
      delete next.password
      delete next.passwordEnc
      plan.sites[origin] = next
      if (passwords && typeof passwords[origin] === 'string' && passwords[origin] !== '') {
        plan.passwords[origin] = passwords[origin]
      } else if (existing[origin]?.passwordEnc) {
        // 本機已有這個站台的密碼（同一台機器再匯入）：沿用，不要讓匯入把能用的密碼洗掉
        next.passwordEnc = existing[origin].passwordEnc
      } else {
        summary.sites.needPassword.push(origin)
      }
      if (Object.prototype.hasOwnProperty.call(existing, origin)) summary.sites.update++
      else summary.sites.add++
    }
  }

  // 設定：白名單＋數值域，其餘列入 rejected、不寫
  if (isPlainObject(data.settings)) {
    const patch = {}
    for (const [key, value] of Object.entries(data.settings)) {
      const rule = Object.prototype.hasOwnProperty.call(SETTINGS_RULES, key) ? SETTINGS_RULES[key] : null
      if (!rule) {
        summary.settings.rejected.push({ key, reason: '不認得的設定' })
        continue
      }
      const reason = rule(value)
      if (reason) {
        summary.settings.rejected.push({ key, reason })
        continue
      }
      patch[key] = structuredClone(value)
      summary.settings.applied.push(key)
    }
    if (Object.keys(patch).length > 0) plan.settings = patch
  }

  if (data.layout !== undefined) {
    plan.hasLayout = true
    plan.layout = structuredClone(data.layout)
    summary.layout = true
  }

  return { plan, summary }
}

/**
 * 設定匯入第二步：依 preview 的計畫寫入。任何一步丟例外 → 把 tasks／sites／settings／layout
 * 還原成寫入前的快照，再把原錯誤丟出去（還原本身失敗時錯誤帶 restoreError）。成功後重建排程。
 */
export async function applySettingsImport(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('缺少匯入計畫')

  // 先把密碼加密好（加密失敗就什麼都還沒寫）
  const sites = {}
  for (const [origin, site] of Object.entries(plan.sites || {})) {
    const next = { ...site }
    if (typeof plan.passwords?.[origin] === 'string') {
      next.passwordEnc = await encryptSecret(plan.passwords[origin])
    }
    sites[origin] = next
  }

  const snapshot = await snapshotImportKeys()
  try {
    if (Array.isArray(plan.tasks) && plan.tasks.length > 0) await saveTasks(plan.tasks)
    if (Object.keys(sites).length > 0) await saveSites(sites)
    if (plan.settings) await saveSettings(plan.settings)
    if (plan.hasLayout) {
      await setRawLayout(plan.layout)
      await saveLayout(await getLayout())
    }
  } catch (err) {
    try {
      await restoreImportKeys(snapshot)
    } catch (restoreErr) {
      err.restoreError = restoreErr
    }
    throw err
  }

  await rebuildAlarms()
}

// 舊介面：preview 後直接 apply（既有呼叫端不變）
export async function importSettings(json, opts = {}) {
  const { plan, summary } = await previewSettingsImport(json, opts)
  await applySettingsImport(plan)
  return { skippedTasks: summary.tasks.skipped.length, summary }
}

