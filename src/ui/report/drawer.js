// AutoFetcher 卡片設定抽屜模組（SPEC I1）
// 草稿模型（AF-21 批次 4 定案 5）：抽屜裡的變更只改草稿、即時預覽在畫面上那張卡，
// 按「套用」才一次寫進 storage；「取消」與其他關閉方式丟掉草稿（有變更時先問）。

import { getLayout, updateCard, removeCard } from '../../shared/layout-store.js'
import { getTasks } from '../../shared/storage.js'
import { rerenderCard, renderDashboard } from './dashboard.js'
import { buildSeriesIndex } from '../../shared/series-index.js'
import { confirmDialog, isDialogOpen } from '../modal.js'

// 草稿只管抽屜自己的欄位；位置與大小不在草稿內（拖曳縮放照舊即時寫）
const DRAFT_KEYS = ['title', 'type', 'source', 'options']

let currentDashId = null
let currentCardId = null
// 草稿：開啟時從卡片深拷貝，抽屜裡的變更只改它
let currentCard = null
// 開啟當下的草稿欄位（判斷有沒有變更、套用時只寫有變的欄位）
let baseline = null
let cachedTasks = []
// 關閉流程進行中（確認框開著時不重複問）
let closing = null

function pickDraft(card) {
  const out = {}
  for (const k of DRAFT_KEYS) {
    if (card && card[k] !== undefined) out[k] = structuredClone(card[k])
  }
  return out
}

// 各欄位與開啟當下不同的那些（只寫有變的欄位）
function changedFields() {
  if (!currentCard || !baseline) return {}
  const draft = pickDraft(currentCard)
  const out = {}
  for (const k of DRAFT_KEYS) {
    if (JSON.stringify(draft[k]) !== JSON.stringify(baseline[k])) out[k] = draft[k]
  }
  return out
}

function isDirty() {
  return Object.keys(changedFields()).length > 0
}

function isOpen() {
  const drawer = document.getElementById('card-drawer')
  return Boolean(drawer && !drawer.hidden && currentCardId)
}

/**
 * 抽屜正在編輯這張卡時回傳草稿欄位（儀表板重畫時用它蓋過 storage 版本），否則 null
 */
export function getDraftPreview(dashId, cardId) {
  if (!isOpen() || !currentCard) return null
  if (cardId !== currentCardId) return null
  if (dashId && currentDashId && dashId !== currentDashId) return null
  return pickDraft(currentCard)
}

/**
 * 把投放到正在編輯那張卡的補丁併進草稿（不寫 storage）；不是這張卡回傳 false
 * 補丁由呼叫端以草稿為基準經 drop-rules 算好（同一套去重與上限）
 */
export async function mergeIntoDraft(dashId, cardId, patch) {
  if (!getDraftPreview(dashId, cardId) || !patch) return false
  const next = { ...currentCard }
  for (const k of DRAFT_KEYS) {
    if (patch[k] !== undefined) next[k] = structuredClone(patch[k])
  }
  currentCard = next
  populateFields(currentCard)
  await previewDraft()
  return true
}

// 用草稿重畫畫面上那張卡（不寫 storage）
async function previewDraft() {
  if (!currentDashId || !currentCardId || !currentCard) return
  await rerenderCard(currentDashId, currentCardId, pickDraft(currentCard))
}

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
 * 更新多值任務父列全選勾選框之狀態
 */
function updateToggleAllState(parentId) {
  const container = document.getElementById('drawer-sources')
  if (!container) return
  const parentBox = container.querySelector(`input[data-action="toggle-all"][data-parent-id="${parentId}"]`)
  if (!parentBox) return
  const childBoxes = [...container.querySelectorAll(`input[data-source-checkbox][data-parent-id="${parentId}"]`)]
  if (childBoxes.length === 0) return
  const checkedCount = childBoxes.filter(cb => cb.checked).length
  if (checkedCount === childBoxes.length) {
    parentBox.checked = true
    parentBox.indeterminate = false
  } else if (checkedCount === 0) {
    parentBox.checked = false
    parentBox.indeterminate = false
  } else {
    parentBox.checked = false
    parentBox.indeterminate = true
  }
}

