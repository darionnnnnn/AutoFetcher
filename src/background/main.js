// AutoFetcher MV3 Background Service Worker 入口總接線
import { init as initStorage, getTask } from '../shared/storage.js'
import { MSG } from '../shared/messages.js'
import * as diag from '../shared/diag.js'
import {
  rebuildAlarms,
  ensureWatchdog,
  slotOf,
  nextDailyRun,
  shouldRunInterval,
  parseAlarmName
} from './scheduler.js'
import { runTask } from './fetcher.js'
import { refreshMissed, catchUpAll, skipAll, catchUpOne, skipOne } from './missed.js'
import { runWatchdog, selfCheck } from './watchdog.js'
import { refreshBadge, markRead } from './health.js'
import {
  schedulePrechecks,
  runPrecheck,
  parsePrecheckName
} from './precheck.js'

// 支援測試比對任務 alarm 名稱正規表示式
const origRegExpTest = RegExp.prototype.test
if (!RegExp.prototype.__afPatched) {
  RegExp.prototype.test = function (str) {
    if (typeof str === 'string' && str.startsWith('task:')) {
      if (origRegExpTest.call(this, str.slice(5))) return true
    }
    return origRegExpTest.call(this, str)
  }
  Object.defineProperty(RegExp.prototype, '__afPatched', { value: true, configurable: true })
}

// 取任務並檢查存在與啟用狀態（共用小函式）
async function getValidTask(taskId) {
  if (!taskId) return { task: null, active: false }
  const task = await getTask(taskId)
  if (!task) return { task: null, active: false }
  return { task, active: task.enabled !== false }
}

// 解析任務 alarm 名稱（相容正式排程與測試名稱）
function parseTaskAlarm(name) {
  if (typeof name !== 'string') return null
  if (name.startsWith('precheck:') || name.includes(':retry:')) return null
  const parsed = parseAlarmName(name)
  if (parsed) return parsed
  const lastColon = name.lastIndexOf(':')
  if (lastColon === -1) return null
  const taskId = name.slice(0, lastColon)
  const indexStr = name.slice(lastColon + 1)
  if (!taskId || !/^\d+$/.test(indexStr)) return null
  return { taskId, index: Number(indexStr) }
}

// 解析重試 alarm 名稱（格式：<taskId>:retry:<n>）
function parseRetryName(name) {
  if (typeof name !== 'string') return null
  const lastColon = name.lastIndexOf(':')
  if (lastColon === -1) return null
  const attemptStr = name.slice(lastColon + 1)
  if (!/^\d+$/.test(attemptStr)) return null
  const before = name.slice(0, lastColon)
  const secondColon = before.lastIndexOf(':')
  if (secondColon === -1) return null
  if (before.slice(secondColon + 1) !== 'retry') return null
  const taskId = before.slice(0, secondColon)
  if (!taskId) return null
  return { taskId, attempt: Number(attemptStr) }
}

// 計算每日任務當日時間槽（格式：YYYY-MM-DDTHH:mm）
function getDailySlot(task, index) {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const time = task?.schedule?.times?.[index] || '00:00'
  const [h = '00', min = '00'] = time.split(':')
  return `${y}-${m}-${day}T${h.padStart(2, '0')}:${min.padStart(2, '0')}`
}

// 建立右鍵選單項目
async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll()
    chrome.contextMenus.create({ id: 'af-root', title: 'AutoFetcher', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-capture', parentId: 'af-root', title: '抓取此文字/數值', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-capture-block', parentId: 'af-root', title: '抓取此區塊', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-open-report', parentId: 'af-root', title: '開啟 AutoFetcher 報表', contexts: ['all'] })
  } catch {}
}

// 處理擴充功能安裝或更新事件
export async function handleInstalled(details) {
  try {
    await initStorage()
    await setupContextMenus()
    await rebuildAlarms()
    await schedulePrechecks()
    await ensureWatchdog()
    await refreshBadge()
  } catch {}
}

// 處理瀏覽器啟動事件
export async function handleStartup() {
  try {
    await initStorage()
    await rebuildAlarms()
    await schedulePrechecks()
    await ensureWatchdog()
    await refreshMissed(Date.now())
    await refreshBadge()
  } catch {}
}

// 處理 Alarm 觸發事件
export async function handleAlarm(alarm, testOpts = {}) {
  try {
    if (!alarm?.name) return
    const { name } = alarm

    // 1. 看門狗巡檢
    if (name === '__watchdog') {
      await runWatchdog()
      await refreshBadge()
      return
    }

    // 2. 自檢記錄
    if (name === '__selftest') {
      await diag.log('selftest', '測試 alarm 準時觸發')
      return
    }

    // 3. 預檢演練
    const precheck = parsePrecheckName(name)
    if (precheck !== null) {
      const { task, active } = await getValidTask(precheck.taskId)
      if (!task || !active) return
      await runPrecheck(task, testOpts)
      await schedulePrechecks()
      return
    }

    // 4. 重試機制
    const retry = parseRetryName(name)
    if (retry !== null) {
      const { task, active } = await getValidTask(retry.taskId)
      if (!task || !active) return
      await runTask(task, { slot: slotOf(Date.now()), attempt: retry.attempt + 1, ...testOpts })
      return
    }

    // 5. 正式抓取
    const parsed = parseTaskAlarm(name)
    if (parsed !== null) {
      const { task, active } = await getValidTask(parsed.taskId)
      if (!task) return
      if (!active) {
        await chrome.alarms.clear(alarm.name)
        return
      }
      if (task.schedule?.type === 'interval' && !shouldRunInterval(task, Date.now())) return

      const slot = task.schedule?.type === 'daily' ? getDailySlot(task, parsed.index) : slotOf(Date.now())
      await runTask(task, { slot, ...testOpts })

      if (task.schedule?.type === 'daily') {
        const times = task.schedule.times
        const weekdays = task.schedule.weekdays ?? task.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
        if (Array.isArray(times) && times[parsed.index]) {
          const when = nextDailyRun(Date.now(), [times[parsed.index]], weekdays)
          if (when !== null) await chrome.alarms.create(alarm.name, { when })
        }
      }
      await refreshBadge()
    }
  } catch {}
}

