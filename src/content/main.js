import { MSG } from '../shared/messages.js'
import { describe, resolve } from '../shared/selector.js'
import { extractValue, parseNumber } from '../shared/extract.js'

// 記住使用者最後右鍵點擊的元素
let lastTarget = null

// 監聽右鍵選單事件，後一次覆蓋前一次
document.addEventListener('contextmenu', (event) => {
  lastTarget = event.target
})

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

// 處理 EXTRACT 訊息：依 locator 尋找元素並擷取數值
function handleExtract(msg, sendResponse) {
  const resolved = resolve(document, msg.locator)
  if (resolved.error) {
    sendResponse({ ok: false, error: resolved.error, snippet: resolved.snippet })
    return
  }

  const extracted = extractValue(resolved.el, msg.spec)
  if (extracted.ok) {
    sendResponse({
      ok: true,
      value: extracted.value,
      raw: extracted.raw,
      status: extracted.status,
      strategyUsed: extracted.strategyUsed,
      layer: resolved.layer
    })
  } else {
    sendResponse({
      ok: false,
      error: extracted.error,
      raw: extracted.raw
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

  if (msg.type === MSG.REPICK) {
    sendResponse({ ok: false, reason: 'unsupported' })
    return true
  }
})
