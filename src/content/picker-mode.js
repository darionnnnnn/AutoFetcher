// 豁免說明：此檔案在網頁 isolated world 執行，網頁未載入 ui/theme.css，
// 因此為全專案唯一允許寫色碼字面值之檔案。所有色碼集中在下方 COLORS 常數，
// 其餘程式碼一律引用 COLORS 的屬性。
import { MSG, MAX_BATCH_TASKS } from '../shared/messages.js'
import { describe } from '../shared/selector.js'
import { detectKind } from '../shared/block-detect.js'
import { parseNumber, resolveByPosition, locateByHeader } from '../shared/extract.js'
import { withInnerLabel } from '../shared/describe.js'
import {
  columnHeaders, rowHeader, innermostTable,
  // 「哪些列／格屬於這張表」的判準只有 shared/table.js 一份（AF-10 作業 D）：
  // 這裡以原本的區域名稱引入，呼叫端一律不變
  CELL_SELECTOR,
  tableOf, cellOf, isHeaderCell,
  cssGridRowsOf,
  gridIndexOf, cellAtGridIndex,
  innerPathOf, resolveInner, hasInner, resolveInnerAt, putInner, gridStartsOf,
  excludeOf, putExclude,
  tableRowsOf as getTableRows,
  rowCellsOf as getRowCells,
  isHeaderRowOf as isHeaderRow
} from '../shared/table.js'

// 顏色常數（對應 theme.css 暗色軌）——這是本檔唯一允許出現色碼字面值的地方
const COLORS = {
  bg: '#0f172a',
  surface: '#1e293b',
  border: '#334155',
  text: '#f8fafc',
  textMuted: '#94a3b8',
  primary: '#3b82f6',
  warn: '#fbbf24',
  ok: '#22c55e',
  danger: '#ef4444'
}

let active = false, currentPurpose = null, currentTaskId = undefined, currentTargetEl = null, backStack = []
// 進不去框架時要說出來；代理層是 iframe 的替身（見 frameOfProxy）
let currentHint = null
let pendingPreselect = null
let overlayEl = null, highlightEl = null, panelEl = null, toolbarEl = null, menuEl = null
// 面板拆兩層：內文每次重建，動作列建一次只更新文字——
// 每次 hover 重建按鈕會把焦點與正在按下的那一顆整個換掉，使用者會覺得「完成鈕點了沒反應」
let panelBodyEl = null, panelDoneEl = null, panelUndoEl = null, panelTrimHeadEl = null, panelTrimTailEl = null
// 「取代」前的已選清單快照：取代是最容易誤觸的動作，要留一步可以反悔
let undoSnapshot = null
// 面板固定在右下角，但游標靠近時要閃到左下角，否則它就擋在使用者要選的內容上
let panelCorner = 'right'
// 換角之後先鎖住，等游標離開面板附近才允許再換（避免沿邊緣移動時來回彈跳）
let panelAvoidLatched = false
let pickMode = 'cell', cellIndex = null, colIndex = null, rowIndex = null, currentDataRows = [], currentRowEl = null, currentCellEl = null
let selectedList = [], maxPicks = 100, limitReached = false, headerChangedNotice = false
// 每格各一個值後是否處於可去頭去尾的狀態
let trimReady = false
// 建立整欄值時自動排除了幾列表尾，等那個值真的加進清單（addPick 成功）才說出來
let pendingFooterNotice = 0
function footerNotice(added) {
  if (added > 0) toolbarNotice = `已自動排除表尾 ${added} 列（合計），右鍵可取消`
}
// 非表格元素被「點一下鎖定」後不再跟著滑鼠跑（檔案總管點一下選取的習慣）
let lockedEl = null
// 換到另一張不相干表格時（已選 ≥2），第一次只提示、再點一次才真的換掉
let replaceConfirmPending
// 取消選取的二段確認狀態（形狀：{ at, count }）
let cancelConfirmPending = null
// Ctrl+A 全選截斷提示狀態（形狀：{ scanned, taken }）
let selectAllNotice = null

// 工具列四段之設定（作用中模式與預告提示共用）
const TOOLS_DEF = [
  { key: 'cell', label: '單格', title: '只選這一格' },
  { key: 'col', label: '整欄→一個值', title: '整欄合成一個數字（加總、平均…）' },
  { key: 'colEach', label: '整欄→每格', title: '這一欄每一格各自是一個值' },
  { key: 'row', label: '整列→一個值', title: '整列合成一個數字' }
]

// 清除表格切換確認與取消確認的暫存狀態
function clearPendingConfirms() {
  replaceConfirmPending = null
  cancelConfirmPending = null
}
// 工具列被點到停用的那一段時要說原因（點不動卻沒訊息是最容易被當成壞掉的）
let toolbarNotice = null
// 這一格內含表格時的警語（面板唯一一份）
const NESTED_CELL_NOTICE = '這一格內含表格，會抓到整串文字；要抓裡面某一格，把滑鼠移到那一格上（只會框那一格）'
// 已選的值換算不到外層表時的說明（↑、觸發 2、整欄→每格三處共用）
const CANNOT_PROMOTE_NOTICE = '已選的值裡有小表的整欄或整列，換不到外層表；要抓外層每一列請先移除它'
// 目標小表只有 1 列、外層不可升級時點整欄的提示（三處共用同一句）
const SINGLE_ROW_NESTED_TABLE_NOTICE = '這張小表只有 1 列，整欄只有 1 格；要跨外層每一列請按 ↑ 切到外層表'
// 單列小表上要整欄、已改選外層那一欄時的說明（AF-18 觸發 1 的四個入口共用）
const promotedColNotice = (n) => `這張小表只有 1 列，已改選外層表這一欄的同一個位置（${n} 格）；只要這一格請切回單格`
// repick 不升到外層的說明（↑、Ctrl 點外層、觸發 2 三處共用）
const REPICK_NO_PROMOTE_NOTICE = '重選既有任務時不能換到外層表（歷史紀錄會接不上）；要抓外層整欄請建立新任務'
// 上一次是否已經在說這句話：面板只在目標改變時重畫，
// hover 換到（或離開）內含表格的格子時要補畫一次，但不能每次 mousemove 都重畫
let nestedNoticeOn = false
// 目標還不是表格時點「整欄／整列」：記下意圖，等滑鼠移到表格上再自動套用。
// 沒有這個的話按鈕當下是停用的，點了完全沒事，使用者卻以為模式已經切好了
let pendingMode = null
// 拖曳框選放開後瀏覽器會補一個 click，接著可能被當成雙擊；短時間內的雙擊要吃掉
let lastDragEndAt = 0
// 指標與表頭提示都是我們加在頁面上的，離開時要原樣還回去
let originalCursor = ''
let titledEls = []
let reduceMotion = false
// 已選的值屬於哪一張表格：滑鼠漂出表格不清空，換到另一張表格才清
let pickedTableEl = null
// 明確選定的表要鎖（按 ↑ / ↓ 選定之表格，滑鼠移動不覆寫）
let deliberateTableEl = null
// 當前滑鼠 hover 的元素（Enter 快速路徑與子單位判定使用）
let currentHoverEl = null
// 當前 hover 格子的子路徑（標示與切換模式使用）
let currentInner = null
let originalUserSelect = '', dragStart = null, isDragging = false, suppressClick = false, menuTargetContext = null
// 批次模式（右鍵「一次建立多個任務」）：每個不同的目標自成一組（＝將來一個任務）。
// 目前這組的值仍放在 selectedList／pickedTableEl（既有判定照原樣運作），其餘的組存在 batchGroups；
// currentGroupIdx 是目前這組在 batchGroups 的位置（還沒寫進去時為 -1）。
// 表格組 { tableEl, picks }、元素組 { el }
let batchMode = false, batchGroups = [], currentGroupIdx = -1
// 各表最後一次 hover 的列欄（送出時非目前這張表的組要用它組 blockInfo，與非批次送出同一口徑）
const batchHover = new Map()
const MAX_BATCH_GROUPS = MAX_BATCH_TASKS
const BATCH_LIMIT_NOTICE = `一次最多建立 ${MAX_BATCH_GROUPS} 個任務；要再加請先完成這一批`
const BATCH_FRAME_NOTICE = '進入框架會離開這一頁的選取；請先完成這一批，再對框架內的內容另開一批'

// detectKind 會掃整棵子樹，而滑鼠每移動一格都要問一次，因此記住最後一次的結果
// （只放「不是表格」的元素，例如滑鼠下的格子；表格走下面以元素為鍵的快取，兩者不再互相逐出）
let kindCacheEl = null, kindCache = null
// 同一張表的衍生資料（型別描述、資料列、最內層表）只算一次（AF-21 批次 7）：
// 以表格元素為鍵，內容變動由觀察器作廢；exitPickMode 整個換新、觀察器全部 disconnect
let tableCache = new WeakMap()
let tableObserver = null
// 觀察器的回呼是非同步的：派發事件後同步讀快取之前，先把還沒送達的變動紀錄收進來
function flushTableMutations() {
  if (tableObserver) invalidateByMutations(tableObserver.takeRecords())
}
// 變動落在哪張表裡，就作廢那張表（與所有包著它的表）的快取
function invalidateByMutations(records) {
  if (!records || records.length === 0) return
  for (const rec of records) {
    let node = rec.target
    while (node) {
      tableCache.delete(node)
      node = node.parentNode
    }
  }
  // 可否升級看的是外層表每一列的小表，任何一張變了都可能改變答案
  upgradeableCache.clear()
  kindCacheEl = null
  kindCache = null
}
// 取得（必要時建立）這張表的快取項，並開始觀察它
function tableEntryOf(el) {
  let entry = tableCache.get(el)
  if (entry) return entry
  entry = {}
  // 觀察器取元素所在文件的那一份（頁面上就是全域那個）；拿不到就不快取，每次照算
  const MO = el?.ownerDocument?.defaultView?.MutationObserver ||
    (typeof MutationObserver === 'function' ? MutationObserver : null)
  if (MO && typeof el.nodeType === 'number') {
    if (!tableObserver) tableObserver = new MO(invalidateByMutations)
    tableObserver.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['role', 'colspan'] })
    tableCache.set(el, entry)
  }
  return entry
}

// 取得元素的型別描述（表格／假表格以元素為鍵快取，其餘同一個元素連續詢問時走單格快取）
function kindOf(el) {
  flushTableMutations()
  const cached = el ? tableCache.get(el) : undefined
  if (cached && cached.kind) return cached.kind
  if (el === kindCacheEl && kindCache) return kindCache
  const kind = detectKind(el)
  if (el && (kind.kind === 'table' || kind.kind === 'grid')) {
    tableEntryOf(el).kind = kind
  } else {
    kindCacheEl = el
    kindCache = kind
  }
  return kind
}

// 最內層表（shared/table.js 的 innermostTable 會掃整表的格子）：同一張表只問一次
function innermostTableCached(el) {
  if (!el || el.tagName !== 'TABLE') return innermostTable(el)
  flushTableMutations()
  const entry = tableEntryOf(el)
  if (!('innermost' in entry)) entry.innermost = innermostTable(el)
  return entry.innermost
}

// 判定是否處於表格模式
function isTableMode(el) {
  if (!el) return false
  const kind = kindOf(el).kind
  return kind === 'table' || kind === 'grid'
}

// 判定儲存格是否屬於指定表格
function cellBelongsToTable(cell, tableEl) {
  return tableOf(cell) === tableEl
}

// 判定這張表是不是在另一張表的格子裡：是的話回外層表 O，否則 null
function outerTableOf(el) {
  if (!el || el.tagName !== 'TABLE' || !el.parentElement) return null
  const O = upgradeTarget(el.parentElement, { deliberate: true })
  if (O && O.tagName === 'TABLE' && O !== el && O.contains(el)) {
    return O
  }
  return null
}

const upgradeableCache = new Map()

// 判定小表 T 是否可升級為外層表 O（同型、重複）
function isUpgradeableTable(T) {
  if (!T || T.tagName !== 'TABLE') return false
  if (upgradeableCache.has(T)) return upgradeableCache.get(T)

  let upgradeable = false
  const O = outerTableOf(T)
  if (O) {
    const info = resolveCell(T, O)
    if (info && info.rIdx !== null && info.cIdx !== null && info.cell) {
      const R = info.rIdx
      const C = info.cIdx
      const dataRows = info.dataRows
      const pathToT = innerPathOf(info.cell, T)
      if (pathToT) {
        const tRows = resolveDataRows(T)
        const tFirstLen = tRows.length > 0 ? getRowCells(tRows[0]).length : 0
        for (let r = 0; r < dataRows.length; r++) {
          if (r === R) continue
          const res = resolveInnerAt(dataRows[r], C, pathToT)
          const x = res.target
          if (x && x.tagName === 'TABLE') {
            const xRows = resolveDataRows(x)
            const xFirstLen = xRows.length > 0 ? getRowCells(xRows[0]).length : 0
            if (xRows.length === tRows.length && xFirstLen === tFirstLen) {
              upgradeable = true
              break
            }
          }
        }
      }
    }
  }

  upgradeableCache.set(T, upgradeable)
  return upgradeable
}

// 目標小表是否只有 1 列
function isSingleRowNestedTable(tableEl) {
  return Boolean(tableEl && outerTableOf(tableEl) && resolveDataRows(tableEl).length === 1)
}

// 把滑鼠下的元素升級成「它所屬的最內層表格」。
// 使用者的直覺是「我點的是這一格」，而擷取規格要的是表格容器 + 列欄索引，
// 兩者之間的轉換只有這一份。只對會挑值的用途升級：前置動作與登入要的是那個元素本身。
function upgradeTarget(el, opts = {}) {
  if (!el) return el
  if (currentPurpose !== 'task' && currentPurpose !== 'repick') return el
  if (typeof el.closest !== 'function') return el
  let upgraded = null
  if (isTableMode(el)) upgraded = el
  if (!upgraded) {
    const cell = el.closest(CELL_SELECTOR)
    if (cell) upgraded = tableOf(cell)
  }
  if (!upgraded) upgraded = tableOf(el)
  // 找不到任何表格＝滑鼠落在頁面的別處（往右上角工具列移動途中經過的段落、空白）。
  // 已經選了值或明確選定表格時不換目標：換掉的話工具列三段會立刻反灰、hover 標示被清掉，
  // 使用者根本走不到工具列去改「單格／整欄／整列」——這就是 P4 回饋的根因。
  // 已選之後按 ↑ 明確切到外層、但值沒有升上去（不可升級、換算不了、repick）時，
  // 鎖的是那張外層表：否則滑鼠一動又被拉回已選的小表，↑ 等於沒按（AF-18 P1）
  const anchor = (selectedList.length > 0 && pickedTableEl)
    ? ((deliberateTableEl && deliberateTableEl !== pickedTableEl && deliberateTableEl.contains(pickedTableEl)) ? deliberateTableEl : pickedTableEl)
    : deliberateTableEl
  if (!upgraded) {
    if (!opts.deliberate && anchor) return anchor
    return el
  }
  // 擷取端（shared/table.js 的 parseTable / getDataRows）對純包裝的外層表會鑽到內層，
  // 選取端不跟著鑽的話，索引以外層算、值以內層取，會靜默抓到別一格（AF-10 作業 D）
  upgraded = innermostTableCached(upgraded)

  // 觸發 2：已選在 T，滑鼠到 O 的別處（用途 task、T 可升級）
  if (!opts.deliberate && anchor && selectedList.length > 0 && anchor === pickedTableEl &&
      currentPurpose === 'task' && isUpgradeableTable(anchor)) {
    const O = outerTableOf(anchor)
    if (O) {
      if (anchor.contains(el) || upgraded === anchor) {
        return anchor
      }
      if (upgraded === O || (O.contains(upgraded) && !upgraded.contains(anchor) && !anchor.contains(upgraded))) {
        return O
      }
    }
  }

  // 已經選了值或明確選定表格就鎖在那張表（AF-10 作業 C）：
  // 巢狀內外層是「同一張表的事」，鎖回已選或選定那張（只擋一個方向的話，內層已選後
  // Ctrl 點外層格子會混進另一張表的索引，再用內層 locator 送出）；
  // **另一張不相干的表**才把目標換過去，讓使用者看得到「可以改點這張」——
  // 但換不換得成要等他真的點下去（滑鼠路過不算）。
  if (!opts.deliberate && anchor && upgraded !== anchor &&
      (anchor.contains(upgraded) || upgraded.contains(anchor))) {
    return anchor
  }
  return upgraded
}

// 取得表格的所有資料列（排除表頭列）
// 同一張表只算一次（快取在 tableCache，表格內容變動才重算）；回傳的陣列是共用的，呼叫端不得改動它
function resolveDataRows(tableEl) {
  if (!tableEl) return []
  const kind = kindOf(tableEl).kind
  const entry = (kind === 'table' || kind === 'grid') ? tableEntryOf(tableEl) : null
  if (entry && entry.dataRows) return entry.dataRows
  // CSS 假表格的列判準也走 shared/table.js 那一份（選取端與解析端不得各寫一份）
  const rows = kind === 'table'
    ? getTableRows(tableEl).filter(r => !isHeaderRow(r))
    : cssGridRowsOf(tableEl)
  if (entry) entry.dataRows = rows
  return rows
}

// 判定列元素是否位於屬於該表格之 tfoot
function isTableFooterRow(row, tableEl) {
  if (!row || !tableEl || typeof row.closest !== 'function') return false
  const tfoot = row.closest('tfoot')
  return Boolean(tfoot && tableOf(tfoot) === tableEl)
}

// 建立整欄 block 時自動排除屬於該表格的 tfoot 列
function withFooterExclude(block, tableEl) {
  if (!block || block.axis !== 'col' || !tableEl || !isTableMode(tableEl)) return 0
  const dataRows = resolveDataRows(tableEl)
  const items = []
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r]
    if (isTableFooterRow(row, tableEl)) {
      items.push({ index: r, header: rowHeader(row) })
    }
  }
  if (items.length > 0) {
    putExclude(block, items)
    return items.length
  }
  return 0
}

// 判定 block 值是否涵蓋指定列與欄索引之儲存格（選單與標示共用）
function blockCoversCell(block, rIdx, cIdx) {
  if (!block || typeof block !== 'object') return false
  if (block.axis === 'col') return block.index === cIdx
  if (block.axis === 'row') return block.index === rIdx
  return false
}

// 判定儲存格是否落在該 block 值的排除清單內（整欄比列索引、整列比欄索引）
function isExcludedCell(block, rIdx, cIdx) {
  if (!blockCoversCell(block, rIdx, cIdx)) return false
  const excludes = excludeOf(block)
  const targetIdx = block.axis === 'col' ? rIdx : cIdx
  return excludes.some(item => item.index === targetIdx)
}

// 元素是否直接擁有非空白文字節點
function ownsText(el) {
  if (!el || !el.childNodes) return false
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i]
    if (node.nodeType === 3 && node.textContent.trim() !== '') {
      return true
    }
  }
  return false
}

// 取得複合格內的子單位元素（非複合格或無子單位回 null）
function subUnitOf(outerCell, el) {
  if (!outerCell || !el || outerCell === el || !outerCell.contains(el)) return null
  if (cellWrapsTable(outerCell)) {
    const sub = cellOf(el)
    if (sub && sub !== outerCell && outerCell.contains(sub)) {
      return sub
    }
    return null
  }
  const textDescendants = Array.from(outerCell.querySelectorAll('*')).filter(ownsText)
  if (textDescendants.length >= 2) {
    let curr = el
    while (curr && curr !== outerCell) {
      if (ownsText(curr)) return curr
      curr = curr.parentElement
    }
  }
  return null
}

// 依網格欄索引與子路徑取得元素（選取端標示與取值共用）
function targetAtGrid(row, c, inner) {
  if (hasInner(inner)) {
    return resolveInnerAt(row, c, inner).target
  }
  return cellAtGridIndex(row, c)
}

// 解析目標所在的資料列與資料欄索引
function resolveCell(target, tableEl) {
  if (!tableEl || !isTableMode(tableEl) || !target) return null
  const isTable = kindOf(tableEl).kind === 'table'
  let row = null, cell = null, dataRows = []
  if (isTable) {
    let curr = target
    while (curr && curr !== tableEl) {
      if (curr.matches && curr.matches(CELL_SELECTOR) && cellBelongsToTable(curr, tableEl)) {
        cell = curr
        break
      }
      curr = curr.parentElement
    }
    if (!cell) return null
    row = cell.closest ? cell.closest('tr, [role="row"]') : null
    if (!row || !tableEl.contains(row)) return null
    dataRows = resolveDataRows(tableEl)
  } else {
    dataRows = Array.from(tableEl.children || [])
    row = dataRows.find(r => r === target || r.contains(target))
    if (!row) return null
    cell = Array.from(row.children || []).find(c => c === target || c.contains(target))
    if (!cell) return null
  }
  let cIdx = gridIndexOf(row, cell)
  if (cIdx < 0) cIdx = null
  let rIdx = dataRows.indexOf(row)
  if (rIdx < 0) rIdx = null
  if (rIdx === null || cIdx === null) return null
  const result = { row, cell, rIdx, cIdx, dataRows }
  const subEl = subUnitOf(cell, target)
  if (subEl) {
    const inner = innerPathOf(cell, subEl)
    if (inner && inner.length > 0) {
      result.subEl = subEl
      result.inner = inner
    }
  }
  return result
}

// 會挑多個值的用途：新任務與重選。前置動作與登入一次只選一個元素，維持點一下就送出。
function isMultiPickPurpose() {
  return currentPurpose === 'task' || currentPurpose === 'repick'
}