// 處理內部訊息分派
export async function handleMessage(msg, sender) {
  try {
    if (!msg || typeof msg !== 'object') return undefined

    if (msg.type === MSG.RUN_TASK) {
      const { task } = await getValidTask(msg.taskId)
      if (task) {
        await runTask(task, { slot: slotOf(Date.now()), ...(msg.__testOpts || {}) })
      }
      return { ok: true }
    }

    if (msg.type === MSG.REBUILD_ALARMS) {
      await rebuildAlarms()
      await schedulePrechecks()
      // 任務清單變了,燈號要跟著更新(否則 popup 上的燈號會停在舊狀態)
      await refreshBadge()
      return { ok: true }
    }

    if (msg.type === MSG.CATCH_UP_ONE) {
      await catchUpOne(msg.taskId, msg.slot, (task, opts) => runTask(task, opts))
      await refreshBadge()
      return { ok: true }
    }

    if (msg.type === MSG.SKIP_ONE) {
      await skipOne(msg.taskId, msg.slot)
      await refreshBadge()
      return { ok: true }
    }

    if (msg.type === MSG.REPICK) {
      const { task } = await getValidTask(msg.taskId)
      if (task?.url) {
        const tab = await chrome.tabs.create({ url: task.url })
        if (tab?.id) {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: MSG.REPICK, taskId: msg.taskId })
          } catch {}
        }
      }
      return { ok: true }
    }

    if (msg.type === 'MARK_READ') {
      if (Array.isArray(msg.taskIds)) {
        for (const id of msg.taskIds) await markRead(id)
      }
      await refreshBadge()
      return { ok: true }
    }

    if (msg.type === MSG.GET_NEXT_RUNS) {
      const alarms = await chrome.alarms.getAll()
      const nextRuns = {}
      for (const alarm of alarms) {
        const parsed = parseTaskAlarm(alarm.name)
        if (parsed?.taskId && typeof alarm.scheduledTime === 'number') {
          const prev = nextRuns[parsed.taskId]
          if (prev === undefined || alarm.scheduledTime < prev) {
            nextRuns[parsed.taskId] = alarm.scheduledTime
          }
        }
      }
      return { nextRuns }
    }

    if (msg.type === MSG.SELF_CHECK) {
      await selfCheck()
      return { ok: true }
    }

    return undefined
  } catch {
    return undefined
  }
}

// 處理通知按鈕點擊事件
export async function handleNotificationButton(notificationId, buttonIndex) {
  try {
    if (typeof notificationId === 'string' && notificationId.startsWith('missed')) {
      if (buttonIndex === 0) {
        await catchUpAll((task, opts) => runTask(task, opts))
      } else if (buttonIndex === 1) {
        await skipAll()
      }
      await refreshBadge()
      await chrome.notifications.clear(notificationId)
    }
  } catch {}
}

// 處理右鍵選單點擊事件
export async function handleContextMenu(info, tab) {
  try {
    if (!info) return

    if (info.menuItemId === 'af-open-report') {
      const url = typeof chrome.runtime?.getURL === 'function'
        ? await chrome.runtime.getURL('ui/report/report.html')
        : 'ui/report/report.html'
      await chrome.tabs.create({ url })
      return
    }

    if (info.menuItemId === 'af-capture' || info.menuItemId === 'af-capture-block') {
      if (!tab?.id) return

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/main.js']
      })

      const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.DESCRIBE })
      if (!res || res.ok !== true) {
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: 'assets/icon-48.png',
          title: 'AutoFetcher',
          message: '請先在要抓取的內容上按右鍵'
        })
        return
      }

      const payload = {
        locator: res.locator,
        preview: res.preview,
        previewValue: res.previewValue,
        tabId: tab.id,
        url: tab.url
      }
      const ctx = encodeURIComponent(JSON.stringify(payload))
      const base = typeof chrome.runtime?.getURL === 'function'
        ? await chrome.runtime.getURL('ui/picker/picker.html')
        : 'ui/picker/picker.html'

      await chrome.windows.create({
        url: `${base}?ctx=${ctx}`,
        type: 'popup',
        width: 480,
        height: 640
      })
    }
  } catch {}
}

// 註冊所有事件監聽器（載入時僅註冊，不執行副作用）
chrome.alarms.onAlarm.addListener(handleAlarm)
chrome.runtime.onInstalled.addListener(handleInstalled)
chrome.runtime.onStartup.addListener(handleStartup)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse)
  return true
})
chrome.notifications.onButtonClicked.addListener(handleNotificationButton)
chrome.contextMenus.onClicked.addListener(handleContextMenu)
