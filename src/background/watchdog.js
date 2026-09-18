// AutoFetcher 看門狗：定期自我檢查與修復（SPEC §4.1）
import {
  ensureWatchdog,
  rebuildAlarms,
  alarmName,
  parseAlarmName,
  nextDailyRun,
  nextIntervalRun
} from './scheduler.js'
import { getTasks, trimOldRecords, trimOldRuns, pruneOrphanEntries, runOncePerDay, getLastTimezone, setLastTimezone, getInflight, updateInflight } from '../shared/storage.js'
import { ensureSiteCheck } from './sitecheck.js'
import { cleanOrphanFetchTabs } from './fetch-tab.js'
import * as diag from '../shared/diag.js'


// 確保看門狗 alarm 存在
async function checkWatchdogAlarm() {
  await ensureWatchdog()
}

// 檢查時區變更，必要時重建所有 alarms
async function checkTimezone() {
  const lastTimezone = await getLastTimezone()
  const currentTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (lastTimezone !== currentTimezone) {
    await rebuildAlarms()
    await setLastTimezone(currentTimezone)
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
  const inflight = await getInflight()
  if (!inflight || typeof inflight !== 'object' || Array.isArray(inflight)) {
    return
  }

  const now = Date.now()
  const stale = []

  for (const [key, val] of Object.entries(inflight)) {
    // fetcher 寫進去的是 ISO 字串，早期這裡比對 typeof === 'number'，所以清理從未觸發過
    const startedAt = typeof val?.startedAt === 'string' ? Date.parse(val.startedAt) : val?.startedAt
    if (Number.isFinite(startedAt) && now - startedAt > 3 * 60 * 1000) {
      stale.push(key)
    }
  }

  if (stale.length > 0) {
    // 鎖內對最新的 inflight 刪除，不會蓋掉這段期間新開始的抓取；診斷在鎖外寫（鎖不巢狀）
    await updateInflight((cur) => {
      const next = { ...cur }
      for (const key of stale) delete next[key]
      return next
    })
    for (const key of stale) await diag.log('interrupted', key)
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

  // 帳本保留 14 天：與紀錄保留天數設定無關，自帶一天一次的日戳
  try {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    await trimOldRuns(today)
  } catch {}

  // 孤兒鍵清理（alertLog／lastValues／health）：一天一次，自帶日戳，不放在抓取路徑
  try {
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    await runOncePerDay('lastOrphanPruneDate', today, pruneOrphanEntries)
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

  // 上一個 service worker 被回收時沒關掉的抓取視窗（判定只看登記表，見 fetch-tab.js）
  try {
    await cleanOrphanFetchTabs()
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
