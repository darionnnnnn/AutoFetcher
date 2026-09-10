// AF-10 作業 A：前置動作的共用定義——單位換算與說給使用者聽的訊息。
// background（fetcher）、content（main）、Picker 三端共用同一份，
// 各寫一份會讓「同一個失敗在三個畫面上長得不一樣」。

/** 前置動作型別的中文名稱（下拉選項與失敗訊息共用同一份） */
export const PRE_ACTION_LABELS = {
  hover: '移到元素上',
  waitFor: '等元素出現',
  click: '點擊元素',
  wait: '等待'
}

/** hover 的預設停留毫秒：選單常要游標停一下才展開 */
export const DEFAULT_HOVER_HOLD_MS = 300
/** waitFor 的預設逾時毫秒 */
export const DEFAULT_WAIT_TIMEOUT_MS = 20000

/**
 * 取得動作型別的中文名稱。
 * @param {string} type 動作型別
 * @returns {string} 中文名稱（未知型別回原字串）
 */
export function preActionLabel(type) {
  return PRE_ACTION_LABELS[type] || String(type || '動作')
}

/**
 * `wait` 動作要等幾毫秒。
 * 介面與資料一律以**秒**為單位（`sec`），舊設定檔存的是毫秒（`ms`）——
 * 舊任務零遷移，讀到 `ms` 就照毫秒用（換算只有這一份）。
 * @param {{sec?: number|string, ms?: number|string}} action 動作
 * @returns {number} 毫秒數（非法值一律 0）
 */
export function waitMsOf(action) {
  if (!action || typeof action !== 'object') return 0
  if (action.sec !== undefined && action.sec !== null && action.sec !== '') {
    const sec = Number(action.sec)
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0
  }
  if (action.ms !== undefined && action.ms !== null && action.ms !== '') {
    const ms = Number(action.ms)
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  }
  return 0
}

/**
 * 把失敗代碼寫成使用者看得懂的一句話：**第幾步、哪一種動作、怎麼了**。
 * 只說 `preaction_timeout` 等於告訴使用者「壞了」卻不說是哪一步壞的。
 * @param {number} index 第幾個動作（0 起算）
 * @param {{type?: string}} action 動作
 * @param {string} code 失敗代碼或訊息
 * @returns {string} 中文訊息
 */
export function preActionFailure(index, action, code) {
  const step = `前置動作第 ${Number(index) + 1} 步（${preActionLabel(action?.type)}）`
  if (code === 'preaction_not_found') return `${step}找不到元素`
  if (code === 'preaction_timeout') return `${step}等不到元素出現（逾時）`
  if (code === 'frame_not_found') return `${step}找不到元素所在的框架`
  // 「沒有回應」與「動作失敗」是兩件事:探針顯示回應正常會在幾毫秒內回來,
  // 一旦逾時,最可能的原因是這一步讓頁面換掉了,回應跟著舊文件一起消失
  if (code === 'no_response') return `${step}沒有回應（這一步可能讓頁面換頁了）`
  return `${step}失敗：${code || '未知錯誤'}`
}

/**
 * `waitFor` 要等幾毫秒才算逾時。字串（匯入的設定檔常見）也要吃得下，
 * 否則 background 與 content 各自解讀，一邊 3 秒、一邊 20 秒。
 * @param {{timeoutMs?: number|string}} action 動作
 * @returns {number} 毫秒數
 */
export function timeoutMsOf(action) {
  const n = Number(action?.timeoutMs)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WAIT_TIMEOUT_MS
}

/** 送 `RUN_PRE_ACTIONS` 之後，等回應的緩衝毫秒 */
export const PRE_ACTION_MESSAGE_BUFFER_MS = 5000

/**
 * 送 `RUN_PRE_ACTIONS` 給 content 之後要等多久才算沒有回應。
 * **必須涵蓋動作自己需要的時間**：`hover` 的 `holdMs` 沒有上限，
 * 固定 20 秒會把「使用者刻意設長的 hover」誤報成沒有回應，那是自己製造的假失敗。
 * @param {{type?: string, holdMs?: number|string, timeoutMs?: number|string}} action 動作
 * @returns {number} 毫秒數
 */
export function messageTimeoutMs(action) {
  const type = action?.type
  if (type === 'waitFor') return timeoutMsOf(action) + PRE_ACTION_MESSAGE_BUFFER_MS
  if (type === 'hover') {
    const n = Number(action?.holdMs)
    const hold = Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOVER_HOLD_MS
    return hold + PRE_ACTION_MESSAGE_BUFFER_MS
  }
  return DEFAULT_WAIT_TIMEOUT_MS
}
