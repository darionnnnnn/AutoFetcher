// AutoFetcher 紀錄狀態共用模組 (record-status)

const SUCCESS_STATUSES = ['ok', 'fallback', 'late']
export const WARN_STATUSES = ['fallback', 'late', 'partial']
export const RED_STATUSES = [
  'login_failed',
  'selector_lost',
  'parse_error',
  'failed',
  'not_found',
  'error',
  'interrupted'
]

const RECORD_TO_HEALTH_STATUS = {
  ok: 'ok',
  fallback: 'fallback',
  late: 'late',
  partial: 'partial',
  not_found: 'selector_lost',
  parse_error: 'parse_error',
  login_failed: 'login_failed',
  error: 'failed',
  interrupted: 'interrupted'
}

/**
 * 判斷紀錄是否為成功狀態（ok, fallback, late）
 * @param {object|null|undefined} record
 * @returns {boolean}
 */
export function isSuccess(record) {
  if (!record || typeof record !== 'object') return false
  return SUCCESS_STATUSES.includes(record.status)
}

/**
 * 判斷紀錄或 health 物件是否為警示狀態（fallback, late, partial）
 * @param {object|null|undefined} record
 * @returns {boolean}
 */
export function isWarn(record) {
  if (!record || typeof record !== 'object') return false
  return WARN_STATUSES.includes(record.status)
}

/**
 * 判斷紀錄或 health 物件是否為紅色異常狀態
 * @param {object|null|undefined} record
 * @returns {boolean}
 */
export function isRed(record) {
  if (!record || typeof record !== 'object') return false
  return RED_STATUSES.includes(record.status)
}

/**
 * 將紀錄的 status 對應成 health 的 status，表外字串原樣回傳
 * @param {string} recordStatus
 * @returns {string}
 */
export function healthStatusOf(recordStatus) {
  return Object.prototype.hasOwnProperty.call(RECORD_TO_HEALTH_STATUS, recordStatus)
    ? RECORD_TO_HEALTH_STATUS[recordStatus]
    : recordStatus
}


// 狀態代碼 → 白話（紀錄狀態與 health 狀態共用，全站唯一一份；AF-21 定案 12）
const STATUS_TEXT_MAP = {
  ok: '成功',
  fallback: '用備援方式抓到',
  late: '遲到',
  partial: '只抓到部分',
  not_found: '找不到元素',
  selector_lost: '找不到元素',
  parse_error: '抓不到數值',
  login_failed: '無法登入',
  error: '抓取失敗',
  failed: '抓取失敗',
  interrupted: '被瀏覽器中斷'
}

/**
 * 狀態代碼的白話文字；表外代碼原樣回傳
 * @param {string} status
 * @returns {string}
 */
export function statusTextOf(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_TEXT_MAP, status)
    ? STATUS_TEXT_MAP[status]
    : status
}
