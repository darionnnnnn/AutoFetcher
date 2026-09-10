import { MSG } from '../shared/messages.js'
import { waitMsOf, timeoutMsOf, DEFAULT_HOVER_HOLD_MS } from '../shared/preaction.js'
import { describe, resolve } from '../shared/selector.js'
import { extractValue, parseNumber } from '../shared/extract.js'
import { parseTable, getDataRows, rowHeader, innermostTable } from '../shared/table.js'
import { enterPickMode, exitPickMode } from './picker-mode.js'

// 記住使用者最後右鍵點擊的元素
let lastTarget = null


// 處理 DESCRIBE 訊息：回傳目標元素的四層定位與預覽數值
function handleDescribe(sendResponse) {
  if (!lastTarget) {
    sendResponse({ ok: false, error: 'no_target' })
    return
  }

  const preview = (lastTarget.textContent || '').trim()
  const previewValue = parseNumber(preview)

  sendResponse({
    ok: true,
    locator: describe(lastTarget),
    preview,
    previewValue
  })
}

// 診斷包裡那張表的 HTML 上限（SPEC §3）。截到就標 truncated，不靜默截。
const DIAG_HTML_MAX = 4000
// 二維陣列只留前幾列：整張表倒進訊息會讓大表的診斷包大到沒人看得完
const DIAG_ROWS_MAX = 20

// 擷取失敗時，把「當下這個頁面長什麼樣」整理成一份給人看的現況。
// 只在失敗時產生：成功時沒有消費端，白帶一份大字串。
function pageDebugOf(el) {
  try {
    const table = parseTable(el)
    const dataRows = getDataRows(el)
    const tableEl = el?.tagName === 'TABLE' ? innermostTable(el) : (el?.querySelector?.('table') || el)
    const html = String(tableEl?.outerHTML || el?.outerHTML || '')
    return {
      table: {
        source: table.source,
        headers: table.headers,
        // 列標題是**原文**（`rowHeader`），不是過濾過的錨點：
        // 使用者要看的正是「那一格現在寫什麼」
        rowHeaders: table.cells.map((row, i) => (dataRows[i] ? rowHeader(dataRows[i]) : rowHeader(row))),
        rowCount: table.cells.length,
        colCount: table.cells.reduce((max, row) => (row.length > max ? row.length : max), 0),
        cells: table.cells.slice(0, DIAG_ROWS_MAX),
        partial: table.partial
      },
      html: html.slice(0, DIAG_HTML_MAX),
      truncated: html.length > DIAG_HTML_MAX
    }
  } catch {
    return null
  }
}

// 處理 EXTRACT 訊息：依 locator 尋找元素並擷取數值
function handleExtract(msg, sendResponse) {
  const resolved = resolve(document, msg.locator)
  if (resolved.error) {
    sendResponse({ ok: false, error: resolved.error, snippet: resolved.snippet })
    return
  }

  const extracted = extractValue(resolved.el, msg.spec)
  // 整包轉發：白名單會把 used / skipped / partial / fields 這些欄位丟掉，
  // background 的 partial 黃燈與多值分支都靠它們（AF-5 X3）
  if (extracted.ok) {
    sendResponse({ ...extracted, ok: true, layer: resolved.layer })
  } else {
    // 失敗才附現況：使用者按「匯出診斷」時，我們要看得到那張表當下長什麼樣
    const page = pageDebugOf(resolved.el)
    sendResponse({
      ...extracted,
      ok: false,
      ...(page ? { debug: { page: { ...page, resolvedLayer: resolved.layer } } } : {})
    })
  }
}

// 處理 SCROLL_INTO_VIEW 訊息：將目標元素捲動至畫面中央
function handleScrollIntoView(msg, sendResponse) {
  const resolved = resolve(document, msg.locator)
  if (resolved.error) {
    sendResponse({ ok: false, error: 'not_found' })
    return
  }

  if (typeof resolved.el.scrollIntoView === 'function') {
    resolved.el.scrollIntoView({ block: 'center' })
  }

  sendResponse({ ok: true })
}

