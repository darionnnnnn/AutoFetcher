import {
  quickRange, filterRecords, summarize, buildCalendar,
  sortRecords, parseHash, buildHash,
  shiftRange, normalizeRange, paginate, compareDays, buildDateStats } from './logic.js'
import {
  getRecordsInRange, getRecordsByDate, deleteRecord,
  getSettings, saveSettings, getTasks,
  getHealthMap, getMissedList,
  subscribe
} from '../../shared/storage.js'
import { getLayout } from '../../shared/layout-store.js'
import { applyTheme } from '../theme-apply.js'
import { buildSeries, pivot } from './series.js'
import { lineChart } from './charts.js'
import { buildTsv } from './cards.js'
import { confirmDialog } from '../modal.js'
import { renderTasks, focusTaskRow } from './tasks.js'
import { renderSettings } from './settings.js'
import { renderDashboard, refreshDashboard, dashboardDataRange } from './dashboard.js'
import { isSuccess, statusTextOf } from '../../shared/record-status.js'
import { MSG } from '../../shared/messages.js'
import { buildSeriesIndex, nameOf } from '../../shared/series-index.js'
import { computeHealth } from '../../background/health.js'
import { icon, setIcon, levelChipOf } from '../icons.js'

// 頁籤順序（方向鍵在這四個之間移動）
const TABS = ['dashboard', 'history', 'tasks', 'settings']

// 紀錄明細列的 id 流水號（展開鈕的 aria-controls 指向它）
let detailSeq = 0

const DEFAULT_COLUMNS = [
  { key: 'slot', label: '時間', visible: true },
  { key: 'taskName', label: '任務', visible: true },
  { key: 'value', label: '值', visible: true },
  { key: 'status', label: '狀態', visible: true },
  { key: 'strategyUsed', label: '策略', visible: false }
]

const state = {
  view: 'dashboard',
  dash: null,
  from: '',
  to: '',
  taskIds: [],
  statuses: [],
  sortField: null,
  sortDir: 'asc',
  valueMin: null,
  valueMax: null,
  keyword: '',
  failedOnly: false,
  alertOnly: false,
  task: null,
  page: 1,
  compareTo: ''
}

let currentColumns = [...DEFAULT_COLUMNS]
let lastRecords = []
let lastColumns = currentColumns
let allLoadedRecords = []
let currentCalYear = 2026
let currentCalMonth = 9
let isCalDragging = false
let calDragStart = null
let calDragCurrent = null

// 格式化單一值：數值使用 toLocaleString，字串維持原樣，null/undefined 顯示破折號
function formatValue(val) {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'number') return Number.isNaN(val) ? '—' : val.toLocaleString()
  return String(val)
}

// 建立單一表格列元素 (tr)
function createTableRow(cells, isHeader = false, options = {}) {
  const tr = document.createElement('tr')
  if (options.className) tr.className = options.className
  const tag = isHeader ? 'th' : 'td'
  for (const cell of cells) {
    const el = document.createElement(tag)
    if (typeof cell === 'object' && cell !== null && !cell.nodeType) {
      if (cell.key) el.dataset.key = cell.key
      if (cell.text !== undefined) el.textContent = cell.text
      if (cell.colSpan) el.colSpan = cell.colSpan
      if (cell.className) el.className = cell.className
    } else {
      el.textContent = cell != null ? String(cell) : '—'
    }
    tr.appendChild(el)
  }
  return tr
}

// 紀錄本身只存 taskId；顯示用的任務名在載入時由任務清單併入（已刪任務退回顯示 taskId）
export function joinTaskNames(records = [], tasks = []) {
  const index = buildSeriesIndex(tasks)
  return records.map(r => ({ ...r, taskName: r.taskName ?? nameOf(index, r.taskId) }))
}

export function getState() {
  return state
}