// 滑鼠下的是表頭格嗎？表頭列的 th ＝ 整欄，資料列的 th（列標題）＝ 整列。
// 試算表點欄標題選整欄、點列首選整列是共通習慣，這是它的唯一一份判定。
function resolveHeaderTarget(target, tableEl) {
  if (!tableEl || !isTableMode(tableEl) || !target || typeof target.closest !== 'function') return null
  const cell = target.closest(CELL_SELECTOR)
  if (!cell || !cellBelongsToTable(cell, tableEl) || !isHeaderCell(cell)) return null
  const row = cell.closest('tr, [role="row"]')
  if (!row || !tableEl.contains(row)) return null
  if (isHeaderRow(row)) {
    const cIdx = gridIndexOf(row, cell)
    if (cIdx < 0) return null
    return { axis: 'col', index: cIdx, headerText: columnHeaders(tableEl)[cIdx] || (cell.textContent || '').trim() }
  }
  const dataRows = resolveDataRows(tableEl)
  const rIdx = dataRows.indexOf(row)
  if (rIdx < 0) return null
  return { axis: 'row', index: rIdx, headerText: rowHeader(row) }
}

// 計算外層表 O 在指定網格欄與子路徑下成功解析到的列數
function countResolvedInnerInCol(O, cIdx, inner) {
  const dataRows = resolveDataRows(O)
  let count = 0
  for (const row of dataRows) {
    if (targetAtGrid(row, cIdx, inner) !== null) {
      count++
    }
  }
  return count
}

// 把目前整份已選清單換成外層表 O 的座標（只有一份）
function promotePicksToOuter(T) {
  const O = outerTableOf(T)
  if (!O) return false
  const info = resolveCell(T, O)
  if (!info || info.rIdx === null || info.cIdx === null || !info.cell) return false
  const R = info.rIdx
  const C = info.cIdx
  const oCell = info.cell
  const oDataRows = info.dataRows
  const oHeaders = columnHeaders(O)
  const tDataRows = resolveDataRows(T)

  const newPicks = []
  for (const pick of selectedList) {
    if (pick.cell) {
      const r = pick.cell.row ? pick.cell.row.index : null
      const c = pick.cell.col ? pick.cell.col.index : null
      if (typeof r !== 'number' || typeof c !== 'number' || !tDataRows[r]) return false
      const el = targetAtGrid(tDataRows[r], c, pick.cell.inner)
      if (!el) return false
      const inner = innerPathOf(oCell, el)
      if (!inner) return false
      const cell = {
        row: { index: R, header: rowHeader(oDataRows[R]) },
        col: { index: C, header: oHeaders[C] || '' }
      }
      putInner(cell, inner)
      newPicks.push({ cell })
    } else if (pick.block) {
      if (pick.block.axis !== 'col' || tDataRows.length !== 1) return false
      const c = pick.block.index
      if (typeof c !== 'number') return false
      const el = targetAtGrid(tDataRows[0], c, pick.block.inner)
      if (!el) return false
      const inner = innerPathOf(oCell, el)
      if (!inner) return false
      const block = {
        axis: 'col',
        index: C,
        headerText: oHeaders[C] || ''
      }
      putInner(block, inner)
      withFooterExclude(block, O)
      newPicks.push({ block })
    } else {
      return false
    }
  }

  const previous = takeUndoSnapshot(selectedList, T)
  clearPickedMarks(document)
  selectedList = newPicks
  pickedTableEl = O
  setTarget(O)
  deliberateTableEl = O
  undoSnapshot = previous
  batchHover.delete(T)
  if (batchMode) syncBatch()
  applyPickedMarks(O)
  return true
}

// 觸發 2（只有這一份）：已選在小表 T、目標是它可升級的外層 O 時，加值之前先把已選換到外層。
// 回傳 'none'（不適用）／'promoted'（換好了，呼叫端照原語意加值）／'blocked'（換算不了，已說明原因，呼叫端不得加值）
function promoteBeforeAddingInOuter() {
  if (currentPurpose !== 'task' || selectedList.length === 0 || !pickedTableEl || currentTargetEl === pickedTableEl) return 'none'
  if (!isUpgradeableTable(pickedTableEl) || outerTableOf(pickedTableEl) !== currentTargetEl) return 'none'
  if (promotePicksToOuter(pickedTableEl)) return 'promoted'
  toolbarNotice = CANNOT_PROMOTE_NOTICE
  applyPickedMarks(pickedTableEl)
  if (panelEl) updatePanel(panelEl, currentTargetEl)
  return 'blocked'
}

// 批次模式所有的組（依建立順序），目前這組以 selectedList／pickedTableEl 的現況代入；值被移光的組不列出。
// 不改動任何狀態（畫面與計數用）；回傳的目前這組其 picks 就是 selectedList 本身
function batchGroupsView() {
  if (!batchMode) return []
  const live = (selectedList.length > 0 && pickedTableEl) ? { tableEl: pickedTableEl, picks: selectedList } : null
  const out = []
  batchGroups.forEach((g, i) => {
    if (i !== currentGroupIdx) out.push(g)
    else if (live) out.push(live)
  })
  if (currentGroupIdx < 0 && live) out.push(live)
  return out
}

// 把目前這組的現況寫回 batchGroups（移光的組拿掉），之後 batchGroups 的序號就是畫面上的組序號
function syncBatch() {
  if (!batchMode) return
  const view = batchGroupsView()
  currentGroupIdx = view.findIndex(g => g.picks === selectedList)
  batchGroups = view.map(g => g.el ? g : { tableEl: g.tableEl, picks: g.picks.slice() })
  // 同一張表只能是一組：小表那組升到外層之後，外層若本來就有一組要併進去，
  // 否則會建出兩個定位相同的任務（AF-18 G-1 實作回報抓到）
  const cur = currentGroupIdx >= 0 ? batchGroups[currentGroupIdx] : null
  const dup = cur && !cur.el ? batchGroups.findIndex((g, i) => i !== currentGroupIdx && !g.el && g.tableEl === cur.tableEl) : -1
  if (dup >= 0) {
    const merged = batchGroups[dup].picks.slice()
    for (const p of cur.picks) if (!merged.some(m => samePick(m, p))) merged.push(p)
    batchGroups[dup] = { tableEl: cur.tableEl, picks: merged.slice() }
    batchGroups.splice(currentGroupIdx, 1)
    currentGroupIdx = dup > currentGroupIdx ? dup - 1 : dup
    selectedList = merged
    limitReached = selectedList.length >= maxPicks
  }
}

function batchValueTotal(groups) {
  return groups.reduce((n, g) => n + (g.el ? 1 : g.picks.length), 0)
}

// 讓某一組成為目前這組（表格組才會；元素組沒有「目前」）
function loadBatchGroup(i) {
  const g = batchGroups[i]
  if (!g || g.el) return
  selectedList = g.picks.slice()
  pickedTableEl = g.tableEl
  currentGroupIdx = i
  limitReached = selectedList.length >= maxPicks
  trimReady = false
  clearPendingConfirms()
}

/**
 * 批次模式的「換表」：目標表與目前這組的表不相干時，不取代、不要求確認，
 * 改為切到那張表的組（沒有就開新的一組）。回傳 false 表示組數已滿、已說明，呼叫端不得加值。
 * 非批次模式一律回 true（什麼都不做）。
 */
function batchFollowTarget(tableEl) {
  if (!batchMode || !tableEl || !isTableMode(tableEl) || pickedTableEl === tableEl) return true
  syncBatch()
  const at = batchGroups.findIndex(g => g.tableEl === tableEl)
  if (at >= 0) {
    loadBatchGroup(at)
    return true
  }
  // 點的是某一組的「同一張外層表」底下的另一張小表（或外層自己）：回到那一組並升到外層，
  // 不得各開一組——切過別的組之後鎖表的 anchor 已經換人，觸發 2 不會自己發生（體檢抓到：監控頁會變成一列一個任務）
  const O = outerTableOf(tableEl)
  const kin = batchGroups.findIndex(g => !g.el && g.tableEl && (
    (O && g.tableEl === O) ||
    (isUpgradeableTable(g.tableEl) && (outerTableOf(g.tableEl) === tableEl || (O && outerTableOf(g.tableEl) === O)))))
  if (kin >= 0) {
    const kinTable = batchGroups[kin].tableEl
    loadBatchGroup(kin)
    const outer = kinTable === O || kinTable === tableEl ? kinTable : outerTableOf(kinTable)
    if (kinTable === outer || promotePicksToOuter(kinTable)) {
      if (currentTargetEl !== outer) setTarget(outer)
      deliberateTableEl = outer
      return true
    }
    // 換算不了（那一組有小表的整欄／整列值）：照舊各自成組
    syncBatch()
  }
  if (batchGroups.length >= MAX_BATCH_GROUPS) {
    toolbarNotice = BATCH_LIMIT_NOTICE
    applyPickedMarks(pickedTableEl)
    return false
  }
  selectedList = []
  pickedTableEl = null
  currentGroupIdx = -1
  limitReached = false
  trimReady = false
  clearPendingConfirms()
  return true
}

// 整組移除（存復原快照）
function removeBatchGroup(i) {
  syncBatch()
  if (i < 0 || i >= batchGroups.length) return
  const previous = takeUndoSnapshot(selectedList, pickedTableEl)
  if (i === currentGroupIdx) {
    selectedList = []
    pickedTableEl = null
    limitReached = false
    trimReady = false
    currentGroupIdx = -1
  } else if (i < currentGroupIdx) {
    currentGroupIdx--
  }
  batchGroups.splice(i, 1)
  undoSnapshot = previous
  applyPickedMarks(pickedTableEl)
  if (panelEl) updatePanel(panelEl, currentTargetEl)
}

// 非表格元素：已是某一組就移除那一組，否則新增一組
function toggleElementGroup(el) {
  syncBatch()
  const at = batchGroups.findIndex(g => g.el === el)
  if (at >= 0) {
    removeBatchGroup(at)
    return
  }
  if (batchGroups.length >= MAX_BATCH_GROUPS) {
    toolbarNotice = BATCH_LIMIT_NOTICE
  } else {
    clearUndoSnapshot()
    batchGroups.push({ el })
  }
  applyPickedMarks(pickedTableEl)
  if (panelEl) updatePanel(panelEl, currentTargetEl)
}

// 整欄／整列模式點到非表格的說明（送出、點擊、批次三處共用）
function nonTableModeNotice() {
  return `${pickMode === 'row' ? '整列' : '整欄'}只能在表格上選，先把滑鼠移到表格；要抓這個元素請切回「單格」`
}

// 批次模式點到非表格元素：整欄／整列模式照現有規則拒絕並說明，否則切換那一組
function batchClickElement(el) {
  // 點在頁面空白處（body）不是要抓整個頁面
  if (!el || el === document.body || el === document.documentElement) {
    toolbarNotice = '點在頁面空白處了：把滑鼠移到要抓的數字或表格上再點'
    if (panelEl) updatePanel(panelEl, currentTargetEl)
    return
  }
  if (pickMode === 'col' || pickMode === 'colEach' || pickMode === 'row') {
    toolbarNotice = nonTableModeNotice()
    if (panelEl) updatePanel(panelEl, currentTargetEl)
    return
  }
  toggleElementGroup(el)
}

// 批次模式已有組時不得鑽進框架（會丟掉這一批）；擋下時回 true
function batchBlocksDescend() {
  if (!batchMode || batchGroupsView().length === 0) return false
  toolbarNotice = BATCH_FRAME_NOTICE
  if (panelEl) updatePanel(panelEl, currentTargetEl)
  return true
}

// 把滑鼠下的位置換算成「點下去會選到什麼」，點擊與雙擊共用同一份
function candidateAt(target) {
  // 候選值只記待提示數：點下去可能是 Ctrl 取消、或與已選重複，那時不能說「已自動排除表尾」
  pendingFooterNotice = 0
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return null
  const head = resolveHeaderTarget(target, currentTargetEl)
  if (head) {
    const block = { axis: head.axis, index: head.index, headerText: head.headerText }
    pendingFooterNotice = withFooterExclude(block, currentTargetEl)
    return { block }
  }
  const info = resolveCell(target, currentTargetEl)
  if (!info) return null
  if (pickMode === 'col') {
    if (currentPurpose === 'task' && isSingleRowNestedTable(currentTargetEl) && isUpgradeableTable(currentTargetEl)) {
      const O = outerTableOf(currentTargetEl)
      if (O) {
        const oInfo = resolveCell(currentTargetEl, O)
        if (oInfo && oInfo.cell && oInfo.cIdx !== null) {
          const C = oInfo.cIdx
          const oCell = oInfo.cell
          const subEl = info.subEl || info.cell || target
          const fullInner = innerPathOf(oCell, subEl)
          const block = { axis: 'col', index: C, headerText: columnHeaders(O)[C] || '' }
          putInner(block, fullInner)
          pendingFooterNotice = withFooterExclude(block, O)
          return { block }
        }
      }
    }
    const block = { axis: 'col', index: info.cIdx, headerText: columnHeaders(currentTargetEl)[info.cIdx] || '' }
    putInner(block, info.inner)
    pendingFooterNotice = withFooterExclude(block, currentTargetEl)
    return { block }
  }
  if (pickMode === 'row') {
    const block = { axis: 'row', index: info.rIdx, headerText: info.row ? rowHeader(info.row) : '' }
    putInner(block, info.inner)
    return { block }
  }
  return makeCellPick(info.rIdx, info.cIdx, currentTargetEl, info.dataRows, info.inner)
}

// 清除所有標記為待選之表格格子
// 只清自己畫過的（markedCellEls），不掃全文件（AF-21 批次 7）
function clearMarkedCells(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d) return
  const marked = markedCellEls
  markedCellEls = new Set()
  for (const cell of marked) {
    if (!cell.hasAttribute('data-af-cell')) continue
    cell.removeAttribute('data-af-cell')
    if (cell.hasAttribute('data-af-picked')) {
      cell.style.outline = `2px solid ${COLORS.primary}`
    } else if (cell.hasAttribute('data-af-excluded')) {
      cell.style.outline = `2px dashed ${COLORS.warn}`
    } else {
      cell.style.outline = ''
    }
  }
}

// 標示待選格、欄或列之資料格
function markCells(cell, dataRows, row, mode, cIdx, inner) {
  clearMarkedCells(document)
  if (mode === 'cell') {
    // 子單位以呼叫端算好的 inner 為準（與 pick 同一份），不在這裡用 hover 元素再判一次：
    // 兩份輸入不同步時（Shift＋方向鍵移到下一格）會框整格、卻選了格內子元素
    const targetCell = hasInner(inner) ? (row ? targetAtGrid(row, cIdx, inner) : null) : cell
    if (targetCell && !isHeaderCell(targetCell)) {
      targetCell.setAttribute('data-af-cell', '')
      markedCellEls.add(targetCell)
      targetCell.style.outline = `2px solid ${COLORS.warn}`
      targetCell.style.transition = markTransition()
    }
  } else if ((mode === 'col' || mode === 'colEach') && cIdx !== null && cIdx >= 0 && dataRows) {
    for (const dRow of dataRows) {
      const targetCell = targetAtGrid(dRow, cIdx, inner)
      if (targetCell && !isHeaderCell(targetCell)) {
        targetCell.setAttribute('data-af-cell', '')
        markedCellEls.add(targetCell)
        targetCell.style.outline = `2px solid ${COLORS.warn}`
      }
    }
  } else if (mode === 'row' && row) {
    for (const c of getRowCells(row)) {
      const idx = gridIndexOf(row, c)
      const targetCell = targetAtGrid(row, idx, inner)
      if (targetCell && !isHeaderCell(targetCell)) {
        targetCell.setAttribute('data-af-cell', '')
        markedCellEls.add(targetCell)
        targetCell.style.outline = `2px solid ${COLORS.warn}`
      }
    }
  }
}

// 這一格裡面自己包著一張表格嗎？
// 這種格子的文字是內層小表整串接起來的（25530+39806 → 2553039806），
// 解析出的數字只是碰巧排在最前面的那一個。抓得到值、但值是錯的，
// 是看不見的錯誤——所以在面板上先說出來（AF-10 作業 D）。
function cellWrapsTable(cell) {
  return Boolean(cell && typeof cell.querySelector === 'function' && cell.querySelector('table, [role="grid"], [role="table"]'))
}

/**
 * 清掉保留中的標示。
 * @param {Document} doc 文件
 * @param {string|null} purpose 只清這個用途的；不給就全清
 */
function clearHeldMarks(doc, purpose) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || typeof d.querySelectorAll !== 'function') return
  const sel = purpose ? `[data-af-held="${purpose}"]` : '[data-af-held]'
  for (const el of d.querySelectorAll(sel)) {
    el.removeAttribute('data-af-held')
    el.removeAttribute('data-af-picked')
    el.removeAttribute('data-af-excluded')
    el.style.outline = ''
  }
}

// 已選標示的狀態位元：P＝data-af-picked、X＝data-af-excluded（兩者可並存：先被別組排除、再被另一組選到）
const MARK_P = 1, MARK_X = 2
// 自己畫過的標示（AF-21 批次 7）：清理只清這些，不做全文件查詢
let markedCellEls = new Set()
let pickedMarkEls = new Map()
let chipHoverEls = new Set()

// 記下 chip 懸停加粗的格子（清理時只清這些）
function trackChipHover(cell) {
  chipHoverEls.add(cell)
}

// 收掉 chip 懸停的加粗外框；回傳這次真的被還原外框的格子
function clearChipHoverMarks() {
  const restored = new Set()
  const els = chipHoverEls
  chipHoverEls = new Set()
  for (const cell of els) {
    if (!cell.hasAttribute('data-af-chip-hover')) continue
    if (cell._afHoverTimer) {
      clearTimeout(cell._afHoverTimer)
      delete cell._afHoverTimer
    }
    cell.removeAttribute('data-af-chip-hover')
    if (cell._afPrevOutline !== undefined) {
      cell.style.outline = cell._afPrevOutline
      delete cell._afPrevOutline
    }
    restored.add(cell)
  }
  return restored
}

// 拿掉一格的已選／排除標示（保留中的標示不動：它們的出口是 EXIT_PICK 或下一次同用途的 ENTER_PICK）
function unmarkPicked(cell) {
  if (cell.hasAttribute('data-af-held')) return
  for (const attr of ['data-af-picked', 'data-af-excluded']) {
    if (!cell.hasAttribute(attr)) continue
    cell.removeAttribute(attr)
    if (cell.hasAttribute('data-af-cell')) {
      cell.style.outline = `2px solid ${COLORS.warn}`
    } else {
      cell.style.outline = ''
    }
  }
}

// 把一格畫成指定狀態（與舊版「全清再依序畫」的最終結果相同：待選格維持待選色，其餘看最後一次是選還是排除）
function writePickedMark(cell, state) {
  if (state & MARK_P) {
    if (!cell.hasAttribute('data-af-picked')) cell.setAttribute('data-af-picked', '')
  } else if (cell.hasAttribute('data-af-picked')) {
    cell.removeAttribute('data-af-picked')
  }
  if (state & MARK_X) {
    if (!cell.hasAttribute('data-af-excluded')) cell.setAttribute('data-af-excluded', '')
  } else if (cell.hasAttribute('data-af-excluded')) {
    cell.removeAttribute('data-af-excluded')
  }
  if (cell.hasAttribute('data-af-cell')) {
    cell.style.outline = `2px solid ${COLORS.warn}`
  } else {
    cell.style.outline = (state & MARK_P) ? `2px solid ${COLORS.primary}` : `2px dashed ${COLORS.warn}`
  }
}

// 標示是否已經是這個狀態（別的程式碼拿掉了屬性就要重畫）
function markMatches(cell, state) {
  return cell.hasAttribute('data-af-picked') === Boolean(state & MARK_P) &&
    cell.hasAttribute('data-af-excluded') === Boolean(state & MARK_X)
}

// 清除所有已選標記
function clearPickedMarks(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d) return
  clearChipHoverMarks()
  const els = pickedMarkEls
  pickedMarkEls = new Map()
  for (const cell of els.keys()) unmarkPicked(cell)
}

// 目前這組以外的組（批次模式）
function otherBatchGroups() {
  return batchGroupsView().filter(g => g.picks !== selectedList)
}

// 重新在表格上貼回已選標記（批次模式時每一組都畫）。
// 只對「上一次畫的」與「這一次該畫的」差集增刪（AF-21 批次 7）：hover 換欄時已選的 20 格不會全拆再全畫
function applyPickedMarks(tableEl) {
  const restored = clearChipHoverMarks()
  const next = new Map()
  collectPickMarks(next, tableEl, selectedList)
  if (batchMode) {
    for (const g of otherBatchGroups()) {
      if (g.el) {
        next.set(g.el, (next.get(g.el) || 0) | MARK_P)
      } else {
        collectPickMarks(next, g.tableEl, g.picks)
      }
    }
  }
  for (const cell of pickedMarkEls.keys()) {
    if (!next.has(cell)) unmarkPicked(cell)
  }
  for (const [cell, state] of next) {
    if (pickedMarkEls.get(cell) !== state || restored.has(cell) || !markMatches(cell, state)) {
      writePickedMark(cell, state)
    }
  }
  pickedMarkEls = next
}

// 取得一個 pick 所涵蓋的所有格子元素
function cellsOfPick(tableEl, pick, rows) {
  if (!tableEl || !isTableMode(tableEl) || !pick) return []
  const dataRows = rows || resolveDataRows(tableEl)
  const cells = []
  if (pick.cell) {
    const row = dataRows[pick.cell.row.index]
    if (row) {
      const cell = targetAtGrid(row, pick.cell.col.index, pick.cell.inner)
      if (cell && !isHeaderCell(cell)) {
        cells.push(cell)
      }
    }
  } else if (pick.block) {
    if (pick.block.axis === 'col') {
      for (let r = 0; r < dataRows.length; r++) {
        if (isExcludedCell(pick.block, r, pick.block.index)) continue
        const cell = targetAtGrid(dataRows[r], pick.block.index, pick.block.inner)
        if (cell && !isHeaderCell(cell)) {
          cells.push(cell)
        }
      }
    } else if (pick.block.axis === 'row') {
      const row = dataRows[pick.block.index]
      if (row) {
        for (const c of getRowCells(row)) {
          const idx = gridIndexOf(row, c)
          if (isExcludedCell(pick.block, pick.block.index, idx)) continue
          const cell = targetAtGrid(row, idx, pick.block.inner)
          if (cell && !isHeaderCell(cell)) {
            cells.push(cell)
          }
        }
      }
    }
  }
  return cells
}

