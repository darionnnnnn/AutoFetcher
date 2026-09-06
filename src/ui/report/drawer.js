// AutoFetcher 卡片設定抽屜模組（SPEC I1）

import { getLayout, updateCard, removeCard } from '../../shared/layout-store.js'
import { getTasks } from '../../shared/storage.js'
import { rerenderCard, renderDashboard } from './dashboard.js'

let currentDashId = null
let currentCardId = null
let currentCard = null
let snapshot = null
let cachedTasks = []

/**
 * 依型別更新欄位分組容器的顯示／隱藏
 */
function updateFieldVisibility(type) {
  const fieldSources = document.getElementById('drawer-field-sources')
  const fieldNumber = document.getElementById('drawer-field-number')
  const fieldTable = document.getElementById('drawer-field-table')
  const fieldStatus = document.getElementById('drawer-field-status')
  const fieldYaxis = document.getElementById('drawer-field-yaxis')
  const fieldContent = document.getElementById('drawer-field-content')
  const fieldGauge = document.getElementById('drawer-field-gauge')

  if (fieldSources) fieldSources.hidden = (type === 'text')
  if (fieldNumber) fieldNumber.hidden = (type !== 'number')
  if (fieldTable) fieldTable.hidden = (type !== 'table')
  if (fieldStatus) fieldStatus.hidden = (type !== 'status')
  if (fieldYaxis) fieldYaxis.hidden = (type !== 'line' && type !== 'bar')
  if (fieldContent) fieldContent.hidden = (type !== 'text')
  if (fieldGauge) fieldGauge.hidden = (type !== 'gauge')
}

/**
 * 依型別更新來源任務 checkbox 的停用狀態與說明文字
 */
function updateSourcesDisabledState(type) {
  const container = document.getElementById('drawer-sources')
  if (!container) return
  const isNumeric = ['number', 'line', 'bar', 'gauge'].includes(type)

  for (const t of cachedTasks) {
    const input = container.querySelector(`input[value="${t.id}"]`)
    if (!input) continue
    const label = input.closest('label') || input.parentElement
    if (isNumeric && t.mode === 'text') {
      input.disabled = true
      if (label) {
        label.textContent = ''
        label.appendChild(input)
        label.appendChild(document.createTextNode(` ${t.name || t.id}（文字模式不可選）`))
      }
    } else {
      input.disabled = false
      if (label) {
        label.textContent = ''
        label.appendChild(input)
        label.appendChild(document.createTextNode(` ${t.name || t.id}`))
      }
    }
  }
}

/**
 * 產生來源任務清單 checkbox
 * 已選的來源依 card.source 的順序排在前面(那個順序就是表格的欄序),
 * 每一列附上下移動按鈕;未選的任務接在後面
 */
function renderSources(tasks, currentSources = [], type = 'number') {
  const container = document.getElementById('drawer-sources')
  if (!container) return
  container.textContent = ''

  const isNumeric = ['number', 'line', 'bar', 'gauge'].includes(type)
  const selectedIds = (currentSources || []).map(s => s && s.taskId).filter(Boolean)
  const taskById = new Map(tasks.map(t => [t.id, t]))

  // 已選的照欄序,未選的照任務清單順序接在後面
  const ordered = []
  for (const id of selectedIds) {
    if (taskById.has(id)) ordered.push({ task: taskById.get(id), checked: true })
  }
  const selectedSet = new Set(selectedIds)
  for (const t of tasks) {
    if (!selectedSet.has(t.id)) ordered.push({ task: t, checked: false })
  }

  const selectedCount = ordered.filter(o => o.checked).length

  ordered.forEach((entry, idx) => {
    const t = entry.task
    const row = document.createElement('div')
    row.setAttribute('data-source-row', '')
    row.setAttribute('data-task-id', t.id)

    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = t.id
    input.checked = entry.checked

    if (isNumeric && t.mode === 'text') {
      input.disabled = true
      label.appendChild(input)
      label.appendChild(document.createTextNode(` ${t.name || t.id}（文字模式不可選）`))
    } else {
      input.disabled = false
      label.appendChild(input)
      label.appendChild(document.createTextNode(` ${t.name || t.id}`))
    }
    row.appendChild(label)

    // 只有已選的來源需要調整欄序
    if (entry.checked) {
      const up = document.createElement('button')
      up.type = 'button'
      up.setAttribute('data-action', 'source-up')
      up.textContent = '↑'
      up.title = '往前移一欄'
      up.disabled = idx === 0
      const down = document.createElement('button')
      down.type = 'button'
      down.setAttribute('data-action', 'source-down')
      down.textContent = '↓'
      down.title = '往後移一欄'
      down.disabled = idx === selectedCount - 1
      row.appendChild(up)
      row.appendChild(down)
    }

    container.appendChild(row)
  })
}

