// AutoFetcher 報表查詢邏輯：日期範圍、篩選、摘要、月曆、排序、網址狀態 (SPEC §8.3)

// 將 Date 物件轉為 YYYY-MM-DD 本地時間字串
function toDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 快捷日期範圍計算
export function quickRange(kind, nowMs) {
  const base = nowMs != null ? new Date(nowMs) : new Date()
  if (Number.isNaN(base.getTime())) return null
  const y = base.getFullYear(), m = base.getMonth(), d = base.getDate()

  switch (kind) {
    case 'today':
      return { from: toDateString(base), to: toDateString(base) }
    case 'yesterday':
      return { from: toDateString(new Date(y, m, d - 1)), to: toDateString(new Date(y, m, d - 1)) }
    case 'last7': // 含今天共 7 天
      return { from: toDateString(new Date(y, m, d - 6)), to: toDateString(base) }
    case 'last30': // 含今天共 30 天
      return { from: toDateString(new Date(y, m, d - 29)), to: toDateString(base) }
    case 'thisMonth': // 當月一號到當月最後一天
      return { from: toDateString(new Date(y, m, 1)), to: toDateString(new Date(y, m + 1, 0)) }
    case 'lastMonth': // 上月一號到上月最後一天
      return { from: toDateString(new Date(y, m - 1, 1)), to: toDateString(new Date(y, m, 0)) }
    default:
      return null
  }
}

// 依條件篩選紀錄陣列
export function filterRecords(records, filter = {}) {
  if (!Array.isArray(records)) return []
  if (!filter || typeof filter !== 'object') return [...records]

  const { taskIds, statuses, alertOnly, min, max, keyword } = filter
  const hasTaskIds = Array.isArray(taskIds) && taskIds.length > 0
  const hasStatuses = Array.isArray(statuses) && statuses.length > 0
  const kw = (keyword != null && String(keyword).trim() !== '') ? String(keyword).toLowerCase() : null

  return records.filter(r => {
    if (!r) return false
    if (hasTaskIds && !taskIds.includes(r.taskId)) return false
    if (hasStatuses && !statuses.includes(r.status)) return false
    if (alertOnly && r.alert !== true) return false
    if (min !== undefined && min !== null) {
      if (typeof r.value !== 'number' || Number.isNaN(r.value) || r.value < min) return false
    }
    if (max !== undefined && max !== null) {
      if (typeof r.value !== 'number' || Number.isNaN(r.value) || r.value > max) return false
    }
    if (kw) {
      const rawText = r.raw != null ? String(r.raw).toLowerCase() : ''
      const nameText = r.taskName != null ? String(r.taskName).toLowerCase() : ''
      if (!rawText.includes(kw) && !nameText.includes(kw)) return false
    }
    return true
  })
}

// 依任務分組統計摘要資訊
export function summarize(records) {
  if (!Array.isArray(records)) return []
  const groups = new Map()

  for (const r of records) {
    if (!r || !r.taskId) continue
    let g = groups.get(r.taskId)
    if (!g) {
      g = {
        taskId: r.taskId, taskName: r.taskName || r.taskId,
        count: 0, failCount: 0, numValues: [], first: null, last: null
      }
      groups.set(r.taskId, g)
    }
    if (r.taskName && (!g.taskName || g.taskName === g.taskId)) {
      g.taskName = r.taskName
    }

    g.count++

    if (typeof r.value === 'number' && !Number.isNaN(r.value)) {
      g.numValues.push(r.value)
      if (g.first === null) g.first = r.value
      g.last = r.value
    } else {
      g.failCount++
    }
  }

  const result = []
  for (const g of groups.values()) {
    const hasNums = g.numValues.length > 0
    let min = null, max = null, avg = null, delta = null, first = null, last = null

    if (hasNums) {
      min = Math.min(...g.numValues)
      max = Math.max(...g.numValues)
      const sum = g.numValues.reduce((acc, val) => acc + val, 0)
      avg = Math.round((sum / g.numValues.length) * 10000) / 10000
      first = g.first
      last = g.last
      delta = Math.round((last - first) * 10000) / 10000
    }

    result.push({
      taskId: g.taskId, taskName: g.taskName, count: g.count, failCount: g.failCount,
      min, max, avg, first, last, delta
    })
  }

  return result
}

// 產生日曆週陣列，前後補滿整週（週日在第一格）
export function buildCalendar(year, month, statsByDate = {}) {
  const stats = statsByDate || {}
  const firstOfMonth = new Date(year, month - 1, 1)
  const startDate = new Date(year, month - 1, 1 - firstOfMonth.getDay())
  const lastOfMonth = new Date(year, month, 0)
  const endDate = new Date(year, month, 6 - lastOfMonth.getDay())

  const weeks = []
  let currentWeek = []
  const curr = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())

  while (curr <= endDate) {
    const dateStr = toDateString(curr)
    const inMonth = curr.getFullYear() === year && (curr.getMonth() + 1) === month
    const stat = stats[dateStr]

    currentWeek.push({
      date: dateStr,
      day: curr.getDate(),
      inMonth,
      count: stat?.count ?? 0,
      hasFail: !!stat?.hasFail
    })

    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }

    curr.setDate(curr.getDate() + 1)
  }

  return weeks
}

// 依欄位排序紀錄（不改動傳入的陣列，未提供值者永遠排在最後）
export function sortRecords(records, field, dir = 'asc') {
  if (!Array.isArray(records)) return []
  const isDesc = dir === 'desc'

  return [...records].sort((a, b) => {
    const valA = a != null ? a[field] : undefined
    const valB = b != null ? b[field] : undefined

    const aEmpty = valA === undefined || valA === null
    const bEmpty = valB === undefined || valB === null

    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1

    const diff = (typeof valA === 'number' && typeof valB === 'number')
      ? valA - valB
      : String(valA).localeCompare(String(valB))

    return isDesc ? -diff : diff
  })
}

// 解析 URL Hash 為報表狀態物件
export function parseHash(hash) {
  const defaultState = { view: 'history' }
  if (!hash || typeof hash !== 'string') return defaultState

  try {
    let raw = hash.startsWith('#') ? hash.slice(1) : hash
    if (raw.startsWith('?')) raw = raw.slice(1)
    if (!raw) return defaultState

    const params = new URLSearchParams(raw)
    const result = {}

    const view = params.get('view')
    result.view = view || 'history'

    const from = params.get('from')
    if (from) result.from = from

    const to = params.get('to')
    if (to) result.to = to

    const taskIdsStr = params.get('taskIds')
    if (taskIdsStr !== null && taskIdsStr !== '') {
      result.taskIds = taskIdsStr.split(',').filter(Boolean)
    }

    const statusesStr = params.get('statuses')
    if (statusesStr !== null && statusesStr !== '') {
      result.statuses = statusesStr.split(',').filter(Boolean)
    }

    return result
  } catch {
    return defaultState
  }
}

// 將報表狀態物件轉換為 URL Hash 字串
export const buildHash = function (state = {}) {
  if (!state || typeof state !== 'object') return '#view=history'
  const params = new URLSearchParams()
  if (state.view) params.set('view', state.view)
  if (state.from) params.set('from', state.from)
  if (state.to) params.set('to', state.to)
  if (Array.isArray(state.taskIds) && state.taskIds.length > 0) {
    params.set('taskIds', state.taskIds.join(','))
  }
  if (Array.isArray(state.statuses) && state.statuses.length > 0) {
    params.set('statuses', state.statuses.join(','))
  }
  const qs = params.toString()
  return qs ? `#${qs}` : '#'
}