// 算出一組已選值該畫的標示（先全部標成已選、再把排除項改成排除；順序與舊版逐格畫相同）
function collectPickMarks(marks, tableEl, picks) {
  if (!tableEl || !isTableMode(tableEl)) return
  const dataRows = resolveDataRows(tableEl)
  const pick1 = (cell) => marks.set(cell, (marks.get(cell) || 0) | MARK_P)
  const exclude1 = (cell) => marks.set(cell, ((marks.get(cell) || 0) & ~MARK_P) | MARK_X)
  for (const pick of picks) {
    for (const cell of cellsOfPick(tableEl, pick, dataRows)) pick1(cell)
  }

  for (const pick of picks) {
    if (pick.block) {
      const excludes = excludeOf(pick.block)
      if (pick.block.axis === 'col') {
        for (const item of excludes) {
          const row = dataRows[item.index]
          if (row) {
            const cell = targetAtGrid(row, pick.block.index, pick.block.inner)
            if (cell && !isHeaderCell(cell)) exclude1(cell)
          }
        }
      } else if (pick.block.axis === 'row') {
        const row = dataRows[pick.block.index]
        if (row) {
          for (const item of excludes) {
            const cell = targetAtGrid(row, item.index, pick.block.inner)
            if (cell && !isHeaderCell(cell)) exclude1(cell)
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
  let name = '目標'
  if (pick.cell) {
    const r = pick.cell.row ? pick.cell.row.header : ''
    const c = pick.cell.col ? pick.cell.col.header : ''
    if (r && c) name = `${r} · ${c}`
    else name = r || c || '儲存格'
  } else if (pick.block) {
    name = pick.block.headerText || (pick.block.axis === 'col' ? '整欄' : '整列')
  }
  // 名稱接格內標籤只有 describe.js 的 withInnerLabel 一份（與七個命名入口同源）
  return withInnerLabel(name, (pick.cell && pick.cell.inner) || (pick.block && pick.block.inner))
}

// iframe 的 src 一律轉成絕對網址:background 拿它跟 frame 的 location.href 比對，
// 送相對路徑過去 new URL() 會拋，結果是永遠「無法進入此框架」
function frameSrcOf(frameEl) {
  const raw = frameEl?.getAttribute?.('src') || ''
  try {
    return new URL(raw, document?.baseURI).href
  } catch {
    return raw
  }
}

// iframe 的代理層:滑鼠移到 <iframe> 上時事件由 iframe 自己的文件接走，
// 最上層永遠 hover 不到那個元素，所以在它上面貼一層可以指到的替身。
function frameOfProxy(el) {
  return el && el.getAttribute && el.getAttribute('data-af-frame-proxy') !== null ? el.__afFrame || null : null
}

// 目標是 iframe（或它的代理層）時，回傳那個 iframe，否則 null
function iframeOf(el) {
  if (!el) return null
  const viaProxy = frameOfProxy(el)
  if (viaProxy) return viaProxy
  return el.tagName === 'IFRAME' ? el : null
}

const PROXY_SYNC_MS = 250
let lastProxySync = 0
// 代理層讓路給哪一個頁面元素（null = 沒有讓路）
let yieldedEl = null

// 把代理層貼回它代表的那個 iframe 當下的位置（建立時與滑鼠移動時各一次，唯一一份）。
// lazy layout 常在進入選取模式之後才把 iframe 推開，只在建立時算一次會凍在舊位置。
function syncProxyRect(proxy) {
  const frame = proxy && proxy.__afFrame
  if (!frame) return
  const rect = typeof frame.getBoundingClientRect === 'function' ? frame.getBoundingClientRect() : null
  const sx = (typeof window !== 'undefined' && (window.scrollX || window.pageXOffset)) || 0
  const sy = (typeof window !== 'undefined' && (window.scrollY || window.pageYOffset)) || 0
  proxy.style.left = `${(rect?.left || 0) + sx}px`
  proxy.style.top = `${(rect?.top || 0) + sy}px`
  proxy.style.width = `${rect?.width || 0}px`
  proxy.style.height = `${rect?.height || 0}px`
}

function allProxies() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return []
  return [...document.querySelectorAll('[data-af-frame-proxy]')]
}

// 版面重排（lazy layout、頁籤切換）會把 iframe 推開，代理層要跟上；
// 每次滑鼠移動都量會逼瀏覽器重算版面，所以節流。
function syncProxyRects() {
  const now = Date.now()
  if (now - lastProxySync < PROXY_SYNC_MS) return
  lastProxySync = now
  for (const proxy of allProxies()) syncProxyRect(proxy)
}

// iframe 的代理層要蓋在 iframe 上（不然指不到它），
// **但不能蓋在頁面自己疊上來的東西上**（下拉選單、彈窗）——
// 指標被代理層攔走的話，站台收到 mouseout 就把選單收起來，使用者永遠點不到選單項目。
// 所以代理層貼在 <body> 底下（不放進 z-index 拉到最高的 overlay，那是獨立堆疊脈絡，
// 放進去就一定蓋過所有頁面內容）。
// 跟它在 body 這一層比高低的不是 iframe 自己，是 iframe **最外層那個有數字 z-index 的祖先**
// （`.content { position: relative; z-index: 2 }` 這種容器很常見）：
// 只看 iframe 自己會拿到 0，整個容器蓋在代理層上面，iframe 反而選不到（體檢抓到的退化）。
// 取那個值，代理層與容器同層、又排在 DOM 後面，就蓋得住 iframe；
// 頁面把選單疊在 iframe 上時一定給了更高的 z-index，那就由選單勝出。
function proxyZIndexFor(frame) {
  let z = 0
  try {
    const gcs = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle.bind(window) : null
    if (gcs) {
      let node = frame
      while (node && node !== document.body && node !== document.documentElement) {
        const raw = Number(gcs(node)?.zIndex)
        // 一路往上覆寫，留下的就是最外層那個
        if (Number.isFinite(raw)) z = raw
        node = node.parentElement
      }
    }
  } catch {}
  return String(Math.max(0, z))
}

function buildFrameProxies() {
  if (typeof document === 'undefined' || !document.body) return
  for (const frame of document.querySelectorAll('iframe')) {
    const proxy = document.createElement('div')
    proxy.setAttribute('data-af-frame-proxy', '')
    proxy.__afFrame = frame
    proxy.style.position = 'absolute'
    proxy.style.pointerEvents = 'auto'
    proxy.style.zIndex = proxyZIndexFor(frame)
    syncProxyRect(proxy)
    document.body.appendChild(proxy)
  }
  lastProxySync = Date.now()
}

// 疊上來的東西沒有 z-index（只靠 DOM 順序）時代理層還是會贏，這是最後一道防線：
// 暫時關掉代理層問一次真實命中，底下是頁面元素就讓路，把指標還給它。
// 站台的選單多半有收合延遲，一個 mousemove（幾毫秒）內還回去通常來得及。
// `elementFromPoint` 是 CLAUDE.md 那條禁令的唯一例外（只有真實命中測試答得出來），
// 拿不到它（jsdom）就跳過讓路，行為同以往。
function yieldProxyIfCovered(proxy, event) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null
  const prev = proxy.style.pointerEvents
  proxy.style.pointerEvents = 'none'
  let hit = null
  try {
    hit = document.elementFromPoint(event.clientX, event.clientY)
  } finally {
    proxy.style.pointerEvents = prev
  }
  // 問不出來、或底下就是那個 iframe：維持可指到，否則 iframe 又選不到了
  if (!hit || hit === proxy.__afFrame) return null
  // 命中我們自己的東西（overlay、別的代理層）不算頁面元素
  if (overlayEl && (hit === overlayEl || overlayEl.contains(hit))) return null
  if (hit.getAttribute && hit.getAttribute('data-af-frame-proxy') !== null) return null
  proxy.style.pointerEvents = 'none'
  yieldedEl = hit
  return hit
}

// 讓路是暫時的：指標離開那個元素就要把代理層裝回去，否則 iframe 從此選不到。
// （指標從選單移進裸露的 iframe 區域時，父文件收不到任何事件——
//   那個轉換的最後一個訊號就是選單自己的 mouseout，所以要聽它。）
function rearmProxies() {
  if (!yieldedEl) return
  yieldedEl = null
  for (const proxy of allProxies()) proxy.style.pointerEvents = 'auto'
}

function stillOnYielded(node) {
  if (!yieldedEl || !node) return false
  return node === yieldedEl || (typeof yieldedEl.contains === 'function' && yieldedEl.contains(node))
}

function onMouseOut(event) {
  if (!active || !yieldedEl) return
  if (!stillOnYielded(event.target)) return
  if (stillOnYielded(event.relatedTarget)) return
  rearmProxies()
}

// 更新工具列狀態（作用中模式與停用狀態）
function updateToolbar() {
  if (!toolbarEl) return
  // 已經選了值就以「已選那張表」為準：滑鼠可能正停在表格外的一段文字上，
  // 用 hover 目標判定會讓三段在使用者走向工具列的途中反灰（P4 回饋的根因）
  const judgeEl = (selectedList.length > 0 && pickedTableEl) ? pickedTableEl : currentTargetEl
  const isTable = Boolean(judgeEl && isTableMode(judgeEl))
  const isTask = isMultiPickPurpose()

  for (const btn of toolbarEl.querySelectorAll('[data-af-tool]')) {
    const key = btn.getAttribute('data-af-tool')
    let disabled = false
    if (!isTable) {
      disabled = true
    } else if (!isTask) {
      if (key === 'col' || key === 'colEach' || key === 'row') disabled = true
    }

    if (disabled) {
      btn.setAttribute('aria-disabled', 'true')
      btn.style.opacity = '0.5'
      btn.style.cursor = 'not-allowed'
    } else {
      btn.removeAttribute('aria-disabled')
      btn.style.opacity = '1'
      btn.style.cursor = 'pointer'
    }

    if (key === pickMode) {
      btn.setAttribute('data-af-active', '')
      btn.style.backgroundColor = COLORS.primary
      btn.style.color = COLORS.text
    } else {
      btn.removeAttribute('data-af-active')
      btn.style.backgroundColor = COLORS.surface
      btn.style.color = COLORS.primary
    }
  }
}

// 移除指定序號之已選項（留復原快照）
function removePickAt(index) {
  trimReady = false
  if (index < 0 || index >= selectedList.length) return
  const previous = takeUndoSnapshot(selectedList, pickedTableEl)
  clearUndoSnapshot()
  selectedList.splice(index, 1)
  undoSnapshot = previous
  limitReached = false
  if (selectedList.length === 0) {
    pickedTableEl = null
    applyPickedMarks(currentTargetEl)
  } else {
    applyPickedMarks(pickedTableEl)
  }
  updatePanel(panelEl, currentTargetEl)
}

// 移除最後一項已選項（Ctrl+Z 自身的移除不存快照，其他呼叫端存）
function removeLastPick(saveSnapshot = true) {
  trimReady = false
  if (selectedList.length === 0) return
  const previous = saveSnapshot ? takeUndoSnapshot(selectedList, pickedTableEl) : null
  clearUndoSnapshot()
  selectedList.pop()
  if (previous) undoSnapshot = previous
  limitReached = false
  if (selectedList.length === 0) {
    pickedTableEl = null
    applyPickedMarks(currentTargetEl)
  } else {
    applyPickedMarks(pickedTableEl)
  }
  updatePanel(panelEl, currentTargetEl)
}

// 取得一個 chip 所對應的頁面格子或元素
function cellsOfChip(chip) {
  if (chip._afEl) return [chip._afEl]
  if (chip._afTable && chip._afPick) return cellsOfPick(chip._afTable, chip._afPick)
  return []
}

// 取得元素文字作為名稱提示（連續空白縮減為單一空白，最多 20 字）
function elementNameHint(el) {
  if (!el) return ''
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20)
}

// 已選值的 chip（× 移除那一個值）；批次模式各組共用同一份建法
function buildPickChip(i, name) {
  const chip = document.createElement('div')
  chip.setAttribute('data-af-chip', String(i))
  chip.style.display = 'inline-flex'
  chip.style.alignItems = 'center'
  chip.style.backgroundColor = COLORS.surface
  chip.style.color = COLORS.text
  chip.style.border = `1px solid ${COLORS.border}`
  chip.style.borderRadius = '3px'
  chip.style.padding = '2px 6px'
  chip.style.fontSize = '12px'
  chip.style.minHeight = '28px'
  chip.style.transition = reduceMotion ? '' : 'background-color 150ms ease'

  chip.addEventListener('mouseenter', () => {
    for (const cell of cellsOfChip(chip)) {
      if (cell._afPrevOutline === undefined) {
        cell._afPrevOutline = cell.style.outline
      }
      cell.setAttribute('data-af-chip-hover', '')
      trackChipHover(cell)
      cell.style.outline = `3px solid ${COLORS.primary}`
    }
  })
  chip.addEventListener('mouseleave', () => {
    for (const cell of cellsOfChip(chip)) {
      if (cell._afHoverTimer) {
        clearTimeout(cell._afHoverTimer)
        delete cell._afHoverTimer
      }
      cell.removeAttribute('data-af-chip-hover')
      if (cell._afPrevOutline !== undefined) {
        cell.style.outline = cell._afPrevOutline
        delete cell._afPrevOutline
      }
    }
  })

  const nameSpan = document.createElement('span')
  nameSpan.textContent = name
  chip.appendChild(nameSpan)

  const removeBtn = document.createElement('span')
  removeBtn.setAttribute('data-af-chip-remove', '')
  removeBtn.textContent = '×'
  removeBtn.setAttribute('title', '移除')
  removeBtn.style.marginLeft = '6px'
  removeBtn.style.cursor = 'pointer'
  removeBtn.style.fontWeight = 'bold'
  chip.appendChild(removeBtn)
  return chip
}

// 批次模式的已選清單：依組分段（每組一個 data-af-group 容器）
function renderBatchGroups(panel, groups, el) {
  groups.forEach((g, gi) => {
    const box = document.createElement('div')
    box.setAttribute('data-af-group', String(gi))
    box.style.marginBottom = '6px'

    const head = document.createElement('div')
    head.style.display = 'flex'
    head.style.alignItems = 'center'
    head.style.gap = '6px'
    head.style.fontWeight = 'bold'
    const title = document.createElement('span')
    const nameHint = g.el ? elementNameHint(g.el) : (computeNameHint(g.tableEl) || '')
    const n = g.el ? 1 : g.picks.length
    title.textContent = `任務 ${gi + 1}：${nameHint}（${n} 個值）`
    head.appendChild(title)
    const removeGroup = document.createElement('span')
    removeGroup.setAttribute('data-af-group-remove', '')
    removeGroup.textContent = '×'
    removeGroup.setAttribute('title', '移除這個任務')
    removeGroup.style.cursor = 'pointer'
    head.appendChild(removeGroup)
    box.appendChild(head)

    const listDiv = document.createElement('div')
    listDiv.setAttribute('data-af-chip-list', '')
    listDiv.style.display = 'flex'
    listDiv.style.flexWrap = 'wrap'
    listDiv.style.gap = '4px'
    listDiv.style.maxHeight = '40vh'
    listDiv.style.overflowY = 'auto'
    if (g.el) {
      const chip = buildPickChip(0, nameHint || '這個元素')
      chip._afEl = g.el
      listDiv.appendChild(chip)
    } else {
      g.picks.forEach((pick, i) => {
        const chip = buildPickChip(i, getPickName(pick))
        chip._afTable = g.tableEl
        chip._afPick = pick
        listDiv.appendChild(chip)
      })
    }
    box.appendChild(listDiv)
    panel.appendChild(box)
  })

  const noticeLines = []
  if (limitReached) noticeLines.push('（已達選取上限）')
  if (headerChangedNotice) noticeLines.push('（位置已變）')
  if (cancelConfirmPending) {
    noticeLines.push(`再按一次 Esc（或再點「取消」）才會取消，會丟掉 ${cancelConfirmPending.count} 個已選值`)
  }
  if (selectAllNotice) {
    if (selectedList.length === selectAllNotice.taken) {
      noticeLines.push(`這張表有 ${selectAllNotice.scanned} 格，只選到前 ${selectAllNotice.taken} 格（上限）`)
    } else {
      selectAllNotice = null
    }
  }
  if (undoSnapshot) noticeLines.push('可按復原或 Ctrl／⌘＋Z 還原上一步')
  if (cellWrapsTable(currentCellEl) && !currentInner) noticeLines.push(NESTED_CELL_NOTICE)
  if (toolbarNotice) noticeLines.push(toolbarNotice)
  const hoverCell = currentCellEl || (currentHoverEl && cellOf(currentHoverEl))
  if ((currentPurpose === 'task' || currentPurpose === 'repick') && selectedCount() > 0 &&
      hoverCell && !hoverCell.hasAttribute('data-af-picked') && !hoverCell.closest?.('[data-af-picked]') && !hoverCell.querySelector?.('[data-af-picked]')) {
    noticeLines.push(`Enter＝完成，只送已選的 ${selectedCount()} 個；要加這一格請先點它`)
  }
  noticeLines.push(instructionLine(el))
  appendPanelText(panel, noticeLines)
  updatePanelActions(el)
}

// 產生說明面板文字與已選清單
function updatePanel(panel, el) {
  if (!panel) return
  // 動作列是 panelBodyEl 的兄弟節點，不能跟著內文一起被清掉
  const body = panelBodyEl && panel.contains(panelBodyEl) ? panelBodyEl : panel
  while (body.firstChild) {
    body.removeChild(body.firstChild)
  }
  panel = body

  const groups = batchGroupsView()
  if (groups.length > 0) {
    renderBatchGroups(panel, groups, el)
    return
  }

  const countDiv = document.createElement('div')
  countDiv.setAttribute('data-af-count', '')
  countDiv.textContent = `已選 ${selectedList.length}／${maxPicks}`
  countDiv.style.fontWeight = 'bold'
  countDiv.style.marginBottom = '4px'
  panel.appendChild(countDiv)

  if (selectedList.length > 0) {
    const headerDiv = document.createElement('div')
    headerDiv.textContent = `已選 ${selectedList.length} 個值:`
    headerDiv.style.marginBottom = '4px'
    headerDiv.style.fontWeight = 'bold'
    panel.appendChild(headerDiv)

    const listDiv = document.createElement('div')
    listDiv.setAttribute('data-af-chip-list', '')
    listDiv.style.display = 'flex'
    listDiv.style.flexWrap = 'wrap'
    listDiv.style.gap = '4px'
    listDiv.style.marginBottom = '6px'
    listDiv.style.maxHeight = '40vh'
    listDiv.style.overflowY = 'auto'

    for (let i = 0; i < selectedList.length; i++) {
      const chip = buildPickChip(i, getPickName(selectedList[i]))
      chip._afTable = pickedTableEl || currentTargetEl
      chip._afPick = selectedList[i]
      listDiv.appendChild(chip)
    }
    panel.appendChild(listDiv)

    const removeLastBtn = document.createElement('button')
    removeLastBtn.type = 'button'
    removeLastBtn.setAttribute('data-af-remove-last', '')
    removeLastBtn.textContent = '移除最後一項'
    removeLastBtn.style.padding = '2px 8px'
    removeLastBtn.style.fontSize = '12px'
    removeLastBtn.style.backgroundColor = COLORS.surface
    removeLastBtn.style.color = COLORS.primary
    removeLastBtn.style.border = `1px solid ${COLORS.border}`
    removeLastBtn.style.borderRadius = '3px'
    removeLastBtn.style.cursor = 'pointer'
    removeLastBtn.style.minHeight = '28px'
    removeLastBtn.style.marginBottom = '4px'
    removeLastBtn.style.transition = reduceMotion ? '' : 'background-color 150ms ease'
    addFocusRing(removeLastBtn)
    panel.appendChild(removeLastBtn)

    const noticeLines = []
    if (limitReached || selectedList.length >= maxPicks) {
      noticeLines.push('（已達選取上限）')
    }
    if (headerChangedNotice) {
      noticeLines.push('（位置已變）')
    }
    if (replaceConfirmPending) {
      noticeLines.push(`再點一次才會換到這張表（會取代 ${selectedList.length} 個已選值）`)
    }
    if (cancelConfirmPending) {
      noticeLines.push(`再按一次 Esc（或再點「取消」）才會取消，會丟掉 ${cancelConfirmPending.count} 個已選值`)
    }
    if (selectAllNotice) {
      if (selectedList.length === selectAllNotice.taken) {
        noticeLines.push(`這張表有 ${selectAllNotice.scanned} 格，只選到前 ${selectAllNotice.taken} 格（上限）`)
      } else {
        selectAllNotice = null
      }
    }
    if (undoSnapshot) {
      noticeLines.push(undoSnapshot.tableEl && pickedTableEl && undoSnapshot.tableEl !== pickedTableEl
        ? '已換到另一張表格（可按復原或 Ctrl／⌘＋Z 回上一張）'
        : '可按復原或 Ctrl／⌘＋Z 還原上一步')
    }
    if (cellWrapsTable(currentCellEl) && !currentInner) noticeLines.push(NESTED_CELL_NOTICE)
    if (toolbarNotice) noticeLines.push(toolbarNotice)
    const hoverCell = currentCellEl || (currentHoverEl && cellOf(currentHoverEl))
    if ((currentPurpose === 'task' || currentPurpose === 'repick') && selectedList.length > 0 &&
        hoverCell && !hoverCell.hasAttribute('data-af-picked') && !hoverCell.closest?.('[data-af-picked]') && !hoverCell.querySelector?.('[data-af-picked]')) {
      noticeLines.push(`Enter＝完成，只送已選的 ${selectedList.length} 個；要加這一格請先點它`)
    }
    noticeLines.push(instructionLine(el))
    const footerDiv = document.createElement('div')
    footerDiv.textContent = noticeLines.join('\n')
    footerDiv.style.whiteSpace = 'pre-line'
    panel.appendChild(footerDiv)
    updatePanelActions(el)
    return
  }

  const frameEl = iframeOf(el)
  if (frameEl) {
    const lines = ['框架 iframe']
    let host = ''
    try {
      host = new URL(frameSrcOf(frameEl)).hostname
    } catch {}
    if (host) lines.push(host)
    lines.push('確認即進入這個框架選取')
    if (currentHint === 'frame_not_found') lines.push('無法進入這個框架')
    lines.push('點一下即進入這個框架')
    appendPanelText(panel, lines)
    updatePanelActions(el)
    return
  }

  if (!el) {
    const lines = []
    if (currentHint === 'frame_not_found') lines.push('無法進入這個框架')
    if (limitReached || selectedList.length >= maxPicks) lines.push('（已達選取上限）')
    if (headerChangedNotice) lines.push('（位置已變）')
    if (toolbarNotice) lines.push(toolbarNotice)
    lines.push(instructionLine(null))
    appendPanelText(panel, lines)
    updatePanelActions(el)
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
  // 非表格沒有欄／列可挑，工具列會整排停用；要說出為什麼，不然使用者只看到點不動
  if (!isTableMode(el)) lines.push('非表格：抓整個元素')
  if (currentHint === 'frame_not_found') lines.push('無法進入這個框架')
  if (limitReached || selectedList.length >= maxPicks) lines.push('（已達選取上限）')
  if (headerChangedNotice) lines.push('（位置已變）')
  if (lockedEl && el === lockedEl) lines.push('（已鎖定：滑鼠移開也不會換目標，點別處解除）')
  if (cellWrapsTable(currentCellEl) && !currentInner) lines.push(NESTED_CELL_NOTICE)
  if (toolbarNotice) lines.push(toolbarNotice)
  lines.push(instructionLine(el))
  appendPanelText(panel, lines)
  updatePanelActions(el)
}

/**
 * 面板永遠有一句「現在該做什麼」，隨狀態換。這一句就是全部的教學——
 * 使用者不會去看說明文件，也不該需要看。
 */
function instructionLine(el) {
  if (currentPurpose === 'preaction' || (currentPurpose && currentPurpose.startsWith('login'))) {
    return '點一下要操作的那個元素就完成'
  }
  if (batchMode) {
    const groups = batchGroupsView()
    return groups.length === 0
      ? '點你要抓的內容；不同的表格或元素會各自成為一個任務'
      : `已選 ${groups.length} 個任務、共 ${batchValueTotal(groups)} 個值，好了按完成（或雙擊、Enter）`
  }
  if (selectedList.length > 0) {
    return `已選 ${selectedList.length} 個值，再點其他格可加選、點已選的可取消，好了按完成（或雙擊、Enter）`
  }
  if (el && isTableMode(el)) {
    if (outerTableOf(el)) {
      return '這是外層表格裡的小表：要抓外層每一列的這個位置，按 ↑ 切到外層表再點那一格'
    }
    return '點你要的那一格；點表頭可選整欄'
  }
  if (el) {
    return '點一下鎖定這個元素 · 雙擊或 Enter 完成 · ↑ 放大 ↓ 縮小'
  }
  // 目標還沒出現：多半是內容要先操作頁面才會載入（例如點頁籤才出現的 iframe）
  return '把滑鼠移到要抓的內容上；還沒出現的話按 Esc，先操作頁面讓它載入，再在它上面按右鍵'
}

// 面板的文字段落（動作列是真的按鈕，所以文字不能再用 panel.textContent 整包覆蓋）
function appendPanelText(panel, lines) {
  const div = document.createElement('div')
  div.style.whiteSpace = 'pre-line'
  div.textContent = lines.join('\n')
  panel.appendChild(div)
}

// 面板底部的動作列：畫面上看得見的「完成／取消／復原」，不必先知道 Enter 與 Esc。
// **建一次，之後只更新文字與狀態**——每次 hover 重建會把使用者正要按的那顆換掉。
function buildPanelActions() {
  const bar = document.createElement('div')
  bar.style.display = 'flex'
  bar.style.gap = '8px'
  bar.style.marginTop = '8px'

  const done = document.createElement('button')
  done.type = 'button'
  done.setAttribute('data-af-done', '')
  // 主色由 updatePanelActions 依「有沒有已選」切換：沒東西可完成時就不該長得像主要動作
  styleActionButton(done, false)
  addFocusRing(done)
  bar.appendChild(done)

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.setAttribute('data-af-cancel', '')
  cancel.textContent = '取消'
  styleActionButton(cancel, false)
  addFocusRing(cancel)
  bar.appendChild(cancel)

  const undo = document.createElement('button')
  undo.type = 'button'
  undo.setAttribute('data-af-undo', '')
  undo.textContent = '復原'
  styleActionButton(undo, false)
  addFocusRing(undo)
  undo.hidden = true
  bar.appendChild(undo)

  const trimHead = document.createElement('button')
  trimHead.type = 'button'
  trimHead.setAttribute('data-af-trim-head', '')
  trimHead.textContent = '去掉第一格'
  styleActionButton(trimHead, false)
  addFocusRing(trimHead)
  trimHead.hidden = true
  bar.appendChild(trimHead)

  const trimTail = document.createElement('button')
  trimTail.type = 'button'
  trimTail.setAttribute('data-af-trim-tail', '')
  trimTail.textContent = '去掉最後一格'
  styleActionButton(trimTail, false)
  addFocusRing(trimTail)
  trimTail.hidden = true
  bar.appendChild(trimTail)

  panelDoneEl = done
  panelUndoEl = undo
  panelTrimHeadEl = trimHead
  panelTrimTailEl = trimTail
  return bar
}

function styleActionButton(btn, primary) {
  btn.style.padding = '4px 12px'
  btn.style.fontSize = '12px'
  btn.style.fontFamily = 'inherit'
  btn.style.minHeight = '28px'
  btn.style.borderRadius = '4px'
  btn.style.cursor = 'pointer'
  btn.style.backgroundColor = primary ? COLORS.primary : COLORS.surface
  btn.style.color = primary ? COLORS.text : COLORS.textMuted
  btn.style.border = primary ? 'none' : `1px solid ${COLORS.border}`
}

// 只更新既有按鈕的文字與可用狀態（不重建節點）
function updatePanelActions(el) {
  if (!panelDoneEl) return
  const done = panelDoneEl
  const n = selectedCount()
  done.removeAttribute('aria-disabled')
  if (n > 0) {
    done.textContent = `完成（${n} 個值）`
  } else if (iframeOf(el)) {
    done.textContent = '進入這個框架'
  } else if (!el || isTableMode(el)) {
    // 表格上還沒選任何一格：沒有東西可以完成，說出來比讓它送出空值好
    done.textContent = '完成'
    done.setAttribute('aria-disabled', 'true')
  } else {
    done.textContent = '完成（這個元素）'
  }
  const disabled = done.getAttribute('aria-disabled') === 'true'
  // 有東西可以完成時才是主要動作（未選時長得跟「取消」一樣重會誘導誤按）；
  // 樣式先套，游標與透明度後蓋，否則停用時的 not-allowed 會被 pointer 洗掉
  styleActionButton(done, n > 0 || !disabled)
  done.style.cursor = disabled ? 'not-allowed' : 'pointer'
  done.style.opacity = disabled ? '0.5' : '1'

  if (panelUndoEl) panelUndoEl.hidden = !undoSnapshot

  if (panelTrimHeadEl && panelTrimTailEl) {
    panelTrimHeadEl.hidden = !trimReady
    panelTrimTailEl.hidden = !trimReady
    const trimDisabled = selectedList.length <= 1
    if (trimDisabled) {
      panelTrimHeadEl.setAttribute('aria-disabled', 'true')
      panelTrimTailEl.setAttribute('aria-disabled', 'true')
    } else {
      panelTrimHeadEl.removeAttribute('aria-disabled')
      panelTrimTailEl.removeAttribute('aria-disabled')
    }
    styleActionButton(panelTrimHeadEl, false)
    styleActionButton(panelTrimTailEl, false)
    panelTrimHeadEl.style.cursor = trimDisabled ? 'not-allowed' : 'pointer'
    panelTrimTailEl.style.cursor = trimDisabled ? 'not-allowed' : 'pointer'
    panelTrimHeadEl.style.opacity = trimDisabled ? '0.5' : '1'
    panelTrimTailEl.style.opacity = trimDisabled ? '0.5' : '1'
  }

  if (toolbarEl) {
    const lastName = selectedList.length > 0 ? getPickName(selectedList[selectedList.length - 1]) : null
    for (const def of TOOLS_DEF) {
      if (def.key === 'cell') continue
      const btn = toolbarEl.querySelector(`[data-af-tool="${def.key}"]`)
      if (!btn) continue
      if (lastName) {
        btn.setAttribute('title', `會把最後選的「${lastName}」換成${def.label}`)
      } else {
        btn.setAttribute('title', def.title)
      }
    }
  }
}

// 設定當前目標元素
function setTarget(el) {
  // AF-10 作業 C：**滑鼠移動不再有破壞性副作用**。
  // 以前滑鼠刮過另一張表就把整批已選清掉（連復原快照一起丟），
  // 使用者只是要把游標移到右上角工具列，途中經過別的表格就全沒了。
  // 現在換表一律由「點另一張表的格子」觸發（onClick 的表格分支），而且留一步反悔。
  clearMarkedCells(document)
  currentHoverEl = null
  currentInner = null
  currentTargetEl = el; currentDataRows = []; currentRowEl = null; colIndex = null; rowIndex = null; cellIndex = null; currentCellEl = null
  if (!el) {
    if (highlightEl) highlightEl.style.display = 'none'
    updateToolbar()
    if (panelEl) updatePanel(panelEl, null)
    return
  }
  // 目標是代理層時先重算一次位置（鍵盤 ↓ 回到代理層也走這裡），
  // 不然藍框會畫在版面重排前的舊矩形上
  if (frameOfProxy(el)) syncProxyRect(el)
  if (highlightEl) {
    highlightEl.style.display = 'block'
    updateHighlight(highlightEl, el)
  }
  // 非表格是「抓整個元素」，用十字指標；表格的格子與表頭由 handleTableMouseMove 各自設
  if (!isTableMode(el)) setCursor('crosshair')
  // 在非表格上點過「整欄／整列」的意圖，等目標變成表格才兌現
  if (pendingMode && isTableMode(el) && isMultiPickPurpose()) {
    pickMode = pendingMode
    pendingMode = null
    toolbarNotice = null
    // 這裡刻意不呼叫 upgradeLastPickTo：工具列的停用判定改以 `pickedTableEl` 為準之後
    // （已選非空時三段一律可用），「有已選卻點到停用的整欄」不可能成立，
    // 走到這裡時已選一定是空的，沒有東西可以升級。
  }
  updateToolbar()
  if (panelEl) updatePanel(panelEl, el)
}

// 取得待選欄或列之表頭文字
function getHeaderText() {
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return ''
  if (pickMode === 'row') return currentRowEl ? rowHeader(currentRowEl) : ''
  if (colIndex === null) return ''
  return columnHeaders(currentTargetEl)[colIndex] || ''
}

// 處理表格內滑鼠移動
// overlay 的按鈕拿不到樣式表（注入在別人的網頁上），焦點環只能自己畫。
// 沒有它，用鍵盤的人完全看不出焦點在哪一顆。
function addFocusRing(btn) {
  if (!btn || btn._afFocusBound) return
  btn.addEventListener('focus', () => {
    btn.style.outline = `2px solid ${COLORS.primary}`
    btn.style.outlineOffset = '2px'
  })
  btn.addEventListener('blur', () => {
    btn.style.outline = ''
    btn.style.outlineOffset = ''
  })
  btn._afFocusBound = true
}

// 指標形狀就是「這裡能做什麼」的說明：試算表用 cell 表示可選格、pointer 表示可點
function setCursor(kind) {
  if (typeof document === 'undefined' || !document.body) return
  document.body.style.cursor = kind
}

// 表頭要說出點下去會發生什麼；提示是我們加的，離開選取模式要收乾淨
function markTitle(el, text) {
  if (!el || typeof el.setAttribute !== 'function') return
  if (el.getAttribute('title') === text) return
  // 頁面自己的 title（例如「點此排序」）要記下來還原，直接覆蓋等於永久弄壞人家的網頁
  if (!titledEls.some(e => e.el === el)) {
    titledEls.push({ el, prev: el.hasAttribute('title') ? el.getAttribute('title') : null })
  }
  el.setAttribute('title', text)
}

function clearTitles() {
  for (const { el, prev } of titledEls) {
    try {
      if (prev === null) el.removeAttribute('title')
      else el.setAttribute('title', prev)
    } catch {}
  }
  titledEls = []
}

// 標示的狀態切換要看得出來，但使用者要求減少動態時一律不加
function markTransition() {
  return reduceMotion ? '' : 'outline-color 100ms ease, background-color 100ms ease'
}

function handleTableMouseMove(target) {
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return
  const prevCell = currentCellEl
  currentHoverEl = target
  // 滑鼠在表頭上：先讓使用者看到點下去會選到整欄（或整列），再決定點不點
  const head = resolveHeaderTarget(target, currentTargetEl)
  if (head) {
    setCursor('pointer')
    const cell = typeof target.closest === 'function' ? target.closest(CELL_SELECTOR) : null
    if (cell) markTitle(cell, head.axis === 'col' ? '選整欄' : '選整列')
    // 記住停在表頭上這件事，Enter 的快速路徑才會選到整欄／整列而不是上一格殘留的索引
    currentCellEl = cell
    currentInner = null
    rowIndex = null; colIndex = null; cellIndex = null
    rememberBatchHover()
    const dataRows = resolveDataRows(currentTargetEl)
    clearMarkedCells(document)
    if (head.axis === 'col') {
      markCells(null, dataRows, null, 'col', head.index, null)
    } else {
      markCells(null, dataRows, dataRows[head.index], 'row', null, null)
    }
    if (selectedList.length > 0 && pickedTableEl) {
      applyPickedMarks(pickedTableEl)
    } else {
      applyPickedMarks(currentTargetEl)
    }
    const updated = syncNestedNotice()
    if (!updated && prevCell !== currentCellEl) {
      if (panelEl) updatePanel(panelEl, currentTargetEl)
    }
    return
  }
  const info = resolveCell(target, currentTargetEl)
  // 滑鼠停在格子以外（表格的縫隙、表頭列）時要放掉記住的那一格，
  // 否則之後切換模式會把標示畫回一個滑鼠早就離開的位置
  if (!info) {
    currentCellEl = null
    currentInner = null
    currentHoverEl = null
    // 列欄索引也要放掉：只清格子的話，切到整欄／整列時 markCells 會拿舊索引畫回一整欄（AF-18 體檢 p5 B3 補強抓到）
    rowIndex = null; colIndex = null; cellIndex = null; currentRowEl = null
    rememberBatchHover()
    clearMarkedCells(document)
    if (selectedList.length > 0 && pickedTableEl) {
      applyPickedMarks(pickedTableEl)
    } else {
      applyPickedMarks(currentTargetEl)
    }
    const updated = syncNestedNotice()
    if (!updated && prevCell !== currentCellEl) {
      if (panelEl) updatePanel(panelEl, currentTargetEl)
    }
    return
  }
  setCursor('cell')
  currentCellEl = info.cell
  currentInner = info.inner || null
  colIndex = info.cIdx
  rowIndex = info.rIdx
  cellIndex = pickMode === 'row' ? rowIndex : colIndex
  currentDataRows = info.dataRows
  currentRowEl = info.row
  rememberBatchHover()
  if ((pickMode === 'col' || pickMode === 'colEach') && currentPurpose === 'task' &&
      isSingleRowNestedTable(currentTargetEl) && isUpgradeableTable(currentTargetEl)) {
    const O = outerTableOf(currentTargetEl)
    if (O) {
      const oInfo = resolveCell(currentTargetEl, O)
      if (oInfo && oInfo.cell && oInfo.cIdx !== null) {
        const C = oInfo.cIdx
        const oCell = oInfo.cell
        const subEl = info.subEl || info.cell || target
        const fullInner = innerPathOf(oCell, subEl)
        clearMarkedCells(document)
        markCells(null, oInfo.dataRows, null, 'col', C, fullInner)
        if (selectedList.length > 0 && pickedTableEl) {
          applyPickedMarks(pickedTableEl)
        } else {
          applyPickedMarks(currentTargetEl)
        }
        const updated = syncNestedNotice()
        if (!updated && prevCell !== currentCellEl) {
          if (panelEl) updatePanel(panelEl, currentTargetEl)
        }
        return
      }
    }
  }
  markCells(currentCellEl, info.dataRows, info.row, pickMode, colIndex, currentInner)
  if (selectedList.length > 0 && pickedTableEl) {
    applyPickedMarks(pickedTableEl)
  } else {
    applyPickedMarks(currentTargetEl)
  }
  const updated = syncNestedNotice()
  if (!updated && prevCell !== currentCellEl) {
    if (panelEl) updatePanel(panelEl, currentTargetEl)
  }
}

// 批次模式：記下這張表最後一次 hover 的列欄（滑鼠移到別張表後 setTarget 會把它們清掉）
function rememberBatchHover() {
  if (!batchMode || !currentTargetEl) return
  batchHover.set(currentTargetEl, { rowIndex, colIndex, rowEl: currentRowEl })
}

// 組 payload 用的 blockInfo 位置：目前目標就是這張表時讀現況，否則讀它最後一次 hover 的記錄
function blockHintFor(tableEl) {
  if (tableEl === currentTargetEl) return { index: currentCellIndex(), headerText: getHeaderText() }
  const h = batchHover.get(tableEl)
  if (!h) return { index: null, headerText: '' }
  if (pickMode === 'row') return { index: h.rowIndex, headerText: h.rowEl ? rowHeader(h.rowEl) : '' }
  return { index: h.colIndex, headerText: h.colIndex === null ? '' : (columnHeaders(tableEl)[h.colIndex] || '') }
}

// hover 的格子是否內含表格且無子單位，改變時才重畫面板（每次 mousemove 都重畫會把按鈕從指尖換掉）
function syncNestedNotice() {
  const on = Boolean(cellWrapsTable(currentCellEl) && !currentInner)
  if (on === nestedNoticeOn) return false
  nestedNoticeOn = on
  if (panelEl) updatePanel(panelEl, currentTargetEl)
  return true
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

// 取得單一儲存格的文字內容。
// 這裡**不需要處理位置定位**：它吃的一律是已選清單裡的項目，而已選清單只存索引——
// 選取當下建立的 pick 本來就沒有 pos（pos 是之後在 Picker 設的），
// 帶 pos 的 preselect 也在 applyPreselect 就換算成當下的索引了。加一條走不到的分支只是死碼。
function getCellText(cellSpec, tableEl) {
  if (!tableEl || !cellSpec || !cellSpec.row || !cellSpec.col) return ''
  const dataRows = resolveDataRows(tableEl)
  const rowEl = dataRows[cellSpec.row.index]
  if (!rowEl) return ''
  const el = targetAtGrid(rowEl, cellSpec.col.index, cellSpec.inner)
  return (el && el.textContent ? el.textContent : '').trim()
}

// 取得整欄或整列聚合的描述文字
function getBlockPreview(blockSpec, tableEl) {
  if (!tableEl || !blockSpec) return ''
  const isRow = blockSpec.axis === 'row'
  const axisName = isRow ? '列' : '欄'
  const dataRows = resolveDataRows(tableEl)
  let n = 0
  const idx = (blockSpec.index !== null && blockSpec.index !== undefined) ? blockSpec.index : 0
  if (isRow) {
    const rowEl = dataRows[idx]
    if (rowEl) {
      for (const cell of getRowCells(rowEl)) {
        const c = gridIndexOf(rowEl, cell)
        const el = targetAtGrid(rowEl, c, blockSpec.inner)
        if (el) n++
      }
    }
  } else {
    for (const r of dataRows) {
      const el = targetAtGrid(r, idx, blockSpec.inner)
      if (el) n++
    }
  }
  const header = typeof blockSpec.headerText === 'string' ? blockSpec.headerText.trim() : ''
  const label = header ? `「${header}」` : `第 ${Number(idx) + 1} ${axisName}`
  return `${label}整${axisName} ${n} 格`
}

// 整欄或整列前 3 格（解析得到、未被排除、文字非空）的文字，以「、」串接；多於 3 格加「…」，一格都沒有回空字串
const BLOCK_SAMPLE_MAX = 3
function getBlockSamples(blockSpec, tableEl) {
  if (!tableEl || !blockSpec) return ''
  const dataRows = resolveDataRows(tableEl)
  const idx = (blockSpec.index !== null && blockSpec.index !== undefined) ? blockSpec.index : 0
  const texts = []
  const take = (el, rIdx, cIdx) => {
    if (!el || isExcludedCell(blockSpec, rIdx, cIdx)) return
    const text = (el.textContent || '').trim()
    if (text) texts.push(text)
  }
  if (blockSpec.axis === 'row') {
    const rowEl = dataRows[idx]
    if (rowEl) {
      for (const cell of getRowCells(rowEl)) {
        const c = gridIndexOf(rowEl, cell)
        take(targetAtGrid(rowEl, c, blockSpec.inner), idx, c)
      }
    }
  } else {
    dataRows.forEach((r, rIdx) => take(targetAtGrid(r, idx, blockSpec.inner), rIdx, idx))
  }
  if (texts.length === 0) return ''
  return texts.slice(0, BLOCK_SAMPLE_MAX).join('、') + (texts.length > BLOCK_SAMPLE_MAX ? '…' : '')
}

// 解析整欄每格各一個值的清單（右鍵 col-each、工具列 colEach 與快捷路徑共用）
function resolveColEachCells(tableEl, cIdx, inner, targetEl) {
  if (!tableEl || !isTableMode(tableEl)) return null
  if (currentPurpose === 'task' && isSingleRowNestedTable(tableEl) && isUpgradeableTable(tableEl)) {
    const O = outerTableOf(tableEl)
    if (O) {
      const oInfo = resolveCell(tableEl, O)
      if (oInfo && oInfo.cell && oInfo.cIdx !== null) {
        const C = oInfo.cIdx
        const oCell = oInfo.cell
        let actualTarget = targetEl
        if (!actualTarget) {
          const dRows = resolveDataRows(tableEl)
          const cEl = dRows[0] ? cellAtGridIndex(dRows[0], cIdx) : null
          actualTarget = (cEl && hasInner(inner)) ? (resolveInner(cEl, inner) || cEl) : (cEl || oCell)
        }
        const fullInner = innerPathOf(oCell, actualTarget)
        const oRows = resolveDataRows(O)
        const picks = []
        for (let r = 0; r < oRows.length; r++) {
          if (targetAtGrid(oRows[r], C, fullInner) !== null) {
            picks.push(makeCellPick(r, C, O, oRows, fullInner))
          }
        }
        return {
          tableEl: O,
          origTableEl: tableEl,
          isOuter: true,
          cIdx: C,
          inner: fullInner,
          picks
        }
      }
    }
  }
  const dataRows = resolveDataRows(tableEl)
  const picks = []
  for (let r = 0; r < dataRows.length; r++) {
    if (targetAtGrid(dataRows[r], cIdx, inner) !== null) {
      picks.push(makeCellPick(r, cIdx, tableEl, dataRows, inner))
    }
  }
  return {
    tableEl,
    origTableEl: tableEl,
    isOuter: false,
    cIdx,
    inner,
    picks
  }
}

// 展開整欄每格各一個值（右鍵 col-each、工具列 colEach 與快捷路徑共用）
function expandColEach(tableEl, cIdx, inner, targetEl, options = {}) {
  const resolved = resolveColEachCells(tableEl, cIdx, inner, targetEl)
  if (!resolved) return false
  if (resolved.picks.length === 0) {
    toolbarNotice = '這一欄在目前的頁面上取不到格子'
    if (panelEl) updatePanel(panelEl, currentTargetEl)
    return false
  }

  const toggle = options.toggle !== false
  const present = resolved.picks.filter(p => selectedList.some(s => samePick(s, p)))
  // 全部已選＝整組取消；被上限截斷（補不進去了）而這一欄已有值時同樣算取消，否則再也點不掉
  const full = selectedList.length >= maxPicks
  if (toggle && present.length > 0 && (present.length === resolved.picks.length || full)) {
    const previous = takeUndoSnapshot(selectedList, pickedTableEl)
    clearUndoSnapshot()
    selectedList = selectedList.filter(s => !resolved.picks.some(p => samePick(s, p)))
    undoSnapshot = previous
    limitReached = false
    trimReady = false
    if (selectedList.length === 0) {
      pickedTableEl = null
      applyPickedMarks(currentTargetEl)
    } else {
      applyPickedMarks(pickedTableEl)
    }
    if (panelEl) updatePanel(panelEl, currentTargetEl)
    return true
  }

  if (resolved.isOuter) {
    // 升不上去就不得往下加：清單會混著小表的索引，卻配上外層表的定位
    if (selectedList.length > 0 && pickedTableEl === resolved.origTableEl && !promotePicksToOuter(resolved.origTableEl)) {
      toolbarNotice = CANNOT_PROMOTE_NOTICE
      if (panelEl) updatePanel(panelEl, currentTargetEl)
      return false
    }
    pickedTableEl = resolved.tableEl
    setTarget(resolved.tableEl)
    deliberateTableEl = resolved.tableEl
  } else {
    if (isSingleRowNestedTable(resolved.tableEl)) {
      toolbarNotice = SINGLE_ROW_NESTED_TABLE_NOTICE
    }
  }

  let n = 0
  for (const p of resolved.picks) {
    addPick(p)
    if (limitReached) break
  }
  // 說的是這一欄實際在清單裡的格數（去重、上限截斷的不算）
  n = resolved.picks.filter(p => selectedList.some(s => samePick(s, p))).length

  if (resolved.isOuter) {
    toolbarNotice = promotedColNotice(n)
  }

  if (options.replaceSnapshot) {
    undoSnapshot = options.replaceSnapshot
  }
  trimReady = true
  applyPickedMarks(pickedTableEl || resolved.tableEl)
  if (panelEl) updatePanel(panelEl, pickedTableEl || resolved.tableEl)
  return true
}

/**
 * 給一個目標與它的值清單，組出 PICKED 的任務欄位（type／purpose／taskId 以外的全部）。
 * 單任務與批次都經這一份。
 * @param {Element} targetEl 目標（表格或元素）
 * @param {Array} picks 值清單
 * @param {{index: number|null, headerText: string}|null} hint 表格目標的 blockInfo 位置
 */
function buildPickPayload(targetEl, picks, hint) {
  const isTable = isTableMode(targetEl)
  const blockInfo = { ...kindOf(targetEl) }
  if (isTable) {
    blockInfo.axis = pickMode === 'row' ? 'row' : 'col'
    blockInfo.index = hint ? hint.index : null
    blockInfo.headerText = hint ? hint.headerText : ''
  } else {
    delete blockInfo.axis
    delete blockInfo.index
  }

  const payload = {
    locator: describe(targetEl),
    blockInfo,
    picks
  }

  if (isTable) {
    const nameHint = computeNameHint(targetEl)
    if (nameHint) payload.nameHint = nameHint
  }

  if (!isTable) {
    payload.preview = (targetEl.textContent || '').trim()
    payload.previewValue = parseNumber(payload.preview)
  } else if (picks.length > 1) {
    const firstText = picks[0].cell
      ? getCellText(picks[0].cell, targetEl)
      : (picks[0].block ? getBlockPreview(picks[0].block, targetEl) : (targetEl.textContent || '').trim())
    payload.preview = `${firstText}（共 ${picks.length} 個值）`
  } else if (picks.length === 1 && picks[0].cell) {
    const cellText = getCellText(picks[0].cell, targetEl)
    payload.preview = cellText
    const num = parseNumber(cellText)
    if (num !== null) {
      payload.previewValue = num
    }
  } else if (picks.length === 1 && picks[0].block) {
    payload.preview = getBlockPreview(picks[0].block, targetEl)
    const samples = getBlockSamples(picks[0].block, targetEl)
    if (samples) payload.previewSamples = samples
  } else {
    payload.preview = (targetEl.textContent || '').trim()
    const num = parseNumber(payload.preview)
    if (num !== null) {
      payload.previewValue = num
    }
  }
  return payload
}

// 送出確認訊息並離開
function confirmPick() {
  if (batchMode) {
    syncBatch()
    if (batchGroups.length > 0 && iframeOf(currentTargetEl)) {
      batchBlocksDescend()
      return
    }
    // 恰好一組而且就是目前這組：走下面的單任務流程，送出與非批次模式逐欄相同
    const onlyLive = batchGroups.length === 1 && currentGroupIdx === 0
    if (batchGroups.length > 0 && !onlyLive) {
      const payloads = batchGroups.map(g => {
        if (g.el) {
          const payload = buildPickPayload(g.el, [{ locator: describe(g.el) }], null)
          // 只有真的送出 batch 陣列時才補名稱提示：恰好一組走單任務訊息，要與非批次模式逐欄相同
          const hint = batchGroups.length >= 2 ? elementNameHint(g.el) : ''
          if (hint) payload.nameHint = hint
          return payload
        }
        return buildPickPayload(g.tableEl, g.picks.slice(), blockHintFor(g.tableEl))
      })
      const msg = batchGroups.length === 1
        ? { type: MSG.PICKED, purpose: currentPurpose, ...payloads[0] }
        : { type: MSG.PICKED, purpose: currentPurpose, batch: payloads }
      if (currentTaskId !== undefined) msg.taskId = currentTaskId
      applyPickedMarks(pickedTableEl)
      chrome.runtime.sendMessage(msg)
      exitPickMode({ hold: currentPurpose })
      return
    }
  }
  // 已選了值就以那張表格為準：滑鼠可能正停在表格外的一段文字上
  if (selectedList.length > 0 && pickedTableEl && currentTargetEl !== pickedTableEl) {
    setTarget(pickedTableEl)
  }
  if (!currentTargetEl) return

  // 整欄／整列模式卻沒有任何已選、目標又不是表格：送出去的會是「整個元素」，
  // 使用者以為自己選的是一整欄。停下來說原因，不要把他選的模式靜靜丟掉（AF-10 作業 C）
  if (isMultiPickPurpose() && selectedList.length === 0 &&
      (pickMode === 'col' || pickMode === 'colEach' || pickMode === 'row') && !isTableMode(currentTargetEl) &&
      !iframeOf(currentTargetEl)) {
    toolbarNotice = nonTableModeNotice()
    if (panelEl) updatePanel(panelEl, currentTargetEl)
    return
  }

  // 目標是 iframe(或它的代理層):值在框架裡面，選這個殼沒有意義，改成鑽進去
  const descendTarget = iframeOf(currentTargetEl)
  if (descendTarget) {
    const msg = { type: MSG.DESCEND_FRAME, purpose: currentPurpose, src: frameSrcOf(descendTarget) }
    if (batchMode) msg.batch = true
    if (currentTaskId !== undefined) msg.taskId = currentTaskId
    if (pendingPreselect) msg.preselect = pendingPreselect
    chrome.runtime.sendMessage(msg)
    exitPickMode()
    return
  }

  let picks = []
  if (selectedList.length > 0) {
    picks = [...selectedList]
  } else {
    if (isTableMode(currentTargetEl)) {
      if (pickMode === 'cell') {
        if (rowIndex !== null && colIndex !== null) {
          const dataRows = resolveDataRows(currentTargetEl)
          const row = dataRows[rowIndex]
          const cell = {
            row: { index: rowIndex, header: row ? rowHeader(row) : '' },
            col: { index: colIndex, header: columnHeaders(currentTargetEl)[colIndex] || '' }
          }
          putInner(cell, currentInner)
          picks = [{ cell }]
        } else {
          const block = {
            axis: 'col',
            index: currentCellIndex() !== null ? currentCellIndex() : 0,
            headerText: getHeaderText()
          }
          putInner(block, currentInner)
          withFooterExclude(block, currentTargetEl)
          picks = [{ block }]
        }
      } else if (pickMode === 'row') {
        const block = {
          axis: 'row',
          index: rowIndex !== null ? rowIndex : (currentCellIndex() !== null ? currentCellIndex() : 0),
          headerText: currentRowEl ? rowHeader(currentRowEl) : getHeaderText()
        }
        putInner(block, currentInner)
        picks = [{ block }]
      } else if (pickMode === 'colEach') {
        const resolved = resolveColEachCells(
          currentTargetEl,
          colIndex !== null ? colIndex : (currentCellIndex() !== null ? currentCellIndex() : 0),
          currentInner,
          currentHoverEl || currentCellEl || currentTargetEl
        )
        picks = resolved ? resolved.picks : []
        if (resolved?.isOuter) {
          currentTargetEl = resolved.tableEl
        }
      } else {
        if (currentPurpose === 'task' && isSingleRowNestedTable(currentTargetEl) && isUpgradeableTable(currentTargetEl)) {
          const O = outerTableOf(currentTargetEl)
          if (O) {
            const oInfo = resolveCell(currentTargetEl, O)
            if (oInfo && oInfo.cell && oInfo.cIdx !== null) {
              const C = oInfo.cIdx
              const oCell = oInfo.cell
              const targetEl = currentHoverEl || currentCellEl || currentTargetEl
              const fullInner = innerPathOf(oCell, targetEl)
              const block = {
                axis: 'col',
                index: C,
                headerText: columnHeaders(O)[C] || ''
              }
              putInner(block, fullInner)
              withFooterExclude(block, O)
              picks = [{ block }]
              currentTargetEl = O
            }
          }
        }
        if (picks.length === 0) {
          const block = {
            axis: 'col',
            index: colIndex !== null ? colIndex : (currentCellIndex() !== null ? currentCellIndex() : 0),
            headerText: colIndex !== null ? (columnHeaders(currentTargetEl)[colIndex] || '') : getHeaderText()
          }
          putInner(block, currentInner)
          withFooterExclude(block, currentTargetEl)
          picks = [{ block }]
        }
      }
    } else {
      picks = [{ locator: describe(currentTargetEl) }]
    }
  }

  // 一次只選一個的用途（登入、前置動作）才截斷；重選要能改多值（SPEC §8.4）
  if (!isMultiPickPurpose() && picks.length > 1) {
    picks = picks.slice(0, 1)
  }

  const msg = {
    type: MSG.PICKED,
    purpose: currentPurpose,
    ...buildPickPayload(currentTargetEl, picks, { index: currentCellIndex(), headerText: getHeaderText() })
  }
  if (currentTaskId !== undefined) msg.taskId = currentTaskId

  chrome.runtime.sendMessage(msg)
  // 設定面板就開在旁邊，使用者要看得到自己剛剛選的是哪一格；
  // repick 沒有面板（存檔就結束），維持全清
  exitPickMode(currentPurpose === 'repick' ? {} : { hold: currentPurpose })
}

// 請求取消選取模式（已選 2 個以上需二段確認）
function requestCancel() {
  const count = selectedCount()
  const needConfirm = (currentPurpose === 'task' || currentPurpose === 'repick') && count >= 2
  if (needConfirm) {
    // 「是不是同一次確認」比的是清單內容，不是數量：工具列把最後一格換成整欄、右鍵排除／取消排除
    // 都不改數量，只比數量的話這些變動之後的 Esc 會被當成第二次而直接取消
    const sig = JSON.stringify(batchMode
      ? batchGroupsView().map(g => (g.el ? describe(g.el) : g.picks))
      : selectedList)
    if (!cancelConfirmPending || cancelConfirmPending.sig !== sig) {
      cancelConfirmPending = { at: Date.now(), count, sig }
      if (panelEl) updatePanel(panelEl, currentTargetEl)
      return
    }
    // 太快的第二下（習慣性連按）不算；**不得重設計時**——重設的話每 300 毫秒按一次就永遠取消不了
    if (Date.now() - cancelConfirmPending.at < 400) return
  }
  cancelPick()
}

// 送出取消訊息並離開
function cancelPick() {
  const msg = { type: MSG.PICKED, purpose: currentPurpose, cancelled: true }
  if (currentTaskId !== undefined) msg.taskId = currentTaskId
  const purpose = currentPurpose
  chrome.runtime.sendMessage(msg)
  exitPickMode({ clearOnly: purpose })
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
    : tableOf(target)
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
  menuEl.style.backgroundColor = COLORS.surface
  menuEl.style.border = `1px solid ${COLORS.border}`
  menuEl.style.borderRadius = '4px'
  menuEl.style.padding = '4px 0'
  menuEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)'
  menuEl.style.zIndex = '2147483647'
  menuEl.style.pointerEvents = 'auto'

  const cellInfo = isTable ? resolveCell(target, tableEl) : null
  let matchedPickIndex = -1
  let matchedBlock = null
  // 只有滑鼠下的表就是已選那張表時才比對：blockCoversCell 只比索引，
  // 在 B 表上按右鍵會改到 A 表那一組的排除，而且錨定成 B 表的列標題（體檢抓到）
  if (cellInfo && selectedList.length > 0 && tableEl === pickedTableEl) {
    for (let i = selectedList.length - 1; i >= 0; i--) {
      const pick = selectedList[i]
      if (pick.block && blockCoversCell(pick.block, cellInfo.rIdx, cellInfo.cIdx)) {
        matchedPickIndex = i
        matchedBlock = pick.block
        break
      }
    }
  }
  menuTargetContext = { target, tableEl, cellInfo, targetPickIndex: matchedPickIndex }

  while (menuEl.firstChild) {
    menuEl.removeChild(menuEl.firstChild)
  }

  let excludeItem = null
  if (matchedBlock && cellInfo) {
    const isExcluded = isExcludedCell(matchedBlock, cellInfo.rIdx, cellInfo.cIdx)
    if (matchedBlock.axis === 'col') {
      excludeItem = isExcluded
        ? { key: 'include', label: '取消排除這一列' }
        : { key: 'exclude', label: '從整欄聚合排除這一列' }
    } else if (matchedBlock.axis === 'row') {
      excludeItem = isExcluded
        ? { key: 'include', label: '取消排除這一欄' }
        : { key: 'exclude', label: '從整列聚合排除這一欄' }
    }
  }

  const items = isTable
    ? [
        { key: 'cell', label: '選這一格' },
        { key: 'col-each', label: '這一欄：每格各一個值' },
        { key: 'col', label: '這一欄：整欄聚合成一個值' },
        { key: 'row-each', label: '這一列：每格各一個值' },
        { key: 'row', label: '這一列：整列聚合成一個值' },
        ...(excludeItem ? [excludeItem] : []),
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
    el.style.color = COLORS.text
    el.style.backgroundColor = COLORS.surface
    el.style.userSelect = 'none'
    el.style.transition = 'background-color 150ms ease'
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
  const inner = menuTargetContext.cellInfo?.inner
  // closeMenu 會把 menuTargetContext 清成 null：排除要改哪一個值得在關選單之前取出來
  const targetPickIndex = menuTargetContext.targetPickIndex
  closeMenu()

  if (action === 'done') {
    confirmPick()
    return
  }
  if (action === 'cancel') {
    requestCancel()
    return
  }
  if (action === 'element') {
    confirmPick()
    return
  }

  if (['cell', 'col-each', 'col', 'row-each', 'row'].includes(action)) {
    if (promoteBeforeAddingInOuter() === 'blocked') return
    if (!batchFollowTarget(tableEl)) {
      updatePanel(panelEl, currentTargetEl)
      return
    }
  }

  if (action === 'cell') {
    if (tableEl && isTableMode(tableEl)) {
      const info = cellInfo || (rowIndex !== null && colIndex !== null ? { rIdx: rowIndex, cIdx: colIndex, dataRows: resolveDataRows(tableEl) } : null)
      if (info) {
        addPick(makeCellPick(info.rIdx, info.cIdx, tableEl, info.dataRows, inner))
        applyPickedMarks(tableEl)
        updatePanel(panelEl, tableEl)
      }
    }
    return
  }

  if (action === 'col-each' || action === 'row-each') {
    if (tableEl && isTableMode(tableEl)) {
      const dataRows = resolveDataRows(tableEl)
      if (action === 'col-each') {
        const cIdx = cellInfo ? cellInfo.cIdx : (colIndex !== null ? colIndex : 0)
        const targetEl = (cellInfo && (cellInfo.subEl || cellInfo.cell)) || menuTargetContext?.target
        expandColEach(tableEl, cIdx, inner, targetEl, { toggle: false })
        return
      } else {
        const rIdx = cellInfo ? cellInfo.rIdx : (rowIndex !== null ? rowIndex : 0)
        // 逐格的網格起點（不是 0..DOM 格數）：無表頭＋colspan 的列會重複選同一格、漏掉最後一欄
        for (const c of dataRows[rIdx] ? gridStartsOf(dataRows[rIdx]) : []) {
          if (targetAtGrid(dataRows[rIdx], c, inner) !== null) {
            addPick(makeCellPick(rIdx, c, tableEl, dataRows, inner))
            if (limitReached) break
          }
        }
      }
      applyPickedMarks(tableEl)
      trimReady = true
      updatePanel(panelEl, tableEl)
    }
    return
  }

  if (action === 'col') {
    if (tableEl && isTableMode(tableEl)) {
      if (currentPurpose === 'task' && isSingleRowNestedTable(tableEl) && isUpgradeableTable(tableEl)) {
        if (selectedList.length > 0 && pickedTableEl === tableEl) {
          promotePicksToOuter(tableEl)
        }
        const O = outerTableOf(tableEl)
        if (O) {
          const oInfo = resolveCell(tableEl, O)
          if (oInfo && oInfo.cell && oInfo.cIdx !== null) {
            const C = oInfo.cIdx
            const oCell = oInfo.cell
            const targetEl = (cellInfo && (cellInfo.subEl || cellInfo.cell)) || oInfo.cell
            const fullInner = innerPathOf(oCell, targetEl)
            const block = { axis: 'col', index: C, headerText: columnHeaders(O)[C] || '' }
            putInner(block, fullInner)
            pendingFooterNotice = withFooterExclude(block, O)
            addPick({ block })
            pickedTableEl = O
            setTarget(O)
            deliberateTableEl = O
            const n = countResolvedInnerInCol(O, C, fullInner)
            toolbarNotice = promotedColNotice(n)
            applyPickedMarks(O)
            updatePanel(panelEl, O)
            return
          }
        }
      }
      const cIdx = cellInfo ? cellInfo.cIdx : (colIndex !== null ? colIndex : (currentCellIndex() !== null ? currentCellIndex() : 0))
      const block = { axis: 'col', index: cIdx, headerText: columnHeaders(tableEl)[cIdx] || '' }
      putInner(block, inner)
      pendingFooterNotice = withFooterExclude(block, tableEl)
      addPick({ block })
      applyPickedMarks(tableEl)
      if (isSingleRowNestedTable(tableEl)) {
        toolbarNotice = SINGLE_ROW_NESTED_TABLE_NOTICE
      }
      updatePanel(panelEl, tableEl)
    }
    return
  }

  if (action === 'row') {
    if (tableEl && isTableMode(tableEl)) {
      const dataRows = resolveDataRows(tableEl)
      const rIdx = cellInfo ? cellInfo.rIdx : (rowIndex !== null ? rowIndex : 0)
      const row = dataRows[rIdx]
      const block = { axis: 'row', index: rIdx, headerText: row ? rowHeader(row) : '' }
      putInner(block, inner)
      addPick({ block })
      applyPickedMarks(tableEl)
      updatePanel(panelEl, tableEl)
    }
    return
  }

  if (action === 'exclude' || action === 'include') {
    const pickIdx = targetPickIndex
    if (pickIdx !== undefined && pickIdx >= 0 && pickIdx < selectedList.length && cellInfo) {
      const oldPick = selectedList[pickIdx]
      if (oldPick && oldPick.block) {
        const newBlock = { ...oldPick.block }
        let currentExcludes = excludeOf(newBlock).map(item => ({ ...item }))
        if (newBlock.axis === 'col') {
          if (action === 'exclude') {
            if (!currentExcludes.some(x => x.index === cellInfo.rIdx)) {
              currentExcludes.push({ index: cellInfo.rIdx, header: cellInfo.row ? rowHeader(cellInfo.row) : '' })
            }
          } else {
            currentExcludes = currentExcludes.filter(x => x.index !== cellInfo.rIdx)
          }
        } else if (newBlock.axis === 'row') {
          if (action === 'exclude') {
            if (!currentExcludes.some(x => x.index === cellInfo.cIdx)) {
              currentExcludes.push({ index: cellInfo.cIdx, header: columnHeaders(tableEl)[cellInfo.cIdx] || '' })
            }
          } else {
            currentExcludes = currentExcludes.filter(x => x.index !== cellInfo.cIdx)
          }
        }
        delete newBlock.exclude
        putExclude(newBlock, currentExcludes)
        // 排除也是改動：留著快照的話 Ctrl+Z 會跳回排除之前，連這次的排除一起丟掉
        clearUndoSnapshot()
        selectedList = selectedList.slice()
        selectedList[pickIdx] = { ...oldPick, block: newBlock }
        applyPickedMarks(tableEl)
        updatePanel(panelEl, tableEl)
      }
    }
    return
  }
}

// 比較兩組格內子路徑是否相等（缺省、null、空陣列視為無子路徑）
function sameInner(a, b) {
  const hasA = hasInner(a)
  const hasB = hasInner(b)
  if (!hasA && !hasB) return true
  if (!hasA || !hasB) return false
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.tag !== b[i]?.tag || a[i]?.index !== b[i]?.index) return false
  }
  return true
}

// 加入單一儲存格至已選清單
function makeCellPick(r, c, tableEl, dataRows, inner) {
  const rows = dataRows || resolveDataRows(tableEl)
  const row = rows[r]
  const cell = {
    row: { index: r, header: row ? rowHeader(row) : '' },
    col: { index: c, header: columnHeaders(tableEl)[c] || '' }
  }
  putInner(cell, inner)
  return { cell }
}

// 判定兩個已選項是不是同一個值（儲存格比列欄索引與 inner，聚合比軸、索引與 inner）
function samePick(a, b) {
  if (a.cell && b.cell) {
    return a.cell.row.index === b.cell.row.index &&
      a.cell.col.index === b.cell.col.index &&
      sameInner(a.cell.inner, b.cell.inner)
  }
  if (a.block && b.block) {
    return a.block.axis === b.block.axis &&
      a.block.index === b.block.index &&
      sameInner(a.block.inner, b.block.inner)
  }
  return false
}

// 加入一個值：去重與上限的判斷只有這一份，所有加選路徑都走它
function addPick(pick) {
  trimReady = false
  const footer = pendingFooterNotice
  pendingFooterNotice = 0
  // 任何加選都讓復原快照失效（取代之後又加了東西，就沒有「上一步」可回了）
  clearUndoSnapshot()
  if (selectedList.some(p => samePick(p, pick))) return false
  if (selectedList.length >= maxPicks) {
    limitReached = true
    return false
  }
  selectedList.push(pick)
  // 只有整欄值會有表尾排除：候選值算好的待報數可能沒被消耗（點表頭只觸發「再點一次才取代」提示就早退），
  // 整欄的每個建立入口都會重算它，整列值撿到殘留的就不得說（體檢探針抓到）
  if (pick.block && pick.block.axis === 'col') footerNotice(footer)
  if (!pickedTableEl && currentTargetEl && isTableMode(currentTargetEl)) pickedTableEl = currentTargetEl
  return true
}

// 點擊：已經選過就取消（存復原快照），否則加入
function togglePick(pick) {
  trimReady = false
  const at = selectedList.findIndex(p => samePick(p, pick))
  if (at >= 0) {
    const previous = takeUndoSnapshot(selectedList, pickedTableEl)
    clearUndoSnapshot()
    selectedList.splice(at, 1)
    undoSnapshot = previous
    limitReached = false
    if (selectedList.length === 0) {
      pickedTableEl = null
      applyPickedMarks(currentTargetEl)
    } else {
      applyPickedMarks(pickedTableEl)
    }
    return
  }
  // 這一格已經算在某個整欄／整列值裡（本來就是藍框）：加成獨立的值是允許的（合計那一格單獨當一個值，AF-16），
  // 但不得無聲——指令句說「點已選的可取消」，這一下卻是加選，要講清楚（體檢抓到）
  const covering = pick.cell ? selectedList.find(p => p.block && blockCoversCell(p.block, pick.cell.row.index, pick.cell.col.index)) : null
  if (addPick(pick) && covering) {
    toolbarNotice = `這一格已經算在「${getPickName(covering)}」裡；現在另外加成獨立的一個值（再點一次取消）`
  }
}

function addCellPick(r, c, dataRows, inner) {
  if (targetAtGrid(dataRows[r], c, inner) !== null) {
    addPick(makeCellPick(r, c, currentTargetEl, dataRows, inner))
  }
}

// 判定欄索引是否在表格網格範圍內（至少有一列該欄有格子）
function isColInGrid(dataRows, cIdx) {
  return typeof cIdx === 'number' && cIdx >= 0 && dataRows.some(row => cellAtGridIndex(row, cIdx) !== null)
}

// 套用預選項
// 位置定位（第一筆／最後一筆／倒數第二筆）換算成當下的索引；不是位置定位就回 null。
// 判定與 shared/extract.js 的 resolveByPosition 同一套規則。
function posIndexOf(pos, count) {
  if (pos !== 'first' && pos !== 'last' && pos !== 'last-1') return null
  const idx = resolveByPosition(pos, count)
  return idx >= 0 ? idx : null
}

// preselect 帶回來的排除項以標題勾回：搬家跟著標題走、找不到就略過那一項；兩種都亮「位置已變」
function relocateExcludes(block, headers, count, axis) {
  const out = []
  for (const item of excludeOf(block)) {
    const loc = locateByHeader(headers, item, count, axis)
    if (!loc.ok || typeof loc.index !== 'number' || loc.index < 0 || loc.index >= count) {
      headerChangedNotice = true
      continue
    }
    if (loc.index !== item.index) headerChangedNotice = true
    out.push({ index: loc.index, header: headers[loc.index] || item.header })
  }
  return out
}

function applyPreselect(preselect, tableEl) {
  if (!Array.isArray(preselect) || !tableEl || !isTableMode(tableEl)) return
  const dataRows = resolveDataRows(tableEl)
  const colHeaders = columnHeaders(tableEl)
  const rowHeaders = dataRows.map((row) => rowHeader(row))

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

      // 用位置定位的軸要以當下的筆數重算索引，不比對標題
      // （標題正是因為會變才改用位置的）
      const rPos = posIndexOf(item.cell.row?.pos, dataRows.length)
      if (rPos !== null) { rIdx = rPos; rHeader = '' }
      const cPos = posIndexOf(item.cell.col?.pos, colHeaders.length)
      if (cPos !== null) { cIdx = cPos; cHeader = '' }

      // 勾回既有的值要與擷取端同一份定位（extract.js 的 locateByHeader）：
      // 文字標題不見了就略過這個值；純數值標題不見或重複就退回索引（AF-14）
      if (cHeader) {
        const loc = locateByHeader(colHeaders, { index: cIdx, header: cHeader }, colHeaders.length, 'col')
        if (!loc.ok) continue
        if (loc.index !== cIdx) {
          headerChangedNotice = true
          cIdx = loc.index
        }
      }
      if (rHeader) {
        const loc = locateByHeader(rowHeaders, { index: rIdx, header: rHeader }, dataRows.length, 'row')
        if (!loc.ok) continue
        if (loc.index !== rIdx) {
          headerChangedNotice = true
          rIdx = loc.index
        }
      }

      if (rIdx !== null && cIdx !== null && rIdx >= 0 && rIdx < dataRows.length && isColInGrid(dataRows, cIdx)) {
        if (hasInner(item.cell.inner)) {
          if (targetAtGrid(dataRows[rIdx], cIdx, item.cell.inner) === null) {
            headerChangedNotice = true
            continue
          }
        }
        const targetRow = dataRows[rIdx]
        const actualRowHeader = rHeader || (targetRow ? rowHeader(targetRow) : '')
        const actualColHeader = cHeader || (colHeaders[cIdx] || '')
        const cell = {
          row: { index: rIdx, header: actualRowHeader },
          col: { index: cIdx, header: actualColHeader }
        }
        putInner(cell, item.cell.inner)
        addPick({ cell })
      }
    } else if (item.block) {
      const axis = item.block.axis
      let bIdx = item.block.index
      const bHeader = item.block.headerText || ''

      if (axis === 'col') {
        if (bHeader) {
          const loc = locateByHeader(colHeaders, { index: bIdx, header: bHeader }, colHeaders.length, 'col')
          if (!loc.ok) continue
          if (loc.index !== bIdx) {
            headerChangedNotice = true
            bIdx = loc.index
          }
        }
        if (bIdx !== null && isColInGrid(dataRows, bIdx)) {
          if (hasInner(item.block.inner)) {
            if (!dataRows.some(row => targetAtGrid(row, bIdx, item.block.inner) !== null)) {
              headerChangedNotice = true
              continue
            }
          }
          const block = { axis: 'col', index: bIdx, headerText: bHeader || colHeaders[bIdx] || '' }
          putInner(block, item.block.inner)
          // 表尾不在這裡自動加：使用者之前取消過的排除不能復活
          putExclude(block, relocateExcludes(item.block, rowHeaders, dataRows.length, 'row'))
          addPick({ block })
        }
      } else if (axis === 'row') {
        if (bHeader) {
          const loc = locateByHeader(rowHeaders, { index: bIdx, header: bHeader }, dataRows.length, 'row')
          if (!loc.ok) continue
          if (loc.index !== bIdx) {
            headerChangedNotice = true
            bIdx = loc.index
          }
        }
        if (bIdx !== null && bIdx >= 0 && bIdx < dataRows.length) {
          if (hasInner(item.block.inner)) {
            const row = dataRows[bIdx]
            if (!row || !getRowCells(row).some(cell => targetAtGrid(row, gridIndexOf(row, cell), item.block.inner) !== null)) {
              headerChangedNotice = true
              continue
            }
          }
          const block = { axis: 'row', index: bIdx, headerText: bHeader || rowHeader(dataRows[bIdx]) || '' }
          putInner(block, item.block.inner)
          putExclude(block, relocateExcludes(item.block, colHeaders, colHeaders.length, 'col'))
          addPick({ block })
        }
      }
    }
  }
}

