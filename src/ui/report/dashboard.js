// AutoFetcher 儀表板面板控制模組（SPEC G3）

import { getLayout, saveLayout } from '../../shared/layout-store.js'
import { getRecordsInRange, getTasks } from '../../shared/storage.js'
import { renderCard } from './cards.js'
import { resolvePeriod } from './series.js'
import { placeCard, resizeCard, compact } from './layout.js'

// 編輯模式狀態與復原歷史
let editing = false
let currentDashId = null
const undoStack = []
const redoStack = []
let activeOp = null

/**
 * 將 YYYY-MM-DD 加上指定天數
 */
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const year = dt.getUTCFullYear()
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const day = String(dt.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 取得今天日期字串 (YYYY-MM-DD)
 */
function getTodayString() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 像素位移換算為格線行列數（純函式）
 */
export function pixelToGrid(dx, dy, gridWidth) {
  const colWidth = (gridWidth && gridWidth > 0) ? gridWidth / 12 : 50
  const rowHeight = 80
  const cols = Math.round(dx / colWidth)
  const rows = Math.round(dy / rowHeight)
  return { cols, rows }
}

/**
 * 取得目前是否處於編輯模式
 */
export function isEditing() {
  return editing
}

/**
 * 把目前版面推進歷史堆疊（上限 50 步）
 */
export async function pushHistory() {
  const layout = await getLayout()
  const snapshot = structuredClone(layout.dashboards)
  undoStack.push(snapshot)
  if (undoStack.length > 50) {
    undoStack.shift()
  }
  redoStack.length = 0
}

/**
 * 取得目前可復原步數
 */
export function historySize() {
  return undoStack.length
}

/**
 * 復原上一步
 */
export async function undo() {
  if (undoStack.length === 0) return
  const layout = await getLayout()
  redoStack.push(structuredClone(layout.dashboards))

  const prevDashboards = undoStack.pop()
  layout.dashboards = prevDashboards
  await saveLayout(layout)
  await renderDashboard(currentDashId)
}

/**
 * 重做下一步
 */
export async function redo() {
  if (redoStack.length === 0) return
  const layout = await getLayout()
  undoStack.push(structuredClone(layout.dashboards))
  if (undoStack.length > 50) {
    undoStack.shift()
  }

  const nextDashboards = redoStack.pop()
  layout.dashboards = nextDashboards
  await saveLayout(layout)
  await renderDashboard(currentDashId)
}

/**
 * 更新編輯模式的 DOM 視覺狀態
 */
function updateEditingUI() {
  if (typeof document === 'undefined') return
  const grid = document.getElementById('dashboard-grid')
  if (grid) {
    if (editing) {
      grid.classList.add('editing')
    } else {
      grid.classList.remove('editing')
    }
    const handles = grid.querySelectorAll('[data-role="resize-handle"]')
    for (const handle of handles) {
      handle.hidden = !editing
    }
  }
  const editBtn = document.getElementById('edit-layout')
  if (editBtn) {
    editBtn.textContent = editing ? '完成編輯' : '編輯版面'
  }
}

/**
 * 鍵盤快速鍵監聽 (Ctrl/Cmd + Z, Ctrl/Cmd + Shift + Z)
 */
function onKeyDown(event) {
  if (!editing) return

  const target = event.target
  if (target) {
    const tag = target.tagName ? target.tagName.toLowerCase() : ''
    if (['input', 'textarea', 'select'].includes(tag)) return
    if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') return
  }

  if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault()
    }
    if (event.shiftKey) {
      redo()
    } else {
      undo()
    }
  }
}

/**
 * 指標按下事件處理
 */
function onPointerDown(e, card) {
  if (!editing) return
  if (e.button !== undefined && e.button !== 0) return
  if (e.target.closest && e.target.closest('button')) return

  const isResize = Boolean(e.target.closest && e.target.closest('[data-role="resize-handle"]'))

  if (typeof e.target.setPointerCapture === 'function') {
    e.target.setPointerCapture(e.pointerId)
  }

  activeOp = {
    type: isResize ? 'resize' : 'drag',
    card: { ...card },
    cardEl: e.currentTarget,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    targetX: card.x,
    targetY: card.y,
    targetW: card.w,
    targetH: card.h,
    ghost: null
  }

  pushHistory()
}

