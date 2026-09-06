// AutoFetcher 儲存層：所有 chrome.storage 存取的唯一入口
import { pruneCardsForTask } from './layout-store.js'
import { encryptSecret } from './crypto.js'
import { parentIdOf, SERIES_SEP } from './series-index.js'

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

const SCHEMA_VERSION = 2

// 站台的舊欄位 loginPageUrlPrefix 轉成 loginCheck（不碰密碼；init 遷移與設定匯入共用）
export function normalizeSiteShape(site) {
  const next = { ...site }
  if (next.loginCheck === undefined && typeof next.loginPageUrlPrefix === 'string') {
    next.loginCheck = { type: 'urlPrefix', value: next.loginPageUrlPrefix }
  }
  delete next.loginPageUrlPrefix
  return next
}

// v1 → v2：站台從「登入頁前綴 + 明文密碼」改為「loginCheck + AES-GCM 密文」
async function migrateSitesToV2(sites) {
  const migrated = {}
  for (const [origin, site] of Object.entries(sites)) {
    if (!site || typeof site !== 'object') continue
    const next = normalizeSiteShape(site)
    if (next.password !== undefined) {
      if (next.passwordEnc === undefined && typeof next.password === 'string' && next.password !== '') {
        next.passwordEnc = await encryptSecret(next.password)
      }
      delete next.password
    }
    migrated[origin] = next
  }
  return migrated
}

