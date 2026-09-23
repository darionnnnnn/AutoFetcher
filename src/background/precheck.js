// AutoFetcher 抓取前預檢（SPEC §4.2）
import { runTask } from './fetcher.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { nextDailyRun } from './scheduler.js'
import { getTasks } from '../shared/storage.js'
import { log as diagLog } from '../shared/diag.js'
import { notifyFailure, clearNotifyLog } from './notify.js'

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

/**
 * 一個任務應有的預檢 alarm（名稱與觸發時刻）：排程與看門狗補建共用這一份計算
 * @param {object} task 任務
 * @param {number} nowMs 現在（毫秒）
 * @returns {{ name: string, when: number }[]}
 */
export function precheckAlarmsFor(task, nowMs = Date.now()) {
  const out = []
  if (!task || task.enabled === false) return out
  const schedule = task.schedule
  if (!schedule || schedule.type !== 'daily') return out
  const times = schedule.times
  if (!Array.isArray(times) || times.length === 0) return out
  const weekdays = schedule.weekdays ?? task.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
  if (!Array.isArray(weekdays) || weekdays.length === 0) return out

  const lead = task.precheckLeadMinutes === undefined ? 30 : task.precheckLeadMinutes
  if (typeof lead !== 'number' || lead <= 0) return out

  for (let i = 0; i < times.length; i++) {
    let nextRun = nextDailyRun(nowMs, [times[i]], weekdays)
    if (nextRun === null) continue
    let when = nextRun - lead * 60000
    // 現在剛好落在「預檢時間」與「抓取時間」之間時，when 會是過去的時間點：
    // Chrome 會立刻觸發、alarm 隨即消失，使用者看到一次沒頭沒尾的預檢警報。
    // 這種情況跳過這一輪，排到下一次的那一槽。
    if (when <= nowMs) {
      nextRun = nextDailyRun(nextRun + 60000, [times[i]], weekdays)
      if (nextRun === null) continue
      when = nextRun - lead * 60000
    }
    out.push({ name: `${task.id}:pre:${i}`, when })
  }
  return out
}

/**
 * 排定預檢 alarm。
 * 不帶 taskId：清光全部預檢 alarm 再依所有任務重建（只給 REBUILD_ALARMS、安裝、啟動用）。
 * 帶 taskId：只清、只建那個任務的預檢 alarm（預檢 alarm 觸發後用；不動其他任務）。
 */
export async function schedulePrechecks(nowMs = Date.now(), opts = {}) {
  const onlyId = typeof opts?.taskId === 'string' ? opts.taskId : null
  const existing = await chrome.alarms.getAll()
  for (const alarm of existing) {
    const parsed = parsePrecheckName(alarm.name)
    if (parsed === null) continue
    if (onlyId !== null && parsed.taskId !== onlyId) continue
    await chrome.alarms.clear(alarm.name)
  }

  const tasks = await getTasks()
  for (const task of tasks) {
    if (!task) continue
    if (onlyId !== null && task.id !== onlyId) continue
    for (const { name, when } of precheckAlarmsFor(task, nowMs)) {
      await chrome.alarms.create(name, { when })
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

    if (res?.fields && typeof res.fields === 'object') {
      const fieldEntries = Object.entries(res.fields)
      const declared = Array.isArray(task?.fields) ? task.fields : []
      const declaredKeys = new Set(declared.map(field => field?.key).filter(Boolean))
      const hasAllDeclared = declared.length > 0 && declared.every(field =>
        field?.key && Object.prototype.hasOwnProperty.call(res.fields, field.key))
      const successful = fieldEntries.filter(([_, r]) => r?.ok === true)
      const failedEntries = fieldEntries.filter(([key, r]) => r?.ok !== true || (declared.length > 0 && !declaredKeys.has(key)))
      if (res.ok === true && hasAllDeclared && fieldEntries.length === declared.length && failedEntries.length === 0) {
        status = 'ok'
      } else {
        const missing = declared.filter(field => !Object.prototype.hasOwnProperty.call(res.fields, field?.key))
        const failures = [...failedEntries, ...missing.map(field => [field.key, { ok: false, error: 'error' }])]
        if (successful.length > 0 && failures.length === 0) failures.push(['結果', { ok: false, error: 'error' }])
        const firstFail = failures[0]?.[1]
        const firstError = firstFail?.error
        if (successful.length > 0) {
          status = 'partial'
          reason = '部分失敗'
        } else if (firstError === 'not_found') {
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
        detail = failures.map(([k]) => nameOfKey(k)).join('、')
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
      } else if (res?.error === 'frame_not_found') {
        // 與「找不到元素」分開講：使用者要處理的是 iframe 不見了或換了網址
        status = 'selector_lost'
        reason = '找不到目標所在的框架'
      } else {
        status = 'failed'
        reason = '抓取失敗'
      }
      detail = res?.snippet || res?.raw || res?.error || ''
    }

    if (status === 'ok') {
      await setTaskHealth(task.id, { status: 'ok' })
      // 恢復正常：下次預檢再壞會重新通知
      await clearNotifyLog(`${task.id}:precheck`)
    } else {
      await setTaskHealth(task.id, { status, reason, detail })

      const taskName = task?.name || task?.id || '未命名任務'
      const nextTime = getNextCaptureTime(task)
      const timeText = nextTime ? `接下來的抓取時間為 ${nextTime}` : '接下來的抓取時間即將到來'
      const title = `AutoFetcher 預檢失敗：${taskName}（${reason}）`
      const message = `任務「${taskName}」預檢失敗：${reason}。${timeText}，請盡速確認。`

      // 同一任務同一狀態 24 小時內只通知一次（燈號照寫，不受冷卻影響）
      await notifyFailure(`${task.id}:precheck`, status, {
        title,
        message,
        task
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