export function initFromHash(hash) {
  let parsed = {}
  try { parsed = parseHash(hash) || {} } catch { parsed = {} }
  const raw = (typeof hash === 'string') ? hash.replace(/^[#?]/, '') : ''
  const params = new URLSearchParams(raw)
  if (params.has('view')) {
    state.view = parsed.view
  } else {
    state.view = 'dashboard'
  }
  state.dash = parsed.dash || null
  state.taskIds = parsed.taskIds || []
  state.statuses = parsed.statuses || []

  const today = quickRange('today', Date.now())
  state.from = parsed.from || (today ? today.from : '')
  state.to = parsed.to || (today ? today.to : '')
  state.valueMin = parsed.valueMin !== undefined ? parsed.valueMin : null
  state.valueMax = parsed.valueMax !== undefined ? parsed.valueMax : null
  state.keyword = parsed.keyword || ''
  state.failedOnly = parsed.failedOnly === true
  state.alertOnly = parsed.alertOnly === true
  // 只用一次：定位完就清掉，之後的重畫與切頁不再捲動
  state.task = parsed.task || null
  state.page = parsed.page || 1
  state.compareTo = parsed.compareTo || ''

  if (typeof document !== 'undefined') {
    renderRangeBar()
    setupTableMode()
    const fromInput = document.getElementById('range-from')
    const toInput = document.getElementById('range-to')
    if (fromInput) fromInput.value = state.from || ''
    if (toInput) toInput.value = state.to || ''
  }
}

let currentTableMode = 'list'
let activeFilterContainer = null
let activeFilterHandler = null

async function renderCurrentHistoryTable(filtered, tasks) {
  const sel = document.getElementById('table-mode')
  const mode = sel?.value || currentTableMode || 'list'
  if (mode === 'pivot') {
    renderPivot(filtered, tasks)
  } else {
    const isLarge = isOver90Days(state.from, state.to)
    renderTable(filtered, currentColumns, isLarge ? { paginate: true, page: state.page || 1, pageSize: 500 } : {})
  }
}

export function setupTableMode() {
  if (typeof document === 'undefined') return
  const sel = document.getElementById('table-mode')
  if (!sel) return
  sel.value = currentTableMode || 'list'
  sel.onchange = async () => {
    const mode = sel.value || 'list'
    currentTableMode = mode
    try {
      const settings = await getSettings()
      const oldHistory = (settings && typeof settings.history === 'object') ? settings.history : {}
      await saveSettings({
        history: { ...oldHistory, tableMode: mode }
      })
    } catch {}

    let tasks = []
    try { tasks = await getTasks() } catch {}
    let records = allLoadedRecords
    if (state.from && state.to && (!records || records.length === 0)) {
      const raw = await getRecordsInRange(state.from, state.to)
      records = joinTaskNames(raw, tasks)
      allLoadedRecords = records
    }
    const filtered = filterRecords(allLoadedRecords, {
      taskIds: state.taskIds,
      statuses: state.statuses,
      failedOnly: state.failedOnly,
      alertOnly: state.alertOnly,
      valueMin: state.valueMin,
      valueMax: state.valueMax,
      keyword: state.keyword
    })
    await renderCurrentHistoryTable(filtered, tasks)
    renderSummary(summarize(filtered))
  }
}

function isOver90Days(from, to) {
  if (!from || !to) return false
  const ms = new Date(to).getTime() - new Date(from).getTime()
  const days = Math.round(ms / 86400000) + 1
  return days > 90
}

async function onFilterChange() {
  const container = document.getElementById('filters')
  if (!container) return
  const tasksContainer = container.querySelector('#filter-tasks')
  const statusesContainer = container.querySelector('#filter-statuses')
  const failedCb = container.querySelector('#filter-failed-only')
  const alertCb = container.querySelector('#filter-alert-only')
  const valMinInput = container.querySelector('#filter-value-min')
  const valMaxInput = container.querySelector('#filter-value-max')
  const kwInput = container.querySelector('#filter-keyword')

  state.taskIds = tasksContainer
    ? [...tasksContainer.querySelectorAll('input:checked')]
        .filter(cb => !cb.dataset.parent)
        .map(cb => cb.value)
    : []
  state.statuses = statusesContainer ? [...statusesContainer.querySelectorAll('input:checked')].map(cb => cb.value) : []
  state.failedOnly = failedCb ? failedCb.checked : false
  state.alertOnly = alertCb ? alertCb.checked : false
  state.valueMin = (valMinInput && valMinInput.value !== '') ? Number(valMinInput.value) : null
  state.valueMax = (valMaxInput && valMaxInput.value !== '') ? Number(valMaxInput.value) : null
  state.keyword = kwInput ? kwInput.value.trim() : ''

  if (typeof window !== 'undefined') {
    window.location.hash = buildHash(state)
  }

  await applyCurrentFilters()
}

async function applyCurrentFilters() {
  let tasks = []
  try { tasks = await getTasks() } catch {}
  if (state.from && state.to) {
    const raw = await getRecordsInRange(state.from, state.to)
    allLoadedRecords = joinTaskNames(raw, tasks)
  }
  const filtered = filterRecords(allLoadedRecords, {
    taskIds: state.taskIds,
    statuses: state.statuses,
    failedOnly: state.failedOnly,
    alertOnly: state.alertOnly,
    valueMin: state.valueMin,
    valueMax: state.valueMax,
    keyword: state.keyword
  })
  await renderCurrentHistoryTable(filtered, tasks)
  renderSummary(summarize(filtered))
}

export async function renderFilters() {
  const container = document.getElementById('filters')
  if (!container) return
  container.textContent = ''

  if (activeFilterContainer && activeFilterHandler) {
    activeFilterContainer.removeEventListener('change', activeFilterHandler)
  }
  activeFilterContainer = container
  activeFilterHandler = onFilterChange
  container.addEventListener('change', activeFilterHandler)

  let tasks = []
  try { tasks = await getTasks() } catch {}

  // 1. 任務多選容器 #filter-tasks
  const tasksContainer = document.createElement('div')
  tasksContainer.id = 'filter-tasks'
  const seriesIndex = buildSeriesIndex(tasks)

  for (const t of tasks) {
    if (!t || !t.id) continue
    const taskGroup = document.createElement('div')
    taskGroup.className = 'filter-task-group'

    const parentLabel = document.createElement('label')
    const parentCb = document.createElement('input')
    parentCb.type = 'checkbox'
    parentCb.value = t.id

    parentLabel.appendChild(parentCb)
    parentLabel.appendChild(document.createTextNode(` ${t.name || t.id}`))
    taskGroup.appendChild(parentLabel)

    const isMulti = Array.isArray(t.fields) && t.fields.length > 0
    if (isMulti) {
      parentCb.dataset.parent = 'true'
      const childrenContainer = document.createElement('div')
      childrenContainer.className = 'filter-task-children'

      const childCbs = []
      const children = seriesIndex.childrenOf[t.id] || []

      function updateParentState() {
        const checkedCount = childCbs.filter(c => c.checked).length
        if (checkedCount === childCbs.length) {
          parentCb.checked = true
          parentCb.indeterminate = false
        } else if (checkedCount > 0) {
          parentCb.checked = false
          parentCb.indeterminate = true
        } else {
          parentCb.checked = false
          parentCb.indeterminate = false
        }
      }

      parentCb.addEventListener('change', () => {
        parentCb.indeterminate = false
        for (const c of childCbs) {
          c.checked = parentCb.checked
        }
      })

      for (const sid of children) {
        const item = seriesIndex.byId[sid]
        const childLabel = document.createElement('label')
        const childCb = document.createElement('input')
        childCb.type = 'checkbox'
        childCb.value = sid
        childCb.checked = Array.isArray(state.taskIds) && (state.taskIds.includes(sid) || state.taskIds.includes(t.id))
        childCbs.push(childCb)

        childLabel.appendChild(childCb)
        childLabel.appendChild(document.createTextNode(` ${item?.shortName || item?.name || sid}`))
        childrenContainer.appendChild(childLabel)

        childCb.addEventListener('change', () => {
          updateParentState()
        })
      }

      updateParentState()
      taskGroup.appendChild(childrenContainer)
    } else {
      parentCb.checked = Array.isArray(state.taskIds) && state.taskIds.includes(t.id)
    }

    tasksContainer.appendChild(taskGroup)
  }

  // 2. 狀態多選容器 #filter-statuses
  const statusesContainer = document.createElement('div')
  statusesContainer.id = 'filter-statuses'
  // 標籤文字只經 statusTextOf（全站唯一一份），格式「白話 (代碼)」
  const allStatuses = ['ok', 'fallback', 'late', 'not_found', 'parse_error', 'login_failed', 'error', 'interrupted']
    .map(key => ({ key, label: `${statusTextOf(key)} (${key})` }))
  for (const item of allStatuses) {
    const label = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = item.key
    cb.checked = Array.isArray(state.statuses) && state.statuses.includes(item.key)
    label.appendChild(cb)
    label.appendChild(document.createTextNode(` ${item.label}`))
    statusesContainer.appendChild(label)
  }

  // 3. 只看失敗 #filter-failed-only（不成功的紀錄）與只看告警 #filter-alert-only（alert === true），兩者可同時勾＝交集
  const failedLabel = document.createElement('label')
  const failedCb = document.createElement('input')
  failedCb.type = 'checkbox'
  failedCb.id = 'filter-failed-only'
  failedCb.checked = !!state.failedOnly
  failedLabel.append(failedCb, ' ', '只看失敗')

  const alertsLabel = document.createElement('label')
  const alertCb = document.createElement('input')
  alertCb.type = 'checkbox'
  alertCb.id = 'filter-alert-only'
  alertCb.checked = !!state.alertOnly
  alertsLabel.append(alertCb, ' ', '只看告警')

  // 4. 值範圍 #filter-value-min, #filter-value-max
  const valMinLabel = document.createElement('label')
  valMinLabel.textContent = '數值下限：'
  const valMinInput = document.createElement('input')
  valMinInput.type = 'number'
  valMinInput.id = 'filter-value-min'
  if (state.valueMin !== null && state.valueMin !== undefined) {
    valMinInput.value = String(state.valueMin)
  }
  valMinLabel.appendChild(valMinInput)

  const valMaxLabel = document.createElement('label')
  valMaxLabel.textContent = '數值上限：'
  const valMaxInput = document.createElement('input')
  valMaxInput.type = 'number'
  valMaxInput.id = 'filter-value-max'
  if (state.valueMax !== null && state.valueMax !== undefined) {
    valMaxInput.value = String(state.valueMax)
  }
  valMaxLabel.appendChild(valMaxInput)

  // 5. 關鍵字 #filter-keyword
  const kwLabel = document.createElement('label')
  kwLabel.textContent = '關鍵字：'
  const kwInput = document.createElement('input')
  kwInput.type = 'text'
  kwInput.id = 'filter-keyword'
  kwInput.placeholder = '搜尋數值或原文...'
  if (state.keyword) {
    kwInput.value = state.keyword
  }
  kwLabel.appendChild(kwInput)

  container.appendChild(tasksContainer)
  container.appendChild(statusesContainer)
  container.appendChild(failedLabel)
  container.appendChild(alertsLabel)
  container.appendChild(valMinLabel)
  container.appendChild(valMaxLabel)
  container.appendChild(kwLabel)
}

export async function loadAndRenderTasks() {
  try {
    const tasks = await getTasks()
    let health = {}
    let missed = []
    try {
      health = await getHealthMap()
      missed = await getMissedList()
    } catch {}

    const nextRuns = {}
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.GET_NEXT_RUNS })
      if (res?.nextRuns) {
        for (const [taskId, time] of Object.entries(res.nextRuns)) {
          if (typeof time === 'number') {
            const d = new Date(time)
            const y = d.getFullYear()
            const m = String(d.getMonth() + 1).padStart(2, '0')
            const day = String(d.getDate()).padStart(2, '0')
            const h = String(d.getHours()).padStart(2, '0')
            const min = String(d.getMinutes()).padStart(2, '0')
            nextRuns[taskId] = `${y}-${m}-${day} ${h}:${min}`
          } else if (time) {
            nextRuns[taskId] = String(time)
          }
        }
      }
    } catch {}

    renderTasks(tasks, health, missed, { nextRuns })
  } catch (err) {
    console.error('載入任務失敗:', err)
  }
}

