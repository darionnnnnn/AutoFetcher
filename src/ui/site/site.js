// AutoFetcher 站台登入設定視窗互動邏輯
import { getSite, saveSite } from '../../shared/storage.js'
import { encryptSecret } from '../../shared/crypto.js'
import { MSG } from '../../shared/messages.js'

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
}

let listenerBound = false
function ensureMessageListener() {
  if (listenerBound) return
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener(handlePickedMessage)
    listenerBound = true
  }
}

export async function render() {
  ensureMessageListener()

  const search = typeof window !== 'undefined' ? window.location?.search : ''
  const params = new URLSearchParams(search || '')
  currentOrigin = params.get('origin') || ''
  const tabIdParam = params.get('tabId')
  currentTabId = tabIdParam ? Number(tabIdParam) : null

  const originEl = document.getElementById('origin')
  if (originEl) {
    originEl.textContent = currentOrigin
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

  existingSite = currentOrigin ? await getSite(currentOrigin) : null

  const loginUrlEl = document.getElementById('login-url')
  const usernameEl = document.getElementById('username')
  const passwordEl = document.getElementById('password')
  const successTypeEl = document.getElementById('success-type')
  const successValueEl = document.getElementById('success-value')
  const noteEl = document.getElementById('site-note')

  if (noteEl) noteEl.textContent = ''
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
}

export async function handleSave() {
  const noteEl = document.getElementById('site-note')

  // 1. 三個選擇器任一個沒有時，顯示缺什麼並不存檔
  const missing = []
  for (const item of SELECTOR_FIELDS) {
    if (!currentSelectors[item.field]) {
      missing.push(item.label)
    }
  }
  if (missing.length > 0) {
    if (noteEl) {
      noteEl.style.color = 'var(--danger)'
      noteEl.textContent = `缺少選擇器：${missing.join('、')}`
    }
    return
  }

  // 2. 密碼欄有填則加密，留空則沿用既有密文
  const password = document.getElementById('password')?.value ?? ''
  let passwordEnc = null
  if (password) {
    passwordEnc = await encryptSecret(password)
  } else if (existingSite?.passwordEnc) {
    passwordEnc = existingSite.passwordEnc
  } else {
    if (noteEl) {
      noteEl.style.color = 'var(--danger)'
      noteEl.textContent = '請輸入密碼'
    }
    return
  }

  // 3. 組出完整的 site 物件
  const loginUrl = document.getElementById('login-url')?.value?.trim() || currentOrigin
  const username = document.getElementById('username')?.value?.trim() || ''
  const successType = document.getElementById('success-type')?.value || 'urlPrefix'
  const successValue = document.getElementById('success-value')?.value?.trim() || ''

  const site = {
    loginUrl,
    selectors: {
      user: currentSelectors.user,
      pass: currentSelectors.pass,
      submit: currentSelectors.submit
    },
    loginCheck: {
      type: 'urlPrefix',
      value: loginUrl
    },
    successCheck: {
      type: successType,
      value: successValue
    },
    username,
    passwordEnc,
    enabled: true,
    failStreak: 0
  }

  // 4. 存檔並提示
  const origin = currentOrigin || document.getElementById('origin')?.textContent?.trim() || ''
  await saveSite(origin, site)
  existingSite = site
  if (noteEl) {
    noteEl.style.color = 'var(--ok)'
    noteEl.textContent = '已儲存'
  }
}

if (typeof document !== 'undefined' && document.getElementById('site-save') && globalThis.chrome?.runtime?.id) {
  document.getElementById('site-save')?.addEventListener('click', () => handleSave())
  document.getElementById('site-cancel')?.addEventListener('click', () => window.close())
  render()
}
