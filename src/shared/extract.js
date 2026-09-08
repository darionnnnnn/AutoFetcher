// AutoFetcher 數值擷取策略鏈與後處理
import { parseTable, rowHeader, getDataRows } from './table.js'
import { aggregateCells } from './aggregate.js'

const STRATEGY_ORDER = ['auto', 'regex', 'attr', 'child', 'label']

// 取各策略候選字串的函式
function getAutoCandidate(el) {
  return el.textContent
}

function getRegexCandidate(el, spec) {
  if (!spec.regex) return null
  try {
    const match = (el.textContent ?? '').match(new RegExp(spec.regex))
    return match && match[1] !== undefined ? match[1] : null
  } catch {
    return null
  }
}

function getAttrCandidate(el, spec) {
  if (!spec.attr || typeof el.getAttribute !== 'function') return null
  return el.getAttribute(spec.attr)
}

function getChildCandidate(el, spec) {
  if (!spec.childSel || typeof el.querySelector !== 'function') return null
  try {
    const child = el.querySelector(spec.childSel)
    return child ? child.textContent : null
  } catch {
    return null
  }
}

function getLabelCandidate(el, spec) {
  if (!spec.labelText || typeof el.querySelectorAll !== 'function') return null
  const elements = el.querySelectorAll('*')
  for (const node of elements) {
    if (node.textContent && node.textContent.trim() === spec.labelText) {
      return node.nextElementSibling ? node.nextElementSibling.textContent : null
    }
  }
  return null
}

const STRATEGY_HANDLERS = {
  auto: getAutoCandidate,
  regex: getRegexCandidate,
  attr: getAttrCandidate,
  child: getChildCandidate,
  label: getLabelCandidate
}

/**
 * 嘗試單一策略取值並解析為數字
 * @param {string} name - 策略名稱
 * @param {Element} el - DOM 元素
 * @param {object} spec - 規則物件
 * @returns {number|null}
 */
function tryStrategy(name, el, spec) {
  const handler = STRATEGY_HANDLERS[name]
  if (!handler) return null
  const candidate = handler(el, spec)
  if (candidate === null || candidate === undefined) return null
  return parseNumber(candidate)
}

/**
 * 將文字轉換為數字
 * @param {unknown} text - 待轉換字串
 * @returns {number|null}
 */
export function parseNumber(text) {
  if (typeof text !== 'string') return null
  let str = text.trim()
  if (!str) return null

  // 全形數字 ０-９ 轉半形
  str = str.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))

  // 會計負數判斷：整串被小括號包覆（繁中財務頁面常用全形括號，一併認）
  let isAccountingNegative = false
  str = str.replace(/（/g, '(').replace(/）/g, ')')
  const parenMatch = str.match(/^\s*\(([^()]*)\)\s*$/)
  if (parenMatch) {
    isAccountingNegative = true
    str = parenMatch[1]
  }

  // 去除貨幣符號、百分號、逗號
  str = str.replace(/NT\$|[$¥€£元%,]/g, '')

  // 去除數字之間的空白
  str = str.replace(/(\d)\s+(?=\d)/g, '$1')

  // 日期格式（如 09-02、2026-09-02）不視為數值
  if (/^\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?$/.test(str.trim())) {
    return null
  }

  // 抓取第一個數值片段
  const match = str.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null

  let num = Number(match[0])
  if (Number.isNaN(num)) return null

  if (isAccountingNegative) {
    num = -num
  }

  return num === 0 ? 0 : num
}

// 尋找陣列中最接近 preferredIndex 的符合項目索引
function findClosestIndex(array, target, preferredIndex) {
  // 沒帶索引時（只靠表頭定位）從 0 起算距離，否則 NaN 會讓每一次比較都不成立、永遠找不到
  const from = Number.isFinite(Number(preferredIndex)) ? Number(preferredIndex) : 0
  let bestIndex = -1
  let bestDist = Infinity
  for (let i = 0; i < array.length; i++) {
    if (array[i] === target) {
      const dist = Math.abs(i - from)
      if (dist < bestDist) {
        bestDist = dist
        bestIndex = i
      }
    }
  }
  return bestIndex
}

// 取得資料列對應的列標題陣列
function getTableRowHeaders(tableCells, dataRows) {
  const headers = []
  for (let r = 0; r < tableCells.length; r++) {
    const rowEl = dataRows[r]
    headers.push(rowEl ? rowHeader(rowEl) : rowHeader(tableCells[r]))
  }
  return headers
}

