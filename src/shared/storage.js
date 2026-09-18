// AutoFetcher 儲存層：所有 chrome.storage 存取的唯一入口
import { pruneCardsForTask } from './layout-store.js'
import { encryptSecret } from './crypto.js'
import { parentIdOf, SERIES_SEP } from './series-index.js'
import { withLock, lockNameOf } from './lock.js'
import { isSuccess, isWarn, isRed } from './record-status.js'

const DEFAULT_SETTINGS = {
  retentionDays: 365,
  notifications: true,
  extraDelaySec: 3,
  theme: 'system',
  fetchTabMode: 'tab'
}

const DEFAULT_LAYOUT = { dashboards: [] }
// 紀錄鍵（AF-21 批次 1）：舊的 rec:<date> 一天一鍵只讀與刪；新寫入一律 rec2:<date>:<HH>。
// 刻意換前綴：舊版以 startsWith('rec:') 認紀錄鍵，降版時小時鍵不會被當成日期
const REC_PREFIX = 'rec:'
const REC2_PREFIX = 'rec2:'
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))

// 帳本按日分鍵：runs:<YYYY-MM-DD>，值 { [taskId]: { [slot]: status } }
const RUNS_PREFIX = 'runs:'
const LEGACY_RUNS_KEY = 'runs'
// 帳本保留天數（錯過清單 7 天＋重試餘裕）
const RUNS_KEEP_DAYS = 14
// 範圍讀取：天數在這以內由日期列舉鍵，超過先取鍵名再篩〔暫定〕
const RANGE_ENUM_MAX_DAYS = 62
// 需要「所有鍵」的操作每批最多取幾個鍵的值
const BATCH_SIZE = 50

// 內部輔助函式：判定與轉換日期紀錄鍵（舊日鍵與小時鍵都認）
function isRecordKey(key) {
  return typeof key === 'string' && (key.startsWith(REC_PREFIX) || key.startsWith(REC2_PREFIX))
}

function legacyRecordKey(date) {
  return `${REC_PREFIX}${date}`
}

function hourRecordKey(date, hh) {
  return `${REC2_PREFIX}${date}:${hh}`
}

// 某日所有可能的紀錄鍵：舊日鍵在前，接著 00～23 小時鍵（合併時的相對順序就是這個）
function dayRecordKeys(date) {
  return [legacyRecordKey(date), ...HOURS.map(hh => hourRecordKey(date, hh))]
}

function keyToDate(key) {
  if (key.startsWith(REC2_PREFIX)) return key.slice(REC2_PREFIX.length, REC2_PREFIX.length + 10)
  return key.slice(REC_PREFIX.length)
}

// 紀錄落在哪個小時：slot（本地時間）第 12–13 碼 → capturedAt 換算的本地小時 → '00'
function hourOfRecord(record) {
  const slot = record?.slot
  if (typeof slot === 'string' && /^\d{2}$/.test(slot.slice(11, 13))) return slot.slice(11, 13)
  const ms = typeof record?.capturedAt === 'string' ? Date.parse(record.capturedAt) : NaN
  if (Number.isFinite(ms)) return String(new Date(ms).getHours()).padStart(2, '0')
  return '00'
}

// 依小時分組（保持原順序）：Map<HH, records[]>
function groupByHour(records) {
  const groups = new Map()
  for (const r of records) {
    const hh = hourOfRecord(r)
    if (!groups.has(hh)) groups.set(hh, [])
    groups.get(hh).push(r)
  }
  return groups
}

// 同日紀錄依 capturedAt 由舊到新（穩定排序；沒有 capturedAt 的保持相對位置、排最後）
function sortDayRecords(list) {
  const timeOf = (r) => {
    const ms = typeof r?.capturedAt === 'string' ? Date.parse(r.capturedAt) : NaN
    return Number.isFinite(ms) ? ms : null
  }
  return list
    .map((r, i) => ({ r, i, t: timeOf(r) }))
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i
      if (a.t === null) return 1
      if (b.t === null) return -1
      return a.t - b.t || a.i - b.i
    })
    .map(x => x.r)
}

