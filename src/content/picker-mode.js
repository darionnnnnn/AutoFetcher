// 豁免說明：此檔案在網頁 isolated world 執行，網頁未載入 ui/theme.css，因此為全專案唯一允許寫色碼字面值之檔案。色碼源自 ui/theme.css 亮色：主色 #2563eb、白 #ffffff、警示 #d97706。
import { MSG } from '../shared/messages.js'
import { describe } from '../shared/selector.js'
import { detectKind } from '../shared/block-detect.js'
import { parseNumber } from '../shared/extract.js'
import { columnHeaders, rowHeader } from '../shared/table.js'

let active = false, currentPurpose = null, currentTaskId = undefined, currentTargetEl = null, backStack = []
let overlayEl = null, highlightEl = null, panelEl = null
let tableAxis = null, cellIndex = null, colIndex = null, rowIndex = null, currentDataRows = [], currentRowEl = null

// detectKind 會掃整棵子樹，而滑鼠每移動一格都要問一次，因此記住最後一次的結果
let kindCacheEl = null, kindCache = null

// 取得元素的型別描述（同一個元素連續詢問時走快取）
function kindOf(el) {
  if (el !== kindCacheEl) {
    kindCacheEl = el
    kindCache = detectKind(el)
  }
  return kindCache
}

// 判定是否處於表格模式
function isTableMode(el) {
  if (!el) return false
  const kind = kindOf(el).kind
  return kind === 'table' || kind === 'grid'
}

// 判定格子是否為表頭格
function isHeaderCell(c) {
  return c?.tagName === 'TH' || c?.getAttribute?.('role') === 'columnheader'
}

// 取得列中的格子
function getRowCells(row) {
  if (!row) return []
  const cells = row.querySelectorAll ? Array.from(row.querySelectorAll('td, th, [role="cell"], [role="gridcell"], [role="columnheader"]')) : []
  return cells.length > 0 ? cells : Array.from(row.children || [])
}

// 判定是否為表頭列
function isHeaderRow(r) {
  if (r.closest && r.closest('thead')) return true
  const cells = getRowCells(r)
  return cells.length > 0 && cells.every(isHeaderCell)
}

// 取得表格的所有列
function getTableRows(tableEl) {
  if (!tableEl) return []
  const rows = tableEl.querySelectorAll ? Array.from(tableEl.querySelectorAll('tr, [role="row"]')).filter(r => r.closest('table, [role="grid"], [role="table"]') === tableEl) : []
  return rows.length > 0 ? rows : Array.from(tableEl.children || []).filter(c => c?.getAttribute?.('role') === 'row')
}

// 清除所有標記為待選之表格格子
function clearMarkedCells(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || typeof d.querySelectorAll !== 'function') return
  for (const cell of d.querySelectorAll('[data-af-cell]')) {
    cell.removeAttribute('data-af-cell')
    cell.style.outline = ''
  }
}

// 標示待選欄或列之資料格
function markCells(dataRows, row, axis, cIdx) {
  clearMarkedCells(document)
  if (axis === 'col' && cIdx !== null && cIdx >= 0 && dataRows) {
    for (const dRow of dataRows) {
      const targetCell = getRowCells(dRow)[cIdx]
      if (targetCell && !isHeaderCell(targetCell)) {
        targetCell.setAttribute('data-af-cell', '')
        targetCell.style.outline = '2px solid #d97706'
      }
    }
  } else if (axis === 'row' && row) {
    for (const c of getRowCells(row)) {
      if (!isHeaderCell(c)) {
        c.setAttribute('data-af-cell', '')
        c.style.outline = '2px solid #d97706'
      }
    }
  }
}

// 更新高亮框位置與尺寸
function updateHighlight(hl, el) {
  if (!hl || !el || typeof el.getBoundingClientRect !== 'function') return
  const rect = el.getBoundingClientRect()
  const sx = (typeof window !== 'undefined' && (window.scrollX || window.pageXOffset)) || 0
  const sy = (typeof window !== 'undefined' && (window.scrollY || window.pageYOffset)) || 0
  hl.style.left = `${rect.left + sx}px`; hl.style.top = `${rect.top + sy}px`
  hl.style.width = `${rect.width}px`; hl.style.height = `${rect.height}px`
}

// 產生說明面板文字
function updatePanel(panel, el) {
  if (!panel) return
  if (!el) {
    panel.textContent = '↑ 放大選取 ↓ 縮小 Enter 確認 Esc 取消'
    return
  }
  const tagDesc = (el.tagName ? el.tagName.toLowerCase() : '') + (el.id ? `#${el.id}` : '')
  const preview = (el.textContent || '').trim().slice(0, 80)
  const info = kindOf(el)
  const typeDesc = info.kind === 'number' ? `數值 ${info.value}`
    : info.kind === 'table' ? `表格 ${info.rows} 列 × ${info.cols} 欄\n點一格選整欄,Tab 切換欄/列`
    : info.kind === 'grid' ? `表格(版面) ${info.rows} 列 × ${info.cols} 欄\n點一格選整欄,Tab 切換欄/列`
    : info.kind === 'list' ? `清單 ${info.rows} 項`
    : '文字'
  panel.textContent = [tagDesc, ...(preview ? [preview] : []), typeDesc, '↑ 放大選取 ↓ 縮小 Enter 確認 Esc 取消'].join('\n')
}