/**
 * 面板閃避：游標靠近面板 24px 內就換到另一角。
 * 面板本身正在被使用（滑鼠在它上面、或它裡面有焦點）時不動——
 * 移動會讓使用者按到一半的按鈕跑掉。
 */
const PANEL_AVOID_MARGIN = 24
function avoidPanel(event) {
  if (!panelEl || !panelEl.getBoundingClientRect) return
  if (overlayEl && panelEl.contains(event.target)) return
  const focused = typeof document !== 'undefined' ? document.activeElement : null
  if (focused && panelEl.contains(focused)) return
  const r = panelEl.getBoundingClientRect()
  if (!r || (r.width === 0 && r.height === 0)) return
  const near = event.clientX >= r.left - PANEL_AVOID_MARGIN &&
    event.clientX <= r.right + PANEL_AVOID_MARGIN &&
    event.clientY >= r.top - PANEL_AVOID_MARGIN &&
    event.clientY <= r.bottom + PANEL_AVOID_MARGIN
  if (!near) {
    // 離開之後才解除鎖定，否則游標沿著面板邊緣走會左右來回彈跳
    panelAvoidLatched = false
    return
  }
  if (panelAvoidLatched) return
  panelAvoidLatched = true
  setPanelCorner(panelCorner === 'right' ? 'left' : 'right')
}