export function showTab(name) {
  state.view = name
  for (const tab of TABS) {
    const panel = document.getElementById(`panel-${tab}`)
    if (panel) panel.hidden = (tab !== name)
    // 螢幕閱讀器靠 aria-selected 知道在哪一頁；roving tabindex：Tab 鍵只停在目前這一頁的頁籤
    const btn = document.getElementById(`tab-${tab}`)
    if (btn) {
      btn.setAttribute('aria-selected', tab === name ? 'true' : 'false')
      btn.tabIndex = tab === name ? 0 : -1
    }
  }
  // 日期範圍只影響儀表板（卡片的全局區間）與歷史頁；任務頁與設定頁顯示它會讓人以為清單被日期篩過
  const rangeBar = document.getElementById('range-bar')
  if (rangeBar) rangeBar.hidden = !(name === 'dashboard' || name === 'history')
  if (name === 'dashboard') {
    getLayout().then(l => {
      const targetId = state.dash || l?.lastDashboardId || l?.dashboards?.[0]?.id
      renderDashboard(targetId)
    }).catch(() => {})
  }
  if (name === 'tasks') {
    const focusId = state.task
    state.task = null
    return loadAndRenderTasks().then(() => {
      if (focusId) focusTaskRow(focusId)
    })
  }
  if (name === 'settings') {
    renderSettings()
  }
}

/**
 * 頁籤的點擊與方向鍵（WAI-ARIA tabs：←／→ 換頁並移焦點，Home／End 到頭尾）。
 * 用 onclick／onkeydown 指派，重複呼叫不會累加監聽
 */
