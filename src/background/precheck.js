// AutoFetcher 抓取前預檢（SPEC §4.2）
import { runTask } from './fetcher.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { nextDailyRun } from './scheduler.js'
import { getTasks, getSites } from '../shared/storage.js'
import { log as diagLog } from '../shared/diag.js'

// 解析 URL 取得 origin
function getOrigin(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

// 判定網址是否停留在登入頁
async function isAtLoginPage(url) {
  if (typeof url !== 'string' || !url) return false
  const origin = getOrigin(url)
  if (!origin) return false
  const sites = await getSites()
  const site = sites[origin]
  if (site && typeof site.loginPageUrlPrefix === 'string' && site.loginPageUrlPrefix.trim() !== '') {
    return url.startsWith(site.loginPageUrlPrefix)
  }
  return false
}

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
export async function schedulePrechecks() {
  const existing = await chrome.alarms.getAll()
  for (const alarm of existing) {
    if (parsePrecheckName(alarm.name) !== null) {
      await chrome.alarms.clear(alarm.name)
    }
  }

  const tasks = await getTasks()
  const now = Date.now()

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
      const nextRun = nextDailyRun(now, [times[i]], weekdays)
      if (nextRun === null) continue
      const when = nextRun - lead * 60000
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

    if (res?.ok === true) {
      status = 'ok'
    } else {
      const atLogin = await isAtLoginPage(task?.url)
      if (atLogin) {
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

      await chrome.notifications.create(`${task.id}:precheck`, {
        type: 'basic',
        iconUrl: 'assets/icon-128.png',
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