function setPanelCorner(corner) {
  panelCorner = corner
  if (!panelEl) return
  if (corner === 'left') {
    panelEl.style.left = '16px'
    panelEl.style.right = ''
  } else {
    panelEl.style.right = '16px'
    panelEl.style.left = ''
  }
}

// 事件監聽處理常式
function onMouseMove(event) {
  if (!active) return
  let target = event.target
  avoidPanel(event)
  syncProxyRects()
  // 指標已經離開讓路的那個元素：把代理層裝回去，不然 iframe 從此選不到
  if (yieldedEl && !stillOnYielded(target)) rearmProxies()
  // 指在代理層上時先問一次底下真正是什麼：疊在 iframe 上的下拉選單要還給頁面
  if (frameOfProxy(target)) {
    const covered = yieldProxyIfCovered(target, event)
    if (covered) target = covered
  }
  // overlay 自己的元素一律跳過，唯一例外是 iframe 的代理層——它就是為了被指到才貼的
  const isProxy = !!frameOfProxy(target)
  if (!target || (!isProxy && overlayEl && (target === overlayEl || overlayEl.contains(target)))) return

  if (dragStart && event.buttons === 1 && currentTargetEl && isTableMode(currentTargetEl)) {
    const info = resolveCell(target, currentTargetEl)
    if (info && (info.rIdx !== dragStart.rIdx || info.cIdx !== dragStart.cIdx)) {
      isDragging = true
    }
  }

  // 鎖定中：目標不再跟著滑鼠跑（點一下選取之後滑鼠移開，選的還是那一個）
  if (lockedEl) return

  const upgraded = upgradeTarget(target)
  if (deliberateTableEl && isTableMode(upgraded) &&
      !deliberateTableEl.contains(upgraded) && !upgraded.contains(deliberateTableEl)) {
    deliberateTableEl = null
  }
  if (upgraded !== currentTargetEl) {
    backStack = []
    setTarget(upgraded)
  }
  if (currentTargetEl && isTableMode(currentTargetEl) && (currentTargetEl === target || currentTargetEl.contains(target))) {
    handleTableMouseMove(target)
  }
}

