// 錯過清單：比對與補抓離線期間應執行但未執行的排程槽
import { getTasks, getMissedList, updateMissedList, getLastSeenAt, setLastSeenAt, getLedgerRange } from '../shared/storage.js'
import { slotOf } from './scheduler.js'
import { intervalRunsBetween } from '../shared/schedule-math.js'
import { notify } from './notify.js'
import { isGap, gapTextOf } from '../shared/describe.js'

// 七天的毫秒數常數
const SEVEN_DAYS_MS = 7 * 86400000
// 只計算 slot 早於「現在 − 20 分鐘」的格子：剛到點、還在跑（含 2＋10 分鐘的重試）的格子不得誤報成錯過；
// lastSeenAt 也只推進到這裡，下一輪接著算、不漏
export const MISSED_SETTLE_MS = 20 * 60 * 1000

// gap 的判定與白話在 shared/describe.js（UI 與背景共用）
export { isGap, gapTextOf }

// 同一個項目（任務＋排程槽）的比對鍵
const itemKey = (x) => `${x.taskId}:${x.slot}`

// 從錯過清單移除指定的項目（在鎖內對最新清單做，不會蓋掉同時新增的項目）
async function removeMissed(items) {
  const drop = new Set(items.map(itemKey))
  await updateMissedList((list) => list.filter((m) => !drop.has(itemKey(m))))
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

/**
 * interval 任務在 (fromMs, toMs] 之間應觸發卻沒有帳本的格子（純函式）
 * 扣掉帳本已有的、以及早於任務 createdAt 的格子；沒有 createdAt 的舊任務視為很早以前建立。
 * @returns {{ taskId, taskName, kind:'gap', count, from, slot }[]} 每個任務最多一筆，漏 0 格不產生
 */
export function computeIntervalGaps(tasks, ledger, fromMs, toMs) {
  if (!Array.isArray(tasks) || typeof fromMs !== 'number' || typeof toMs !== 'number' || fromMs >= toMs) {
    return []
  }
  const gaps = []
  for (const task of tasks) {
    if (!task || task.enabled === false) continue
    if (task.schedule?.type !== 'interval') continue
    const createdAt = typeof task.createdAt === 'number' ? task.createdAt : -Infinity
    const slots = []
    for (const ms of intervalRunsBetween(task, fromMs, toMs)) {
      if (ms < createdAt) continue
      const slot = slotOf(ms)
      if (ledger?.[task.id]?.[slot] !== undefined) continue
      slots.push(slot)
    }
    if (slots.length === 0) continue
    gaps.push({
      taskId: task.id,
      taskName: task.name || task.id,
      kind: 'gap',
      count: slots.length,
      from: slots[0],
      slot: slots[slots.length - 1]
    })
  }
  return gaps
}

// 重新整理錯過清單並於有新增項目時發送通知（onStartup 與看門狗每輪都呼叫；重複呼叫不重複列、不重複通知）
export async function refreshMissed(nowMs = Date.now(), sinceMs) {
  let effectiveSince = sinceMs
  if (typeof effectiveSince !== 'number') {
    const lastSeenAt = await getLastSeenAt()
    effectiveSince = typeof lastSeenAt === 'number' ? lastSeenAt : nowMs - SEVEN_DAYS_MS
  }

  // 計算窗的終點：現在 − 20 分鐘（剛到點的格子留給下一輪）
  const toMs = nowMs - MISSED_SETTLE_MS
  const fromMs = Math.max(effectiveSince, nowMs - SEVEN_DAYS_MS)
  // 窗是空的（上一輪已經算到這裡、或 lastSeenAt 比終點還新）：什麼都不做，也不把 lastSeenAt 往回拉
  if (!(fromMs < toMs)) return

  const tasks = await getTasks()
  const ledger = await getLedgerRange(slotOf(fromMs).slice(0, 10), slotOf(toMs).slice(0, 10))

  const computed = computeMissedSlots(tasks, ledger, fromMs, toMs)
  const gaps = computeIntervalGaps(tasks, ledger, fromMs, toMs)

  // 合併要對鎖內讀到的最新清單做，否則同時的補抓／略過會被舊清單蓋回來
  let newCount = 0
  const merged = await updateMissedList((existing) => {
    const existingKeys = new Set(existing.map(itemKey))
    const next = [...existing]
    for (const item of computed) {
      const key = itemKey(item)
      if (!existingKeys.has(key)) {
        existingKeys.add(key)
        next.push(item)
        newCount++
      }
    }
    // gap：同任務已有 gap 就把 count 加上去、slot 延到新的最後一格，不新增第二筆；gap 不另外通知
    for (const gap of gaps) {
      const idx = next.findIndex((m) => isGap(m) && m.taskId === gap.taskId)
      if (idx === -1) {
        next.push(gap)
      } else {
        const prev = next[idx]
        next[idx] = {
          ...prev,
          taskName: gap.taskName,
          count: (Number(prev.count) || 0) + gap.count,
          from: prev.from || gap.from,
          slot: gap.slot > prev.slot ? gap.slot : prev.slot
        }
      }
    }
    return next.sort((a, b) => a.slot.localeCompare(b.slot) || a.taskId.localeCompare(b.taskId))
  })

  const slotCount = merged.filter((m) => !isGap(m)).length
  if (slotCount > 0 && newCount > 0) {
    await notify('missed-tasks', {
      title: '錯過排程通知',
      message: `有 ${slotCount} 個排程槽未執行`,
      buttons: [{ title: '全部補抓' }, { title: '全部略過' }]
    })
  }

  await setLastSeenAt(toMs)
}

// 取得當前錯過清單
export async function getMissed() {
  return await getMissedList()
}

// 補抓清單中的所有項目
export async function catchUpAll(runTaskFn) {
  const list = await getMissedList()
  const tasks = await getTasks()
  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  // gap 不可補抓（補到的是現在的值）：不跑、也不從清單移除，只能「知道了」
  const runnable = list.filter((m) => !isGap(m))
  for (const item of runnable) {
    const task = taskMap.get(item.taskId)
    if (!task) continue
    try {
      await runTaskFn(task, { slot: item.slot, reason: 'late' })
    } catch {
      // 個別項目執行失敗時接住例外，繼續執行後續項目
    }
  }

  await removeMissed(runnable)
}

// 補抓單一項目：從清單找出符合的項目執行並移除
export async function catchUpOne(taskId, slot, runTaskFn) {
  const list = await getMissedList()
  const item = list.find((m) => m.taskId === taskId && m.slot === slot)
  if (!item || isGap(item)) return

  const tasks = await getTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (task) {
    try {
      await runTaskFn(task, { slot: item.slot, reason: 'late' })
    } catch {
      // 個別項目執行失敗時接住例外
    }
  }

  await removeMissed([item])
}

// 全部略過：清空錯過清單
export async function skipAll() {
  await updateMissedList(() => [])
}

// 略過單一項目：從清單移除指定任務與排程槽
export async function skipOne(taskId, slot) {
  await removeMissed([{ taskId, slot }])
}
