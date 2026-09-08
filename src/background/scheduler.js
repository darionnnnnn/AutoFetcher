// AutoFetcher 排程核心：alarms 建立與重建
import { getTasks } from '../shared/storage.js'
// 排程數學一律從 shared 來（Picker 的觸發預覽也用同一份）；
// 這裡只 re-export，本檔不得再寫一份實作。
import {
  slotOf,
  nextDailyRun,
  shouldRunInterval,
  nextIntervalRun
} from '../shared/schedule-math.js'

export { slotOf, nextDailyRun, shouldRunInterval, nextIntervalRun }

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