export function setupTabs() {
  const go = (tab, focus) => {
    showTab(tab)
    if (typeof window !== 'undefined') window.location.hash = buildHash(state)
    if (focus) document.getElementById(`tab-${tab}`)?.focus()
  }
  for (const tab of TABS) {
    const btn = document.getElementById(`tab-${tab}`)
    if (!btn) continue
    btn.onclick = () => go(tab, false)
    btn.onkeydown = (e) => {
      const i = TABS.indexOf(tab)
      let next = null
      if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length]
      else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length]
      else if (e.key === 'Home') next = TABS[0]
      else if (e.key === 'End') next = TABS[TABS.length - 1]
      if (!next) return
      e.preventDefault()
      go(next, true)
    }
  }
}

/**
 * 應用列右側的燈號 chip＋摘要句（與 popup 同一份燈號算法 computeHealth、同一份 chip 對照 levelChipOf）
 */
export async function renderAppStatus() {
  const chip = document.getElementById('app-status-chip')
  const summary = document.getElementById('app-status-summary')
  if (!chip && !summary) return
  let health = { level: 'off', summary: '' }
  try {
    const [tasks, healthMap, missed] = await Promise.all([getTasks(), getHealthMap(), getMissedList()])
    health = computeHealth(tasks, healthMap, missed)
  } catch {}
  const { cls, text } = levelChipOf(health.level)
  if (chip) {
    chip.className = `chip ${cls}`
    chip.textContent = text
  }
  if (summary) {
    summary.textContent = health.summary || ''
    summary.title = health.summary || ''
  }
}

// 會整份重畫的鍵（任務清單或版面變了，側欄、頁籤、卡片組成都可能不同）
const STRUCTURE_KEYS = new Set(['tasks', 'layout'])
// 不是紀錄、但卡片或任務頁會顯示的鍵
const STATUS_KEYS = new Set(['lastValues', 'health', 'missed'])

/**
 * 變動的紀錄日期與範圍有沒有交集；範圍不完整時一律當作有
 */
export function datesIntersect(dates, from, to) {
  if (!from || !to) return true
  for (const d of dates || []) {
    if (typeof d === 'string' && d >= from && d <= to) return true
  }
  return false
}

/**
 * 依 storage 的變動決定要不要重畫、重畫多少（AF-21 批次 6）。
 * 不帶 change（使用者操作後的主動刷新）＝照舊整份重畫。
 * @param {{ keys: Set<string>, dates: Set<string> }} [change]
 */
export async function refreshCurrentView(change) {
  const currentView = state.view || 'dashboard'
  const keys = change?.keys instanceof Set ? change.keys : null
  const dates = change?.dates instanceof Set ? change.dates : new Set()
  let structural = !keys
  let status = false
  let records = false
  if (keys) {
    for (const k of keys) {
      if (STRUCTURE_KEYS.has(k)) structural = true
      else if (STATUS_KEYS.has(k)) status = true
      else records = true
    }
  }
  // 應用列的燈號跟著任務與健康狀態走（純紀錄變動不影響燈號）
  if (structural || status) renderAppStatus()
  if (currentView === 'dashboard') {
    try {
      if (structural) {
        const l = await getLayout()
        const targetId = state.dash || l?.lastDashboardId || l?.dashboards?.[0]?.id
        await refreshDashboard({ full: true, dashId: targetId })
        return
      }
      if (!status) {
        if (!records) return
        // 儀表板的範圍是各卡片自己的區間設定合起來（與實際讀紀錄的範圍同一份）
        const range = await dashboardDataRange()
        if (range && !datesIntersect(dates, range.from, range.to)) return
      }
      await refreshDashboard({ full: false })
    } catch {}
    return
  }
  if (currentView !== 'tasks' && currentView !== 'history') return
  if (!structural && !status) {
    if (!records) return
    if (!datesIntersect(dates, state.from, state.to)) return
  }
  if (currentView === 'tasks') {
    await loadAndRenderTasks()
    return
  }
  await applyCurrentFilters()
}