// 位置定位：表格每天在最前或最後新增一筆時，用「第幾筆」比用會變動的標題可靠。
// count 是當下的資料列數（或欄數），每次擷取都重算。
export function resolveByPosition(pos, count) {
  if (typeof count !== 'number' || count <= 0) return -1
  if (pos === 'first') return 0
  if (pos === 'last') return count - 1
  if (pos === 'last-1') return count >= 2 ? count - 2 : -1
  return -1
}

// 這個軸是不是用位置定位（有 pos 就不看 index 與 header）
function positionOf(spec) {
  const pos = spec && typeof spec.pos === 'string' ? spec.pos : ''
  return (pos === 'first' || pos === 'last' || pos === 'last-1') ? pos : ''
}

// 依表頭定位索引（欄與列同一套規則：表頭對得上就照用，搬家了跟著表頭走並標記備援）；
// 帶 pos 的軸走位置定位，count 是當下這個軸有幾筆。
function locateByHeader(headers, spec, count) {
  const s = spec || {}
  const pos = positionOf(s)
  if (pos) {
    const index = resolveByPosition(pos, typeof count === 'number' ? count : (headers || []).length)
    if (index < 0) return { ok: false, error: 'not_found', message: positionShortage(pos) }
    return { ok: true, index, status: 'ok', pos }
  }
  const header = typeof s.header === 'string' ? s.header.trim() : ''
  if (!header) {
    return { ok: true, index: s.index, status: 'ok' }
  }
  const foundIndex = findClosestIndex(headers || [], header, s.index)
  if (foundIndex === -1) {
    return { ok: false, error: 'not_found', message: headerGoneMessage(header) }
  }
  return foundIndex === s.index
    ? { ok: true, index: s.index, status: 'ok' }
    : { ok: true, index: foundIndex, status: 'fallback' }
}

// 標題不見時的錯誤訊息要指向解法，不然使用者只看到「找不到」
function headerGoneMessage(header) {
  return `標題「${header}」找不到；若這張表每天新增一列，請到任務設定改用位置定位（第一筆／最後一筆／倒數第二筆）`
}

function positionShortage(pos) {
  const name = pos === 'first' ? '第一筆' : pos === 'last' ? '最後一筆' : '倒數第二筆'
  return `表格的資料筆數不足，取不到${name}`
}

// 位置定位抓到的值要能追溯是哪一列（每天最後一筆會變，光看數字看不出是哪一天）
function labelOf(rowLoc, colLoc, rowHeaders, colHeaders) {
  const parts = []
  if (rowLoc.pos) parts.push((rowHeaders || [])[rowLoc.index] || '')
  if (colLoc.pos) parts.push((colHeaders || [])[colLoc.index] || '')
  const text = parts.filter(Boolean).join(' · ')
  return text || undefined
}

// 從已解析的表格中擷取單一儲存格數值
function extractCellFromTable(table, dataRows, cellSpec, specOpts = {}) {
  if (!cellSpec) {
    return { ok: false, error: 'not_found' }
  }

  // 欄數以最寬的那一列為準（位置定位的「最後一欄」要看實際格數，不是表頭數）
  let colCount = (table.headers || []).length
  for (const row of table.cells) {
    if (row.length > colCount) colCount = row.length
  }
  const colLoc = locateByHeader(table.headers, cellSpec.col, colCount)
  if (!colLoc.ok) return { ok: false, error: 'not_found', message: colLoc.message }

  const rowHeaders = getTableRowHeaders(table.cells, dataRows)
  const rowLoc = locateByHeader(rowHeaders, cellSpec.row, table.cells.length)
  if (!rowLoc.ok) return { ok: false, error: 'not_found', message: rowLoc.message }

  const targetRow = rowLoc.index
  const targetCol = colLoc.index

  if (typeof targetRow !== 'number' || targetRow < 0 || targetRow >= table.cells.length) {
    return { ok: false, error: 'not_found' }
  }
  const rowData = table.cells[targetRow]
  if (typeof targetCol !== 'number' || targetCol < 0 || targetCol >= rowData.length) {
    return { ok: false, error: 'not_found' }
  }

  const status = (colLoc.status === 'fallback' || rowLoc.status === 'fallback') ? 'fallback' : 'ok'
  const raw = rowData[targetCol]
  const parsed = parseNumber(raw)
  if (parsed === null) {
    return { ok: false, error: 'parse_error', raw }
  }

  let value = parsed
  const multiplier = specOpts.multiplier
  if (typeof multiplier === 'number' && Number.isFinite(multiplier)) {
    value = value * multiplier
  }
  const decimals = specOpts.decimals
  if (typeof decimals === 'number' && Number.isFinite(decimals)) {
    value = Number(value.toFixed(decimals))
  }
  if (value === 0) {
    value = 0
  }

  const label = labelOf(rowLoc, colLoc, rowHeaders, table.headers)
  return {
    ok: true,
    value,
    raw,
    status,
    strategyUsed: 'cell',
    ...(label !== undefined ? { label } : {})
  }
}