// 處理 FILL_LOGIN 訊息：填入帳號密碼並點擊送出按鈕
function handleFillLogin(msg, sendResponse) {
  const selectors = msg?.selectors || {}
  const userRes = resolve(document, selectors.user)
  if (userRes?.error || !userRes?.el) {
    sendResponse({ ok: false, missing: 'user' })
    return
  }

  const passRes = resolve(document, selectors.pass)
  if (passRes?.error || !passRes?.el) {
    sendResponse({ ok: false, missing: 'pass' })
    return
  }

  const submitRes = resolve(document, selectors.submit)
  if (submitRes?.error || !submitRes?.el) {
    sendResponse({ ok: false, missing: 'submit' })
    return
  }

  userRes.el.value = msg?.username ?? ''
  userRes.el.dispatchEvent(new Event('input', { bubbles: true }))
  userRes.el.dispatchEvent(new Event('change', { bubbles: true }))

  passRes.el.value = msg?.password ?? ''
  passRes.el.dispatchEvent(new Event('input', { bubbles: true }))
  passRes.el.dispatchEvent(new Event('change', { bubbles: true }))

  if (typeof submitRes.el.click === 'function') {
    submitRes.el.click()
  }

  sendResponse({ ok: true })
}

// 處理 CHECK_ELEMENT 訊息：檢查頁面上是否存在指定選擇器的元素
function handleCheckElement(msg, sendResponse) {
  let found = false
  if (typeof msg?.selector === 'string' && msg.selector.trim() !== '') {
    try {
      found = !!document.querySelector(msg.selector)
    } catch {
      found = false
    }
  }
  sendResponse({ ok: true, found })
}

// 處理 RESOLVE_LOCATOR 訊息：檢查目標元素是否存在
function handleResolveLocator(msg, sendResponse) {
  const resolved = resolve(document, msg?.locator)
  const found = !resolved?.error && !!resolved?.el
  sendResponse({ ok: true, found })
}

// 處理 RUN_PRE_ACTIONS 訊息：依序執行前置動作
// 合成事件的 `isTrusted` 一律是 false，純 CSS `:hover` 展開的選單不會因此打開
// （SPEC §4 有寫，Picker 也說了一句）；能做的是把 JS 監聽得到的那一串事件補齊。
function dispatchMouse(el, type, extra = {}) {
  const View = el?.ownerDocument?.defaultView || globalThis.window
  const init = { bubbles: true, cancelable: true, view: View, ...extra }
  const Ctor = type.startsWith('pointer') && typeof View?.PointerEvent === 'function'
    ? View.PointerEvent
    : (typeof View?.MouseEvent === 'function' ? View.MouseEvent : null)
  // 拿不到事件建構子就派不出任何事件：要炸出來，不能回 ok 讓 fetcher 記成「hover 有做」
  if (!Ctor) throw new Error('preaction_no_event_ctor')
  el.dispatchEvent(new Ctor(type, type.startsWith('pointer') ? { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true } : init))
}

// `mouseenter` / `pointerenter` **不冒泡**：只派給目標的話，
// 靠祖先容器（列、選單列）的 enter 才展開的選單不會有反應，所以要沿祖先鏈各派一次
function dispatchEnterChain(el, type) {
  const chain = []
  let cur = el
  while (cur && cur.nodeType === 1) {
    chain.push(cur)
    cur = cur.parentElement
  }
  for (const node of chain.reverse()) dispatchMouse(node, type, { bubbles: false })
}

// 把游標「移到」這個元素上：先捲進畫面，再補齊進入事件
function hoverElement(el) {
  if (typeof el.scrollIntoView === 'function') {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch { el.scrollIntoView() }
  }
  dispatchMouse(el, 'pointerover')
  dispatchEnterChain(el, 'pointerenter')
  dispatchMouse(el, 'mouseover')
  dispatchEnterChain(el, 'mouseenter')
  dispatchMouse(el, 'mousemove')
}

