import {
  getLayout, saveLayout, addDashboard, renameDashboard,
  deleteDashboard, duplicateDashboard, reorderDashboards,
  setLastDashboard, addCard, updateCard
} from '../../shared/layout-store.js'
import { getRecordsInRange, getTasks, getHealthMap, getMissedList } from '../../shared/storage.js'
import { renderCard } from './cards.js'
import { resolvePeriod } from './series.js'
import { placeCard, resizeCard, compact, autoArrange } from './layout.js'
import { openDrawer } from './drawer.js'
import { applyTemplate } from './templates.js'
import { MSG } from '../../shared/messages.js'
import { createDragSource, registerDropTarget, resetDnd, isPointInside } from './dnd.js'
import { applyDrop, cardTypeForTask } from './drop-rules.js'
import { buildSeriesIndex } from '../../shared/series-index.js'

// 編輯模式狀態與復原歷史
let editing = false
let currentDashId = null
const undoStack = []
const redoStack = []
let activeOp = null
let dashIdPendingDelete = null
let templateKindPending = null
let tabDrag = null
let toastTimer = null

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
export async function pushHistory(snapshot) {
  if (!snapshot) {
    const layout = await getLayout()
    snapshot = layout.dashboards
  }
  undoStack.push(structuredClone(snapshot))
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
 * 顯示拖曳投放提示訊息（3 秒後自動隱藏）
 */
function showToast(reason) {
  const toast = document.getElementById('dnd-toast')
  if (!toast) return
  toast.textContent = reason || ''
  toast.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.hidden = true
  }, 3000)
}

/**
 * 更新編輯模式的 DOM 視覺狀態
 */
