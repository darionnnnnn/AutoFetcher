// AutoFetcher 序列 id 共用模組 (series-index)
//
// 一個任務可以抓多個值（SPEC §7）。每個值在紀錄、卡片來源、告警紀錄裡
// 都以「子序列 id」表示：父任務 id 與值 key 以保留字元相接。
// 排程 alarm、執行帳本、health、missed 一律用父任務 id。
//
// 組合與拆解只有這一份，其他模組不得自行字串處理。

// 分隔字元（保留字元，task.id 與 field key 都不得包含它）
export const SERIES_SEP = '#'

/**
 * 組出子序列 id；沒有 key 時回傳父任務 id 本身（單值任務）
 * @param {string} taskId
 * @param {string} [fieldKey]
 * @returns {string}
 */
export function seriesIdOf(taskId, fieldKey) {
  const base = typeof taskId === 'string' ? taskId : ''
  if (typeof fieldKey !== 'string' || fieldKey === '') return base
  return `${base}${SERIES_SEP}${fieldKey}`
}

/**
 * 取出父任務 id；不是子序列 id 時原樣回傳（單值任務的紀錄照樣適用）
 * @param {string} id
 * @returns {string}
 */
export function parentIdOf(id) {
  if (typeof id !== 'string') return ''
  const at = id.indexOf(SERIES_SEP)
  return at === -1 ? id : id.slice(0, at)
}

/**
 * 取出值 key；單值任務（沒有分隔字元）回傳空字串
 * @param {string} id
 * @returns {string}
 */
export function fieldKeyOf(id) {
  if (typeof id !== 'string') return ''
  const at = id.indexOf(SERIES_SEP)
  return at === -1 ? '' : id.slice(at + SERIES_SEP.length)
}
