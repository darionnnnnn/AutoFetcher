// AutoFetcher 自動登入流程（SPEC §6）
import { getSite, saveSite } from '../shared/storage.js'
import { decryptSecret } from '../shared/crypto.js'
import { injectContent } from './inject.js'
import { notify } from './notify.js'
import { MSG } from '../shared/messages.js'
import { sendToFrame } from './messaging.js'
import { waitTabReady } from './fetch-tab.js'

// 送給 content 的訊息各自的逾時（AF-21 批次 2 定案 6，暫定值）：
// 檢查元素只是一次 querySelector；填表要派事件、按送出，給寬一點
const CHECK_ELEMENT_TIMEOUT_MS = 10000
const FILL_LOGIN_TIMEOUT_MS = 15000

// 短暫等待輔助函式
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 解析 URL 取得 origin
function getOrigin(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

// 處理登入失敗邏輯（累計失敗次數、滿三次停用並通知）
async function recordLoginFailure(origin, site, deadlineAt = Infinity) {
  // 失敗是因為這一次抓取的總時限到了（等待被截短），不是帳密或頁面的問題：不累加、不停用
  if (Date.now() >= deadlineAt) return { ok: false, reason: '超過單次抓取時限' }
  site.failStreak = (site.failStreak || 0) + 1
  if (site.failStreak === 3) {
    site.enabled = false
    await notify(`site:${origin}:disabled`, {
      title: 'AutoFetcher',
      message: `站台「${origin}」連續登入失敗 3 次，已自動停用自動登入。可至設定頁面重新啟用。`
    })
  }
  await saveSite(origin, site)
  return { ok: false, reason: '無法登入' }
}

/**
 * 確認分頁登入狀態並於需要時執行自動登入。
 * opts：`pollMs`／`loadTimeoutMs`／`extraDelayMs`；
 * `deadlineAt`（抓取的總時限時刻，每個等待取「自己的逾時」與「剩餘時間」較小者）；
 * `checkTimeoutMs`／`fillTimeoutMs` 只給測試縮短。
 */
export async function ensureLoggedIn(tabId, task, opts) {
  const pollMs = opts?.pollMs ?? 250
  const loadTimeoutMs = opts?.loadTimeoutMs ?? 30000
  const extraDelayMs = opts?.extraDelayMs ?? 3000
  const checkTimeoutMs = opts?.checkTimeoutMs ?? CHECK_ELEMENT_TIMEOUT_MS
  const fillTimeoutMs = opts?.fillTimeoutMs ?? FILL_LOGIN_TIMEOUT_MS
  const deadlineAt = typeof opts?.deadlineAt === 'number' ? opts.deadlineAt : Infinity
  const within = (ms) => Math.max(0, Math.min(ms, deadlineAt - Date.now()))

  // 1. 讀取分頁目前實際網址
  const tab = await chrome.tabs.get(tabId)
  const currentUrl = tab?.url || ''

  // 2. 依實際網址之 origin 取得站台設定
  const origin = getOrigin(currentUrl)
  if (!origin) {
    return { ok: true }
  }

  const site = await getSite(origin)
  if (!site) {
    return { ok: true }
  }

  // 3. 判斷是否停留在登入頁
  const loginCheck = site.loginCheck || (site.loginPageUrlPrefix ? { type: 'urlPrefix', value: site.loginPageUrlPrefix } : null)
  let isLoginPage = false

  if (loginCheck?.type === 'urlPrefix') {
    isLoginPage = typeof loginCheck.value === 'string' && currentUrl.startsWith(loginCheck.value)
  } else if (loginCheck?.type === 'passwordField') {
    await injectContent(tabId)
    try {
      const checkRes = await sendToFrame(tabId, {
        type: MSG.CHECK_ELEMENT,
        selector: 'input[type="password"]'
      }, 0, within(checkTimeoutMs), 'Check element')
      isLoginPage = checkRes?.ok === true && checkRes?.found === true
    } catch {
      isLoginPage = false
    }
  }

  if (!isLoginPage) {
    return { ok: true }
  }

  // 4. 若已在登入頁但站台自動登入已停用，不嘗試登入
  if (site.enabled === false) {
    return { ok: false, reason: '站台自動登入已停用' }
  }

  // 5. 解密密碼
  let plainPassword
  try {
    plainPassword = await decryptSecret(site.passwordEnc)
  } catch {
    return await recordLoginFailure(origin, site, deadlineAt)
  }

  // 6. 注入 content script 並填入登入資訊（逾時與送不到走同一條失敗路徑）
  await injectContent(tabId)
  let fillRes
  try {
    fillRes = await sendToFrame(tabId, {
      type: MSG.FILL_LOGIN,
      selectors: site.selectors,
      username: site.username,
      password: plainPassword
    }, 0, within(fillTimeoutMs), 'Fill login')
  } catch {
    return await recordLoginFailure(origin, site, deadlineAt)
  }

  if (fillRes?.ok !== true) {
    return await recordLoginFailure(origin, site, deadlineAt)
  }
  // 從這裡開始頁面已經被動過(填了表單、按了送出、多半換了頁):回傳帶 `attempted`,
  // 呼叫端靠它知道「這一頁不再是剛載入的樣子」

  // 7. 等候頁面重新載入完成與額外延遲（等載入只有 fetch-tab 的 waitTabReady 一份，含 discarded 重載）
  await waitTabReady(tabId, { pollMs, loadTimeoutMs: within(loadTimeoutMs) })
  const delay = within(extraDelayMs)
  if (delay > 0) {
    await sleep(delay)
  }

  // 依 successCheck 判定登入是否成功
  let isSuccess = false
  if (site.successCheck?.type === 'urlPrefix') {
    const refreshedTab = await chrome.tabs.get(tabId)
    isSuccess = typeof refreshedTab?.url === 'string' && refreshedTab.url.startsWith(site.successCheck.value)
  } else if (site.successCheck?.type === 'element') {
    await injectContent(tabId)
    try {
      const checkRes = await sendToFrame(tabId, {
        type: MSG.CHECK_ELEMENT,
        selector: site.successCheck.value
      }, 0, within(checkTimeoutMs), 'Check element')
      isSuccess = checkRes?.ok === true && checkRes?.found === true
    } catch {
      isSuccess = false
    }
  }

  // 8. 登入成功：歸零失敗計數並寫回
  if (isSuccess) {
    site.failStreak = 0
    await saveSite(origin, site)
    return { ok: true, attempted: true }
  }

  // 9. 登入失敗：累計次數並寫回
  return { ...(await recordLoginFailure(origin, site, deadlineAt)), attempted: true }
}
