// AutoFetcher 數值擷取策略鏈與後處理
import { parseTable } from './table.js'
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
    const block = opts.block || {}
    const table = parseTable(el)
    if (!table.cells || table.cells.length === 0) {
      return { ok: false, error: 'not_found' }
    }

    let targetIndex = block.index
    let status = 'ok'
    let values = []

    if (block.axis === 'row') {
      // 列模式：直接依 index 取整列
      if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= table.cells.length) {
        return { ok: false, error: 'not_found' }
      }
      values = table.cells[targetIndex]
    } else {
      // 欄模式（col）
      const headerText = typeof block.headerText === 'string' ? block.headerText.trim() : ''
      if (headerText) {
        const foundIndex = (table.headers || []).indexOf(headerText)
        if (foundIndex === -1) {
          return { ok: false, error: 'not_found' }
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

    return {
      ok: true,
      value: agg.value,
      raw,
      status,
      strategyUsed: 'block',
      used: agg.used,
      skipped: agg.skipped,
      partial: Boolean(table.partial)
    }
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
