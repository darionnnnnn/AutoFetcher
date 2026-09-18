// 抓取分頁的唯一入口：取得、沿用與釋放抓取專用分頁
//
// 給後續維護者的設計決策與探針事實說明：
// 1. 探針事實：
//    state:'minimized' 直接建立的視窗，頁面 viewport 是 0×0；
//    minimized 加 focused:false 會靜默變成一般視窗；
//    type:'popup' 會搶焦點；已最小化的視窗裡再開的作用中分頁(與在它之後開的背景分頁)同樣是 0×0——
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

// 回傳這次有沒有因為被卸載而重載(呼叫端要知道頁面是不是重新載入過)
export async function waitTabReady(tabId, opts = {}) {
  const { pollMs = 250, loadTimeoutMs = 30000 } = opts
  let reloaded = false
  try {
    const cur = await chrome.tabs.get(tabId)
    if (cur && cur.discarded === true) {
      await chrome.tabs.reload(tabId)
      reloaded = true
    }
  } catch {}

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
  return reloaded
}

// `holder.fetchTab.loads`:這個分頁載入過幾次(新建算 1,每次導覽或重載加 1)。
// 呼叫端靠它判斷「上一個任務做完前置動作之後,頁面有沒有被換掉」——比對次數,不比網址
// (前置動作的點擊可能把頁面導去別處,網址本來就會變)。
// `keepPage`:分頁還在就完全不動它(不導覽、不重載),給「同一頁、同一組前置動作已經做好」的下一個任務接著抓。
export async function acquireFetchTab(holder, url, opts = {}) {
  const { freshLoad = false, keepPage = false, pollMs = 250, loadTimeoutMs = 30000 } = opts

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
    if (keepPage) {
      // 什麼都不做:前置動作留下的狀態就是下一個任務要的
    } else if (freshLoad) {
      if (tab.url === url) {
        await chrome.tabs.reload(tabId)
      } else {
        await chrome.tabs.update(tabId, { url })
      }
      holder.fetchTab.loads++
    } else if (!sameOriginPath(tab.url, url)) {
      await chrome.tabs.update(tabId, { url })
      holder.fetchTab.loads++
    }
  } else {
    // 記著的分頁已經不在(使用者手動關掉之類):舊登記要取消,否則同一個 boot 的殘留項永遠沒人清;
    // `loads` 接著往上數——從 1 重算的話,呼叫端會把「全新的頁面」誤認成「沒被換過的那一頁」
    const prevLoads = holder.fetchTab ? holder.fetchTab.loads : 0
    if (holder.fetchTab) {
      await unregisterTab(holder.fetchTab.tabId)
      delete holder.fetchTab
    }
    // 預設是目前視窗的背景分頁(AF-20 使用者定案:不閃、不切過去);專用視窗要在設定頁選
    const settings = await getSettings()
    let mode = settings.fetchTabMode === 'window' ? 'window' : 'tab'

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

    holder.fetchTab = { tabId, windowId, loads: prevLoads + 1 }
  }

  if (await waitTabReady(tabId, { pollMs, loadTimeoutMs })) holder.fetchTab.loads++
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

  await waitTabReady(tabId, { pollMs, loadTimeoutMs })

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

// 同站台 Promise 佇列管理器
const originQueues = new Map()

// 同站台串行排隊執行
export function enqueueForOrigin(origin, fn) {
  let entry = originQueues.get(origin)
  if (!entry) {
    entry = {
      chain: Promise.resolve(),
      pending: 0
    }
    originQueues.set(origin, entry)
  }
  entry.pending++

  const run = async () => {
    try {
      return await fn(entry)
    } finally {
      entry.pending--
      if (entry.pending === 0) {
        // 先從 map 拿掉再釋放:釋放要等瀏覽器關分頁,這段期間排進來的工作若還拿到這個 entry,
        // 等它被刪掉之後再來的工作就會另建一條佇列,同站台變成兩條並行
        originQueues.delete(origin)
        try {
          await releaseFetchTab(entry)
        } catch {}
      }
    }
  }

  const resultPromise = entry.chain.then(run, run)
  entry.chain = resultPromise.catch(() => {})
  return resultPromise
}
