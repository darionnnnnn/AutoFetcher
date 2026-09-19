// AutoFetcher 通知唯一入口
import { getSettings, updateNotifyLog, updateFailMerge } from '../shared/storage.js'
import { log } from '../shared/diag.js'

// 相對路徑會相對於「呼叫端的位址」解析（service worker 是 /background/），
// 在真實瀏覽器會 404 並讓整則通知不顯示，必須用 getURL 取絕對網址。
const ICON_PATH = 'icons/icon-128.png'

// 失敗通知冷卻：同一個 key 以同一個 status 通知過，24 小時內不再跳〔暫定；AF-21 批次 2 定案 8〕
export const FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000
// 同站台合併：同一個 origin 在這段時間內接連的失敗共用一則通知
export const FAIL_MERGE_WINDOW_MS = 5 * 60 * 1000
// 合併訊息最多列出幾個任務名稱，其餘寫「等」
const MERGE_NAME_LIMIT = 3

// 發送系統通知，若通知關閉或拋錯則回傳 false，成功回傳 true
export async function notify(id, options) {
  const settings = await getSettings()
  if (settings?.notifications === false) {
    return false
  }

  const createOptions = {
    type: 'basic',
    iconUrl: await chrome.runtime.getURL(ICON_PATH),
    title: options.title,
    message: options.message
  }
  if (options.buttons !== undefined) {
    createOptions.buttons = options.buttons
  }

  try {
    if (id == null) {
      await chrome.notifications.create(createOptions)
    } else {
      await chrome.notifications.create(id, createOptions)
    }
    return true
  } catch (err) {
    try {
      await log('notify', { id, error: err?.message || String(err) })
    } catch {
      // 吞掉診斷紀錄例外
    }
    return false
  }
}

// 冷卻判定：通過就在同一次鎖內記帳並回 { prev, entry }（prev 是記帳前的那一筆，可能是 undefined）；被擋回 null（不寫）
async function claimFailure(key, status, nowMs) {
  let claim = null
  await updateNotifyLog((logMap) => {
    const prev = logMap[key]
    if (prev && prev.status === status && typeof prev.at === 'number' && nowMs - prev.at < FAILURE_COOLDOWN_MS) {
      return undefined
    }
    claim = { prev, entry: { status, at: nowMs } }
    logMap[key] = claim.entry
    return logMap
  })
  return claim
}

// 通知沒建成（notify 回 false）：撤回剛記的那筆冷卻，同狀態下一次仍會通知。
// 只在那一筆還是自己記的時候撤（期間別人記了新的就不動）；原本有舊紀錄就放回舊的
async function releaseFailure(key, claim) {
  await updateNotifyLog((logMap) => {
    const cur = logMap[key]
    if (!cur || cur.status !== claim.entry.status || cur.at !== claim.entry.at) return undefined
    if (claim.prev === undefined) delete logMap[key]
    else logMap[key] = claim.prev
    return logMap
  })
}

// 通知是否開著（關著時連冷卻帳本都不記：之後打開要照常通知）
async function notificationsOn() {
  const settings = await getSettings()
  return settings?.notifications !== false
}

/**
 * 失敗通知（帶冷卻）：同一個 key 在 24 小時內已經以同一個 status 通知過就不跳。
 * @param {string} key 冷卻帳本的鍵（任務 id、<任務 id>:precheck、site:<origin>）
 * @param {string} status 失敗狀態；換了狀態就會再跳
 * @param {{ id?: string, title: string, message: string, nowMs?: number }} options id 缺省用 key
 * @returns {Promise<boolean>} 有沒有跳出通知
 */
export async function notifyFailure(key, status, options = {}) {
  if (!(await notificationsOn())) return false
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now()
  const claim = await claimFailure(key, String(status ?? ''), nowMs)
  if (!claim) return false
  const { id, nowMs: _omit, ...rest } = options
  const shown = await notify(id ?? key, rest)
  if (!shown) await releaseFailure(key, claim)
  return shown
}

// 恢復正常時清掉冷卻紀錄：下次再壞就會重新通知。
// 同站台合併的待辦名單也要把它拿掉——恢復正常的任務不該出現在下一則合併通知裡
export async function clearNotifyLog(key) {
  await updateNotifyLog((logMap) => {
    if (!(key in logMap)) return undefined
    delete logMap[key]
    return logMap
  })
  await updateFailMerge((merge) => {
    let changed = false
    for (const [site, entry] of Object.entries(merge)) {
      if (!entry || !Array.isArray(entry.items)) continue
      const kept = entry.items.filter(x => x && x.id !== key)
      if (kept.length === entry.items.length) continue
      changed = true
      if (kept.length === 0) delete merge[site]
      else merge[site] = { ...entry, items: kept }
    }
    return changed ? merge : undefined
  })
}

// 站台的顯示名稱（通知訊息用）
function hostOf(origin) {
  try {
    return new URL(origin).host || origin
  } catch {
    return String(origin || '')
  }
}

// 合併訊息：「example.com 有 3 個任務抓取失敗：A、B、C」，超過 3 個列前 3 個加「等」
export function mergedFailureMessage(origin, names) {
  const shown = names.slice(0, MERGE_NAME_LIMIT).join('、') + (names.length > MERGE_NAME_LIMIT ? '等' : '')
  return `${hostOf(origin)} 有 ${names.length} 個任務抓取失敗：${shown}`
}

/**
 * 抓取失敗通知（冷卻＋同站台合併）：通知 id 一律 fail:<origin>，5 分鐘內同站台的失敗累計在同一則。
 * 被冷卻擋下的任務不列入；累計放 storage.session（worker 被回收也不丟）。
 * @param {string} origin 任務網址的 origin
 * @param {{ id: string, name?: string }} task 任務
 * @param {string} status 失敗狀態
 * @param {{ nowMs?: number, title?: string }} [opts]
 */
export async function notifySiteFailure(origin, task, status, opts = {}) {
  if (!(await notificationsOn())) return false
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now()
  const claim = await claimFailure(task.id, String(status ?? ''), nowMs)
  if (!claim) return false

  const siteKey = String(origin || '')
  let names = []
  await updateFailMerge((merge) => {
    const prev = merge[siteKey]
    const fresh = prev && typeof prev.at === 'number' && nowMs - prev.at < FAIL_MERGE_WINDOW_MS
    const items = fresh && Array.isArray(prev.items) ? prev.items.filter(x => x && x.id !== task.id) : []
    items.push({ id: task.id, name: task.name || task.id })
    // 過期的其他站台一併清掉，session 不會越長越大
    for (const [k, v] of Object.entries(merge)) {
      if (k !== siteKey && !(v && typeof v.at === 'number' && nowMs - v.at < FAIL_MERGE_WINDOW_MS)) delete merge[k]
    }
    merge[siteKey] = { at: nowMs, items }
    names = items.map(x => x.name)
    return merge
  })

  const shown = await notify(`fail:${siteKey}`, {
    title: opts.title || 'AutoFetcher 抓取失敗',
    message: mergedFailureMessage(siteKey, names)
  })
  if (!shown) await releaseFailure(task.id, claim)
  return shown
}
