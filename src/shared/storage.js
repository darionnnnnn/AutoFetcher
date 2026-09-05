// AutoFetcher 儲存層：所有 chrome.storage 存取的唯一入口

const DEFAULT_SETTINGS = {
  retentionDays: 365,
  notifications: true,
  extraDelaySec: 3,
  theme: 'system'
}

const DEFAULT_LAYOUT = { dashboards: [] }
const REC_PREFIX = 'rec:'

// 內部輔助函式：判定與轉換日期紀錄鍵
function isRecordKey(key) {
  return typeof key === 'string' && key.startsWith(REC_PREFIX)
}

function dateToKey(date) {
  return `${REC_PREFIX}${date}`
}

function keyToDate(key) {
  return key.slice(REC_PREFIX.length)
}

// 初始化儲存空間（冪等：已存在值不得覆蓋）
export async function init() {
  const current = await chrome.storage.local.get(['schemaVersion', 'settings'])
  const patch = {}
  if (current.schemaVersion === undefined) patch.schemaVersion = 1
  if (current.settings === undefined) patch.settings = { ...DEFAULT_SETTINGS }
  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch)
  }
}

// 取得架構版本號
export async function getSchemaVersion() {
  const res = await chrome.storage.local.get('schemaVersion')
  return typeof res.schemaVersion === 'number' ? res.schemaVersion : 1
}

// 取得全域設定
export async function getSettings() {
  const res = await chrome.storage.local.get('settings')
  return res.settings && typeof res.settings === 'object' ? res.settings : { ...DEFAULT_SETTINGS }
}

// 儲存設定（與既有設定淺層合併）
export async function saveSettings(patch) {
  const current = await getSettings()
  const updated = { ...current, ...patch }
  await chrome.storage.local.set({ settings: updated })
  return updated
}

// 取得所有任務清單，依 order 由小到大排序
export async function getTasks() {
  const res = await chrome.storage.local.get('tasks')
  const list = Array.isArray(res.tasks) ? [...res.tasks] : []
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

// 依 id 取得單一任務（不存在回傳 null）
export async function getTask(id) {
  const tasks = await getTasks()
  return tasks.find(t => t.id === id) || null
}

// 新增或更新任務（驗證 id, name, url；未指定 order 給目前最大 + 1）
export async function saveTask(task) {
  const isValidStr = v => typeof v === 'string' && v.trim() !== ''
  if (!task || !isValidStr(task.id) || !isValidStr(task.name) || !isValidStr(task.url)) {
    throw new Error('任務格式錯誤：id、name 與 url 必須皆為非空字串')
  }

  const res = await chrome.storage.local.get('tasks')
  const tasks = Array.isArray(res.tasks) ? [...res.tasks] : []

  let order = task.order
  if (order === undefined || order === null) {
    order = tasks.length === 0 ? 0 : Math.max(...tasks.map(t => t.order ?? 0)) + 1
  }

  const taskToSave = { ...task, order }
  const index = tasks.findIndex(t => t.id === task.id)
  if (index !== -1) {
    tasks[index] = taskToSave
  } else {
    tasks.push(taskToSave)
  }

  await chrome.storage.local.set({ tasks })
  return taskToSave
}

// 刪除任務並清理所有日期對應的紀錄（剩 0 筆時移除該日期鍵）
export async function deleteTask(id) {
  const all = await chrome.storage.local.get(null)
  const tasks = Array.isArray(all.tasks) ? all.tasks.filter(t => t.id !== id) : []
  const toSet = { tasks }
  const toRemove = []

  for (const [key, value] of Object.entries(all)) {
    if (isRecordKey(key)) {
      const records = Array.isArray(value) ? value : []
      const remaining = records.filter(r => r.taskId !== id)
      if (remaining.length === 0) {
        toRemove.push(key)
      } else if (remaining.length !== records.length) {
        toSet[key] = remaining
      }
    }
  }

  await chrome.storage.local.set(toSet)
  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove)
  }
}

// 取得所有站台設定
export async function getSites() {
  const res = await chrome.storage.local.get('sites')
  return res.sites && typeof res.sites === 'object' ? res.sites : {}
}

// 依 origin 取得單一站台設定（不存在回傳 null）
export async function getSite(origin) {
  const sites = await getSites()
  return sites[origin] ?? null
}

// 儲存單一站台設定
export async function saveSite(origin, site) {
  const sites = await getSites()
  sites[origin] = site
  await chrome.storage.local.set({ sites })
}

// 追加紀錄至指定日期的 storage 鍵（rec:<date>）
export async function appendRecord(date, record) {
  const key = dateToKey(date)
  const res = await chrome.storage.local.get(key)
  const list = Array.isArray(res[key]) ? res[key] : []
  list.push(record)
  await chrome.storage.local.set({ [key]: list })
}

// 取得指定日期的所有紀錄（無資料回傳空陣列）
export async function getRecordsByDate(date) {
  const key = dateToKey(date)
  const res = await chrome.storage.local.get(key)
  return Array.isArray(res[key]) ? res[key] : []
}

// 列出所有具備紀錄的日期，由舊到新排序
export async function listDates() {
  const all = await chrome.storage.local.get(null)
  const dates = []
  for (const [key, val] of Object.entries(all)) {
    if (isRecordKey(key) && Array.isArray(val) && val.length > 0) {
      dates.push(keyToDate(key))
    }
  }
  return dates.sort()
}

// 取得指定日期範圍內的所有紀錄（扁平陣列，含 date 欄位，由舊到新排序）
export async function getRecordsInRange(from, to) {
  const dates = (await listDates()).filter(d => d >= from && d <= to)
  if (dates.length === 0) return []

  const keys = dates.map(dateToKey)
  const data = await chrome.storage.local.get(keys)
  const result = []

  for (const d of dates) {
    const list = Array.isArray(data[dateToKey(d)]) ? data[dateToKey(d)] : []
    for (const record of list) {
      result.push({ ...record, date: d })
    }
  }
  return result
}

// 依 retentionDays 清理過期紀錄（retentionDays <= 0 時不刪除）
export async function trimOldRecords(today) {
  const settings = await getSettings()
  const retentionDays = settings.retentionDays
  if (typeof retentionDays !== 'number' || retentionDays <= 0) return

  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - retentionDays + 1)
  const cutoff = d.toISOString().slice(0, 10)

  const all = await chrome.storage.local.get(null)
  const toRemove = Object.keys(all).filter(key => isRecordKey(key) && keyToDate(key) < cutoff)
  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove)
  }
}

// 匯出設定與架構資料（不含任何抓取紀錄）
export async function exportAll() {
  const [schemaVersion, tasks, sites, settings, res] = await Promise.all([
    getSchemaVersion(),
    getTasks(),
    getSites(),
    getSettings(),
    chrome.storage.local.get('layout')
  ])
  return {
    schemaVersion,
    tasks,
    sites,
    settings,
    layout: res.layout ?? { ...DEFAULT_LAYOUT }
  }
}
