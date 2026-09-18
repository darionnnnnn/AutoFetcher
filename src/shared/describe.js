// AutoFetcher 白話描述：把任務設定講成一句人話。
// **全站唯一一份**：Picker 摘要卡與儲存回饋、任務頁的排程欄、popup 任務列的 title 都從這裡取，
// 各寫一份會讓同一個任務在三個畫面上長得不一樣（AF-9 定案）。
// 純函式：無 DOM、無 chrome.

import { isAnchorText, skipOf, excludeOf } from './table.js'

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
// 以週一為起點排序：使用者看的是「週一～五」，不是「週日、週一…」
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

/**
 * 星期陣列轉白話。缺省或空陣列一律是「每天」
 * （與 schedule-math.js 的 nextIntervalRun 同一條規則，兩邊不得各判各的）。
 * @param {number[]|undefined} weekdays
 * @returns {string}
 */
export function describeWeekdays(weekdays) {
  if (!Array.isArray(weekdays) || weekdays.length === 0) return '每天'
  const uniq = [...new Set(weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
  if (uniq.length === 0) return '每天'
  if (uniq.length === 7) return '每天'

  const sorted = WEEK_ORDER.filter((d) => uniq.includes(d))
  // 連續三天以上才縮寫成區間，兩天列舉比較好讀（週六、週日）
  const isRun = sorted.every((d, i) => {
    if (i === 0) return true
    return WEEK_ORDER.indexOf(d) === WEEK_ORDER.indexOf(sorted[i - 1]) + 1
  })
  if (isRun && sorted.length >= 3) {
    return `週${WEEKDAY_NAMES[sorted[0]]}～${WEEKDAY_NAMES[sorted[sorted.length - 1]]}`
  }
  return sorted.map((d) => `週${WEEKDAY_NAMES[d]}`).join('、')
}

/**
 * 排程轉白話。
 * daily → 「每日 09:30、15:00，週一～五」
 * interval 有時段 → 「08:30～09:20 之間每 10 分鐘，週一～五」
 * interval 無時段 → 「每 10 分鐘，每天」
 * 其他 → 「未排程」
 * @param {Object} schedule task.schedule
 * @returns {string}
 */
export function describeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return '未排程'
  const days = describeWeekdays(schedule.weekdays)

  if (schedule.type === 'daily') {
    const times = Array.isArray(schedule.times)
      ? schedule.times.filter((t) => typeof t === 'string' && t.trim() !== '')
      : []
    if (times.length === 0) return '未排程'
    return `每日 ${times.join('、')}，${days}`
  }

  if (schedule.type === 'interval') {
    const every = schedule.everyMinutes
    if (typeof every !== 'number' || !Number.isFinite(every) || every <= 0) return '未排程'
    const w = schedule.window
    if (w && w.from && w.to) {
      return `${w.from}～${w.to} 之間每 ${every} 分鐘，${days}`
    }
    return `每 ${every} 分鐘，${days}`
  }

  return '未排程'
}

// 網址取主機名；不合法就原樣回傳（截斷交給 CSS）
function hostOf(url) {
  if (typeof url !== 'string' || url.trim() === '') return ''
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const AGG_TEXT = {
  max: '最大值',
  min: '最小值',
  avg: '平均',
  sum: '加總',
  count: '筆數'
}

// 位置定位的白話（Picker 的值清單也用這一份，不要再抄一張）
export const POS_TEXT = {
  first: '第一筆',
  last: '最後一筆',
  'last-1': '倒數第二筆'
}

// 哪一軸的標題是純數值而**還沒有**改用位置定位（'row' | 'col' | ''）。
// 這是「要不要提示、捷徑鈕指向哪個下拉」的唯一判定，Picker 不得自己再算一份
// （句子叫你改列、按鈕卻指到欄，就是兩份判定各說各話）。
// 已經設了位置定位的軸不再提示：擷取端 pos 先於 header 生效，警語此時是假的、而且永遠關不掉。
export function numericHeaderAxis(cell, rowPos, colPos) {
  const rowH = String(cell?.row?.header || '').trim()
  const colH = String(cell?.col?.header || '').trim()
  if (!rowPos && rowH && !isAnchorText(rowH)) return 'row'
  if (!colPos && colH && !isAnchorText(colH)) return 'col'
  return ''
}

// 標題是純數值時（4318 這種），它可能是鍵也可能只是那一格的資料：擷取端只在它當下唯一出現時
// 才拿來定位，不見了就改以位置抓（`shared/extract.js` 的 locateByHeader）。使用者在畫面上看得到
// 那個數字、系統卻可能默默改用位置，不講的話表格哪天多一列就會抓到別人的資料——選取當下就要說出來。
// 儲存格：指向那一軸的位置定位下拉。整欄／整列：那一軸是使用者自己點的、沒有位置定位可換
// （pos 是給另一軸用的），只說明行為，不給做不到的建議。
function anchorNote(cell, block, rowPos, colPos) {
  const axis = numericHeaderAxis(cell, rowPos, colPos)
  if (axis) {
    const which = axis === 'row' ? '列' : '欄'
    const raw = String(axis === 'row' ? cell.row.header : cell.col.header).trim()
    return `。這一${which}的標題是數字（${raw}），不一定是標題：它還在表上就跟著它，` +
      `不在就改以位置抓；若這張表會新增${which}，請改用「${which}定位」`
  }
  const blockH = String(block?.headerText || '').trim()
  if (blockH && !isAnchorText(blockH)) {
    const which = block?.axis === 'row' ? '列' : '欄'
    return `。這一${which}的標題是數字（${blockH}），不一定是標題：它還在表上就跟著它，不在就照原本的位置抓`
  }
  return ''
}

// 產生略過與排除設定的白話字串，讀值一律經 table.js 的 skipOf／excludeOf
function exclusionNote(block, unit, crossPos, withExclude) {
  if (crossPos) return ''
  const parts = []
  const { head, tail } = skipOf(block)
  if (head > 0 && tail > 0) {
    parts.push(`略過開頭 ${head} ${unit}、結尾 ${tail} ${unit}`)
  } else if (head > 0) {
    parts.push(`略過開頭 ${head} ${unit}`)
  } else if (tail > 0) {
    parts.push(`略過結尾 ${tail} ${unit}`)
  }
  if (withExclude) {
    const excludes = excludeOf(block)
    if (excludes.length > 0) {
      parts.push(`排除 ${excludes.length} ${unit}`)
    }
  }
  if (parts.length === 0) return ''
  return `，${parts.join('、')}`
}

/**
 * `describeTarget` 句中「略過／排除」那一段（含前面的「，」；沒有就是空字串）。
 * 任務頁的模式欄只要這一段，也經它——不得另組一份判斷單位與位置定位的邏輯。
 * @param {Object} target 與 `describeTarget` 同一種輸入
 * @returns {string}
 */
export function exclusionOfTarget(target) {
  const t = target || {}
  if (t.mode !== 'block' || !t.block) return ''
  const crossPos = t.block.axis === 'row' ? t.colPos : t.rowPos
  if (typeof t.fieldCount === 'number' && t.fieldCount >= 2) return exclusionNote(t.block, '筆', crossPos, false)
  if (t.cell) return ''
  return exclusionNote(t.block, t.block.axis === 'row' ? '格' : '列', crossPos, true)
}

/**
 * 只有略過設定的白話（Picker 儲存摘要用：略過是整個任務一份，存了就套到每個整欄整列的值）。
 * @param {{head:number, tail:number}} skip
 * @param {string} unit 列／格／筆
 * @returns {string}
 */
export function skipNote(skip, unit) {
  return exclusionNote({ skip }, unit, '', false)
}

/**
 * 已存的任務 → `describeTarget` 的輸入（任務頁與 popup 共用；Picker 是從表單組，不走這裡）。
 * 多值任務取第一個值（位置定位與略過是任務層級一份）。
 * @param {Object} task
 * @returns {Object}
 */
export function targetOfTask(task) {
  const t = task || {}
  const spec = t.spec || {}
  const fields = Array.isArray(spec.fields) ? spec.fields : []
  // 多值取第一個值；略過是任務層級、只掛在整欄整列的值上，第一個值是儲存格時要往後找第一個 block（否則略過說明整段消失）
  const first = fields.length > 0 ? (fields.find((f) => f && f.block) || fields[0]) : spec.block
  const out = { url: t.url || '', mode: fields.length > 0 ? 'block' : (t.mode || spec.mode || 'number') }
  if (fields.length >= 2) out.fieldCount = fields.length
  if (first && first.cell) {
    out.cell = first.cell
    out.rowPos = first.cell.row?.pos || ''
    out.colPos = first.cell.col?.pos || ''
  } else if (first) {
    const block = first.block || first
    if (block.axis) {
      out.block = block
      // 整欄的 pos 指列、整列的 pos 指欄
      if (block.axis === 'row') out.colPos = block.pos || ''
      else out.rowPos = block.pos || ''
    }
  }
  return out
}

/**
 * 目標轉白話：「抓 www.twse.com.tw 的表格，取「115/09/07 · 成交金額」這一格」
 * @param {Object} target
 * @param {string} [target.url] 目標網址
 * @param {string} [target.mode] 'number' | 'text' | 'block'
 * @param {number} [target.fieldCount] 多值任務的值數量
 * @param {Object} [target.cell] { row: {header}, col: {header} }
 * @param {Object} [target.block] { axis: 'col'|'row', headerText, aggregate }
 * @param {string} [target.rowPos] 列定位
 * @param {string} [target.colPos] 欄定位
 * @returns {string}
 */
export function describeTarget(target) {
  const t = target || {}
  const host = hostOf(t.url)
  const where = host ? `抓 ${host} ` : '抓 '
  const note = t.mode === 'block' ? anchorNote(t.cell, t.block, t.rowPos, t.colPos) : ''

  if (t.mode !== 'block') {
    const kind = t.mode === 'text' ? '文字' : '數字'
    return `${where}頁面上的${kind}`
  }

  const posNote = []
  if (t.rowPos && POS_TEXT[t.rowPos]) posNote.push(`列取${POS_TEXT[t.rowPos]}`)
  if (t.colPos && POS_TEXT[t.colPos]) posNote.push(`欄取${POS_TEXT[t.colPos]}`)
  const posText = posNote.length > 0 ? `，${posNote.join('、')}` : ''

  if (typeof t.fieldCount === 'number' && t.fieldCount >= 2) {
    const exText = exclusionOfTarget(t)
    return `${where}的表格，取 ${t.fieldCount} 個值${exText}${posText}${note}`
  }

  if (t.cell) {
    const rowH = t.cell.row?.header || ''
    const colH = t.cell.col?.header || ''
    const label = withInnerLabel([rowH, colH].filter((x) => x !== '').join(' · '), t.cell.inner)
    if (label !== '') return `${where}的表格，取「${label}」這一格${posText}${note}`
    return `${where}的表格，取其中一格${posText}${note}`
  }

  if (t.block) {
    const isRow = t.block.axis === 'row'
    const axis = isRow ? '整列' : '整欄'
    const exText = exclusionOfTarget(t)
    const header = withInnerLabel(t.block.headerText || '', t.block.inner)
    const agg = t.block.aggregate ? AGG_TEXT[t.block.aggregate] || '' : ''
    const aggText = agg ? `的${agg}` : ''
    if (header !== '') return `${where}的表格，取「${header}」${axis}${aggText}${exText}${posText}${note}`
    return `${where}的表格，取${axis}${aggText}${exText}${posText}${note}`
  }

  return `${where}的表格${posText}${note}`
}

/**
 * 儀表板去處轉白話：「加入「預設儀表板」的數字、折線卡」
 * @param {string} dashboardName 空字串或未選代表不加入
 * @param {string[]} cardTypes
 * @returns {string}
 */
export function describeDashboard(dashboardName, cardTypes) {
  if (!dashboardName) return '不加入儀表板'
  const names = { number: '數字', line: '折線', bar: '長條', table: '表格' }
  const types = Array.isArray(cardTypes) ? cardTypes.map((c) => names[c]).filter(Boolean) : []
  if (types.length === 0) return `加入「${dashboardName}」，尚未選卡片型別`
  return `加入「${dashboardName}」的${types.join('、')}卡`
}

/**
 * 格內子路徑的白話標籤。
 * @param {Array<{tag: string, index: number}>} inner
 * @returns {string}
 */
export function innerLabel(inner) {
  if (!Array.isArray(inner) || inner.length === 0) return ''
  for (const seg of inner) {
    if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return ''
    if (typeof seg.tag !== 'string' || seg.tag.trim() === '') return ''
    if (typeof seg.index !== 'number' || !Number.isInteger(seg.index) || seg.index < 1) return ''
  }
  const last = inner[inner.length - 1]
  const lastTag = last.tag.toLowerCase()
  if (lastTag === 'td' || lastTag === 'th') {
    let lastTr = null
    for (let i = inner.length - 2; i >= 0; i--) {
      if (inner[i].tag && inner[i].tag.toLowerCase() === 'tr') {
        lastTr = inner[i]
        break
      }
    }
    if (lastTr) {
      return `小表第 ${lastTr.index} 列第 ${last.index} 格`
    }
  }
  const suffix = last.index > 1 ? ` ${last.index}` : ''
  return `內層 ${last.tag}${suffix}`
}

/**
 * 既有的名稱文字接上格內標籤（「10.231.1.31 · PORT:443 · 小表第 1 列第 2 格」），空的略過。
 * 七個命名與描述入口的組法只有這一份；沒有子路徑時原樣回傳 base。
 * @param {string} base 既有的名稱文字（可為空字串）
 * @param {unknown} inner 子路徑
 * @returns {string}
 */
export function withInnerLabel(base, inner) {
  return [base, innerLabel(inner)].filter((x) => typeof x === 'string' && x !== '').join(' · ')
}

// interval 的空窗項目（休眠期間略過 N 次）：只能「知道了」，不可補抓
export const isGap = (x) => x?.kind === 'gap'

// gap 的白話（popup、任務頁、儀表板狀態卡共用這一份）：「休眠期間略過 N 次（from～slot）」
export function gapTextOf(item) {
  const from = item?.from || item?.slot || ''
  const to = item?.slot || ''
  const range = from && to && from !== to ? `${from}～${to}` : (to || from)
  return `休眠期間略過 ${Number(item?.count) || 0} 次（${range}）`
}
