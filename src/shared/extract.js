// AutoFetcher 數值擷取策略鏈與後處理
import {
  parseTable, rowHeader, isAnchorText,
  hasInner, resolveInnerAt, blockRowsOf, gridStartsOf,
  skipOf, excludeOf
} from './table.js'
import { aggregateCells } from './aggregate.js'
import { innerLabel } from './describe.js'

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

// 表頭對得上照用，搬家了跟著表頭走並標記備援；帶 pos 的軸走位置定位，count 是當下這個軸有幾筆。
/**
 * 依表頭定位索引（欄與列同一套規則）。選取模式的 preselect 也用這一份勾回既有的值，
 * 兩邊各寫一份的話，畫面勾到的格子與擷取抓到的格子會不一樣。
 */
export function locateByHeader(headers, spec, count, axis) {
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
  // 純數值的標題（4318 這種）可能是鍵、也可能只是那一格的資料，單看一格分不出來。
  // 規則：**當下唯一出現才拿它定位**（年度欄 2024/2025 插了一欄照樣跟得上、亮黃燈）；
  // 不見了或重複出現（第一欄是 0/1 這種小整數）就視同沒有標題、走 index、狀態 ok
  // ——不見了就硬性失敗的話，單列無表頭的表永遠抓不到；重複還去比對會跳到別列。
  if (!isAnchorText(header)) {
    const hits = (headers || []).filter((h) => h === header).length
    if (hits !== 1) return { ok: true, index: s.index, status: 'ok' }
  }
  const foundIndex = findClosestIndex(headers || [], header, s.index)
  if (foundIndex === -1) {
    return { ok: false, error: 'not_found', message: headerGoneMessage(header, headers, axis) }
  }
  return foundIndex === s.index
    ? { ok: true, index: s.index, status: 'ok' }
    : { ok: true, index: foundIndex, status: 'fallback' }
}