// 設定當前目標元素
function setTarget(el) {
  clearMarkedCells(document)
  currentTargetEl = el; currentDataRows = []; currentRowEl = null; colIndex = null; rowIndex = null; cellIndex = null
  if (!el) {
    tableAxis = null
    if (highlightEl) highlightEl.style.display = 'none'
    if (panelEl) updatePanel(panelEl, null)
    return
  }
  tableAxis = isTableMode(el) ? 'col' : null
  if (highlightEl) {
    highlightEl.style.display = 'block'
    updateHighlight(highlightEl, el)
  }
  if (panelEl) updatePanel(panelEl, el)
}

// 取得待選欄或列之表頭文字
function getHeaderText() {
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return ''
  if (tableAxis === 'row') return currentRowEl ? rowHeader(currentRowEl) : ''
  if (colIndex === null) return ''
  return columnHeaders(currentTargetEl)[colIndex] || ''
}

// 處理表格內滑鼠移動
function handleTableMouseMove(target) {
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return
  const isTable = kindOf(currentTargetEl).kind === 'table'
  let row = null, cell = null, dataRows = []
  if (isTable) {
    cell = target.closest?.('td, th, [role="cell"], [role="gridcell"], [role="columnheader"]')
    if (!cell || !currentTargetEl.contains(cell)) return
    row = cell.closest?.('tr, [role="row"]')
    if (!row || !currentTargetEl.contains(row)) return
    dataRows = getTableRows(currentTargetEl).filter(r => !isHeaderRow(r))
  } else {
    dataRows = Array.from(currentTargetEl.children || [])
    row = dataRows.find(r => r === target || r.contains(target))
    if (!row) return
    cell = Array.from(row.children || []).find(c => c === target || c.contains(target))
    if (!cell) return
  }
  const cellsInRow = getRowCells(row)
  colIndex = Math.max(-1, cellsInRow.indexOf(cell))
  colIndex = colIndex >= 0 ? colIndex : null
  rowIndex = dataRows.includes(row) ? dataRows.indexOf(row) : null
  cellIndex = tableAxis === 'row' ? rowIndex : colIndex
  currentDataRows = dataRows; currentRowEl = row
  markCells(dataRows, row, tableAxis, colIndex)
}

// 取得表格 caption 文字
function getCaptionText(el) {
  if (!el || typeof el.querySelector !== 'function') return ''
  const caption = el.querySelector('caption')
  return caption && caption.textContent ? caption.textContent.trim() : ''
}

// 判定元素是否為標題或內含標題，回傳其中最後一個標題之文字
function getHeadingFromElement(el) {
  if (!el) return ''
  const tag = (el.tagName || '').toLowerCase()
  if (/^h[1-6]$/.test(tag)) {
    const text = (el.textContent || '').trim()
    if (text) return text
  }
  if (typeof el.querySelectorAll === 'function') {
    const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6')
    for (let i = headings.length - 1; i >= 0; i--) {
      const text = (headings[i].textContent || '').trim()
      if (text) return text
    }
  }
  return ''
}

// 從目標元素往前同層、再往父層尋找最近的標題文字
function getPrecedingHeadingText(el) {
  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null)
  const body = doc ? doc.body : null
  let curr = el
  while (curr && curr !== body && curr.parentElement) {
    let sibling = curr.previousElementSibling
    while (sibling) {
      const headingText = getHeadingFromElement(sibling)
      if (headingText) return headingText
      sibling = sibling.previousElementSibling
    }
    curr = curr.parentElement
  }
  return ''
}

// 算出表格名稱提示
function computeNameHint(el) {
  if (!el || !isTableMode(el)) return undefined
  const caption = getCaptionText(el)
  if (caption) return caption.slice(0, 60)
  const heading = getPrecedingHeadingText(el)
  if (heading) return heading.slice(0, 60)
  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null)
  const title = (doc && doc.title ? doc.title.trim() : '')
  if (title) return title.slice(0, 60)
  return undefined
}

// 送出確認訊息並離開
function confirmPick() {
  if (!currentTargetEl) return
  const preview = (currentTargetEl.textContent || '').trim()
  const previewValue = parseNumber(preview)
  const blockInfo = { ...kindOf(currentTargetEl) }
  if (isTableMode(currentTargetEl)) {
    blockInfo.axis = tableAxis || 'col'
    blockInfo.index = currentCellIndex()
    blockInfo.headerText = getHeaderText()
  } else {
    delete blockInfo.axis
    delete blockInfo.index
  }
  const msg = { type: MSG.PICKED, purpose: currentPurpose, locator: describe(currentTargetEl), preview, previewValue, blockInfo }
  if (isTableMode(currentTargetEl)) {
    const nameHint = computeNameHint(currentTargetEl)
    if (nameHint) msg.nameHint = nameHint
  }
  if (currentTaskId !== undefined) msg.taskId = currentTaskId
  chrome.runtime.sendMessage(msg)
  exitPickMode()
}

