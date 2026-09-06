// AutoFetcher 紀錄狀態共用模組 (record-status)

export const SUCCESS_STATUSES = ['ok', 'fallback', 'late']
export const WARN_STATUSES = ['fallback', 'late', 'partial']
export const RED_STATUSES = [
  'login_failed',
  'selector_lost',
  'parse_error',
  'failed',
  'not_found',
  'error'
]

const RECORD_TO_HEALTH_STATUS = {
  ok: 'ok',
  fallback: 'fallback',
  late: 'late',
  partial: 'partial',
  not_found: 'selector_lost',
  parse_error: 'parse_error',
  login_failed: 'login_failed',
  error: 'failed'
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

