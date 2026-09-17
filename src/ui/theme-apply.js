// 套用外觀主題：所有擴充功能頁共用的唯一一份
import { getSettings } from '../shared/storage.js'

// 'dark'／'light' 設 <html data-theme>，其他（system 或未設定）移除屬性、跟系統走
export function applyTheme(theme) {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
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
