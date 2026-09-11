// 豁免說明：此檔案在網頁 isolated world 執行，網頁未載入 ui/theme.css，
// 因此為全專案唯一允許寫色碼字面值之檔案。所有色碼集中在下方 COLORS 常數，
// 其餘程式碼一律引用 COLORS 的屬性。
import { MSG } from '../shared/messages.js'
import { describe } from '../shared/selector.js'
import { detectKind } from '../shared/block-detect.js'
import { parseNumber, resolveByPosition, locateByHeader } from '../shared/extract.js'
import {
  columnHeaders, rowHeader, innermostTable,
  // 「哪些列／格屬於這張表」的判準只有 shared/table.js 一份（AF-10 作業 D）：
  // 這裡以原本的區域名稱引入，呼叫端一律不變
  CELL_SELECTOR,
  tableOf, isHeaderCell,
  cssGridRowsOf,
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
let panelBodyEl = null, panelDoneEl = null, panelUndoEl = null
// 「取代」前的已選清單快照：取代是最容易誤觸的動作，要留一步可以反悔
let undoSnapshot = null
// 面板固定在右下角，但游標靠近時要閃到左下角，否則它就擋在使用者要選的內容上
let panelCorner = 'right'
// 換角之後先鎖住，等游標離開面板附近才允許再換（避免沿邊緣移動時來回彈跳）
let panelAvoidLatched = false
let pickMode = 'cell', cellIndex = null, colIndex = null, rowIndex = null, currentDataRows = [], currentRowEl = null, currentCellEl = null
let selectedList = [], maxPicks = 20, limitReached = false, headerChangedNotice = false
// 非表格元素被「點一下鎖定」後不再跟著滑鼠跑（檔案總管點一下選取的習慣）
let lockedEl = null
// 帶 preselect 進來的多個已選值，第一次「點一下取代」只提示、再點一次才真的換掉
let preselectPristine = false, replaceConfirmPending = null
// 工具列被點到停用的那一段時要說原因（點不動卻沒訊息是最容易被當成壞掉的）
let toolbarNotice = null
// 這一格內含表格時的警語（面板唯一一份）
const NESTED_CELL_NOTICE = '這一格內含表格，會抓到整串文字；要抓裡面的值請把滑鼠移進去'
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
let originalUserSelect = '', dragStart = null, isDragging = false, suppressClick = false, menuTargetContext = null

// detectKind 會掃整棵子樹，而滑鼠每移動一格都要問一次，因此記住最後一次的結果
let kindCacheEl = null, kindCache = null

// 取得元素的型別描述（同一個元素連續詢問時走快取）
function kindOf(el) {
  if (el !== kindCacheEl) {
    kindCacheEl = el
    kindCache = detectKind(el)
  }
  return kindCache
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

// 把滑鼠下的元素升級成「它所屬的最內層表格」。
// 使用者的直覺是「我點的是這一格」，而擷取規格要的是表格容器 + 列欄索引，
// 兩者之間的轉換只有這一份。只對會挑值的用途升級：前置動作與登入要的是那個元素本身。
function upgradeTarget(el, opts = {}) {
  if (!el) return el
  if (currentPurpose !== 'task' && currentPurpose !== 'repick') return el
  if (typeof el.closest !== 'function') return el
  let upgraded = null
  const cell = el.closest(CELL_SELECTOR)
  if (cell) upgraded = tableOf(cell)
  if (!upgraded) upgraded = tableOf(el)
  // 找不到任何表格＝滑鼠落在頁面的別處（往右上角工具列移動途中經過的段落、空白）。
  // 已經選了值的時候不換目標：換掉的話工具列三段會立刻反灰、hover 標示被清掉，
  // 使用者根本走不到工具列去改「單格／整欄／整列」——這就是 P4 回饋的根因。
  if (!upgraded) {
    if (!opts.deliberate && selectedList.length > 0 && pickedTableEl) return pickedTableEl
    return el
  }
  // 擷取端（shared/table.js 的 parseTable / getDataRows）對純包裝的外層表會鑽到內層，
  // 選取端不跟著鑽的話，索引以外層算、值以內層取，會靜默抓到別一格（AF-10 作業 D）
  upgraded = innermostTable(upgraded)
  // 已經選了值就鎖在那張表（AF-10 作業 C）：
  // 巢狀內外層是「同一張表的事」，鎖回已選那張（只擋一個方向的話，內層已選後
  // Ctrl 點外層格子會混進另一張表的索引，再用內層 locator 送出）；
  // **另一張不相干的表**才把目標換過去，讓使用者看得到「可以改點這張」——
  // 但換不換得成要等他真的點下去（滑鼠路過不算）。
  if (!opts.deliberate && selectedList.length > 0 && pickedTableEl && upgraded !== pickedTableEl &&
      (pickedTableEl.contains(upgraded) || upgraded.contains(pickedTableEl))) {
    return pickedTableEl
  }
  return upgraded
}

// 取得表格的所有資料列（排除表頭列）
function resolveDataRows(tableEl) {
  if (!tableEl) return []
  if (kindOf(tableEl).kind === 'table') {
    return getTableRows(tableEl).filter(r => !isHeaderRow(r))
  }
  // CSS 假表格的列判準也走 shared/table.js 那一份（選取端與解析端不得各寫一份）
  return cssGridRowsOf(tableEl)
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
    dataRows = getTableRows(tableEl).filter(r => !isHeaderRow(r))
  } else {
    dataRows = Array.from(tableEl.children || [])
    row = dataRows.find(r => r === target || r.contains(target))
    if (!row) return null
    cell = Array.from(row.children || []).find(c => c === target || c.contains(target))
    if (!cell) return null
  }
  const cellsInRow = getRowCells(row)
  let cIdx = cellsInRow.indexOf(cell)
  if (cIdx < 0) cIdx = null
  let rIdx = dataRows.indexOf(row)
  if (rIdx < 0) rIdx = null
  if (rIdx === null || cIdx === null) return null
  return { row, cell, rIdx, cIdx, dataRows }
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
  const cells = getRowCells(row)
  const idx = cells.indexOf(cell)
  if (idx < 0) return null
  if (isHeaderRow(row)) {
    return { axis: 'col', index: idx, headerText: columnHeaders(tableEl)[idx] || (cell.textContent || '').trim() }
  }
  const dataRows = resolveDataRows(tableEl)
  const rIdx = dataRows.indexOf(row)
  if (rIdx < 0) return null
  return { axis: 'row', index: rIdx, headerText: rowHeader(row) }
}

// 把滑鼠下的位置換算成「點下去會選到什麼」，點擊與雙擊共用同一份
function candidateAt(target) {
  if (!currentTargetEl || !isTableMode(currentTargetEl)) return null
  const head = resolveHeaderTarget(target, currentTargetEl)
  if (head) return { block: { axis: head.axis, index: head.index, headerText: head.headerText } }
  const info = resolveCell(target, currentTargetEl)
  if (!info) return null
  if (pickMode === 'col') {
    return { block: { axis: 'col', index: info.cIdx, headerText: columnHeaders(currentTargetEl)[info.cIdx] || '' } }
  }
  if (pickMode === 'row') {
    return { block: { axis: 'row', index: info.rIdx, headerText: info.row ? rowHeader(info.row) : '' } }
  }
  return makeCellPick(info.rIdx, info.cIdx, currentTargetEl, info.dataRows)
}

// 清除所有標記為待選之表格格子
function clearMarkedCells(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || typeof d.querySelectorAll !== 'function') return
  for (const cell of d.querySelectorAll('[data-af-cell]')) {
    cell.removeAttribute('data-af-cell')
    if (cell.hasAttribute('data-af-picked')) {
      cell.style.outline = `2px solid ${COLORS.primary}`
    } else {
      cell.style.outline = ''
    }
  }
}