function onKeyDown(event) {
  if (!active) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (event.repeat) return
    requestCancel()
    return
  }
  cancelConfirmPending = null
  if (event.key === 'Backspace' || event.key === 'Delete') {
    // 沒有東西可移除就放給頁面：選取模式可能開在有輸入框的頁面上（例如站台登入設定）
    if (selectedList.length > 0) {
      event.preventDefault()
      removeLastPick()
    }
  } else if (event.key === 'Enter') {
    // 焦點在面板的按鈕上時，Enter 是「按那顆按鈕」，不是「送出」——
    // 焦點停在「取消」上卻送出，是鍵盤使用者最容易踩到的陷阱
    // 只有「完成／取消」這兩顆要讓 Enter 交給按鈕（它們本來就會結束流程）；
    // 工具列與「移除最後一項」不能列進來——點過它們焦點就留在上面（頁面上的 mousedown
    // 都被擋掉，焦點永遠不會離開），列進來等於碰過工具列之後 Enter 就再也不能送出
    const focused = document?.activeElement
    if (focused && typeof focused.closest === 'function' &&
        (focused.closest('[data-af-cancel]') || focused.closest('[data-af-done]'))) {
      return
    }
    if (!currentTargetEl) return
    event.preventDefault()
    // 還沒選就按 Enter：把滑鼠停著的那一個選起來再送（鍵盤使用者不必先點一下）
    // 批次模式已有組時不補選（Enter 是「完成這一批」，不是再加一組）
    if (selectedCount() === 0 && isTableMode(currentTargetEl) && (currentHoverEl || currentCellEl)) {
      if (pickMode === 'colEach') {
        const cIdx = colIndex !== null ? colIndex : 0
        const resolved = resolveColEachCells(currentTargetEl, cIdx, currentInner, currentHoverEl || currentCellEl)
        if (resolved) {
          for (const p of resolved.picks) {
            addPick(p)
            if (limitReached) break
          }
        }
      } else {
        const candidate = candidateAt(currentHoverEl || currentCellEl)
        if (candidate) addPick(candidate)
      }
    }
    confirmPick()
  } else if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
    // Ctrl／⌘＋A：全選這張表的資料格（取代整批，留復原快照）
    if (!isMultiPickPurpose() || !currentTargetEl || !isTableMode(currentTargetEl)) return
    event.preventDefault()
    const dataRows = resolveDataRows(currentTargetEl)
    if (dataRows.length === 0) return
    if (!batchFollowTarget(currentTargetEl)) {
      updatePanel(panelEl, currentTargetEl)
      return
    }
    const previous = takeUndoSnapshot(selectedList, pickedTableEl)
    clearPickedMarks(document)
    selectedList = []
    limitReached = false
    pickedTableEl = null
    // 全選的是整格：hover 時算出的子單位路徑要清掉，否則接著 Tab／Shift＋方向鍵會沿它框子元素
    currentInner = null
    let scanned = 0
    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r]
      const cells = getRowCells(row)
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i]
        // 列標題那一格不是資料（它是這一列的名字），全選不該把它算進來
        if (isHeaderCell(cell)) continue
        const cIdx = gridIndexOf(row, cell)
        if (cIdx >= 0) {
          scanned++
          if (!limitReached) {
            addPick(makeCellPick(r, cIdx, currentTargetEl, dataRows))
          }
        }
      }
    }
    selectAllNotice = scanned > selectedList.length ? { scanned, taken: selectedList.length } : null
    undoSnapshot = previous
    clearPendingConfirms()
    if (selectedList.length > 0 && pickedTableEl) {
      applyPickedMarks(pickedTableEl)
    } else {
      applyPickedMarks(currentTargetEl)
    }
    updatePanel(panelEl, currentTargetEl)
  } else if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
    // Ctrl／⌘＋Z：**先還原上一次取代**（那是最容易誤觸、損失最大的動作），
    // 沒有可還原的取代才退回「移除最後一項」；兩者都沒有就把按鍵放給頁面
    if (undoSnapshot) {
      event.preventDefault()
      undoReplace()
      updatePanel(panelEl, currentTargetEl)
      return
    }
    if (selectedList.length === 0) return
    event.preventDefault()
    removeLastPick(false)
  } else if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    if (currentTargetEl && isTableMode(currentTargetEl) && isMultiPickPurpose()) {
      event.preventDefault()
      const dataRows = resolveDataRows(currentTargetEl)
      if (dataRows.length > 0) {
        const curR = rowIndex !== null ? rowIndex : 0
        const curC = colIndex !== null ? colIndex : 0
        // 最右能走到的是最後一格的網格起點（colspan 之後 DOM 格數小於網格寬）
        const lastCol = Math.max(0, ...gridStartsOf(dataRows[curR] || dataRows[0]))

        // 與點擊／拖曳／右鍵同一套守門（體檢抓到：這條路漏了，滑鼠停在另一張表時會把那張表的索引塞進已選的組）
        if (promoteBeforeAddingInOuter() === 'blocked') return
        if (!batchFollowTarget(currentTargetEl)) {
          updatePanel(panelEl, currentTargetEl)
          return
        }
        if (selectedList.length > 0 && pickedTableEl && currentTargetEl !== pickedTableEl) {
          toolbarNotice = '一個任務只能抓同一張表格裡的值；要改抓另一張表，直接點那一格'
          updatePanel(panelEl, currentTargetEl)
          return
        }

        addCellPick(curR, curC, dataRows, currentInner)

        let newR = curR
        let newC = curC
        if (event.key === 'ArrowRight') newC = Math.min(lastCol, curC + 1)
        else if (event.key === 'ArrowLeft') newC = Math.max(0, curC - 1)
        else if (event.key === 'ArrowDown') newR = Math.min(dataRows.length - 1, curR + 1)
        else if (event.key === 'ArrowUp') newR = Math.max(0, curR - 1)

        rowIndex = newR
        colIndex = newC
        cellIndex = pickMode === 'row' ? rowIndex : colIndex
        currentRowEl = dataRows[rowIndex]
        currentCellEl = currentRowEl ? cellAtGridIndex(currentRowEl, colIndex) : null

        addCellPick(newR, newC, dataRows, currentInner)
        if (selectedList.length > 0 && pickedTableEl) {
          applyPickedMarks(pickedTableEl)
        } else {
          applyPickedMarks(currentTargetEl)
        }
        markCells(currentCellEl, dataRows, currentRowEl, pickMode, colIndex, currentInner)
        updatePanel(panelEl, currentTargetEl)
      }
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!currentTargetEl || currentTargetEl === document.body) return
    const lastHover = currentHoverEl

    // 觸發 3：已選非空時按 ↑（只在 pickedTableEl 是 T、而且 T 有 O 時套用；其他情況 ↑ 行為完全不變）
    if (selectedList.length > 0 && pickedTableEl) {
      const T = pickedTableEl
      const O = outerTableOf(T)
      if (O) {
        // 值升不上去時 ↑ 照樣離開這張表（AF-10 C-5：↑ 是明確意圖，不被鎖表擋住），
        // 只是說清楚已選的值還留在小表：接著點外層的格子是換表（留得住復原），不是加選
        if (currentPurpose === 'repick') {
          toolbarNotice = REPICK_NO_PROMOTE_NOTICE
        } else if (currentPurpose === 'task' && !isUpgradeableTable(T)) {
          toolbarNotice = '外層不是每一列重複同一種小表的表格，已選的值留在原表；點外層的格子會換表'
        } else if (currentPurpose === 'task' && !promotePicksToOuter(T)) {
          toolbarNotice = CANNOT_PROMOTE_NOTICE
        } else if (currentPurpose === 'task') {
          backStack.push(T)
          if (isTableMode(currentTargetEl) && lastHover && currentTargetEl.contains(lastHover)) {
            handleTableMouseMove(lastHover)
          }
          if (panelEl) updatePanel(panelEl, currentTargetEl)
          return
        }
      }
    }

    // 指在代理層時往上要走 iframe 的父層；代理層自己的父層是我們的 overlay
    const anchor = frameOfProxy(currentTargetEl) || currentTargetEl
    if (anchor.parentElement) {
      // `↑` 是使用者明確要換目標（滑鼠路過才需要鎖表保護），不套鎖表
      backStack.push(currentTargetEl)
      const nextTarget = upgradeTarget(anchor.parentElement, { deliberate: true })
      setTarget(nextTarget)
      if (isTableMode(nextTarget)) {
        deliberateTableEl = nextTarget
      } else {
        deliberateTableEl = null
      }
      relockAfterMove()
      if (isTableMode(currentTargetEl) && lastHover && currentTargetEl.contains(lastHover)) {
        handleTableMouseMove(lastHover)
      }
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (backStack.length > 0) {
      const nextTarget = backStack[backStack.length - 1]
      if (selectedList.length > 0 && pickedTableEl && pickedTableEl === currentTargetEl &&
          nextTarget && currentTargetEl.contains(nextTarget)) {
        toolbarNotice = '已選的值在外層表；要回小表請先移除已選'
        if (panelEl) updatePanel(panelEl, currentTargetEl)
        return
      }
      const lastHover = currentHoverEl
      backStack.pop()
      setTarget(nextTarget)
      if (isTableMode(nextTarget)) {
        deliberateTableEl = nextTarget
      } else {
        deliberateTableEl = null
      }
      relockAfterMove()
      if (isTableMode(currentTargetEl) && lastHover && currentTargetEl.contains(lastHover)) {
        handleTableMouseMove(lastHover)
      }
    }
  } else if (event.key === 'Tab') {
    if (currentTargetEl && isTableMode(currentTargetEl)) {
      event.preventDefault()
      const modes = ['cell', 'col', 'colEach', 'row']
      const availableModes = isMultiPickPurpose() ? modes : ['cell']
      if (availableModes.length > 1) {
        const curIdx = availableModes.indexOf(pickMode)
        const nextIdx = (curIdx + 1) % availableModes.length
        pickMode = availableModes[nextIdx]
        cellIndex = pickMode === 'row' ? rowIndex : colIndex
        updateToolbar()
        markCells(currentCellEl, currentDataRows, currentRowEl, pickMode, colIndex, currentInner)
        if (selectedList.length > 0 && pickedTableEl) {
          applyPickedMarks(pickedTableEl)
        } else {
          applyPickedMarks(currentTargetEl)
        }
        updatePanel(panelEl, currentTargetEl)
      }
    }
  }
}

