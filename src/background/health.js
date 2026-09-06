// AutoFetcher 健康狀態彙總與工具列燈號 (SPEC §12.1)
import { getTasks } from '../shared/storage.js'
import { RED_STATUSES, WARN_STATUSES } from '../shared/record-status.js'

// 狀態代碼對應繁體中文詞對照表
const STATUS_TEXT = {
  login_failed: '無法登入',
  selector_lost: '找不到元素',
  parse_error: '抓不到數值',
  failed: '抓取失敗',
  fallback: '用備援方式抓到',
  late: '遲到',
  partial: '只抓到部分'
}

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
      yellowCount: 0,
      summary: '已暫停'
    }
  }

  const unreadRedTasks = []
  const unreadYellowTasks = []

  for (const task of activeTasks) {
    const record = health[task.id]
    // 沒有健康紀錄的新任務視為正常，不列為異常
    if (!record || !record.status) continue

    const isUnread = record.read !== true

    if (RED_STATUSES.includes(record.status)) {
      if (isUnread) {
        unreadRedTasks.push({ task, record })
      }
    } else if (WARN_STATUSES.includes(record.status)) {
      if (isUnread) {
        unreadYellowTasks.push({ task, record })
      }
    }
  }

  // 站台層級的健康項目（key 為 site:<origin>，來自每日站台登入檢查）。
  // 站台登不進去等於所有靠它的任務都會失敗，只跳一次通知不夠，要一起進燈號。
  for (const [key, record] of Object.entries(health)) {
    if (!key.startsWith(SITE_PREFIX)) continue
    if (!record || !record.status || record.read === true) continue
    const site = { name: key.slice(SITE_PREFIX.length) }
    if (RED_STATUSES.includes(record.status)) {
      unreadRedTasks.push({ task: site, record })
    } else if (WARN_STATUSES.includes(record.status)) {
      unreadYellowTasks.push({ task: site, record })
    }
  }

  const redCount = unreadRedTasks.length
  const yellowCount = unreadYellowTasks.length + (hasMissed ? 1 : 0)

  let level = 'green'
  let summary = '一切正常'

  // 先以未讀項目決定等級；若全部紅/黃項目皆已讀且無錯過排程，等級回到綠燈
  if (redCount > 0) {
    level = 'red'
    const items = unreadRedTasks.map(
      ({ task, record }) => `${task.name || task.id} ${STATUS_TEXT[record.status] || record.reason || '抓取失敗'}`
    )
    const desc = items.slice(0, 2).join('、') + (items.length > 2 ? '等' : '')
    summary = `${redCount} 個任務異常:${desc}`
  } else if (yellowCount > 0) {
    level = 'yellow'
    const items = unreadYellowTasks.map(
      ({ task, record }) => `${task.name || task.id} ${STATUS_TEXT[record.status] || record.reason || '注意'}`
    )
    if (hasMissed) {
      items.push('錯過排程')
    }
    const desc = items.slice(0, 2).join('、') + (items.length > 2 ? '等' : '')
    summary = `${yellowCount} 個任務注意:${desc}`
  }

  return { level, redCount, yellowCount, summary }
}

// 取得儲存空間中的所有健康紀錄
export async function getHealth() {
  const res = await chrome.storage.local.get('health')
  return res && res.health && typeof res.health === 'object' ? res.health : {}
}

// 寫入單一任務的健康狀態紀錄並補上時間戳
export async function setTaskHealth(taskId, { status, reason, detail } = {}) {
  const health = await getHealth()
  const prev = health[taskId]

  // status 與上一次不同時重設為未讀（false），相同時保留既有 read 標記
  const statusChanged = !prev || prev.status !== status
  const read = statusChanged ? false : (prev.read === true)

  const resolvedReason = (reason !== undefined && reason !== '')
    ? reason
    : (STATUS_TEXT[status] || '')

  const record = {
    status,
    reason: resolvedReason,
    detail,
    at: Date.now(),
    read
  }

  const updated = {
    ...health,
    [taskId]: record
  }

  await chrome.storage.local.set({ health: updated })
  return record
}

// 將指定任務的健康紀錄標示為已讀
export async function markRead(taskId) {
  const health = await getHealth()
  const prev = health[taskId] || {}
  const updated = {
    ...health,
    [taskId]: {
      ...prev,
      read: true
    }
  }
  await chrome.storage.local.set({ health: updated })
}

// 將狀態物件反映至瀏覽器擴充功能圖示 badge 與標題
export async function applyBadge(state) {
  const level = state?.level
  let text = ''
  let color = '#188038'

  switch (level) {
    case 'red':
      text = String(state?.redCount ?? 0)
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

  await chrome.action.setBadgeText({ text })
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setTitle({ title: 'AutoFetcher — ' + (state?.summary || '') })
}

// 重新整理健康狀態並更新圖示燈號
export async function refreshBadge() {
  const tasks = await getTasks()
  const health = await getHealth()
  const res = await chrome.storage.local.get('missed')
  const missed = Array.isArray(res?.missed) ? res.missed : []

  const state = computeHealth(tasks, health, missed)
  await applyBadge(state)
  return state
}
