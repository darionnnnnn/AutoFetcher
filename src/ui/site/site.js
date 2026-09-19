// AutoFetcher 站台登入設定視窗互動邏輯
import { getSite, saveSite, getPanelCtx, deleteHealthEntry } from '../../shared/storage.js'
import { encryptSecret } from '../../shared/crypto.js'
import { MSG } from '../../shared/messages.js'
import { applySavedTheme } from '../theme-apply.js'
import { createSaveGuard, setFieldError } from '../save-guard.js'
import { icon } from '../icons.js'

let currentOrigin = ''
let currentTabId = null
let existingSite = null
const currentSelectors = {
  user: null,
  pass: null,
  submit: null
}

const SELECTOR_FIELDS = [
  { field: 'user', purpose: 'login-user', label: '帳號欄位' },
  { field: 'pass', purpose: 'login-pass', label: '密碼欄位' },
  { field: 'submit', purpose: 'login-submit', label: '送出按鈕' }
]

// 守門原因句（測試與畫面共用同一份字）
const PREFIX_REASON = '成功判定值不能是登入頁的網址（在登入頁上也會判定成功）'
const ALREADY_LOGGED_IN = '目前已經是登入狀態，無法驗證帳密；請先在該站登出再測'

// 測試登入的四步（背景回傳的 step 代號 → 白話）
const STEP_LABELS = {
  open: '開啟登入頁',
  fields: '找到欄位並填入',
  submit: '送出',
  verify: '判定登入成功'
}

function formatLocator(locator) {
  if (!locator) return '尚未選取'
  return locator.css || locator.path || locator.xpath || '已選取'
}

function updateFieldDisplay(field) {
  const el = document.querySelector(`[data-field="${field}"]`)
  if (el) {
    el.textContent = formatLocator(currentSelectors[field])
  }
}

function handlePickedMessage(msg) {
  if (!msg || msg.type !== MSG.PICKED) return
  if (msg.cancelled === true) return
  if (typeof msg.purpose !== 'string' || !msg.purpose.startsWith('login-')) return

  const field = msg.purpose.slice('login-'.length)
  if (!['user', 'pass', 'submit'].includes(field)) return

  currentSelectors[field] = msg.locator
  updateFieldDisplay(field)
  refreshGuardIfShown()
}

let listenerBound = false
function ensureMessageListener() {
  if (listenerBound) return
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener(handlePickedMessage)
    listenerBound = true
  }
}

// 守門元件：面板文件可能被整份換掉（測試也會），容器變了就重建
let guardCache = null
function saveGuard() {
  const container = document.getElementById('site-errors')
  if (!container) return null
  if (!guardCache || guardCache.container !== container) {
    guardCache = {
      container,
      guard: createSaveGuard({
        container,
        saveButton: document.getElementById('site-save'),
        countEl: document.getElementById('site-missing')
      })
    }
  }
  return guardCache.guard
}

// 表單上目前的值（還沒存）
function readForm() {
  return {
    loginUrl: document.getElementById('login-url')?.value?.trim() || currentOrigin,
    username: document.getElementById('username')?.value?.trim() || '',
    password: document.getElementById('password')?.value ?? '',
    successType: document.getElementById('success-type')?.value || 'urlPrefix',
    successValue: document.getElementById('success-value')?.value?.trim() || ''
  }
}

