// AutoFetcher 報表歷史檢視 (SPEC §8.3, F2)

import {
  quickRange, filterRecords, summarize, buildCalendar,
  sortRecords, parseHash, buildHash,
  shiftRange, normalizeRange
} from './logic.js'
import { getRecordsInRange, getSettings, saveSettings, getTasks } from '../../shared/storage.js'
import { getLayout } from '../../shared/layout-store.js'
import { renderTasks } from './tasks.js'
import { renderSettings } from './settings.js'
import { renderDashboard } from './dashboard.js'

const DEFAULT_COLUMNS = [
  { key: 'slot', label: '時間', visible: true },
  { key: 'taskName', label: '任務', visible: true },
  { key: 'value', label: '值', visible: true },
  { key: 'status', label: '狀態', visible: true },
  { key: 'strategyUsed', label: '策略', visible: false }
]

const state = {
  view: 'history',
  from: '',
  to: '',
  taskIds: [],
  statuses: [],
  sortField: null,
  sortDir: 'asc'
}

let currentColumns = [...DEFAULT_COLUMNS]
let lastRecords = []
let lastColumns = currentColumns

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
  const byId = new Map()
  for (const t of tasks) if (t && t.id) byId.set(t.id, t.name)
  return records.map(r => ({ ...r, taskName: r.taskName ?? byId.get(r.taskId) ?? r.taskId }))
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
  if (parsed.view) state.view = parsed.view
  if (parsed.taskIds) state.taskIds = parsed.taskIds
  if (parsed.statuses) state.statuses = parsed.statuses

  const today = quickRange('today', Date.now())
  state.from = parsed.from || (today ? today.from : '')
  state.to = parsed.to || (today ? today.to : '')
  if (typeof document !== 'undefined') {
    renderRangeBar()
    const fromInput = document.getElementById('range-from')
    const toInput = document.getElementById('range-to')
    if (fromInput) fromInput.value = state.from || ''
    if (toInput) toInput.value = state.to || ''
  }
}

export async function loadAndRenderTasks() {
  try {
    const tasks = await getTasks()
    let health = {}
    let missed = []
    if (globalThis.chrome?.storage?.local?.get) {
      const storageData = await chrome.storage.local.get(['health', 'missed'])
      health = (storageData && storageData.health && typeof storageData.health === 'object')
        ? storageData.health
        : {}
      missed = Array.isArray(storageData?.missed) ? storageData.missed : []
    }

    const nextRuns = {}
    if (globalThis.chrome?.alarms?.getAll) {
      const alarms = await chrome.alarms.getAll()
      for (const a of alarms) {
        if (a.name?.startsWith('task:')) {
          const parts = a.name.slice(5).split(':')
          const taskId = parts.slice(0, -1).join(':') || parts[0]
          if (taskId && a.scheduledTime) {
            if (!nextRuns[taskId] || a.scheduledTime < nextRuns[taskId]) {
              const d = new Date(a.scheduledTime)
              const y = d.getFullYear()
              const m = String(d.getMonth() + 1).padStart(2, '0')
              const day = String(d.getDate()).padStart(2, '0')
              const h = String(d.getHours()).padStart(2, '0')
              const min = String(d.getMinutes()).padStart(2, '0')
              nextRuns[taskId] = `${y}-${m}-${day} ${h}:${min}`
            }
          }
        }
      }
    }

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
      renderDashboard(l?.lastDashboardId || l?.dashboards?.[0]?.id)
    }).catch(() => {})
  }
  if (name === 'tasks') {
    loadAndRenderTasks()
  }
  if (name === 'settings') {
    renderSettings()
  }
}

export function renderTable(records = [], columns = currentColumns) {
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
      renderTable(sorted, lastColumns)
    })
  })
  thead.appendChild(trHead)

  if (lastRecords.length === 0) {
    if (emptyState) emptyState.hidden = false
    return
  }
  if (emptyState) emptyState.hidden = true

  for (const record of lastRecords) {
    const isFailed = !['ok', 'fallback', 'late'].includes(record.status)
    const cells = visibleCols.map(col => formatValue(record[col.key]))
    const tr = createTableRow(cells, false, { className: isFailed ? 'failed' : '' })

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
    const cells = [
      r.taskName || r.taskId || '—',
      formatValue(r.count), formatValue(r.failCount),
      formatValue(r.min), formatValue(r.max), formatValue(r.avg),
      formatValue(r.first), formatValue(r.last), formatValue(r.delta)
    ]
    tbody.appendChild(createTableRow(cells, false))
  }
  table.appendChild(tbody)
  container.appendChild(table)
}

export function renderCalendar(year, month, statsByDate = {}) {
  const container = document.getElementById('calendar')
  if (!container) return
  container.textContent = ''

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

      td.addEventListener('click', () => {
        state.from = day.date
        state.to = day.date
        if (typeof window !== 'undefined') window.location.hash = buildHash(state)
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
    container.appendChild(label)
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
  showTab(state.view || 'history')
  renderRangeBar()

  let cols = currentColumns
  try {
    const settings = await getSettings()
    applyTheme(settings?.theme)
    if (settings?.history?.columns) {
      cols = settings.history.columns
      currentColumns = cols
    }
  } catch {
    applyTheme('system')
  }

  renderColumnConfig(cols)

  let tasks = []
  try { tasks = await getTasks() } catch {}
  const records = joinTaskNames(await getRecordsInRange(state.from, state.to), tasks)
  const filtered = filterRecords(records, {
    taskIds: state.taskIds,
    statuses: state.statuses
  })
  renderTable(filtered, cols)
  renderSummary(summarize(filtered))

  const baseDate = state.from ? new Date(state.from) : new Date()
  const year = baseDate.getFullYear()
  const month = baseDate.getMonth() + 1
  const monthRange = quickRange('thisMonth', baseDate.getTime())
  const monthRecords = monthRange ? await getRecordsInRange(monthRange.from, monthRange.to) : records
  const statsByDate = {}
  for (const r of monthRecords) {
    if (!r.date) continue
    if (!statsByDate[r.date]) statsByDate[r.date] = { count: 0, hasFail: false }
    statsByDate[r.date].count++
    if (!['ok', 'fallback', 'late'].includes(r.status)) statsByDate[r.date].hasFail = true
  }
  renderCalendar(year, month, statsByDate)
}

if (globalThis.chrome?.runtime?.id) {
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
