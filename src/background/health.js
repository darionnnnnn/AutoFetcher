// AutoFetcher 健康狀態彙總與工具列燈號 (SPEC §12.1)
import { getTasks, getHealthMap, updateHealthMap, updateHealthMapForExecution, getMissedList } from '../shared/storage.js'
import { RED_STATUSES, WARN_STATUSES, statusTextOf } from '../shared/record-status.js'

// 健康紀錄裡站台項目的鍵前綴（sitecheck.js 寫入）
const SITE_PREFIX = 'site:'

// 依啟用任務、健康紀錄與錯過清單計算燈號狀態（純函式）
export function computeHealth(tasks = [], healthMap = {}, missed = []) {
  const taskList = Array.isArray(tasks) ? tasks : []
  // 只看 tasks 裡存在且 enabled !== false 的啟用中任務
  const activeTasks = taskList.filter((t) => t && t.enabled !== false)
  const health = healthMap && typeof healthMap === 'object' ? healthMap : {}
  const missedList = Array.isArray(missed) ? missed : []
  const hasMissed = missedList.length > 0

  // 沒有任何啟用中的任務時呈現停用燈號
  if (activeTasks.length === 0) {
    return {
      level: 'off',
      redCount: 0,
      knownRedCount: 0,
      yellowCount: 0,
      summary: '已暫停'
    }
  }

  // 紅燈（資料沒在收）：修好之前一直算，與已讀無關；已讀只讓它不進 badge 數字（AF-21 批次 5 定案 1）
  // 黃燈：可「知道了」，已讀就不計；狀態改變時 setTaskHealth 會把 read 重設為未讀
  const redTasks = []
  const unreadYellowTasks = []

  const classify = (task, record) => {
    if (RED_STATUSES.includes(record.status)) {
      redTasks.push({ task, record, read: record.read === true })
    } else if (WARN_STATUSES.includes(record.status) && record.read !== true) {
      unreadYellowTasks.push({ task, record })
    }
  }

  for (const task of activeTasks) {
    const record = health[task.id]
    // 沒有健康紀錄的新任務視為正常，不列為異常
    if (!record || !record.status) continue
    classify(task, record)
  }

  // 站台層級的健康項目（key 為 site:<origin>，來自每日站台登入檢查）。
  // 站台登不進去等於所有靠它的任務都會失敗，只跳一次通知不夠，要一起進燈號。
  for (const [key, record] of Object.entries(health)) {
    if (!key.startsWith(SITE_PREFIX)) continue
    if (!record || !record.status) continue
    classify({ name: key.slice(SITE_PREFIX.length) }, record)
  }

  // redCount＝未讀的紅（badge 數字）；knownRedCount＝已知悉但還沒修好的紅
  const redCount = redTasks.filter(x => !x.read).length
  const knownRedCount = redTasks.length - redCount
  const yellowCount = unreadYellowTasks.length + (hasMissed ? 1 : 0)

  let level = 'green'
  let summary = '一切正常'

  if (redTasks.length > 0) {
    level = 'red'
    // 未讀的排前面，已讀的標「（已知悉）」
    const ordered = [...redTasks.filter(x => !x.read), ...redTasks.filter(x => x.read)]
    const items = ordered.map(
      ({ task, record, read }) => `${task.name || task.id} ${statusTextOf(record.status) || record.reason || '抓取失敗'}${read ? '（已知悉）' : ''}`
    )
    const desc = items.slice(0, 2).join('、') + (items.length > 2 ? '等' : '')
    summary = `${redTasks.length} 個任務異常:${desc}`
  } else if (yellowCount > 0) {
    level = 'yellow'
    const items = unreadYellowTasks.map(
      ({ task, record }) => `${task.name || task.id} ${statusTextOf(record.status) || record.reason || '注意'}`
    )
    if (hasMissed) {
      items.push('錯過排程')
    }
    const desc = items.slice(0, 2).join('、') + (items.length > 2 ? '等' : '')
    summary = `${yellowCount} 個任務注意:${desc}`
  }

  return { level, redCount, knownRedCount, yellowCount, summary }
}

