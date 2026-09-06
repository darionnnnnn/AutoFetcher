// AutoFetcher 自動登入流程（SPEC §6）
import { getSite, saveSite } from '../shared/storage.js'
import { decryptSecret } from '../shared/crypto.js'
import { injectContent } from './inject.js'
import { notify } from './notify.js'
import { MSG } from '../shared/messages.js'

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

// 輪詢等待分頁載入完成
async function waitForTabComplete(tabId, pollMs, loadTimeoutMs) {
  let tabInfo = await chrome.tabs.get(tabId)
  const loadStart = Date.now()
  while (tabInfo?.status !== 'complete' && Date.now() - loadStart < loadTimeoutMs) {
    await sleep(pollMs)
    tabInfo = await chrome.tabs.get(tabId)
  }
  return tabInfo
}

// 處理登入失敗邏輯（累計失敗次數、滿三次停用並通知）
async function recordLoginFailure(origin, site) {
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

// 確認分頁登入狀態並於需要時執行自動登入
export async function ensureLoggedIn(tabId, task, opts) {
  const pollMs = opts?.pollMs ?? 250
  const loadTimeoutMs = opts?.loadTimeoutMs ?? 30000
  const extraDelayMs = opts?.extraDelayMs ?? 3000

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
      const checkRes = await chrome.tabs.sendMessage(tabId, {
        type: MSG.CHECK_ELEMENT,
        selector: 'input[type="password"]'
      })
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
    return await recordLoginFailure(origin, site)
  }

  // 6. 注入 content script 並填入登入資訊
  await injectContent(tabId)
  let fillRes
  try {
    fillRes = await chrome.tabs.sendMessage(tabId, {
      type: MSG.FILL_LOGIN,
      selectors: site.selectors,
      username: site.username,
      password: plainPassword
    })
  } catch {
    return await recordLoginFailure(origin, site)
  }

  if (fillRes?.ok !== true) {
    return await recordLoginFailure(origin, site)
  }

  // 7. 等候頁面重新載入完成與額外延遲
  await waitForTabComplete(tabId, pollMs, loadTimeoutMs)
  if (extraDelayMs > 0) {
    await sleep(extraDelayMs)
  }

  // 依 successCheck 判定登入是否成功
  let isSuccess = false
  if (site.successCheck?.type === 'urlPrefix') {
    const refreshedTab = await chrome.tabs.get(tabId)
    isSuccess = typeof refreshedTab?.url === 'string' && refreshedTab.url.startsWith(site.successCheck.value)
  } else if (site.successCheck?.type === 'element') {
    await injectContent(tabId)
    try {
      const checkRes = await chrome.tabs.sendMessage(tabId, {
        type: MSG.CHECK_ELEMENT,
        selector: site.successCheck.value
      })
      isSuccess = checkRes?.ok === true && checkRes?.found === true
    } catch {
      isSuccess = false
    }
  }

  // 8. 登入成功：歸零失敗計數並寫回
  if (isSuccess) {
    site.failStreak = 0
    await saveSite(origin, site)
    return { ok: true }
  }

  // 9. 登入失敗：累計次數並寫回
  return await recordLoginFailure(origin, site)
}