export function renderTable(records = [], columns = currentColumns, opts = {}) {
  lastRecords = Array.isArray(records) ? [...records] : []
  lastColumns = Array.isArray(columns) ? [...columns] : currentColumns

  const table = document.getElementById('record-table')
  const emptyState = document.getElementById('empty-state')
  if (!table) return

  let thead = table.querySelector('thead')
  if (!thead) { thead = document.createElement('thead'); table.appendChild(thead) }
  thead.textContent = ''

  let tbody = table.querySelector('tbody')
  if (!tbody) { tbody = document.createElement('tbody'); table.appendChild(tbody) }
  tbody.textContent = ''

  const visibleCols = lastColumns.filter(c => c && c.visible !== false)
  const headerCells = visibleCols.map(c => ({ key: c.key, text: c.label || c.key }))
  const trHead = createTableRow(headerCells, true)
  trHead.querySelectorAll('th').forEach((th, idx) => {
    const col = visibleCols[idx]
    th.addEventListener('click', () => {
      state.sortDir = (state.sortField === col.key && state.sortDir === 'asc') ? 'desc' : 'asc'
      state.sortField = col.key
      const sorted = sortRecords(lastRecords, state.sortField, state.sortDir)
      renderTable(sorted, lastColumns, opts)
    })
  })
  thead.appendChild(trHead)

  // 處理複製 TSV 按鈕
  const copyBtn = document.querySelector('[data-action="copy-records-tsv"]')
  if (copyBtn) {
    const nav = typeof navigator !== 'undefined' ? navigator : (typeof window !== 'undefined' ? window.navigator : null)
    if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') {
      copyBtn.hidden = true
    } else {
      copyBtn.hidden = false
      copyBtn.onclick = () => {
        const tsvHeaders = visibleCols.map(c => c.label || c.key)
        const tsvRows = lastRecords.map(r => visibleCols.map(c => r[c.key]))
        const tsv = buildTsv([tsvHeaders, ...tsvRows])
        nav.clipboard.writeText(tsv).catch(() => {})
      }
    }
  }

  // 處理分頁
  let displayRecords = lastRecords
  const pager = document.getElementById('record-pager')
  if (opts && opts.paginate) {
    const page = opts.page || state.page || 1
    const pageSize = opts.pageSize || 500
    const paged = paginate(lastRecords, page, pageSize)
    displayRecords = paged.items
    if (pager) {
      pager.hidden = false
      pager.textContent = ''

      const prevBtn = document.createElement('button')
      prevBtn.type = 'button'
      prevBtn.dataset.action = 'prev-page'
      prevBtn.textContent = '上一頁'
      prevBtn.disabled = paged.page <= 1
      prevBtn.onclick = () => {
        state.page = paged.page - 1
        if (typeof window !== 'undefined') window.location.hash = buildHash(state)
        renderTable(lastRecords, lastColumns, { paginate: true, page: state.page, pageSize })
      }

      const textSpan = document.createElement('span')
      textSpan.className = 'pager-text'
      textSpan.textContent = `第 ${paged.page} / ${paged.totalPages} 頁`

      const nextBtn = document.createElement('button')
      nextBtn.type = 'button'
      nextBtn.dataset.action = 'next-page'
      nextBtn.textContent = '下一頁'
      nextBtn.disabled = paged.page >= paged.totalPages
      nextBtn.onclick = () => {
        state.page = paged.page + 1
        if (typeof window !== 'undefined') window.location.hash = buildHash(state)
        renderTable(lastRecords, lastColumns, { paginate: true, page: state.page, pageSize })
      }

      pager.appendChild(prevBtn)
      pager.appendChild(textSpan)
      pager.appendChild(nextBtn)
    }
  } else {
    if (pager) pager.hidden = true
  }

  if (lastRecords.length === 0) {
    if (emptyState) emptyState.hidden = false
    return
  }
  if (emptyState) emptyState.hidden = true

  for (const record of displayRecords) {
    const isFailed = !isSuccess(record)
    const hasAlert = record.alert === true
    const cells = visibleCols.map(col => {
      // 狀態欄顯示白話；複製 TSV 與匯出維持代碼
      const text = col.key === 'status' && record.status
        ? statusTextOf(record.status)
        : formatValue(record[col.key])
      return text
    })
    const classNames = []
    if (isFailed) classNames.push('failed')
    if (hasAlert) classNames.push('has-alert')
    const tr = createTableRow(cells, false, { className: classNames.join(' ') })
    // 位置定位（每次取最後一列那種）抓到的值要看得出來源是哪一列，
    // 不然「今天早上網站還沒更新」跟「抓錯了」在畫面上長得一樣
    if (record.label) {
      tr.setAttribute('title', `來源列：${record.label}`)
    }
    // 告警：狀態欄後面接警示圖示（有 aria-label，不只靠顏色）
    const statusIdx = visibleCols.findIndex(c => c.key === 'status')
    if (hasAlert && statusIdx !== -1) {
      const mark = document.createElement('span')
      mark.className = 'alert-mark'
      mark.setAttribute('role', 'img')
      mark.setAttribute('aria-label', '告警')
      mark.title = '告警條件成立'
      mark.appendChild(icon('alert'))
      tr.children[statusIdx]?.appendChild(mark)
    }

    // 展開控制是列內一顆按鈕（鍵盤可達）；滑鼠點整列展開照舊，按鈕的 click 冒泡到列上同一個處理
    const detailId = `record-detail-${++detailSeq}`
    const expandBtn = document.createElement('button')
    expandBtn.type = 'button'
    expandBtn.className = 'row-expand'
    expandBtn.dataset.action = 'toggle-detail'
    expandBtn.setAttribute('aria-expanded', 'false')
    expandBtn.setAttribute('aria-controls', detailId)
    setIcon(expandBtn, 'chevron-right', { label: '展開明細' })
    tr.firstElementChild?.prepend(expandBtn)

    tr.addEventListener('click', () => {
      const next = tr.nextElementSibling
      if (next && next.classList.contains('detail')) {
        next.remove()
        expandBtn.setAttribute('aria-expanded', 'false')
        setIcon(expandBtn, 'chevron-right', { label: '展開明細' })
        return
      }

      let diffText = '—'
      if (record.slot && record.capturedAt) {
        const diffSec = Math.round((new Date(record.capturedAt) - new Date(record.slot)) / 1000)
        if (!Number.isNaN(diffSec)) diffText = `${diffSec >= 0 ? '+' : ''}${diffSec}s`
      }

      const detailItems = [
        ['原始值 (raw)', record.raw !== undefined && record.raw !== null
          ? `${record.raw}${record.rawTruncated === true ? '（已截斷）' : ''}` : '—'],
        ['錯誤訊息 (error)', record.error ?? '—'],
        ['使用策略 (strategyUsed)', record.strategyUsed ?? '—'],
        ['排定時間 (slot)', record.slot ?? '—'], ['擷取時間 (capturedAt)', record.capturedAt ?? '—'],
        ['時間差 (diff)', diffText]
      ]
      if (record.label) {
        detailItems.push(['來源列 (label)', record.label])
      }
      if (record.strategyUsed === 'block') {
        detailItems.push(['聚合格數 (used)', record.used ?? '—'])
        // skipped 是解析不到（非數字）的格；excluded 含略過頭尾與點選排除兩種——標籤照口徑寫，別讓只設略過的人看到「排除 1 格」
        detailItems.push(['非數字格數 (skipped)', record.skipped ?? 0])
        detailItems.push(['略過與排除格數 (excluded)', record.excluded ?? 0])
        if (record.partial === true) {
          detailItems.push(['只抓到部分 (partial)', '是（表格可能有未載入的列）'])
        }
      }
      if (record.alert === true) {
        detailItems.push(['告警 (alert)', (Array.isArray(record.alertHits) && record.alertHits.length > 0) ? record.alertHits.join(', ') : '是'])
      }

      const detailTr = createTableRow([{ colSpan: visibleCols.length || 1, text: '' }], false, { className: 'detail' })
      const td = detailTr.querySelector('td'), box = document.createElement('div')
      td.textContent = ''
      box.className = 'detail-box'
      for (const [lbl, val] of detailItems) {
        const itemRow = document.createElement('div'), strong = document.createElement('strong'), span = document.createElement('span')
        itemRow.className = 'detail-item'
        strong.textContent = `${lbl}：`
        span.textContent = String(val)
        itemRow.appendChild(strong)
        itemRow.appendChild(span)
        box.appendChild(itemRow)
      }

      // 單筆刪除按鈕
      const deleteActionRow = document.createElement('div')
      deleteActionRow.className = 'detail-actions'
      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.dataset.action = 'delete-record'
      delBtn.textContent = '刪除此紀錄'
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        // 共用 modal（AF-21 4-D）：確認框就在畫面正中，不再離刪除鈕數百像素
        const ok = await confirmDialog({
          title: '刪除紀錄',
          body: `確定要刪除此筆紀錄嗎？（${record.taskName || record.taskId || ''}，${record.capturedAt || record.slot || ''}）刪除後無法復原。`,
          confirmText: '刪除',
          cancelText: '取消',
          danger: true
        })
        if (ok !== true) return
        const recDate = record.date || (record.slot ? record.slot.slice(0, 10) : '')
        await deleteRecord(recDate, record.taskId, record.capturedAt)

        if (state.from && state.to) {
          let tasks = []
          try { tasks = await getTasks() } catch {}
          const raw = await getRecordsInRange(state.from, state.to)
          allLoadedRecords = joinTaskNames(raw, tasks)
          const filtered = filterRecords(allLoadedRecords, {
            taskIds: state.taskIds,
            statuses: state.statuses,
            failedOnly: state.failedOnly,
            alertOnly: state.alertOnly,
            valueMin: state.valueMin,
            valueMax: state.valueMax,
            keyword: state.keyword
          })
          await renderCurrentHistoryTable(filtered, tasks)
          renderSummary(summarize(filtered))
        } else {
          const idx = lastRecords.findIndex(r => r.taskId === record.taskId && r.capturedAt === record.capturedAt)
          if (idx !== -1) lastRecords.splice(idx, 1)
          renderTable(lastRecords, lastColumns, opts)
          renderSummary(summarize(lastRecords))
        }
      })
      deleteActionRow.appendChild(delBtn)
      box.appendChild(deleteActionRow)

      td.appendChild(box)
      detailTr.id = detailId
      tr.after(detailTr)
      expandBtn.setAttribute('aria-expanded', 'true')
      setIcon(expandBtn, 'chevron-down', { label: '收合明細' })
    })
    tbody.appendChild(tr)
  }
}