/**
 * 依型別更新來源任務 checkbox 的停用狀態與說明文字
 */
function updateSourcesDisabledState(type) {
  const container = document.getElementById('drawer-sources')
  if (!container) return
  const isNumeric = ['number', 'line', 'bar', 'gauge'].includes(type)
  const index = buildSeriesIndex(cachedTasks)

  for (const t of cachedTasks) {
    const isMulti = Array.isArray(t.fields) && t.fields.length > 0
    if (isMulti) {
      const parentBox = container.querySelector(`input[data-action="toggle-all"][data-parent-id="${t.id}"]`)
      if (parentBox) {
        parentBox.disabled = isNumeric && t.mode === 'text'
        const label = parentBox.closest('label') || parentBox.parentElement
        if (label) {
          label.textContent = ''
          label.appendChild(parentBox)
          label.appendChild(document.createTextNode(isNumeric && t.mode === 'text' ? ` ${t.name || t.id}（文字模式不可選）` : ` ${t.name || t.id}`))
        }
      }
      for (const sid of (index.childrenOf[t.id] || [])) {
        const seriesInfo = index.byId[sid]
        const input = container.querySelector(`input[data-source-checkbox][value="${sid}"]`)
        if (!input) continue
        const label = input.closest('label') || input.parentElement
        const disabled = isNumeric && seriesInfo?.mode === 'text'
        input.disabled = disabled
        if (label) {
          label.textContent = ''
          label.appendChild(input)
          const displayName = seriesInfo?.shortName || seriesInfo?.name || sid
          label.appendChild(document.createTextNode(disabled ? ` ${displayName}（文字模式不可選）` : ` ${displayName}`))
        }
      }
    } else {
      const input = container.querySelector(`input[data-source-checkbox][value="${t.id}"]`)
      if (!input) continue
      const label = input.closest('label') || input.parentElement
      const seriesInfo = index.byId[t.id]
      const disabled = isNumeric && seriesInfo?.mode === 'text'
      input.disabled = disabled
      if (label) {
        label.textContent = ''
        label.appendChild(input)
        const displayName = t.name || t.id
        label.appendChild(document.createTextNode(disabled ? ` ${displayName}（文字模式不可選）` : ` ${displayName}`))
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
  const selectedSet = new Set(selectedIds)
  const index = buildSeriesIndex(tasks)

  // 組織任務與序列的排序
  const taskEntries = []
  for (const t of tasks) {
    const isMulti = Array.isArray(t.fields) && t.fields.length > 0
    const childSeriesIds = isMulti ? (index.childrenOf[t.id] || []) : [t.id]
    const selectedChildren = childSeriesIds.filter(id => selectedSet.has(id))
    selectedChildren.sort((a, b) => selectedIds.indexOf(a) - selectedIds.indexOf(b))
    const unselectedChildren = childSeriesIds.filter(id => !selectedSet.has(id))
    const orderedChildren = [...selectedChildren, ...unselectedChildren]
    const earliestIndex = selectedChildren.length > 0
      ? Math.min(...selectedChildren.map(id => selectedIds.indexOf(id)))
      : Infinity

    taskEntries.push({
      task: t,
      isMulti,
      childSeriesIds,
      selectedChildren,
      orderedChildren,
      earliestIndex
    })
  }

  // 有選中項目的任務排在前面(依最早選中索引排序)，未選中的照原本順序排在後面
  taskEntries.sort((a, b) => {
    if (a.earliestIndex !== b.earliestIndex) {
      return a.earliestIndex - b.earliestIndex
    }
    return 0
  })

  for (const entry of taskEntries) {
    const t = entry.task
    if (entry.isMulti) {
      // 父列：任務名稱與全選/全不選勾選框（不寫入 source）
      const parentRow = document.createElement('div')
      parentRow.className = 'drawer-task-group'
      parentRow.setAttribute('data-task-parent', t.id)

      const parentLabel = document.createElement('label')
      const parentInput = document.createElement('input')
      parentInput.type = 'checkbox'
      parentInput.setAttribute('data-action', 'toggle-all')
      parentInput.setAttribute('data-parent-id', t.id)
      parentInput.value = t.id

      const isTextMode = isNumeric && t.mode === 'text'
      parentInput.disabled = isTextMode

      if (entry.selectedChildren.length === entry.childSeriesIds.length && entry.childSeriesIds.length > 0) {
        parentInput.checked = true
        parentInput.indeterminate = false
      } else if (entry.selectedChildren.length === 0) {
        parentInput.checked = false
        parentInput.indeterminate = false
      } else {
        parentInput.checked = false
        parentInput.indeterminate = true
      }

      parentLabel.appendChild(parentInput)
      parentLabel.appendChild(document.createTextNode(isTextMode ? ` ${t.name || t.id}（文字模式不可選）` : ` ${t.name || t.id}`))
      parentRow.appendChild(parentLabel)
      container.appendChild(parentRow)

      // 子列：每個值一列
      for (const sid of entry.orderedChildren) {
        const seriesInfo = index.byId[sid]
        const isChecked = selectedSet.has(sid)
        const childRow = document.createElement('div')
        childRow.setAttribute('data-source-row', '')
        childRow.setAttribute('data-task-id', sid)
        childRow.className = 'drawer-series-row'
        childRow.style.paddingLeft = '1.2rem'

        const childLabel = document.createElement('label')
        const childInput = document.createElement('input')
        childInput.type = 'checkbox'
        childInput.setAttribute('data-source-checkbox', '')
        childInput.setAttribute('data-parent-id', t.id)
        childInput.value = sid
        childInput.checked = isChecked

        const isChildTextMode = isNumeric && seriesInfo?.mode === 'text'
        childInput.disabled = isChildTextMode

        const displayName = seriesInfo?.shortName || seriesInfo?.name || sid
        childLabel.appendChild(childInput)
        childLabel.appendChild(document.createTextNode(isChildTextMode ? ` ${displayName}（文字模式不可選）` : ` ${displayName}`))
        childRow.appendChild(childLabel)

        if (isChecked) {
          const selectedIdx = selectedIds.indexOf(sid)
          const up = document.createElement('button')
          up.type = 'button'
          up.setAttribute('data-action', 'source-up')
          up.textContent = '↑'
          up.title = '往前移一欄'
          up.disabled = selectedIdx === 0

          const down = document.createElement('button')
          down.type = 'button'
          down.setAttribute('data-action', 'source-down')
          down.textContent = '↓'
          down.title = '往後移一欄'
          down.disabled = selectedIdx === selectedIds.length - 1

          childRow.appendChild(up)
          childRow.appendChild(down)
        }

        container.appendChild(childRow)
      }
    } else {
      // 單值任務：任務自身一列
      const sid = t.id
      const seriesInfo = index.byId[sid]
      const isChecked = selectedSet.has(sid)
      const row = document.createElement('div')
      row.setAttribute('data-source-row', '')
      row.setAttribute('data-task-id', sid)

      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.setAttribute('data-source-checkbox', '')
      input.value = sid
      input.checked = isChecked

      const isTextMode = isNumeric && seriesInfo?.mode === 'text'
      input.disabled = isTextMode

      label.appendChild(input)
      label.appendChild(document.createTextNode(isTextMode ? ` ${t.name || t.id}（文字模式不可選）` : ` ${t.name || t.id}`))
      row.appendChild(label)

      if (isChecked) {
        const selectedIdx = selectedIds.indexOf(sid)
        const up = document.createElement('button')
        up.type = 'button'
        up.setAttribute('data-action', 'source-up')
        up.textContent = '↑'
        up.title = '往前移一欄'
        up.disabled = selectedIdx === 0

        const down = document.createElement('button')
        down.type = 'button'
        down.setAttribute('data-action', 'source-down')
        down.textContent = '↓'
        down.title = '往後移一欄'
        down.disabled = selectedIdx === selectedIds.length - 1

        row.appendChild(up)
        row.appendChild(down)
      }

      container.appendChild(row)
    }
  }
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
    const allSelectableBoxes = sourcesContainer ? [...sourcesContainer.querySelectorAll('input[data-source-checkbox]')] : []
    const allSelectableIds = new Set(allSelectableBoxes.map(b => b.value))

    // 清單上找不到的既有來源必須原樣保留
    const preserved = (currentCard?.source || []).filter(s => s && s.taskId && !allSelectableIds.has(s.taskId))

    const checkedBoxes = sourcesContainer ? sourcesContainer.querySelectorAll('input[data-source-checkbox]:checked') : []
    const aggSelect = document.getElementById('drawer-aggregation')
    const aggVal = (aggSelect && aggSelect.value) ? aggSelect.value : 'raw'

    // source 的順序就是樞紐表的欄序，而清單是依任務分組畫的——
    // 以原本的 source 為基準做增刪，不用清單的 DOM 順序重建，使用者調過的欄序才不會被洗掉
    const checkedIds = new Set([...checkedBoxes].map(b => b.value))
    const preservedIds = new Set(preserved.map(s => s.taskId))
    const original = currentCard?.source || []
    source = original.filter(s => s && s.taskId && (checkedIds.has(s.taskId) || preservedIds.has(s.taskId)))
    for (const tid of checkedIds) {
      if (!original.some(s => s && s.taskId === tid)) source.push({ taskId: tid, aggregation: aggVal })
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

    const showDeltaBox = document.getElementById('drawer-show-delta')
    if (showDeltaBox) {
      options.showDelta = showDeltaBox.checked
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

  ensureTableDeltaField()
  const showDeltaBox = document.getElementById('drawer-show-delta')
  if (showDeltaBox) {
    showDeltaBox.checked = Boolean(card.options?.showDelta)
  }

  renderSources(cachedTasks, card.source, card.type)
  renderStatusTasks(cachedTasks, card.options?.taskIds)
  updateFieldVisibility(card.type)
}

/**
 * 確保表格卡片抽屜中的差異欄勾選框存在
 */
function ensureTableDeltaField() {
  let box = document.getElementById('drawer-show-delta')
  if (!box) {
    const fieldTable = document.getElementById('drawer-field-table')
    if (fieldTable) {
      const row = document.createElement('div')
      row.className = 'drawer-row'
      const label = document.createElement('label')
      box = document.createElement('input')
      box.type = 'checkbox'
      box.id = 'drawer-show-delta'
      label.appendChild(box)
      label.appendChild(document.createTextNode(' 顯示與上一列的差'))
      row.appendChild(label)
      fieldTable.appendChild(row)
    }
  }
  return box
}

/**
 * 欄位變更只改草稿，並即時預覽在畫面上那張卡（不寫 storage）
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

  await previewDraft()
}

// 收掉抽屜並清掉草稿狀態（之後的重畫就回到 storage 版本）
function hideAndReset() {
  const drawer = document.getElementById('card-drawer')
  if (drawer) drawer.hidden = true
  const deleteConfirm = document.getElementById('drawer-delete-confirm')
  if (deleteConfirm) deleteConfirm.hidden = true
  const did = currentDashId
  const cid = currentCardId
  currentDashId = null
  currentCardId = null
  currentCard = null
  baseline = null
  return { did, cid }
}

/**
 * 套用：一次 updateCard 寫入草稿（只寫有變的欄位）、關抽屜
 */
async function applyDraft() {
  if (!currentDashId || !currentCardId) return
  const patch = changedFields()
  const { did, cid } = hideAndReset()
  if (Object.keys(patch).length > 0) {
    await updateCard(did, cid, patch)
  }
  await rerenderCard(did, cid)
}

/**
 * 取消：丟掉草稿、把畫面上的卡重畫回 storage 的樣子、關抽屜
 */
async function discardDraft() {
  if (!currentDashId || !currentCardId) {
    hideAndReset()
    return
  }
  const { did, cid } = hideAndReset()
  await rerenderCard(did, cid)
}

/**
 * 其他關閉方式（✕、Esc、點抽屜外、開另一張卡）：有變更先問，回傳抽屜是否已關
 */
async function requestClose() {
  if (!isOpen()) return true
  if (closing) return closing
  if (!isDirty()) {
    await discardDraft()
    return true
  }
  closing = (async () => {
    try {
      const answer = await confirmDialog({
        title: '要套用剛才的變更嗎？',
        body: '這張卡片的設定改過還沒套用。',
        confirmText: '套用',
        // 取消（含 Esc）＝繼續編輯，草稿保留；捨棄是 extra 那顆
        cancelText: '繼續編輯',
        extra: { text: '捨棄', value: 'discard' }
      })
      if (answer === true) {
        await applyDraft()
        return true
      }
      if (answer === 'discard') {
        await discardDraft()
        return true
      }
      return false
    } finally {
      closing = null
    }
  })()
  return closing
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
    closeBtn.addEventListener('click', () => requestClose())
  }

  const applyBtn = document.getElementById('drawer-apply')
  if (applyBtn) {
    applyBtn.addEventListener('click', () => applyDraft())
  }

  const cancelDraftBtn = document.getElementById('drawer-cancel')
  if (cancelDraftBtn) {
    cancelDraftBtn.addEventListener('click', () => discardDraft())
  }

  const doc = drawer.ownerDocument
  // Esc：確認框自己的 Esc 已經 preventDefault，不能再被這裡當成關抽屜
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (!isOpen() || isDialogOpen()) return
    requestClose()
  })
  // 點抽屜外：拖曳（按下與放開距離超過幾個像素）不算，否則把值拖進卡片就會關抽屜；
  // 卡片右上的齒輪由 openDrawer 自己處理換卡，確認框裡的點擊也不算
  let downAt = null
  doc.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX ?? 0, y: e.clientY ?? 0 }
  }, true)
  doc.addEventListener('click', (e) => {
    const start = downAt
    downAt = null
    if (!isOpen() || isDialogOpen()) return
    const t = e.target
    if (!t || typeof t.closest !== 'function') return
    if (drawer.contains(t)) return
    if (t.closest('dialog') || t.closest('[data-action="config"]')) return
    if (!t.isConnected) return
    if (start && (Math.abs((e.clientX ?? 0) - start.x) > 4 || Math.abs((e.clientY ?? 0) - start.y) > 4)) return
    requestClose()
  })

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
        // 卡片都刪了，草稿一併丟掉（不問）
        const { did, cid } = hideAndReset()
        await removeCard(did, cid)
        await renderDashboard(did)
      })
    }
  }

  drawer.addEventListener('change', (e) => {
    if (e.target?.matches?.('input[data-action="toggle-all"]')) {
      const parentId = e.target.getAttribute('data-parent-id')
      const checked = e.target.checked
      const childBoxes = drawer.querySelectorAll(`input[data-source-checkbox][data-parent-id="${parentId}"]:not(:disabled)`)
      for (const cb of childBoxes) {
        cb.checked = checked
      }
    } else if (e.target?.matches?.('input[data-source-checkbox]')) {
      const parentId = e.target.getAttribute('data-parent-id')
      if (parentId) {
        updateToggleAllState(parentId)
      }
    }
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
 * 把某個來源在欄序中前後移動一位（只改草稿並預覽）
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
  renderSources(cachedTasks, source, currentCard.type)
  await previewDraft()
}

/**
 * 開啟卡片設定抽屜
 */
export async function openDrawer(dashId, cardId) {
  // 正在編輯另一張卡：先照關閉規則處理那份草稿；選「繼續編輯」就不換卡
  if (isOpen() && cardId !== currentCardId) {
    const closed = await requestClose()
    if (!closed) return
  } else if (isOpen() && cardId === currentCardId) {
    return
  }
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
  currentCard = structuredClone(card)
  baseline = pickDraft(card)

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
 * 關閉卡片設定抽屜（有未套用的變更時先問）；回傳抽屜是否已關
 */
export function closeDrawer() {
  return requestClose()
}