// 整欄／整列再加上位置＝那一格（「成交金額」× 最後一列）。
// 有位置就沒有東西要聚合，aggregate 一律忽略。
function extractCrossCell(table, block, specOpts, colCount, dataRows) {
  const isRow = block.axis === 'row'
  const cellSpec = isRow
    // 整列 + 位置：列照原本的表頭定位，欄用位置
    ? { row: { index: block.index, header: block.headerText }, col: { pos: block.pos } }
    // 整欄 + 位置：欄照原本的表頭定位，列用位置
    : { row: { pos: block.pos }, col: { index: block.index, header: block.headerText } }
  const res = extractCellFromTable(table, dataRows || [], cellSpec, specOpts)
  if (!res.ok) return res
  return { ...res, used: 1, skipped: 0, strategyUsed: 'block' }
}

// 從已解析的表格中聚合欄或列
function extractBlockFromTable(table, blockSpec, specOpts = {}, dataRows) {
  const block = blockSpec || {}
  let targetIndex = block.index
  let status = 'ok'
  let values = []

  let colCount = (table.headers || []).length
  for (const row of table.cells) {
    if (row.length > colCount) colCount = row.length
  }

  // 這一軸挑好了之後，另一軸還帶著位置＝只要那一格，不是整欄整列聚合
  const crossPos = positionOf(block)
  if (crossPos) {
    return extractCrossCell(table, block, specOpts, colCount, dataRows)
  }

  if (block.axis === 'row') {
    // 列模式：欄與列同一套規則，列標題對得上照用、搬家跟著標題走（AF-8 修：原本只吃 index）
    const rowHeaders = getTableRowHeaders(table.cells, dataRows || [])
    const rowLoc = locateByHeader(rowHeaders, {
      index: targetIndex,
      header: typeof block.headerText === 'string' ? block.headerText : ''
    }, table.cells.length)
    if (!rowLoc.ok) return { ok: false, error: 'not_found', message: rowLoc.message }
    targetIndex = rowLoc.index
    status = rowLoc.status
    if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= table.cells.length) {
      return { ok: false, error: 'not_found' }
    }
    values = table.cells[targetIndex]
  } else {
    // 欄模式（col）
    const headerText = typeof block.headerText === 'string' ? block.headerText.trim() : ''
    if (headerText) {
      const foundIndex = findClosestIndex(table.headers || [], headerText, targetIndex)
      if (foundIndex === -1) {
        return { ok: false, error: 'not_found', message: headerGoneMessage(headerText) }
      }
      if (foundIndex !== targetIndex) {
        targetIndex = foundIndex
        status = 'fallback'
      }
    }

    // 取值：每一列的第 targetIndex 格
    // 超出範圍：若所有列都沒有那一格，回 not_found
    values = []
    for (const row of table.cells) {
      if (targetIndex >= 0 && targetIndex < row.length) {
        values.push(row[targetIndex])
      }
    }
    if (values.length === 0) {
      return { ok: false, error: 'not_found' }
    }
  }

  const agg = aggregateCells(values, block.aggregate)
  const raw = values.join(', ')

  if (agg.value === null) {
    return {
      ok: false,
      error: 'parse_error',
      raw
    }
  }

  let value = agg.value
  const multiplier = specOpts.multiplier
  if (typeof multiplier === 'number' && Number.isFinite(multiplier)) {
    value = value * multiplier
  }
  const decimals = specOpts.decimals
  if (typeof decimals === 'number' && Number.isFinite(decimals)) {
    value = Number(value.toFixed(decimals))
  }
  if (value === 0) {
    value = 0
  }

  return {
    ok: true,
    value,
    raw,
    status,
    strategyUsed: 'block',
    used: agg.used,
    skipped: agg.skipped,
    partial: Boolean(table.partial)
  }
}

