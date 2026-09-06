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

/**
 * 建立任務序列索引（純函式，不得修改傳入物件）
 * @param {Array} tasks
 * @returns {{ byId: Object, parents: Object, childrenOf: Object, seriesIds: string[] }}
 */
export function buildSeriesIndex(tasks) {
  const byId = {}
  const parents = {}
  const childrenOf = {}
  const seriesIds = []

  if (!Array.isArray(tasks)) {
    return { byId, parents, childrenOf, seriesIds }
  }

  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || task.id === '') {
      continue
    }

    const hasFields = Array.isArray(task.fields) && task.fields.length > 0
    const children = []
    parents[task.id] = task

    if (hasFields) {
      for (const field of task.fields) {
        if (!field || typeof field.key !== 'string' || field.key === '') {
          continue
        }
        const sid = seriesIdOf(task.id, field.key)
        const fieldName = typeof field.name === 'string' ? field.name : ''
        const taskName = typeof task.name === 'string' ? task.name : ''
        byId[sid] = {
          id: sid,
          parentId: task.id,
          name: `${taskName} · ${fieldName}`,
          shortName: fieldName,
          fieldKey: field.key,
          mode: task.mode
        }
        seriesIds.push(sid)
        children.push(sid)
      }
    } else {
      const taskName = typeof task.name === 'string' ? task.name : ''
      byId[task.id] = {
        id: task.id,
        parentId: task.id,
        name: taskName,
        shortName: taskName,
        fieldKey: '',
        mode: task.mode
      }
      seriesIds.push(task.id)
      children.push(task.id)
    }

    childrenOf[task.id] = children
  }

  return { byId, parents, childrenOf, seriesIds }
}

/**
 * 依序列 id 查詢顯示名稱；找不到時回傳 id 本身
 * @param {Object} index
 * @param {string} id
 * @returns {string}
 */
export function nameOf(index, id) {
  if (index && index.byId && index.byId[id] && typeof index.byId[id].name === 'string') {
    return index.byId[id].name
  }
  return id
}