// 鎖定的是「不跟著滑鼠跑」，不是凍結目標：↑↓ 換了目標之後鎖要跟過去，
// 否則面板的「已鎖定」說明會消失，但滑鼠其實還是動不了。
// setTarget 內部已經畫過一次面板，所以要在改完之後再畫一次。
function relockAfterMove() {
  if (!lockedEl) return
  // 鎖只對非表格元素有意義：走到表格或代理層上就放掉，否則 onMouseMove 一直提早 return、
  // onClick 的表格分支又不會清它，hover 標示從此凍住
  if (currentTargetEl && (isTableMode(currentTargetEl) || iframeOf(currentTargetEl))) {
    lockedEl = null
  } else {
    lockedEl = currentTargetEl
  }
  updatePanel(panelEl, currentTargetEl)
}

function onClick(event) {
  if (!active) return
  event.preventDefault(); event.stopPropagation()

  if (suppressClick) {
    return
  }

  // 1. 右鍵選單處理
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

  // 2. 工具列按鈕點擊
  const toolBtn = event.target && event.target.closest ? event.target.closest('[data-af-tool]') : null
  if (toolBtn) {
    if (toolBtn.getAttribute('aria-disabled') === 'true') {
      // 靜默 return 會讓使用者以為模式切了（實際沒切），要說出點不動的原因
      const mode = toolBtn.getAttribute('data-af-tool')
      // 點工具列＝使用者要重新挑目標，先前點非表格元素造成的鎖定一律解除；
      // 鎖著的話滑鼠移到表格上也完全沒有反應，看起來就是「工具列壞了」
      lockedEl = null
      // 點「單格」＝改變主意了，先前記住的整欄／整列意圖要一起取消，
      // 否則滑鼠一移到表格上還是會自動切成整欄
      if (mode === 'cell') {
        pendingMode = null
        toolbarNotice = null
        if (panelEl) updatePanel(panelEl, currentTargetEl)
        return
      }
      if (!isMultiPickPurpose()) {
        toolbarNotice = '這個用途一次只選一個元素'
      } else {
        const onTable = Boolean(currentTargetEl && isTableMode(currentTargetEl))
        if (!onTable) {
          // 停用的真正原因是「這裡不是表格」，與用途無關；
          // 說成「一次只選一個」會跟面板上一行的「非表格：抓整個元素」自相矛盾
          if (mode === 'col' || mode === 'colEach' || mode === 'row') {
            pendingMode = mode
            toolbarNotice = `先把滑鼠移到表格上，會自動切成${mode === 'row' ? '整列' : '整欄'}`
          } else {
            toolbarNotice = '先把滑鼠移到表格上'
          }
        }
      }
      if (panelEl) updatePanel(panelEl, currentTargetEl)
      return
    }
    // 焦點不留在工具列上：留著的話之後的 Enter／Space 會再按一次同一顆
    if (typeof toolBtn.blur === 'function') toolBtn.blur()
    const mode = toolBtn.getAttribute('data-af-tool')
    if (mode && (mode === 'cell' || mode === 'col' || mode === 'colEach' || mode === 'row')) {
      pickMode = mode
      cellIndex = pickMode === 'row' ? rowIndex : colIndex
      toolbarNotice = null
      pendingMode = null
      if (mode === 'colEach') {
        if (selectedList.length > 0 && selectedList[selectedList.length - 1].cell) {
          const last = selectedList[selectedList.length - 1]
          const table = pickedTableEl || currentTargetEl
          if (table && isTableMode(table)) {
            const previous = takeUndoSnapshot(selectedList, pickedTableEl)
            selectedList = selectedList.slice(0, -1)
            expandColEach(table, last.cell.col.index, last.cell.inner || null, null, { replaceSnapshot: previous, toggle: false })
          }
        }
      } else {
        // 已選的最後一項是單一儲存格時，切整欄／整列＝把那一格升級成整欄／整列
        upgradeLastPickTo(mode)
      }
      updateToolbar()
      if (currentTargetEl && isTableMode(currentTargetEl)) {
        markCells(currentCellEl, currentDataRows, currentRowEl, pickMode, colIndex, currentInner)
        if (selectedList.length > 0 && pickedTableEl) {
          applyPickedMarks(pickedTableEl)
        } else {
          applyPickedMarks(currentTargetEl)
        }
      }
      if (mode === 'col' && isSingleRowNestedTable(currentTargetEl)) {
        if (!toolbarNotice && !(currentPurpose === 'task' && isUpgradeableTable(currentTargetEl))) {
          toolbarNotice = SINGLE_ROW_NESTED_TABLE_NOTICE
        }
      }
      if (panelEl) updatePanel(panelEl, currentTargetEl)
    }
    return
  }

  // 3. 已選清單 chip 移除鈕點擊
  const chipRemoveBtn = event.target && event.target.closest ? event.target.closest('[data-af-chip-remove]') : null
  if (chipRemoveBtn) {
    const chipEl = chipRemoveBtn.closest('[data-af-chip]')
    if (chipEl) {
      const idx = parseInt(chipEl.getAttribute('data-af-chip'), 10)
      const groupEl = chipEl.closest('[data-af-group]')
      if (!isNaN(idx) && groupEl) {
        // 批次模式：× 移除的是那一組的那個值（元素組只有一個值＝整組）
        const gi = parseInt(groupEl.getAttribute('data-af-group'), 10)
        syncBatch()
        const g = batchGroups[gi]
        if (g && g.el) {
          removeBatchGroup(gi)
        } else if (g) {
          if (gi !== currentGroupIdx) loadBatchGroup(gi)
          removePickAt(idx)
        }
      } else if (!isNaN(idx)) {
        removePickAt(idx)
      }
    }
    return
  }

  // 3a. 批次模式的整組移除鈕
  const groupRemoveBtn = event.target && event.target.closest ? event.target.closest('[data-af-group-remove]') : null
  if (groupRemoveBtn) {
    const groupEl = groupRemoveBtn.closest('[data-af-group]')
    const gi = groupEl ? parseInt(groupEl.getAttribute('data-af-group'), 10) : NaN
    if (!isNaN(gi)) removeBatchGroup(gi)
    return
  }

  // 3b. 面板「復原」按鈕：還原上一次取代
  const undoBtn = event.target && event.target.closest ? event.target.closest('[data-af-undo]') : null
  if (undoBtn) {
    if (undoReplace()) updatePanel(panelEl, currentTargetEl)
    return
  }

  // 3c. 每格各一個值之後的「去掉第一格／最後一格」：可連按，Ctrl+Z 反悔一步
  const trimBtn = event.target && event.target.closest ? event.target.closest('[data-af-trim-head], [data-af-trim-tail]') : null
  if (trimBtn) {
    if (trimBtn.getAttribute('aria-disabled') === 'true' || selectedList.length <= 1) {
      // 停用的鈕被點到不得靜默：說出為什麼不能再去掉
      toolbarNotice = '只剩一個值了，不能再去掉'
    } else {
      const previous = takeUndoSnapshot(selectedList, pickedTableEl)
      clearPickedMarks(document)
      selectedList = trimBtn.hasAttribute('data-af-trim-head') ? selectedList.slice(1) : selectedList.slice(0, -1)
      undoSnapshot = previous
      limitReached = selectedList.length >= maxPicks
      applyPickedMarks(pickedTableEl || currentTargetEl)
    }
    updatePanel(panelEl, currentTargetEl)
    return
  }

  // 4. 面板「移除最後一項」按鈕點擊
  const removeLastBtn = event.target && event.target.closest ? event.target.closest('[data-af-remove-last]') : null
  if (removeLastBtn) {
    removeLastPick()
    return
  }

  // 4b. 面板的「完成」與「取消」：畫面上看得見的出口
  const doneBtn = event.target && event.target.closest ? event.target.closest('[data-af-done]') : null
  if (doneBtn) {
    if (doneBtn.getAttribute('aria-disabled') !== 'true') confirmPick()
    return
  }
  const cancelBtn = event.target && event.target.closest ? event.target.closest('[data-af-cancel]') : null
  if (cancelBtn) {
    requestCancel()
    return
  }

  // 4c. 點 chip 本體（捲進畫面並加粗外框提示 1 秒）
  const chipEl = event.target && event.target.closest ? event.target.closest('[data-af-chip]') : null
  if (chipEl) {
    const cells = cellsOfChip(chipEl)
    if (cells.length > 0) {
      if (typeof cells[0].scrollIntoView === 'function') {
        cells[0].scrollIntoView({ block: 'nearest' })
      }
      for (const cell of cells) {
        if (cell._afPrevOutline === undefined) {
          cell._afPrevOutline = cell.style.outline
        }
        cell.setAttribute('data-af-chip-hover', '')
        trackChipHover(cell)
        cell.style.outline = `3px solid ${COLORS.primary}`
        if (cell._afHoverTimer) clearTimeout(cell._afHoverTimer)
        cell._afHoverTimer = setTimeout(() => {
          cell.removeAttribute('data-af-chip-hover')
          if (cell._afPrevOutline !== undefined) {
            cell.style.outline = cell._afPrevOutline
            delete cell._afPrevOutline
          }
          delete cell._afHoverTimer
        }, 1000)
      }
    }
    return
  }

  // 5. 面板或工具列本身的其餘點擊（絕對不可以送出確認）
  if (panelEl && (event.target === panelEl || panelEl.contains(event.target))) {
    return
  }
  if (toolbarEl && (event.target === toolbarEl || toolbarEl.contains(event.target))) {
    return
  }
  // overlay 自己的點擊（非代理層）也不得送出
  if (overlayEl && (event.target === overlayEl || (overlayEl.contains(event.target) && !frameOfProxy(event.target)))) {
    return
  }

  if (!currentTargetEl && event.target && (!overlayEl || (!overlayEl.contains(event.target) && event.target !== overlayEl))) {
    setTarget(event.target)
  }
  if (!currentTargetEl) return

  // 已選值後目標被鎖在某張表，點到那張表以外（例如外層表的格子）：什麼都不做。
  // 往下落會走到第 8 段直接送出，等於點外層一下就把內層的已選送走了
  if (isTableMode(currentTargetEl) && isMultiPickPurpose() &&
      !currentTargetEl.contains(event.target) && !frameOfProxy(event.target)) {
    // 批次模式：已選的表鎖住了 hover，但點到非表格元素就是要把它加成（或移除）一組
    if (batchMode) {
      const el = upgradeTarget(event.target, { deliberate: true })
      if (el && !isTableMode(el) && !iframeOf(el)) {
        batchClickElement(el)
        return
      }
    }
    const additive = event.ctrlKey || event.metaKey
    if (additive && pickedTableEl && currentPurpose === 'repick') {
      const o = outerTableOf(pickedTableEl)
      if (o && o.contains(event.target)) {
        toolbarNotice = REPICK_NO_PROMOTE_NOTICE
        applyPickedMarks(pickedTableEl)
        if (panelEl) updatePanel(panelEl, currentTargetEl)
        return
      }
    }
    return
  }

  // 6. 表格內的點擊：選取，不送出（送出走雙擊、Enter 或「完成」鈕）
  if (isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)) {
    // 觸發 2：目標是 O 時點擊（一般點、Ctrl 點、Shift 點）——先換算
    const promoted = promoteBeforeAddingInOuter()
    if (promoted === 'blocked') return
    const justPromoted = promoted === 'promoted'

    // 觸發 1：單列小表上整欄模式點格（已選在 T 的先換算；換算不了就維持現況行為）
    if (pickMode === 'col' && currentPurpose === 'task' &&
        isSingleRowNestedTable(currentTargetEl) && isUpgradeableTable(currentTargetEl)) {
      if (selectedList.length > 0 && pickedTableEl === currentTargetEl) {
        promotePicksToOuter(currentTargetEl)
      }
    }

    handleTableMouseMove(event.target)

    // 一次只選一個的用途（前置動作、登入）：維持點一下就送出
    if (!isMultiPickPurpose()) {
      const candidate = candidateAt(event.target)
      if (candidate) {
        if (!addPick(candidate)) {
          if (selectedList.length > 0 && pickedTableEl) {
            applyPickedMarks(pickedTableEl)
          } else {
            applyPickedMarks(currentTargetEl)
          }
          updatePanel(panelEl, currentTargetEl)
          return
        }
        confirmPick()
        return
      }
      return
    }

    const additive = event.ctrlKey || event.metaKey

    // 批次模式的換表：切到那張表的組（沒有就開新的一組），再照原本語意處理這一下
    if (!batchFollowTarget(currentTargetEl)) {
      updatePanel(panelEl, currentTargetEl)
      return
    }

    // 換表判定：已選的值屬於另一張不相干的表格
    if (selectedList.length > 0 && pickedTableEl && currentTargetEl !== pickedTableEl) {
      if (additive) {
        const o = outerTableOf(pickedTableEl)
        if (currentPurpose === 'repick' && o && (currentTargetEl === o || o.contains(currentTargetEl))) {
          toolbarNotice = REPICK_NO_PROMOTE_NOTICE
        } else {
          toolbarNotice = '一個任務只能抓同一張表格裡的值；要改抓另一張表，直接點那一格'
        }
        applyPickedMarks(pickedTableEl)
        updatePanel(panelEl, currentTargetEl)
        return
      }

      // 一般點走 replaceSelection
      const candidate = candidateAt(event.target)
      if (candidate) {
        const key = pickKey(candidate)
        if (selectedList.length >= 2 && replaceConfirmPending !== key) {
          replaceConfirmPending = key
          cancelConfirmPending = null
          applyPickedMarks(pickedTableEl)
          updatePanel(panelEl, currentTargetEl)
          return
        }
        replaceConfirmPending = null
        replaceSelection(candidate)
        applyPickedMarks(pickedTableEl || currentTargetEl)
        updatePanel(panelEl, currentTargetEl)
        return
      }
      return
    }

    // 同一張表格內的點擊：
    if (pickMode === 'colEach') {
      const head = resolveHeaderTarget(event.target, currentTargetEl)
      let cIdx = null, inner = null, targetEl = event.target
      if (head && head.axis === 'col') {
        cIdx = head.index
        inner = null
      } else {
        const info = resolveCell(event.target, currentTargetEl)
        if (info) {
          cIdx = info.cIdx
          inner = info.inner || null
          targetEl = info.subEl || info.cell || event.target
        }
      }
      if (cIdx !== null) {
        clearPendingConfirms()
        expandColEach(currentTargetEl, cIdx, inner, targetEl, { toggle: true })
        return
      }
      return
    }

    const candidate = candidateAt(event.target)
    if (candidate) {
      const singleColTrigger = Boolean(pickMode === 'col' && currentPurpose === 'task' &&
        isSingleRowNestedTable(currentTargetEl) && isUpgradeableTable(currentTargetEl))
      let colO = null
      if (singleColTrigger) {
        colO = outerTableOf(currentTargetEl)
      }

      const snapToPreserve = (justPromoted ? undoSnapshot : null)
      clearPendingConfirms()

      if (event.shiftKey && lastCellPick() && candidate.cell) {
        // Shift 點：從上一個已選的格子拉出矩形範圍
        addRange(lastCellPick(), candidate.cell)
      } else {
        // 無修飾鍵或 Ctrl／⌘ 點：togglePick（沒選過就加、選過就取消）
        togglePick(candidate)
      }

      if (snapToPreserve) {
        undoSnapshot = snapToPreserve
      }

      if (singleColTrigger && colO && candidate.block) {
        pickedTableEl = colO
        setTarget(colO)
        deliberateTableEl = colO
        const n = countResolvedInnerInCol(colO, candidate.block.index, candidate.block.inner)
        toolbarNotice = promotedColNotice(n)
      }

      if (selectedList.length > 0 && pickedTableEl) {
        applyPickedMarks(pickedTableEl)
      } else {
        applyPickedMarks(currentTargetEl)
      }
      updatePanel(panelEl, currentTargetEl)
      return
    }
    // 點在表格內但不是任何一格（格子之間的縫、表格的邊）：什麼都不做。
    // 送出會把使用者沒選的東西存起來，鎖定會讓 hover 標示凍在原地，兩個都不對
    if (isMultiPickPurpose()) return
  }

  // 7. 非表格：點一下鎖定這個元素（再點別處解除），不送出。
  // 表格不走這條——點在表格的縫隙（格子解析不出來）不該把整張表鎖住，
  // 那會讓 hover 標示凍結在原地，看起來像整個選取模式壞了
  if (isMultiPickPurpose() && !isTableMode(currentTargetEl) && !iframeOf(currentTargetEl)) {
    // 使用者選的是「整欄／整列」，這裡卻不是表格：鎖定它、之後送出整個元素，
    // 等於把他選的模式靜靜丟掉（工具列還亮著整欄）。說出來，不要照做。
    if (pickMode === 'col' || pickMode === 'colEach' || pickMode === 'row') {
      toolbarNotice = nonTableModeNotice()
      updatePanel(panelEl, currentTargetEl)
      return
    }
    // 批次模式不使用鎖定：點一下＝加成一組／再點＝移除那一組
    if (batchMode) {
      batchClickElement(currentTargetEl)
      return
    }
    if (lockedEl) {
      lockedEl = null
      if (event.target && (!overlayEl || !overlayEl.contains(event.target))) setTarget(upgradeTarget(event.target))
    } else {
      lockedEl = currentTargetEl
    }
    updatePanel(panelEl, currentTargetEl)
    return
  }

  // 8. iframe 代理層與一次一個的用途：點一下就送出（鑽進框架是導覽，不是選取）
  // 批次模式已有組時點到框架：不下鑽、也不送出，說明原因
  if (iframeOf(event.target) && batchBlocksDescend()) return
  confirmPick()
}

// 已選清單中最後一個「儲存格」型的值（Shift 拉範圍的錨點）
function lastCellPick() {
  for (let i = selectedList.length - 1; i >= 0; i--) {
    if (selectedList[i].cell) return selectedList[i].cell
  }
  return null
}

// 兩個值是不是同一個（面板提示用的字串鍵，判定本身仍走 samePick）
function pickKey(pick) {
  if (pick.cell) {
    const base = `c:${pick.cell.row.index},${pick.cell.col.index}`
    return hasInner(pick.cell.inner) ? `${base}:${JSON.stringify(pick.cell.inner)}` : base
  }
  if (pick.block) {
    const base = `b:${pick.block.axis},${pick.block.index}`
    return hasInner(pick.block.inner) ? `${base}:${JSON.stringify(pick.block.inner)}` : base
  }
  return 'x'
}

/**
 * 已選清單的最後一項是單一儲存格時，切到整欄／整列＝把那一格升級成該欄／該列。
 * 「先點一格，再按整欄」是最直覺的操作順序，沒有這一條使用者得先切模式再重點一次。
 * 取代掉的那一格可以復原。最後一項不是單格（或清單是空的）就只切模式。
 */