/**
 * 指標移動事件處理
 */
function onPointerMove(e) {
  if (!activeOp) return

  const dx = e.clientX - activeOp.startX
  const dy = e.clientY - activeOp.startY

  const grid = document.getElementById('dashboard-grid')
  const gridRect = grid ? grid.getBoundingClientRect() : { width: 600 }
  const { cols, rows } = pixelToGrid(dx, dy, gridRect.width)

  if (activeOp.type === 'drag') {
    let targetX = activeOp.card.x + cols
    let targetY = activeOp.card.y + rows
    if (targetX < 0) targetX = 0
    if (targetX + activeOp.card.w > 12) targetX = Math.max(0, 12 - activeOp.card.w)
    if (targetY < 0) targetY = 0

    activeOp.targetX = targetX
    activeOp.targetY = targetY

    if (!activeOp.ghost && grid) {
      activeOp.ghost = document.createElement('div')
      activeOp.ghost.className = 'ghost'
      grid.appendChild(activeOp.ghost)
    }
    if (activeOp.ghost) {
      activeOp.ghost.style.setProperty('--card-x', String(targetX))
      activeOp.ghost.style.setProperty('--card-y', String(targetY))
      activeOp.ghost.style.setProperty('--card-w', String(activeOp.card.w))
      activeOp.ghost.style.setProperty('--card-h', String(activeOp.card.h))
    }
  } else if (activeOp.type === 'resize') {
    let targetW = activeOp.card.w + cols
    let targetH = activeOp.card.h + rows
    if (targetW < 1) targetW = 1
    if (targetW > 12) targetW = 12
    if (targetH < 1) targetH = 1
    if (targetH > 6) targetH = 6

    activeOp.targetW = targetW
    activeOp.targetH = targetH

    if (!activeOp.ghost && grid) {
      activeOp.ghost = document.createElement('div')
      activeOp.ghost.className = 'ghost'
      grid.appendChild(activeOp.ghost)
    }
    if (activeOp.ghost) {
      activeOp.ghost.style.setProperty('--card-x', String(activeOp.card.x))
      activeOp.ghost.style.setProperty('--card-y', String(activeOp.card.y))
      activeOp.ghost.style.setProperty('--card-w', String(targetW))
      activeOp.ghost.style.setProperty('--card-h', String(targetH))
    }
  }
}

/**
 * 指標釋放事件處理
 */
async function onPointerUp(e) {
  if (!activeOp) return

  const op = activeOp
  activeOp = null

  if (op.ghost) {
    op.ghost.remove()
    op.ghost = null
  }

  if (typeof e.target.releasePointerCapture === 'function') {
    e.target.releasePointerCapture(e.pointerId)
  }

  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === currentDashId) || layout.dashboards[0]
  if (!dash) return

  let changed = false

  if (op.type === 'drag') {
    if (op.targetX !== op.card.x || op.targetY !== op.card.y) {
      changed = true
      const target = { ...op.card, x: op.targetX, y: op.targetY }
      dash.cards = placeCard(dash.cards, target)
    }
  } else if (op.type === 'resize') {
    if (op.targetW !== op.card.w || op.targetH !== op.card.h) {
      changed = true
      dash.cards = compact(resizeCard(dash.cards, op.card.id, op.targetW, op.targetH))
    }
  }

  if (changed) {
    await saveLayout(layout)
    await renderDashboard(dash.id)
  } else {
    undoStack.pop()
  }
}

/**
 * 確保事件監聽器只綁定一次
 */
