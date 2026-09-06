import { MSG } from '../shared/messages.js'
import { describe, resolve } from '../shared/selector.js'
import { extractValue, parseNumber } from '../shared/extract.js'
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
    sendResponse({ ...extracted, ok: false })
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

// 處理 RUN_PRE_ACTIONS 訊息：依序執行前置動作
async function handlePreActions(msg, sendResponse) {
  const actions = Array.isArray(msg?.actions) ? msg.actions : []

  try {
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue

      if (action.type === 'wait') {
        const ms = typeof action.ms === 'number' ? action.ms : 0
        if (ms > 0) {
          await new Promise((r) => setTimeout(r, ms))
        }
      } else if (action.type === 'click') {
        const res = resolve(document, action.locator)
        if (res?.error || !res?.el) {
          throw new Error('preaction_not_found')
        }
        if (typeof res.el.click === 'function') {
          res.el.click()
        }
      } else if (action.type === 'waitFor') {
        const initial = resolve(document, action.locator)
        if (initial?.error || !initial?.el) {
          await new Promise((resolvePromise, rejectPromise) => {
            const timeout = typeof action.timeoutMs === 'number' ? action.timeoutMs : 20000
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
              const res = resolve(document, action.locator)
              if (!res.error && res.el) {
                cleanup()
                resolvePromise()
              }
            })

            observer.observe(document, { childList: true, subtree: true })
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
      enterPickMode({
        purpose: msg.purpose,
        taskId: msg.taskId,
        initialTarget: lastTarget
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
  })
}
