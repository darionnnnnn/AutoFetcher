// AutoFetcher 區塊型別偵測（選取模式面板與 §7 區塊聚合共用同一份判定）
import { parseNumber } from './extract.js'
import { columnHeaders, innermostTable } from './table.js'

const CELL_SELECTOR = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"]'

// 判定元素是否為表格（HTML table 或 ARIA 表格角色）
function isTableLike(el) {
  if (el.tagName === 'TABLE') return true
  const role = el.getAttribute ? el.getAttribute('role') : null
  return role === 'grid' || role === 'table'
}

// 取得表格的列元素；ARIA 表格可能沒有 tr
function getRows(el) {
  if (typeof el.querySelectorAll !== 'function') return []
  const allRows = Array.from(el.querySelectorAll('tr, [role="row"]'))
  // 只留「這張表自己的」列，排除巢狀小表格的列。
  // 容器是 role="table" 而裡面包著真的 <table> 時，closest 會停在內層那張表，
  // 用它當判準會把每一列都濾掉、列數歸零，所以改成「往上找到的第一張表就是 el 或 el 裡的那一張」。
  const owner = el.tagName === 'TABLE' ? el : (typeof el.querySelector === 'function' ? el.querySelector('table') : null)
  const rows = allRows.filter((row) => {
    if (typeof row.closest !== 'function') return true
    const host = row.closest('table, [role="grid"], [role="table"]')
    return host === el || (owner !== null && host === owner)
  })
  if (rows.length > 0) return rows
  return Array.from(el.children || []).filter(
    (child) => child.getAttribute && child.getAttribute('role') === 'row'
  )
}

// 描述表格：列數、最寬那一列的格子數、表頭文字
function describeTable(el) {
  const rows = getRows(el)
  let cols = 0

  for (const row of rows) {
    if (typeof row.querySelectorAll !== 'function') continue
    const allCells = Array.from(row.querySelectorAll(CELL_SELECTOR))
    const cells = allCells.filter(
      (cell) => typeof cell.closest !== 'function' || cell.closest('tr, [role="row"]') === row
    )
    if (cells.length > cols) cols = cells.length
  }

  return { kind: 'table', rows: rows.length, cols, headers: columnHeaders(el) }
}

/**
 * 判斷一個 DOM 元素屬於哪種型別（表格、清單、假表格、數值或文字）。
 * 判定順序：table → list → grid → number → text。
 * @param {Element} el 要偵測的 DOM 元素
 * @returns {{kind: string, value?: number|null, rows?: number, cols?: number, headers?: string[]}}
 */
export function detectKind(el) {
  if (!el) return { kind: 'text', value: null }

  // 1. 表格：巢狀表格只在純包裝時取內層
  if (isTableLike(el)) {
    return describeTable(innermostTable(el))
  }

  // 2. 清單
  if (el.tagName === 'UL' || el.tagName === 'OL') {
    const items = typeof el.querySelectorAll === 'function' ? el.querySelectorAll('li') : []
    return { kind: 'list', rows: items.length }
  }

  // 3. CSS 假表格：子元素至少 3 個，且每個子元素的子元素數量相同且至少 2 個
  const children = Array.from(el.children || [])
  if (children.length >= 3) {
    const cols = children[0].children ? children[0].children.length : 0
    const uniform = cols >= 2 && children.every((child) => (child.children?.length ?? -1) === cols)
    if (uniform) return { kind: 'grid', rows: children.length, cols }
  }

  // 4. 數值：沿用 extract 的解析（千分位、貨幣、百分號、全形、會計負數）
  const value = parseNumber(el.textContent || '')
  if (value !== null) return { kind: 'number', value }

  // 5. 其餘一律當文字
  return { kind: 'text', value: null }
}