function updateEditingUI() {
  if (typeof document === 'undefined') return
  const palette = document.getElementById('source-palette')
  if (palette) {
    palette.hidden = !editing
  }
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
    const removeHandles = grid.querySelectorAll('[data-remove-source]')
    for (const handle of removeHandles) {
      handle.hidden = !editing
      handle.textContent = editing ? '×' : ''
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
  if (e.target.closest && (e.target.closest('button') || e.target.closest('[data-remove-source]'))) return

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
  const snapshot = structuredClone(layout.dashboards)

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
    await pushHistory(snapshot)
    await saveLayout(layout)
    await renderDashboard(dash.id)
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
        renderDashboard(currentDashId).catch(() => {})
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

  const addBtn = document.getElementById('dashboard-add')
  if (addBtn && !addBtn._dashboardAddAttached) {
    addBtn._dashboardAddAttached = true
    addBtn.addEventListener('click', async () => {
      const layout = await getLayout()
      const newDash = await addDashboard(`儀表板 ${layout.dashboards.length + 1}`)
      if (newDash) {
        await setLastDashboard(newDash.id)
        await renderDashboard(newDash.id)
      }
    })
  }

  const arrangeBtn = document.getElementById('auto-arrange')
  if (arrangeBtn && !arrangeBtn._dashboardArrangeAttached) {
    arrangeBtn._dashboardArrangeAttached = true
    arrangeBtn.addEventListener('click', async () => {
      const layout = await getLayout()
      const dash = layout.dashboards.find(d => d.id === currentDashId) || layout.dashboards[0]
      if (dash) {
        dash.cards = autoArrange(dash.cards)
        await saveLayout(layout)
        await renderDashboard(dash.id)
      }
    })
  }

  const templateConfirm = document.getElementById('template-confirm')
  if (templateConfirm && !templateConfirm._dashboardTemplateAttached) {
    templateConfirm._dashboardTemplateAttached = true
    const cancelBtn = templateConfirm.querySelector('[data-action="cancel"]')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        templateConfirm.hidden = true
        templateKindPending = null
        const select = document.getElementById('apply-template')
        if (select) select.value = ''
      })
    }
    const confirmBtn = templateConfirm.querySelector('[data-action="confirm"]')
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        templateConfirm.hidden = true
        if (templateKindPending && currentDashId) {
          const kind = templateKindPending
          templateKindPending = null
          await applyTemplate(currentDashId, kind)
          const select = document.getElementById('apply-template')
          if (select) select.value = ''
          await renderDashboard(currentDashId)
        }
      })
    }
  }

  const applySelect = document.getElementById('apply-template')
  if (applySelect && !applySelect._dashboardApplyAttached) {
    applySelect._dashboardApplyAttached = true
    applySelect.addEventListener('change', async (e) => {
      const kind = e.target.value
      if (!kind || !currentDashId) return

      const templateConfirm = document.getElementById('template-confirm')
      if (templateConfirm) {
        templateKindPending = kind
        templateConfirm.hidden = false
      } else {
        await applyTemplate(currentDashId, kind)
        e.target.value = ''
        await renderDashboard(currentDashId)
      }
    })
  }

  const deleteConfirm = document.getElementById('dashboard-delete-confirm')
  if (deleteConfirm && !deleteConfirm._dashboardDeleteAttached) {
    deleteConfirm._dashboardDeleteAttached = true
    const cancelBtn = deleteConfirm.querySelector('[data-action="cancel"]')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        deleteConfirm.hidden = true
        dashIdPendingDelete = null
      })
    }
    const confirmBtn = deleteConfirm.querySelector('[data-action="confirm"]')
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        deleteConfirm.hidden = true
        if (dashIdPendingDelete) {
          const targetId = dashIdPendingDelete
          dashIdPendingDelete = null
          await deleteDashboard(targetId)
          const l = await getLayout()
          const nextId = l.dashboards[0]?.id
          if (nextId) await setLastDashboard(nextId)
          await renderDashboard(nextId)
        }
      })
    }
  }

  const emptyEl = document.getElementById('dashboard-empty')
  if (emptyEl && !emptyEl._dashboardEmptyAttached) {
    emptyEl._dashboardEmptyAttached = true
    const emptyApply = emptyEl.querySelector('[data-action="apply-template"]')
    if (emptyApply) {
      emptyApply.addEventListener('click', async () => {
        if (currentDashId) {
          const select = document.getElementById('apply-template')
          const kind = select?.value || 'overview'
          await applyTemplate(currentDashId, kind)
          if (select) select.value = ''
          await renderDashboard(currentDashId)
        }
      })
    }
    const emptyTasks = emptyEl.querySelector('[data-action="go-tasks"]')
    if (emptyTasks) {
      emptyTasks.addEventListener('click', () => {
        const tabBtn = document.getElementById('tab-tasks')
        if (tabBtn) tabBtn.click()
      })
    }
  }

  const paletteToggle = document.getElementById('palette-toggle')
  if (paletteToggle && !paletteToggle._paletteToggleAttached) {
    paletteToggle._paletteToggleAttached = true
    paletteToggle.addEventListener('click', () => {
      const palette = document.getElementById('source-palette')
      if (!palette) return
      const collapsed = palette.classList.toggle('collapsed')
      paletteToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    })
  }

  const search = document.getElementById('palette-search')
  if (search && !search._paletteSearchAttached) {
    search._paletteSearchAttached = true
    search.addEventListener('input', () => {
      const q = (search.value || '').toLowerCase()
      const items = document.querySelectorAll('[data-palette-task]')
      for (const item of items) {
        const nameEl = item.querySelector('.palette-task-name')
        const name = ((nameEl ? nameEl.textContent : item.textContent) || '').toLowerCase()
        item.hidden = Boolean(q && !name.includes(q))
      }
    })
  }
}

/**
 * 建立卡片渲染共用 Context
 */
async function buildDashboardContext(dash) {
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
  const index = buildSeriesIndex(tasks)
  const tasksById = index.byId
  const parentTasksById = index.parents

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

  return {
    records,
    tasksById,
    parentTasksById,
    index,
    health,
    missed,
    nextRuns,
    today,
    range: { from: defaultFrom, to: defaultTo },
    editing,
    cards: dash.cards
  }
}

/**
 * 準備單張卡片 DOM 元素並綁定基本事件
 */
function prepareCardElement(card, ctx, dashId) {
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

  const removeHandles = cardEl.querySelectorAll('[data-remove-source]')
  for (const h of removeHandles) {
    const taskId = h.getAttribute('data-task-id')
    createDragSource(h, () => ({ removeFrom: { cardId: card.id, taskId } }))
  }

  cardEl.addEventListener('pointerdown', (e) => onPointerDown(e, card))

  const configBtn = cardEl.querySelector('[data-action="config"]')
  if (configBtn) {
    configBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openDrawer(dashId, card.id)
    })
  }

  return cardEl
}

// 側欄上的抓取模式標示
const MODE_LABELS = { number: '數值', text: '文字', block: '區塊' }