/**
 * 產生狀態清單任務篩選 checkbox
 */
function renderStatusTasks(tasks, taskIds = []) {
  const container = document.getElementById('drawer-status-tasks')
  if (!container) return
  container.textContent = ''

  const selectedSet = new Set(Array.isArray(taskIds) ? taskIds : [])

  for (const t of tasks) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = t.id
    input.checked = selectedSet.has(t.id)

    label.appendChild(input)
    label.appendChild(document.createTextNode(` ${t.name || t.id}`))
    container.appendChild(label)
  }
}

/**
 * 從抽屜表單欄位收集變更補丁（patch 轉換只寫一份）
 */
function collectPatch() {
  const titleInput = document.getElementById('drawer-title')
  const title = titleInput ? titleInput.value : ''

  const typeSelect = document.getElementById('drawer-type')
  const type = typeSelect ? typeSelect.value : 'number'

  const options = { ...(currentCard?.options || {}) }

  // 來源任務與聚合（fieldSources）
  const fieldSources = document.getElementById('drawer-field-sources')
  let source = currentCard?.source ? [...currentCard.source] : []
  if (fieldSources && !fieldSources.hidden) {
    const sourcesContainer = document.getElementById('drawer-sources')
    const checkedBoxes = sourcesContainer ? sourcesContainer.querySelectorAll('input[type="checkbox"]:checked') : []
    const aggSelect = document.getElementById('drawer-aggregation')
    const aggVal = (aggSelect && aggSelect.value) ? aggSelect.value : 'raw'

    source = []
    for (const box of checkedBoxes) {
      const tid = box.value
      const existing = currentCard?.source?.find(s => s.taskId === tid)
      source.push({
        taskId: tid,
        aggregation: existing?.aggregation || aggVal
      })
    }
    options.aggregation = aggVal
  }

  // 期間（全域設定）
  const periodSelect = document.getElementById('drawer-period')
  if (periodSelect) {
    const periodVal = periodSelect.value
    if (periodVal === 'range') {
      options.period = 'range'
    } else if (periodVal != null && periodVal !== '') {
      options.period = Number(periodVal)
    }
  }

  // 數值卡片分組（fieldNumber）
  const fieldNumber = document.getElementById('drawer-field-number')
  if (fieldNumber && !fieldNumber.hidden) {
    // 比較基準
    const compareSelect = document.getElementById('drawer-compare')
    options.compare = (compareSelect && compareSelect.value) ? compareSelect.value : 'prev'

    // 小數位數
    const decimalsInput = document.getElementById('drawer-decimals')
    if (decimalsInput && decimalsInput.value !== '' && !Number.isNaN(Number(decimalsInput.value))) {
      options.decimals = Number(decimalsInput.value)
    } else {
      delete options.decimals
    }

    // 單位
    const unitInput = document.getElementById('drawer-unit')
    if (unitInput && unitInput.value !== '') {
      options.unit = unitInput.value
    } else {
      delete options.unit
    }

    // 閾值
    const thValInput = document.getElementById('drawer-threshold-value')
    if (thValInput && thValInput.value !== '' && !Number.isNaN(Number(thValInput.value))) {
      const opSelect = document.getElementById('drawer-threshold-op')
      const colorInput = document.getElementById('drawer-threshold-color')
      options.thresholds = [{
        op: (opSelect && opSelect.value) ? opSelect.value : 'gte',
        value: Number(thValInput.value),
        color: (colorInput && colorInput.value) ? colorInput.value : 'var(--warn)'
      }]
    } else {
      options.thresholds = []
    }

    // 迷你走勢圖
    const sparklineBox = document.getElementById('drawer-sparkline')
    if (sparklineBox) {
      options.sparkline = sparklineBox.checked
    }
  }

  // 表格卡片分組（fieldTable）
  const fieldTable = document.getElementById('drawer-field-table')
  if (fieldTable && !fieldTable.hidden) {
    const tableModeSelect = document.getElementById('drawer-table-mode')
    options.mode = (tableModeSelect && tableModeSelect.value) ? tableModeSelect.value : 'recent'

    const limitInput = document.getElementById('drawer-limit')
    if (limitInput && limitInput.value !== '' && Number.isFinite(Number(limitInput.value))) {
      options.limit = Number(limitInput.value)
    } else {
      delete options.limit
    }

    const rowHeaderInput = document.getElementById('drawer-row-header')
    if (rowHeaderInput && rowHeaderInput.value.trim() !== '') {
      options.rowHeader = rowHeaderInput.value.trim()
    } else {
      delete options.rowHeader
    }

    // 容差存成數字,pivot 用 Number.isInteger 判斷,存字串會整個失效
    const bucketSelect = document.getElementById('drawer-bucket')
    if (bucketSelect && bucketSelect.value !== '' && Number.isFinite(Number(bucketSelect.value))) {
      options.bucketMinutes = Number(bucketSelect.value)
    } else {
      delete options.bucketMinutes
    }
  }

  // 狀態卡片分組（fieldStatus）
  const fieldStatus = document.getElementById('drawer-field-status')
  if (fieldStatus && !fieldStatus.hidden) {
    const statusContainer = document.getElementById('drawer-status-tasks')
    const checkedBoxes = statusContainer ? statusContainer.querySelectorAll('input[type="checkbox"]:checked') : []
    options.taskIds = Array.from(checkedBoxes).map(b => b.value)
  }

  // Y 軸與正規化分組（fieldYaxis）
  const fieldYaxis = document.getElementById('drawer-field-yaxis')
  if (fieldYaxis && !fieldYaxis.hidden) {
    const yminInput = document.getElementById('drawer-ymin')
    if (yminInput && yminInput.value !== '' && !Number.isNaN(Number(yminInput.value))) {
      options.yMin = Number(yminInput.value)
    } else {
      delete options.yMin
    }
    const ymaxInput = document.getElementById('drawer-ymax')
    if (ymaxInput && ymaxInput.value !== '' && !Number.isNaN(Number(ymaxInput.value))) {
      options.yMax = Number(ymaxInput.value)
    } else {
      delete options.yMax
    }

    const normSelect = document.getElementById('drawer-normalize')
    if (normSelect && normSelect.value && normSelect.value !== 'none') {
      options.normalize = normSelect.value
    } else {
      delete options.normalize
    }
  }

  // 文字內容分組（fieldContent）
  const fieldContent = document.getElementById('drawer-field-content')
  if (fieldContent && !fieldContent.hidden) {
    const contentInput = document.getElementById('drawer-content')
    if (contentInput && contentInput.value !== '') {
      options.content = contentInput.value
    } else {
      delete options.content
    }
  }

  // 儀表分組（fieldGauge）
  const fieldGauge = document.getElementById('drawer-field-gauge')
  if (fieldGauge && !fieldGauge.hidden) {
    const gminInput = document.getElementById('drawer-gauge-min')
    if (gminInput && gminInput.value !== '' && !Number.isNaN(Number(gminInput.value))) {
      options.min = Number(gminInput.value)
    } else {
      delete options.min
    }
    const gmaxInput = document.getElementById('drawer-gauge-max')
    if (gmaxInput && gmaxInput.value !== '' && !Number.isNaN(Number(gmaxInput.value))) {
      options.max = Number(gmaxInput.value)
    } else {
      delete options.max
    }
    const gwarnInput = document.getElementById('drawer-gauge-warn')
    if (gwarnInput && gwarnInput.value !== '' && !Number.isNaN(Number(gwarnInput.value))) {
      options.warn = Number(gwarnInput.value)
    } else {
      delete options.warn
    }
  }

  return { title, type, source, options }
}

