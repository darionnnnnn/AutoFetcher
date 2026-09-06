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
import { buildSeries, pivot } from './series.js'
import { lineChart } from './charts.js'
import { buildTsv } from './cards.js'
import { renderTasks } from './tasks.js'
import { renderSettings } from './settings.js'
import { renderDashboard, isEditing } from './dashboard.js'
import { isSuccess } from '../../shared/record-status.js'
import { MSG } from '../../shared/messages.js'
import { buildSeriesIndex, nameOf } from '../../shared/series-index.js'

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
  alertsOnly: false,
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

export function applyTheme(theme) {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
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
  state.alertsOnly = parsed.alertsOnly === true
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
      alertsOnly: state.alertsOnly,
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
  const alertsCb = container.querySelector('#filter-alerts-only')
  const valMinInput = container.querySelector('#filter-value-min')
  const valMaxInput = container.querySelector('#filter-value-max')
  const kwInput = container.querySelector('#filter-keyword')

  state.taskIds = tasksContainer
    ? [...tasksContainer.querySelectorAll('input:checked')]
        .filter(cb => !cb.dataset.parent)
        .map(cb => cb.value)
    : []
  state.statuses = statusesContainer ? [...statusesContainer.querySelectorAll('input:checked')].map(cb => cb.value) : []
  state.alertsOnly = alertsCb ? alertsCb.checked : false
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
    alertsOnly: state.alertsOnly,
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
  const allStatuses = [
    { key: 'ok', label: '成功 (ok)' },
    { key: 'fallback', label: '備援 (fallback)' },
    { key: 'late', label: '逾時 (late)' },
    { key: 'not_found', label: '未找到 (not_found)' },
    { key: 'parse_error', label: '抓不到數值 (parse_error)' },
    { key: 'login_failed', label: '無法登入 (login_failed)' },
    { key: 'error', label: '錯誤 (error)' }
  ]
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

  // 3. 只看告警 #filter-alerts-only
  const alertsLabel = document.createElement('label')
  const alertsCb = document.createElement('input')
  alertsCb.type = 'checkbox'
  alertsCb.id = 'filter-alerts-only'
  alertsCb.checked = !!state.alertsOnly
  alertsLabel.appendChild(alertsCb)
  alertsLabel.appendChild(document.createTextNode(' 只看告警'))

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
  for (const tab of ['dashboard', 'history', 'tasks', 'settings']) {
    const panel = document.getElementById(`panel-${tab}`)
    if (panel) panel.hidden = (tab !== name)
  }
  if (name === 'dashboard') {
    getLayout().then(l => {
      const targetId = state.dash || l?.lastDashboardId || l?.dashboards?.[0]?.id
      renderDashboard(targetId)
    }).catch(() => {})
  }
  if (name === 'tasks') {
    loadAndRenderTasks()
  }
  if (name === 'settings') {
    renderSettings()
  }
}

export async function refreshCurrentView() {
  const currentView = state.view || 'dashboard'
  if (currentView === 'dashboard') {
    if (isEditing()) return
    try {
      const l = await getLayout()
      const targetId = state.dash || l?.lastDashboardId || l?.dashboards?.[0]?.id
      await renderDashboard(targetId)
    } catch {}
    return
  }
  if (currentView === 'tasks') {
    await loadAndRenderTasks()
    return
  }
  if (currentView === 'history') {
    await applyCurrentFilters()
    return
  }
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
      const text = formatValue(record[col.key])
      if (col.key === 'status' && hasAlert) {
        return `${text} 🔔`
      }
      return text
    })
    const classNames = []
    if (isFailed) classNames.push('failed')
    if (hasAlert) classNames.push('has-alert')
    const tr = createTableRow(cells, false, { className: classNames.join(' ') })

    tr.addEventListener('click', () => {
      const next = tr.nextElementSibling
      if (next && next.classList.contains('detail')) {
        next.remove()
        return
      }

      let diffText = '—'
      if (record.slot && record.capturedAt) {
        const diffSec = Math.round((new Date(record.capturedAt) - new Date(record.slot)) / 1000)
        if (!Number.isNaN(diffSec)) diffText = `${diffSec >= 0 ? '+' : ''}${diffSec}s`
      }

      const detailItems = [
        ['原始值 (raw)', record.raw ?? '—'], ['錯誤訊息 (error)', record.error ?? '—'],
        ['DOM 片段 (snippet)', record.snippet ?? '—'], ['使用策略 (strategyUsed)', record.strategyUsed ?? '—'],
        ['排定時間 (slot)', record.slot ?? '—'], ['擷取時間 (capturedAt)', record.capturedAt ?? '—'],
        ['時間差 (diff)', diffText]
      ]
      if (record.strategyUsed === 'block') {
        detailItems.push(['聚合格數 (used)', record.used ?? '—'])
        detailItems.push(['略過格數 (skipped)', record.skipped ?? 0])
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
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const confirmBox = document.getElementById('record-delete-confirm')
        if (confirmBox) {
          confirmBox.hidden = false
          const cancelBtn = confirmBox.querySelector('[data-action="cancel"]')
          const okBtn = confirmBox.querySelector('[data-action="confirm"]')

          if (cancelBtn) {
            cancelBtn.onclick = () => {
              confirmBox.hidden = true
            }
          }

          if (okBtn) {
            okBtn.onclick = async () => {
              confirmBox.hidden = true

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
                  alertsOnly: state.alertsOnly,
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
            }
          }
        }
      })
      deleteActionRow.appendChild(delBtn)
      box.appendChild(deleteActionRow)

      td.appendChild(box)
      tr.after(detailTr)
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
  prevBtn.textContent = '‹'
  prevBtn.onclick = () => {
    let y = currentCalYear
    let m = currentCalMonth - 1
    if (m < 1) { m = 12; y -= 1 }
    renderCalendar(y, m, statsByDate)
  }

  const jumpInput = document.createElement('input')
  jumpInput.type = 'month'
  jumpInput.id = 'cal-jump'
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
  nextBtn.textContent = '›'
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
      td.textContent = String(day.day)

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
  if (prevDay) prevDay.onclick = () => shift(-1)

  const nextDay = document.getElementById('range-next-day')
  if (nextDay) nextDay.onclick = () => shift(1)

  const prevWeek = document.getElementById('range-prev-week')
  if (prevWeek) prevWeek.onclick = () => shift(-7)

  const nextWeek = document.getElementById('range-next-week')
  if (nextWeek) nextWeek.onclick = () => shift(7)

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
    alertsOnly: state.alertsOnly,
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
  subscribe(() => { refreshCurrentView() })
  loadAndRenderPage()
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
      loadAndRenderPage()
    })
    for (const tab of ['dashboard', 'history', 'tasks', 'settings']) {
      const btn = document.getElementById(`tab-${tab}`)
      if (btn) {
        btn.addEventListener('click', () => {
          showTab(tab)
          window.location.hash = buildHash(state)
        })
      }
    }
  }
}

if (typeof document !== 'undefined') {
  setupTableMode()
}