// 兩個網址互為前綴（其中一個以另一個開頭）
function mutuallyPrefixed(a, b) {
  if (!a || !b) return false
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * 「還不能儲存」的原因（儲存與測試登入共用）。
 * @returns {Array<{ id: string, text: string, field: string }>}
 */
function collectReasons() {
  const form = readForm()
  const reasons = []
  for (const item of SELECTOR_FIELDS) {
    if (!currentSelectors[item.field]) {
      reasons.push({ id: `selector-${item.field}`, text: `還沒選${item.label}（按「在頁面上選取」）`, field: `pick-${item.field}-btn` })
    }
  }
  if (!form.password && !existingSite?.passwordEnc) {
    reasons.push({ id: 'password', text: '請輸入密碼', field: 'password' })
  }
  if (!form.successValue) {
    reasons.push({ id: 'success-value', text: '請填成功判定值（登入後才會出現的網址開頭或元素）', field: 'success-value' })
  } else if (form.successType === 'urlPrefix' && mutuallyPrefixed(form.successValue, form.loginUrl)) {
    reasons.push({ id: 'success-value', text: PREFIX_REASON, field: 'success-value' })
  }
  return reasons
}

// 原因區已經展開時，補齊一項就即時更新（不搶焦點）
function refreshGuardIfShown() {
  const container = document.getElementById('site-errors')
  if (!container || container.hidden) return
  saveGuard()?.show(collectReasons(), { focus: false })
}

// 判定值欄就地提示：與登入頁互為前綴時直接寫在欄位下方
function checkSuccessValueField() {
  const el = document.getElementById('success-value')
  if (!el) return
  const form = readForm()
  const bad = form.successType === 'urlPrefix' && form.successValue && mutuallyPrefixed(form.successValue, form.loginUrl)
  setFieldError(el, bad ? PREFIX_REASON : '')
}

/**
 * 問 background：這個視窗現在的作用分頁是哪個。
 * 面板的 `sender.tab` 永遠是 null、網址參數在面板重載後會被丟掉，
 * 載入當下查作用分頁又會在切換競態中拿到舊分頁——只有 windowId 這條路可靠。
 * @returns {Promise<number|null>}
 */
async function resolvePanelTab() {
  try {
    const win = await chrome.windows.getCurrent()
    if (win?.id === undefined || win?.id === null) return null
    const res = await chrome.runtime.sendMessage({ type: MSG.RESOLVE_PANEL_TAB, windowId: win.id })
    return res?.tabId ?? null
  } catch { return null }
}

// 面板目前服務的分頁：轉為可見時若沒變就不重畫（重畫會把剛填的密碼與剛選的欄位洗掉）
let panelTabId = null

/**
 * 一鍵帶入：面板所屬分頁**目前的實際網址**（轉址後的位置，不是設定裡的網址）的 origin＋路徑。
 * 與登入頁互為前綴時照樣填入，由守門說明（使用者應該先登入再按）。
 */
export async function useCurrentUrl() {
  const el = document.getElementById('success-value')
  const typeEl = document.getElementById('success-type')
  if (!el) return
  let url = ''
  try {
    if (currentTabId !== null && currentTabId !== undefined) {
      url = (await chrome.tabs.get(currentTabId))?.url || ''
    }
  } catch {}
  let value = ''
  try {
    const u = new URL(url)
    if (/^https?:$/.test(u.protocol)) value = u.origin + u.pathname
  } catch {}
  if (!value) {
    setFieldError(el, '讀不到這一頁的網址：請在要抓的網站分頁上開這個面板')
    return
  }
  el.value = value
  if (typeEl) typeEl.value = 'urlPrefix'
  checkSuccessValueField()
  refreshGuardIfShown()
}

// ---- 測試登入 ----

let testing = false
// 測試登入鈕的原文（site.html）：切站台時按鈕文字要回到這一句
const TEST_LOGIN_LABEL = '測試登入'
// 測試登入的輪次：測試途中切到另一個分頁（面板會自癒重畫成別的站台）時，
// 回來的結果不屬於畫面上這個站台，不得寫上去（AF-21 體檢 C P2）
let testRunId = 0

// 這一輪的結果還算不算數：輪次沒被重置、而且畫面上還是同一個站台
function isCurrentTestRun(runId, origin) {
  return runId === testRunId && origin === currentOrigin
}

function renderTestResult(res, errorText) {
  const list = document.getElementById('test-login-steps')
  const resultEl = document.getElementById('test-login-result')
  if (list) {
    const steps = Array.isArray(res?.steps) ? res.steps : []
    list.replaceChildren(...steps.map(s => {
      const li = document.createElement('li')
      li.dataset.step = String(s.step || '')
      li.dataset.ok = s.ok === true ? 'true' : 'false'
      const label = STEP_LABELS[s.step] || String(s.step || '')
      // 成敗用 SVG 圖示（不用符號字元）；圖示本身帶名稱，螢幕閱讀器念得出這一步成功或失敗
      const mark = icon(s.ok === true ? 'check' : 'close', { size: 14 })
      mark.removeAttribute('aria-hidden')
      mark.setAttribute('role', 'img')
      mark.setAttribute('aria-label', s.ok === true ? '成功' : '失敗')
      li.replaceChildren(mark, document.createTextNode(` ${label}${s.detail ? `：${s.detail}` : ''}`))
      return li
    }))
    list.hidden = steps.length === 0
  }
  if (resultEl) {
    let text
    let ok = false
    if (errorText) text = `測試沒有完成：${errorText}`
    else if (res?.alreadyLoggedIn === true) text = ALREADY_LOGGED_IN
    else if (res?.ok === true) { text = '登入成功：這組設定可以用（記得按儲存）'; ok = true }
    else if (res && Array.isArray(res.steps) && res.steps.length > 0) text = '登入失敗：看上面打叉的那一步'
    else text = `測試沒有完成：${res?.error || '背景沒有回應'}`
    resultEl.textContent = text
    resultEl.dataset.ok = ok ? 'true' : 'false'
    resultEl.hidden = false
  }
}

function clearTestResult() {
  const list = document.getElementById('test-login-steps')
  const resultEl = document.getElementById('test-login-result')
  if (list) { list.replaceChildren(); list.hidden = true }
  if (resultEl) { resultEl.textContent = ''; resultEl.hidden = true; delete resultEl.dataset.ok }
}

/**
 * 用表單上**尚未儲存**的設定測一次登入。密碼只放進這一則訊息，不寫 ctx、不寫 storage。
 */
export async function handleTestLogin() {
  if (testing) return
  const btn = document.getElementById('site-test-login')
  const reasons = collectReasons()
  if (reasons.length > 0) {
    saveGuard()?.show(reasons)
    return
  }
  const form = readForm()
  const msg = {
    type: MSG.TEST_LOGIN,
    site: {
      loginUrl: form.loginUrl,
      selectors: { user: currentSelectors.user, pass: currentSelectors.pass, submit: currentSelectors.submit },
      successCheck: { type: form.successType, value: form.successValue },
      username: form.username
    }
  }
  if (form.password) msg.password = form.password
  else msg.useSaved = true

  testing = true
  const runId = ++testRunId
  const runOrigin = currentOrigin
  const label = btn?.textContent
  if (btn) {
    btn.textContent = '測試中…'
    btn.setAttribute('aria-busy', 'true')
  }
  clearTestResult()
  try {
    const res = await chrome.runtime.sendMessage(msg)
    if (!isCurrentTestRun(runId, runOrigin)) return
    renderTestResult(res, '')
  } catch (err) {
    if (!isCurrentTestRun(runId, runOrigin)) return
    renderTestResult(null, String(err?.message || err || '背景沒有回應'))
  } finally {
    // 已經不是這一輪了：旗標與按鈕早就被 render() 重設過，別再蓋回去
    if (isCurrentTestRun(runId, runOrigin)) {
      testing = false
      if (btn) {
        btn.textContent = label || TEST_LOGIN_LABEL
        btn.removeAttribute('aria-busy')
      }
    }
  }
}

export async function render() {
  ensureMessageListener()
  // 每次重畫都從乾淨狀態起算：切到沒有站台設定的分頁時，
  // 不重置會沿用上一個分頁的 origin，把 A 站的設定寫到 B 站
  currentOrigin = ''
  currentTabId = null

  // 先走面板：參數放在 storage.session 的 panel:<tabId>
  if (globalThis.chrome?.sidePanel) {
    const tabId = await resolvePanelTab()
    panelTabId = tabId
    const ctx = tabId !== null ? await getPanelCtx(tabId) : null
    if (ctx?.kind === 'site') {
      currentOrigin = ctx.origin || ''
      currentTabId = ctx.tabId ?? tabId
    }
  }
  // 退路：舊版瀏覽器走彈出視窗，參數在網址上
  if (!currentOrigin) {
    const search = typeof window !== 'undefined' ? window.location?.search : ''
    const params = new URLSearchParams(search || '')
    currentOrigin = params.get('origin') || ''
    const tabIdParam = params.get('tabId')
    if (currentTabId === null || currentTabId === undefined) {
      currentTabId = tabIdParam ? Number(tabIdParam) : null
    }
  }

  const originEl = document.getElementById('origin')
  if (originEl) {
    originEl.textContent = currentOrigin
  }
  saveGuard()?.clear()
  clearTestResult()
  // 上一輪測試登入（可能還在跑）的結果不屬於現在畫面上的站台：作廢它，旗標與按鈕文字一起重設，
  // 否則切回來會卡在「測試中…」而且永遠按不動（testing 擋住）
  testRunId++
  testing = false
  const testBtn0 = document.getElementById('site-test-login')
  if (testBtn0) {
    testBtn0.textContent = TEST_LOGIN_LABEL
    testBtn0.removeAttribute('aria-busy')
  }
  // 判斷不出目前分頁時不能讓人存：存出去的是鍵為空字串的站台，永遠不會被任何網址命中
  const saveBtn = document.getElementById('site-save')
  if (saveBtn) saveBtn.disabled = !currentOrigin
  const noteEl0 = document.getElementById('site-note')
  if (!currentOrigin && noteEl0) {
    noteEl0.style.color = 'var(--danger)'
    noteEl0.textContent = '無法判斷目前的分頁，請關掉面板後在目標網頁上重新按右鍵「設定此站台登入」'
  }

  // 綁定選取按鈕點擊事件（表格驅動）
  for (const item of SELECTOR_FIELDS) {
    const btn = document.querySelector(`[data-action="pick-${item.field}"]`)
    if (btn) {
      btn.onclick = () => {
        chrome.runtime?.sendMessage?.({
          type: MSG.ENTER_PICK,
          purpose: item.purpose,
          tabId: currentTabId
        })
      }
    }
  }
  const useUrlBtn = document.getElementById('use-current-url')
  if (useUrlBtn) useUrlBtn.onclick = () => { useCurrentUrl() }
  const testBtn = document.getElementById('site-test-login')
  if (testBtn) testBtn.onclick = () => { handleTestLogin() }

  existingSite = currentOrigin ? await getSite(currentOrigin) : null

  const loginUrlEl = document.getElementById('login-url')
  const usernameEl = document.getElementById('username')
  const passwordEl = document.getElementById('password')
  const successTypeEl = document.getElementById('success-type')
  const successValueEl = document.getElementById('success-value')
  const noteEl = document.getElementById('site-note')

  if (noteEl && currentOrigin) noteEl.textContent = ''
  if (passwordEl) passwordEl.value = ''

  if (existingSite) {
    if (loginUrlEl) loginUrlEl.value = existingSite.loginUrl || ''
    if (usernameEl) usernameEl.value = existingSite.username || ''
    for (const item of SELECTOR_FIELDS) {
      currentSelectors[item.field] = existingSite.selectors?.[item.field] || null
      updateFieldDisplay(item.field)
    }
    if (successTypeEl) successTypeEl.value = existingSite.successCheck?.type || 'urlPrefix'
    if (successValueEl) successValueEl.value = existingSite.successCheck?.value || ''
  } else {
    if (loginUrlEl) loginUrlEl.value = currentOrigin
    if (usernameEl) usernameEl.value = ''
    for (const item of SELECTOR_FIELDS) {
      currentSelectors[item.field] = null
      updateFieldDisplay(item.field)
    }
    if (successTypeEl) successTypeEl.value = 'urlPrefix'
    if (successValueEl) successValueEl.value = ''
  }
  if (successValueEl) setFieldError(successValueEl, '')

  // 欄位改了就地更新（判定值與登入頁網址互相影響）
  for (const el of [loginUrlEl, passwordEl, successTypeEl, successValueEl]) {
    if (!el) continue
    el.onchange = () => { checkSuccessValueField(); refreshGuardIfShown() }
  }
  if (successValueEl) successValueEl.onblur = () => checkSuccessValueField()
}

export async function handleSave({ closeDelayMs = 1500 } = {}) {
  const noteEl = document.getElementById('site-note')
  if (!currentOrigin) {
    if (noteEl) {
      noteEl.style.color = 'var(--danger)'
      noteEl.textContent = '無法判斷目前的分頁，沒有存檔'
    }
    return
  }

  // 1. 還不能存的原因（缺選擇器、缺密碼、缺判定值、判定值與登入頁互為前綴）：列在固定列上方，零寫入
  const reasons = collectReasons()
  if (reasons.length > 0) {
    if (noteEl) noteEl.textContent = ''
    saveGuard()?.show(reasons)
    return
  }
  saveGuard()?.clear()

  // 2. 密碼欄有填則加密，留空則沿用既有密文（守門已確保兩者之一存在）
  const form = readForm()
  const passwordEnc = form.password ? await encryptSecret(form.password) : existingSite.passwordEnc

  // 3. 組出完整的 site 物件；使用者改好了就重新啟用、失敗計數歸零
  const site = {
    loginUrl: form.loginUrl,
    selectors: {
      user: currentSelectors.user,
      pass: currentSelectors.pass,
      submit: currentSelectors.submit
    },
    loginCheck: {
      type: 'urlPrefix',
      value: form.loginUrl
    },
    successCheck: {
      type: form.successType,
      value: form.successValue
    },
    username: form.username,
    passwordEnc,
    enabled: true,
    failStreak: 0
  }

  // 4. 存檔並提示；舊的紅燈（每日站台檢查留下的 site:<origin>）一併清掉，再請 background 重整燈號
  const origin = currentOrigin
  await saveSite(origin, site)
  await deleteHealthEntry('site:' + origin)
  try { await chrome.runtime?.sendMessage?.({ type: MSG.REBUILD_ALARMS }) } catch {}
  existingSite = site
  if (noteEl) {
    noteEl.style.color = 'var(--ok)'
    noteEl.textContent = '已儲存'
  }
  // 與任務面板同一套：存好之後把面板關掉（連同頁面上保留的標示）
  if (globalThis.chrome?.sidePanel && panelTabId !== null && typeof setTimeout === 'function') {
    const tabId = panelTabId
    setTimeout(() => {
      try { chrome.runtime.sendMessage({ type: MSG.CLOSE_PANEL, tabId }) } catch {}
    }, closeDelayMs)
  }
}

if (typeof document !== 'undefined' && document.getElementById('site-save') && globalThis.chrome?.runtime?.id) {
  applySavedTheme()
  // 面板文件在切換分頁後會被重載，而且載入當下解析得到的分頁可能是舊的：
  // 每次轉為可見都重畫一次（自癒）
  if (globalThis.chrome?.sidePanel) {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return
      // 分頁沒變就不重畫：使用者切去看一眼別的分頁，回來密碼與剛選的欄位要還在
      const tabId = await resolvePanelTab()
      if (tabId !== null && tabId === panelTabId) return
      render()
    })
  }
  document.getElementById('site-save')?.addEventListener('click', () => handleSave())
  document.getElementById('site-cancel')?.addEventListener('click', () => {
    // 面板沒有 window.close()：請 background 關它（順便清掉頁面上的標示）
    if (globalThis.chrome?.sidePanel && panelTabId !== null) {
      try { chrome.runtime.sendMessage({ type: MSG.CLOSE_PANEL, tabId: panelTabId }) } catch {}
      return
    }
    window.close()
  })
  render()
}