/**
 * 表單內容填入
 */
function populateFields(card) {
  const titleInput = document.getElementById('drawer-title')
  if (titleInput) titleInput.value = card.title ?? ''

  const typeSelect = document.getElementById('drawer-type')
  if (typeSelect) typeSelect.value = card.type || 'number'

  const periodSelect = document.getElementById('drawer-period')
  if (periodSelect) {
    periodSelect.value = card.options?.period != null ? String(card.options.period) : 'range'
  }

  const aggSelect = document.getElementById('drawer-aggregation')
  if (aggSelect) {
    aggSelect.value = card.options?.aggregation || card.source?.[0]?.aggregation || 'raw'
  }

  const decimalsInput = document.getElementById('drawer-decimals')
  if (decimalsInput) {
    decimalsInput.value = card.options?.decimals != null ? String(card.options.decimals) : ''
  }

  const unitInput = document.getElementById('drawer-unit')
  if (unitInput) {
    unitInput.value = card.options?.unit ?? ''
  }

  const th = card.options?.thresholds?.[0]
  const thOpSelect = document.getElementById('drawer-threshold-op')
  if (thOpSelect) thOpSelect.value = th?.op || 'gte'
  const thValInput = document.getElementById('drawer-threshold-value')
  if (thValInput) thValInput.value = th?.value != null ? String(th.value) : ''
  const thColorInput = document.getElementById('drawer-threshold-color')
  if (thColorInput) thColorInput.value = th?.color || 'var(--warn)'

  const sparklineBox = document.getElementById('drawer-sparkline')
  if (sparklineBox) {
    sparklineBox.checked = Boolean(card.options?.sparkline)
  }

  const yminInput = document.getElementById('drawer-ymin')
  if (yminInput) yminInput.value = card.options?.yMin != null ? String(card.options.yMin) : ''
  const ymaxInput = document.getElementById('drawer-ymax')
  if (ymaxInput) ymaxInput.value = card.options?.yMax != null ? String(card.options.yMax) : ''

  const normSelect = document.getElementById('drawer-normalize')
  if (normSelect) normSelect.value = card.options?.normalize || 'none'

  const contentInput = document.getElementById('drawer-content')
  if (contentInput) contentInput.value = card.options?.content ?? ''

  const gminInput = document.getElementById('drawer-gauge-min')
  if (gminInput) gminInput.value = card.options?.min != null ? String(card.options.min) : ''
  const gmaxInput = document.getElementById('drawer-gauge-max')
  if (gmaxInput) gmaxInput.value = card.options?.max != null ? String(card.options.max) : ''
  const gwarnInput = document.getElementById('drawer-gauge-warn')
  if (gwarnInput) gwarnInput.value = card.options?.warn != null ? String(card.options.warn) : ''

  // 比較基準
  const compareSelect = document.getElementById('drawer-compare')
  if (compareSelect) {
    compareSelect.value = card.options?.compare || 'prev'
  }

  // 表格模式與筆數上限
  const tableModeSelect = document.getElementById('drawer-table-mode')
  if (tableModeSelect) {
    tableModeSelect.value = card.options?.mode || 'recent'
  }
  const limitInput = document.getElementById('drawer-limit')
  if (limitInput) {
    limitInput.value = card.options?.limit != null ? String(card.options.limit) : ''
  }
  const rowHeaderInput = document.getElementById('drawer-row-header')
  if (rowHeaderInput) {
    rowHeaderInput.value = card.options?.rowHeader ?? ''
  }
  const bucketSelect = document.getElementById('drawer-bucket')
  if (bucketSelect) {
    bucketSelect.value = card.options?.bucketMinutes != null ? String(card.options.bucketMinutes) : '0'
  }

  renderSources(cachedTasks, card.source, card.type)
  renderStatusTasks(cachedTasks, card.options?.taskIds)
  updateFieldVisibility(card.type)
}

