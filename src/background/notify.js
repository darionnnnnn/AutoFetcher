// AutoFetcher 通知唯一入口
import { getSettings } from '../shared/storage.js'
import { log } from '../shared/diag.js'

// 相對路徑會相對於「呼叫端的位址」解析（service worker 是 /background/），
// 在真實瀏覽器會 404 並讓整則通知不顯示，必須用 getURL 取絕對網址。
const ICON_PATH = 'icons/icon-128.png'

// 發送系統通知，若通知關閉或拋錯則回傳 false，成功回傳 true
export async function notify(id, options) {
  const settings = await getSettings()
  if (settings?.notifications === false) {
    return false
  }

  const createOptions = {
    type: 'basic',
    iconUrl: await chrome.runtime.getURL(ICON_PATH),
    title: options.title,
    message: options.message
  }
  if (options.buttons !== undefined) {
    createOptions.buttons = options.buttons
  }

  try {
    if (id == null) {
      await chrome.notifications.create(createOptions)
    } else {
      await chrome.notifications.create(id, createOptions)
    }
    return true
  } catch (err) {
    try {
      await log('notify', { id, error: err?.message || String(err) })
    } catch {
      // 吞掉診斷紀錄例外
    }
    return false
  }
}
