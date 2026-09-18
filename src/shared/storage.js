// AutoFetcher 儲存層：所有 chrome.storage 存取的唯一入口
import { pruneCardsForTask } from './layout-store.js'
import { encryptSecret } from './crypto.js'
import { parentIdOf, SERIES_SEP } from './series-index.js'
import { withLock, lockNameOf } from './lock.js'

const DEFAULT_SETTINGS = {
  retentionDays: 365,
  notifications: true,
  extraDelaySec: 3,
  theme: 'system',
  fetchTabMode: 'tab'
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

// ---- 讀-改-寫的唯一一份（AF-21 批次 1）----
// 規則：對某鍵的 set／remove 一律在 lockNameOf(那個鍵) 的鎖內，讀也在同一次持有內；
// 一次只動一個鍵（動多鍵就等於同時持有多把鎖＝巢狀）；鎖不可重入，鎖內不得再呼叫會取鎖的函式。

// mutator 回傳它表示刪掉這個鍵
const REMOVE = Symbol('remove')

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
const asArray = (v) => Array.isArray(v) ? v : []

/**
 * 鎖內讀一個鍵 → mutator(現值) → 寫回。
 * mutator 回 undefined 表示不寫（回傳現值）；回 REMOVE 表示刪鍵（回傳 undefined）；其餘寫入並回傳。
 */
async function mutateKey(key, mutator, area = 'local') {
  return withLock(lockNameOf(key, area), async () => {
    const store = chrome.storage[area]
    const res = await store.get(key)
    const current = res?.[key]
    const next = await mutator(current)
    if (next === undefined) return current
    if (next === REMOVE) {
      await store.remove(key)
      return undefined
    }
    await store.set({ [key]: next })
    return next
  })
}

// 公開 update* 共用：缺值／形狀不對時給 shape 的預設，交給 mutator 的是副本
function updateValue(key, shape, mutator, area = 'local') {
  return mutateKey(key, (current) => mutator(structuredClone(shape(current))), area)
}

// 單純覆寫一個鍵（仍在鎖內讀過再寫，寫入點規則只有一種）
function writeKey(key, value, area = 'local') {
  return mutateKey(key, () => value, area)
}

// 站台的舊欄位 loginPageUrlPrefix 轉成 loginCheck（不碰密碼；init 遷移與設定匯入共用）
export function normalizeSiteShape(site) {
  const next = { ...site }
  if (next.loginCheck === undefined && typeof next.loginPageUrlPrefix === 'string') {
    next.loginCheck = { type: 'urlPrefix', value: next.loginPageUrlPrefix }
  }
  delete next.loginPageUrlPrefix
  return next
}

// 需要加密的明文密碼（v1 站台）
function plainPasswordOf(site) {
  return site && typeof site === 'object' && site.passwordEnc === undefined &&
    typeof site.password === 'string' && site.password !== '' ? site.password : null
}

// v1 → v2：站台從「登入頁前綴 + 明文密碼」改為「loginCheck + AES-GCM 密文」
// 密文事先在鎖外算好（加密要取 cryptoKey 的鎖，不得在 sites 的鎖內巢狀取）；
// 鎖內讀到的密碼若不在事先算好的表裡，就先留著明文不刪（不能讓密碼消失）
function migrateSitesToV2(sites, encrypted) {
  const migrated = {}
  for (const [origin, site] of Object.entries(sites)) {
    if (!site || typeof site !== 'object') continue
    const next = normalizeSiteShape(site)
    if (next.password !== undefined) {
      const plain = plainPasswordOf(next)
      if (plain !== null) {
        if (!encrypted.has(plain)) {
          migrated[origin] = next
          continue
        }
        next.passwordEnc = encrypted.get(plain)
      }
      delete next.password
    }
    migrated[origin] = next
  }
  return migrated
}

// 初始化儲存空間（冪等：已存在值不得覆蓋；順便做一次性的 schema 遷移）
// 逐鍵依序取鎖：settings → sites → schemaVersion（版本號最後寫，遷移中斷時重跑還會再遷移一次）
export async function init() {
  await mutateKey('settings', (cur) => cur === undefined ? { ...DEFAULT_SETTINGS } : undefined)

  const current = await chrome.storage.local.get(['schemaVersion', 'sites'])
  const version = typeof current.schemaVersion === 'number' ? current.schemaVersion : SCHEMA_VERSION
  if (version < 2 && current.sites && typeof current.sites === 'object') {
    const encrypted = new Map()
    for (const site of Object.values(current.sites)) {
      const plain = plainPasswordOf(site)
      if (plain !== null && !encrypted.has(plain)) encrypted.set(plain, await encryptSecret(plain))
    }
    await mutateKey('sites', (sites) => sites && typeof sites === 'object' ? migrateSitesToV2(sites, encrypted) : undefined)
  }

  await mutateKey('schemaVersion', (cur) => {
    const v = typeof cur === 'number' ? cur : SCHEMA_VERSION
    return cur === undefined || v < SCHEMA_VERSION ? SCHEMA_VERSION : undefined
  })
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

// 儲存設定（與既有設定淺層合併；在 settings 鎖內讀-改-寫，跨頁面同時存也不會互相覆蓋）
export async function saveSettings(patch) {
  return mutateKey('settings', (current) => ({
    ...(current && typeof current === 'object' ? current : DEFAULT_SETTINGS),
    ...patch
  }))
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

// 內部輔助函式：驗證單一任務物件格式
function validateTask(task, index) {
  const isValidStr = v => typeof v === 'string' && v.trim() !== ''
  if (!task || !isValidStr(task.id) || !isValidStr(task.name) || !isValidStr(task.url)) {
    const err = new Error('任務格式錯誤：id、name 與 url 必須皆為非空字串')
    err.index = index
    throw err
  }

  if (task.id.includes(SERIES_SEP)) {
    const err = new Error(`任務 id 不得包含保留字元 ${SERIES_SEP}`)
    err.index = index
    throw err
  }

  if (Array.isArray(task.fields)) {
    const seenKeys = new Set()
    for (const f of task.fields) {
      if (!f || typeof f.key !== 'string' || f.key.trim() === '') {
        const err = new Error('任務欄位 key 必須為非空字串')
        err.index = index
        throw err
      }
      if (f.key.includes(SERIES_SEP)) {
        const err = new Error(`任務欄位 key 不得包含保留字元 ${SERIES_SEP}`)
        err.index = index
        throw err
      }
      if (seenKeys.has(f.key)) {
        const err = new Error(`任務欄位 key 重複：${f.key}`)
        err.index = index
        throw err
      }
      seenKeys.add(f.key)
    }
  }
}

// 整批新增或更新任務（先全部驗證，任一筆不合法整批不寫入）
export async function saveTasks(list) {
  if (!Array.isArray(list) || list.length === 0) return []

  for (let i = 0; i < list.length; i++) {
    validateTask(list[i], i)
  }

  let savedTasks = []
  await mutateKey('tasks', (current) => {
    const tasks = Array.isArray(current) ? [...current] : []
    savedTasks = mergeTasksUnlocked(tasks, list)
    return tasks
  })
  return savedTasks
}

// 內部輔助函式（不取鎖，只在 tasks 鎖內用）：把 list 併進 tasks（就地），回傳實際存下的任務
// 未指定 order 的給目前最大 + 1
function mergeTasksUnlocked(tasks, list) {
  let nextOrder = tasks.length === 0 ? 0 : Math.max(...tasks.map(t => t.order ?? 0)) + 1

  const savedTasks = []
  for (const item of list) {
    let order = item.order
    if (order === undefined || order === null) {
      order = nextOrder++
    }
    const taskToSave = { ...item, order }
    const index = tasks.findIndex(t => t.id === item.id)
    if (index !== -1) {
      tasks[index] = taskToSave
    } else {
      tasks.push(taskToSave)
    }
    savedTasks.push(taskToSave)
  }
  return savedTasks
}

/**
 * 在 tasks 鎖內讀最新的任務，對 ids 中存在的每個任務呼叫 mutator(副本)，寫回改過的那些。
 * 取代「getTask → 改 → saveTask」：跨兩次呼叫的讀-改-寫鎖不住，別人剛寫的欄位會被舊副本洗掉。
 * mutator 回 null／undefined 表示這個任務不改；不存在的 id 略過；任一筆不合法整批不寫（丟例外）。
 * @param {string[]} ids 任務 id
 * @param {(task: object) => object|null|undefined} mutator 回傳新任務
 * @returns {Promise<object[]>} 實際寫入的任務
 */
export async function updateTasks(ids, mutator) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  let savedTasks = []
  await mutateKey('tasks', async (current) => {
    const tasks = Array.isArray(current) ? [...current] : []
    const changed = []
    for (const id of new Set(ids)) {
      const found = tasks.find(t => t.id === id)
      if (!found) continue
      const next = await mutator(structuredClone(found))
      if (next === null || next === undefined) continue
      changed.push(next)
    }
    if (changed.length === 0) return undefined
    for (let i = 0; i < changed.length; i++) {
      validateTask(changed[i], i)
    }
    savedTasks = mergeTasksUnlocked(tasks, changed)
    return tasks
  })
  return savedTasks
}

// 新增或更新任務（驗證 id, name, url；未指定 order 給目前最大 + 1）
export async function saveTask(task) {
  const [saved] = await saveTasks([task])
  return saved
}

// 整批刪除任務並清理所有日期對應的紀錄（剩 0 筆時移除該日期鍵）
export async function deleteTasks(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return

  const targetIds = new Set(ids)
  // 逐鍵依序「取鎖→讀→改→寫→放」，不同時持有兩把鎖
  await mutateKey('tasks', (current) => Array.isArray(current) ? current.filter(t => !targetIds.has(t.id)) : [])

  // 先列出有哪些紀錄鍵（鎖外），每個鍵再在自己的鎖內重讀最新值來改
  const all = await chrome.storage.local.get(null)
  for (const key of Object.keys(all)) {
    if (!isRecordKey(key)) continue
    await mutateKey(key, (value) => {
      const records = Array.isArray(value) ? value : []
      const remaining = records.filter(r => !targetIds.has(parentIdOf(r.taskId)))
      if (remaining.length === 0) return REMOVE
      return remaining.length !== records.length ? remaining : undefined
    })
  }

  // 被刪任務最後一次的值也一起清（鍵是序列 id）；不清的話 lastValues 只會越長越大
  await mutateKey('lastValues', (current) => {
    if (!current || typeof current !== 'object') return undefined
    const kept = Object.fromEntries(Object.entries(current).filter(([k]) => !targetIds.has(parentIdOf(k))))
    return Object.keys(kept).length !== Object.keys(current).length ? kept : undefined
  })

  // 版面有自己的鎖，要在上面的鎖都放掉之後才動
  for (const id of ids) {
    await pruneCardsForTask(id)
  }
}

// 刪除任務並清理所有日期對應的紀錄（剩 0 筆時移除該日期鍵）
export async function deleteTask(id) {
  await deleteTasks([id])
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
  await mutateKey('sites', (current) => ({ ...asObject(current), [origin]: site }))
}

// 刪除單一站台設定
export async function deleteSite(origin) {
  await mutateKey('sites', (current) => {
    const sites = { ...asObject(current) }
    delete sites[origin]
    return sites
  })
  // 站台不在了，它的健康項目也要拿掉，否則燈號永遠紅著且沒有途徑清除
  await deleteHealthEntry('site:' + origin)
}

// 移除一筆健康項目（任務 id 或 site:<origin>）
export async function deleteHealthEntry(key) {
  await mutateKey('health', (current) => {
    const health = current && typeof current === 'object' ? { ...current } : {}
    if (!(key in health)) return undefined
    delete health[key]
    return health
  })
}

// 追加多筆紀錄至指定日期的 storage 鍵（rec:<date>）
export async function appendRecords(date, records) {
  if (!Array.isArray(records) || records.length === 0) return
  await mutateKey(dateToKey(date), (current) => [...asArray(current), ...records])
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
  await mutateKey(dateToKey(date), (current) => {
    const list = [...asArray(current)]
    const index = list.findIndex(r => r.taskId === taskId && r.capturedAt === capturedAt)
    if (index === -1) return undefined
    list.splice(index, 1)
    return list.length === 0 ? REMOVE : list
  })
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
  // 逐鍵在各自的鎖內刪（同一天的鎖可能正被抓取寫入持有）
  for (const key of toRemove) {
    await mutateKey(key, () => REMOVE)
  }
  await writeKey('lastTrimDate', today)
}

// 取得原始版面資料（無資料回傳 null）
export async function getRawLayout() {
  const res = await chrome.storage.local.get('layout')
  return res.layout ?? null
}

// 寫入原始版面資料至 storage.local.layout（整份取代；要依現值改請用 updateLayout）
export async function setRawLayout(layout) {
  await writeKey('layout', layout)
}

/**
 * 在 layout 鎖內讀原始版面（沒有時給 { dashboards: [] }）→ mutator(副本) 回傳新值 → 寫回。
 * mutator 回 undefined 表示不寫。版面的增刪改一律經 layout-store，由它呼叫這裡。
 */
export async function updateLayout(mutator) {
  return updateValue('layout', (v) => v ?? { ...DEFAULT_LAYOUT, dashboards: [] }, mutator)
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

  let added = 0
  let skipped = 0

  // 逐日在各自的鎖內併入（去重要對鎖內讀到的最新值做）
  for (const [date, dayList] of dateMap.entries()) {
    await mutateKey(dateToKey(date), (current) => {
      const updatedList = [...asArray(current)]
      const seen = new Set(updatedList.map(r => `${r.taskId}::${r.capturedAt}`))

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
      return updatedList
    })
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
  await mutateKey('lastValues', (current) => {
    const all = { ...asObject(current) }
    for (const k of keys) all[k] = entries[k]
    return all
  })
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

// 從 lastValues 移除指定的序列鍵
export async function deleteLastValues(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return
  await mutateKey('lastValues', (current) => {
    const all = { ...asObject(current) }
    let changed = false
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(all, k)) {
        delete all[k]
        changed = true
      }
    }
    return changed ? all : undefined
  })
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

// 在 alertLog 鎖內讀告警通知時間帳本 → mutator(副本) 回傳新值 → 寫回
export async function updateAlertLog(mutator) {
  return updateValue('alertLog', asObject, mutator)
}

// 在 health 鎖內讀健康狀態表 → mutator(副本) 回傳新值 → 寫回（寫入的算法在 background/health.js）
export async function updateHealthMap(mutator) {
  return updateValue('health', asObject, mutator)
}

// 在 missed 鎖內讀錯過清單 → mutator(副本) 回傳新清單 → 寫回
export async function updateMissedList(mutator) {
  return updateValue('missed', asArray, mutator)
}

// ---- 執行帳本（runs：{ [taskId]: { [slot]: status } }，冪等靠它，SPEC §4.1）----

async function getRuns() {
  const res = await chrome.storage.local.get('runs')
  return asObject(res.runs)
}

/**
 * 查某任務某排程槽的帳本狀態（沒有回 undefined）
 * @param {string} taskId 父任務 id
 * @param {string} slot 排程槽（本地時間 YYYY-MM-DDTHH:MM）
 */
export async function getRunStatus(taskId, slot) {
  return (await getRuns())[taskId]?.[slot]
}

/**
 * 寫某任務某排程槽的帳本狀態（在 runs 鎖內讀-改-寫）
 */
export async function setRunStatus(taskId, slot, status) {
  await updateValue('runs', asObject, (runs) => {
    runs[taskId] = { ...asObject(runs[taskId]), [slot]: status }
    return runs
  })
}

/**
 * 取日期範圍內（YYYY-MM-DD，含頭含尾）的帳本：同形狀，只含 slot 日期落在範圍內的格子
 */
export async function getLedgerRange(fromDate, toDate) {
  const runs = await getRuns()
  const result = {}
  for (const [taskId, slots] of Object.entries(runs)) {
    for (const [slot, status] of Object.entries(asObject(slots))) {
      const date = slot.slice(0, 10)
      if (date < fromDate || date > toDate) continue
      if (!result[taskId]) result[taskId] = {}
      result[taskId][slot] = status
    }
  }
  return result
}

// 上次看門狗／錯過清單看到的時間（毫秒）；沒有回 undefined
export async function getLastSeenAt() {
  const res = await chrome.storage.local.get('lastSeenAt')
  return res.lastSeenAt
}

export async function setLastSeenAt(ms) {
  await writeKey('lastSeenAt', ms)
}

// 上次記下的時區；沒有回 undefined
export async function getLastTimezone() {
  const res = await chrome.storage.local.get('lastTimezone')
  return res.lastTimezone
}

export async function setLastTimezone(tz) {
  await writeKey('lastTimezone', tz)
}

// ---- session：抓取中的排程槽（inflight）與重選開的分頁（repickTabs）----

// 取得抓取中的排程槽表（key -> { state, startedAt }）
export async function getInflight() {
  const res = await chrome.storage.session.get('inflight')
  return asObject(res?.inflight)
}

// 在 session:inflight 鎖內讀 → mutator(副本) 回傳新值 → 寫回
export async function updateInflight(mutator) {
  return updateValue('inflight', asObject, mutator, 'session')
}

// 取得為了重選而開的分頁表（taskId -> tabId）
export async function getRepickTabs() {
  const res = await chrome.storage.session.get('repickTabs')
  return asObject(res?.repickTabs)
}

// 在 session:repickTabs 鎖內讀 → mutator(副本) 回傳新值 → 寫回
export async function updateRepickTabs(mutator) {
  return updateValue('repickTabs', asObject, mutator, 'session')
}

// 查詢多個任務在所有日期的紀錄總數與各任務筆數
export async function countRecordsForTasks(ids) {
  const byId = {}
  if (!Array.isArray(ids) || ids.length === 0) {
    return { total: 0, byId }
  }

  for (const id of ids) {
    byId[id] = 0
  }

  const targetIds = new Set(ids)
  const all = await chrome.storage.local.get(null)
  let total = 0

  for (const [key, val] of Object.entries(all)) {
    if (isRecordKey(key) && Array.isArray(val)) {
      for (const r of val) {
        if (r && r.taskId) {
          const pid = parentIdOf(r.taskId)
          if (targetIds.has(pid)) {
            byId[pid] = (byId[pid] || 0) + 1
            total++
          }
        }
      }
    }
  }

  return { total, byId }
}

// 查詢單一任務在所有日期的紀錄總數
export async function countRecordsForTask(taskId) {
  if (!taskId) return 0
  const res = await countRecordsForTasks([taskId])
  return res.byId[taskId] ?? 0
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

// ---- 面板（side panel）的暫存 ctx：AF-10 作業 B ----
// 為什麼不走網址參數：B-0 實測面板重載時 Chrome 用 `default_path` 重新載入，
// `?ctx=` 之類的查詢字串會被丟掉。改放 `storage.session`（分頁關掉就沒了，正好）。
const PANEL_PREFIX = 'panel:'

/**
 * 讀某個分頁的面板 ctx。
 * @param {number} tabId 分頁 id
 * @returns {Promise<object|null>}
 */
export async function getPanelCtx(tabId) {
  if (tabId === undefined || tabId === null) return null
  const key = PANEL_PREFIX + tabId
  const res = await chrome.storage.session.get(key)
  return res?.[key] ?? null
}

/**
 * 寫某個分頁的面板 ctx（整包取代）。
 * @param {number} tabId 分頁 id
 * @param {object} ctx 內容
 */
export async function setPanelCtx(tabId, ctx) {
  if (tabId === undefined || tabId === null) return
  await writeKey(PANEL_PREFIX + tabId, ctx, 'session')
}

/**
 * 併入某個分頁的面板 ctx（只換給的那幾個鍵）。
 * 使用者可能已經在面板上填了一半的表單，整包覆蓋會把他打的字洗掉。
 * @param {number} tabId 分頁 id
 * @param {object} patch 要換的欄位
 */
export async function mergePanelCtx(tabId, patch) {
  if (tabId === undefined || tabId === null) return
  // 讀跟寫在同一把鎖內，兩個來源同時併入時不會互相洗掉
  await mutateKey(PANEL_PREFIX + tabId, (current) => ({ ...(current || {}), ...patch }), 'session')
}

/**
 * 清掉某個分頁的面板 ctx（面板關閉或分頁關閉時）。
 * @param {number} tabId 分頁 id
 */
export async function clearPanelCtx(tabId) {
  if (tabId === undefined || tabId === null) return
  await mutateKey(PANEL_PREFIX + tabId, () => REMOVE, 'session')
}

export function subscribe(handler, opts = {}) {
  if (typeof handler !== 'function') {
    return () => {}
  }
  const onChanged = (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage.onChanged : null
  if (!onChanged || typeof onChanged.addListener !== 'function') {
    return () => {}
  }
  // 面板要監看的是 session（它的 ctx 放那裡），別的畫面看 local；
  // 各自再寫一份 onChanged 監聽會違反「UI 監看資料變動的唯一入口」
  if (opts.area === 'session') {
    const onSession = (changes, areaName) => {
      if (areaName !== 'session') return
      handler(changes)
    }
    onChanged.addListener(onSession)
    return () => {
      if (typeof onChanged.removeListener === 'function') onChanged.removeListener(onSession)
    }
  }
  // 指定 keys：只看 local 這幾個鍵的變動、不防抖、把 changes 交給呼叫端
  // （background 要監看 settings，它不在 NOTIFY_KEYS 裡，也不該讓 UI 跟著重畫）
  if (Array.isArray(opts.keys)) {
    const onKeys = (changes, areaName) => {
      if (areaName !== 'local' || !changes) return
      if (!opts.keys.some(k => Object.prototype.hasOwnProperty.call(changes, k))) return
      handler(changes)
    }
    onChanged.addListener(onKeys)
    return () => {
      if (typeof onChanged.removeListener === 'function') onChanged.removeListener(onKeys)
    }
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

