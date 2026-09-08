// 豁免說明：此檔案在網頁 isolated world 執行，網頁未載入 ui/theme.css，
// 因此為全專案唯一允許寫色碼字面值之檔案。所有色碼集中在下方 COLORS 常數，
// 其餘程式碼一律引用 COLORS 的屬性。
import { MSG } from '../shared/messages.js'
import { describe } from '../shared/selector.js'
import { detectKind } from '../shared/block-detect.js'
import { parseNumber } from '../shared/extract.js'
import { columnHeaders, rowHeader } from '../shared/table.js'

// 顏色常數（對應 theme.css 暗色軌）——這是本檔唯一允許出現色碼字面值的地方
const COLORS = {
  bg: '#0f172a',
  surface: '#1e293b',
  border: '#334155',
  text: '#f8fafc',
  textMuted: '#94a3b8',
  primary: '#3b82f6',
  warn: '#fbbf24',
  ok: '#22c55e',
  danger: '#ef4444'
}

let active = false, currentPurpose = null, currentTaskId = undefined, currentTargetEl = null, backStack = []
// 進不去框架時要說出來；代理層是 iframe 的替身（見 frameOfProxy）
let currentHint = null
let pendingPreselect = null
let overlayEl = null, highlightEl = null, panelEl = null, toolbarEl = null, menuEl = null
let pickMode = 'cell', cellIndex = null, colIndex = null, rowIndex = null, currentDataRows = [], currentRowEl = null, currentCellEl = null
let selectedList = [], maxPicks = 20, limitReached = false, headerChangedNotice = false
// 已選的值屬於哪一張表格：滑鼠漂出表格不清空，換到另一張表格才清
let pickedTableEl = null
let originalUserSelect = '', dragStart = null, isDragging = false, suppressClick = false, menuTargetContext = null

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

const CELL_SELECTOR = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"]'

// 取得元素所屬的最近表格
function tableOf(el) {
  return el && typeof el.closest === 'function' ? el.closest('table, [role="grid"], [role="table"]') : null
}

// 判定儲存格是否屬於指定表格
function cellBelongsToTable(cell, tableEl) {
  return tableOf(cell) === tableEl
}

// 取得列中的格子（只取這一列自己的儲存格，排除巢狀小表格的儲存格）
function getRowCells(row) {
  if (!row) return []
  const rowTable = tableOf(row)
  const raw = row.querySelectorAll ? Array.from(row.querySelectorAll(CELL_SELECTOR)) : []
  const cells = rowTable ? raw.filter(c => cellBelongsToTable(c, rowTable)) : raw
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
  const rows = tableEl.querySelectorAll ? Array.from(tableEl.querySelectorAll('tr, [role="row"]')).filter(r => tableOf(r) === tableEl) : []
  return rows.length > 0 ? rows : Array.from(tableEl.children || []).filter(c => c?.getAttribute?.('role') === 'row')
}

// 取得表格的所有資料列（排除表頭列）
function resolveDataRows(tableEl) {
  if (!tableEl) return []
  if (kindOf(tableEl).kind === 'table') {
    return getTableRows(tableEl).filter(r => !isHeaderRow(r))
  }
  return Array.from(tableEl.children || [])
}

// 解析目標所在的資料列與資料欄索引
function resolveCell(target, tableEl) {
  if (!tableEl || !isTableMode(tableEl) || !target) return null
  const isTable = kindOf(tableEl).kind === 'table'
  let row = null, cell = null, dataRows = []
  if (isTable) {
    let curr = target
    while (curr && curr !== tableEl) {
      if (curr.matches && curr.matches(CELL_SELECTOR) && cellBelongsToTable(curr, tableEl)) {
        cell = curr
        break
      }
      curr = curr.parentElement
    }
    if (!cell) return null
    row = cell.closest ? cell.closest('tr, [role="row"]') : null
    if (!row || !tableEl.contains(row)) return null
    dataRows = getTableRows(tableEl).filter(r => !isHeaderRow(r))
  } else {
    dataRows = Array.from(tableEl.children || [])
    row = dataRows.find(r => r === target || r.contains(target))
    if (!row) return null
    cell = Array.from(row.children || []).find(c => c === target || c.contains(target))
    if (!cell) return null
  }
  const cellsInRow = getRowCells(row)
  let cIdx = cellsInRow.indexOf(cell)
  if (cIdx < 0) cIdx = null
  let rIdx = dataRows.indexOf(row)
  if (rIdx < 0) rIdx = null
  if (rIdx === null || cIdx === null) return null
  return { row, cell, rIdx, cIdx, dataRows }
}

// 清除所有標記為待選之表格格子
function clearMarkedCells(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || typeof d.querySelectorAll !== 'function') return
  for (const cell of d.querySelectorAll('[data-af-cell]')) {
    cell.removeAttribute('data-af-cell')
    if (cell.hasAttribute('data-af-picked')) {
      cell.style.outline = `2px solid ${COLORS.primary}`
    } else {
      cell.style.outline = ''
    }
  }
}

// 標示待選格、欄或列之資料格
function markCells(cell, dataRows, row, mode, cIdx) {
  clearMarkedCells(document)
  if (mode === 'cell') {
    if (cell && !isHeaderCell(cell)) {
      cell.setAttribute('data-af-cell', '')
      cell.style.outline = `2px solid ${COLORS.warn}`
    }
  } else if (mode === 'col' && cIdx !== null && cIdx >= 0 && dataRows) {
    for (const dRow of dataRows) {
      const targetCell = getRowCells(dRow)[cIdx]
      if (targetCell && !isHeaderCell(targetCell)) {
        targetCell.setAttribute('data-af-cell', '')
        targetCell.style.outline = `2px solid ${COLORS.warn}`
      }
    }
  } else if (mode === 'row' && row) {
    for (const c of getRowCells(row)) {
      if (!isHeaderCell(c)) {
        c.setAttribute('data-af-cell', '')
        c.style.outline = `2px solid ${COLORS.warn}`
      }
    }
  }
}

// 清除所有已選標記
function clearPickedMarks(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || typeof d.querySelectorAll !== 'function') return
  for (const cell of d.querySelectorAll('[data-af-picked]')) {
    cell.removeAttribute('data-af-picked')
    if (cell.hasAttribute('data-af-cell')) {
      cell.style.outline = `2px solid ${COLORS.warn}`
    } else {
      cell.style.outline = ''
    }
  }
}