function setupEvents(grid) {
  if (typeof document !== 'undefined' && !document._dashboardKeydownAttached) {
    document._dashboardKeydownAttached = true
    document.addEventListener('keydown', onKeyDown)
  }

  const editBtn = document.getElementById('edit-layout')
  if (editBtn && !editBtn._dashboardEditAttached) {
    editBtn._dashboardEditAttached = true
    editBtn.addEventListener('click', () => {
      editing = !editing
      if (!editing) {
        undoStack.length = 0
        redoStack.length = 0
      }
      updateEditingUI()
    })
  }

  if (grid && !grid._dashboardPointerAttached) {
    grid._dashboardPointerAttached = true
    grid.addEventListener('pointermove', onPointerMove)
    grid.addEventListener('pointerup', onPointerUp)
  }

  if (typeof window !== 'undefined' && !window._dashboardResizeAttached) {
    window._dashboardResizeAttached = true
    window.addEventListener('resize', () => {
      const g = document.getElementById('dashboard-grid')
      if (!g) return
      if (window.innerWidth < 900) {
        g.classList.add('single-column')
      } else {
        g.classList.remove('single-column')
      }
    })
  }
}

/**
 * 渲染儀表板
 */
export async function renderDashboard(dashId) {
  const layout = await getLayout()
  let dash = null
  if (dashId) {
    dash = layout.dashboards.find(d => d.id === dashId)
  }
  if (!dash) {
    dash = layout.dashboards[0]
  }
  if (!dash) return

  currentDashId = dash.id

  const note = document.getElementById('layout-version-note')
  if (note) {
    note.hidden = !layout.newerVersion
  }

  const grid = document.getElementById('dashboard-grid')
  if (!grid) return

  setupEvents(grid)

  if (typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < 900) {
    grid.classList.add('single-column')
  } else {
    grid.classList.remove('single-column')
  }

  if (editing) {
    grid.classList.add('editing')
  } else {
    grid.classList.remove('editing')
  }

  const today = getTodayString()
  const rangeFromInput = document.getElementById('range-from')
  const rangeToInput = document.getElementById('range-to')
  const defaultFrom = (rangeFromInput && rangeFromInput.value) ? rangeFromInput.value : today
  const defaultTo = (rangeToInput && rangeToInput.value) ? rangeToInput.value : today

  let minFrom = defaultFrom
  let maxTo = defaultTo

  const cards = Array.isArray(dash.cards) ? dash.cards : []
  for (const card of cards) {
    const p = resolvePeriod(card?.options?.period, defaultFrom, defaultTo, today)
    if (p?.from) {
      if (!minFrom || p.from < minFrom) minFrom = p.from
    }
    if (p?.to) {
      if (!maxTo || p.to > maxTo) maxTo = p.to
    }
  }

  const fetchFrom = minFrom ? shiftDate(minFrom, -1) : minFrom
  const fetchTo = maxTo

  const records = (fetchFrom && fetchTo) ? await getRecordsInRange(fetchFrom, fetchTo) : []
  const tasks = await getTasks()
  const tasksById = {}
  for (const t of tasks) {
    if (t && t.id) tasksById[t.id] = t
  }

  let health = {}
  let missed = []
  if (globalThis.chrome?.storage?.local?.get) {
    const data = await chrome.storage.local.get(['health', 'missed'])
    health = (data?.health && typeof data.health === 'object') ? data.health : {}
    missed = Array.isArray(data?.missed) ? data.missed : []
  }

  const nextRuns = {}
  if (globalThis.chrome?.alarms?.getAll) {
    try {
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
    } catch {}
  }

  const ctx = {
    records,
    tasksById,
    health,
    missed,
    nextRuns,
    today,
    range: { from: defaultFrom, to: defaultTo }
  }

  grid.textContent = ''

  for (const card of cards) {
    const cardEl = renderCard(card, ctx)
    cardEl.style.setProperty('--card-x', String(card.x))
    cardEl.style.setProperty('--card-y', String(card.y))
    cardEl.style.setProperty('--card-w', String(card.w))
    cardEl.style.setProperty('--card-h', String(card.h))

    let handle = cardEl.querySelector('[data-role="resize-handle"]')
    if (!handle) {
      handle = document.createElement('div')
      handle.dataset.role = 'resize-handle'
      handle.className = 'resize-handle'
      cardEl.appendChild(handle)
    }
    handle.hidden = !editing

    cardEl.addEventListener('pointerdown', (e) => onPointerDown(e, card))
    grid.appendChild(cardEl)
  }
}
