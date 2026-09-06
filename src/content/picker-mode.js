// 豁免說明：此檔案在網頁 isolated world 執行，網頁未載入 ui/theme.css，因此為全專案唯一允許寫色碼字面值之檔案。色碼源自 ui/theme.css 亮色：主色 #2563eb、白 #ffffff、警示 #d97706。
import { MSG } from '../shared/messages.js'
import { describe } from '../shared/selector.js'
import { detectKind } from '../shared/block-detect.js'
import { parseNumber } from '../shared/extract.js'
import { columnHeaders, rowHeader } from '../shared/table.js'

let active = false, currentPurpose = null, currentTaskId = undefined, currentTargetEl = null, backStack = []
let overlayEl = null, highlightEl = null, panelEl = null, menuEl = null
let tableAxis = null, cellIndex = null, colIndex = null, rowIndex = null, currentDataRows = [], currentRowEl = null
let selectedList = [], maxPicks = 20, limitReached = false, headerChangedNotice = false
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
    cell = target.closest ? target.closest('td, th, [role="cell"], [role="gridcell"], [role="columnheader"]') : null
    if (!cell || !tableEl.contains(cell)) return null
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
      cell.style.outline = '2px solid #2563eb'
    } else {
      cell.style.outline = ''
    }
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

// 清除所有已選標記
function clearPickedMarks(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || typeof d.querySelectorAll !== 'function') return
  for (const cell of d.querySelectorAll('[data-af-picked]')) {
    cell.removeAttribute('data-af-picked')
    if (cell.hasAttribute('data-af-cell')) {
      cell.style.outline = '2px solid #d97706'
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
          cell.style.outline = '2px solid #2563eb'
        }
      }
    } else if (pick.block) {
      if (pick.block.axis === 'col') {
        for (const row of dataRows) {
          const cells = getRowCells(row)
          const cell = cells[pick.block.index]
          if (cell && !isHeaderCell(cell)) {
            cell.setAttribute('data-af-picked', '')
            cell.style.outline = '2px solid #2563eb'
          }
        }
      } else if (pick.block.axis === 'row') {
        const row = dataRows[pick.block.index]
        if (row) {
          for (const cell of getRowCells(row)) {
            if (!isHeaderCell(cell)) {
              cell.setAttribute('data-af-picked', '')
              cell.style.outline = '2px solid #2563eb'
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

// 產生說明面板文字
function updatePanel(panel, el) {
  if (!panel) return
  if (selectedList.length > 0) {
    const count = selectedList.length
    const names = selectedList.slice(0, 3).map(getPickName)
    let nameStr = names.join('、')
    if (selectedList.length > 3) {
      nameStr += '…'
    }
    const lines = [`已選 ${count} 個值: ${nameStr}`]
    if (limitReached || selectedList.length >= maxPicks) {
      lines.push('（已達選取上限）')
    }
    if (headerChangedNotice) {
      lines.push('（位置已變）')
    }
    lines.push('Shift 點選加選 / 拖曳框選 / 右鍵選單 / Enter 完成 / Esc 取消')
    panel.textContent = lines.join('\n')
    return
  }

  if (!el) {
    const lines = []
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
  if (limitReached || selectedList.length >= maxPicks) lines.push('（已達選取上限）')
  if (headerChangedNotice) lines.push('（位置已變）')
  lines.push('↑ 放大 ↓ 縮小 / Shift 點選加選 / 拖曳框選 / 右鍵選單 / Enter 確認 Esc 取消')
  panel.textContent = lines.join('\n')
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
  const info = resolveCell(target, currentTargetEl)
  if (!info) return
  colIndex = info.cIdx
  rowIndex = info.rIdx
  cellIndex = tableAxis === 'row' ? rowIndex : colIndex
  currentDataRows = info.dataRows
  currentRowEl = info.row
  markCells(info.dataRows, info.row, tableAxis, colIndex)
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

  let picks = []
  if (selectedList.length > 0) {
    picks = [...selectedList]
  } else {
    if (isTableMode(currentTargetEl)) {
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
            axis: tableAxis || 'col',
            index: currentCellIndex() !== null ? currentCellIndex() : 0,
            headerText: getHeaderText()
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
  msg.picks = picks

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
    : (target && target.closest ? target.closest('table, [role="grid"], [role="table"]') : null)
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
  menuEl.style.backgroundColor = '#ffffff'
  menuEl.style.border = '1px solid #2563eb'
  menuEl.style.borderRadius = '4px'
  menuEl.style.padding = '4px 0'
  menuEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)'
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
        { key: 'col', label: '選這一欄' },
        { key: 'row', label: '選這一列' },
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
    el.style.color = '#2563eb'
    el.style.backgroundColor = '#ffffff'
    el.style.userSelect = 'none'
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
  if (!target || (overlayEl && (target === overlayEl || overlayEl.contains(target)))) return

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
        cellIndex = tableAxis === 'row' ? rowIndex : colIndex
        currentRowEl = dataRows[rowIndex]

        addCellPick(newR, newC, dataRows)
        applyPickedMarks(currentTargetEl)
        markCells(dataRows, currentRowEl, tableAxis, colIndex)
        updatePanel(panelEl, currentTargetEl)
      }
    }
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
      selectedList = []
      clearPickedMarks(document)
      markCells(currentDataRows, currentRowEl, tableAxis, colIndex)
      updatePanel(panelEl, currentTargetEl)
    }
  }
}

function onClick(event) {
  if (!active) return
  event.preventDefault(); event.stopPropagation()

  if (suppressClick) {
    return
  }

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

  if (!currentTargetEl && event.target && (!overlayEl || (!overlayEl.contains(event.target) && event.target !== overlayEl))) {
    setTarget(event.target)
  }
  if (!currentTargetEl) return

  if (isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)) {
    handleTableMouseMove(event.target)
    const cellInfo = resolveCell(event.target, currentTargetEl)
    if (cellInfo && event.shiftKey && currentPurpose === 'task') {
      togglePick(makeCellPick(cellInfo.rIdx, cellInfo.cIdx, currentTargetEl, cellInfo.dataRows))
      applyPickedMarks(currentTargetEl)
      updatePanel(panelEl, currentTargetEl)
      return
    }

    if (cellInfo && (!event.shiftKey || currentPurpose !== 'task')) {
      const rIdx = cellInfo.rIdx
      const cIdx = cellInfo.cIdx
      const rHeader = rowHeader(cellInfo.dataRows[rIdx]) || ''
      const cHeader = columnHeaders(currentTargetEl)[cIdx] || ''
      selectedList = [{
        cell: {
          row: { index: rIdx, header: rHeader },
          col: { index: cIdx, header: cHeader }
        }
      }]
    }
  }

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
  if (typeof document === 'undefined' || !document.body) return

  originalUserSelect = document.body.style.userSelect || ''
  document.body.style.userSelect = 'none'

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
  overlayEl = null; highlightEl = null; panelEl = null; menuEl = null; tableAxis = null; cellIndex = null; colIndex = null; rowIndex = null
  currentDataRows = []; currentRowEl = null
  selectedList = []
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
export function currentAxis() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : (tableAxis || 'col') }
export function currentCellIndex() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : cellIndex }
export function selectedCount() { return selectedList.length }