export function renderSummary(rows) {
  const container = document.getElementById('summary')
  if (!container) return
  container.textContent = ''
  if (!Array.isArray(rows) || rows.length === 0) return

  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const headers = ['任務', '筆數', '失敗', '最小', '最大', '平均', '首筆', '末筆', '變化']
  thead.appendChild(createTableRow(headers, true))
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const r of rows) {
    const tr = document.createElement('tr')

    // 任務名欄位：改成可點的元素，帶 data-task-id
    const taskTd = document.createElement('td')
    const taskLink = document.createElement('button')
    taskLink.type = 'button'
    taskLink.className = 'task-link'
    taskLink.dataset.taskId = r.taskId
    taskLink.textContent = r.taskName || r.taskId || '—'
    taskLink.addEventListener('click', async () => {
      try {
        const records = await getRecordsInRange(state.from, state.to)
        const seriesList = buildSeries(records, [{ taskId: r.taskId }], { from: state.from, to: state.to })
        const chartBox = document.getElementById('summary-chart')
        if (chartBox) {
          chartBox.textContent = ''
          const svg = lineChart(seriesList)
          chartBox.appendChild(svg)
          chartBox.hidden = false
        }
      } catch (err) {
        console.error('繪製折線圖失敗:', err)
      }
    })
    taskTd.appendChild(taskLink)
    tr.appendChild(taskTd)

    const otherValues = [
      formatValue(r.count), formatValue(r.failCount),
      formatValue(r.min), formatValue(r.max), formatValue(r.avg),
      formatValue(r.first), formatValue(r.last), formatValue(r.delta)
    ]
    for (const val of otherValues) {
      const td = document.createElement('td')
      td.textContent = String(val)
      tr.appendChild(td)
    }

    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  container.appendChild(table)
}

