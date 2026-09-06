// AutoFetcher 表格解析（SPEC §7）：把各種表格寫法解析成二維陣列

// 去除文字頭尾空白
function cleanText(text) {
  return (text || '').trim()
}

// 判定是否為虛擬捲動表格（只渲染可視列）
function isPartial(el) {
  const scrollHeight = Number(el?.scrollHeight) || 0
  const clientHeight = Number(el?.clientHeight) || 0
  if (clientHeight <= 0) return false
  return scrollHeight > clientHeight * 1.5
}

// 取得元素的 role 屬性
function getRole(el) {
  const role = typeof el?.getAttribute === 'function' ? el.getAttribute('role') : el?.role
  return (typeof role === 'string' ? role.trim().toLowerCase() : '')
}

// 安全讀取跨欄或跨列數值
function getSpan(cell, attr) {
  if (!cell) return 1
  const val = typeof cell.getAttribute === 'function' ? cell.getAttribute(attr) : cell[attr]
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

// 取得 HTML 表格的所有列
function getTableRows(table) {
  if (table.rows) return Array.from(table.rows)
  if (typeof table.querySelectorAll === 'function') return Array.from(table.querySelectorAll('tr'))
  return Array.from(table.children || []).filter((child) => child.tagName === 'TR')
}

// 取得列的所有格子
function getRowCells(row) {
  if (row.cells) return Array.from(row.cells)
  if (typeof row.querySelectorAll === 'function') return Array.from(row.querySelectorAll('th, td'))
  return Array.from(row.children || []).filter((child) => child.tagName === 'TH' || child.tagName === 'TD')
}

// 判定是否為 HTML 表格的表頭列
function isHeaderRow(row, cells) {
  if (cells.length === 0) return false
  const inThead = (typeof row.closest === 'function' && Boolean(row.closest('thead'))) ||
    row.parentElement?.tagName === 'THEAD'
  if (inThead) return true
  return cells.every((cell) => cell.tagName === 'TH')
}

// 取得 ARIA 表格的列元素
function getAriaRows(el) {
  if (typeof el.querySelectorAll === 'function') {
    const rows = Array.from(el.querySelectorAll('[role="row"]'))
    if (rows.length > 0) return rows
  }
  return Array.from(el.children || []).filter((child) => getRole(child) === 'row')
}

/**
 * 取得與資料欄一一對齊的表頭字串陣列。
 * @param {Element} el 表格元素
 * @returns {string[]} 表頭字串陣列
 */
export function columnHeaders(el) {
  if (!el) return []

  let headerRows = []

  // 1. HTML <table>
  if (el.tagName === 'TABLE' || (typeof el.querySelector === 'function' && el.querySelector('table'))) {
    let table = el
    while (typeof table.querySelector === 'function') {
      const inner = table.querySelector('table')
      if (!inner) break
      table = inner
    }
    const rows = getTableRows(table)
    // 只認 thead 裡的列，或表格開頭連續的表頭列。
    // 表格中段常有整列 th 的分組標題（「亞洲貨幣」那種），
    // 把它也當表頭會讓整份 headers 被那一列洗掉。
    const inThead = (row) => (typeof row.closest === 'function' && Boolean(row.closest('thead'))) ||
      row.parentElement?.tagName === 'THEAD'
    const theadRows = rows.filter(inThead)
    if (theadRows.length > 0) {
      for (const row of theadRows) headerRows.push({ row, cells: getRowCells(row) })
    } else {
      for (const row of rows) {
        const cells = getRowCells(row)
        if (!isHeaderRow(row, cells)) break
        headerRows.push({ row, cells })
      }
    }
  } else {
    // 2. ARIA 表格
    const role = getRole(el)
    if (role === 'grid' || role === 'table') {
      const rows = getAriaRows(el)
      for (const row of rows) {
        let colHeaders = []
        if (typeof row.querySelectorAll === 'function') {
          colHeaders = Array.from(row.querySelectorAll('[role="columnheader"]'))
        } else {
          const children = Array.from(row.children || [])
          colHeaders = children.filter((child) => getRole(child) === 'columnheader')
        }
        if (colHeaders.length > 0) {
          headerRows.push({ row, cells: colHeaders })
        }
      }
    }
  }

  const H = headerRows.length
  if (H === 0) return []

  // 配置表頭網格展開 rowspan 與 colspan
  const grid = []
  for (let r = 0; r < H; r++) {
    if (!grid[r]) grid[r] = []
    const cells = headerRows[r].cells
    let col = 0

    for (const cell of cells) {
      while (grid[r][col] !== undefined) {
        col++
      }

      const text = cleanText(cell.textContent)
      const rowspan = getSpan(cell, 'rowspan')
      const colspan = getSpan(cell, 'colspan')

      for (let dr = 0; dr < rowspan; dr++) {
        const targetR = r + dr
        if (!grid[targetR]) grid[targetR] = []
        for (let dc = 0; dc < colspan; dc++) {
          grid[targetR][col + dc] = {
            cell,
            text,
            rowspan,
            colspan,
            startR: r,
            startCol: col,
          }
        }
      }

      col += colspan
    }
  }

  const lastRow = grid[H - 1] || []
  const headers = []

  for (let c = 0; c < lastRow.length; c++) {
    const bottom = lastRow[c]
    const bottomText = bottom ? bottom.text : ''
    const groups = []

    for (let r = 0; r < H - 1; r++) {
      const upper = grid[r]?.[c]
      if (upper && upper.cell !== bottom?.cell && upper.colspan > 1 && upper.text) {
        if (groups.length === 0 || groups[groups.length - 1] !== upper.text) {
          groups.push(upper.text)
        }
      }
    }

    if (groups.length > 0 && bottomText) {
      headers.push(`${groups.join(' · ')} · ${bottomText}`)
    } else if (groups.length > 0) {
      headers.push(groups.join(' · '))
    } else {
      headers.push(bottomText)
    }
  }

  return headers
}

/**
 * 取得該列的列標題（第一個非空格子文字）。
 * @param {Element|string[]} row 列元素或儲存格字串陣列
 * @returns {string} 列標題文字
 */
export function rowHeader(row) {
  if (!row) return ''
  if (Array.isArray(row)) {
    for (const item of row) {
      const text = cleanText(typeof item === 'string' ? item : item?.textContent)
      if (text) return text
    }
    return ''
  }
  const cells = getRowCells(row)
  for (const cell of cells) {
    const text = cleanText(cell?.textContent)
    if (text) return text
  }
  return ''
}

/**
 * 取得表格所有的資料列 DOM 元素（排除表頭列）。
 * @param {Element} el 表格元素
 * @returns {Element[]} 資料列 DOM 元素陣列
 */
export function getDataRows(el) {
  if (!el) return []
  let table = el
  if (table.tagName === 'TABLE' || (typeof table.querySelector === 'function' && table.querySelector('table'))) {
    while (typeof table.querySelector === 'function') {
      const inner = table.querySelector('table')
      if (!inner) break
      table = inner
    }
    const rows = getTableRows(table)
    const dataRows = []
    for (const row of rows) {
      const cells = getRowCells(row)
      if (!isHeaderRow(row, cells) && cells.length > 0) {
        dataRows.push(row)
      }
    }
    return dataRows
  }

  const role = getRole(el)
  if (role === 'grid' || role === 'table') {
    const rows = getAriaRows(el)
    const dataRows = []
    for (const row of rows) {
      let dataCells = []
      if (typeof row.querySelectorAll === 'function') {
        dataCells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]'))
      } else {
        dataCells = Array.from(row.children || []).filter((child) => {
          const r = getRole(child)
          return r === 'cell' || r === 'gridcell'
        })
      }
      if (dataCells.length > 0) {
        dataRows.push(row)
      }
    }
    return dataRows
  }

  return []
}