// 重新在表格上貼回已選標記
function applyPickedMarks(tableEl) {
  clearPickedMarks(document)
  if (!tableEl || !isTableMode(tableEl)) return
  const dataRows = resolveDataRows(tableEl)
  for (const pick of selectedList) {
    if (pick.cell) {
      const row = dataRows[pick.cell.row.index]
      if (row) {
        const cells = getRowCells(row)
        const cell = cells[pick.cell.col.index]
        if (cell && !isHeaderCell(cell)) {
          cell.setAttribute('data-af-picked', '')
          if (!cell.hasAttribute('data-af-cell')) {
            cell.style.outline = `2px solid ${COLORS.primary}`
          }
        }
      }
    } else if (pick.block) {
      if (pick.block.axis === 'col') {
        for (const row of dataRows) {
          const cells = getRowCells(row)
          const cell = cells[pick.block.index]
          if (cell && !isHeaderCell(cell)) {
            cell.setAttribute('data-af-picked', '')
            if (!cell.hasAttribute('data-af-cell')) {
              cell.style.outline = `2px solid ${COLORS.primary}`
            }
          }
        }
      } else if (pick.block.axis === 'row') {
        const row = dataRows[pick.block.index]
        if (row) {
          for (const cell of getRowCells(row)) {
            if (!isHeaderCell(cell)) {
              cell.setAttribute('data-af-picked', '')
              if (!cell.hasAttribute('data-af-cell')) {
                cell.style.outline = `2px solid ${COLORS.primary}`
              }
            }
          }
        }
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

// 取得已選項目的顯示名稱
function getPickName(pick) {
  if (pick.cell) {
    const r = pick.cell.row ? pick.cell.row.header : ''
    const c = pick.cell.col ? pick.cell.col.header : ''
    if (r && c) return `${r} · ${c}`
    return r || c || '儲存格'
  }
  if (pick.block) {
    return pick.block.headerText || (pick.block.axis === 'col' ? '整欄' : '整列')
  }
  return '目標'
}

// iframe 的 src 一律轉成絕對網址:background 拿它跟 frame 的 location.href 比對，
// 送相對路徑過去 new URL() 會拋，結果是永遠「無法進入此框架」
function frameSrcOf(frameEl) {
  const raw = frameEl?.getAttribute?.('src') || ''
  try {
    return new URL(raw, document?.baseURI).href
  } catch {
    return raw
  }
}

// iframe 的代理層:滑鼠移到 <iframe> 上時事件由 iframe 自己的文件接走，
// 最上層永遠 hover 不到那個元素，所以在它上面貼一層可以指到的替身。
function frameOfProxy(el) {
  return el && el.getAttribute && el.getAttribute('data-af-frame-proxy') !== null ? el.__afFrame || null : null
}

// 目標是 iframe（或它的代理層）時，回傳那個 iframe，否則 null
function iframeOf(el) {
  if (!el) return null
  const viaProxy = frameOfProxy(el)
  if (viaProxy) return viaProxy
  return el.tagName === 'IFRAME' ? el : null
}

function buildFrameProxies() {
  if (typeof document === 'undefined' || !document.body || !overlayEl) return
  for (const frame of document.querySelectorAll('iframe')) {
    const rect = typeof frame.getBoundingClientRect === 'function' ? frame.getBoundingClientRect() : null
    const proxy = document.createElement('div')
    proxy.setAttribute('data-af-frame-proxy', '')
    proxy.__afFrame = frame
    const sx = (typeof window !== 'undefined' && (window.scrollX || window.pageXOffset)) || 0
    const sy = (typeof window !== 'undefined' && (window.scrollY || window.pageYOffset)) || 0
    proxy.style.position = 'absolute'
    proxy.style.left = `${(rect?.left || 0) + sx}px`
    proxy.style.top = `${(rect?.top || 0) + sy}px`
    proxy.style.width = `${rect?.width || 0}px`
    proxy.style.height = `${rect?.height || 0}px`
    // 這一層必須收得到滑鼠事件,否則就跟沒貼一樣
    proxy.style.pointerEvents = 'auto'
    proxy.style.zIndex = '2147483646'
    overlayEl.appendChild(proxy)
  }
}

// 更新工具列狀態（作用中模式與停用狀態）
function updateToolbar() {
  if (!toolbarEl) return
  const isTable = Boolean(currentTargetEl && isTableMode(currentTargetEl))
  const isTask = currentPurpose === 'task'

  for (const btn of toolbarEl.querySelectorAll('[data-af-tool]')) {
    const key = btn.getAttribute('data-af-tool')
    let disabled = false
    if (!isTable) {
      disabled = true
    } else if (!isTask) {
      if (key === 'col' || key === 'row') disabled = true
    }

    if (disabled) {
      btn.setAttribute('aria-disabled', 'true')
      btn.style.opacity = '0.5'
      btn.style.cursor = 'not-allowed'
    } else {
      btn.removeAttribute('aria-disabled')
      btn.style.opacity = '1'
      btn.style.cursor = 'pointer'
    }

    if (key === pickMode) {
      btn.setAttribute('data-af-active', '')
      btn.style.backgroundColor = COLORS.primary
      btn.style.color = COLORS.text
    } else {
      btn.removeAttribute('data-af-active')
      btn.style.backgroundColor = COLORS.surface
      btn.style.color = COLORS.primary
    }
  }
}

// 移除指定序號之已選項
function removePickAt(index) {
  if (index < 0 || index >= selectedList.length) return
  selectedList.splice(index, 1)
  limitReached = false
  if (selectedList.length === 0) {
    pickedTableEl = null
  }
  applyPickedMarks(currentTargetEl)
  updatePanel(panelEl, currentTargetEl)
}

// 移除最後一項已選項
function removeLastPick() {
  if (selectedList.length === 0) return
  selectedList.pop()
  limitReached = false
  if (selectedList.length === 0) {
    pickedTableEl = null
  }
  applyPickedMarks(currentTargetEl)
  updatePanel(panelEl, currentTargetEl)
}

// 產生說明面板文字與已選清單
function updatePanel(panel, el) {
  if (!panel) return

  while (panel.firstChild) {
    panel.removeChild(panel.firstChild)
  }

  if (selectedList.length > 0) {
    const headerDiv = document.createElement('div')
    headerDiv.textContent = `已選 ${selectedList.length} 個值:`
    headerDiv.style.marginBottom = '4px'
    headerDiv.style.fontWeight = 'bold'
    panel.appendChild(headerDiv)

    const listDiv = document.createElement('div')
    listDiv.style.display = 'flex'
    listDiv.style.flexWrap = 'wrap'
    listDiv.style.gap = '4px'
    listDiv.style.marginBottom = '6px'

    for (let i = 0; i < selectedList.length; i++) {
      const pick = selectedList[i]
      const chip = document.createElement('div')
      chip.setAttribute('data-af-chip', String(i))
      chip.style.display = 'inline-flex'
      chip.style.alignItems = 'center'
      chip.style.backgroundColor = COLORS.surface
      chip.style.color = COLORS.text
      chip.style.border = `1px solid ${COLORS.border}`
      chip.style.borderRadius = '3px'
      chip.style.padding = '2px 6px'
      chip.style.fontSize = '12px'
      chip.style.minHeight = '28px'
      chip.style.transition = 'background-color 150ms ease'

      const nameSpan = document.createElement('span')
      nameSpan.textContent = getPickName(pick)
      chip.appendChild(nameSpan)

      const removeBtn = document.createElement('span')
      removeBtn.setAttribute('data-af-chip-remove', '')
      removeBtn.textContent = '\u00d7'
      removeBtn.style.marginLeft = '6px'
      removeBtn.style.cursor = 'pointer'
      removeBtn.style.fontWeight = 'bold'
      chip.appendChild(removeBtn)

      listDiv.appendChild(chip)
    }
    panel.appendChild(listDiv)

    const removeLastBtn = document.createElement('button')
    removeLastBtn.type = 'button'
    removeLastBtn.setAttribute('data-af-remove-last', '')
    removeLastBtn.textContent = '移除最後一項'
    removeLastBtn.style.padding = '2px 8px'
    removeLastBtn.style.fontSize = '12px'
    removeLastBtn.style.backgroundColor = COLORS.surface
    removeLastBtn.style.color = COLORS.primary
    removeLastBtn.style.border = `1px solid ${COLORS.border}`
    removeLastBtn.style.borderRadius = '3px'
    removeLastBtn.style.cursor = 'pointer'
    removeLastBtn.style.minHeight = '28px'
    removeLastBtn.style.marginBottom = '4px'
    removeLastBtn.style.transition = 'background-color 150ms ease'
    panel.appendChild(removeLastBtn)

    const noticeLines = []
    if (limitReached || selectedList.length >= maxPicks) {
      noticeLines.push('（已達選取上限）')
    }
    if (headerChangedNotice) {
      noticeLines.push('（位置已變）')
    }
    noticeLines.push('Shift 點選加選 / 拖曳框選 / 右鍵選單 / Enter 完成 / Esc 取消')
    const footerDiv = document.createElement('div')
    footerDiv.textContent = noticeLines.join('\n')
    footerDiv.style.whiteSpace = 'pre-line'
    panel.appendChild(footerDiv)
    return
  }

  const frameEl = iframeOf(el)
  if (frameEl) {
    const lines = ['框架 iframe']
    let host = ''
    try {
      host = new URL(frameSrcOf(frameEl)).hostname
    } catch {}
    if (host) lines.push(host)
    lines.push('確認即進入這個框架選取')
    if (currentHint === 'frame_not_found') lines.push('無法進入這個框架')
    lines.push('Enter 進入 / Esc 取消')
    panel.textContent = lines.join('\n')
    return
  }

  if (!el) {
    const lines = []
    if (currentHint === 'frame_not_found') lines.push('無法進入這個框架')
    if (limitReached || selectedList.length >= maxPicks) lines.push('（已達選取上限）')
    if (headerChangedNotice) lines.push('（位置已變）')
    lines.push('↑ 放大 ↓ 縮小 / Shift 點選加選 / 拖曳框選 / 右鍵選單 / Enter 確認 Esc 取消')
    panel.textContent = lines.join('\n')
    return
  }
  const tagDesc = (el.tagName ? el.tagName.toLowerCase() : '') + (el.id ? `#${el.id}` : '')
  const preview = (el.textContent || '').trim().slice(0, 80)
  const info = kindOf(el)
  const typeDesc = info.kind === 'number' ? `數值 ${info.value}`
    : info.kind === 'table' ? `表格 ${info.rows} 列 × ${info.cols} 欄\n點一格選那一格,Shift 加選,右鍵有更多`
    : info.kind === 'grid' ? `表格(版面) ${info.rows} 列 × ${info.cols} 欄\n點一格選那一格,Shift 加選,右鍵有更多`
    : info.kind === 'list' ? `清單 ${info.rows} 項`
    : '文字'
  const lines = [tagDesc]
  if (preview) lines.push(preview)
  lines.push(typeDesc)
  // 非表格沒有欄／列可挑，工具列會整排停用；要說出為什麼，不然使用者只看到點不動
  if (!isTableMode(el)) lines.push('非表格：抓整個元素')
  if (currentHint === 'frame_not_found') lines.push('無法進入這個框架')
  if (limitReached || selectedList.length >= maxPicks) lines.push('（已達選取上限）')
  if (headerChangedNotice) lines.push('（位置已變）')
  lines.push('↑ 放大 ↓ 縮小 / Shift 點選加選 / 拖曳框選 / 右鍵選單 / Enter 確認 Esc 取消')
  panel.textContent = lines.join('\n')
}

// 設定當前目標元素
function setTarget(el) {
  // 換到另一張表格（或離開表格）時，先前選的列欄索引就沒有意義了；
  // 不清掉會把 A 表的索引配上 B 表的定位一起送出去
  // 滑鼠落在「另一張表格」裡（不論停在表格本身或它的某一格）才算換表
  const hostTable = tableOf(el)
  if (selectedList.length > 0 && pickedTableEl && hostTable && hostTable !== pickedTableEl &&
      !pickedTableEl.contains(hostTable) && !hostTable.contains(pickedTableEl)) {
    clearPickedMarks(document)
    selectedList = []
    limitReached = false
    pickedTableEl = null
  }
  clearMarkedCells(document)
  currentTargetEl = el; currentDataRows = []; currentRowEl = null; colIndex = null; rowIndex = null; cellIndex = null; currentCellEl = null
  if (!el) {
    if (highlightEl) highlightEl.style.display = 'none'
    updateToolbar()
    if (panelEl) updatePanel(panelEl, null)
    return
  }
  if (highlightEl) {
    highlightEl.style.display = 'block'
    updateHighlight(highlightEl, el)
  }
  updateToolbar()
  if (panelEl) updatePanel(panelEl, el)
}

// 取得待選欄或列之表頭文字
function getHeaderText() {
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return ''
  if (pickMode === 'row') return currentRowEl ? rowHeader(currentRowEl) : ''
  if (colIndex === null) return ''
  return columnHeaders(currentTargetEl)[colIndex] || ''
}

// 處理表格內滑鼠移動
function handleTableMouseMove(target) {
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return
  const info = resolveCell(target, currentTargetEl)
  // 滑鼠停在格子以外（表格的縫隙、表頭列）時要放掉記住的那一格，
  // 否則之後切換模式會把標示畫回一個滑鼠早就離開的位置
  if (!info) {
    currentCellEl = null
    clearMarkedCells(document)
    applyPickedMarks(currentTargetEl)
    return
  }
  currentCellEl = info.cell
  colIndex = info.cIdx
  rowIndex = info.rIdx
  cellIndex = pickMode === 'row' ? rowIndex : colIndex
  currentDataRows = info.dataRows
  currentRowEl = info.row
  markCells(currentCellEl, info.dataRows, info.row, pickMode, colIndex)
  applyPickedMarks(currentTargetEl)
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

// 取得單一儲存格的文字內容
function getCellText(cellSpec, tableEl) {
  if (!tableEl || !cellSpec || !cellSpec.row || !cellSpec.col) return ''
  const dataRows = resolveDataRows(tableEl)
  const rowEl = dataRows[cellSpec.row.index]
  if (!rowEl) return ''
  const cells = getRowCells(rowEl)
  const cellEl = cells[cellSpec.col.index]
  return (cellEl && cellEl.textContent ? cellEl.textContent : '').trim()
}

// 取得整欄或整列聚合的描述文字
function getBlockPreview(blockSpec, tableEl) {
  if (!tableEl || !blockSpec) return ''
  const isRow = blockSpec.axis === 'row'
  const axisName = isRow ? '列' : '欄'
  const dataRows = resolveDataRows(tableEl)
  let n = 0
  const idx = (blockSpec.index !== null && blockSpec.index !== undefined) ? blockSpec.index : 0
  if (isRow) {
    const rowEl = dataRows[idx]
    n = rowEl ? getRowCells(rowEl).length : 0
  } else {
    for (const r of dataRows) {
      const cells = getRowCells(r)
      if (idx >= 0 && idx < cells.length) n++
    }
  }
  const header = typeof blockSpec.headerText === 'string' ? blockSpec.headerText.trim() : ''
  const label = header ? `「${header}」` : `第 ${Number(idx) + 1} ${axisName}`
  return `${label}整${axisName} ${n} 格`
}

// 送出確認訊息並離開
function confirmPick() {
  // 已選了值就以那張表格為準：滑鼠可能正停在表格外的一段文字上
  if (selectedList.length > 0 && pickedTableEl && currentTargetEl !== pickedTableEl) {
    setTarget(pickedTableEl)
  }
  if (!currentTargetEl) return

  // 目標是 iframe(或它的代理層):值在框架裡面，選這個殼沒有意義，改成鑽進去
  const descendTarget = iframeOf(currentTargetEl)
  if (descendTarget) {
    const msg = { type: MSG.DESCEND_FRAME, purpose: currentPurpose, src: frameSrcOf(descendTarget) }
    if (currentTaskId !== undefined) msg.taskId = currentTaskId
    if (pendingPreselect) msg.preselect = pendingPreselect
    chrome.runtime.sendMessage(msg)
    exitPickMode()
    return
  }

  let picks = []
  if (selectedList.length > 0) {
    picks = [...selectedList]
  } else {
    if (isTableMode(currentTargetEl)) {
      if (pickMode === 'cell') {
        if (rowIndex !== null && colIndex !== null) {
          const dataRows = resolveDataRows(currentTargetEl)
          const row = dataRows[rowIndex]
          picks = [{
            cell: {
              row: { index: rowIndex, header: row ? rowHeader(row) : '' },
              col: { index: colIndex, header: columnHeaders(currentTargetEl)[colIndex] || '' }
            }
          }]
        } else {
          picks = [{
            block: {
              axis: 'col',
              index: currentCellIndex() !== null ? currentCellIndex() : 0,
              headerText: getHeaderText()
            }
          }]
        }
      } else if (pickMode === 'row') {
        picks = [{
          block: {
            axis: 'row',
            index: rowIndex !== null ? rowIndex : (currentCellIndex() !== null ? currentCellIndex() : 0),
            headerText: currentRowEl ? rowHeader(currentRowEl) : getHeaderText()
          }
        }]
      } else {
        picks = [{
          block: {
            axis: 'col',
            index: colIndex !== null ? colIndex : (currentCellIndex() !== null ? currentCellIndex() : 0),
            headerText: colIndex !== null ? (columnHeaders(currentTargetEl)[colIndex] || '') : getHeaderText()
          }
        }]
      }
    } else {
      picks = [{ locator: describe(currentTargetEl) }]
    }
  }

  if (currentPurpose !== 'task' && picks.length > 1) {
    picks = picks.slice(0, 1)
  }

  const blockInfo = { ...kindOf(currentTargetEl) }
  if (isTableMode(currentTargetEl)) {
    blockInfo.axis = pickMode === 'row' ? 'row' : 'col'
    blockInfo.index = currentCellIndex()
    blockInfo.headerText = getHeaderText()
  } else {
    delete blockInfo.axis
    delete blockInfo.index
  }

  const msg = {
    type: MSG.PICKED,
    purpose: currentPurpose,
    locator: describe(currentTargetEl),
    blockInfo,
    picks
  }

  if (isTableMode(currentTargetEl)) {
    const nameHint = computeNameHint(currentTargetEl)
    if (nameHint) msg.nameHint = nameHint
  }
  if (currentTaskId !== undefined) msg.taskId = currentTaskId

  if (!isTableMode(currentTargetEl)) {
    msg.preview = (currentTargetEl.textContent || '').trim()
    msg.previewValue = parseNumber(msg.preview)
  } else if (picks.length > 1) {
    const firstText = picks[0].cell
      ? getCellText(picks[0].cell, currentTargetEl)
      : (picks[0].block ? getBlockPreview(picks[0].block, currentTargetEl) : (currentTargetEl.textContent || '').trim())
    msg.preview = `${firstText}（共 ${picks.length} 個值）`
  } else if (picks.length === 1 && picks[0].cell) {
    const cellText = getCellText(picks[0].cell, currentTargetEl)
    msg.preview = cellText
    const num = parseNumber(cellText)
    if (num !== null) {
      msg.previewValue = num
    }
  } else if (picks.length === 1 && picks[0].block) {
    msg.preview = getBlockPreview(picks[0].block, currentTargetEl)
  } else {
    msg.preview = (currentTargetEl.textContent || '').trim()
    const num = parseNumber(msg.preview)
    if (num !== null) {
      msg.previewValue = num
    }
  }

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

// 關閉右鍵選單
function closeMenu() {
  if (menuEl) {
    menuEl.remove()
    menuEl = null
  }
  menuTargetContext = null
}

// 開啟右鍵選單
function openMenu(event) {
  const target = event.target
  const tableEl = (currentTargetEl && isTableMode(currentTargetEl)) ? currentTargetEl
    : tableOf(target)
  const isTable = Boolean(tableEl && isTableMode(tableEl))

  if (!menuEl) {
    menuEl = document.createElement('div')
    menuEl.setAttribute('data-af-menu', '')
    if (overlayEl) overlayEl.appendChild(menuEl)
    else if (document.body) document.body.appendChild(menuEl)
  }

  menuEl.style.position = 'fixed'
  menuEl.style.left = `${event.clientX || 0}px`
  menuEl.style.top = `${event.clientY || 0}px`
  menuEl.style.backgroundColor = COLORS.surface
  menuEl.style.border = `1px solid ${COLORS.border}`
  menuEl.style.borderRadius = '4px'
  menuEl.style.padding = '4px 0'
  menuEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)'
  menuEl.style.zIndex = '2147483647'
  menuEl.style.pointerEvents = 'auto'

  const cellInfo = isTable ? resolveCell(target, tableEl) : null
  menuTargetContext = { target, tableEl, cellInfo }

  while (menuEl.firstChild) {
    menuEl.removeChild(menuEl.firstChild)
  }

  const items = isTable
    ? [
        { key: 'cell', label: '選這一格' },
        { key: 'col-each', label: '這一欄：每格各一個值' },
        { key: 'col', label: '這一欄：整欄聚合成一個值' },
        { key: 'row-each', label: '這一列：每格各一個值' },
        { key: 'row', label: '這一列：整列聚合成一個值' },
        { key: 'done', label: '完成' },
        { key: 'cancel', label: '取消' }
      ]
    : [
        { key: 'element', label: '選取此元素' },
        { key: 'cancel', label: '取消' }
      ]

  for (const item of items) {
    const el = document.createElement('div')
    el.setAttribute('data-af-menu-item', item.key)
    el.textContent = item.label
    el.style.padding = '6px 16px'
    el.style.cursor = 'pointer'
    el.style.fontSize = '12px'
    el.style.color = COLORS.text
    el.style.backgroundColor = COLORS.surface
    el.style.userSelect = 'none'
    el.style.transition = 'background-color 150ms ease'
    menuEl.appendChild(el)
  }
}

// 處理右鍵選單項目點擊
function handleMenuAction(action) {
  if (!menuTargetContext) {
    closeMenu()
    return
  }
  const { tableEl, cellInfo } = menuTargetContext
  closeMenu()

  if (action === 'done') {
    confirmPick()
    return
  }
  if (action === 'cancel') {
    cancelPick()
    return
  }
  if (action === 'element') {
    confirmPick()
    return
  }

  if (action === 'cell') {
    if (tableEl && isTableMode(tableEl)) {
      const info = cellInfo || (rowIndex !== null && colIndex !== null ? { rIdx: rowIndex, cIdx: colIndex, dataRows: resolveDataRows(tableEl) } : null)
      if (info) {
        addPick(makeCellPick(info.rIdx, info.cIdx, tableEl, info.dataRows))
        applyPickedMarks(tableEl)
        updatePanel(panelEl, tableEl)
      }
    }
    return
  }

  if (action === 'col-each' || action === 'row-each') {
    if (tableEl && isTableMode(tableEl)) {
      const dataRows = resolveDataRows(tableEl)
      if (action === 'col-each') {
        // 一整欄的每一格各是一個值（各幣別的買入），與「整欄加總成一個值」是兩件事
        const cIdx = cellInfo ? cellInfo.cIdx : (colIndex !== null ? colIndex : 0)
        for (let r = 0; r < dataRows.length; r++) {
          addPick(makeCellPick(r, cIdx, tableEl, dataRows))
          if (limitReached) break
        }
      } else {
        const rIdx = cellInfo ? cellInfo.rIdx : (rowIndex !== null ? rowIndex : 0)
        const cols = columnHeaders(tableEl).length || getRowCells(dataRows[rIdx] || dataRows[0]).length
        for (let c = 0; c < cols; c++) {
          addPick(makeCellPick(rIdx, c, tableEl, dataRows))
          if (limitReached) break
        }
      }
      applyPickedMarks(tableEl)
      updatePanel(panelEl, tableEl)
    }
    return
  }

  if (action === 'col') {
    if (tableEl && isTableMode(tableEl)) {
      const cIdx = cellInfo ? cellInfo.cIdx : (colIndex !== null ? colIndex : (currentCellIndex() !== null ? currentCellIndex() : 0))
      addPick({ block: { axis: 'col', index: cIdx, headerText: columnHeaders(tableEl)[cIdx] || '' } })
      applyPickedMarks(tableEl)
      updatePanel(panelEl, tableEl)
    }
    return
  }

  if (action === 'row') {
    if (tableEl && isTableMode(tableEl)) {
      const dataRows = resolveDataRows(tableEl)
      const rIdx = cellInfo ? cellInfo.rIdx : (rowIndex !== null ? rowIndex : 0)
      const row = dataRows[rIdx]
      addPick({ block: { axis: 'row', index: rIdx, headerText: row ? rowHeader(row) : '' } })
      applyPickedMarks(tableEl)
      updatePanel(panelEl, tableEl)
    }
    return
  }
}

// 加入單一儲存格至已選清單
function makeCellPick(r, c, tableEl, dataRows) {
  const rows = dataRows || resolveDataRows(tableEl)
  const row = rows[r]
  return {
    cell: {
      row: { index: r, header: row ? rowHeader(row) : '' },
      col: { index: c, header: columnHeaders(tableEl)[c] || '' }
    }
  }
}

// 判定兩個已選項是不是同一個值（儲存格比列欄索引，聚合比軸與索引）
function samePick(a, b) {
  if (a.cell && b.cell) {
    return a.cell.row.index === b.cell.row.index && a.cell.col.index === b.cell.col.index
  }
  if (a.block && b.block) {
    return a.block.axis === b.block.axis && a.block.index === b.block.index
  }
  return false
}

// 加入一個值：去重與上限的判斷只有這一份，所有加選路徑都走它
function addPick(pick) {
  if (selectedList.some(p => samePick(p, pick))) return false
  if (selectedList.length >= maxPicks) {
    limitReached = true
    return false
  }
  selectedList.push(pick)
  if (!pickedTableEl && currentTargetEl && isTableMode(currentTargetEl)) pickedTableEl = currentTargetEl
  return true
}

// Shift 點擊：已經選過就取消，否則加入
function togglePick(pick) {
  const at = selectedList.findIndex(p => samePick(p, pick))
  if (at >= 0) {
    selectedList.splice(at, 1)
    limitReached = false
    return
  }
  addPick(pick)
}

function addCellPick(r, c, dataRows) {
  addPick(makeCellPick(r, c, currentTargetEl, dataRows))
}

// 套用預選項
function applyPreselect(preselect, tableEl) {
  if (!Array.isArray(preselect) || !tableEl || !isTableMode(tableEl)) return
  const dataRows = resolveDataRows(tableEl)
  const colHeaders = columnHeaders(tableEl)

  for (const item of preselect) {
    if (!item) continue
    if (selectedList.length >= maxPicks) {
      limitReached = true
      break
    }
    if (item.cell) {
      let rIdx = item.cell.row ? item.cell.row.index : null
      let rHeader = item.cell.row ? item.cell.row.header : ''
      let cIdx = item.cell.col ? item.cell.col.index : null
      let cHeader = item.cell.col ? item.cell.col.header : ''

      if (cHeader) {
        const found = colHeaders.indexOf(cHeader)
        if (found === -1) continue
        if (found !== cIdx) {
          headerChangedNotice = true
          cIdx = found
        }
      }
      if (rHeader) {
        let found = -1
        for (let i = 0; i < dataRows.length; i++) {
          if (rowHeader(dataRows[i]) === rHeader) {
            found = i
            break
          }
        }
        if (found === -1) continue
        if (found !== rIdx) {
          headerChangedNotice = true
          rIdx = found
        }
      }

      if (rIdx !== null && cIdx !== null && rIdx >= 0 && rIdx < dataRows.length && cIdx >= 0) {
        const targetRow = dataRows[rIdx]
        const actualRowHeader = rHeader || (targetRow ? rowHeader(targetRow) : '')
        const actualColHeader = cHeader || (colHeaders[cIdx] || '')
        addPick({
          cell: {
            row: { index: rIdx, header: actualRowHeader },
            col: { index: cIdx, header: actualColHeader }
          }
        })
      }
    } else if (item.block) {
      const axis = item.block.axis
      let bIdx = item.block.index
      const bHeader = item.block.headerText || ''

      if (axis === 'col') {
        if (bHeader) {
          const found = colHeaders.indexOf(bHeader)
          if (found === -1) continue
          if (found !== bIdx) {
            headerChangedNotice = true
            bIdx = found
          }
        }
        if (bIdx !== null && bIdx >= 0) {
          addPick({ block: { axis: 'col', index: bIdx, headerText: bHeader || colHeaders[bIdx] || '' } })
        }
      } else if (axis === 'row') {
        if (bHeader) {
          let found = -1
          for (let i = 0; i < dataRows.length; i++) {
            if (rowHeader(dataRows[i]) === bHeader) {
              found = i
              break
            }
          }
          if (found === -1) continue
          if (found !== bIdx) {
            headerChangedNotice = true
            bIdx = found
          }
        }
        if (bIdx !== null && bIdx >= 0 && bIdx < dataRows.length) {
          addPick({ block: { axis: 'row', index: bIdx, headerText: bHeader || rowHeader(dataRows[bIdx]) || '' } })
        }
      }
    }
  }
}

// 事件監聽處理常式
function onMouseMove(event) {
  if (!active) return
  const target = event.target
  // overlay 自己的元素一律跳過，唯一例外是 iframe 的代理層——它就是為了被指到才貼的
  const isProxy = !!frameOfProxy(target)
  if (!target || (!isProxy && overlayEl && (target === overlayEl || overlayEl.contains(target)))) return

  if (dragStart && event.buttons === 1 && currentTargetEl && isTableMode(currentTargetEl)) {
    const info = resolveCell(target, currentTargetEl)
    if (info && (info.rIdx !== dragStart.rIdx || info.cIdx !== dragStart.cIdx)) {
      isDragging = true
    }
  }

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
  } else if (event.key === 'Backspace') {
    // 沒有東西可移除就放給頁面：選取模式可能開在有輸入框的頁面上（例如站台登入設定）
    if (selectedList.length > 0) {
      event.preventDefault()
      removeLastPick()
    }
  } else if (event.key === 'Enter') {
    if (!currentTargetEl) return
    event.preventDefault(); confirmPick()
  } else if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    if (currentTargetEl && isTableMode(currentTargetEl) && currentPurpose === 'task') {
      event.preventDefault()
      const dataRows = resolveDataRows(currentTargetEl)
      if (dataRows.length > 0) {
        const curR = rowIndex !== null ? rowIndex : 0
        const curC = colIndex !== null ? colIndex : 0
        const numCols = columnHeaders(currentTargetEl).length || getRowCells(dataRows[0]).length

        addCellPick(curR, curC, dataRows)

        let newR = curR
        let newC = curC
        if (event.key === 'ArrowRight') newC = Math.min(numCols - 1, curC + 1)
        else if (event.key === 'ArrowLeft') newC = Math.max(0, curC - 1)
        else if (event.key === 'ArrowDown') newR = Math.min(dataRows.length - 1, curR + 1)
        else if (event.key === 'ArrowUp') newR = Math.max(0, curR - 1)

        rowIndex = newR
        colIndex = newC
        cellIndex = pickMode === 'row' ? rowIndex : colIndex
        currentRowEl = dataRows[rowIndex]
        const rowCells = getRowCells(currentRowEl)
        currentCellEl = rowCells[colIndex] || null

        addCellPick(newR, newC, dataRows)
        applyPickedMarks(currentTargetEl)
        markCells(currentCellEl, dataRows, currentRowEl, pickMode, colIndex)
        updatePanel(panelEl, currentTargetEl)
      }
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!currentTargetEl || currentTargetEl === document.body) return
    // 指在代理層時往上要走 iframe 的父層；代理層自己的父層是我們的 overlay
    const anchor = frameOfProxy(currentTargetEl) || currentTargetEl
    if (anchor.parentElement) {
      backStack.push(currentTargetEl); setTarget(anchor.parentElement)
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (backStack.length > 0) setTarget(backStack.pop())
  } else if (event.key === 'Tab') {
    if (currentTargetEl && isTableMode(currentTargetEl)) {
      event.preventDefault()
      const modes = ['cell', 'col', 'row']
      const availableModes = currentPurpose !== 'task' ? ['cell'] : modes
      if (availableModes.length > 1) {
        const curIdx = availableModes.indexOf(pickMode)
        const nextIdx = (curIdx + 1) % availableModes.length
        pickMode = availableModes[nextIdx]
        cellIndex = pickMode === 'row' ? rowIndex : colIndex
        updateToolbar()
        markCells(currentCellEl, currentDataRows, currentRowEl, pickMode, colIndex)
        applyPickedMarks(currentTargetEl)
        updatePanel(panelEl, currentTargetEl)
      }
    }
  }
}

function onClick(event) {
  if (!active) return
  event.preventDefault(); event.stopPropagation()

  if (suppressClick) {
    return
  }

  // 1. 右鍵選單處理
  if (menuEl) {
    const menuItem = event.target && event.target.closest ? event.target.closest('[data-af-menu-item]') : null
    if (menuItem) {
      const action = menuItem.getAttribute('data-af-menu-item')
      handleMenuAction(action)
      return
    }
    closeMenu()
    return
  }

  // 2. 工具列按鈕點擊
  const toolBtn = event.target && event.target.closest ? event.target.closest('[data-af-tool]') : null
  if (toolBtn) {
    if (toolBtn.getAttribute('aria-disabled') === 'true') {
      return
    }
    const mode = toolBtn.getAttribute('data-af-tool')
    if (mode && (mode === 'cell' || mode === 'col' || mode === 'row')) {
      pickMode = mode
      cellIndex = pickMode === 'row' ? rowIndex : colIndex
      updateToolbar()
      if (currentTargetEl && isTableMode(currentTargetEl)) {
        markCells(currentCellEl, currentDataRows, currentRowEl, pickMode, colIndex)
        applyPickedMarks(currentTargetEl)
        updatePanel(panelEl, currentTargetEl)
      }
    }
    return
  }

  // 3. 已選清單 chip 移除鈕點擊
  const chipRemoveBtn = event.target && event.target.closest ? event.target.closest('[data-af-chip-remove]') : null
  if (chipRemoveBtn) {
    const chipEl = chipRemoveBtn.closest('[data-af-chip]')
    if (chipEl) {
      const idx = parseInt(chipEl.getAttribute('data-af-chip'), 10)
      if (!isNaN(idx)) {
        removePickAt(idx)
      }
    }
    return
  }

  // 4. 面板「移除最後一項」按鈕點擊
  const removeLastBtn = event.target && event.target.closest ? event.target.closest('[data-af-remove-last]') : null
  if (removeLastBtn) {
    removeLastPick()
    return
  }

  // 5. 面板或工具列本身的其餘點擊（絕對不可以送出確認）
  if (panelEl && (event.target === panelEl || panelEl.contains(event.target))) {
    return
  }
  if (toolbarEl && (event.target === toolbarEl || toolbarEl.contains(event.target))) {
    return
  }
  // overlay 自己的點擊（非代理層）也不得送出
  if (overlayEl && (event.target === overlayEl || (overlayEl.contains(event.target) && !frameOfProxy(event.target)))) {
    return
  }

  if (!currentTargetEl && event.target && (!overlayEl || (!overlayEl.contains(event.target) && event.target !== overlayEl))) {
    setTarget(event.target)
  }
  if (!currentTargetEl) return

  // 6. 表格內的格子點擊
  if (isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)) {
    handleTableMouseMove(event.target)
    const cellInfo = resolveCell(event.target, currentTargetEl)
    if (cellInfo) {
      let candidate = null
      if (pickMode === 'cell') {
        candidate = makeCellPick(cellInfo.rIdx, cellInfo.cIdx, currentTargetEl, cellInfo.dataRows)
      } else if (pickMode === 'col') {
        candidate = {
          block: {
            axis: 'col',
            index: cellInfo.cIdx,
            headerText: columnHeaders(currentTargetEl)[cellInfo.cIdx] || ''
          }
        }
      } else if (pickMode === 'row') {
        candidate = {
          block: {
            axis: 'row',
            index: cellInfo.rIdx,
            headerText: cellInfo.row ? rowHeader(cellInfo.row) : ''
          }
        }
      }

      if (candidate) {
        const isAlreadySelected = selectedList.some(p => samePick(p, candidate))

        // Shift + 點：切換加選／取消，不送出
        if (event.shiftKey && currentPurpose === 'task') {
          togglePick(candidate)
          applyPickedMarks(currentTargetEl)
          updatePanel(panelEl, currentTargetEl)
          return
        }

        // 點一個已經選過的（同一格／同一欄／同一列）：移除它，不送出
        if (isAlreadySelected) {
          togglePick(candidate)
          applyPickedMarks(currentTargetEl)
          updatePanel(panelEl, currentTargetEl)
          return
        }

        // 點一個沒選過的格子：加入並送出。
        // 加不進去（已達上限）就停在原地提示，不能靜靜送出前面那幾個、把使用者剛點的丟掉
        if (!addPick(candidate)) {
          applyPickedMarks(currentTargetEl)
          updatePanel(panelEl, currentTargetEl)
          return
        }
        confirmPick()
        return
      }
    }
  }

  // 非表格模式點擊確認
  confirmPick()
}

function onMouseDown(event) {
  if (!active) return
  if (menuEl) {
    if (!menuEl.contains(event.target)) {
      closeMenu()
      suppressClick = true
      setTimeout(() => { suppressClick = false }, 0)
    }
    return
  }
  if (event.button !== 0) return
  event.preventDefault()
  if (currentTargetEl && isTableMode(currentTargetEl)) {
    const info = resolveCell(event.target, currentTargetEl)
    if (info) {
      dragStart = { rIdx: info.rIdx, cIdx: info.cIdx }
      isDragging = false
    }
  }
}

function onMouseUp(event) {
  if (!active) return
  if (!dragStart) return
  if (isDragging && currentTargetEl && isTableMode(currentTargetEl)) {
    const endInfo = resolveCell(event.target, currentTargetEl)
    const endR = endInfo ? endInfo.rIdx : dragStart.rIdx
    const endC = endInfo ? endInfo.cIdx : dragStart.cIdx
    const minR = Math.min(dragStart.rIdx, endR)
    const maxR = Math.max(dragStart.rIdx, endR)
    const minC = Math.min(dragStart.cIdx, endC)
    const maxC = Math.max(dragStart.cIdx, endC)

    const dataRows = resolveDataRows(currentTargetEl)
    const colHeaders = columnHeaders(currentTargetEl)

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        addPick(makeCellPick(r, c, currentTargetEl, dataRows))
        if (limitReached) break
      }
      if (selectedList.length >= maxPicks) break
    }

    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
    applyPickedMarks(currentTargetEl)
    updatePanel(panelEl, currentTargetEl)
  }
  dragStart = null
  isDragging = false
}

function onContextMenu(event) {
  if (!active) return
  event.preventDefault()
  event.stopPropagation()
  openMenu(event)
}

export function enterPickMode(opts) {
  exitPickMode()
  active = true
  currentPurpose = opts?.purpose || null
  currentTaskId = opts?.taskId !== undefined ? opts.taskId : undefined
  maxPicks = (typeof opts?.maxPicks === 'number' && opts.maxPicks > 0) ? opts.maxPicks : 20
  limitReached = false
  headerChangedNotice = false
  selectedList = []
  dragStart = null
  isDragging = false
  suppressClick = false
  menuTargetContext = null
  backStack = []
  currentHint = opts?.hint || null
  // 下鑽之後要把原本要勾回的值一起帶過去
  pendingPreselect = opts?.preselect || null
  if (typeof document === 'undefined' || !document.body) return

  originalUserSelect = document.body.style.userSelect || ''
  document.body.style.userSelect = 'none'

  overlayEl = document.createElement('div')
  overlayEl.setAttribute('data-af-overlay', '')
  overlayEl.style.position = 'absolute'; overlayEl.style.top = '0'; overlayEl.style.left = '0'
  overlayEl.style.width = '0'; overlayEl.style.height = '0'; overlayEl.style.pointerEvents = 'none'; overlayEl.style.zIndex = '2147483647'

  highlightEl = document.createElement('div')
  highlightEl.setAttribute('data-af-highlight', '')
  highlightEl.style.position = 'absolute'; highlightEl.style.border = `2px solid ${COLORS.primary}`
  highlightEl.style.boxSizing = 'border-box'; highlightEl.style.pointerEvents = 'none'; highlightEl.style.zIndex = '2147483647'
  overlayEl.appendChild(highlightEl)

  // 建立工具列（三段相連，作用中段用主色底）
  toolbarEl = document.createElement('div')
  toolbarEl.setAttribute('data-af-toolbar', '')
  toolbarEl.style.position = 'fixed'; toolbarEl.style.right = '16px'; toolbarEl.style.top = '16px'
  toolbarEl.style.display = 'flex'; toolbarEl.style.gap = '0'; toolbarEl.style.pointerEvents = 'auto'
  toolbarEl.style.zIndex = '2147483647'
  toolbarEl.style.backgroundColor = COLORS.surface
  toolbarEl.style.border = `1px solid ${COLORS.border}`
  toolbarEl.style.borderRadius = '8px'
  toolbarEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)'
  toolbarEl.style.overflow = 'hidden'

  const toolsDef = [
    { key: 'cell', label: '單格' },
    { key: 'col', label: '整欄' },
    { key: 'row', label: '整列' }
  ]

  for (const def of toolsDef) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('data-af-tool', def.key)
    btn.textContent = def.label
    btn.style.padding = '4px 10px'
    btn.style.fontSize = '12px'
    btn.style.borderRadius = '0'
    btn.style.border = 'none'
    btn.style.borderRight = `1px solid ${COLORS.border}`
    btn.style.cursor = 'pointer'
    btn.style.fontFamily = 'inherit'
    btn.style.minHeight = '28px'
    btn.style.transition = 'background-color 150ms ease, color 150ms ease'
    toolbarEl.appendChild(btn)
  }
  // 移除最後一個按鈕的右邊框
  if (toolbarEl.lastChild) toolbarEl.lastChild.style.borderRight = 'none'
  overlayEl.appendChild(toolbarEl)

  panelEl = document.createElement('div')
  panelEl.setAttribute('data-af-panel', '')
  panelEl.style.position = 'fixed'; panelEl.style.right = '16px'; panelEl.style.bottom = '16px'
  panelEl.style.backgroundColor = COLORS.surface; panelEl.style.color = COLORS.textMuted; panelEl.style.pointerEvents = 'auto'; panelEl.style.zIndex = '2147483647'
  panelEl.style.border = `1px solid ${COLORS.border}`
  panelEl.style.padding = '8px 12px'; panelEl.style.borderRadius = '8px'; panelEl.style.fontSize = '12px'; panelEl.style.lineHeight = '1.4'; panelEl.style.whiteSpace = 'pre-line'
  panelEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)'
  overlayEl.appendChild(panelEl)

  document.body.appendChild(overlayEl)
  buildFrameProxies()
  setTarget(opts?.initialTarget || null)

  if (opts?.preselect && currentTargetEl && isTableMode(currentTargetEl)) {
    applyPreselect(opts.preselect, currentTargetEl)
    applyPickedMarks(currentTargetEl)
    updatePanel(panelEl, currentTargetEl)
  }

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('contextmenu', onContextMenu, true)
}