export function renderCalendar(year, month, statsByDate = {}) {
  currentCalYear = year
  currentCalMonth = month

  const container = document.getElementById('calendar')
  if (!container) return
  container.textContent = ''

  // 1. 月曆導覽列
  const nav = document.createElement('div')
  nav.className = 'calendar-nav'

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.id = 'cal-prev-month'
  setIcon(prevBtn, 'chevron-left', { label: '上個月' })
  prevBtn.onclick = () => {
    let y = currentCalYear
    let m = currentCalMonth - 1
    if (m < 1) { m = 12; y -= 1 }
    renderCalendar(y, m, statsByDate)
  }

  const jumpInput = document.createElement('input')
  jumpInput.type = 'month'
  jumpInput.id = 'cal-jump'
  jumpInput.setAttribute('aria-label', '跳到月份')
  jumpInput.value = `${year}-${String(month).padStart(2, '0')}`
  jumpInput.onchange = () => {
    if (jumpInput.value) {
      const [y, m] = jumpInput.value.split('-').map(Number)
      if (y && m) renderCalendar(y, m, statsByDate)
    }
  }

  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.id = 'cal-next-month'
  setIcon(nextBtn, 'chevron-right', { label: '下個月' })
  nextBtn.onclick = () => {
    let y = currentCalYear
    let m = currentCalMonth + 1
    if (m > 12) { m = 1; y += 1 }
    renderCalendar(y, m, statsByDate)
  }

  nav.appendChild(prevBtn)
  nav.appendChild(jumpInput)
  nav.appendChild(nextBtn)
  container.appendChild(nav)

  // 2. 表格
  const weeks = buildCalendar(year, month, statsByDate)
  const table = document.createElement('table')
  const thead = document.createElement('thead')
  thead.appendChild(createTableRow(['日', '一', '二', '三', '四', '五', '六'], true))
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const week of weeks) {
    const tr = document.createElement('tr')
    for (const day of week) {
      const td = document.createElement('td')
      td.dataset.date = day.date
      // 格內放一顆按鈕：可聚焦、Enter／空白鍵觸發（原生 button 的 click 冒泡到格子上同一個處理）
      const dayBtn = document.createElement('button')
      dayBtn.type = 'button'
      dayBtn.className = 'cal-day'
      dayBtn.textContent = String(day.day)
      let note = ''
      if (day.hasFail) note = '，有失敗'
      else if (day.hasAlert) note = '，有告警'
      else if (day.count > 0) note = '，有紀錄'
      dayBtn.setAttribute('aria-label', `${day.date}${note}`)
      if (state.from && state.to && day.date >= state.from && day.date <= state.to) {
        dayBtn.setAttribute('aria-pressed', 'true')
        td.classList.add('in-range')
      }
      td.appendChild(dayBtn)

      if (!day.inMonth) td.classList.add('out-of-month')
      if (day.count > 0) td.classList.add('has-records')
      if (day.hasFail) td.classList.add('has-fail')
      if (day.hasAlert) td.classList.add('has-alert')

      td.addEventListener('click', () => {
        state.from = day.date
        state.to = day.date
        if (typeof window !== 'undefined') window.location.hash = buildHash(state)
      })

      td.addEventListener('pointerdown', () => {
        isCalDragging = true
        calDragStart = day.date
        calDragCurrent = day.date
      })

      td.addEventListener('pointerover', () => {
        if (isCalDragging) {
          calDragCurrent = day.date
        }
      })

      td.addEventListener('pointerup', () => {
        if (isCalDragging) {
          isCalDragging = false
          const end = day.date || calDragCurrent
          if (calDragStart && end) {
            const norm = normalizeRange(calDragStart, end)
            state.from = norm.from
            state.to = norm.to
            if (typeof window !== 'undefined') window.location.hash = buildHash(state)
          }
          calDragStart = null
          calDragCurrent = null
        }
      })

      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  container.appendChild(table)
}

export function renderColumnConfig(columns) {
  const container = document.getElementById('column-config')
  if (!container) return
  container.textContent = ''
  if (!Array.isArray(columns)) return

  currentColumns = columns.map(c => ({ ...c }))

  for (const col of currentColumns) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = col.key
    input.checked = col.visible !== false

    input.addEventListener('change', async () => {
      col.visible = input.checked
      renderTable(lastRecords, currentColumns)
      try {
        const settings = await getSettings()
        const oldHistory = (settings && typeof settings.history === 'object') ? settings.history : {}
        await saveSettings({
          history: { ...oldHistory, columns: currentColumns }
        })
      } catch {}
    })

    label.appendChild(input)
    label.appendChild(document.createTextNode(` ${col.label || col.key}`))

    // 支援 Pointer Events 拖曳排序
    label.addEventListener('pointerdown', (e) => {
      if (typeof label.setPointerCapture === 'function') {
        try { label.setPointerCapture(e.pointerId) } catch {}
      }
      label.dataset.dragging = 'true'
    })

    label.addEventListener('pointermove', (e) => {
      if (label.dataset.dragging !== 'true') return
      const target = document.elementFromPoint?.(e.clientX, e.clientY)?.closest('#column-config label')
      if (target && target !== label && target.parentNode === container) {
        const rect = target.getBoundingClientRect()
        const midX = rect.left + rect.width / 2
        if (e.clientX < midX) {
          container.insertBefore(label, target)
        } else {
          container.insertBefore(label, target.nextSibling)
        }
      }
    })

    const onPointerUp = async (e) => {
      if (label.dataset.dragging !== 'true') return
      label.dataset.dragging = 'false'
      if (typeof label.releasePointerCapture === 'function') {
        try { label.releasePointerCapture(e.pointerId) } catch {}
      }
      const newKeys = [...container.querySelectorAll('input')].map(inp => inp.value)
      await applyColumnOrder(newKeys)
    }

    label.addEventListener('pointerup', onPointerUp)
    label.addEventListener('pointercancel', onPointerUp)

    container.appendChild(label)
  }
}

export async function applyColumnOrder(keys) {
  if (!Array.isArray(keys)) return
  const colMap = new Map(currentColumns.map(c => [c.key, c]))
  const newCols = []
  for (const k of keys) {
    if (colMap.has(k)) {
      newCols.push(colMap.get(k))
      colMap.delete(k)
    }
  }
  for (const c of colMap.values()) {
    newCols.push(c)
  }
  currentColumns = newCols
  try {
    const settings = await getSettings()
    const oldHistory = (settings && typeof settings.history === 'object') ? settings.history : {}
    await saveSettings({
      history: { ...oldHistory, columns: currentColumns }
    })
  } catch {}
  renderColumnConfig(currentColumns)
  renderTable(lastRecords, currentColumns)
}

