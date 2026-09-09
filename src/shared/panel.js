// AF-10 作業 B：設定面板（Chrome side panel）的唯一入口。
//
// 為什麼是 side panel：面板停在目標分頁旁邊，永遠看得見、不會被別的視窗蓋住
// （MV3 沒有 alwaysOnTop），而且頁面上的高亮與設定畫面可以同時在眼前。
//
// **`sidePanel.open()` 只能在使用者手勢裡呼叫，而且手勢不跨 `sendMessage`**
// （AF-10 的 B-0 探針實測：從 `runtime.onMessage` 裡呼叫一定失敗，
// 錯誤訊息是 `may only be called in response to a user gesture`）。
// 所以每個入口都要在**自己的**點擊／右鍵處理裡呼叫這支函式，不能轉給 background 代開。
import { log as diagLog } from './diag.js'

/** 面板的兩種畫面，各對應一個擴充功能頁 */
export const PANEL_PATHS = {
  picker: 'ui/picker/picker.html',
  site: 'ui/site/site.html'
}

/**
 * 打開指定分頁的設定面板。
 * `path` **不得帶 query string**：B-0 實測面板重載時 Chrome 會用 `default_path` 重新載入，
 * 查詢字串會被丟掉，參數要走 `storage.session`（見 `storage.js` 的 panel ctx）。
 * @param {number} tabId 目標分頁
 * @param {'picker'|'site'} kind 要顯示哪一個畫面
 * @returns {Promise<{ok: boolean, fallback?: boolean}>}
 */
export async function openPanel(tabId, kind = 'picker', fallbackQuery = '') {
  const path = PANEL_PATHS[kind] || PANEL_PATHS.picker
  const api = typeof chrome !== 'undefined' ? chrome.sidePanel : null
  if (api && typeof api.open === 'function') {
    try {
      if (typeof api.setOptions === 'function') {
        await api.setOptions({ tabId, path, enabled: true })
      }
      await api.open({ tabId })
      return { ok: true }
    } catch (err) {
      // 手勢不成立（例如被轉手到別的非同步環節）→ 退回舊的彈出視窗，
      // 而且要留下痕跡：使用者看到的是「右鍵沒反應」，沒有紀錄就查不出原因
      await diagLog('panel_fallback', { message: String(err?.message || err), path })
    }
  } else {
    await diagLog('panel_fallback', { message: 'sidePanel API 不存在（Chrome/Edge 114 以下）', path })
  }
  return openFallbackWindow(path, fallbackQuery)
}

/**
 * 舊版瀏覽器（或手勢不成立）時的退路：沿用 AF-9 之前的彈出視窗。
 * @param {string} path 擴充功能頁路徑
 * @returns {Promise<{ok: boolean, fallback: boolean}>}
 */
async function openFallbackWindow(path, query = '') {
  const base = typeof chrome?.runtime?.getURL === 'function'
    ? await chrome.runtime.getURL(path)
    : path
  // 退路的視窗讀不到面板的 session ctx（那條路是給面板走的），參數要放在網址上，
  // 否則舊版瀏覽器開出來的是一張空表單
  const url = query ? `${String(base)}?${query}` : String(base)
  await chrome.windows.create({ url, type: 'popup', width: 600, height: 820 })
  return { ok: true, fallback: true }
}

/**
 * 關閉指定分頁的面板（儲存完成後用）。
 * `close` 是 Chrome 141+；沒有就退回把該分頁的面板停用。
 * @param {number} tabId 目標分頁
 */
export async function closePanel(tabId) {
  const api = typeof chrome !== 'undefined' ? chrome.sidePanel : null
  if (!api) return
  try {
    if (typeof api.close === 'function') {
      await api.close({ tabId })
      return
    }
    if (typeof api.setOptions === 'function') {
      await api.setOptions({ tabId, enabled: false })
    }
  } catch {}
}