// 標題不見時的錯誤訊息要指向解法，不然使用者只看到「找不到」
function headerGoneMessage(header, currentHeaders, axis) {
  const axisName = axis === 'col' ? '欄' : '列'
  const opening = `標題「${header}」找不到`
  const guide = '若這張表每天新增一列，請到任務設定改用位置定位（第一筆／最後一筆／倒數第二筆）'
  // 只列非空字串的標題
  const valid = (currentHeaders || []).filter((h) => typeof h === 'string' && h.trim() !== '')
  let situation
  if (valid.length === 0) {
    situation = `目前這張表沒有${axisName}標題`
  } else if (valid.length <= 5) {
    situation = `目前這張表的${axisName}標題是：${valid.join('、')}`
  } else {
    situation = `目前這張表的${axisName}標題是：${valid.slice(0, 5).join('、')}…共 ${valid.length} 個`
  }
  return `${opening}；${situation}；${guide}`
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

// 依格內子路徑取指定列欄的文字；「對應到哪個元素」的判定唯一一份在 table.js 的 resolveInnerAt
function resolveInnerCell(dataRows, r, c, inner) {
  const { cell, target } = resolveInnerAt(dataRows ? dataRows[r] : null, c, inner)
  if (!target) return { ok: false, cell }
  return { ok: true, raw: (target.textContent || '').trim(), cell }
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
  const colLoc = locateByHeader(table.headers, cellSpec.col, colCount, 'col')
  if (!colLoc.ok) return { ok: false, error: 'not_found', message: colLoc.message }

  const rowHeaders = getTableRowHeaders(table.cells, dataRows)
  const rowLoc = locateByHeader(rowHeaders, cellSpec.row, table.cells.length, 'row')
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

  let raw
  if (hasInner(cellSpec.inner)) {
    const resolved = resolveInnerCell(dataRows, targetRow, targetCol, cellSpec.inner)
    if (!resolved.ok) {
      // 說出找的是哪個位置（小表第 1 列第 2 格），使用者才對得回畫面
      const where = `這一格裡找不到原本的位置（${innerLabel(cellSpec.inner) || '子路徑'}）`
      let message = where
      if (resolved.cell) {
        const text = (resolved.cell.textContent || '').trim()
        message = text ? `${where}；目前這一格的文字是：${text.slice(0, 40)}` : `${where}；目前這一格是空的`
      }
      return { ok: false, error: 'not_found', message }
    }
    raw = resolved.raw
  } else {
    raw = rowData[targetCol]
  }

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
function extractCrossCell(table, block, specOpts, dataRows) {
  const isRow = block.axis === 'row'
  const cellSpec = isRow
    // 整列 + 位置：列照原本的表頭定位，欄用位置
    ? { row: { index: block.index, header: block.headerText }, col: { pos: block.pos } }
    // 整欄 + 位置：欄照原本的表頭定位，列用位置
    : { row: { pos: block.pos }, col: { index: block.index, header: block.headerText } }
  if (hasInner(block.inner)) {
    cellSpec.inner = block.inner
  }
  const res = extractCellFromTable(table, dataRows || [], cellSpec, specOpts)
  if (!res.ok) return res
  return { ...res, used: 1, skipped: 0, strategyUsed: 'block', partial: Boolean(table.partial) }
}

// 判定清單項目是否為空白格（ok === true 且 raw 為全空白字串）
function isBlankItem(item) {
  return item.ok === true && typeof item.raw === 'string' && /^\s*$/.test(item.raw)
}

// 判定清單項目處置（八態依優先順序判定）
function classifyUse(indexInItems, item, headBlankCount, tailBlankCount, totalCount, head, tail, excludeIndicesToRemove) {
  const strippedEnd = totalCount - tailBlankCount
  const strippedLength = strippedEnd - headBlankCount
  if (headBlankCount > 0 && indexInItems < headBlankCount) {
    return 'trimmed'
  }
  if (tailBlankCount > 0 && indexInItems >= strippedEnd) {
    return 'trimmed'
  }
  // 略過數超過剩餘長度時（那條失敗路徑）下面兩個判斷同樣成立：k < head 是 skipHead、其餘一定 ≥ strippedLength - tail
  const k = indexInItems - headBlankCount
  if (k < head) {
    return 'skipHead'
  }
  if (k >= strippedLength - tail) {
    return 'skipTail'
  }
  if (excludeIndicesToRemove && excludeIndicesToRemove.has(item.index)) {
    return 'excluded'
  }
  if (!item.ok) {
    return 'unresolved'
  }
  if (isBlankItem(item)) {
    return 'blank'
  }
  if (parseNumber(item.raw) === null) {
    return 'nonnumeric'
  }
  return 'used'
}

// 建立逐格處置明細陣列
function buildBlockItems(items, isRow, rowHeaders, colHeaders, headBlankCount, tailBlankCount, head, tail, excludeIndicesToRemove) {
  const totalCount = items.length
  return items.map((it, i) => {
    const use = classifyUse(i, it, headBlankCount, tailBlankCount, totalCount, head, tail, excludeIndicesToRemove)
    const header = isRow
      ? ((colHeaders && colHeaders[it.index]) || '')
      : ((rowHeaders && rowHeaders[it.index]) || '')
    const entry = {
      index: it.index,
      header,
      use
    }
    if (it.ok) {
      entry.raw = it.raw
    }
    if (use === 'used') {
      entry.number = parseNumber(it.raw)
    }
    return entry
  })
}

// 從已解析的表格中聚合欄或列
function extractBlockFromTable(table, blockSpec, specOpts = {}, dataRows) {
  const block = blockSpec || {}
  let targetIndex = block.index
  let status = 'ok'

  // 這一軸挑好了之後，另一軸還帶著位置＝只要那一格，不是整欄整列聚合
  const crossPos = positionOf(block)
  if (crossPos) {
    return extractCrossCell(table, block, specOpts, dataRows)
  }

  const withInner = hasInner(block.inner)
  const isRow = block.axis === 'row'

  let rowHeaders = null
  if (isRow) {
    // 列模式：欄與列同一套規則，列標題對得上照用、搬家跟著標題走（AF-8 修：原本只吃 index）
    rowHeaders = getTableRowHeaders(table.cells, dataRows || [])
    const rowLoc = locateByHeader(rowHeaders, {
      index: targetIndex,
      header: typeof block.headerText === 'string' ? block.headerText : ''
    }, table.cells.length, 'row')
    if (!rowLoc.ok) return { ok: false, error: 'not_found', message: rowLoc.message }
    targetIndex = rowLoc.index
    status = rowLoc.status
    if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= table.cells.length) {
      return { ok: false, error: 'not_found' }
    }
  } else {
    // 欄模式（col）：改用 locateByHeader，判準只維護一份
    const colLoc = locateByHeader(table.headers || [], {
      index: targetIndex,
      header: typeof block.headerText === 'string' ? block.headerText : ''
    }, (table.headers || []).length, 'col')
    if (!colLoc.ok) return { ok: false, error: 'not_found', message: colLoc.message }
    targetIndex = colLoc.index
    status = colLoc.status
    rowHeaders = getTableRowHeaders(table.cells, dataRows || [])
  }

  // 產生有序清單，每項記住另一軸索引與內容
  const items = []
  if (isRow) {
    if (withInner) {
      // 逐「格」不逐「網格欄」：被 colspan 涵蓋的欄是同一格，逐欄走會把它計成解析不到、skipped 虛報
      const rowEl = dataRows ? dataRows[targetIndex] : null
      for (const c of rowEl ? gridStartsOf(rowEl) : []) {
        const resolved = resolveInnerCell(dataRows, targetIndex, c, block.inner)
        if (resolved.ok) {
          items.push({ index: c, ok: true, raw: resolved.raw })
        } else {
          items.push({ index: c, ok: false })
        }
      }
    } else {
      const rowData = table.cells[targetIndex] || []
      for (let c = 0; c < rowData.length; c++) {
        items.push({ index: c, ok: true, raw: rowData[c] })
      }
    }
  } else {
    if (withInner) {
      for (let r = 0; r < table.cells.length; r++) {
        const resolved = resolveInnerCell(dataRows, r, targetIndex, block.inner)
        if (resolved.ok) {
          items.push({ index: r, ok: true, raw: resolved.raw })
        } else {
          items.push({ index: r, ok: false })
        }
      }
    } else {
      for (let r = 0; r < table.cells.length; r++) {
        const row = table.cells[r]
        if (targetIndex >= 0 && targetIndex < row.length) {
          items.push({ index: r, ok: true, raw: row[targetIndex] })
        }
      }
    }
  }

  const initialCount = items.length

  // 本來就沒有格子：維持原本各分支的錯誤
  if (initialCount === 0) {
    if (withInner) {
      const message = isRow
        ? `這一列在目前的頁面上取不到格子（${innerLabel(block.inner) || '子路徑'}）`
        : `這一欄裡找不到原本的位置（${innerLabel(block.inner) || '子路徑'}；0 格都找不到）`
      return { ok: false, error: 'not_found', message }
    }
    return { ok: false, error: 'not_found' }
  }

  // 先套 skip：讀出 head / tail / blank
  const { head, tail, blank } = skipOf(block)

  let headBlankCount = 0
  let tailBlankCount = 0
  if (blank) {
    while (headBlankCount < initialCount && isBlankItem(items[headBlankCount])) {
      headBlankCount++
    }
    if (headBlankCount < initialCount) {
      while (tailBlankCount < (initialCount - headBlankCount) && isBlankItem(items[initialCount - 1 - tailBlankCount])) {
        tailBlankCount++
      }
    }
  }

  const blankCount = headBlankCount + tailBlankCount
  const strippedList = items.slice(headBlankCount, initialCount - tailBlankCount)
  const excludeIndicesToRemove = new Set()
  const buildItems = () => buildBlockItems(items, isRow, rowHeaders, table.headers, headBlankCount, tailBlankCount, head, tail, excludeIndicesToRemove)

  // 剝完之後一格都不剩
  if (blank && strippedList.length === 0) {
    const message = isRow
      ? `這一列的 ${initialCount} 格都是空白格`
      : `這一欄的 ${initialCount} 列都是空白格`
    return {
      ok: false,
      error: 'not_found',
      message,
      items: buildItems()
    }
  }

  // 略過開頭／結尾後沒有剩
  if (head + tail >= strippedList.length) {
    const unit = isRow ? '格' : '列'
    const subject = isRow ? '這一列' : '這一欄'
    const message = blankCount > 0
      ? `略過開頭 ${head} ${unit}、結尾 ${tail} ${unit}後沒有剩下的格子（${subject}去掉頭尾 ${blankCount} ${unit}空白後只有 ${strippedList.length} ${unit}）`
      : `略過開頭 ${head} ${unit}、結尾 ${tail} ${unit}後沒有剩下的格子（${subject}只有 ${initialCount} ${unit}）`
    return {
      ok: false,
      error: 'not_found',
      message,
      items: buildItems()
    }
  }

  let remaining = strippedList
  if (head > 0 || tail > 0) {
    remaining = remaining.slice(head, remaining.length - tail)
  }

  // 再套 exclude：在另一軸上定位並移除
  const excludeList = excludeOf(block)
  const missingExcludeLabels = []
  if (excludeList.length > 0) {
    const otherHeaders = isRow
      ? (table.headers || [])
      : rowHeaders
    const otherCount = isRow
      ? (table.headers || []).length
      : table.cells.length
    const otherAxis = isRow ? 'col' : 'row'

    // 「找得到」＝定位成功，而且那個索引在排除前的完整清單裡。定位成功卻濾不到任何格子的兩種情形都算找不到：
    // 標題是空字串時 locateByHeader 直接回原索引、不檢查範圍（越界）；整列帶 inner 時清單只有每格的網格起點，
    // 排除項指到被 colspan 涵蓋的欄。算成找到的話，狀態 ok、什麼都沒排除，合計就默默被加進去
    const listedIndices = new Set(items.map((it) => it.index))
    for (const item of excludeList) {
      const loc = locateByHeader(otherHeaders, item, otherCount, otherAxis)
      if (loc.ok && listedIndices.has(loc.index)) {
        excludeIndicesToRemove.add(loc.index)
      } else {
        const label = item.header || (isRow ? `第 ${item.index + 1} 格` : `第 ${item.index + 1} 列`)
        missingExcludeLabels.push(label)
      }
    }

    if (excludeIndicesToRemove.size > 0) {
      remaining = remaining.filter((item) => !excludeIndicesToRemove.has(item.index))
    }
  }

  const excluded = strippedList.length - remaining.length

  // 剩下的清單為空（因為 exclude 移光）
  if (remaining.length === 0) {
    return {
      ok: false,
      error: 'not_found',
      // excluded 含 skip 移掉的：只寫「排除」會比使用者設的排除清單還大
      message: `略過與排除共 ${excluded} ${isRow ? '格' : '列'}後沒有剩下的格子`,
      items: buildItems()
    }
  }

  // 剩下清單中「解析不到」的計入 unresolved；其餘進聚合
  let unresolved = 0
  const values = []
  for (const item of remaining) {
    if (item.ok) {
      values.push(item.raw)
    } else {
      unresolved++
    }
  }

  if (values.length === 0) {
    if (withInner) {
      const message = isRow
        ? `這一列裡找不到原本的位置（${innerLabel(block.inner) || '子路徑'}；${unresolved} 格都找不到）`
        : `這一欄裡找不到原本的位置（${innerLabel(block.inner) || '子路徑'}；${unresolved} 格都找不到）`
      return { ok: false, error: 'not_found', message, items: buildItems() }
    }
    return { ok: false, error: 'not_found', items: buildItems() }
  }

  const agg = aggregateCells(values, block.aggregate)
  const raw = values.join(', ')

  if (agg.value === null) {
    return {
      ok: false,
      error: 'parse_error',
      raw,
      items: buildItems()
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

  let finalStatus = status
  let fallbackMessage
  if (missingExcludeLabels.length > 0) {
    finalStatus = 'fallback'
    fallbackMessage = `有 ${missingExcludeLabels.length} 個排除項在目前的頁面找不到（${missingExcludeLabels.join('、')}）`
  }

  return {
    ok: true,
    value,
    raw,
    status: finalStatus,
    strategyUsed: 'block',
    used: agg.used,
    skipped: agg.skipped + unresolved,
    partial: Boolean(table.partial),
    ...(excluded > 0 ? { excluded } : {}),
    ...(blankCount > 0 ? { blank: blankCount } : {}),
    ...(fallbackMessage !== undefined ? { message: fallbackMessage } : {}),
    items: buildItems()
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
    const dataRows = blockRowsOf(el, table.source)

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
              ...(res.raw !== undefined ? { raw: res.raw } : {}),
              ...(res.message !== undefined ? { message: res.message } : {})
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
              ...(res.excluded !== undefined ? { excluded: res.excluded } : {}),
              ...(res.blank !== undefined ? { blank: res.blank } : {}),
              ...(res.message !== undefined ? { message: res.message } : {}),
              ...(res.label !== undefined ? { label: res.label } : {}),
              ...(res.items !== undefined ? { items: res.items } : {})
            }
          } else {
            resultFields[key] = {
              ok: false,
              error: res.error,
              ...(res.raw !== undefined ? { raw: res.raw } : {}),
              ...(res.message !== undefined ? { message: res.message } : {}),
              ...(res.items !== undefined ? { items: res.items } : {})
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
