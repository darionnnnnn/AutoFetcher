// 套用外觀主題：所有擴充功能頁共用的唯一一份
import { getSettings, subscribe } from '../shared/storage.js'

// 'dark'／'light' 設 <html data-theme>，其他（system 或未設定）移除屬性、跟系統走
export function applyTheme(theme) {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

// 常駐的頁面（Picker 側邊面板、站台面板、教學頁）要跟著設定即時換主題：只看 settings 這個鍵，同一頁只掛一次
let unwatchTheme = null
export function watchTheme() {
  if (unwatchTheme) return unwatchTheme
  unwatchTheme = subscribe((changes) => {
    applyTheme(changes?.settings?.newValue?.theme)
  }, { keys: ['settings'] })
  return unwatchTheme
}

// 讀使用者設定的主題並套用；讀取失敗就跟系統走，不拋錯
export async function applySavedTheme() {
  try {
    const settings = await getSettings()
    applyTheme(settings?.theme)
  } catch {
    applyTheme('system')
  }
}