/**
 * 立即套用欄位變更至 storage 與畫面
 */
async function applyChanges(e) {
  if (!currentDashId || !currentCardId) return

  if (e?.target?.id === 'drawer-type') {
    const newType = document.getElementById('drawer-type')?.value || 'number'
    updateFieldVisibility(newType)
    updateSourcesDisabledState(newType)
  }

  const patch = collectPatch()
  currentCard = {
    ...currentCard,
    ...patch,
    options: { ...(patch.options || {}) }
  }

  await updateCard(currentDashId, currentCardId, patch)
  await rerenderCard(currentDashId, currentCardId)
}

/**
 * 還原卡片至開啟時的快照
 */
async function onRevert() {
  if (!currentDashId || !currentCardId || !snapshot) return
  currentCard = structuredClone(snapshot)
  await updateCard(currentDashId, currentCardId, currentCard)
  await rerenderCard(currentDashId, currentCardId)
  populateFields(currentCard)
}

/**
 * 設定抽屜相關 DOM 事件監聽
 */
function setupDrawerEvents() {
  const drawer = document.getElementById('card-drawer')
  if (!drawer || drawer._drawerEventsAttached) return
  drawer._drawerEventsAttached = true

  const closeBtn = document.getElementById('drawer-close')
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeDrawer())
  }

  const revertBtn = document.getElementById('drawer-revert')
  if (revertBtn) {
    revertBtn.addEventListener('click', () => onRevert())
  }

  const deleteBtn = document.getElementById('drawer-delete')
  const deleteConfirm = document.getElementById('drawer-delete-confirm')
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      if (deleteConfirm) deleteConfirm.hidden = false
    })
  }

  if (deleteConfirm) {
    const cancelBtn = deleteConfirm.querySelector('[data-action="cancel"]')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        deleteConfirm.hidden = true
      })
    }
    const confirmBtn = deleteConfirm.querySelector('[data-action="confirm"]')
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (!currentDashId || !currentCardId) return
        const did = currentDashId
        const cid = currentCardId
        await removeCard(did, cid)
        await renderDashboard(did)
        closeDrawer()
      })
    }
  }

  drawer.addEventListener('change', (e) => {
    applyChanges(e)
  })

  // 來源欄序調整(欄序就是表格的欄順序)
  drawer.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-action="source-up"], [data-action="source-down"]')
    if (!btn || btn.disabled) return
    const row = btn.closest('[data-source-row]')
    if (!row) return
    moveSource(row.getAttribute('data-task-id'), btn.getAttribute('data-action') === 'source-up' ? -1 : 1)
  })
}