// 各燈號對應的工具列圖示。**一定要以 / 開頭**：service worker 在 /background/，相對路徑會解析成
// /background/icons/…，setIcon 讀不到就整個丟例外（AF-21 煙霧測試抓到：丟出來的例外讓抓取回報失敗）
const ICON_COLOR = { red: 'red', yellow: 'yellow', green: 'green', off: 'gray' }

export function iconPathOf(level) {
  const color = ICON_COLOR[level] || 'green'
  return {
    16: `/icons/icon-${color}-16.png`,
    32: `/icons/icon-${color}-32.png`,
    48: `/icons/icon-${color}-48.png`
  }
}

// 紅燈但全部已知悉時 badge 顯示的提示字：仍有問題、但沒有新的
export const KNOWN_RED_BADGE = '!'

// 取得儲存空間中的所有健康紀錄
export async function getHealth() {
  return getHealthMap()
}

// 寫入單一任務的健康狀態紀錄並補上時間戳
async function setTaskHealthInternal(taskId, { status, reason, detail } = {}, executionFingerprint) {
  let record
  const mutate = (health) => {
    const prev = health[taskId]

    // status 與上一次不同時重設為未讀（false），相同時保留既有 read 標記
    const statusChanged = !prev || prev.status !== status
    const read = statusChanged ? false : (prev.read === true)

    const resolvedReason = (reason !== undefined && reason !== '')
      ? reason
      : (statusTextOf(status) || '')

    record = {
      status,
      reason: resolvedReason,
      detail,
      at: Date.now(),
      read,
      ...(executionFingerprint ? { executionFingerprint } : {})
    }

    return {
      ...health,
      [taskId]: record
    }
  }
  const written = executionFingerprint
    ? await updateHealthMapForExecution(taskId, executionFingerprint, mutate)
    : (await updateHealthMap(mutate), true)
  if (!written) return null
  return record
}

export async function setTaskHealth(taskId, healthObj = {}) {
  return setTaskHealthInternal(taskId, healthObj)
}

export async function setTaskHealthForExecution(taskId, healthObj, executionFingerprint) {
  return setTaskHealthInternal(taskId, healthObj, executionFingerprint)
}

// 將指定任務的健康紀錄標示為已讀
export async function markRead(taskId) {
  await updateHealthMap((health) => {
    const prev = health[taskId] || {}
    return {
      ...health,
      [taskId]: {
        ...prev,
        read: true
      }
    }
  })
}

// 將狀態物件反映至瀏覽器擴充功能圖示 badge 與標題
export async function applyBadge(state) {
  const level = state?.level
  let text = ''
  let color = '#188038'

  switch (level) {
    case 'red':
      text = (state?.redCount ?? 0) > 0 ? String(state.redCount) : KNOWN_RED_BADGE
      color = '#D93025'
      break
    case 'yellow':
      text = String(state?.yellowCount ?? 0)
      color = '#F9AB00'
      break
    case 'off':
      text = 'II'
      color = '#5F6368'
      break
    case 'green':
    default:
      text = ''
      color = '#188038'
      break
  }

  // 換圖示失敗只是少了顏色，不得讓燈號其餘部分（以及呼叫它的抓取流程）跟著失敗
  try {
    await chrome.action.setIcon({ path: iconPathOf(level || 'green') })
  } catch {}
  await chrome.action.setBadgeText({ text })
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setTitle({ title: 'AutoFetcher — ' + (state?.summary || '') })
}

// 重新整理健康狀態並更新圖示燈號
export async function refreshBadge() {
  const tasks = await getTasks()
  const health = await getHealth()
  const missed = await getMissedList()

  const state = computeHealth(tasks, health, missed)
  await applyBadge(state)
  return state
}
