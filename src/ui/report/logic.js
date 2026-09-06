// AutoFetcher 報表查詢邏輯：日期範圍、篩選、摘要、月曆、排序、網址狀態 (SPEC §8.3)
import { isSuccess } from '../../shared/record-status.js'

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

  const { taskIds, statuses, alertOnly, alertsOnly, min, max, valueMin, valueMax, keyword } = filter
  const hasTaskIds = Array.isArray(taskIds) && taskIds.length > 0
  const hasStatuses = Array.isArray(statuses) && statuses.length > 0
  const kw = (keyword != null && String(keyword).trim() !== '') ? String(keyword).toLowerCase() : null
  const vMin = valueMin !== undefined ? valueMin : min
  const vMax = valueMax !== undefined ? valueMax : max

  return records.filter(r => {
    if (!r) return false
    if (hasTaskIds && !taskIds.includes(r.taskId)) return false
    if (hasStatuses && !statuses.includes(r.status)) return false
    if (alertsOnly) {
      if (isSuccess(r)) return false
    }
    if (alertOnly && r.alert !== true) return false
    if (vMin !== undefined && vMin !== null) {
      if (typeof r.value !== 'number' || Number.isNaN(r.value) || r.value < vMin) return false
    }
    if (vMax !== undefined && vMax !== null) {
      if (typeof r.value !== 'number' || Number.isNaN(r.value) || r.value > vMax) return false
    }
    if (kw) {
      const rawText = r.raw != null ? String(r.raw).toLowerCase() : ''
      const nameText = r.taskName != null ? String(r.taskName).toLowerCase() : ''
      const valText = r.value != null ? String(r.value).toLowerCase() : ''
      if (!rawText.includes(kw) && !nameText.includes(kw) && !valText.includes(kw)) return false
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

// 依日期彙總月曆需要的統計：筆數、有沒有失敗、有沒有命中告警
export function buildDateStats(records = [], isSuccessFn) {
  const stats = {}
  for (const r of records) {
    if (!r?.date) continue
    if (!stats[r.date]) stats[r.date] = { count: 0, hasFail: false, hasAlert: false }
    stats[r.date].count++
    if (!isSuccessFn(r)) stats[r.date].hasFail = true
    if (r.alert === true) stats[r.date].hasAlert = true
  }
  return stats
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
      hasFail: !!stat?.hasFail,
      hasAlert: !!stat?.hasAlert
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

// 分頁輔助函式：切分陣列並夾持頁碼在合法範圍（1 ~ totalPages）
export function paginate(rows = [], page = 1, pageSize = 500) {
  const list = Array.isArray(rows) ? rows : []
  const size = (typeof pageSize === 'number' && pageSize > 0) ? pageSize : 500
  const totalPages = Math.max(1, Math.ceil(list.length / size))
  let p = (typeof page === 'number' && !Number.isNaN(page)) ? page : 1
  if (p < 1) p = 1
  if (p > totalPages) p = totalPages
  const start = (p - 1) * size
  const items = list.slice(start, start + size)
  return { items, page: p, totalPages }
}

// 比較兩天的紀錄並計算數值差異
export function compareDays(recordsA = [], recordsB = [], taskIds = []) {
  const recsA = Array.isArray(recordsA) ? recordsA : []
  const recsB = Array.isArray(recordsB) ? recordsB : []

  const extractTime = (slot) => {
    if (!slot || typeof slot !== 'string') return ''
    const match = slot.match(/(\d{2}:\d{2})/)
    return match ? match[1] : slot.slice(0, 5)
  }

  const timeSet = new Set()
  const mapA = new Map()
  const mapB = new Map()

  for (const r of recsA) {
    if (!r || !r.slot) continue
    const time = extractTime(r.slot)
    if (!time) continue
    timeSet.add(time)
    if (!mapA.has(time)) mapA.set(time, new Map())
    mapA.get(time).set(r.taskId, r)
  }

  for (const r of recsB) {
    if (!r || !r.slot) continue
    const time = extractTime(r.slot)
    if (!time) continue
    timeSet.add(time)
    if (!mapB.has(time)) mapB.set(time, new Map())
    mapB.get(time).set(r.taskId, r)
  }

  let ids = taskIds
  if (!Array.isArray(ids) || ids.length === 0) {
    const allIds = new Set()
    for (const r of recsA) if (r && r.taskId) allIds.add(r.taskId)
    for (const r of recsB) if (r && r.taskId) allIds.add(r.taskId)
    ids = [...allIds]
  }

  const sortedTimes = [...timeSet].sort()
  const rows = sortedTimes.map(time => {
    const values = {}
    for (const id of ids) {
      const rA = mapA.get(time)?.get(id)
      const rB = mapB.get(time)?.get(id)
      const valA = (rA && rA.value !== undefined && rA.value !== null) ? rA.value : null
      const valB = (rB && rB.value !== undefined && rB.value !== null) ? rB.value : null
      let delta = null
      if (valA !== null && valB !== null && typeof valA === 'number' && typeof valB === 'number') {
        delta = Math.round((valB - valA) * 10000) / 10000
      }
      values[id] = { a: valA, b: valB, delta }
    }
    return { time, values }
  })

  return { rows }
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

    const dash = params.get('dash')
    if (dash) result.dash = dash

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

    const vMin = params.get('valueMin')
    if (vMin !== null && vMin !== '' && !Number.isNaN(Number(vMin))) {
      result.valueMin = Number(vMin)
    }

    const vMax = params.get('valueMax')
    if (vMax !== null && vMax !== '' && !Number.isNaN(Number(vMax))) {
      result.valueMax = Number(vMax)
    }

    const keyword = params.get('keyword')
    if (keyword !== null && keyword !== '') {
      result.keyword = keyword
    }

    const alertsOnly = params.get('alertsOnly')
    if (alertsOnly === '1' || alertsOnly === 'true') {
      result.alertsOnly = true
    }

    const page = params.get('page')
    if (page !== null && page !== '' && !Number.isNaN(Number(page))) {
      result.page = Number(page)
    }

    const compareTo = params.get('compareTo')
    if (compareTo !== null && compareTo !== '') {
      result.compareTo = compareTo
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
  if (state.dash) params.set('dash', state.dash)
  if (state.from) params.set('from', state.from)
  if (state.to) params.set('to', state.to)
  if (Array.isArray(state.taskIds) && state.taskIds.length > 0) {
    params.set('taskIds', state.taskIds.join(','))
  }
  if (Array.isArray(state.statuses) && state.statuses.length > 0) {
    params.set('statuses', state.statuses.join(','))
  }
  if (state.valueMin !== undefined && state.valueMin !== null && !Number.isNaN(Number(state.valueMin))) {
    params.set('valueMin', String(state.valueMin))
  }
  if (state.valueMax !== undefined && state.valueMax !== null && !Number.isNaN(Number(state.valueMax))) {
    params.set('valueMax', String(state.valueMax))
  }
  if (state.keyword) {
    params.set('keyword', state.keyword)
  }
  if (state.alertsOnly) {
    params.set('alertsOnly', '1')
  }
  if (state.page !== undefined && state.page !== null && !Number.isNaN(Number(state.page))) {
    params.set('page', String(state.page))
  }
  if (state.compareTo) {
    params.set('compareTo', state.compareTo)
  }
  const qs = params.toString()
  return qs ? `#${qs}` : '#'
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

function parseUtcDate(str) {
  if (typeof str !== 'string' || !DATE_REGEX.test(str)) return null
  const [y, m, d] = str.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null
  }
  return dt
}

function formatUtcDate(date) {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 日期範圍平移（days 為位移天數，正數往後、負數往前）
export function shiftRange(from, to, days = 0) {
  const dFrom = parseUtcDate(from)
  const dTo = parseUtcDate(to)
  if (!dFrom || !dTo) return null
  if (typeof days !== 'number' || Number.isNaN(days)) return null
  if (days === 0) return { from, to }

  dFrom.setUTCDate(dFrom.getUTCDate() + days)
  dTo.setUTCDate(dTo.getUTCDate() + days)

  return {
    from: formatUtcDate(dFrom),
    to: formatUtcDate(dTo)
  }
}

// 標準化日期範圍：若 from 晚於 to 則交換
export function normalizeRange(from, to) {
  if (from > to) {
    return { from: to, to: from }
  }
  return { from, to }
}




