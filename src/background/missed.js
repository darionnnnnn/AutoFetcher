// 錯過清單：比對與補抓離線期間應執行但未執行的排程槽
import { getTasks } from '../shared/storage.js'
import { slotOf } from './scheduler.js'
import { notify } from './notify.js'

// 七天的毫秒數常數
const SEVEN_DAYS_MS = 7 * 86400000

// 讀取錯過清單
async function readMissed() {
  const res = await chrome.storage.local.get('missed')
  return Array.isArray(res.missed) ? res.missed : []
}

// 寫入錯過清單
async function writeMissed(list) {
  await chrome.storage.local.set({ missed: list })
}

// 計算指定時間範圍內錯過的排程槽（純函式，不操作 chrome API）
export function computeMissedSlots(tasks, ledger, fromMs, toMs) {
  if (!Array.isArray(tasks) || typeof fromMs !== 'number' || typeof toMs !== 'number' || fromMs >= toMs) {
    return []
  }

  const missed = []
  const startDate = new Date(fromMs)
  const endDate = new Date(toMs)
  const endDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).getTime()

  for (const task of tasks) {
    if (!task || task.enabled === false) continue
    if (task.schedule?.type !== 'daily') continue

    const weekdays = task.schedule.weekdays ?? task.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
    if (!Array.isArray(weekdays) || weekdays.length === 0) continue

    const times = task.schedule.times
    if (!Array.isArray(times) || times.length === 0) continue

    const seenSlots = new Set()
    let cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())

    while (cur.getTime() <= endDay) {
      if (weekdays.includes(cur.getDay())) {
        for (const t of times) {
          if (typeof t !== 'string' || !/^\d{1,2}:\d{2}$/.test(t)) continue
          const [h, m] = t.split(':').map(Number)
          const slotDate = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), h, m, 0, 0)
          const slotMs = slotDate.getTime()

          if (slotMs > fromMs && slotMs <= toMs) {
            const slot = slotOf(slotMs)
            if (!seenSlots.has(slot)) {
              seenSlots.add(slot)
              if (ledger?.[task.id]?.[slot] === undefined) {
                missed.push({
                  taskId: task.id,
                  taskName: task.name || task.id,
                  slot
                })
              }
            }
          }
        }
      }
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1)
    }
  }

  return missed.sort((a, b) => a.slot.localeCompare(b.slot) || a.taskId.localeCompare(b.taskId))
}

// 重新整理錯過清單並於有新增項目時發送通知
export async function refreshMissed(nowMs = Date.now(), sinceMs) {
  let effectiveSince = sinceMs
  if (typeof effectiveSince !== 'number') {
    const res = await chrome.storage.local.get('lastSeenAt')
    effectiveSince = typeof res.lastSeenAt === 'number' ? res.lastSeenAt : nowMs - SEVEN_DAYS_MS
  }

  const fromMs = Math.max(effectiveSince, nowMs - SEVEN_DAYS_MS)
  const tasks = await getTasks()
  const runsRes = await chrome.storage.local.get('runs')
  const ledger = runsRes.runs || {}

  const computed = computeMissedSlots(tasks, ledger, fromMs, nowMs)
  const existing = await readMissed()

  const existingKeys = new Set(existing.map((x) => `${x.taskId}:${x.slot}`))
  let newCount = 0
  const merged = [...existing]

  for (const item of computed) {
    const key = `${item.taskId}:${item.slot}`
    if (!existingKeys.has(key)) {
      existingKeys.add(key)
      merged.push(item)
      newCount++
    }
  }

  merged.sort((a, b) => a.slot.localeCompare(b.slot) || a.taskId.localeCompare(b.taskId))
  await writeMissed(merged)

  if (merged.length > 0 && newCount > 0) {
    await notify('missed-tasks', {
      title: '錯過排程通知',
      message: `有 ${merged.length} 個排程槽未執行`,
      buttons: [{ title: '全部補抓' }, { title: '全部略過' }]
    })
  }

  await chrome.storage.local.set({ lastSeenAt: nowMs })
}

// 取得當前錯過清單
export async function getMissed() {
  return await readMissed()
}

// 補抓清單中的所有項目
export async function catchUpAll(runTaskFn) {
  const list = await readMissed()
  const tasks = await getTasks()
  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  for (const item of list) {
    const task = taskMap.get(item.taskId)
    if (!task) continue
    try {
      await runTaskFn(task, { slot: item.slot, reason: 'late' })
    } catch {
      // 個別項目執行失敗時接住例外，繼續執行後續項目
    }
  }

  await writeMissed([])
}

// 補抓單一項目：從清單找出符合的項目執行並移除
export async function catchUpOne(taskId, slot, runTaskFn) {
  const list = await readMissed()
  const item = list.find((m) => m.taskId === taskId && m.slot === slot)
  if (!item) return

  const tasks = await getTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (task) {
    try {
      await runTaskFn(task, { slot: item.slot, reason: 'late' })
    } catch {
      // 個別項目執行失敗時接住例外
    }
  }

  const remaining = list.filter((m) => !(m.taskId === taskId && m.slot === slot))
  await writeMissed(remaining)
}

// 全部略過：清空錯過清單
export async function skipAll() {
  await writeMissed([])
}

// 略過單一項目：從清單移除指定任務與排程槽
export async function skipOne(taskId, slot) {
  const list = await readMissed()
  const remaining = list.filter((item) => !(item.taskId === taskId && item.slot === slot))
  await writeMissed(remaining)
}
