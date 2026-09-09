// AutoFetcher 區塊型別偵測（選取模式面板與 §7 區塊聚合共用同一份判定）
import { parseNumber } from './extract.js'
import { columnHeaders, innermostTable, tableRowsOf, rowCellsOf } from './table.js'

// 判定元素是否為表格（HTML table 或 ARIA 表格角色）
function isTableLike(el) {
  if (el.tagName === 'TABLE') return true
  const role = el.getAttribute ? el.getAttribute('role') : null
  return role === 'grid' || role === 'table'
}

// 描述表格：列數、最寬那一列的格子數、表頭文字
function describeTable(el) {
  // 列與格的判準只有 shared/table.js 一份：面板說的規模必須與擷取時解析的一致
  const rows = tableRowsOf(el)
  let cols = 0

  for (const row of rows) {
    const cells = rowCellsOf(row)
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
