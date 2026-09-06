// AutoFetcher 通知唯一入口
import { getSettings } from '../shared/storage.js'
import { log } from '../shared/diag.js'

const ICON_URL = 'icons/icon-128.png'

// 發送系統通知，若通知關閉或拋錯則回傳 false，成功回傳 true
export async function notify(id, options) {
  const settings = await getSettings()
  if (settings?.notifications === false) {
    return false
  }

  const createOptions = {
    type: 'basic',
    iconUrl: ICON_URL,
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