export function renderPivot(records = [], tasks = []) {
  const table = document.getElementById('record-table')
  const emptyState = document.getElementById('empty-state')
  if (!table) return

  let thead = table.querySelector('thead')
  if (!thead) { thead = document.createElement('thead'); table.appendChild(thead) }
  thead.textContent = ''

  let tbody = table.querySelector('tbody')
  if (!tbody) { tbody = document.createElement('tbody'); table.appendChild(tbody) }
  tbody.textContent = ''

  const sortedTasks = [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const seriesIndex = buildSeriesIndex(sortedTasks)
  const seriesIds = seriesIndex.seriesIds

  const { columns, rows } = pivot(records, seriesIds, { taskOrder: seriesIds })

  const headerCells = ['時間', ...columns.map(id => nameOf(seriesIndex, id))]
  thead.appendChild(createTableRow(headerCells, true))

  if (!rows || rows.length === 0) {
    if (emptyState) emptyState.hidden = false
    return
  }
  if (emptyState) emptyState.hidden = true

  for (const row of rows) {
    const cells = [row.t, ...columns.map(col => formatValue(row.values[col]))]
    tbody.appendChild(createTableRow(cells, false))
  }
}

export async function renderCompare(compareDate) {
  const table = document.getElementById('compare-table')
  if (!table) return
  let thead = table.querySelector('thead')
  if (!thead) { thead = document.createElement('thead'); table.appendChild(thead) }
  thead.textContent = ''
  let tbody = table.querySelector('tbody')
  if (!tbody) { tbody = document.createElement('tbody'); table.appendChild(tbody) }
  tbody.textContent = ''

  if (!compareDate) return

  let tasks = []
  try { tasks = await getTasks() } catch {}
  const sortedTasks = [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const seriesIndex = buildSeriesIndex(sortedTasks)
  const seriesIds = seriesIndex.seriesIds

  const recordsA = await getRecordsInRange(state.from, state.to)
  const recordsB = await getRecordsByDate(compareDate)

  const { rows } = compareDays(recordsA, recordsB, seriesIds)

  const headers = ['時間']
  for (const id of seriesIds) {
    const name = nameOf(seriesIndex, id)
    headers.push(`${name} (基準)`, `${name} (比較)`, '差異')
  }
  thead.appendChild(createTableRow(headers, true))

  for (const row of rows) {
    const cells = [row.time]
    for (const id of seriesIds) {
      const v = row.values[id] || { a: null, b: null, delta: null }
      cells.push(formatValue(v.a), formatValue(v.b), formatValue(v.delta))
    }
    tbody.appendChild(createTableRow(cells, false))
  }
}

export function renderRangeBar() {
  const bar = document.getElementById('range-bar')
  if (!bar) return

  const fromInput = document.getElementById('range-from')
  const toInput = document.getElementById('range-to')

  const syncInputs = () => {
    if (fromInput) fromInput.value = state.from || ''
    if (toInput) toInput.value = state.to || ''
  }

  syncInputs()

  const buttons = bar.querySelectorAll('[data-range]')
  for (const btn of buttons) {
    btn.onclick = () => {
      const range = quickRange(btn.dataset.range, Date.now())
      if (range) {
        state.from = range.from
        state.to = range.to
        if (typeof window !== 'undefined') window.location.hash = buildHash(state)
        syncInputs()
      }
    }
  }

  const shift = (days) => {
    const shifted = shiftRange(state.from, state.to, days)
    if (shifted) {
      state.from = shifted.from
      state.to = shifted.to
      if (typeof window !== 'undefined') window.location.hash = buildHash(state)
      syncInputs()
    }
  }

  const prevDay = document.getElementById('range-prev-day')
  if (prevDay) {
    setIcon(prevDay, 'chevron-left', { label: '往前一天' })
    prevDay.onclick = () => shift(-1)
  }

  const nextDay = document.getElementById('range-next-day')
  if (nextDay) {
    setIcon(nextDay, 'chevron-right', { label: '往後一天' })
    nextDay.onclick = () => shift(1)
  }

  const prevWeek = document.getElementById('range-prev-week')
  if (prevWeek) {
    setIcon(prevWeek, 'chevrons-left', { label: '往前一週' })
    prevWeek.onclick = () => shift(-7)
  }

  const nextWeek = document.getElementById('range-next-week')
  if (nextWeek) {
    setIcon(nextWeek, 'chevrons-right', { label: '往後一週' })
    nextWeek.onclick = () => shift(7)
  }

  const onDateChange = () => {
    const rawFrom = fromInput ? fromInput.value : state.from
    const rawTo = toInput ? toInput.value : state.to
    if (rawFrom && rawTo) {
      const normalized = normalizeRange(rawFrom, rawTo)
      state.from = normalized.from
      state.to = normalized.to
      if (typeof window !== 'undefined') window.location.hash = buildHash(state)
      syncInputs()
    }
  }

  if (fromInput) fromInput.onchange = onDateChange
  if (toInput) toInput.onchange = onDateChange
}

async function loadAndRenderPage() {
  initFromHash(typeof location !== 'undefined' ? location.hash : '')
  showTab(state.view || 'dashboard')
  renderRangeBar()
  renderAppStatus()

  let cols = currentColumns
  try {
    const settings = await getSettings()
    applyTheme(settings?.theme)
    if (settings?.history?.columns) {
      cols = settings.history.columns
      currentColumns = cols
    }
    if (settings?.history?.tableMode) {
      currentTableMode = settings.history.tableMode
    }
  } catch {
    applyTheme('system')
  }
  setupTableMode()

  renderColumnConfig(cols)

  let tasks = []
  try { tasks = await getTasks() } catch {}
  const rawRecords = await getRecordsInRange(state.from, state.to)
  const records = joinTaskNames(rawRecords, tasks)
  allLoadedRecords = records

  await renderFilters()

  const filtered = filterRecords(records, {
    taskIds: state.taskIds,
    statuses: state.statuses,
    failedOnly: state.failedOnly,
    alertOnly: state.alertOnly,
    valueMin: state.valueMin,
    valueMax: state.valueMax,
    keyword: state.keyword
  })

  await renderCurrentHistoryTable(filtered, tasks)
  renderSummary(summarize(filtered))

  const baseDate = state.from ? new Date(state.from) : new Date()
  const year = baseDate.getFullYear()
  const month = baseDate.getMonth() + 1
  const monthRange = quickRange('thisMonth', baseDate.getTime())
  const monthRecords = monthRange ? await getRecordsInRange(monthRange.from, monthRange.to) : records
  const statsByDate = buildDateStats(monthRecords, isSuccess)
  renderCalendar(year, month, statsByDate)

  const compareInput = document.getElementById('compare-date')
  if (compareInput) {
    compareInput.value = state.compareTo || ''
    compareInput.onchange = async () => {
      state.compareTo = compareInput.value
      if (typeof window !== 'undefined') window.location.hash = buildHash(state)
      await renderCompare(state.compareTo)
    }
  }
  if (state.compareTo) {
    await renderCompare(state.compareTo)
  }
}

if (typeof document !== 'undefined' && globalThis.chrome?.runtime?.id) {
  subscribe((change) => { refreshCurrentView(change) })
  loadAndRenderPage()
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
      loadAndRenderPage()
    })
    setupTabs()
  }
}

if (typeof document !== 'undefined') {
  setupTableMode()
}
