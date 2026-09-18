// AutoFetcher 自動登入流程（SPEC §6）
import { getSite, saveSite } from '../shared/storage.js'
import { decryptSecret } from '../shared/crypto.js'
import { injectContent } from './inject.js'
import { notify } from './notify.js'
import { MSG } from '../shared/messages.js'
import { sendToFrame } from './messaging.js'
import { waitTabReady, enqueueForOrigin, acquireFetchTab } from './fetch-tab.js'

// 送給 content 的訊息各自的逾時（AF-21 批次 2 定案 6，暫定值）：
// 檢查元素只是一次 querySelector；填表要派事件、按送出，給寬一點
const CHECK_ELEMENT_TIMEOUT_MS = 10000
const FILL_LOGIN_TIMEOUT_MS = 15000

// FILL_LOGIN 回報找不到的欄位 → 白話名稱
const FIELD_LABELS = { user: '帳號欄位', pass: '密碼欄位', submit: '送出按鈕' }

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

// 等待與逾時參數（ensureLoggedIn 與測試登入共用）
function timingOf(opts) {
  const deadlineAt = typeof opts?.deadlineAt === 'number' ? opts.deadlineAt : Infinity
  return {
    pollMs: opts?.pollMs ?? 250,
    loadTimeoutMs: opts?.loadTimeoutMs ?? 30000,
    extraDelayMs: opts?.extraDelayMs ?? 3000,
    checkTimeoutMs: opts?.checkTimeoutMs ?? CHECK_ELEMENT_TIMEOUT_MS,
    fillTimeoutMs: opts?.fillTimeoutMs ?? FILL_LOGIN_TIMEOUT_MS,
    deadlineAt,
    within: (ms) => Math.max(0, Math.min(ms, deadlineAt - Date.now()))
  }
}

// 站台的「登入頁判定」（舊版設定只有 loginPageUrlPrefix）
function loginCheckOf(site) {
  return site.loginCheck || (site.loginPageUrlPrefix ? { type: 'urlPrefix', value: site.loginPageUrlPrefix } : null)
}

