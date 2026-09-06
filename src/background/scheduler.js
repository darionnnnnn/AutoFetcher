// AutoFetcher 排程核心：alarms 建立與重建
import { getTasks } from '../shared/storage.js'

// 數值補零至兩位數
function pad2(n) {
  return String(n).padStart(2, '0')
}

// 將 'HH:mm' 或 Date 轉為當日分鐘數
function timeToMinutes(time) {
  if (typeof time === 'string') {
    const [h, m] = time.split(':').map(Number)
    return h * 60 + m
  }
  return time.getHours() * 60 + time.getMinutes()
}

// 本地時間排程槽字串（YYYY-MM-DDTHH:mm）
export function slotOf(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const h = pad2(d.getHours())
  const min = pad2(d.getMinutes())
  return `${y}-${m}-${day}T${h}:${min}`
}

// 計算下一次每日排程觸發的時間戳（毫秒）
export function nextDailyRun(nowMs, times, weekdays) {
  if (!Array.isArray(times) || times.length === 0) return null
  if (!Array.isArray(weekdays) || weekdays.length === 0) return null

  const validTimes = times.filter((t) => typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t))
  if (validTimes.length === 0) return null

  const sortedTimes = [...validTimes].sort((a, b) => timeToMinutes(a) - timeToMinutes(b))
  const base = new Date(nowMs)

  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    if (!weekdays.includes(day.getDay())) continue

    for (const t of sortedTimes) {
      const mins = timeToMinutes(t)
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Math.floor(mins / 60),
        mins % 60,
        0,
        0
      ).getTime()
      if (candidate > nowMs) {
        return candidate
      }
    }
  }
  return null
}

// 判定當前時間是否符合間隔排程的執行條件
export function shouldRunInterval(task, nowMs) {
  const schedule = task?.schedule || {}
  const weekdays = schedule.weekdays ?? task?.weekdays
  const now = new Date(nowMs)
  if (Array.isArray(weekdays) && weekdays.length > 0 && !weekdays.includes(now.getDay())) {
    return false
  }
  const window = schedule.window
  if (!window || !window.from || !window.to) {
    return true
  }
  const from = timeToMinutes(window.from)
  const to = timeToMinutes(window.to)
  const current = timeToMinutes(now)
  if (from <= to) {
    return current >= from && current <= to
  }
  return current >= from || current <= to
}

// 產生任務 alarm 名稱
export function alarmName(taskId, index) {
  return `task:${taskId}:${index}`
}

// 解析任務 alarm 名稱
export function parseAlarmName(name) {
  if (typeof name !== 'string' || !name.startsWith('task:')) {
    return null
  }
  const rest = name.slice(5)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon === -1) {
    return null
  }
  const taskId = rest.slice(0, lastColon)
  const indexStr = rest.slice(lastColon + 1)
  if (!taskId || !/^\d+$/.test(indexStr)) {
    return null
  }
  return { taskId, index: Number(indexStr) }
}

// 重建所有任務的 alarms
export async function rebuildAlarms() {
  const existing = await chrome.alarms.getAll()
  for (const alarm of existing) {
    if (parseAlarmName(alarm.name) !== null) {
      await chrome.alarms.clear(alarm.name)
    }
  }

  const tasks = await getTasks()
  for (const task of tasks) {
    try {
      if (!task || task.enabled === false || !task.schedule) continue

      const { schedule } = task
      if (schedule.type === 'daily') {
        const weekdays = schedule.weekdays ?? task.weekdays
        if (!Array.isArray(schedule.times) || schedule.times.length === 0) continue
        if (!Array.isArray(weekdays) || weekdays.length === 0) continue

        for (let i = 0; i < schedule.times.length; i++) {
          const when = nextDailyRun(Date.now(), [schedule.times[i]], weekdays)
          if (when !== null) {
            await chrome.alarms.create(alarmName(task.id, i), { when })
          }
        }
      } else if (schedule.type === 'interval') {
        const when = nextIntervalRun(task, Date.now())
        if (when !== null) {
          await chrome.alarms.create(alarmName(task.id, 0), { when })
        }
      }
    } catch {
      continue
    }
  }
}

// 確保看門狗 alarm 存在
export async function ensureWatchdog() {
  const existing = await chrome.alarms.get('__watchdog')
  if (!existing) {
    await chrome.alarms.create('__watchdog', { periodInMinutes: 15 })
  }
}

/**
 * 計算下一個對齊的排程時刻
 * @param {Object} task 任務物件
 * @param {number} nowMs 當前毫秒時間戳
 * @returns {number|null} 下一個對齊的毫秒時間戳，或 null
 */
export function nextIntervalRun(task, nowMs) {
  const schedule = task?.schedule
  const everyMinutes = schedule?.everyMinutes
  if (typeof everyMinutes !== 'number' || !Number.isFinite(everyMinutes) || everyMinutes <= 0) {
    return null
  }

  // weekdays 缺省或空陣列一律視為每天(與 daily 的必填不同,見 AF-4 A1 定案)
  const weekdays = schedule?.weekdays ?? task?.weekdays
  const everyDay = !Array.isArray(weekdays) || weekdays.length === 0

  const window = schedule?.window
  const hasWindow = !!(window && window.from && window.to)
  const fromMins = hasWindow ? timeToMinutes(window.from) : 0
  const toMins = hasWindow ? timeToMinutes(window.to) : 0

  // 當天的候選分鐘數,一律遞增
  const minutesOfDay = []
  if (!hasWindow) {
    for (let m = 0; m < 1440; m += everyMinutes) minutesOfDay.push(m)
  } else if (fromMins <= toMins) {
    // 同一天內,終點閉區間
    for (let m = fromMins; m <= toMins; m += everyMinutes) minutesOfDay.push(m)
  } else {
    // 跨午夜:凌晨段從 00:00 起,傍晚段從 from 起
    for (let m = 0; m <= toMins; m += everyMinutes) minutesOfDay.push(m)
    for (let m = fromMins; m < 1440; m += everyMinutes) minutesOfDay.push(m)
  }
  if (minutesOfDay.length === 0) return null

  const base = new Date(nowMs)
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    // 星期以候選時刻自己所在的那一天判定(跨午夜的凌晨段也算它自己那天)
    if (!everyDay && !weekdays.includes(day.getDay())) continue

    for (const m of minutesOfDay) {
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Math.floor(m / 60),
        m % 60,
        0,
        0
      ).getTime()
      // 嚴格大於 now:等於 now 的格子要跳過
      if (candidate > nowMs) return candidate
    }
  }
  return null
}
