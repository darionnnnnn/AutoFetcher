// AutoFetcher 抓取前預檢（SPEC §4.2）
import { runTask } from './fetcher.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { nextDailyRun } from './scheduler.js'
import { getTasks } from '../shared/storage.js'
import { log as diagLog } from '../shared/diag.js'
import { notify } from './notify.js'

// 計算任務下一次抓取時間字串（HH:mm）
function getNextCaptureTime(task) {
  try {
    const schedule = task?.schedule
    if (schedule?.type === 'daily' && Array.isArray(schedule.times) && schedule.times.length > 0) {
      const weekdays = schedule.weekdays ?? task?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
      const nextMs = nextDailyRun(Date.now(), schedule.times, weekdays)
      if (nextMs !== null) {
        const d = new Date(nextMs)
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}`
      }
    }
  } catch {}
  return ''
}

// 解析預檢 alarm 名稱（格式：<taskId>:pre:<index>）
export function parsePrecheckName(name) {
  if (typeof name !== 'string') return null
  const lastColon = name.lastIndexOf(':')
  if (lastColon === -1) return null

  const indexStr = name.slice(lastColon + 1)
  if (!/^\d+$/.test(indexStr)) return null

  const beforeLast = name.slice(0, lastColon)
  const secondLastColon = beforeLast.lastIndexOf(':')
  if (secondLastColon === -1) return null

  const tag = beforeLast.slice(secondLastColon + 1)
  if (tag !== 'pre') return null

  const taskId = beforeLast.slice(0, secondLastColon)
  if (!taskId) return null

  return { taskId, index: Number(indexStr) }
}

// 判定是否為預檢 alarm
export function isPrecheckAlarm(name) {
  return parsePrecheckName(name) !== null
}

// 排定所有啟用中每日任務的預檢 alarm
export async function schedulePrechecks(nowMs = Date.now()) {
  const existing = await chrome.alarms.getAll()
  for (const alarm of existing) {
    if (parsePrecheckName(alarm.name) !== null) {
      await chrome.alarms.clear(alarm.name)
    }
  }

  const tasks = await getTasks()
  const now = nowMs

  for (const task of tasks) {
    if (!task || task.enabled === false) continue
    const schedule = task.schedule
    if (!schedule || schedule.type !== 'daily') continue
    const times = schedule.times
    if (!Array.isArray(times) || times.length === 0) continue
    const weekdays = schedule.weekdays ?? task.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
    if (!Array.isArray(weekdays) || weekdays.length === 0) continue

    const lead = task.precheckLeadMinutes === undefined ? 30 : task.precheckLeadMinutes
    if (typeof lead !== 'number' || lead <= 0) continue

    for (let i = 0; i < times.length; i++) {
      let nextRun = nextDailyRun(now, [times[i]], weekdays)
      if (nextRun === null) continue
      let when = nextRun - lead * 60000
      // 現在剛好落在「預檢時間」與「抓取時間」之間時，when 會是過去的時間點：
      // Chrome 會立刻觸發、alarm 隨即消失，使用者看到一次沒頭沒尾的預檢警報。
      // 這種情況跳過這一輪，排到下一次的那一槽。
      if (when <= now) {
        nextRun = nextDailyRun(nextRun + 60000, [times[i]], weekdays)
        if (nextRun === null) continue
        when = nextRun - lead * 60000
      }
      await chrome.alarms.create(`${task.id}:pre:${i}`, { when })
    }
  }
}

// 執行任務預檢演練並更新健康狀態
export async function runPrecheck(task, opts = {}) {
  try {
    const res = await runTask(task, { ...opts, slot: 'precheck', dryRun: true })

    let status = 'ok'
    let reason = ''
    let detail = ''

    if (res?.ok === true && res.fields && typeof res.fields === 'object') {
      const fieldEntries = Object.entries(res.fields)
      const hasOk = fieldEntries.some(([_, r]) => r?.ok === true)
      if (hasOk) {
        status = 'ok'
      } else {
        const failedEntries = fieldEntries.filter(([_, r]) => !r?.ok)
        const firstFail = failedEntries[0]?.[1]
        const firstError = firstFail?.error
        if (firstError === 'not_found') {
          status = 'selector_lost'
          reason = '找不到元素'
        } else if (firstError === 'parse_error') {
          status = 'parse_error'
          reason = '抓不到數值'
        } else {
          status = 'failed'
          reason = '抓取失敗'
        }
        // 使用者看得懂的是值的名稱，不是內部代號
        const nameOfKey = (k) => (task?.fields || []).find(f => f?.key === k)?.name || k
        detail = failedEntries.map(([k]) => nameOfKey(k)).join('、')
      }
    } else {
      if (res?.ok === true) {
        status = 'ok'
      } else if (res?.error === 'login_failed') {
        status = 'login_failed'
        reason = '無法登入'
      } else if (res?.error === 'not_found') {
        status = 'selector_lost'
        reason = '找不到元素'
      } else if (res?.error === 'parse_error') {
        status = 'parse_error'
        reason = '抓不到數值'
      } else {
        status = 'failed'
        reason = '抓取失敗'
      }
      detail = res?.snippet || res?.raw || res?.error || ''
    }

    if (status === 'ok') {
      await setTaskHealth(task.id, { status: 'ok' })
    } else {
      await setTaskHealth(task.id, { status, reason, detail })

      const taskName = task?.name || task?.id || '未命名任務'
      const nextTime = getNextCaptureTime(task)
      const timeText = nextTime ? `接下來的抓取時間為 ${nextTime}` : '接下來的抓取時間即將到來'
      const title = `AutoFetcher 預檢失敗：${taskName}（${reason}）`
      const message = `任務「${taskName}」預檢失敗：${reason}。${timeText}，請盡速確認。`

      await notify(`${task.id}:precheck`, {
        title,
        message
      })
    }

    await refreshBadge()
    await diagLog('precheck', {
      taskId: task?.id,
      status,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {})
    })
    return res
  } catch (err) {
    // 預檢絕對不可以往外丟例外
    try {
      await setTaskHealth(task?.id, { status: 'failed', reason: '抓取失敗', detail: String(err?.message || err) })
      await refreshBadge()
      await diagLog('precheck', { taskId: task?.id, status: 'failed', reason: '抓取失敗', error: String(err?.message || err) })
    } catch {}
  }
}