// 分頁（實際網址 currentUrl）目前是不是停在登入頁
async function isOnLoginPage(tabId, site, currentUrl, t) {
  const loginCheck = loginCheckOf(site)
  if (loginCheck?.type === 'urlPrefix') {
    return typeof loginCheck.value === 'string' && currentUrl.startsWith(loginCheck.value)
  }
  if (loginCheck?.type === 'passwordField') {
    await injectContent(tabId)
    try {
      const checkRes = await sendToFrame(tabId, {
        type: MSG.CHECK_ELEMENT,
        selector: 'input[type="password"]'
      }, 0, t.within(t.checkTimeoutMs), 'Check element')
      return checkRes?.ok === true && checkRes?.found === true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 在一個「已經開好」的分頁上走一次登入：（判斷是否在登入頁）→ 填表送出 → 等載入 → 判定成功。
 * 只回報結果，**不碰**失敗計數、停用與通知（那些只在 ensureLoggedIn 那一層）；
 * 密碼只活在參數裡，不寫進任何地方。
 * opts：同 ensureLoggedIn 的等待參數；`knownLoginPage: true` 表示呼叫端已判定過在登入頁。
 * @returns {Promise<{ ok: boolean, alreadyLoggedIn?: boolean, attempted?: boolean,
 *   steps: Array<{ step: 'fields'|'submit'|'verify', ok: boolean, detail: string }> }>}
 */
export async function attemptLogin(tabId, site, password, opts = {}) {
  const t = timingOf(opts)
  const steps = []

  if (opts.knownLoginPage !== true) {
    const tab = await chrome.tabs.get(tabId)
    const currentUrl = tab?.url || ''
    if (!(await isOnLoginPage(tabId, site, currentUrl, t))) {
      return { ok: false, alreadyLoggedIn: true, steps }
    }
  }

  // 送出前的網址：content 按下送出鈕之後才回覆，那時分頁可能已經開始換頁，一定要在送訊息之前量
  const beforeUrl = (await chrome.tabs.get(tabId))?.url || ''
  // 填表並送出（逾時與送不到走同一條失敗路徑）
  await injectContent(tabId)
  let fillRes
  try {
    fillRes = await sendToFrame(tabId, {
      type: MSG.FILL_LOGIN,
      selectors: site.selectors,
      username: site.username,
      password
    }, 0, t.within(t.fillTimeoutMs), 'Fill login')
  } catch {
    steps.push({ step: 'fields', ok: false, detail: '登入頁沒有回應填表（頁面可能還沒載入完，或被其他程式擋住）' })
    return { ok: false, steps }
  }
  if (fillRes?.ok !== true) {
    const label = FIELD_LABELS[fillRes?.missing]
    steps.push({
      step: 'fields',
      ok: false,
      detail: label
        ? `登入頁上找不到${label}：請回頁面重新選取`
        : '沒辦法在登入頁上填入帳號密碼'
    })
    return { ok: false, steps }
  }
  steps.push({ step: 'fields', ok: true, detail: '找到帳號、密碼欄位與送出按鈕' })
  // 從這裡開始頁面已經被動過(填了表單、按了送出、多半換了頁):回傳帶 `attempted`,
  // 呼叫端靠它知道「這一頁不再是剛載入的樣子」

  // 等候頁面重新載入完成與額外延遲（等載入只有 fetch-tab 的 waitTabReady 一份，含 discarded 重載）
  await waitTabReady(tabId, { pollMs: t.pollMs, loadTimeoutMs: t.within(t.loadTimeoutMs) })
  const delay = t.within(t.extraDelayMs)
  if (delay > 0) {
    await sleep(delay)
  }

  // 依 successCheck 判定登入是否成功
  const afterUrl = (await chrome.tabs.get(tabId))?.url || ''
  const check = site.successCheck || {}
  let isSuccess = false
  let verifyDetail = ''
  if (check.type === 'urlPrefix') {
    isSuccess = typeof afterUrl === 'string' && afterUrl.startsWith(check.value)
    verifyDetail = isSuccess
      ? `登入後的網址以「${check.value}」開頭`
      : `登入後的網址是「${afterUrl}」，不是以「${check.value}」開頭`
  } else if (check.type === 'element') {
    await injectContent(tabId)
    try {
      const checkRes = await sendToFrame(tabId, {
        type: MSG.CHECK_ELEMENT,
        selector: check.value
      }, 0, t.within(t.checkTimeoutMs), 'Check element')
      isSuccess = checkRes?.ok === true && checkRes?.found === true
    } catch {
      isSuccess = false
    }
    verifyDetail = isSuccess
      ? `登入後找到判定元素「${check.value}」`
      : `登入後的頁面上找不到判定元素「${check.value}」`
  } else {
    verifyDetail = '沒有設定成功判定'
  }

  if (isSuccess) {
    steps.push({ step: 'submit', ok: true, detail: '已送出' })
    steps.push({ step: 'verify', ok: true, detail: verifyDetail })
    return { ok: true, attempted: true, steps }
  }
  // 判定不成立時才分辨「送出後頁面根本沒變」：網址原封不動，多半是帳密錯（站台留在原頁顯示錯誤）或送出鈕選錯
  if (afterUrl === beforeUrl) {
    steps.push({ step: 'submit', ok: false, detail: '按下送出後頁面沒有變化：可能是帳號密碼錯誤，或選到的送出按鈕不對' })
    return { ok: false, attempted: true, steps }
  }
  steps.push({ step: 'submit', ok: true, detail: '已送出，頁面已換頁' })
  steps.push({ step: 'verify', ok: false, detail: verifyDetail })
  return { ok: false, attempted: true, steps }
}

/**
 * 確認分頁登入狀態並於需要時執行自動登入。
 * opts：`pollMs`／`loadTimeoutMs`／`extraDelayMs`；
 * `deadlineAt`（抓取的總時限時刻，每個等待取「自己的逾時」與「剩餘時間」較小者）；
 * `checkTimeoutMs`／`fillTimeoutMs` 只給測試縮短。
 */
export async function ensureLoggedIn(tabId, task, opts) {
  const t = timingOf(opts)

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
  if (!(await isOnLoginPage(tabId, site, currentUrl, t))) {
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
    return await recordLoginFailure(origin, site, t.deadlineAt)
  }

  // 6～7. 填表、送出、等載入、判定（與測試登入同一份）
  const res = await attemptLogin(tabId, site, plainPassword, { ...opts, knownLoginPage: true })

  // 8. 登入成功：歸零失敗計數並寫回
  if (res.ok) {
    site.failStreak = 0
    await saveSite(origin, site)
    return { ok: true, attempted: true }
  }

  // 9. 登入失敗：累計次數並寫回（失敗計數、停用、通知只在這一層）
  const fail = await recordLoginFailure(origin, site, t.deadlineAt)
  return res.attempted ? { ...fail, attempted: true } : fail
}

/**
 * 測試登入（站台面板「測試登入」）：用表單上**尚未儲存**的設定與明文密碼走一次登入。
 * 與同站台抓取同一條佇列、同一個抓取頁面（fetch-tab）；不累加失敗計數、不停用、不通知，
 * 密碼不寫進 diag、紀錄、storage。
 * @param {object} site 站台物件（loginUrl、selectors、loginCheck、successCheck、username）
 * @param {string} password 明文密碼
 * @param {object} [opts] 等待參數（測試縮短用）
 */
export async function testLogin(site, password, opts = {}) {
  const origin = getOrigin(site?.loginUrl)
  if (!origin) return { ok: false, steps: [{ step: 'open', ok: false, detail: '登入頁網址不是合法的網址' }] }
  return enqueueForOrigin(origin, async (holder) => {
    let tabId
    try {
      tabId = await acquireFetchTab(holder, site.loginUrl, {
        freshLoad: true,
        pollMs: opts.pollMs ?? 250,
        loadTimeoutMs: opts.loadTimeoutMs ?? 30000
      })
    } catch (err) {
      return { ok: false, steps: [{ step: 'open', ok: false, detail: `開不了登入頁：${String(err?.message || err)}` }] }
    }
    // 測試會填表、按送出：排在後面的同站台抓取要重載，不能沿用這一頁
    holder.pageDirty = true
    const tab = await chrome.tabs.get(tabId)
    if (!tab?.url) {
      return { ok: false, steps: [{ step: 'open', ok: false, detail: '開不了登入頁：分頁沒有載入任何網址' }] }
    }
    const open = { step: 'open', ok: true, detail: '已開啟登入頁' }
    const res = await attemptLogin(tabId, site, password, opts)
    if (res.alreadyLoggedIn) {
      return { ok: false, alreadyLoggedIn: true, steps: [{ ...open, detail: `開啟後停在「${tab.url}」，不是登入頁` }] }
    }
    return { ok: res.ok, steps: [open, ...res.steps] }
  })
}