// 把某日各鍵的值（依 dayRecordKeys 的順序）合併成一份排序好的清單
function mergeDay(date, data) {
  const merged = []
  for (const key of dayRecordKeys(date)) {
    if (Array.isArray(data[key])) merged.push(...data[key])
  }
  return sortDayRecords(merged)
}

// YYYY-MM-DD 加減天數（純日曆運算，不受時區影響）
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// 起訖日期（含頭含尾）之間的每一天；起日晚於訖日回空陣列
function datesBetween(from, to) {
  const dates = []
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d)
  return dates
}

function daySpan(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1
}

// 現在的本地日期 YYYY-MM-DD
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function runsKey(date) {
  return `${RUNS_PREFIX}${date}`
}

function isRunsKey(key) {
  return typeof key === 'string' && key.startsWith(RUNS_PREFIX)
}

// 取 storage 所有鍵名（只要鍵名，不取值）：有 getKeys 就用它，沒有才退回 get(null)
async function listAllKeys() {
  const local = chrome.storage.local
  if (typeof local.getKeys === 'function') return await local.getKeys()
  return Object.keys(await local.get(null))
}

// 分批取值：每批最多 BATCH_SIZE 個鍵，逐批交給 onBatch(該批的 { key: value })
async function forEachBatch(keys, onBatch) {
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const data = await chrome.storage.local.get(keys.slice(i, i + BATCH_SIZE))
    await onBatch(data || {})
  }
}

export const SCHEMA_VERSION = 3

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
// 逐鍵依序取鎖：settings → sites → runs:<date>／runs → schemaVersion（版本號最後寫，遷移中斷時重跑還會再遷移一次）
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

  await migrateRunsToV3()

  await mutateKey('schemaVersion', (cur) => {
    const v = typeof cur === 'number' ? cur : SCHEMA_VERSION
    return cur === undefined || v < SCHEMA_VERSION ? SCHEMA_VERSION : undefined
  })
}

// v2 → v3：單一 runs 鍵拆成 runs:<date>，只留近 RUNS_KEEP_DAYS 天（以現在的本地日期計），最後刪掉舊鍵。
// 冪等：各日鍵是「併入」（該日既有的格子優先），中途失敗重跑會再併一次同樣的格子，結果相同；
// 舊鍵最後才刪，刪掉之後再跑就沒有東西可遷移
async function migrateRunsToV3() {
  const res = await chrome.storage.local.get(LEGACY_RUNS_KEY)
  if (res[LEGACY_RUNS_KEY] === undefined) return
  const cutoff = addDays(localToday(), -RUNS_KEEP_DAYS)
  const byDate = new Map()
  for (const [taskId, slots] of Object.entries(asObject(res[LEGACY_RUNS_KEY]))) {
    for (const [slot, status] of Object.entries(asObject(slots))) {
      const date = typeof slot === 'string' ? slot.slice(0, 10) : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoff) continue
      if (!byDate.has(date)) byDate.set(date, {})
      const day = byDate.get(date)
      day[taskId] = { ...day[taskId], [slot]: status }
    }
  }
  for (const [date, cells] of byDate) {
    await mutateKey(runsKey(date), (current) => {
      const next = { ...asObject(current) }
      for (const [taskId, slots] of Object.entries(cells)) {
        next[taskId] = { ...slots, ...asObject(next[taskId]) }
      }
      return next
    })
  }
  await mutateKey(LEGACY_RUNS_KEY, () => REMOVE)
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

// 任務網址只收這幾種 scheme（AF-21 批次 3 定案 1）：javascript:／data:／chrome: 之類排程照開就是在擴充功能權限下執行
const TASK_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