/**
 * 渲染資料來源側欄清單
 */
async function renderPalette() {
  const listEl = document.getElementById('palette-list')
  if (!listEl) return
  const tasks = await getTasks()
  listEl.textContent = ''
  const searchInput = document.getElementById('palette-search')
  const q = (searchInput?.value || '').toLowerCase()

  for (const t of tasks) {
    if (t.enabled === false) continue
    const item = document.createElement('div')
    item.setAttribute('data-palette-task', '')
    item.setAttribute('data-task-id', t.id)
    item.setAttribute('data-mode', t.mode || 'number')
    const nameEl = document.createElement('span')
    nameEl.className = 'palette-task-name'
    nameEl.textContent = t.name || ''
    item.appendChild(nameEl)
    const modeEl = document.createElement('span')
    modeEl.className = 'palette-task-mode'
    modeEl.textContent = MODE_LABELS[t.mode] || MODE_LABELS.number
    item.appendChild(modeEl)
    if (q && !item.textContent.toLowerCase().includes(q)) {
      item.hidden = true
    }
    createDragSource(item, () => ({ taskId: t.id, label: t.name }))
    listEl.appendChild(item)
  }
}

/**
 * 將卡片註冊為拖曳投放目標
 */
function registerCardDropTarget(cardEl, card, ctx) {
  cardEl._unregisterDropTarget = registerDropTarget(cardEl, {
    accepts(payload) {
      if (!editing) return false
      if (!payload || !payload.taskId || payload.removeFrom) return false
      // 表格永遠收:落點才決定插到第幾欄,已經在最後一欄的任務也要能拖到前面。
      // 用空 opts 問 applyDrop 等於問「搬到最後有沒有變化」,會讓最後一欄拖不動。
      if (card.type === 'table') return true
      return applyDrop(card, payload.taskId, {}) !== null
    },
    async onDrop(payload, pos) {
      if (!payload || !payload.taskId) return

      let index
      if (card.type === 'table' && card.options?.mode === 'pivot') {
        const ths = [...cardEl.querySelectorAll('thead th')]
        const hasReadableHeaders = ths.length > 0 && ths.some(th => {
          const r = th.getBoundingClientRect?.()
          return r && (r.width > 0 || r.right > r.left)
        })
        if (hasReadableHeaders) {
          let targetCol = -1
          const x = pos?.x ?? 0
          for (let i = 0; i < ths.length; i++) {
            const rect = ths[i].getBoundingClientRect()
            const midX = rect.left + rect.width / 2
            if (x < midX) {
              targetCol = i
              break
            }
          }
          if (targetCol === -1) {
            index = ths.length - 1
          } else {
            index = Math.max(0, targetCol - 1)
          }
        }
      }

      const opts = {}
      if (typeof index === 'number') {
        opts.index = index
      }
      const taskName = payload.label || ctx?.tasksById?.[payload.taskId]?.name
      if (typeof taskName === 'string' && taskName) {
        opts.taskName = taskName
      }
      const firstTaskId = card.source?.[0]?.taskId
      const prevTaskName = firstTaskId ? ctx?.tasksById?.[firstTaskId]?.name : undefined
      if (typeof prevTaskName === 'string' && prevTaskName) {
        opts.prevTaskName = prevTaskName
      }

      const patch = applyDrop(card, payload.taskId, opts)
      if (!patch) return
      if (patch.rejected) {
        showToast(patch.reason)
        return
      }

      await pushHistory()
      await updateCard(currentDashId, card.id, patch)
      await renderDashboard(currentDashId)
    }
  })
}

/**
 * 把落點座標換算成格線上的欄列(夾在合法範圍內)
 */
function gridCellAt(grid, pos, w) {
  if (!grid || !pos || typeof grid.getBoundingClientRect !== 'function') return { x: 0, y: 0 }
  const rect = grid.getBoundingClientRect()
  if (!rect || !rect.width) return { x: 0, y: 0 }
  const colWidth = rect.width / 12
  const rowHeight = 80
  const x = Math.max(0, Math.min(12 - w, Math.floor((pos.x - rect.left) / colWidth)))
  const y = Math.max(0, Math.floor((pos.y - rect.top) / rowHeight))
  return { x, y }
}

/**
 * 指標是否落在某張卡片上(矩形判定用 dnd.js 那一份,不要再寫一次)
 */