export function exitPickMode() {
  currentHint = null
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    clearMarkedCells(document)
    clearPickedMarks(document)
    closeMenu()
    if (document.body) {
      document.body.style.userSelect = originalUserSelect
    }
    for (const el of (document.querySelectorAll ? document.querySelectorAll('[data-af-overlay]') : [])) {
      el.remove()
    }
    for (const el of (document.querySelectorAll ? document.querySelectorAll('[data-af-menu]') : [])) {
      el.remove()
    }
  }
  active = false; currentPurpose = null; currentTaskId = undefined; currentTargetEl = null; backStack = []
  overlayEl = null; highlightEl = null; panelEl = null; toolbarEl = null; menuEl = null
  pickMode = 'cell'; cellIndex = null; colIndex = null; rowIndex = null; currentCellEl = null
  currentDataRows = []; currentRowEl = null
  selectedList = []
  // 這一個漏清會讓下一次選取沿用上一張表的 locator，配上新表的列欄索引送出去（AF-7 體檢）
  pickedTableEl = null
  maxPicks = 20
  limitReached = false
  headerChangedNotice = false
  dragStart = null
  isDragging = false
  suppressClick = false
  menuTargetContext = null
}

export function isActive() { return active }
export function currentTarget() { return currentTargetEl }
export function currentAxis() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : (pickMode === 'row' ? 'row' : 'col') }
export function currentCellIndex() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : cellIndex }
export function selectedCount() { return selectedList.length }
