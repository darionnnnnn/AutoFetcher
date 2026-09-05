// AutoFetcher 紀錄狀態共用模組 (record-status)

export const SUCCESS_STATUSES = ['ok', 'fallback', 'late']

/**
 * 判斷紀錄是否為成功狀態（ok, fallback, late）
 * @param {object|null|undefined} record
 * @returns {boolean}
 */
export function isSuccess(record) {
  if (!record || typeof record !== 'object') return false
  return SUCCESS_STATUSES.includes(record.status)
}