// 標示待選格、欄或列之資料格
function markCells(cell, dataRows, row, mode, cIdx) {
  clearMarkedCells(document)
  if (mode === 'cell') {
    if (cell && !isHeaderCell(cell)) {
      cell.setAttribute('data-af-cell', '')
      cell.style.outline = `2px solid ${COLORS.warn}`
      cell.style.transition = markTransition()
    }
  } else if (mode === 'col' && cIdx !== null && cIdx >= 0 && dataRows) {
    for (const dRow of dataRows) {
      const targetCell = getRowCells(dRow)[cIdx]
      if (targetCell && !isHeaderCell(targetCell)) {
        targetCell.setAttribute('data-af-cell', '')
        targetCell.style.outline = `2px solid ${COLORS.warn}`
      }
    }
  } else if (mode === 'row' && row) {
    for (const c of getRowCells(row)) {
      if (!isHeaderCell(c)) {
        c.setAttribute('data-af-cell', '')
        c.style.outline = `2px solid ${COLORS.warn}`
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
    el.style.outline = ''
  }
}

// 清除所有已選標記
function clearPickedMarks(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || typeof d.querySelectorAll !== 'function') return
  // 保留中的標示（送出後留給面板旁邊看的那些）不在這裡清，
  // 它們的出口是 EXIT_PICK 或下一次同用途的 ENTER_PICK
  for (const cell of d.querySelectorAll('[data-af-picked]:not([data-af-held])')) {
    cell.removeAttribute('data-af-picked')
    if (cell.hasAttribute('data-af-cell')) {
      cell.style.outline = `2px solid ${COLORS.warn}`
    } else {
      cell.style.outline = ''
    }
  }
}

// 重新在表格上貼回已選標記
function applyPickedMarks(tableEl) {
  clearPickedMarks(document)
  if (!tableEl || !isTableMode(tableEl)) return
  const dataRows = resolveDataRows(tableEl)
  for (const pick of selectedList) {
    if (pick.cell) {
      const row = dataRows[pick.cell.row.index]
      if (row) {
        const cells = getRowCells(row)
        const cell = cells[pick.cell.col.index]
        if (cell && !isHeaderCell(cell)) {
          cell.setAttribute('data-af-picked', '')
          if (!cell.hasAttribute('data-af-cell')) {
            cell.style.outline = `2px solid ${COLORS.primary}`
          }
        }
      }
    } else if (pick.block) {
      if (pick.block.axis === 'col') {
        for (const row of dataRows) {
          const cells = getRowCells(row)
          const cell = cells[pick.block.index]
          if (cell && !isHeaderCell(cell)) {
            cell.setAttribute('data-af-picked', '')
            if (!cell.hasAttribute('data-af-cell')) {
              cell.style.outline = `2px solid ${COLORS.primary}`
            }
          }
        }
      } else if (pick.block.axis === 'row') {
        const row = dataRows[pick.block.index]
        if (row) {
          for (const cell of getRowCells(row)) {
            if (!isHeaderCell(cell)) {
              cell.setAttribute('data-af-picked', '')
              if (!cell.hasAttribute('data-af-cell')) {
                cell.style.outline = `2px solid ${COLORS.primary}`
              }
            }
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
  if (pick.cell) {
    const r = pick.cell.row ? pick.cell.row.header : ''
    const c = pick.cell.col ? pick.cell.col.header : ''
    if (r && c) return `${r} · ${c}`
    return r || c || '儲存格'
  }
  if (pick.block) {
    return pick.block.headerText || (pick.block.axis === 'col' ? '整欄' : '整列')
  }
  return '目標'
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
      if (key === 'col' || key === 'row') disabled = true
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

// 移除指定序號之已選項
function removePickAt(index) {
  if (index < 0 || index >= selectedList.length) return
  clearUndoSnapshot()
  selectedList.splice(index, 1)
  limitReached = false
  if (selectedList.length === 0) {
    pickedTableEl = null
  }
  applyPickedMarks(currentTargetEl)
  updatePanel(panelEl, currentTargetEl)
}

// 移除最後一項已選項
function removeLastPick() {
  if (selectedList.length === 0) return
  clearUndoSnapshot()
  selectedList.pop()
  limitReached = false
  if (selectedList.length === 0) {
    pickedTableEl = null
  }
  applyPickedMarks(currentTargetEl)
  updatePanel(panelEl, currentTargetEl)
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

  if (selectedList.length > 0) {
    const headerDiv = document.createElement('div')
    headerDiv.textContent = `已選 ${selectedList.length} 個值:`
    headerDiv.style.marginBottom = '4px'
    headerDiv.style.fontWeight = 'bold'
    panel.appendChild(headerDiv)

    const listDiv = document.createElement('div')
    listDiv.style.display = 'flex'
    listDiv.style.flexWrap = 'wrap'
    listDiv.style.gap = '4px'
    listDiv.style.marginBottom = '6px'

    for (let i = 0; i < selectedList.length; i++) {
      const pick = selectedList[i]
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

      const nameSpan = document.createElement('span')
      nameSpan.textContent = getPickName(pick)
      chip.appendChild(nameSpan)

      const removeBtn = document.createElement('span')
      removeBtn.setAttribute('data-af-chip-remove', '')
      removeBtn.textContent = '\u00d7'
      removeBtn.setAttribute('title', '移除')
      removeBtn.style.marginLeft = '6px'
      removeBtn.style.cursor = 'pointer'
      removeBtn.style.fontWeight = 'bold'
      chip.appendChild(removeBtn)

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
      noticeLines.push(`（再點一次會取代這 ${selectedList.length} 個已選值）`)
    }
    if (undoSnapshot) {
      noticeLines.push(undoSnapshot.tableEl && pickedTableEl && undoSnapshot.tableEl !== pickedTableEl
        ? '已換到另一張表格（可按復原或 Ctrl／⌘＋Z 回上一張）'
        : '已換成新的選取（可按復原或 Ctrl／⌘＋Z 還原）')
    }
    if (cellWrapsTable(currentCellEl)) noticeLines.push(NESTED_CELL_NOTICE)
    if (toolbarNotice) noticeLines.push(toolbarNotice)
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
  if (cellWrapsTable(currentCellEl)) lines.push(NESTED_CELL_NOTICE)
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
  if (selectedList.length > 0) {
    return `已選 ${selectedList.length} 個值，再點可換、Ctrl／⌘ 點可加，好了按完成（或雙擊、Enter）`
  }
  if (el && isTableMode(el)) {
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

  panelDoneEl = done
  panelUndoEl = undo
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
  const n = selectedList.length
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
}

// 設定當前目標元素
function setTarget(el) {
  // AF-10 作業 C：**滑鼠移動不再有破壞性副作用**。
  // 以前滑鼠刮過另一張表就把整批已選清掉（連復原快照一起丟），
  // 使用者只是要把游標移到右上角工具列，途中經過別的表格就全沒了。
  // 現在換表一律由「點另一張表的格子」觸發（onClick 的表格分支），而且留一步反悔。
  clearMarkedCells(document)
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
  // 滑鼠在表頭上：先讓使用者看到點下去會選到整欄（或整列），再決定點不點
  const head = resolveHeaderTarget(target, currentTargetEl)
  if (head) {
    setCursor('pointer')
    const cell = typeof target.closest === 'function' ? target.closest(CELL_SELECTOR) : null
    if (cell) markTitle(cell, head.axis === 'col' ? '選整欄' : '選整列')
    // 記住停在表頭上這件事，Enter 的快速路徑才會選到整欄／整列而不是上一格殘留的索引
    currentCellEl = cell
    rowIndex = null; colIndex = null; cellIndex = null
    const dataRows = resolveDataRows(currentTargetEl)
    clearMarkedCells(document)
    if (head.axis === 'col') {
      markCells(null, dataRows, null, 'col', head.index)
    } else {
      markCells(null, dataRows, dataRows[head.index], 'row', null)
    }
    applyPickedMarks(currentTargetEl)
    syncNestedNotice()
    return
  }
  const info = resolveCell(target, currentTargetEl)
  // 滑鼠停在格子以外（表格的縫隙、表頭列）時要放掉記住的那一格，
  // 否則之後切換模式會把標示畫回一個滑鼠早就離開的位置
  if (!info) {
    currentCellEl = null
    clearMarkedCells(document)
    applyPickedMarks(currentTargetEl)
    syncNestedNotice()
    return
  }
  setCursor('cell')
  currentCellEl = info.cell
  colIndex = info.cIdx
  rowIndex = info.rIdx
  cellIndex = pickMode === 'row' ? rowIndex : colIndex
  currentDataRows = info.dataRows
  currentRowEl = info.row
  markCells(currentCellEl, info.dataRows, info.row, pickMode, colIndex)
  applyPickedMarks(currentTargetEl)
  syncNestedNotice()
}

// hover 的格子是否內含表格，改變時才重畫面板（每次 mousemove 都重畫會把按鈕從指尖換掉）
function syncNestedNotice() {
  const on = cellWrapsTable(currentCellEl)
  if (on === nestedNoticeOn) return
  nestedNoticeOn = on
  if (panelEl) updatePanel(panelEl, currentTargetEl)
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
  const cells = getRowCells(rowEl)
  const cellEl = cells[cellSpec.col.index]
  return (cellEl && cellEl.textContent ? cellEl.textContent : '').trim()
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
    n = rowEl ? getRowCells(rowEl).length : 0
  } else {
    for (const r of dataRows) {
      const cells = getRowCells(r)
      if (idx >= 0 && idx < cells.length) n++
    }
  }
  const header = typeof blockSpec.headerText === 'string' ? blockSpec.headerText.trim() : ''
  const label = header ? `「${header}」` : `第 ${Number(idx) + 1} ${axisName}`
  return `${label}整${axisName} ${n} 格`
}

// 送出確認訊息並離開
function confirmPick() {
  // 已選了值就以那張表格為準：滑鼠可能正停在表格外的一段文字上
  if (selectedList.length > 0 && pickedTableEl && currentTargetEl !== pickedTableEl) {
    setTarget(pickedTableEl)
  }
  if (!currentTargetEl) return

  // 整欄／整列模式卻沒有任何已選、目標又不是表格：送出去的會是「整個元素」，
  // 使用者以為自己選的是一整欄。停下來說原因，不要把他選的模式靜靜丟掉（AF-10 作業 C）
  if (isMultiPickPurpose() && selectedList.length === 0 &&
      (pickMode === 'col' || pickMode === 'row') && !isTableMode(currentTargetEl) &&
      !iframeOf(currentTargetEl)) {
    toolbarNotice = `${pickMode === 'row' ? '整列' : '整欄'}只能在表格上選，先把滑鼠移到表格；要抓這個元素請切回「單格」`
    if (panelEl) updatePanel(panelEl, currentTargetEl)
    return
  }

  // 目標是 iframe(或它的代理層):值在框架裡面，選這個殼沒有意義，改成鑽進去
  const descendTarget = iframeOf(currentTargetEl)
  if (descendTarget) {
    const msg = { type: MSG.DESCEND_FRAME, purpose: currentPurpose, src: frameSrcOf(descendTarget) }
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
          picks = [{
            cell: {
              row: { index: rowIndex, header: row ? rowHeader(row) : '' },
              col: { index: colIndex, header: columnHeaders(currentTargetEl)[colIndex] || '' }
            }
          }]
        } else {
          picks = [{
            block: {
              axis: 'col',
              index: currentCellIndex() !== null ? currentCellIndex() : 0,
              headerText: getHeaderText()
            }
          }]
        }
      } else if (pickMode === 'row') {
        picks = [{
          block: {
            axis: 'row',
            index: rowIndex !== null ? rowIndex : (currentCellIndex() !== null ? currentCellIndex() : 0),
            headerText: currentRowEl ? rowHeader(currentRowEl) : getHeaderText()
          }
        }]
      } else {
        picks = [{
          block: {
            axis: 'col',
            index: colIndex !== null ? colIndex : (currentCellIndex() !== null ? currentCellIndex() : 0),
            headerText: colIndex !== null ? (columnHeaders(currentTargetEl)[colIndex] || '') : getHeaderText()
          }
        }]
      }
    } else {
      picks = [{ locator: describe(currentTargetEl) }]
    }
  }

  // 一次只選一個的用途（登入、前置動作）才截斷；重選要能改多值（SPEC §8.4）
  if (!isMultiPickPurpose() && picks.length > 1) {
    picks = picks.slice(0, 1)
  }

  const blockInfo = { ...kindOf(currentTargetEl) }
  if (isTableMode(currentTargetEl)) {
    blockInfo.axis = pickMode === 'row' ? 'row' : 'col'
    blockInfo.index = currentCellIndex()
    blockInfo.headerText = getHeaderText()
  } else {
    delete blockInfo.axis
    delete blockInfo.index
  }

  const msg = {
    type: MSG.PICKED,
    purpose: currentPurpose,
    locator: describe(currentTargetEl),
    blockInfo,
    picks
  }

  if (isTableMode(currentTargetEl)) {
    const nameHint = computeNameHint(currentTargetEl)
    if (nameHint) msg.nameHint = nameHint
  }
  if (currentTaskId !== undefined) msg.taskId = currentTaskId

  if (!isTableMode(currentTargetEl)) {
    msg.preview = (currentTargetEl.textContent || '').trim()
    msg.previewValue = parseNumber(msg.preview)
  } else if (picks.length > 1) {
    const firstText = picks[0].cell
      ? getCellText(picks[0].cell, currentTargetEl)
      : (picks[0].block ? getBlockPreview(picks[0].block, currentTargetEl) : (currentTargetEl.textContent || '').trim())
    msg.preview = `${firstText}（共 ${picks.length} 個值）`
  } else if (picks.length === 1 && picks[0].cell) {
    const cellText = getCellText(picks[0].cell, currentTargetEl)
    msg.preview = cellText
    const num = parseNumber(cellText)
    if (num !== null) {
      msg.previewValue = num
    }
  } else if (picks.length === 1 && picks[0].block) {
    msg.preview = getBlockPreview(picks[0].block, currentTargetEl)
  } else {
    msg.preview = (currentTargetEl.textContent || '').trim()
    const num = parseNumber(msg.preview)
    if (num !== null) {
      msg.previewValue = num
    }
  }

  chrome.runtime.sendMessage(msg)
  // 設定面板就開在旁邊，使用者要看得到自己剛剛選的是哪一格；
  // repick 沒有面板（存檔就結束），維持全清
  exitPickMode(currentPurpose === 'repick' ? {} : { hold: currentPurpose })
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
  menuTargetContext = { target, tableEl, cellInfo }

  while (menuEl.firstChild) {
    menuEl.removeChild(menuEl.firstChild)
  }

  const items = isTable
    ? [
        { key: 'cell', label: '選這一格' },
        { key: 'col-each', label: '這一欄：每格各一個值' },
        { key: 'col', label: '這一欄：整欄聚合成一個值' },
        { key: 'row-each', label: '這一列：每格各一個值' },
        { key: 'row', label: '這一列：整列聚合成一個值' },
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
  closeMenu()

  if (action === 'done') {
    confirmPick()
    return
  }
  if (action === 'cancel') {
    cancelPick()
    return
  }
  if (action === 'element') {
    confirmPick()
    return
  }

  if (action === 'cell') {
    if (tableEl && isTableMode(tableEl)) {
      const info = cellInfo || (rowIndex !== null && colIndex !== null ? { rIdx: rowIndex, cIdx: colIndex, dataRows: resolveDataRows(tableEl) } : null)
      if (info) {
        addPick(makeCellPick(info.rIdx, info.cIdx, tableEl, info.dataRows))
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
        // 一整欄的每一格各是一個值（各幣別的買入），與「整欄加總成一個值」是兩件事
        const cIdx = cellInfo ? cellInfo.cIdx : (colIndex !== null ? colIndex : 0)
        for (let r = 0; r < dataRows.length; r++) {
          addPick(makeCellPick(r, cIdx, tableEl, dataRows))
          if (limitReached) break
        }
      } else {
        const rIdx = cellInfo ? cellInfo.rIdx : (rowIndex !== null ? rowIndex : 0)
        const cols = columnHeaders(tableEl).length || getRowCells(dataRows[rIdx] || dataRows[0]).length
        for (let c = 0; c < cols; c++) {
          addPick(makeCellPick(rIdx, c, tableEl, dataRows))
          if (limitReached) break
        }
      }
      applyPickedMarks(tableEl)
      updatePanel(panelEl, tableEl)
    }
    return
  }

  if (action === 'col') {
    if (tableEl && isTableMode(tableEl)) {
      const cIdx = cellInfo ? cellInfo.cIdx : (colIndex !== null ? colIndex : (currentCellIndex() !== null ? currentCellIndex() : 0))
      addPick({ block: { axis: 'col', index: cIdx, headerText: columnHeaders(tableEl)[cIdx] || '' } })
      applyPickedMarks(tableEl)
      updatePanel(panelEl, tableEl)
    }
    return
  }

  if (action === 'row') {
    if (tableEl && isTableMode(tableEl)) {
      const dataRows = resolveDataRows(tableEl)
      const rIdx = cellInfo ? cellInfo.rIdx : (rowIndex !== null ? rowIndex : 0)
      const row = dataRows[rIdx]
      addPick({ block: { axis: 'row', index: rIdx, headerText: row ? rowHeader(row) : '' } })
      applyPickedMarks(tableEl)
      updatePanel(panelEl, tableEl)
    }
    return
  }
}

// 加入單一儲存格至已選清單
function makeCellPick(r, c, tableEl, dataRows) {
  const rows = dataRows || resolveDataRows(tableEl)
  const row = rows[r]
  return {
    cell: {
      row: { index: r, header: row ? rowHeader(row) : '' },
      col: { index: c, header: columnHeaders(tableEl)[c] || '' }
    }
  }
}

// 判定兩個已選項是不是同一個值（儲存格比列欄索引，聚合比軸與索引）
function samePick(a, b) {
  if (a.cell && b.cell) {
    return a.cell.row.index === b.cell.row.index && a.cell.col.index === b.cell.col.index
  }
  if (a.block && b.block) {
    return a.block.axis === b.block.axis && a.block.index === b.block.index
  }
  return false
}

// 加入一個值：去重與上限的判斷只有這一份，所有加選路徑都走它
function addPick(pick) {
  // 任何加選都讓復原快照失效（取代之後又加了東西，就沒有「上一步」可回了）
  clearUndoSnapshot()
  if (selectedList.some(p => samePick(p, pick))) return false
  if (selectedList.length >= maxPicks) {
    limitReached = true
    return false
  }
  selectedList.push(pick)
  if (!pickedTableEl && currentTargetEl && isTableMode(currentTargetEl)) pickedTableEl = currentTargetEl
  return true
}

// Shift 點擊：已經選過就取消，否則加入
function togglePick(pick) {
  clearUndoSnapshot()
  const at = selectedList.findIndex(p => samePick(p, pick))
  if (at >= 0) {
    selectedList.splice(at, 1)
    limitReached = false
    return
  }
  addPick(pick)
}

function addCellPick(r, c, dataRows) {
  addPick(makeCellPick(r, c, currentTargetEl, dataRows))
}

// 套用預選項
// 位置定位（第一筆／最後一筆／倒數第二筆）換算成當下的索引；不是位置定位就回 null。
// 判定與 shared/extract.js 的 resolveByPosition 同一套規則。
function posIndexOf(pos, count) {
  if (pos !== 'first' && pos !== 'last' && pos !== 'last-1') return null
  const idx = resolveByPosition(pos, count)
  return idx >= 0 ? idx : null
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

      if (rIdx !== null && cIdx !== null && rIdx >= 0 && rIdx < dataRows.length && cIdx >= 0) {
        const targetRow = dataRows[rIdx]
        const actualRowHeader = rHeader || (targetRow ? rowHeader(targetRow) : '')
        const actualColHeader = cHeader || (colHeaders[cIdx] || '')
        addPick({
          cell: {
            row: { index: rIdx, header: actualRowHeader },
            col: { index: cIdx, header: actualColHeader }
          }
        })
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
        if (bIdx !== null && bIdx >= 0) {
          addPick({ block: { axis: 'col', index: bIdx, headerText: bHeader || colHeaders[bIdx] || '' } })
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
          addPick({ block: { axis: 'row', index: bIdx, headerText: bHeader || rowHeader(dataRows[bIdx]) || '' } })
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
    event.preventDefault(); cancelPick()
  } else if (event.key === 'Backspace') {
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
    if (selectedList.length === 0 && isTableMode(currentTargetEl) && currentCellEl) {
      const candidate = candidateAt(currentCellEl)
      if (candidate) addPick(candidate)
    }
    confirmPick()
  } else if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
    // Ctrl／⌘＋A：全選這張表的資料格
    if (!isMultiPickPurpose() || !currentTargetEl || !isTableMode(currentTargetEl)) return
    event.preventDefault()
    const dataRows = resolveDataRows(currentTargetEl)
    if (dataRows.length === 0) return
    clearPickedMarks(document)
    selectedList = []
    limitReached = false
    pickedTableEl = null
    for (let r = 0; r < dataRows.length; r++) {
      const cells = getRowCells(dataRows[r])
      for (let c = 0; c < cells.length; c++) {
        // 列標題那一格不是資料（它是這一列的名字），全選不該把它算進來
        if (isHeaderCell(cells[c])) continue
        addPick(makeCellPick(r, c, currentTargetEl, dataRows))
        if (limitReached) break
      }
      if (limitReached) break
    }
    preselectPristine = false
    replaceConfirmPending = null
    applyPickedMarks(currentTargetEl)
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
    removeLastPick()
  } else if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    if (currentTargetEl && isTableMode(currentTargetEl) && isMultiPickPurpose()) {
      event.preventDefault()
      const dataRows = resolveDataRows(currentTargetEl)
      if (dataRows.length > 0) {
        const curR = rowIndex !== null ? rowIndex : 0
        const curC = colIndex !== null ? colIndex : 0
        const numCols = columnHeaders(currentTargetEl).length || getRowCells(dataRows[0]).length

        addCellPick(curR, curC, dataRows)

        let newR = curR
        let newC = curC
        if (event.key === 'ArrowRight') newC = Math.min(numCols - 1, curC + 1)
        else if (event.key === 'ArrowLeft') newC = Math.max(0, curC - 1)
        else if (event.key === 'ArrowDown') newR = Math.min(dataRows.length - 1, curR + 1)
        else if (event.key === 'ArrowUp') newR = Math.max(0, curR - 1)

        rowIndex = newR
        colIndex = newC
        cellIndex = pickMode === 'row' ? rowIndex : colIndex
        currentRowEl = dataRows[rowIndex]
        const rowCells = getRowCells(currentRowEl)
        currentCellEl = rowCells[colIndex] || null

        addCellPick(newR, newC, dataRows)
        applyPickedMarks(currentTargetEl)
        markCells(currentCellEl, dataRows, currentRowEl, pickMode, colIndex)
        updatePanel(panelEl, currentTargetEl)
      }
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!currentTargetEl || currentTargetEl === document.body) return
    // 指在代理層時往上要走 iframe 的父層；代理層自己的父層是我們的 overlay
    const anchor = frameOfProxy(currentTargetEl) || currentTargetEl
    if (anchor.parentElement) {
      // `↑` 是使用者明確要換目標（滑鼠路過才需要鎖表保護），不套鎖表
      backStack.push(currentTargetEl); setTarget(upgradeTarget(anchor.parentElement, { deliberate: true }))
      relockAfterMove()
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (backStack.length > 0) {
      setTarget(backStack.pop())
      relockAfterMove()
    }
  } else if (event.key === 'Tab') {
    if (currentTargetEl && isTableMode(currentTargetEl)) {
      event.preventDefault()
      const modes = ['cell', 'col', 'row']
      const availableModes = isMultiPickPurpose() ? modes : ['cell']
      if (availableModes.length > 1) {
        const curIdx = availableModes.indexOf(pickMode)
        const nextIdx = (curIdx + 1) % availableModes.length
        pickMode = availableModes[nextIdx]
        cellIndex = pickMode === 'row' ? rowIndex : colIndex
        updateToolbar()
        markCells(currentCellEl, currentDataRows, currentRowEl, pickMode, colIndex)
        applyPickedMarks(currentTargetEl)
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
      const onTable = Boolean(currentTargetEl && isTableMode(currentTargetEl))
      if (!onTable) {
        // 停用的真正原因是「這裡不是表格」，與用途無關；
        // 說成「一次只選一個」會跟面板上一行的「非表格：抓整個元素」自相矛盾
        if (isMultiPickPurpose() && (mode === 'col' || mode === 'row')) {
          pendingMode = mode
          toolbarNotice = `先把滑鼠移到表格上，會自動切成${mode === 'row' ? '整列' : '整欄'}`
        } else {
          toolbarNotice = '先把滑鼠移到表格上'
        }
      } else {
        toolbarNotice = '這個用途一次只選一個元素'
      }
      if (panelEl) updatePanel(panelEl, currentTargetEl)
      return
    }
    // 焦點不留在工具列上：留著的話之後的 Enter／Space 會再按一次同一顆
    if (typeof toolBtn.blur === 'function') toolBtn.blur()
    const mode = toolBtn.getAttribute('data-af-tool')
    if (mode && (mode === 'cell' || mode === 'col' || mode === 'row')) {
      pickMode = mode
      cellIndex = pickMode === 'row' ? rowIndex : colIndex
      toolbarNotice = null
      pendingMode = null
      // 已選的最後一項是單一儲存格時，切整欄／整列＝把那一格升級成整欄／整列
      upgradeLastPickTo(mode)
      updateToolbar()
      if (currentTargetEl && isTableMode(currentTargetEl)) {
        markCells(currentCellEl, currentDataRows, currentRowEl, pickMode, colIndex)
        applyPickedMarks(currentTargetEl)
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
      if (!isNaN(idx)) {
        removePickAt(idx)
      }
    }
    return
  }

  // 3b. 面板「復原」按鈕：還原上一次取代
  const undoBtn = event.target && event.target.closest ? event.target.closest('[data-af-undo]') : null
  if (undoBtn) {
    if (undoReplace()) updatePanel(panelEl, currentTargetEl)
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
    cancelPick()
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
    return
  }

  // 6. 表格內的點擊：選取，不送出（送出走雙擊、Enter 或「完成」鈕）
  if (isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)) {
    handleTableMouseMove(event.target)
    const candidate = candidateAt(event.target)
    if (candidate) {
      // 一次只選一個的用途（前置動作、登入）：維持點一下就送出
      if (!isMultiPickPurpose()) {
        if (!addPick(candidate)) {
          applyPickedMarks(currentTargetEl)
          updatePanel(panelEl, currentTargetEl)
          return
        }
        confirmPick()
        return
      }

      const additive = event.ctrlKey || event.metaKey
      // 跨表加選擋下來：兩張表的列欄索引配不到同一個 locator，
      // 混在一起送出去的規格永遠抓到錯的值（要換表就直接點，那是取代且留得住復原）
      if (additive && pickedTableEl && currentTargetEl !== pickedTableEl &&
          !pickedTableEl.contains(currentTargetEl) && !currentTargetEl.contains(pickedTableEl)) {
        toolbarNotice = '一個任務只能抓同一張表格裡的值；要改抓另一張表，直接點那一格'
        applyPickedMarks(pickedTableEl)
        updatePanel(panelEl, currentTargetEl)
        return
      }
      if (additive) {
        // Ctrl／⌘ 點：加選或取消這一個（檔案總管的複選習慣）
        togglePick(candidate)
        preselectPristine = false
        replaceConfirmPending = null
      } else if (event.shiftKey && lastCellPick() && candidate.cell) {
        // Shift 點：從上一個已選的格子拉出矩形範圍
        addRange(lastCellPick(), candidate.cell)
        preselectPristine = false
        replaceConfirmPending = null
      } else {
        // 點一下：選取並取代目前已選。
        // 帶著多個 preselect 進來時（編輯既有任務重選）先提示一次，免得一個誤點清光整批
        const key = pickKey(candidate)
        if (preselectPristine && selectedList.length >= 2 && replaceConfirmPending !== key) {
          replaceConfirmPending = key
          applyPickedMarks(currentTargetEl)
          updatePanel(panelEl, currentTargetEl)
          return
        }
        replaceSelection(candidate)
        preselectPristine = false
        replaceConfirmPending = null
      }
      applyPickedMarks(currentTargetEl)
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
    if (pickMode === 'col' || pickMode === 'row') {
      toolbarNotice = `${pickMode === 'row' ? '整列' : '整欄'}只能在表格上選，先把滑鼠移到表格；要抓這個元素請切回「單格」`
      updatePanel(panelEl, currentTargetEl)
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
  if (pick.cell) return `c:${pick.cell.row.index},${pick.cell.col.index}`
  if (pick.block) return `b:${pick.block.axis},${pick.block.index}`
  return 'x'
}

/**
 * 已選清單的最後一項是單一儲存格時，切到整欄／整列＝把那一格升級成該欄／該列。
 * 「先點一格，再按整欄」是最直覺的操作順序，沒有這一條使用者得先切模式再重點一次。
 * 取代掉的那一格可以復原。最後一項不是單格（或清單是空的）就只切模式。
 */
function upgradeLastPickTo(mode) {
  if (mode !== 'col' && mode !== 'row') return false
  if (selectedList.length === 0) return false
  const last = selectedList[selectedList.length - 1]
  if (!last || !last.cell) return false
  const judgeEl = pickedTableEl || currentTargetEl
  if (!judgeEl || !isTableMode(judgeEl)) return false

  const axis = mode === 'row' ? 'row' : 'col'
  // 判定來源要與工具列一致：工具列以「已選那張表」判定可不可用，
  // 這裡卻看 hover 目標的話，會出現「按鈕亮著、按下去卻沒反應」
  const index = axis === 'row' ? last.cell.row.index : last.cell.col.index
  const headerText = (axis === 'row' ? last.cell.row.header : last.cell.col.header) || ''
  const upgraded = { block: { axis, index, headerText } }
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
  if (!undoSnapshot) return false
  clearPickedMarks(document)
  selectedList = undoSnapshot.picks.slice()
  // 快照裡的那一批索引屬於快照當時那張表：還原時目標與 pickedTableEl 要一起回去，
  // 只還原清單的話，接下來就是「舊表的索引配上新表的定位」——AF-7 同型缺陷
  const backTo = undoSnapshot.tableEl
  undoSnapshot = null
  limitReached = selectedList.length >= maxPicks
  if (backTo) {
    pickedTableEl = backTo
    setTarget(backTo)
  }
  if (currentTargetEl && isTableMode(currentTargetEl)) applyPickedMarks(currentTargetEl)
  return true
}

// 存一份可還原的快照（連同這批索引屬於哪一張表）
function takeUndoSnapshot(picks, tableEl) {
  return picks && picks.length > 0 ? { picks: picks.slice(), tableEl: tableEl || pickedTableEl || null } : null
}

// 取代目前已選：點一下就是「只選這一個」
function replaceSelection(candidate) {
  // 空清單沒有東西可復原：第一次點格不能長出「復原」鈕與「已換成」提示
  const previous = takeUndoSnapshot(selectedList, pickedTableEl)
  clearPickedMarks(document)
  selectedList = []
  limitReached = false
  pickedTableEl = null
  addPick(candidate)
  undoSnapshot = previous
}

// 從錨點格到目標格的矩形範圍一次加進來（Shift 點的行為）
function addRange(anchorCell, targetCell) {
  const dataRows = resolveDataRows(currentTargetEl)
  const minR = Math.min(anchorCell.row.index, targetCell.row.index)
  const maxR = Math.max(anchorCell.row.index, targetCell.row.index)
  const minC = Math.min(anchorCell.col.index, targetCell.col.index)
  const maxC = Math.max(anchorCell.col.index, targetCell.col.index)
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      addPick(makeCellPick(r, c, currentTargetEl, dataRows))
      if (limitReached) return
    }
  }
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

  // 還沒選任何值就直接雙擊：把滑鼠下的那一個選起來再送
  if (selectedList.length === 0 && isTableMode(currentTargetEl) && currentTargetEl.contains(event.target)) {
    const candidate = candidateAt(event.target)
    if (candidate) addPick(candidate)
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
      dragStart = { rIdx: info.rIdx, cIdx: info.cIdx }
      isDragging = false
    }
  }
}

function onMouseUp(event) {
  if (!active) return
  if (!dragStart) return
  if (isDragging && currentTargetEl && isTableMode(currentTargetEl)) {
    const endInfo = resolveCell(event.target, currentTargetEl)
    const endR = endInfo ? endInfo.rIdx : dragStart.rIdx
    const endC = endInfo ? endInfo.cIdx : dragStart.cIdx
    const minR = Math.min(dragStart.rIdx, endR)
    const maxR = Math.max(dragStart.rIdx, endR)
    const minC = Math.min(dragStart.cIdx, endC)
    const maxC = Math.max(dragStart.cIdx, endC)

    const dataRows = resolveDataRows(currentTargetEl)
    const colHeaders = columnHeaders(currentTargetEl)

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        addPick(makeCellPick(r, c, currentTargetEl, dataRows))
        if (limitReached) break
      }
      if (selectedList.length >= maxPicks) break
    }

    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
    lastDragEndAt = Date.now()
    preselectPristine = false
    replaceConfirmPending = null
    applyPickedMarks(currentTargetEl)
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
  maxPicks = (typeof opts?.maxPicks === 'number' && opts.maxPicks > 0) ? opts.maxPicks : 20
  limitReached = false
  headerChangedNotice = false
  selectedList = []
  dragStart = null
  isDragging = false
  suppressClick = false
  menuTargetContext = null
  backStack = []
  lockedEl = null
  replaceConfirmPending = null
  preselectPristine = false
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

  // 建立工具列（三段相連，作用中段用主色底）
  toolbarEl = document.createElement('div')
  toolbarEl.setAttribute('data-af-toolbar', '')
  toolbarEl.style.position = 'fixed'; toolbarEl.style.right = '16px'; toolbarEl.style.top = '16px'
  toolbarEl.style.display = 'flex'; toolbarEl.style.gap = '0'; toolbarEl.style.pointerEvents = 'auto'
  toolbarEl.style.zIndex = '2147483647'
  toolbarEl.style.backgroundColor = COLORS.surface
  toolbarEl.style.border = `1px solid ${COLORS.border}`
  toolbarEl.style.borderRadius = '8px'
  toolbarEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)'
  toolbarEl.style.overflow = 'hidden'

  const toolsDef = [
    { key: 'cell', label: '單格' },
    { key: 'col', label: '整欄' },
    { key: 'row', label: '整列' }
  ]

  for (const def of toolsDef) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('data-af-tool', def.key)
    btn.textContent = def.label
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
  panelBodyEl = document.createElement('div')
  panelBodyEl.setAttribute('data-af-panel-body', '')
  panelBodyEl.style.whiteSpace = 'pre-line'
  panelEl.appendChild(panelBodyEl)
  panelEl.appendChild(buildPanelActions())
  overlayEl.appendChild(panelEl)

  document.body.appendChild(overlayEl)
  buildFrameProxies()
  setTarget(upgradeTarget(opts?.initialTarget || null))

  if (opts?.preselect && currentTargetEl && isTableMode(currentTargetEl)) {
    applyPreselect(opts.preselect, currentTargetEl)
    // 勾回來的值還沒被使用者動過：這時「點一下取代」要先問一次，不然一個誤點就清光整批
    preselectPristine = selectedList.length >= 2
    applyPickedMarks(currentTargetEl)
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
  maxPicks = 20
  limitReached = false
  headerChangedNotice = false
  dragStart = null
  isDragging = false
  suppressClick = false
  menuTargetContext = null
  // 這幾個漏清會讓下一次選取還鎖在上一個元素、或還停在「再點一次才取代」的半途
  lockedEl = null
  replaceConfirmPending = null
  preselectPristine = false
  lastDragEndAt = 0
  // AF-9 新增的狀態：漏清會讓下一次選取沿用上一次的復原快照、提示與面板位置
  undoSnapshot = null
  toolbarNotice = null
  pendingMode = null
  panelBodyEl = null
  panelDoneEl = null
  panelUndoEl = null
  panelCorner = 'right'
  panelAvoidLatched = false
  // 這兩個漏清會讓下一次選取沿用上一次的預選、以及舊的表格列欄數快取
  pendingPreselect = null
  kindCacheEl = null
  kindCache = null
}

export function isActive() { return active }
export function currentTarget() { return currentTargetEl }
export function currentAxis() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : (pickMode === 'row' ? 'row' : 'col') }
export function currentCellIndex() { return (!currentTargetEl || !isTableMode(currentTargetEl)) ? null : cellIndex }
export function selectedCount() { return selectedList.length }
// 唯讀複本：外部（含測試）要看已選了什麼，不得直接改動內部陣列
export function selectedPicks() { return selectedList.slice() }