// 任務網址的 scheme（解析不了回 null）
export function taskUrlProtocolOf(url) {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

// 驗證單一任務物件格式（寫入口與設定匯入共用；不合法丟例外）
export function validateTask(task, index, { keptUrl } = {}) {
  const isValidStr = v => typeof v === 'string' && v.trim() !== ''
  if (!task || !isValidStr(task.id) || !isValidStr(task.name) || !isValidStr(task.url)) {
    const err = new Error('任務格式錯誤：id、name 與 url 必須皆為非空字串')
    err.index = index
    throw err
  }

  if (task.url !== keptUrl && !TASK_URL_PROTOCOLS.has(taskUrlProtocolOf(task.url))) {
    const err = new Error('任務網址只能是 http、https 或 file')
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
      // Picker 重組整個任務時不會帶 createdAt：沒帶就保留原值（AF-21 2-D）
      if (taskToSave.createdAt === undefined && tasks[index].createdAt !== undefined) {
        taskToSave.createdAt = tasks[index].createdAt
      }
      tasks[index] = taskToSave
    } else {
      // 新 id 記下建立時間（毫秒）：interval 空窗提示不算建立之前的格子；舊任務沒有這欄就視為很早以前建立
      if (typeof taskToSave.createdAt !== 'number') taskToSave.createdAt = Date.now()
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
      changed.push({ next, keptUrl: found.url })
    }
    if (changed.length === 0) return undefined
    for (let i = 0; i < changed.length; i++) {
      validateTask(changed[i].next, i, { keptUrl: changed[i].keptUrl })
    }
    savedTasks = mergeTasksUnlocked(tasks, changed.map(c => c.next))
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

  // 先列出有哪些紀錄鍵與帳本鍵（鎖外、只取鍵名），每個鍵再在自己的鎖內重讀最新值來改
  const keys = await listAllKeys()
  for (const key of keys) {
    if (isRecordKey(key)) {
      await mutateKey(key, (value) => {
        const records = Array.isArray(value) ? value : []
        const remaining = records.filter(r => !targetIds.has(parentIdOf(r.taskId)))
        if (remaining.length === 0) return REMOVE
        return remaining.length !== records.length ? remaining : undefined
      })
    } else if (isRunsKey(key)) {
      await mutateKey(key, (value) => {
        const day = asObject(value)
        const kept = Object.fromEntries(Object.entries(day).filter(([id]) => !targetIds.has(parentIdOf(id))))
        if (Object.keys(kept).length === 0) return REMOVE
        return Object.keys(kept).length !== Object.keys(day).length ? kept : undefined
      })
    }
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

// 一次併入多個站台（同 origin 整筆取代；在 sites 鎖內讀-改-寫一次）
export async function saveSites(entries) {
  const patch = asObject(entries)
  if (Object.keys(patch).length === 0) return
  await mutateKey('sites', (current) => ({ ...asObject(current), ...patch }))
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

// 追加多筆紀錄至指定日期的小時鍵（rec2:<date>:<HH>）；落在不同小時的分組各寫一次
export async function appendRecords(date, records) {
  if (!Array.isArray(records) || records.length === 0) return
  for (const [hh, group] of groupByHour(records)) {
    await mutateKey(hourRecordKey(date, hh), (current) => [...asArray(current), ...group])
  }
}

// 追加紀錄至指定日期的小時鍵（rec2:<date>:<HH>）
export async function appendRecord(date, record) {
  return appendRecords(date, [record])
}

// 取得指定日期的所有紀錄（舊日鍵＋24 個小時鍵合併，依 capturedAt 由舊到新；無資料回傳空陣列）
export async function getRecordsByDate(date) {
  const data = await chrome.storage.local.get(dayRecordKeys(date))
  return mergeDay(date, data || {})
}

// 刪除指定日期的單一紀錄（依 taskId 與 capturedAt 相符者移除；舊日鍵與小時鍵都找）
// 移除後若該鍵已無紀錄則移除該鍵；找不到相符紀錄時不改動任何資料
export async function deleteRecord(date, taskId, capturedAt) {
  // 同一天的舊鍵與小時鍵共用一把鎖：鎖內讀全部、只改找到的那一個鍵
  await withLock(lockNameOf(legacyRecordKey(date)), async () => {
    const store = chrome.storage.local
    const data = (await store.get(dayRecordKeys(date))) || {}
    for (const key of dayRecordKeys(date)) {
      const list = asArray(data[key])
      const index = list.findIndex(r => r.taskId === taskId && r.capturedAt === capturedAt)
      if (index === -1) continue
      const next = [...list]
      next.splice(index, 1)
      if (next.length === 0) await store.remove(key)
      else await store.set({ [key]: next })
      return
    }
  })
}

// 列出所有具備紀錄的日期（舊日鍵或小時鍵有非空紀錄），由舊到新排序
export async function listDates() {
  const keys = (await listAllKeys()).filter(isRecordKey)
  const dates = new Set()
  await forEachBatch(keys, (data) => {
    for (const [key, val] of Object.entries(data)) {
      if (isRecordKey(key) && Array.isArray(val) && val.length > 0) dates.add(keyToDate(key))
    }
  })
  return [...dates].sort()
}

// 取得指定日期範圍內的所有紀錄（扁平陣列，含 date 欄位；先依日期、同日依 capturedAt 由舊到新）
// 抓取路徑（告警評估）也會呼叫：範圍不大時由日期列舉鍵直接取，不掃整個 storage
export async function getRecordsInRange(from, to) {
  if (!(from <= to)) return []
  const byDate = new Map()
  const collect = (data) => {
    for (const [key, val] of Object.entries(data || {})) {
      if (!isRecordKey(key) || !Array.isArray(val)) continue
      const date = keyToDate(key)
      if (!byDate.has(date)) byDate.set(date, {})
      byDate.get(date)[key] = val
    }
  }

  if (daySpan(from, to) <= RANGE_ENUM_MAX_DAYS) {
    collect(await chrome.storage.local.get(datesBetween(from, to).flatMap(dayRecordKeys)))
  } else {
    const keys = (await listAllKeys()).filter(k => {
      if (!isRecordKey(k)) return false
      const d = keyToDate(k)
      return d >= from && d <= to
    })
    await forEachBatch(keys, collect)
  }

  const result = []
  for (const date of [...byDate.keys()].sort()) {
    for (const record of mergeDay(date, byDate.get(date))) {
      result.push({ ...record, date })
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

  // 截止日與設定頁「會刪除幾天以前的紀錄」算的是同一條公式（countRecordsBeyondRetention）
  const cutoff = addDays(today, -retentionDays + 1)

  const toRemove = (await listAllKeys()).filter(key => isRecordKey(key) && keyToDate(key) < cutoff)
  // 逐鍵在各自的鎖內刪（同一天的鎖可能正被抓取寫入持有）
  for (const key of toRemove) {
    await mutateKey(key, () => REMOVE)
  }
  await writeKey('lastTrimDate', today)
}

// 帳本只留 RUNS_KEEP_DAYS 天：刪掉日期早於 today - 14 天的 runs:<date>
// 看門狗每日呼叫；用自己的日戳一天只做一次；與紀錄保留天數設定無關（retentionDays <= 0 也照清）
export async function trimOldRuns(today) {
  const stamp = await chrome.storage.local.get('lastRunsTrimDate')
  if (stamp.lastRunsTrimDate === today) return
  const cutoff = addDays(today, -RUNS_KEEP_DAYS)
  const toRemove = (await listAllKeys()).filter(key => isRunsKey(key) && key.slice(RUNS_PREFIX.length) < cutoff)
  for (const key of toRemove) {
    await mutateKey(key, () => REMOVE)
  }
  await writeKey('lastRunsTrimDate', today)
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

// 設定匯入會動到的鍵（AF-21 批次 3 定案 2）：只有這幾個可以被整鍵快照／還原
const IMPORT_KEYS = ['tasks', 'sites', 'settings', 'layout']

/**
 * 設定匯入寫入前的快照：{ [key]: 原值 }，storage 裡沒有的鍵不列（還原時要刪掉）。
 * 只讀不寫；還原經 restoreImportKeys，每個鍵在自己的鎖內重讀再覆寫。
 */
export async function snapshotImportKeys() {
  const res = (await chrome.storage.local.get(IMPORT_KEYS)) || {}
  const snap = {}
  for (const key of IMPORT_KEYS) {
    if (res[key] !== undefined) snap[key] = structuredClone(res[key])
  }
  return snap
}

/**
 * 把設定匯入會動到的鍵整鍵覆寫回快照（快照裡沒有的鍵刪掉）。
 * 逐鍵在各自的鎖內做，一次只持有一把；某鍵還原失敗不中斷其他鍵，最後丟出第一個錯誤。
 */
export async function restoreImportKeys(snapshot) {
  const snap = asObject(snapshot)
  let firstError = null
  for (const key of IMPORT_KEYS) {
    try {
      await mutateKey(key, () => Object.prototype.hasOwnProperty.call(snap, key) ? structuredClone(snap[key]) : REMOVE)
    } catch (err) {
      if (!firstError) firstError = err
    }
  }
  if (firstError) throw firstError
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
  const invalid = []

  // 逐日在各自的鎖內併入（同一天的舊鍵與小時鍵共用一把）；
  // 去重要對鎖內讀到的「該日所有既有鍵」做，新紀錄依自己的小時寫進 rec2: 鍵
  for (const [date, dayList] of dateMap.entries()) {
    await withLock(lockNameOf(legacyRecordKey(date)), async () => {
      const store = chrome.storage.local
      const data = (await store.get(dayRecordKeys(date))) || {}
      const seen = new Set()
      for (const key of dayRecordKeys(date)) {
        for (const r of asArray(data[key])) seen.add(`${r?.taskId}::${r?.capturedAt}`)
      }

      const incoming = []
      for (const day of dayList) {
        if (!day.tasks || typeof day.tasks !== 'object') continue
        for (const taskData of Object.values(day.tasks)) {
          if (!taskData || !Array.isArray(taskData.records)) continue
          for (const rec of taskData.records) {
            const reason = invalidRecordReason(rec)
            if (reason) {
              skipped++
              if (invalid.length < INVALID_REPORT_MAX) {
                invalid.push({ date, taskId: typeof rec?.taskId === 'string' ? rec.taskId : '', reason })
              }
              continue
            }
            const id = `${rec.taskId}::${rec.capturedAt}`
            if (seen.has(id)) {
              skipped++
            } else {
              seen.add(id)
              incoming.push(rec)
              added++
            }
          }
        }
      }

      for (const [hh, group] of groupByHour(incoming)) {
        const key = hourRecordKey(date, hh)
        await store.set({ [key]: [...asArray(data[key]), ...group] })
      }
    })
  }

  // invalid 只在有不合格紀錄時才帶（既有呼叫端與 za2 以 deepEqual 比對 { added, skipped }）
  return invalid.length > 0 ? { added, skipped, invalid } : { added, skipped }
}

// 匯入時回報幾筆不合格紀錄的原因
const INVALID_REPORT_MAX = 5

// 單筆匯入紀錄不合格的原因（合格回空字串）：
// taskId 的保留分隔字元多於一個就拆不出父任務與值 key，寫進去會變成永遠刪不掉的孤兒
function invalidRecordReason(rec) {
  if (!rec || typeof rec !== 'object') return '紀錄不是物件'
  if (typeof rec.taskId !== 'string' || rec.taskId.trim() === '') return 'taskId 必須是非空字串'
  if (rec.taskId.split(SERIES_SEP).length > 2) return `taskId 的保留字元 ${SERIES_SEP} 最多只能出現一次`
  if (typeof rec.capturedAt !== 'string' || !Number.isFinite(Date.parse(rec.capturedAt))) return 'capturedAt 不是可解析的時間'
  if (rec.status !== undefined && !isKnownRecordStatus(rec)) return `未知的狀態：${String(rec.status)}`
  return ''
}

// 沒有 status 鍵的舊紀錄照收（za2 的既有匯入測試就是這種形狀）；有帶但不認得才拒絕
// 已知的紀錄狀態：成功／警示／紅燈清單（record-status.js）＋ interrupted
function isKnownRecordStatus(rec) {
  return isSuccess(rec) || isWarn(rec) || isRed(rec) || rec.status === 'interrupted'
}

// 取得儲存用量與統計資訊
export async function getStorageStats() {
  const allKeys = await listAllKeys()
  const settingsRes = await chrome.storage.local.get('settings')
  const settings = (settingsRes.settings && typeof settingsRes.settings === 'object') ? settingsRes.settings : {}

  let recordCount = 0
  const dates = []
  await forEachBatch(allKeys.filter(isRecordKey), (data) => {
    for (const [key, val] of Object.entries(data)) {
      if (isRecordKey(key) && Array.isArray(val)) {
        recordCount += val.length
        if (val.length > 0) dates.push(keyToDate(key))
      }
    }
  })
  dates.sort()
  const oldestDate = dates.length > 0 ? dates[0] : null

  // 沒有 getBytesInUse 時的估算：分批序列化；金鑰與站台（含密文）不進任何被序列化的字串
  const estimateBytes = async () => {
    let total = 0
    await forEachBatch(allKeys.filter(k => k !== 'cryptoKey' && k !== 'sites'), (data) => {
      const { cryptoKey, sites, ...rest } = data
      total += JSON.stringify(rest).length
    })
    return total
  }

  let bytes = 0
  if (typeof chrome.storage?.local?.getBytesInUse === 'function') {
    try {
      bytes = await chrome.storage.local.getBytesInUse(null)
    } catch {
      bytes = await estimateBytes()
    }
  } else {
    bytes = await estimateBytes()
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

// 取得失敗通知冷卻帳本（{ [key]: { status, at } }；無資料回傳空物件）
export async function getNotifyLog() {
  const res = await chrome.storage.local.get('notifyLog')
  return asObject(res?.notifyLog)
}

// 在 notifyLog 鎖內讀失敗通知冷卻帳本 → mutator(副本) 回傳新值 → 寫回（回 undefined 表示不寫）
export async function updateNotifyLog(mutator) {
  return updateValue('notifyLog', asObject, mutator)
}

// 在 session:failMerge 鎖內讀同站台失敗通知的累計（{ [origin]: { at, items:[{ id, name }] } }）→ mutator(副本) → 寫回
// 放 session：worker 被回收也不丟，瀏覽器關掉就沒了（合併只看 5 分鐘內）
export async function updateFailMerge(mutator) {
  return updateValue('failMerge', asObject, mutator, 'session')
}

// 在 health 鎖內讀健康狀態表 → mutator(副本) 回傳新值 → 寫回（寫入的算法在 background/health.js）
export async function updateHealthMap(mutator) {
  return updateValue('health', asObject, mutator)
}

// 清掉 alertLog／lastValues／health／notifyLog 裡已刪任務與站台的項目（AF-21 定案 6；看門狗一天一次呼叫）
// 以目前的 tasks（父任務 id）與 sites（origin）為準；每個鍵各自在自己的鎖內讀-改-寫，沒有要清的就不寫
export async function pruneOrphanEntries() {
  const taskIds = new Set((await getTasks()).map(t => t?.id).filter(id => typeof id === 'string'))
  const origins = new Set(Object.keys(await getSites()))
  const bySeries = (k) => taskIds.has(parentIdOf(k))
  const byHealth = (k) => k.startsWith('site:') ? origins.has(k.slice('site:'.length)) : taskIds.has(k)
  const removed = {}
  // notifyLog 的鍵：任務 id、<任務 id>:precheck、site:<origin>
  const byNotify = (k) => {
    if (k.startsWith('site:')) return origins.has(k.slice('site:'.length))
    const id = k.endsWith(':precheck') ? k.slice(0, -':precheck'.length) : k
    return taskIds.has(id)
  }
  for (const [key, keep] of [['alertLog', bySeries], ['lastValues', bySeries], ['health', byHealth], ['notifyLog', byNotify]]) {
    await mutateKey(key, (current) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
      const stale = Object.keys(current).filter(k => !keep(k))
      if (stale.length === 0) return undefined
      const next = { ...current }
      for (const k of stale) delete next[k]
      removed[key] = stale
      return next
    })
  }
  return removed
}

// 一天一次的日戳守衛（看門狗的日常清理用）：stampKey 已記著 today 就不跑，跑完才記
export async function runOncePerDay(stampKey, today, fn) {
  const stamp = await chrome.storage.local.get(stampKey)
  if (stamp?.[stampKey] === today) return false
  await fn()
  await writeKey(stampKey, today)
  return true
}

// 在 missed 鎖內讀錯過清單 → mutator(副本) 回傳新清單 → 寫回
export async function updateMissedList(mutator) {
  return updateValue('missed', asArray, mutator)
}

// ---- 執行帳本（冪等靠它，SPEC §4.1）----
// 按日分鍵 runs:<YYYY-MM-DD>（日期＝slot 前 10 碼），值 { [taskId]: { [slot]: status } }；某日無鍵＝該日沒有任何格

/**
 * 查某任務某排程槽的帳本狀態（沒有回 undefined）
 * @param {string} taskId 父任務 id
 * @param {string} slot 排程槽（本地時間 YYYY-MM-DDTHH:MM）
 */
export async function getRunStatus(taskId, slot) {
  const key = runsKey(String(slot).slice(0, 10))
  const res = await chrome.storage.local.get(key)
  return asObject(res[key])[taskId]?.[slot]
}

/**
 * 寫某任務某排程槽的帳本狀態（在該日 runs:<date> 的鎖內讀-改-寫）
 */
export async function setRunStatus(taskId, slot, status) {
  await updateValue(runsKey(String(slot).slice(0, 10)), asObject, (runs) => {
    runs[taskId] = { ...asObject(runs[taskId]), [slot]: status }
    return runs
  })
}

/**
 * 取日期範圍內（YYYY-MM-DD，含頭含尾）的帳本：同形狀，只含 slot 日期落在範圍內的格子
 * 由起訖日期列舉 runs:<date> 鍵直接取（不掃整個 storage）
 */
export async function getLedgerRange(fromDate, toDate) {
  const result = {}
  if (!(fromDate <= toDate)) return result
  const keys = datesBetween(fromDate, toDate).map(runsKey)
  const collect = (data) => {
    for (const key of keys) {
      for (const [taskId, slots] of Object.entries(asObject(data?.[key]))) {
        for (const [slot, status] of Object.entries(asObject(slots))) {
          const date = slot.slice(0, 10)
          if (date < fromDate || date > toDate) continue
          if (!result[taskId]) result[taskId] = {}
          result[taskId][slot] = status
        }
      }
    }
  }
  await forEachBatch(keys, collect)
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

// ---- session：排隊中／執行中的排程槽（runState）與重選開的分頁（repickTabs）----

// 取得排程槽的執行狀態表（'<taskId>@<slot>' -> { state:'queued'|'running', at, boot, attempt, reason }）
export async function getRunState() {
  const res = await chrome.storage.session.get('runState')
  return asObject(res?.runState)
}

// 在 session:runState 鎖內讀 → mutator(副本) 回傳新值 → 寫回
export async function updateRunState(mutator) {
  return updateValue('runState', asObject, mutator, 'session')
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
  let total = 0
  const keys = (await listAllKeys()).filter(isRecordKey)
  await forEachBatch(keys, (data) => {
    for (const [key, val] of Object.entries(data)) {
      if (!isRecordKey(key) || !Array.isArray(val)) continue
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
  })

  return { total, byId }
}

// 唯讀：保留天數改成 retentionDays 時，看門狗下一輪（trimOldRecords）會刪掉幾筆紀錄
// 截止日算法與 trimOldRecords 相同（today 往前 retentionDays-1 天，更早的日期刪）；分批讀，不一次載入全部紀錄
export async function countRecordsBeyondRetention(retentionDays, today = localToday()) {
  if (typeof retentionDays !== 'number' || retentionDays <= 0) return { count: 0, cutoff: null }
  const cutoff = addDays(today, -retentionDays + 1)
  const keys = (await listAllKeys()).filter(key => isRecordKey(key) && keyToDate(key) < cutoff)
  let count = 0
  await forEachBatch(keys, (data) => {
    for (const val of Object.values(data)) {
      if (Array.isArray(val)) count += val.length
    }
  })
  return { count, cutoff }
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

