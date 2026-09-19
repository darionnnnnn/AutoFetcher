// AutoFetcher 排程數學：純函式（無 chrome.、無 storage），
// 讓 background 與 UI（Picker 的觸發預覽）共用同一份計算，不各寫一份。
// 唯一實作在這裡，background/scheduler.js 只做 re-export。

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

// slotOf 的反向：本地時間排程槽字串 → 該分鐘的時間戳（毫秒）；格式不合回 null
export function slotToMs(slot) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(slot ?? '').slice(0, 16))
  if (!m) return null
  const [, y, mo, d, h, mi] = m.map(Number)
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
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

// 間隔排程的候選時刻表（當天的分鐘數、星期）：nextIntervalRun 與 intervalRunsBetween 共用這一份
function intervalPlan(task) {
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
  // 星期以候選時刻自己所在的那一天判定(跨午夜的凌晨段也算它自己那天)
  const dayOk = (day) => everyDay || weekdays.includes(day.getDay())
  return { minutesOfDay, dayOk }
}

// 某一天某分鐘數的時間戳
function atMinute(day, m) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60, 0, 0).getTime()
}

/**
 * 計算下一個對齊的排程時刻
 * @param {Object} task 任務物件
 * @param {number} nowMs 當前毫秒時間戳
 * @returns {number|null} 下一個對齊的毫秒時間戳，或 null
 */
export function nextIntervalRun(task, nowMs) {
  const plan = intervalPlan(task)
  if (!plan) return null

  const base = new Date(nowMs)
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    if (!plan.dayOk(day)) continue

    for (const m of plan.minutesOfDay) {
      const candidate = atMinute(day, m)
      // 嚴格大於 now:等於 now 的格子要跳過
      if (candidate > nowMs) return candidate
    }
  }
  return null
}

/**
 * 列出間隔排程在 (fromMs, toMs] 之間應觸發的所有時刻（與 nextIntervalRun 同一份時段／星期規則）
 * @param {Object} task 任務物件
 * @param {number} fromMs 起點（不含）
 * @param {number} toMs 終點（含）
 * @returns {number[]} 遞增的毫秒時間戳
 */
export function intervalRunsBetween(task, fromMs, toMs) {
  const out = []
  if (typeof fromMs !== 'number' || typeof toMs !== 'number' || !(fromMs < toMs)) return out
  const plan = intervalPlan(task)
  if (!plan) return out

  const start = new Date(fromMs)
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  while (day.getTime() <= toMs) {
    if (plan.dayOk(day)) {
      for (const m of plan.minutesOfDay) {
        const candidate = atMinute(day, m)
        if (candidate > fromMs && candidate <= toMs) out.push(candidate)
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return out
}
