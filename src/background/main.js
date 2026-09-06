// AutoFetcher MV3 Background Service Worker 入口總接線
import { init as initStorage, getTask, saveTask, getRecordsByDate } from '../shared/storage.js'
import { MSG } from '../shared/messages.js'
import * as diag from '../shared/diag.js'
import {
  rebuildAlarms,
  ensureWatchdog,
  slotOf,
  nextDailyRun,
  shouldRunInterval,
  nextIntervalRun,
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
import { injectContent } from './inject.js'
import { scheduleSiteCheck, runSiteCheck } from './sitecheck.js'
import { isSuccess } from '../shared/record-status.js'
import { parentIdOf, buildSeriesIndex, nameOf } from '../shared/series-index.js'


// 重選時把選好的值寫回任務：沒動的值保留原本的 key 與名稱（紀錄靠 key），新值配新 key
function pickSpecOf(pick) {
  if (pick?.cell) return { cell: pick.cell }
  if (pick?.block) return { block: { axis: pick.block.axis, index: pick.block.index, headerText: pick.block.headerText } }
  return null
}
function sameSpec(a, b) {
  return JSON.stringify(pickSpecOf(a)) === JSON.stringify(pickSpecOf(b))
}
function defaultFieldName(pick, n) {
  if (pick?.cell) {
    const r = pick.cell.row?.header || ''
    const c = pick.cell.col?.header || ''
    return (r && c) ? `${r} · ${c}` : (r || c || `值 ${n}`)
  }
  return pick?.block?.headerText || `值 ${n}`
}
function applyRepick(task, picks) {
  if (picks.length === 0) return
  const hadFields = Array.isArray(task.fields) && task.fields.length > 0
  if (!hadFields && picks.length === 1) {
    // 單值任務只換定位與規格，聚合方式沿用
    const spec = pickSpecOf(picks[0])
    if (!spec) return
    task.mode = 'block'
    task.spec = { ...(task.spec || {}), mode: 'block' }
    delete task.spec.fields
    task.spec.block = spec.cell
      ? { cell: spec.cell }
      : { ...spec.block, aggregate: task.spec?.block?.aggregate || 'sum' }
    return
  }
  const aggregate = task.spec?.block?.aggregate
    || (task.spec?.fields || []).find(f => f.block?.aggregate)?.block?.aggregate
    || 'sum'
  const oldSpecs = task.spec?.fields || []
  const oldNames = new Map((task.fields || []).map(f => [f.key, f.name]))
  const fields = []
  const specFields = []
  picks.forEach((pick, i) => {
    const spec = pickSpecOf(pick)
    if (!spec) return
    const kept = oldSpecs.find(f => sameSpec(f, pick))
    const key = kept ? kept.key : crypto.randomUUID().slice(0, 8)
    const name = kept ? (oldNames.get(kept.key) || defaultFieldName(pick, i + 1)) : defaultFieldName(pick, i + 1)
    fields.push({ key, name })
    specFields.push(spec.cell ? { key, cell: spec.cell } : { key, block: { ...spec.block, aggregate } })
  })
  task.mode = 'block'
  task.fields = fields
  task.spec = { ...(task.spec || {}), mode: 'block', fields: specFields }
  delete task.spec.block
}

// 由任務的擷取規格推出選取模式要預先勾回去的值（多值走 spec.fields，單值走 spec.block）
function preselectOf(task) {
  if (!task || !task.spec) return undefined
  if (Array.isArray(task.spec.fields) && task.spec.fields.length > 0) {
    return task.spec.fields
      .map(f => (f?.cell ? { cell: f.cell } : (f?.block ? { block: f.block } : null)))
      .filter(Boolean)
  }
  if (task.spec.block) return [{ block: task.spec.block }]
  return undefined
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
  // 名稱可能帶原始排程槽:<taskId>:retry:<n>@<slot>
  let slot = ''
  const at = name.lastIndexOf('@')
  if (at !== -1) {
    slot = name.slice(at + 1)
    name = name.slice(0, at)
  }
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
  return { taskId, attempt: Number(attemptStr), slot }
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

// 短暫等待輔助函式
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 建立右鍵選單項目
export async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll()
    chrome.contextMenus.create({ id: 'af-root', title: 'AutoFetcher', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-pick', parentId: 'af-root', title: '選取要抓的內容', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-site-login', parentId: 'af-root', title: '設定此站台登入', contexts: ['all'] })
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
    await scheduleSiteCheck()
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
    await scheduleSiteCheck()
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

    // 3. 站台健康檢查
    if (name === '__sitecheck') {
      await runSiteCheck(testOpts)
      await scheduleSiteCheck()
      return
    }

    // 4. 預檢演練
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
      // 重試補的是原本那一格;舊格式沒帶槽時才退回當下時刻
      const retrySlot = retry.slot || slotOf(Date.now())
      await runTask(task, { slot: retrySlot, attempt: retry.attempt + 1, ...testOpts })
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
      // interval 是 one-shot alarm,必須先把下一次排好,任何提早 return 都不能跳過重排
      if (task.schedule?.type === 'interval') {
        const nextWhen = nextIntervalRun(task, Date.now())
        if (nextWhen !== null) await chrome.alarms.create(alarm.name, { when: nextWhen })
        // 用「排定時刻」判斷時段,不是實際觸發時刻:
        // 晚觸發(休眠喚醒、worker 冷啟動)會滑出時段末端,把本來合法的那一格丟掉
        const decideAt = alarm.scheduledTime ?? Date.now()
        if (!shouldRunInterval(task, decideAt)) return
      }

      // interval 的槽取 alarm 排定時刻(對齊格線),晚觸發不可自成新槽,冪等帳本靠它
      const slot = task.schedule?.type === 'daily'
        ? getDailySlot(task, parsed.index)
        : slotOf(alarm.scheduledTime ?? Date.now())
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
      if (!task) {
        return { ok: false, outcome: 'failed', error: '找不到任務' }
      }
      const record = await runTask(task, {
        slot: slotOf(Date.now()),
        ...(msg.__testOpts || {}),
        reason: 'manual'
      })
      if (!record) {
        return { ok: true, outcome: 'failed', status: 'error', error: '沒有結果' }
      }
      // 多值任務要逐值回報，只回第一筆使用者看不出另外幾個值怎麼了
      let values
      if (Array.isArray(task.fields) && task.fields.length > 0 && typeof record.slot === 'string') {
        // 同一分鐘按兩次會有兩組紀錄，每個值只留最新的那一筆
        const latestById = new Map()
        for (const r of await getRecordsByDate(record.slot.slice(0, 10))) {
          if (r.slot !== record.slot || parentIdOf(r.taskId) !== task.id) continue
          const prev = latestById.get(r.taskId)
          if (!prev || String(r.capturedAt) >= String(prev.capturedAt)) latestById.set(r.taskId, r)
        }
        const sameSlot = [...latestById.values()]
        if (sameSlot.length > 0) {
          const idx = buildSeriesIndex([task])
          values = sameSlot.map(r => ({
            // 按鈕就在那個任務旁邊，用值名就夠，不必每個都重複任務名
            name: idx.byId[r.taskId]?.shortName || nameOf(idx, r.taskId),
            ok: isSuccess(r),
            value: isSuccess(r) ? r.value : undefined,
            error: isSuccess(r) ? undefined : (r.error || r.status)
          }))
        }
      }

      if (isSuccess(record)) {
        return { ok: true, outcome: 'done', status: record.status, value: record.value, values }
      }
      return { ok: true, outcome: 'failed', status: record.status, error: record.error || '', values }
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

    if (msg.type === MSG.PICKED) {
      if (msg.cancelled === true) {
        return { ok: true }
      }

      if (msg.purpose === 'preaction' || (typeof msg.purpose === 'string' && msg.purpose.startsWith('login-'))) {
        try {
          await chrome.runtime.sendMessage(msg)
        } catch {}
        return { ok: true }
      }

      if (msg.purpose === 'task') {
        const payload = {
          locator: msg.locator,
          preview: msg.preview,
          previewValue: msg.previewValue,
          blockInfo: msg.blockInfo,
          tabId: sender?.tab?.id,
          url: sender?.tab?.url,
          nameHint: msg.nameHint,
          // 使用者一次挑的那幾個值；漏掉這一個欄位，多值任務就會退化成單值
          picks: msg.picks
        }
        const ctx = encodeURIComponent(JSON.stringify(payload))
        const base = typeof chrome.runtime?.getURL === 'function'
          ? await chrome.runtime.getURL('ui/picker/picker.html')
          : 'ui/picker/picker.html'

        await chrome.windows.create({
          url: `${base}?ctx=${ctx}`,
          type: 'popup',
          width: 480,
          height: 760
        })
        return { ok: true }
      }

      if (msg.purpose === 'repick') {
        const task = await getTask(msg.taskId)
        if (!task) {
          return { ok: true }
        }
        task.locator = msg.locator
        applyRepick(task, Array.isArray(msg.picks) ? msg.picks : [])
        await saveTask(task)
        return { ok: true }
      }

      return { ok: true }
    }

    if (msg.type === MSG.ENTER_PICK) {
      if (msg.tabId) {
        await injectContent(msg.tabId)
        const known = msg.taskId ? await getTask(msg.taskId) : null
        await chrome.tabs.sendMessage(msg.tabId, {
          type: MSG.ENTER_PICK,
          purpose: msg.purpose,
          taskId: msg.taskId,
          // 重選開的是新分頁，那裡沒有「上次右鍵的元素」可用；
          // 要靠任務自己的 locator 才找得到目標，也才勾得回既有的值
          locator: msg.locator || known?.locator,
          preselect: msg.preselect || preselectOf(known)
        })
        return { ok: true }
      }

      const task = await getTask(msg.taskId)
      if (!task) {
        return { ok: false }
      }
      const tab = await chrome.tabs.create({ url: task.url, active: true })
      if (!tab?.id) return { ok: false }
      const pollMs = msg.pollMs ?? 250
      const loadTimeoutMs = msg.loadTimeoutMs ?? 30000
      let tabInfo = await chrome.tabs.get(tab.id)
      const loadStart = Date.now()
      while (tabInfo?.status !== 'complete' && Date.now() - loadStart < loadTimeoutMs) {
        await sleep(pollMs)
        tabInfo = await chrome.tabs.get(tab.id)
      }
      await injectContent(tab.id)
      await chrome.tabs.sendMessage(tab.id, {
        type: MSG.ENTER_PICK,
        purpose: msg.purpose || 'repick',
        taskId: msg.taskId,
        // 這是重選最常走的那條路（任務頁不帶 tabId）：新分頁沒有「上次右鍵的元素」，
        // 不帶這兩個欄位就沒有預選對象，既有的值也勾不回來
        locator: msg.locator || task.locator,
        preselect: msg.preselect || preselectOf(task)
      })
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

// 處理通知本體點擊事件
export async function handleNotificationClick(notificationId) {
  try {
    if (typeof notificationId !== 'string') return

    // 格式：<taskId>:alert:<alertId>:<YYYY-MM-DD>
    const match = notificationId.match(/^(.+):alert:(.+):(\d{4}-\d{2}-\d{2})$/)
    if (!match) return

    const taskId = match[1]
    const date = match[3]

    const base = typeof chrome.runtime?.getURL === 'function'
      ? await chrome.runtime.getURL('ui/report/report.html')
      : 'ui/report/report.html'
    // 報表的 hash 參數是 taskIds（複數），寫成 task= 的話只會定位到日期、篩不到任務
    const url = `${base}#view=history&from=${date}&to=${date}&taskIds=${encodeURIComponent(taskId)}`

    await chrome.tabs.create({ url })
    await chrome.notifications.clear(notificationId)
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

    if (info.menuItemId === 'af-site-login') {
      if (!tab?.id) return
      let origin = ''
      try {
        origin = tab.url ? new URL(tab.url).origin : ''
      } catch {}
      const base = typeof chrome.runtime?.getURL === 'function'
        ? await chrome.runtime.getURL('ui/site/site.html')
        : 'ui/site/site.html'
      await chrome.windows.create({
        url: `${base}?origin=${encodeURIComponent(origin)}&tabId=${tab.id}`,
        type: 'popup',
        width: 480,
        height: 760
      })
      await injectContent(tab.id)
      await chrome.tabs.sendMessage(tab.id, { type: MSG.ENTER_PICK, purpose: 'login-user' })
      return
    }

    if (info.menuItemId === 'af-pick') {
      if (!tab?.id) return
      await injectContent(tab.id)
      await chrome.tabs.sendMessage(tab.id, { type: MSG.ENTER_PICK, purpose: 'task' })
      return
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
chrome.notifications.onClicked.addListener(handleNotificationClick)
chrome.contextMenus.onClicked.addListener(handleContextMenu)