// 解析 HTML <table> 元素
function parseHtmlTable(el) {
  // 巢狀 table 取最內層
  let table = el
  while (typeof table.querySelector === 'function') {
    const inner = table.querySelector('table')
    if (!inner) break
    table = inner
  }

  const rows = getTableRows(table)
  const headers = columnHeaders(table)
  const dataRows = []

  for (const row of rows) {
    const cells = getRowCells(row)
    if (!isHeaderRow(row, cells) && cells.length > 0) {
      dataRows.push(cells)
    }
  }

  // 配置網格展開 rowspan 與 colspan
  const grid = []
  for (let r = 0; r < dataRows.length; r++) {
    if (!grid[r]) grid[r] = []
    const cells = dataRows[r]
    let col = 0

    for (const cell of cells) {
      // 遇到被占用的位置就往右找下一個空位
      while (grid[r][col] !== undefined) {
        col++
      }

      const text = cleanText(cell.textContent)
      const rowspan = getSpan(cell, 'rowspan')
      const colspan = getSpan(cell, 'colspan')

      for (let dr = 0; dr < rowspan; dr++) {
        const targetR = r + dr
        if (targetR >= dataRows.length) break
        if (!grid[targetR]) grid[targetR] = []
        for (let dc = 0; dc < colspan; dc++) {
          grid[targetR][col + dc] = text
        }
      }

      col += colspan
    }
  }

  // 各列展開後保留各自的長度，不補空字串
  const cells = []
  for (let r = 0; r < dataRows.length; r++) {
    const row = grid[r] || []
    const rowCells = []
    for (let c = 0; c < row.length; c++) {
      rowCells.push(row[c] !== undefined ? row[c] : '')
    }
    cells.push(rowCells)
  }

  return { cells, headers }
}