// 元素是否「看得見」：在 DOM 裡不等於使用者看得到，
// 選單多半早就在 DOM 中、靠 class 或 display 切換顯示
function isVisible(el) {
  if (!el || !el.isConnected) return false
  if (typeof el.getClientRects === 'function') {
    const rects = el.getClientRects()
    // jsdom 沒有版面，一律 0 個矩形——那裡改看樣式，不能因此一律判定看不見
    if (rects.length > 0) return true
  }
  const view = el.ownerDocument?.defaultView || globalThis.window
  const style = typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(el) : null
  if (style) {
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (style.opacity !== '' && Number(style.opacity) === 0) return false
  }
  if (el.hasAttribute && (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true')) return false
  return true
}

async function handlePreActions(msg, sendResponse) {
  const actions = Array.isArray(msg?.actions) ? msg.actions : []

  try {
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue

      if (action.type === 'wait') {
        const ms = waitMsOf(action)
        if (ms > 0) {
          await new Promise((r) => setTimeout(r, ms))
        }
      } else if (action.type === 'hover') {
        const res = resolve(document, action.locator)
        if (res?.error || !res?.el) {
          throw new Error('preaction_not_found')
        }
        hoverElement(res.el)
        // 有些選單要游標「停著」才展開：停留期間持續補 mousemove
        const hold = Number.isFinite(Number(action.holdMs)) ? Number(action.holdMs) : DEFAULT_HOVER_HOLD_MS
        if (hold > 0) {
          const step = 100
          for (let waited = 0; waited < hold; waited += step) {
            await new Promise((r) => setTimeout(r, Math.min(step, hold - waited)))
            dispatchMouse(res.el, 'mousemove')
          }
        }
        // 刻意不派 mouseout／mouseleave：下一步通常是點那個選單，移開會讓它收起來
      } else if (action.type === 'click') {
        const res = resolve(document, action.locator)
        if (res?.error || !res?.el) {
          throw new Error('preaction_not_found')
        }
        // 只呼叫 el.click() 只會送出一個 click 事件；
        // 綁 pointerdown / mousedown 的元件庫選單（常見於下拉、選單列）點不動
        hoverElement(res.el)
        dispatchMouse(res.el, 'pointerdown')
        dispatchMouse(res.el, 'mousedown')
        if (typeof res.el.focus === 'function') {
          try { res.el.focus() } catch {}
        }
        dispatchMouse(res.el, 'pointerup')
        dispatchMouse(res.el, 'mouseup')
        if (typeof res.el.click === 'function') {
          res.el.click()
        }
      } else if (action.type === 'waitFor') {
        // 「出現」預設是**看得見**：元素早就在 DOM 裡、只是隱藏著的話，
        // 等到了也只是點到看不見的東西（visible: false 可關掉這個要求）
        const needVisible = action.visible !== false
        const hit = () => {
          const res = resolve(document, action.locator)
          if (res?.error || !res?.el) return false
          return needVisible ? isVisible(res.el) : true
        }
        if (!hit()) {
          await new Promise((resolvePromise, rejectPromise) => {
            const timeout = timeoutMsOf(action)
            let timer = null
            let observer = null

            const cleanup = () => {
              if (timer) {
                clearTimeout(timer)
                timer = null
              }
              if (observer) {
                observer.disconnect()
                observer = null
              }
            }

            timer = setTimeout(() => {
              cleanup()
              rejectPromise(new Error('preaction_timeout'))
            }, timeout)

            observer = new MutationObserver(() => {
              if (hit()) {
                cleanup()
                resolvePromise()
              }
            })

            // 只監聽 childList 的話，「早就在 DOM 裡、靠 class/style 切換顯示」的選單永遠等不到
            observer.observe(document, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
            })
          })
        }
      }
    }
    sendResponse({ ok: true })
  } catch (err) {
    sendResponse({ ok: false, error: err.message || 'preaction_failed' })
  }
}

// 冪等守衛：同一個分頁可能被右鍵與排程各注入一次，不得重複註冊監聽
if (!globalThis.__afContentLoaded) {
  globalThis.__afContentLoaded = true

  // 監聽右鍵選單事件，後一次覆蓋前一次
  document.addEventListener('contextmenu', (event) => {
    lastTarget = event.target
  })

  // 監聽來自 background 或 popup 的訊息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === MSG.DESCRIBE) {
      handleDescribe(sendResponse)
      return true
    }

    if (msg.type === MSG.EXTRACT) {
      handleExtract(msg, sendResponse)
      return true
    }

    if (msg.type === MSG.SCROLL_INTO_VIEW) {
      handleScrollIntoView(msg, sendResponse)
      return true
    }

    if (msg.type === MSG.ENTER_PICK) {
      // 重選是在新分頁開的，沒有「上次右鍵的元素」；先用任務自己的 locator 找回目標
      let target = lastTarget
      if (msg.locator) {
        const resolved = resolve(document, msg.locator)
        if (!resolved.error && resolved.el) target = resolved.el
      }
      enterPickMode({
        purpose: msg.purpose,
        taskId: msg.taskId,
        initialTarget: target,
        preselect: msg.preselect,
        // 下鑽失敗被退回來時 background 會帶 hint，面板要讓使用者知道為什麼還在原地
        hint: msg.hint
      })
      sendResponse({ ok: true })
      return true
    }

    if (msg.type === MSG.EXIT_PICK) {
      exitPickMode()
      sendResponse({ ok: true })
      return true
    }

    if (msg.type === MSG.FILL_LOGIN) {
      handleFillLogin(msg, sendResponse)
      return true
    }

    if (msg.type === MSG.CHECK_ELEMENT) {
      handleCheckElement(msg, sendResponse)
      return true
    }

    if (msg.type === MSG.RUN_PRE_ACTIONS) {
      handlePreActions(msg, sendResponse)
      return true
    }

    if (msg.type === MSG.RESOLVE_LOCATOR) {
      handleResolveLocator(msg, sendResponse)
      return true
    }
  })
}