function upgradeLastPickTo(mode) {
  trimReady = false
  if (mode !== 'col' && mode !== 'row') return false
  if (selectedList.length === 0) return false
  const last = selectedList[selectedList.length - 1]
  if (!last || !last.cell) return false
  const judgeEl = pickedTableEl || currentTargetEl
  if (!judgeEl || !isTableMode(judgeEl)) return false

  // 觸發 1：單列小表上要整欄（已選在 T 的先換算；換算不了就維持現況行為）
  if (mode === 'col' && currentPurpose === 'task' &&
      isSingleRowNestedTable(judgeEl) && isUpgradeableTable(judgeEl)) {
    if (promotePicksToOuter(judgeEl)) {
      const O = outerTableOf(judgeEl)
      const lastPromoted = selectedList[selectedList.length - 1]
      const index = lastPromoted.cell.col.index
      const headerText = lastPromoted.cell.col.header || ''
      const block = { axis: 'col', index, headerText }
      putInner(block, lastPromoted.cell.inner)
      footerNotice(withFooterExclude(block, O))
      const upgraded = { block }
      const previous = undoSnapshot
      if (selectedList.some(p => samePick(p, upgraded))) {
        selectedList = selectedList.slice(0, -1)
      } else {
        selectedList = selectedList.slice(0, -1).concat([upgraded])
      }
      undoSnapshot = previous
      limitReached = selectedList.length >= maxPicks
      const n = countResolvedInnerInCol(O, index, block.inner)
      toolbarNotice = promotedColNotice(n)
      clearPickedMarks(document)
      applyPickedMarks(O)
      return true
    }
  }

  const originalName = getPickName(last)
  const axis = mode === 'row' ? 'row' : 'col'
  // 判定來源要與工具列一致：工具列以「已選那張表」判定可不可用，
  // 這裡卻看 hover 目標的話，會出現「按鈕亮著、按下去卻沒反應」
  const index = axis === 'row' ? last.cell.row.index : last.cell.col.index
  const headerText = (axis === 'row' ? last.cell.row.header : last.cell.col.header) || ''
  const title = headerText || (axis === 'row' ? `第 ${index + 1} 列` : `第 ${index + 1} 欄`)
  const block = { axis, index, headerText }
  putInner(block, last.cell.inner)
  // 單格升級成整欄也是「建立」整欄值：表尾合計照樣預設排除（整列不動）
  // 升級不經 addPick（是取代最後一項），直接說
  const added = withFooterExclude(block, judgeEl)
  const upgraded = { block }
  const previous = takeUndoSnapshot(selectedList, pickedTableEl)
  if (selectedList.some(p => samePick(p, upgraded))) {
    // 已經選過同一欄／列了，只要把那一格拿掉就好
    selectedList = selectedList.slice(0, -1)
  } else {
    selectedList = selectedList.slice(0, -1).concat([upgraded])
  }
  // 取代前留一步反悔：復原快照只活到下一個動作為止
  undoSnapshot = previous
  limitReached = selectedList.length >= maxPicks
  const upNotice = `已把「${originalName}」換成「${title}」${axis === 'row' ? '整列' : '整欄'}，其他已選不變（可復原）`
  toolbarNotice = added > 0 ? `${upNotice}\n已自動排除表尾 ${added} 列（合計），右鍵可取消` : upNotice
  clearPickedMarks(document)
  applyPickedMarks(judgeEl)
  return true
}

// 加選、移除、送出都讓快照失效——留著會在幾步之後莫名其妙跳回舊的一批
function clearUndoSnapshot() {
  undoSnapshot = null
}

/**
 * 還原上一次取代。回傳有沒有真的還原（沒有快照時交回 false，
 * 讓 Ctrl+Z 退回原本的「移除最後一項」）
 */
function undoReplace() {
  trimReady = false
  if (!undoSnapshot) return false
  clearPickedMarks(document)
  selectedList = undoSnapshot.picks.slice()
  // 快照裡的那一批索引屬於快照當時那張表：還原時目標與 pickedTableEl 要一起回去，
  // 只還原清單的話，接下來就是「舊表的索引配上新表的定位」——AF-7 同型缺陷
  const backTo = undoSnapshot.tableEl
  const batchBack = undoSnapshot.batchGroups ? undoSnapshot : null
  undoSnapshot = null
  limitReached = selectedList.length >= maxPicks
  if (batchBack) {
    batchGroups = batchBack.batchGroups.map(g => g.el ? g : { tableEl: g.tableEl, picks: g.picks.slice() })
    currentGroupIdx = batchBack.currentGroupIdx
    if (!backTo || selectedList.length === 0) pickedTableEl = null
  }
  if (backTo) {
    pickedTableEl = backTo
    setTarget(backTo)
  }
  if (selectedList.length > 0 && pickedTableEl) {
    applyPickedMarks(pickedTableEl)
  } else if (currentTargetEl && isTableMode(currentTargetEl)) {
    applyPickedMarks(currentTargetEl)
  } else if (batchBack) {
    applyPickedMarks(null)
  }
  return true
}

// 存一份可還原的快照（連同這批索引屬於哪一張表）
function takeUndoSnapshot(picks, tableEl) {
  // 批次模式：快照涵蓋所有組與目前是哪一組（只存目前這組的話，整組移除復原不回來）
  if (batchMode) {
    syncBatch()
    if (batchGroups.length === 0) return null
    return {
      picks: (picks || []).slice(),
      tableEl: tableEl || pickedTableEl || null,
      batchGroups: batchGroups.map(g => g.el ? g : { tableEl: g.tableEl, picks: g.picks.slice() }),
      currentGroupIdx
    }
  }
  return picks && picks.length > 0 ? { picks: picks.slice(), tableEl: tableEl || pickedTableEl || null } : null
}

// 取代目前已選：點一下就是「只選這一個」
function replaceSelection(candidate) {
  trimReady = false
  // 空清單沒有東西可復原：第一次點格不能長出「復原」鈕與「已換成」提示
  const previous = takeUndoSnapshot(selectedList, pickedTableEl)
  clearPickedMarks(document)
  selectedList = []
  limitReached = false
  pickedTableEl = null
  addPick(candidate)
  undoSnapshot = previous
}

// 從起始列欄到結束列欄的矩形範圍加選（Shift 點與拖曳框選共用）
function addCellRange(tableEl, minR, maxR, minC, maxC, inner) {
  const dataRows = resolveDataRows(tableEl)
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (targetAtGrid(dataRows[r], c, inner) !== null) {
        addPick(makeCellPick(r, c, tableEl, dataRows, inner))
        if (limitReached || selectedList.length >= maxPicks) return
      }
    }
  }
}

// 從錨點格到目標格的矩形範圍一次加進來（Shift 點的行為）
function addRange(anchorCell, targetCell) {
  const minR = Math.min(anchorCell.row.index, targetCell.row.index)
  const maxR = Math.max(anchorCell.row.index, targetCell.row.index)
  const minC = Math.min(anchorCell.col.index, targetCell.col.index)
  const maxC = Math.max(anchorCell.col.index, targetCell.col.index)
  addCellRange(currentTargetEl, minR, maxR, minC, maxC, anchorCell.inner)
}

// 雙擊＝選這一個並送出（檔案總管開啟檔案的習慣）
function onDblClick(event) {
  if (!active) return
  event.preventDefault(); event.stopPropagation()
  // 拖曳框選放開的瞬間瀏覽器會補 click，兩下拖曳就會湊成 dblclick，那不是使用者要送出
  if (Date.now() - lastDragEndAt < 200) return
  if (menuEl) return
  // overlay 自己的元素（工具列、面板、chip）雙擊不送出；代理層是例外，它就是要被點的
  if (overlayEl && overlayEl.contains(event.target) && !frameOfProxy(event.target)) return
  if (!currentTargetEl) return

  // 批次模式雙擊非表格元素也是結果式：click、click 會加再移除那一組，雙擊結束時它一定要是一組（AF-18 終檢）
  if (batchMode) {
    const onTable = isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)
    const el = onTable ? null : (isTableMode(currentTargetEl) ? upgradeTarget(event.target, { deliberate: true }) : currentTargetEl)
    if (el && !isTableMode(el) && !iframeOf(el) && el !== document.body && el !== document.documentElement) {
      syncBatch()
      if (!batchGroups.some(g => g.el === el)) toggleElementGroup(el)
      confirmPick()
      return
    }
  }

  if (currentTargetEl.contains(event.target) && promoteBeforeAddingInOuter() === 'blocked') return

  // 雙擊結果式：在目標表格內時，確保雙擊那個候選值在清單裡（不在就 addPick；在就不動）
  if (isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)) {
    if (!batchFollowTarget(currentTargetEl)) {
      updatePanel(panelEl, currentTargetEl)
      return
    }
    const candidate = candidateAt(event.target)
    if (candidate && !selectedList.some(p => samePick(p, candidate))) {
      addPick(candidate)
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
  // overlay 自己的按鈕（工具列、完成／取消、chip）要讓瀏覽器照常處理這一下 mousedown，
  // 否則它們永遠拿不到焦點，焦點環就是畫了也沒人看得到的死規則
  const onOwnControl = overlayEl && overlayEl.contains(event.target) && !frameOfProxy(event.target)
  if (onOwnControl) return
  event.preventDefault()
  if (currentTargetEl && isTableMode(currentTargetEl)) {
    const info = resolveCell(event.target, currentTargetEl)
    if (info) {
      dragStart = { rIdx: info.rIdx, cIdx: info.cIdx, inner: info.inner }
      isDragging = false
    }
  }
}

function onMouseUp(event) {
  if (!active) return
  if (!dragStart) return
  if (isDragging && currentTargetEl && isTableMode(currentTargetEl)) {
    const promoted = promoteBeforeAddingInOuter()
    if (promoted === 'blocked') {
      dragStart = null
      isDragging = false
      return
    }
    const justPromoted = promoted === 'promoted'
    if (!batchFollowTarget(currentTargetEl)) {
      dragStart = null
      isDragging = false
      updatePanel(panelEl, currentTargetEl)
      return
    }

    const endInfo = resolveCell(event.target, currentTargetEl)
    const endR = endInfo ? endInfo.rIdx : dragStart.rIdx
    const endC = endInfo ? endInfo.cIdx : dragStart.cIdx
    const minR = Math.min(dragStart.rIdx, endR)
    const maxR = Math.max(dragStart.rIdx, endR)
    const minC = Math.min(dragStart.cIdx, endC)
    const maxC = Math.max(dragStart.cIdx, endC)

    const snapToPreserve = (justPromoted ? undoSnapshot : null)
    addCellRange(currentTargetEl, minR, maxR, minC, maxC, dragStart.inner)
    if (snapToPreserve) {
      undoSnapshot = snapToPreserve
    }

    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
    lastDragEndAt = Date.now()
    clearPendingConfirms()
    if (selectedList.length > 0 && pickedTableEl) {
      applyPickedMarks(pickedTableEl)
    } else {
      applyPickedMarks(currentTargetEl)
    }
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
  // 進來前先清乾淨，但**只清同一個用途**的保留標示：
  // 前置動作要選一個元素時，任務目標的藍框要留在畫面上（面板還開著、使用者還在看）
  exitPickMode({ clearOnly: opts?.purpose || null })
  active = true
  currentPurpose = opts?.purpose || null
  currentTaskId = opts?.taskId !== undefined ? opts.taskId : undefined
  // 批次只對建立新任務有意義（重選、前置動作、登入一次就是一個目標）
  batchMode = opts?.batch === true && currentPurpose === 'task'
  maxPicks = (typeof opts?.maxPicks === 'number' && opts.maxPicks > 0) ? opts.maxPicks : 100
  limitReached = false
  headerChangedNotice = false
  selectedList = []
  dragStart = null
  isDragging = false
  suppressClick = false
  menuTargetContext = null
  backStack = []
  lockedEl = null
  clearPendingConfirms()
  selectAllNotice = null
  lastDragEndAt = 0
  currentHint = opts?.hint || null
  // 下鑽之後要把原本要勾回的值一起帶過去
  pendingPreselect = opts?.preselect || null
  if (typeof document === 'undefined' || !document.body) return

  originalUserSelect = document.body.style.userSelect || ''
  document.body.style.userSelect = 'none'
  originalCursor = document.body.style.cursor || ''
  reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    : false

  overlayEl = document.createElement('div')
  overlayEl.setAttribute('data-af-overlay', '')
  overlayEl.style.position = 'absolute'; overlayEl.style.top = '0'; overlayEl.style.left = '0'
  overlayEl.style.width = '0'; overlayEl.style.height = '0'; overlayEl.style.pointerEvents = 'none'; overlayEl.style.zIndex = '2147483647'

  highlightEl = document.createElement('div')
  highlightEl.setAttribute('data-af-highlight', '')
  highlightEl.style.position = 'absolute'; highlightEl.style.border = `2px solid ${COLORS.primary}`
  highlightEl.style.boxSizing = 'border-box'; highlightEl.style.pointerEvents = 'none'; highlightEl.style.zIndex = '2147483647'
  overlayEl.appendChild(highlightEl)

  // 建立工具列（四段相連，作用中段用主色底）
  toolbarEl = document.createElement('div')
  toolbarEl.setAttribute('data-af-toolbar', '')
  toolbarEl.style.position = 'fixed'; toolbarEl.style.right = '16px'; toolbarEl.style.top = '16px'
  toolbarEl.style.display = 'flex'; toolbarEl.style.flexWrap = 'wrap'; toolbarEl.style.maxWidth = 'calc(100vw - 32px)'; toolbarEl.style.gap = '0'; toolbarEl.style.pointerEvents = 'auto'
  toolbarEl.style.zIndex = '2147483647'
  toolbarEl.style.backgroundColor = COLORS.surface
  toolbarEl.style.border = `1px solid ${COLORS.border}`
  toolbarEl.style.borderRadius = '8px'
  toolbarEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)'
  toolbarEl.style.overflow = 'hidden'

  for (const def of TOOLS_DEF) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('data-af-tool', def.key)
    btn.textContent = def.label
    if (def.title) btn.setAttribute('title', def.title)
    btn.style.padding = '4px 10px'
    btn.style.fontSize = '12px'
    btn.style.borderRadius = '0'
    btn.style.border = 'none'
    btn.style.borderRight = `1px solid ${COLORS.border}`
    btn.style.cursor = 'pointer'
    btn.style.fontFamily = 'inherit'
    btn.style.minHeight = '28px'
    btn.style.transition = reduceMotion ? '' : 'background-color 150ms ease, color 150ms ease'
    addFocusRing(btn)
    toolbarEl.appendChild(btn)
  }
  // 移除最後一個按鈕的右邊框
  if (toolbarEl.lastChild) toolbarEl.lastChild.style.borderRight = 'none'
  overlayEl.appendChild(toolbarEl)

  panelEl = document.createElement('div')
  panelEl.setAttribute('data-af-panel', '')
  panelEl.style.position = 'fixed'; panelEl.style.right = '16px'; panelEl.style.bottom = '16px'
  panelEl.style.backgroundColor = COLORS.surface; panelEl.style.color = COLORS.textMuted; panelEl.style.pointerEvents = 'auto'; panelEl.style.zIndex = '2147483647'
  panelEl.style.border = `1px solid ${COLORS.border}`
  panelEl.style.padding = '8px 12px'; panelEl.style.borderRadius = '8px'; panelEl.style.fontSize = '12px'; panelEl.style.lineHeight = '1.4'; panelEl.style.whiteSpace = 'pre-line'
  panelEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)'
  panelEl.style.maxHeight = 'calc(100vh - 32px)'
  panelBodyEl = document.createElement('div')
  panelBodyEl.setAttribute('data-af-panel-body', '')
  panelBodyEl.style.whiteSpace = 'pre-line'
  panelBodyEl.style.overflowY = 'auto'
  panelEl.appendChild(panelBodyEl)
  panelEl.appendChild(buildPanelActions())
  overlayEl.appendChild(panelEl)

  document.body.appendChild(overlayEl)
  buildFrameProxies()
  setTarget(upgradeTarget(opts?.initialTarget || null))

  if (opts?.preselect && currentTargetEl && isTableMode(currentTargetEl)) {
    applyPreselect(opts.preselect, currentTargetEl)
    if (selectedList.length > 0 && pickedTableEl) {
      applyPickedMarks(pickedTableEl)
    } else {
      applyPickedMarks(currentTargetEl)
    }
    updatePanel(panelEl, currentTargetEl)
  }

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('mouseout', onMouseOut, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('dblclick', onDblClick, true)
  document.addEventListener('contextmenu', onContextMenu, true)
}

/**
 * 離開選取模式。
 * @param {{hold?: string}} opts `hold` 給定用途時，**保留該用途的已選標示**（`data-af-held`）：
 *   設定面板開在旁邊時，使用者要看得到自己剛剛選的是哪一格（AF-10 作業 B）。
 *   不給就是全清（`EXIT_PICK`、取消、測試清場都走這條）。
 */
export function exitPickMode(opts = {}) {
  currentHint = null
  // 取消／`Esc` 只清自己這一輪的保留標示：前置動作選到一半反悔，
  // 不該把任務目標的藍框一起抹掉（那是另一個用途的成果）
  const clearOnly = typeof opts.clearOnly === 'string' ? opts.clearOnly : null
  // 送出後保留標示：藍框留著，但工具列、面板、事件攔截、游標覆寫全部拆掉，
  // 頁面要能正常操作（使用者接下來是在面板上填表單，不是還在選）
  const holdPurpose = typeof opts.hold === 'string' ? opts.hold : null
  if (holdPurpose && typeof document !== 'undefined' && document.querySelectorAll) {
    // 只標「這一輪選的」：已經屬於別的用途的保留標示不得被改群，
    // 否則前置動作送出一次，就會把任務目標那一格也變成 preaction 群，
    // 下一次 preaction 的 Esc 會把它一起抹掉（定案 B-6 要防的正是這件事）
    let held = 0
    for (const el of document.querySelectorAll('[data-af-picked]:not([data-af-held])')) {
      el.setAttribute('data-af-held', holdPurpose)
      held++
    }
    // 非表格的目標（最常見的單一數字就是這種）沒有 data-af-picked 可以留，
    // 高亮本來畫在 overlay 上、隨 overlay 一起拆掉——要改標在元素自己身上
    if (held === 0 && currentTargetEl && currentTargetEl !== document.body &&
        !isTableMode(currentTargetEl) && !iframeOf(currentTargetEl) &&
        !currentTargetEl.hasAttribute('data-af-held')) {
      currentTargetEl.setAttribute('data-af-held', holdPurpose)
      currentTargetEl.style.outline = `2px solid ${COLORS.primary}`
    }
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('mouseout', onMouseOut, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('dblclick', onDblClick, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    clearMarkedCells(document)
    clearPickedMarks(document)
    if (!holdPurpose) clearHeldMarks(document, clearOnly)
    closeMenu()
    if (document.body) {
      document.body.style.userSelect = originalUserSelect
      document.body.style.cursor = originalCursor
      clearTitles()
    }
    for (const el of (document.querySelectorAll ? document.querySelectorAll('[data-af-overlay]') : [])) {
      el.remove()
    }
    for (const el of (document.querySelectorAll ? document.querySelectorAll('[data-af-menu]') : [])) {
      el.remove()
    }
    // 代理層貼在 <body> 底下（見 buildFrameProxies），不會隨 overlay 一起拆掉
    for (const el of allProxies()) el.remove()
  }
  yieldedEl = null; lastProxySync = 0
  active = false; currentPurpose = null; currentTaskId = undefined; currentTargetEl = null; backStack = []
  overlayEl = null; highlightEl = null; panelEl = null; toolbarEl = null; menuEl = null
  pickMode = 'cell'; cellIndex = null; colIndex = null; rowIndex = null; currentCellEl = null; nestedNoticeOn = false
  currentDataRows = []; currentRowEl = null
  selectedList = []
  // 這一個漏清會讓下一次選取沿用上一張表的 locator，配上新表的列欄索引送出去（AF-7 體檢）
  pickedTableEl = null
  deliberateTableEl = null
  currentHoverEl = null
  currentInner = null
  maxPicks = 100
  // 「最近一次動作是每格各一個值」漏清的話，下一次選取一進來就亮著去頭去尾鈕
  trimReady = false
  limitReached = false
  headerChangedNotice = false
  dragStart = null
  isDragging = false
  suppressClick = false
  menuTargetContext = null
  // 這幾個漏清會讓下一次選取還鎖在上一個元素、或還停在「再點一次才取代」的半途
  lockedEl = null
  clearPendingConfirms()
  selectAllNotice = null
  lastDragEndAt = 0
  // AF-9 新增的狀態：漏清會讓下一次選取沿用上一次的復原快照、提示與面板位置
  undoSnapshot = null
  toolbarNotice = null
  pendingMode = null
  panelBodyEl = null
  panelDoneEl = null
  panelUndoEl = null
  panelTrimHeadEl = null
  panelTrimTailEl = null
  pendingFooterNotice = 0
  panelCorner = 'right'
  panelAvoidLatched = false
  // 這兩個漏清會讓下一次選取沿用上一次的預選、以及舊的表格列欄數快取
  pendingPreselect = null
  kindCacheEl = null
  kindCache = null
  upgradeableCache.clear()
  // 表格快取與觀察器：觀察器全部 disconnect、快取整個換新（下一輪不得沿用上一輪的列清單）
  if (tableObserver) tableObserver.disconnect()
  tableObserver = null
  tableCache = new WeakMap()
  // 自己畫過的標示清單（上面的 clear* 已清完；保留中的標示本來就不在清理範圍）
  markedCellEls = new Set()
  pickedMarkEls = new Map()
  chipHoverEls = new Set()
  // 批次模式的組：漏清會讓下一輪帶著上一輪的任務送出
  batchMode = false
  batchGroups = []
  currentGroupIdx = -1
  batchHover.clear()
}

export function isActive() { return active }
export function currentTarget() { return currentTargetEl }
export function currentAxis() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : (pickMode === 'row' ? 'row' : 'col') }
export function currentCellIndex() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : cellIndex }
export function selectedCount() { return batchMode ? batchValueTotal(batchGroupsView()) : selectedList.length }
// 唯讀複本：外部（含測試）要看已選了什麼，不得直接改動內部陣列
export function selectedPicks() { return selectedList.slice() }
