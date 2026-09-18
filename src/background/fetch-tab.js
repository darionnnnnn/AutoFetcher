// 抓取分頁的唯一入口：取得、沿用與釋放抓取專用分頁
//
// 給後續維護者的設計決策與探針事實說明：
// 1. 探針事實：
//    state:'minimized' 直接建立的視窗，頁面 viewport 是 0×0；
//    minimized 加 focused:false 會靜默變成一般視窗；
//    type:'popup' 會搶焦點；已最小化的視窗裡再開的分頁同樣是 0×0——
//    所以才「先不聚焦帶尺寸建立、再最小化、之後同佇列只導覽不開新分頁」。
// 2. 為什麼不沿用使用者的分頁：
//    會在使用者眼前點按鈕、捲動、填登入；而且那一頁可能幾小時沒刷新。
// 3. 孤兒判定為什麼用 boot 不用 inflight：
//    同站台兩個任務交接的空檔 inflight 是空的，若用 inflight 會在交接空檔誤關正在使用的視窗與分頁。

import { getSettings } from '../shared/storage.js'
import { sameOriginPath } from './frames.js'
import { log } from '../shared/diag.js'

const BOOT = `${Date.now()}-${Math.random().toString(36).slice(2)}`
let registryQueue = Promise.resolve()

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function registerTab(tabId, windowId = null) {
  registryQueue = registryQueue
    .catch(() => {})
    .then(async () => {
      const res = await chrome.storage.session.get('fetchTabs')
      const list = Array.isArray(res.fetchTabs) ? res.fetchTabs : []
      list.push({ tabId, windowId, boot: BOOT })
      await chrome.storage.session.set({ fetchTabs: list })
    })
  return registryQueue
}

function unregisterTab(tabId) {
  registryQueue = registryQueue
    .catch(() => {})
    .then(async () => {
      const res = await chrome.storage.session.get('fetchTabs')
      const list = Array.isArray(res.fetchTabs) ? res.fetchTabs : []
      const next = list.filter(e => e.tabId !== tabId)
      await chrome.storage.session.set({ fetchTabs: next })
    })
  return registryQueue
}

async function waitForComplete(tabId, pollMs, loadTimeoutMs) {
  const start = Date.now()
  while (true) {
    let tab = null
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      break
    }
    if (tab && tab.status === 'complete') {
      break
    }
    if (Date.now() - start >= loadTimeoutMs) {
      break
    }
    await sleep(pollMs)
  }
}

export async function acquireFetchTab(holder, url, opts = {}) {
  const { freshLoad = false, pollMs = 250, loadTimeoutMs = 30000 } = opts

  let tab = null
  if (holder.fetchTab) {
    try {
      tab = await chrome.tabs.get(holder.fetchTab.tabId)
    } catch {
      tab = null
    }
  }

  let tabId
  if (tab) {
    tabId = holder.fetchTab.tabId
    if (freshLoad) {
      if (tab.url === url) {
        await chrome.tabs.reload(tabId)
      } else {
        await chrome.tabs.update(tabId, { url })
      }
    } else {
      if (!sameOriginPath(tab.url, url)) {
        await chrome.tabs.update(tabId, { url })
      }
    }
  } else {
    const settings = await getSettings()
    let mode = settings.fetchTabMode === 'tab' ? 'tab' : 'window'

    if (mode === 'tab') {
      const windows = await chrome.windows.getAll()
      if (windows.length === 0) {
        mode = 'window'
      }
    }

    let windowId = null
    if (mode === 'window') {
      try {
        const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 800 })
        tabId = win.tabs[0].id
        windowId = win.id
        await registerTab(tabId, windowId)
        // 最小化失敗只是看得到視窗,不是抓不到;視窗已登記,不能掉進下面的退路再開一個分頁(會留下沒人關的視窗)
        try {
          await chrome.windows.update(windowId, { state: 'minimized' })
        } catch {}
      } catch (err) {
        await log('fetch_window_fallback', String(err && err.message ? err.message : err))
        const fallbackTab = await chrome.tabs.create({ url, active: false })
        tabId = fallbackTab.id
        windowId = null
        await registerTab(tabId, windowId)
      }
    } else {
      const createdTab = await chrome.tabs.create({ url, active: false })
      tabId = createdTab.id
      windowId = null
      await registerTab(tabId, windowId)
    }

    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false })
    } catch {}

    holder.fetchTab = { tabId, windowId }
  }

  try {
    const cur = await chrome.tabs.get(tabId)
    if (cur && cur.discarded === true) {
      await chrome.tabs.reload(tabId)
    }
  } catch {}

  await waitForComplete(tabId, pollMs, loadTimeoutMs)
  return tabId
}

export async function releaseFetchTab(holder) {
  if (!holder.fetchTab) return
  const { tabId, windowId } = holder.fetchTab
  if (windowId != null) {
    try {
      await chrome.windows.remove(windowId)
    } catch {}
  } else {
    try {
      await chrome.tabs.remove(tabId)
    } catch {}
  }
  await unregisterTab(tabId)
  delete holder.fetchTab
}

export async function openForegroundTab(url, opts = {}) {
  const { pollMs = 250, loadTimeoutMs = 30000 } = opts
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
  const activeTabs = await chrome.tabs.query({ active: true, windowId: win.id })
  const originalTabId = activeTabs && activeTabs.length > 0 ? activeTabs[0].id : null

  const tab = await chrome.tabs.create({ url, active: true, windowId: win.id })
  const tabId = tab.id

  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false })
  } catch {}

  await registerTab(tabId, null)

  try {
    const cur = await chrome.tabs.get(tabId)
    if (cur && cur.discarded === true) {
      await chrome.tabs.reload(tabId)
    }
  } catch {}

  await waitForComplete(tabId, pollMs, loadTimeoutMs)

  const restore = async () => {
    if (originalTabId != null) {
      try {
        await chrome.tabs.update(originalTabId, { active: true })
      } catch {}
    }
    try {
      await chrome.tabs.remove(tabId)
    } catch {}
    await unregisterTab(tabId)
  }

  return { tabId, restore }
}

export async function cleanOrphanFetchTabs() {
  const res = await chrome.storage.session.get('fetchTabs')
  const list = Array.isArray(res.fetchTabs) ? res.fetchTabs : []
  if (list.length === 0) return

  for (const entry of list) {
    if (entry.boot !== BOOT) {
      if (entry.windowId != null) {
        try {
          await chrome.windows.remove(entry.windowId)
        } catch {}
      } else if (entry.tabId != null) {
        try {
          await chrome.tabs.remove(entry.tabId)
        } catch {}
      }
      await unregisterTab(entry.tabId)
    }
  }
}