// 解析 ARIA 表格
function parseAriaTable(el) {
  const rows = getAriaRows(el)
  const headers = columnHeaders(el)
  const cells = []

  for (const row of rows) {
    let dataCells = []

    if (typeof row.querySelectorAll === 'function') {
      dataCells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]'))
    } else {
      const children = Array.from(row.children || [])
      dataCells = children.filter((child) => {
        const role = getRole(child)
        return role === 'cell' || role === 'gridcell'
      })
    }

    if (dataCells.length > 0) {
      cells.push(dataCells.map((c) => cleanText(c.textContent)))
    }
  }

  return { cells, headers }
}

// 判定是否符合 CSS 假表格條件
function isCssGrid(el) {
  const children = Array.from(el?.children || [])
  if (children.length < 3) return false
  const firstChild = children[0]
  if (!firstChild?.children) return false
  const cols = firstChild.children.length
  if (cols < 2) return false
  return children.every((child) => (child.children?.length ?? -1) === cols)
}

// 解析 CSS 假表格
function parseCssGrid(el) {
  const children = Array.from(el.children || [])
  const cells = children.map((row) =>
    Array.from(row.children || []).map((col) => cleanText(col.textContent))
  )
  return { cells, headers: [] }
}

// 取得清單項目元素
function getListItems(el) {
  const directItems = Array.from(el.children || []).filter((child) => child.tagName === 'LI')
  if (directItems.length > 0) return directItems
  if (typeof el.querySelectorAll === 'function') return Array.from(el.querySelectorAll('li'))
  return []
}

// 解析清單
function parseList(el) {
  const items = getListItems(el)
  const cells = items.map((item) => {
    const trimmed = cleanText(item.textContent)
    return trimmed ? trimmed.split(/\s+/) : ['']
  })

  return { cells, headers: [] }
}

/**
 * 把網頁上各種寫法的表格統一解析成二維陣列。
 * @param {Element} el 要解析的 DOM 元素
 * @returns {{cells: string[][], headers: string[], partial: boolean, source: string}}
 */
export function parseTable(el) {
  if (!el) {
    return { cells: [], headers: [], partial: false, source: '' }
  }

  // 1. HTML <table>
  if (el.tagName === 'TABLE') {
    const result = parseHtmlTable(el)
    return {
      cells: result.cells,
      headers: result.headers,
      partial: isPartial(el),
      source: 'table',
    }
  }

  // 2. ARIA 表格
  const role = getRole(el)
  if (role === 'grid' || role === 'table') {
    const result = parseAriaTable(el)
    return {
      cells: result.cells,
      headers: result.headers,
      partial: isPartial(el),
      source: 'aria',
    }
  }

  // 3. CSS 假表格
  if (isCssGrid(el)) {
    const result = parseCssGrid(el)
    return {
      cells: result.cells,
      headers: result.headers,
      partial: isPartial(el),
      source: 'grid',
    }
  }

  // 4. 清單（<ul> 或 <ol>）
  if (el.tagName === 'UL' || el.tagName === 'OL') {
    const result = parseList(el)
    return {
      cells: result.cells,
      headers: result.headers,
      partial: isPartial(el),
      source: 'list',
    }
  }

  return { cells: [], headers: [], partial: false, source: '' }
}