// 送出取消訊息並離開
function cancelPick() {
  const msg = { type: MSG.PICKED, purpose: currentPurpose, cancelled: true }
  if (currentTaskId !== undefined) msg.taskId = currentTaskId
  chrome.runtime.sendMessage(msg)
  exitPickMode()
}

// 事件監聽處理常式
function onMouseMove(event) {
  if (!active) return
  const target = event.target
  if (!target || (overlayEl && (target === overlayEl || overlayEl.contains(target)))) return
  if (currentTargetEl && isTableMode(currentTargetEl) && (currentTargetEl === target || currentTargetEl.contains(target))) {
    handleTableMouseMove(target)
    return
  }
  if (target !== currentTargetEl) {
    backStack = []
    setTarget(target)
  }
}

function onKeyDown(event) {
  if (!active) return
  if (event.key === 'Escape') {
    event.preventDefault(); cancelPick()
  } else if (event.key === 'Enter') {
    if (!currentTargetEl) return
    event.preventDefault(); confirmPick()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!currentTargetEl || currentTargetEl === document.body) return
    if (currentTargetEl.parentElement) {
      backStack.push(currentTargetEl); setTarget(currentTargetEl.parentElement)
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (backStack.length > 0) setTarget(backStack.pop())
  } else if (event.key === 'Tab') {
    if (currentTargetEl && isTableMode(currentTargetEl)) {
      event.preventDefault()
      tableAxis = tableAxis === 'col' ? 'row' : 'col'
      cellIndex = tableAxis === 'row' ? rowIndex : colIndex
      markCells(currentDataRows, currentRowEl, tableAxis, colIndex)
    }
  }
}

function onClick(event) {
  if (!active) return
  event.preventDefault(); event.stopPropagation()
  if (!currentTargetEl && event.target && (!overlayEl || (!overlayEl.contains(event.target) && event.target !== overlayEl))) {
    setTarget(event.target)
  }
  if (!currentTargetEl) return
  if (isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)) handleTableMouseMove(event.target)
  confirmPick()
}

export function enterPickMode(opts) {
  exitPickMode()
  active = true
  currentPurpose = opts?.purpose || null
  currentTaskId = opts?.taskId !== undefined ? opts.taskId : undefined
  backStack = []
  if (typeof document === 'undefined' || !document.body) return

  overlayEl = document.createElement('div')
  overlayEl.setAttribute('data-af-overlay', '')
  overlayEl.style.position = 'absolute'; overlayEl.style.top = '0'; overlayEl.style.left = '0'
  overlayEl.style.width = '0'; overlayEl.style.height = '0'; overlayEl.style.pointerEvents = 'none'; overlayEl.style.zIndex = '2147483647'

  highlightEl = document.createElement('div')
  highlightEl.setAttribute('data-af-highlight', '')
  highlightEl.style.position = 'absolute'; highlightEl.style.border = '2px solid #2563eb'
  highlightEl.style.boxSizing = 'border-box'; highlightEl.style.pointerEvents = 'none'; highlightEl.style.zIndex = '2147483647'
  overlayEl.appendChild(highlightEl)

  panelEl = document.createElement('div')
  panelEl.setAttribute('data-af-panel', '')
  panelEl.style.position = 'fixed'; panelEl.style.right = '16px'; panelEl.style.bottom = '16px'
  panelEl.style.backgroundColor = '#2563eb'; panelEl.style.color = '#ffffff'; panelEl.style.pointerEvents = 'none'; panelEl.style.zIndex = '2147483647'
  panelEl.style.padding = '8px 12px'; panelEl.style.borderRadius = '4px'; panelEl.style.fontSize = '12px'; panelEl.style.lineHeight = '1.4'; panelEl.style.whiteSpace = 'pre-line'
  overlayEl.appendChild(panelEl)

  document.body.appendChild(overlayEl)
  setTarget(opts?.initialTarget || null)

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('click', onClick, true)
}

export function exitPickMode() {
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', onClick, true)
    clearMarkedCells(document)
    for (const el of (document.querySelectorAll ? document.querySelectorAll('[data-af-overlay]') : [])) {
      el.remove()
    }
  }
  active = false; currentPurpose = null; currentTaskId = undefined; currentTargetEl = null; backStack = []
  overlayEl = null; highlightEl = null; panelEl = null; tableAxis = null; cellIndex = null; colIndex = null; rowIndex = null
  currentDataRows = []; currentRowEl = null
}

export function isActive() { return active }
export function currentTarget() { return currentTargetEl }
export function currentAxis() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : (tableAxis || 'col') }
export function currentCellIndex() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : cellIndex }
