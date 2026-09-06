// AutoFetcher 看門狗：定期自我檢查與修復（SPEC §4.1）
import {
  ensureWatchdog,
  rebuildAlarms,
  alarmName,
  parseAlarmName,
  nextDailyRun,
  nextIntervalRun
} from './scheduler.js'
import { getTasks, trimOldRecords } from '../shared/storage.js'
import { ensureSiteCheck } from './sitecheck.js'
import * as diag from '../shared/diag.js'


// 確保看門狗 alarm 存在
async function checkWatchdogAlarm() {
  await ensureWatchdog()
}

// 檢查時區變更，必要時重建所有 alarms
async function checkTimezone() {
  const { lastTimezone } = await chrome.storage.local.get('lastTimezone')
  const currentTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (lastTimezone !== currentTimezone) {
    await rebuildAlarms()
    await chrome.storage.local.set({ lastTimezone: currentTimezone })
  }
}

// 補建缺失的任務 alarms
async function repairMissingAlarms() {
  const existingAlarms = await chrome.alarms.getAll()
  const existingNames = new Set(existingAlarms.map((a) => a.name))
  const tasks = await getTasks()

  for (const task of tasks) {
    if (!task || task.enabled === false || !task.schedule) continue

    const { schedule } = task
    if (schedule.type === 'daily') {
      const weekdays = schedule.weekdays ?? task.weekdays
      if (!Array.isArray(schedule.times) || schedule.times.length === 0) continue
      if (!Array.isArray(weekdays) || weekdays.length === 0) continue

      for (let i = 0; i < schedule.times.length; i++) {
        const name = alarmName(task.id, i)
        if (!existingNames.has(name)) {
          const when = nextDailyRun(Date.now(), [schedule.times[i]], weekdays)
          if (when !== null) {
            await chrome.alarms.create(name, { when })
            existingNames.add(name)
          }
        }
      }
    } else if (schedule.type === 'interval') {
      const name = alarmName(task.id, 0)
      if (!existingNames.has(name)) {
        const when = nextIntervalRun(task, Date.now())
        if (when !== null) {
          await chrome.alarms.create(name, { when })
          existingNames.add(name)
        }
      }
    }
  }
}

// 清理已刪除或已停用任務殘留的 alarms
async function cleanStaleAlarms() {
  const alarms = await chrome.alarms.getAll()
  const tasks = await getTasks()
  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  for (const alarm of alarms) {
    const parsed = parseAlarmName(alarm.name)
    if (parsed !== null) {
      const task = taskMap.get(parsed.taskId)
      if (!task || task.enabled === false) {
        await chrome.alarms.clear(alarm.name)
      }
    }
  }
}

// 清理執行超過 3 分鐘卡住的 inflight 狀態
async function cleanStuckInflight() {
  const res = await chrome.storage.session.get('inflight')
  const inflight = res?.inflight
  if (!inflight || typeof inflight !== 'object' || Array.isArray(inflight)) {
    return
  }

  const now = Date.now()
  const remaining = {}
  let changed = false

  for (const [key, val] of Object.entries(inflight)) {
    // fetcher 寫進去的是 ISO 字串，早期這裡比對 typeof === 'number'，所以清理從未觸發過
    const startedAt = typeof val?.startedAt === 'string' ? Date.parse(val.startedAt) : val?.startedAt
    if (Number.isFinite(startedAt) && now - startedAt > 3 * 60 * 1000) {
      changed = true
      await diag.log('interrupted', key)
    } else {
      remaining[key] = val
    }
  }

  if (changed) {
    await chrome.storage.session.set({ inflight: remaining })
  }
}

// 執行看門狗檢查巡迴
export async function runWatchdog() {
  try {
    await checkWatchdogAlarm()
  } catch {}

  try {
    await ensureSiteCheck()
  } catch {}

  // 保留天數的清理：會掃整個 storage，所以放在這裡且 trimOldRecords 自己保證一天只做一次
  try {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    await trimOldRecords(today)
  } catch {}

  try {
    await checkTimezone()
  } catch {}

  try {
    await repairMissingAlarms()
  } catch {}

  try {
    await cleanStaleAlarms()
  } catch {}

  try {
    await cleanStuckInflight()
  } catch {}

  try {
    await diag.log('watchdog', '看門狗巡檢完成')
  } catch {}
}

// 建立自檢 alarm 並記錄診斷
export async function selfCheck() {
  const scheduledAt = Date.now() + 60000
  await chrome.alarms.create('__selftest', { when: scheduledAt })
  await diag.log('selftest', `建立自檢 alarm: ${scheduledAt}`)
  return { scheduledAt }
}
