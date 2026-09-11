// AutoFetcher 白話描述：把任務設定講成一句人話。
// **全站唯一一份**：Picker 摘要卡與儲存回饋、任務頁的排程欄、popup 任務列的 title 都從這裡取，
// 各寫一份會讓同一個任務在三個畫面上長得不一樣（AF-9 定案）。
// 純函式：無 DOM、無 chrome.

import { isAnchorText } from './table.js'

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
    return `${where}的表格，取 ${t.fieldCount} 個值${posText}${note}`
  }

  if (t.cell) {
    const rowH = t.cell.row?.header || ''
    const colH = t.cell.col?.header || ''
    const label = [rowH, colH].filter((x) => x !== '').join(' · ')
    if (label !== '') return `${where}的表格，取「${label}」這一格${posText}${note}`
    return `${where}的表格，取其中一格${posText}${note}`
  }

  if (t.block) {
    const axis = t.block.axis === 'row' ? '整列' : '整欄'
    const header = t.block.headerText || ''
    const agg = t.block.aggregate ? AGG_TEXT[t.block.aggregate] || '' : ''
    const aggText = agg ? `的${agg}` : ''
    if (header !== '') return `${where}的表格，取「${header}」${axis}${aggText}${posText}${note}`
    return `${where}的表格，取${axis}${aggText}${posText}${note}`
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