function pointerOverAnyCard(grid, pos) {
  if (!grid || !pos) return false
  return [...grid.querySelectorAll('[data-card-id]')].some(el => isPointInside(el, pos))
}

/**
 * 將格線註冊為拖曳投放目標（拖到空白格建新卡片、或拖出卡片移除資料來源）
 */
function registerGridDropTarget(grid) {
  grid._unregisterDropTarget = registerDropTarget(grid, {
    accepts(payload, pos) {
      if (!editing) return false
      if (!payload) return false
      // 拖著移除把手時,放在哪張卡片上都算移除,格線一律接手
      if (payload.removeFrom) return true
      // 指標正壓在某張卡片上時交給那張卡片決定;它不收就是不收,
      // 不可在它底下偷偷長出一張新卡片
      if (payload.taskId) return !pointerOverAnyCard(grid, pos)
      return false
    },
    async onDrop(payload, pos) {
      if (!editing || !payload) return

      if (payload.removeFrom) {
        const { cardId, taskId } = payload.removeFrom
        if (!cardId || !taskId) return

        // 放回原本那張卡片上不算移除
        const cardEl = grid.querySelector(`[data-card-id="${cardId}"]`)
        if (isPointInside(cardEl, pos)) return

        const layout = await getLayout()
        const currentDash = layout.dashboards.find(d => d.id === currentDashId) || layout.dashboards[0]
        if (!currentDash) return
        const card = currentDash.cards.find(c => c.id === cardId)
        if (!card) return

        // status 卡片的來源存在 options.taskIds,不是 source
        const patch = card.type === 'status'
          ? { options: { ...(card.options || {}), taskIds: (card.options?.taskIds || []).filter(id => id !== taskId) } }
          : { source: (card.source || []).filter(s => s.taskId !== taskId) }
        await pushHistory()
        await updateCard(currentDash.id, cardId, patch)
        await renderDashboard(currentDash.id)
        return
      }

      if (payload.taskId) {
        const tasks = await getTasks()
        const task = tasks.find(t => t.id === payload.taskId)
        const type = cardTypeForTask(task)

        let w = 6
        let h = 2
        if (type === 'number') {
          w = 3
          h = 2
        } else if (type === 'table') {
          w = 12
          h = 4
        }

        const layout = await getLayout()
        const currentDash = layout.dashboards.find(d => d.id === currentDashId) || layout.dashboards[0]
        if (!currentDash) return

        // 落點所在的格子當作希望的位置;放不下時交給 addCard 自己找空位
        const wanted = gridCellAt(grid, pos, w)
        const newCard = {
          type,
          w,
          h,
          x: wanted.x,
          y: wanted.y,
          source: [{ taskId: payload.taskId, aggregation: 'raw' }],
          options: type === 'table' ? { mode: 'recent' } : {}
        }

        await pushHistory()
        await addCard(currentDash.id, newCard)
        await renderDashboard(currentDash.id)
      }
    }
  })
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

  const tabsContainer = document.getElementById('dashboard-tabs')
  if (tabsContainer) {
    tabsContainer.textContent = ''
    for (const d of layout.dashboards) {
      const tabEl = document.createElement('div')
      tabEl.className = 'dash-tab'
      tabEl.dataset.dashId = d.id
      if (d.id === dash.id) {
        tabEl.classList.add('active')
      }

      const input = document.createElement('input')
      input.type = 'text'
      input.value = d.name || ''
      input.addEventListener('change', async (e) => {
        await renameDashboard(d.id, e.target.value)
      })
      input.addEventListener('click', (e) => {
        e.stopPropagation()
      })
      input.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
      })

      const actions = document.createElement('div')
      actions.className = 'dash-tab-actions'

      const dupBtn = document.createElement('button')
      dupBtn.type = 'button'
      dupBtn.dataset.action = 'duplicate'
      dupBtn.title = '複製儀表板'
      dupBtn.textContent = '⧉'
      dupBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const dup = await duplicateDashboard(d.id)
        if (dup) {
          await setLastDashboard(dup.id)
          await renderDashboard(dup.id)
        }
      })
      dupBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
      })

      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.dataset.action = 'delete'
      delBtn.title = '刪除儀表板'
      delBtn.textContent = '×'
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        dashIdPendingDelete = d.id
        const confirmDlg = document.getElementById('dashboard-delete-confirm')
        if (confirmDlg) confirmDlg.hidden = false
      })
      delBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
      })

      actions.appendChild(dupBtn)
      actions.appendChild(delBtn)

      tabEl.appendChild(input)
      tabEl.appendChild(actions)

      tabEl.addEventListener('click', async (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return
        if (tabDrag?.moved) return
        await setLastDashboard(d.id)
        if (d.id !== currentDashId) {
          await renderDashboard(d.id)
        }
      })

      tabEl.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return
        if (e.target.closest('button') || e.target.closest('input')) return

        if (typeof e.target.setPointerCapture === 'function') {
          e.target.setPointerCapture(e.pointerId)
        }

        tabDrag = {
          id: d.id,
          el: tabEl,
          startX: e.clientX,
          startY: e.clientY,
          pointerId: e.pointerId,
          moved: false
        }
      })

      tabEl.addEventListener('pointermove', (e) => {
        if (!tabDrag || tabDrag.id !== d.id) return
        const dx = Math.abs(e.clientX - tabDrag.startX)
        const dy = Math.abs(e.clientY - tabDrag.startY)
        if (dx > 4 || dy > 4) {
          tabDrag.moved = true
        }
        if (!tabDrag.moved) return

        const tabs = [...tabsContainer.querySelectorAll('[data-dash-id]')]
        for (const other of tabs) {
          if (other === tabDrag.el) continue
          const rect = other.getBoundingClientRect ? other.getBoundingClientRect() : null
          if (rect && rect.width > 0) {
            const midX = rect.left + rect.width / 2
            if (e.clientX < midX && other.nextSibling === tabDrag.el) {
              tabsContainer.insertBefore(tabDrag.el, other)
              break
            } else if (e.clientX > midX && tabDrag.el.nextSibling === other) {
              tabsContainer.insertBefore(tabDrag.el, other.nextSibling)
              break
            }
          }
        }
      })

      tabEl.addEventListener('pointerup', async (e) => {
        if (!tabDrag || tabDrag.id !== d.id) return
        const dragInfo = tabDrag
        tabDrag = null

        if (typeof e.target.releasePointerCapture === 'function') {
          try { e.target.releasePointerCapture(dragInfo.pointerId) } catch {}
        }

        if (dragInfo.moved) {
          const ids = [...tabsContainer.querySelectorAll('[data-dash-id]')].map(el => el.dataset.dashId)
          await reorderDashboards(ids)
        }
      })

      tabsContainer.appendChild(tabEl)
    }
  }

  if (typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < 900) {
    grid.classList.add('single-column')
  } else {
    grid.classList.remove('single-column')
  }

  const ctx = await buildDashboardContext(dash)
  const cards = Array.isArray(dash.cards) ? dash.cards : []

  const emptyEl = document.getElementById('dashboard-empty')
  if (emptyEl) {
    emptyEl.hidden = cards.length > 0
  }

  resetDnd()

  await renderPalette()

  grid.textContent = ''

  registerGridDropTarget(grid)

  for (const card of cards) {
    const cardEl = prepareCardElement(card, ctx, dash.id)
    registerCardDropTarget(cardEl, card, ctx)
    grid.appendChild(cardEl)
  }

  // 放在卡片都掛上之後:它會逐個把手設顯示/隱藏,放前面只會打在即將丟棄的舊 DOM 上
  updateEditingUI()
}

/**
 * 僅重新渲染指定單張卡片（不重建其他卡片 DOM 節點）
 */
export async function rerenderCard(dashId, cardId) {
  const layout = await getLayout()
  let dash = null
  if (dashId) {
    dash = layout.dashboards.find(d => d.id === dashId)
  }
  if (!dash) {
    dash = layout.dashboards.find(d => d.id === currentDashId) || layout.dashboards[0]
  }
  if (!dash) return

  const card = dash.cards.find(c => c.id === cardId)
  if (!card) return

  const grid = document.getElementById('dashboard-grid')
  if (!grid) return

  const oldCardEl = grid.querySelector(`[data-card-id="${cardId}"]`)
  if (!oldCardEl) return

  if (typeof oldCardEl._unregisterDropTarget === 'function') {
    oldCardEl._unregisterDropTarget()
  }

  const ctx = await buildDashboardContext(dash)
  const newCardEl = prepareCardElement(card, ctx, dash.id)
  registerCardDropTarget(newCardEl, card, ctx)

  oldCardEl.replaceWith(newCardEl)
}