/**
 * 從 DOM 元素擷取數值或文字
 * @param {Element} el - 目標 DOM 元素
 * @param {object} [spec={}] - 擷取規則
 * @returns {object} 結果物件
 */
export function extractValue(el, spec = {}) {
  if (!el) {
    return { ok: false, error: 'not_found' }
  }

  const opts = spec || {}

  // 區塊（block）模式：解析表格並聚合指定欄或列，不走數值策略鏈
  if (opts.mode === 'block') {
    const table = parseTable(el)
    if (!table.cells || table.cells.length === 0) {
      return { ok: false, error: 'not_found' }
    }
    const dataRows = getDataRows(el)

    // (b) opts.fields: 一次抓多個值
    if (Array.isArray(opts.fields)) {
      const resultFields = {}
      for (const field of opts.fields) {
        if (!field || !field.key) continue
        const key = field.key
        if (field.cell) {
          const res = extractCellFromTable(table, dataRows, field.cell, field)
          if (res.ok) {
            resultFields[key] = {
              ok: true,
              value: res.value,
              raw: res.raw,
              status: res.status,
              ...(res.label !== undefined ? { label: res.label } : {})
            }
          } else {
            resultFields[key] = {
              ok: false,
              error: res.error,
              ...(res.raw !== undefined ? { raw: res.raw } : {})
            }
          }
        } else if (field.block) {
          const res = extractBlockFromTable(table, field.block, field, dataRows)
          if (res.ok) {
            resultFields[key] = {
              ok: true,
              value: res.value,
              raw: res.raw,
              status: res.status,
              used: res.used,
              skipped: res.skipped,
              ...(res.label !== undefined ? { label: res.label } : {})
            }
          } else {
            resultFields[key] = {
              ok: false,
              error: res.error,
              ...(res.raw !== undefined ? { raw: res.raw } : {})
            }
          }
        } else {
          resultFields[key] = { ok: false, error: 'not_found' }
        }
      }
      return {
        ok: true,
        fields: resultFields,
        partial: Boolean(table.partial)
      }
    }

    const block = opts.block || {}

    // (a) opts.block.cell: 單一儲存格
    if (block.cell) {
      const res = extractCellFromTable(table, dataRows, block.cell, opts)
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          ...(res.raw !== undefined ? { raw: res.raw } : {}),
          ...(res.message !== undefined ? { message: res.message } : {})
        }
      }
      return {
        ok: true,
        value: res.value,
        raw: res.raw,
        status: res.status,
        strategyUsed: 'cell',
        ...(res.label !== undefined ? { label: res.label } : {})
      }
    }

    // (c) opts.block: 現有的欄/列聚合
    return extractBlockFromTable(table, block, opts, dataRows)
  }

  // 文字模式不執行策略鏈
  if (opts.mode === 'text') {
    const original = el.textContent ?? ''
    const trimmed = original.trim()
    if (trimmed) {
      return {
        ok: true,
        value: trimmed,
        raw: trimmed,
        status: 'ok',
        strategyUsed: 'text'
      }
    }
    return {
      ok: false,
      error: 'parse_error',
      raw: original
    }
  }

  const raw = (el.textContent ?? '').trim()
  const primary = opts.strategy || 'auto'

  // 先嘗試指定的主策略
  let parsed = tryStrategy(primary, el, opts)
  let status = 'ok'
  let strategyUsed = primary

  // 主策略失敗則依序備援
  if (parsed === null) {
    for (const name of STRATEGY_ORDER) {
      if (name === primary) continue
      const val = tryStrategy(name, el, opts)
      if (val !== null) {
        parsed = val
        status = 'fallback'
        strategyUsed = name
        break
      }
    }
  }

  // 全部策略皆失敗
  if (parsed === null) {
    return {
      ok: false,
      error: 'parse_error',
      raw
    }
  }

  // 後處理：乘數與小數位四捨五入
  let value = parsed
  if (typeof opts.multiplier === 'number' && Number.isFinite(opts.multiplier)) {
    value = value * opts.multiplier
  }
  if (typeof opts.decimals === 'number' && Number.isFinite(opts.decimals)) {
    value = Number(value.toFixed(opts.decimals))
  }
  if (value === 0) {
    value = 0
  }

  return {
    ok: true,
    value,
    raw,
    status,
    strategyUsed
  }
}
