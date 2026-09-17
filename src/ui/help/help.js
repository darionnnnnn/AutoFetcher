// 使用教學頁：只負責套用使用者的主題設定
import { applySavedTheme } from '../theme-apply.js'

if (globalThis.chrome?.runtime?.id) {
  applySavedTheme()
}
