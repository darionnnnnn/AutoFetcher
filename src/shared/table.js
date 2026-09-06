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
  const headers = []
  const dataRows = []

  for (const row of rows) {
    const cells = getRowCells(row)
    if (isHeaderRow(row, cells)) {
      for (const cell of cells) {
        headers.push(cleanText(cell.textContent))
      }
    } else if (cells.length > 0) {
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

// 取得 ARIA 表格的列元素
function getAriaRows(el) {
  if (typeof el.querySelectorAll === 'function') {
    const rows = Array.from(el.querySelectorAll('[role="row"]'))
    if (rows.length > 0) return rows
  }
  return Array.from(el.children || []).filter((child) => getRole(child) === 'row')
}

// 解析 ARIA 表格
function parseAriaTable(el) {
  const rows = getAriaRows(el)
  const headers = []
  const cells = []

  for (const row of rows) {
    let colHeaders = []
    let dataCells = []

    if (typeof row.querySelectorAll === 'function') {
      colHeaders = Array.from(row.querySelectorAll('[role="columnheader"]'))
      dataCells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]'))
    } else {
      const children = Array.from(row.children || [])
      colHeaders = children.filter((child) => getRole(child) === 'columnheader')
      dataCells = children.filter((child) => {
        const role = getRole(child)
        return role === 'cell' || role === 'gridcell'
      })
    }

    if (colHeaders.length > 0) {
      for (const ch of colHeaders) {
        headers.push(cleanText(ch.textContent))
      }
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