// 初始化儲存空間（冪等：已存在值不得覆蓋；順便做一次性的 schema 遷移）
export async function init() {
  const current = await chrome.storage.local.get(['schemaVersion', 'settings', 'sites'])
  const patch = {}
  if (current.settings === undefined) patch.settings = { ...DEFAULT_SETTINGS }

  const version = typeof current.schemaVersion === 'number' ? current.schemaVersion : SCHEMA_VERSION
  if (version < 2 && current.sites && typeof current.sites === 'object') {
    patch.sites = await migrateSitesToV2(current.sites)
  }
  if (current.schemaVersion === undefined || version < SCHEMA_VERSION) {
    patch.schemaVersion = SCHEMA_VERSION
  }

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

// 儲存設定（與既有設定淺層合併，使用佇列避免併發覆蓋）
let saveQueue = Promise.resolve()

export async function saveSettings(patch) {
  saveQueue = saveQueue.then(async () => {
    const current = await getSettings()
    const updated = { ...current, ...patch }
    await chrome.storage.local.set({ settings: updated })
    return updated
  })
  return saveQueue
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

  if (task.id.includes(SERIES_SEP)) {
    throw new Error(`任務 id 不得包含保留字元 ${SERIES_SEP}`)
  }

  if (Array.isArray(task.fields)) {
    const seenKeys = new Set()
    for (const f of task.fields) {
      if (!f || typeof f.key !== 'string' || f.key.trim() === '') {
        throw new Error('任務欄位 key 必須為非空字串')
      }
      if (f.key.includes(SERIES_SEP)) {
        throw new Error(`任務欄位 key 不得包含保留字元 ${SERIES_SEP}`)
      }
      if (seenKeys.has(f.key)) {
        throw new Error(`任務欄位 key 重複：${f.key}`)
      }
      seenKeys.add(f.key)
    }
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
      const remaining = records.filter(r => parentIdOf(r.taskId) !== id)
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

  await pruneCardsForTask(id)
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

// 刪除單一站台設定
export async function deleteSite(origin) {
  const sites = await getSites()
  delete sites[origin]
  await chrome.storage.local.set({ sites })
  // 站台不在了，它的健康項目也要拿掉，否則燈號永遠紅著且沒有途徑清除
  await deleteHealthEntry('site:' + origin)
}

// 移除一筆健康項目（任務 id 或 site:<origin>）
export async function deleteHealthEntry(key) {
  const res = await chrome.storage.local.get('health')
  const health = res.health && typeof res.health === 'object' ? { ...res.health } : {}
  if (!(key in health)) return
  delete health[key]
  await chrome.storage.local.set({ health })
}

// 追加多筆紀錄至指定日期的 storage 鍵（rec:<date>）
export async function appendRecords(date, records) {
  if (!Array.isArray(records) || records.length === 0) return
  const key = dateToKey(date)
  const res = await chrome.storage.local.get(key)
  const list = Array.isArray(res[key]) ? res[key] : []
  list.push(...records)
  await chrome.storage.local.set({ [key]: list })
}

// 追加紀錄至指定日期的 storage 鍵（rec:<date>）
export async function appendRecord(date, record) {
  return appendRecords(date, [record])
}

// 取得指定日期的所有紀錄（無資料回傳空陣列）
export async function getRecordsByDate(date) {
  const key = dateToKey(date)
  const res = await chrome.storage.local.get(key)
  return Array.isArray(res[key]) ? res[key] : []
}

// 刪除指定日期的單一紀錄（依 taskId 與 capturedAt 相符者移除）
// 移除後若該日已無紀錄則移除整個日期鍵；找不到相符紀錄時不改動任何資料
export async function deleteRecord(date, taskId, capturedAt) {
  const key = dateToKey(date)
  const res = await chrome.storage.local.get(key)
  const list = Array.isArray(res[key]) ? res[key] : []
  const index = list.findIndex(r => r.taskId === taskId && r.capturedAt === capturedAt)
  if (index === -1) return
  list.splice(index, 1)
  if (list.length === 0) {
    await chrome.storage.local.remove(key)
  } else {
    await chrome.storage.local.set({ [key]: list })
  }
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
  // 要掃整個 storage（含全部歷史紀錄），一天只做一次；由看門狗呼叫，不放在寫入路徑上
  const stamp = await chrome.storage.local.get('lastTrimDate')
  if (stamp.lastTrimDate === today) return
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
  await chrome.storage.local.set({ lastTrimDate: today })
}

// 取得原始版面資料（無資料回傳 null）
export async function getRawLayout() {
  const res = await chrome.storage.local.get('layout')
  return res.layout ?? null
}

// 寫入原始版面資料至 storage.local.layout
export async function setRawLayout(layout) {
  await chrome.storage.local.set({ layout })
}

// 匯出設定與架構資料（不含任何抓取紀錄）
export async function exportAll() {
  const [schemaVersion, tasks, sites, settings, rawLayout] = await Promise.all([
    getSchemaVersion(),
    getTasks(),
    getSites(),
    getSettings(),
    getRawLayout()
  ])
  return {
    schemaVersion,
    tasks,
    sites,
    settings,
    layout: rawLayout ?? { ...DEFAULT_LAYOUT }
  }
}

// 匯入歷史紀錄資料，逐日併入 rec:<date>，以 taskId + capturedAt 去重
export async function importRecords(input) {
  let days = null
  if (Array.isArray(input)) {
    days = input
  } else if (input && typeof input === 'object' && Array.isArray(input.days)) {
    days = input.days
  } else if (input && typeof input === 'object' && typeof input.date === 'string' && input.tasks && typeof input.tasks === 'object') {
    days = [input]
  } else {
    throw new Error('匯入資料格式錯誤：必須為日檔陣列或包含 days 之物件')
  }

  for (const day of days) {
    if (!day || typeof day !== 'object' || typeof day.date !== 'string' || !day.date || !day.tasks || typeof day.tasks !== 'object') {
      throw new Error('日檔格式錯誤：缺少 date 或 tasks')
    }
  }

  const dateMap = new Map()
  for (const day of days) {
    if (!dateMap.has(day.date)) {
      dateMap.set(day.date, [])
    }
    dateMap.get(day.date).push(day)
  }

  const keys = Array.from(dateMap.keys()).map(dateToKey)
  const existingData = keys.length > 0 ? await chrome.storage.local.get(keys) : {}

  let added = 0
  let skipped = 0
  const toSet = {}

  for (const [date, dayList] of dateMap.entries()) {
    const key = dateToKey(date)
    const existingList = Array.isArray(existingData[key]) ? [...existingData[key]] : []
    const seen = new Set(existingList.map(r => `${r.taskId}::${r.capturedAt}`))
    const updatedList = [...existingList]

    for (const day of dayList) {
      if (!day.tasks || typeof day.tasks !== 'object') continue
      for (const taskData of Object.values(day.tasks)) {
        if (!taskData || !Array.isArray(taskData.records)) continue
        for (const rec of taskData.records) {
          const id = `${rec.taskId}::${rec.capturedAt}`
          if (seen.has(id)) {
            skipped++
          } else {
            seen.add(id)
            updatedList.push(rec)
            added++
          }
        }
      }
    }

    toSet[key] = updatedList
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet)
  }

  return { added, skipped }
}

// 取得儲存用量與統計資訊
export async function getStorageStats() {
  const all = await chrome.storage.local.get(null)
  const settings = (all.settings && typeof all.settings === 'object') ? all.settings : {}

  let recordCount = 0
  const dates = []
  for (const [key, val] of Object.entries(all)) {
    if (isRecordKey(key) && Array.isArray(val)) {
      recordCount += val.length
      if (val.length > 0) {
        dates.push(keyToDate(key))
      }
    }
  }
  dates.sort()
  const oldestDate = dates.length > 0 ? dates[0] : null

  let bytes = 0
  if (typeof chrome.storage?.local?.getBytesInUse === 'function') {
    try {
      bytes = await chrome.storage.local.getBytesInUse(null)
    } catch {
      bytes = JSON.stringify(all).length
    }
  } else {
    bytes = JSON.stringify(all).length
  }
  if (typeof bytes !== 'number') {
    bytes = Number(bytes) || 0
  }

  return {
    bytes,
    recordCount,
    oldestDate,
    lastSettingsExportAt: settings.lastSettingsExportAt ?? null,
    lastRecordsExportAt: settings.lastRecordsExportAt ?? null
  }
}

// 取得健康狀態表
export async function getHealthMap() {
  const res = await chrome.storage.local.get('health')
  return (res.health && typeof res.health === 'object') ? res.health : {}
}

// 一次記下多個序列最後抓到的值（多值任務逐個寫等於整包讀寫 N 遍）
export async function setLastValues(entries) {
  if (!entries || typeof entries !== 'object') return
  const keys = Object.keys(entries)
  if (keys.length === 0) return
  const all = await getLastValues()
  for (const k of keys) all[k] = entries[k]
  await chrome.storage.local.set({ lastValues: all })
}

// 記下某個任務最後一次抓到的值
export async function setLastValue(taskId, entry) {
  return setLastValues({ [taskId]: entry })
}

// 取得各任務最後一次抓到的值（popup 顯示用）
export async function getLastValues() {
  const res = await chrome.storage.local.get('lastValues')
  return res.lastValues && typeof res.lastValues === 'object' ? res.lastValues : {}
}

// 取得補抓清單
export async function getMissedList() {
  const res = await chrome.storage.local.get('missed')
  return Array.isArray(res.missed) ? res.missed : []
}

// 取得診斷紀錄清單
export async function getDiagList() {
  const res = await chrome.storage.local.get('diag')
  return Array.isArray(res.diag) ? res.diag : []
}

// 取得告警通知時間帳本（無資料回傳空物件）
export async function getAlertLog() {
  const res = await chrome.storage.local.get('alertLog')
  return (res.alertLog && typeof res.alertLog === 'object') ? res.alertLog : {}
}

// 寫入告警通知時間帳本
export async function setAlertLog(log) {
  await chrome.storage.local.set({ alertLog: log })
}

// 查詢單一任務在所有日期的紀錄總數（使用 listDates + 逐日 getRecordsByDate）
export async function countRecordsForTask(taskId) {
  if (!taskId) return 0
  const dates = await listDates()
  let count = 0
  for (const d of dates) {
    const records = await getRecordsByDate(d)
    for (const r of records) {
      if (r && parentIdOf(r.taskId) === taskId) {
        count++
      }
    }
  }
  return count
}

// 訂閱 storage 變更（去抖 50ms，僅監聽 local 且指定鍵值與 rec: 紀錄鍵）
const subscribers = new Set()
let isListening = false
let debounceTimer = null

const NOTIFY_KEYS = new Set(['tasks', 'health', 'layout', 'missed', 'lastValues'])

function shouldNotify(changes) {
  if (!changes || typeof changes !== 'object') return false
  for (const key of Object.keys(changes)) {
    if (NOTIFY_KEYS.has(key) || isRecordKey(key)) {
      return true
    }
  }
  return false
}

export function subscribe(handler) {
  if (typeof handler !== 'function') {
    return () => {}
  }
  const onChanged = (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage.onChanged : null
  if (!onChanged || typeof onChanged.addListener !== 'function') {
    return () => {}
  }
  if (!isListening) {
    onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return
      if (!shouldNotify(changes)) return
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        for (const fn of [...subscribers]) {
          if (!subscribers.has(fn)) continue
          try {
            fn()
          } catch {}
        }
      }, 50)
    })
    isListening = true
  }
  subscribers.add(handler)
  return () => {
    subscribers.delete(handler)
  }
}