/**
 * 把某個來源在欄序中前後移動一位,並立即寫回卡片
 */
async function moveSource(taskId, delta) {
  if (!currentDashId || !currentCardId || !currentCard) return
  const source = [...(currentCard.source || [])]
  const from = source.findIndex(s => s && s.taskId === taskId)
  const to = from + delta
  if (from === -1 || to < 0 || to >= source.length) return

  const [moved] = source.splice(from, 1)
  source.splice(to, 0, moved)

  currentCard = { ...currentCard, source }
  await updateCard(currentDashId, currentCardId, { source })
  await rerenderCard(currentDashId, currentCardId)
  renderSources(cachedTasks, source, currentCard.type)
}

/**
 * 開啟卡片設定抽屜
 */
export async function openDrawer(dashId, cardId) {
  const layout = await getLayout()
  let dash = null
  if (dashId) {
    dash = layout.dashboards.find(d => d.id === dashId)
  }
  if (!dash) {
    dash = layout.dashboards.find(d => d.cards.some(c => c.id === cardId)) || layout.dashboards[0]
  }
  if (!dash) return

  const card = dash.cards.find(c => c.id === cardId)
  if (!card) return

  currentDashId = dash.id
  currentCardId = card.id
  snapshot = structuredClone(card)
  currentCard = structuredClone(card)

  try {
    cachedTasks = await getTasks()
  } catch {
    cachedTasks = []
  }

  setupDrawerEvents()
  populateFields(currentCard)

  const deleteConfirm = document.getElementById('drawer-delete-confirm')
  if (deleteConfirm) deleteConfirm.hidden = true

  const drawer = document.getElementById('card-drawer')
  if (drawer) drawer.hidden = false
}

/**
 * 關閉卡片設定抽屜
 */
export function closeDrawer() {
  const drawer = document.getElementById('card-drawer')
  if (drawer) drawer.hidden = true
  const deleteConfirm = document.getElementById('drawer-delete-confirm')
  if (deleteConfirm) deleteConfirm.hidden = true
}
