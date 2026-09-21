// AutoFetcher 擷取流程：開分頁、注入、擷取、寫紀錄、重試
import { getTask, updateTasks, appendRecord, appendRecords, getRecordsInRange, getSettings, updateAlertLog, setLastValue, setLastValues, getRunStatus, setRunStatus, getRunState, updateRunState, updateMissedList } from '../shared/storage.js'
import { waitMsOf, timeoutMsOf, preActionFailure, DEFAULT_WAIT_TIMEOUT_MS, messageTimeoutMs, holdMsOf, capStepMs, PRE_ACTION_STEP_MAX_MS, PRE_ACTION_STEP_CAP_NOTE } from '../shared/preaction.js'
import { seriesIdOf, parentIdOf, buildSeriesIndex, nameOf } from '../shared/series-index.js'
import { MSG } from '../shared/messages.js'
import { slotOf } from './scheduler.js'
import { slotToMs } from '../shared/schedule-math.js'
import { notify, notifySiteFailure, clearNotifyLog } from './notify.js'
import { injectContent } from './inject.js'
import { evaluateAlerts } from '../shared/alerts.js'
import { isSuccess, healthStatusOf } from '../shared/record-status.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { ensureLoggedIn } from './login.js'
import { locateFrame, sameOriginPath, PROBE_TIMEOUT_MS } from './frames.js'
import { acquireFetchTab, openForegroundTab, enqueueForOrigin, waitTabReady, BOOT } from './fetch-tab.js'
import { sendToFrame, timeoutError } from './messaging.js'
import { normalizeTaskSources } from '../shared/task-source.js'

// `locateFrame` 找到才有 frameId；失敗時回的是帶候選清單的物件（給診斷用），不是 null
function frameFound(loc) {
  return Boolean(loc) && typeof loc.frameId === 'number'
}

// 「立即測試」失敗時給使用者匯出的診斷包（SPEC §3）。
// **只在 dryRun 走這裡**：正式抓取不組（不寫紀錄、不進 diag 環形緩衝）。
async function buildDebug(task, tabId, loc, preActionTrace, err, page) {
  let tabUrl = ''
  try {
    // 轉址後的實際位置，不是任務設定的網址
    tabUrl = (await chrome.tabs.get(tabId))?.url || ''
  } catch {}
  return {
    version: chrome.runtime?.getManifest?.()?.version || '',
    at: new Date().toISOString(),
    tabUrl,
    task: {
      name: task?.name || '',
      url: task?.url || '',
      spec: task?.spec,
      locator: task?.locator,
      frame: task?.frame,
      // 前置動作可能含站台帳號設定的 id，密碼一類永遠不在這裡（登入資料另存）
      preActions: task?.preActions
    },
    frame: {
      frameId: frameFound(loc) ? loc.frameId : null,
      matchedBy: loc?.matchedBy ?? null,
      candidates: Array.isArray(loc?.candidates) ? loc.candidates : []
    },
    ...(preActionTrace && preActionTrace.length > 0 ? { preActionTrace } : {}),
    error: err || {},
    ...(page ? { page } : {})
  }
}
import * as diag from '../shared/diag.js'

// 短暫等待輔助函式（非排程）
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 文件在抓取途中被換掉時，使用者看到的是這一句——**唯一一份**，
// 立即測試、紀錄、任務頁、popup 都吃它。
// Chrome 的原文只說了「送不到」，沒說發生什麼、也沒說能怎麼辦；原文留給診斷。
const PAGE_GONE_MESSAGE =
  '頁面在抓取途中換頁或重新載入，來不及取值。若有前置動作，請在會換頁的那一步後面加一個「等待」動作（建議 3 秒）；也請確認目標就在換頁後的那一頁。'

// 送訊息的逾時封裝（sendToFrame／timeoutError）在 messaging.js，background 共用一份

// 續命間隔（AF-21 批次 2 定案 5）：MV3 的 service worker 閒置約 30 秒就被回收，
// 純等待期間沒有任何 chrome API 呼叫就算閒置
const KEEP_ALIVE_INTERVAL_MS = 20000

/**
 * 會續命的等待：每等滿一個間隔、而且還要再等，就呼叫一次 `getPlatformInfo`。
 * 小於一個間隔的等待不呼叫（沒必要）。fetcher 內的純等待一律走它。
 * @param {number} ms 要等的毫秒
 * @param {{intervalMs?: number}} [opts] 間隔只給測試縮短
 */
export async function keepAliveSleep(ms, opts = {}) {
  const intervalMs = opts.intervalMs ?? KEEP_ALIVE_INTERVAL_MS
  let left = Number.isFinite(ms) && ms > 0 ? ms : 0
  while (left > 0) {
    const chunk = Math.min(intervalMs, left)
    await sleep(chunk)
    left -= chunk
    if (left > 0) {
      try { await chrome.runtime.getPlatformInfo() } catch {}
    }
  }
}

// 單次抓取的總時限（AF-21 批次 2 定案 5，暫定值）：
// 基本額度＋任務自己宣告的等待總和，上限壓在單一事件約 5 分鐘之內
const RUN_BUDGET_BASE_MS = 150000
const RUN_BUDGET_MAX_MS = 270000
const DEADLINE_MESSAGE = '超過單次抓取時限'

/**
 * 這次抓取的時限毫秒：基本額度＋前置動作宣告的等待（`wait` 的秒數、`hover` 的停留、`waitFor` 的逾時；
 * `wait`／`hover` 以執行時上限計），上限 `maxMs`。
 * @param {object} task 任務
 * @param {{baseMs?: number, maxMs?: number, stepMaxMs?: number}} [opts] 只給測試縮短
 * @returns {number}
 */
export function runBudgetMsOf(task, opts = {}) {
  const baseMs = opts.baseMs ?? RUN_BUDGET_BASE_MS
  const maxMs = opts.maxMs ?? RUN_BUDGET_MAX_MS
  const stepMaxMs = opts.stepMaxMs ?? PRE_ACTION_STEP_MAX_MS
  let declared = 0
  for (const action of Array.isArray(task?.preActions) ? task.preActions : []) {
    if (action?.type === 'wait') declared += capStepMs(waitMsOf(action), stepMaxMs).ms
    else if (action?.type === 'hover') declared += capStepMs(holdMsOf(action), stepMaxMs).ms
    else if (action?.type === 'waitFor') declared += timeoutMsOf(action)
  }
  return Math.min(baseMs + declared, maxMs)
}

// 超過總時限的錯誤：與既有逾時同類（afTimeout），另帶 afDeadline 讓各層不要把它吞成別的失敗
function deadlineError(budgetMs) {
  const err = timeoutError(`${DEADLINE_MESSAGE}（${Math.round(budgetMs / 1000)} 秒）`)
  err.afDeadline = true
  return err
}

// content 回的錯誤代碼轉成紀錄要寫的字：content 自己丟例外時說中文（AF-21 批次 2 定案 6）
function contentErrorText(res) {
  if (res?.error === 'content_exception') {
    return `頁面上的程式發生錯誤：${res.detail || '未知錯誤'}`
  }
  return res?.error ? String(res.error) : ''
}

// 解析 URL 取得 origin
function getOrigin(url) {
  try {
    return new URL(url).origin
  } catch {
    return url || ''
  }
}

// 實際開始抓的時刻比排程槽晚超過這麼久，成功的紀錄記 late（AF-21 批次 2 定案 2；
// 必須大於重試視窗 2＋10 分鐘加單次執行時間，否則每一筆重試成功都會變黃燈）
const LATE_AFTER_MS = 30 * 60 * 1000
// 別的 worker 留下的 runState 項目：這麼久以內續跑，超過就記 interrupted（定案 4，暫定值）
const RECOVER_WITHIN_MS = 10 * 60 * 1000
// 同一個 worker 自己的 running 項目：跑超過「單次總時限上限＋30 秒」一定是卡住了（AF-21 終檢），
// 比照超過 RECOVER_WITHIN_MS 的處理（寫 interrupted、daily 進錯過清單、移除）
const STUCK_RUNNING_MS = RUN_BUDGET_MAX_MS + 30 * 1000

// 這一次開始抓的時刻比排程槽晚超過 LATE_AFTER_MS（呼叫端用它算出 runTask 的 markLate）
export function isLateStart(slot, nowMs) {
  const slotMs = slotToMs(slot)
  if (slotMs === null) return false
  return nowMs - slotMs > LATE_AFTER_MS
}

// runState 的鍵：'<taskId>@<slot>'
function runStateKeyOf(taskId, slot) {
  return `${taskId}@${slot}`
}

// 寫入（或覆寫）自己那一項
async function putRunState(key, entry) {
  await updateRunState((cur) => ({ ...cur, [key]: entry }))
}

// 只改自己那一項的狀態（項目已被移除就不復活它）；轉成 running 時記下開始跑的時刻 runningAt
// （at 是進佇列的時刻，排隊的時間不算進總時限，判定卡住要從開始跑算）
async function markRunState(key, state) {
  const runningAt = Date.now()
  await updateRunState((cur) => {
    if (!cur[key]) return undefined
    cur[key] = state === 'running' ? { ...cur[key], state, runningAt } : { ...cur[key], state }
    return cur
  })
}

// 移除自己那一項；本來就沒有就不寫
async function dropRunState(key) {
  return takeRunState(key)
}

// 鎖內「拿走」一項：回傳拿走前它還在不在。啟動時與看門狗可能同時復原，
// 只有真的拿到的那一方可以續跑或寫 interrupted，否則同一格會被處理兩次
async function takeRunState(key) {
  let taken = false
  await updateRunState((cur) => {
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined
    delete cur[key]
    taken = true
    return cur
  })
  return taken
}

// '<taskId>@<slot>' 拆回兩段：slot 固定是 YYYY-MM-DDTHH:mm，從最後一個 @ 切
function parseRunStateKey(key) {
  const at = key.lastIndexOf('@')
  if (at <= 0) return null
  return { taskId: key.slice(0, at), slot: key.slice(at + 1) }
}

/**
 * 復原上一個 worker 留下的排隊中／執行中項目（worker 啟動與看門狗每輪呼叫）。
 * 只處理 boot 不是現在這個 worker 的項目；boot 相同的是自己正在跑的，一律不碰。
 * runOpts 只給測試縮短等待，正式呼叫不傳。
 * `detach: true`（看門狗用）：續跑的 runTask 不 await，同一輪的其他清理不必等它跑完；
 * 它的例外接住寫診斷（run_state_error）。回傳這一輪續跑的 Promise 陣列（呼叫端可不理）。
 */
export async function recoverRunState(runOpts = {}, { detach = false } = {}) {
  const resumed = []
  const state = await getRunState()
  // 已經排著重試 alarm 的格子不要再續跑一次：同一格兩條重試鏈會互相搶帳本、各寫一筆紀錄
  const pendingRetries = new Set()
  try {
    for (const alarm of (await chrome.alarms.getAll()) || []) {
      const parsed = parseRetryName(alarm?.name)
      if (parsed?.slot) pendingRetries.add(runStateKeyOf(parsed.taskId, parsed.slot))
    }
  } catch {}
  for (const [key, entry] of Object.entries(state)) {
    if (!entry) continue
    // 自己這個 worker 的項目：只有 running 且跑超過 STUCK_RUNNING_MS 的算卡住，其餘不碰
    let stuck = false
    if (entry.boot === BOOT) {
      const startedAt = typeof entry.runningAt === 'number' ? entry.runningAt : (typeof entry.at === 'number' ? entry.at : null)
      if (entry.state !== 'running' || startedAt === null || Date.now() - startedAt <= STUCK_RUNNING_MS) continue
      stuck = true
    }
    const parsed = parseRunStateKey(key)
    if (!parsed) {
      await dropRunState(key)
      continue
    }
    const { taskId, slot } = parsed
    const task = await getTask(taskId)
    const at = typeof entry.at === 'number' ? entry.at : 0
    // 先拿走再處理：續跑會用同一個鍵登記自己（帶現在的 boot）；沒拿到＝另一個復原已經在處理
    if (!(await takeRunState(key))) continue
    if (!stuck && Date.now() - at <= RECOVER_WITHIN_MS) {
      if (!task || task.enabled === false) continue
      // 這一格已經有重試 alarm 在等：項目拿掉就好，續跑交給那個 alarm
      if (pendingRetries.has(key)) continue
      const run = runTask(task, {
        slot,
        attempt: typeof entry.attempt === 'number' ? entry.attempt : 1,
        reason: typeof entry.reason === 'string' ? entry.reason : 'scheduled',
        markLate: isLateStart(slot, Date.now()),
        ...runOpts
      })
      if (detach) {
        resumed.push(run.catch(async (err) => {
          try { await diag.log('run_state_error', `續跑 ${key}：${String(err?.message || err)}`) } catch {}
        }))
      } else {
        await run
      }
      continue
    }
    if (task) {
      // 不寫帳本（寫了補抓就會被冪等擋掉）、不動 lastValues；燈號要紅
      const record = {
        taskId,
        slot,
        capturedAt: new Date().toISOString(),
        status: 'interrupted',
        error: '上一次執行被瀏覽器中斷'
      }
      await appendRecord(slot.slice(0, 10), record)
      await updateHealth(taskId, healthFromRecords([record]))
      // 設定頁的「被中斷」次數改從 diag 數，不再掃 7 天紀錄；這是罕見事件，不會洗掉環形緩衝
      try { await diag.log('interrupted', `${taskId}@${slot}`) } catch {}
      if (task.schedule?.type === 'daily') {
        await updateMissedList((list) => {
          if (list.some(m => m?.taskId === taskId && m?.slot === slot)) return undefined
          return [...list, { taskId, taskName: task.name || taskId, slot }]
            .sort((x, y) => String(x.slot).localeCompare(String(y.slot)) || String(x.taskId).localeCompare(String(y.taskId)))
        })
      }
    }
  }
  return resumed
}

// 清掉「找不到元素」的連續次數與前景建議（抓到了就歸零）；鎖內讀最新任務，沒有要清的就不寫
async function clearNotFoundStreak(taskId) {
  await updateTasks([taskId], (t) => {
    if (!((t.notFoundStreak || 0) > 0 || t.suggestForeground)) return null
    t.notFoundStreak = 0
    delete t.suggestForeground
    return t
  })
}

// 排定重試 alarm
async function scheduleRetry(taskId, attempt, isOffline = false, slot = '') {
  const delayMs = isOffline ? 10 * 60 * 1000 : (attempt === 1 ? 2 * 60 * 1000 : 10 * 60 * 1000)
  // 名稱帶上原始排程槽,重試補的才是同一格(冪等帳本與樞紐表都靠 slot)
  const suffix = slot ? `@${slot}` : ''
  await chrome.alarms.create(`${taskId}:retry:${attempt}${suffix}`, { when: Date.now() + delayMs })
}

// 解析重試 alarm 名稱（格式：<taskId>:retry:<n>；名稱在 scheduleRetry 組，解析也只有這一份：main 與看門狗共用）
export function parseRetryName(name) {
  if (typeof name !== 'string') return null
  // 名稱可能帶原始排程槽:<taskId>:retry:<n>@<slot>
  let slot = ''
  const at = name.lastIndexOf('@')
  if (at !== -1) {
    slot = name.slice(at + 1)
    name = name.slice(0, at)
  }
  const lastColon = name.lastIndexOf(':')
  if (lastColon === -1) return null
  const attemptStr = name.slice(lastColon + 1)
  if (!/^\d+$/.test(attemptStr)) return null
  const before = name.slice(0, lastColon)
  const secondColon = before.lastIndexOf(':')
  if (secondColon === -1) return null
  if (before.slice(secondColon + 1) !== 'retry') return null
  const taskId = before.slice(0, secondColon)
  if (!taskId) return null
  return { taskId, attempt: Number(attemptStr), slot }
}

// 取得本地日期字串（YYYY-MM-DD）
function getLocalDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 評估告警並發送通知
async function processAlerts(record, cachedRecordsInRange) {
  if (!record || !record.taskId) return

  // 1. 取任務：沒有 alerts 或空陣列直接返回
  const task = await getTask(parentIdOf(record.taskId))
  if (!task || !Array.isArray(task.alerts) || task.alerts.length === 0) {
    return
  }

  const sIndex = buildSeriesIndex([task])
  const displayName = nameOf(sIndex, record.taskId)

  // 2. 取先前紀錄當 prevRecords：今天與前 6 天（共 7 天）
  const today = (typeof record.slot === 'string' && record.slot.length >= 10)
    ? record.slot.slice(0, 10)
    : getLocalDateStr(new Date())

  let recordsInRange = cachedRecordsInRange
  if (!recordsInRange) {
    const [y, m, d] = today.split('-').map(Number)
    const pastDate = new Date(y, m - 1, d - 6, 12, 0, 0)
    const fromDate = getLocalDateStr(pastDate)
    recordsInRange = await getRecordsInRange(fromDate, today)
  }

  // 本筆還沒寫入，所以範圍查詢不會包含它；只要挑出同一任務、由舊到新即可
  const prevRecords = recordsInRange
    .filter(r => r.taskId === record.taskId)
    .sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''))

  // 3. 評估告警
  const { hits } = evaluateAlerts(task, record, prevRecords, displayName)
  if (!Array.isArray(hits) || hits.length === 0) {
    return
  }

  // 4. hits 非空時標記紀錄
  record.alert = true
  record.alertHits = hits.map(h => h.alertId)

  // 5. 去重與通知：冷卻判斷與蓋章在 alertLog 鎖內一起做（同時兩筆命中不會各通知一次）；
  //    通知在鎖外發（notify 可能寫診斷，鎖不巢狀）
  const settings = await getSettings()
  const cooldownMin = typeof settings?.alertCooldownMin === 'number' ? settings.alertCooldownMin : 60
  const cooldownMs = cooldownMin * 60 * 1000
  const now = Date.now()

  let toNotify = []
  await updateAlertLog((alertLog) => {
    const taskAlerts = alertLog[record.taskId] ? { ...alertLog[record.taskId] } : {}
    toNotify = hits.filter((hit) => {
      const lastNotified = taskAlerts[hit.alertId]
      return !(typeof lastNotified === 'number' && (now - lastNotified) < cooldownMs)
    })
    if (toNotify.length === 0) return undefined
    for (const hit of toNotify) taskAlerts[hit.alertId] = now
    alertLog[record.taskId] = taskAlerts
    return alertLog
  })

  for (const hit of toNotify) {
    const notificationId = `${record.taskId}:alert:${hit.alertId}:${today}`
    const title = `AutoFetcher: ${displayName}`
    await notify(notificationId, { title, message: hit.message })
  }
}

// 由這一次抓到的紀錄們決定任務的健康狀態（單值就是一筆，多值是整組）。
// 紀錄狀態轉 health 狀態的對應只算這一次，散在多處就會各自漂。
export function healthFromRecords(records, partial) {
  const list = Array.isArray(records) ? records : []
  const failed = list.filter(r => !isSuccess(r))
  if (list.length > 0 && failed.length === list.length) {
    // 取出現次數最多的那個錯誤：三個值裡兩個找不到元素，就該報找不到元素
    const counts = new Map()
    for (const r of failed) counts.set(r.status, (counts.get(r.status) || 0) + 1)
    const topStatus = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const first = failed.find(r => r.status === topStatus) || failed[0]
    return {
      status: healthStatusOf(first.status),
      reason: list.length > 1 ? `${failed.length} 個值抓不到` : undefined,
      detail: first.error || first.raw || ''
    }
  }
  if (failed.length > 0) {
    return { status: 'partial', reason: `${failed.length} 個值抓不到`, detail: undefined }
  }
  if (partial === true || list.some(r => r.partial === true)) {
    return { status: 'partial', reason: undefined, detail: undefined }
  }
  const warned = list.find(r => r.status === 'fallback') || list.find(r => r.status === 'late')
  return { status: warned ? warned.status : 'ok', reason: undefined, detail: undefined }
}

// 更新任務健康狀態並重整圖示
async function updateHealth(taskId, healthObj) {
  await setTaskHealth(taskId, healthObj)
  await refreshBadge()
}

// 紀錄裡 raw 的上限（AF-21 定案 5）：只在寫紀錄這一層截，擷取端與立即測試預覽照舊回全文
const RECORD_RAW_MAX = 500

// 寫紀錄前的瘦身：snippet 不進紀錄；raw 字串超過上限截斷並標 rawTruncated
function slimRecord(record) {
  const out = { ...record }
  delete out.snippet
  if (typeof out.raw === 'string' && out.raw.length > RECORD_RAW_MAX) {
    out.raw = out.raw.slice(0, RECORD_RAW_MAX)
    out.rawTruncated = true
  }
  return out
}

// 整組紀錄裡有沒有成功的值（多值任務的「寫入成功紀錄」）
function hasAnySuccess(records) {
  return records.some(r => isSuccess(r))
}

// 寫入抓取紀錄並更新帳本與 health
async function writeRecord(input, opts = {}) {
  const { parentId, skipLedger } = opts
  const record = slimRecord(input)
  await processAlerts(record)
  await appendRecord(record.slot.slice(0, 10), record)
  if (!skipLedger) {
    await setRunStatus(parentId, record.slot, record.status)
  }
  await updateHealth(parentId, healthFromRecords([record], record.partial))
  // popup 顯示「最後值」讀的是 lastValues；失敗的紀錄不覆蓋上一次成功的值
  if (isSuccess(record)) {
    await setLastValue(record.taskId, { value: record.value, capturedAt: record.capturedAt })
    // 恢復正常：清掉失敗通知的冷卻，下次再壞會重新通知
    await clearNotifyLog(parentId)
  }
  return record
}

// 多來源遇到擷取前的整體故障時，仍按宣告的 field 形狀留下完整結果。
// 這條入口與成功／部分成功的 appendRecords 路徑共用帳本、health 與告警語意，
// 避免離線、登入失敗或外層例外只留下父任務一筆而讓子序列看似沒有結果。
async function writeMultiFailureRecords(task, slot, status, error, opts = {}) {
  const sources = normalizeTaskSources(task)
  if (sources.length === 0) {
    return await writeRecord({
      taskId: task.id, slot, capturedAt: new Date().toISOString(), status, error
    }, { parentId: task.id, skipLedger: opts.skipLedger === true })
  }
  const capturedAt = new Date().toISOString()
  const records = sources.map((field) => ({
    taskId: seriesIdOf(task.id, field.key),
    slot,
    capturedAt,
    status,
    error
  }))
  const date = typeof slot === 'string' && slot.length >= 10
    ? slot.slice(0, 10)
    : getLocalDateStr(new Date())
  const [y, m, d] = date.split('-').map(Number)
  const pastDate = new Date(y, m - 1, d - 6, 12, 0, 0)
  const fromDate = getLocalDateStr(pastDate)
  const recordsInRange = await getRecordsInRange(fromDate, date)
  for (const record of records) await processAlerts(record, recordsInRange)
  await appendRecords(date, records.map(slimRecord))
  if (opts.skipLedger !== true) await setRunStatus(task.id, slot, status)
  await updateHealth(task.id, healthFromRecords(records, false))
  return records[0]
}

function multiFailureResult(task, status, error) {
  const fields = {}
  for (const field of normalizeTaskSources(task)) {
    const key = field?.key || `field-${Object.keys(fields).length}`
    fields[key] = { ok: false, error: status, message: error }
  }
  return { ok: false, error: status, message: error, fields }
}

// 執行任務的主要入口函式
export async function runTask(task, opts = {}) {
  const {
    slot = slotOf(Date.now()),
    reason = 'scheduled',
    attempt = 1,
    pollMs = 250,
    loadTimeoutMs = 30000,
    extractTimeoutMs = 15000,
    // 捲動到可視區只是捲動，不該比擷取還久
    scrollTimeoutMs = 10000,
    // 存活重試的間隔（AF-13）。探針顯示 150ms 一次就夠，這個額度很寬。
    // **與排程層的重試是兩件事**：那是「這一輪失敗，隔一段時間整個重跑」，
    // 這是「同一次執行內，文件被換掉就再抓一次」，兩者各自計數。
    reviveDelaysMs = [300, 600, 1200],
    // 總時限、續命間隔、單步上限：只給測試縮短，正式呼叫不傳
    budgetBaseMs,
    budgetMaxMs,
    keepAliveMs,
    preActionStepMaxMs = PRE_ACTION_STEP_MAX_MS,
    dryRun = false
  } = opts
  const isManual = reason === 'manual'
  const isMulti = task?.mode === 'multi' || task?.spec?.mode === 'multi'

  let extraDelayMs
  if (opts.extraDelayMs !== undefined) {
    extraDelayMs = opts.extraDelayMs
  } else if (typeof task?.extraDelaySec === 'number') {
    extraDelayMs = task.extraDelaySec * 1000
  } else {
    const settings = await getSettings()
    extraDelayMs = typeof settings?.extraDelaySec === 'number' ? settings.extraDelaySec * 1000 : 3000
  }

  // 1. 冪等檢查：已在帳本中則直接返回 null（dryRun 與手動抓取略過）
  if (!dryRun && !isManual) {
    if (await getRunStatus(task.id, slot)) return null
  }

  // 2. 離線檢查：若離線則排 10 分鐘後重試，不得開分頁
  if (globalThis.navigator?.onLine === false) {
    if (dryRun) return isMulti ? multiFailureResult(task, 'offline', '目前離線') : { ok: false, error: 'offline' }
    // 手動抓取一律不重試，但要留一筆看得到的紀錄，否則使用者按了沒有任何反應
    if (isManual) {
      if (isMulti) {
        return await writeMultiFailureRecords(task, slot, 'error', '目前離線', { skipLedger: true })
      }
      return await writeRecord({
        taskId: task.id,
        slot,
        capturedAt: new Date().toISOString(),
        status: 'error',
        error: '目前離線'
      }, { parentId: task.id, skipLedger: true })
    }
    // 重試也有上限：沒有上限的話 alarm 會自己無限接力下去，一直離線就永遠不留紀錄
    if (attempt < 3) {
      await scheduleRetry(task.id, attempt, true, slot)
      return null
    }
    if (isMulti) {
      return await writeMultiFailureRecords(task, slot, 'error', '目前離線')
    }
    return await writeRecord({
      taskId: task.id,
      slot,
      capturedAt: new Date().toISOString(),
      status: 'error',
      error: '目前離線'
    }, { parentId: task.id })
  }

  // 同站台串行佇列執行
  const origin = getOrigin(task.url)
  // 進佇列前記下開始時刻（runState 的 at）；遲到與否由呼叫端以 markLate 決定
  const startedMs = Date.now()
  const tracked = !dryRun && !isManual
  const lateRun = opts.markLate === true
  // 排隊中／執行中登記在 session.runState（手動與試抓不登記）：worker 被回收時留下痕跡，下一個 worker 才復原得了
  const runKey = tracked ? runStateKeyOf(task.id, slot) : null
  if (runKey) await putRunState(runKey, { state: 'queued', at: startedMs, boot: BOOT, attempt, reason })
  try {
    return await enqueueForOrigin(origin, async (queueCtx) => {
      // 前置動作的逐步軌跡：立即測試要說得出「hover 有做、是 click 沒點到」，
      // 只回一句「成功」的話，使用者在調 hover 選單時完全沒有線索
      const preActionTrace = []
      // 單步上限的註明：成功的紀錄也要帶（排程抓取沒有軌跡可看）
      const capNotes = []
      // 分頁 id 與框架定位結果在 try 外面宣告：最外層的 catch 要用它們組診斷包
      // （讀分頁實際網址；框架其實找到了、是擷取階段斷線，診斷包不能長得跟「找不到框架」一樣）
      let tabId
      let loc = null
      let restoreForeground = null
      let acquiredTab = false
      let reusedPreActions = false
      const hasPreActions = Array.isArray(task.preActions) && task.preActions.length > 0
      // 佇列中再次確認冪等，防止併發重複執行（dryRun 與手動抓取略過）
      if (!dryRun && !isManual) {
        if (await getRunStatus(task.id, slot)) return null
      }

      // 3. 開始執行：runState 改成 running 並呼叫延壽 API
      if (runKey) await markRunState(runKey, 'running')
      await chrome.runtime.getPlatformInfo()

      // 總時限從輪到自己才開始算（排隊的時間不算）。**不用 Promise.race 包整段**：
      // 被拋下的那段會繼續跑、晚一點又寫一次紀錄。改成每個主要步驟開始前檢查，
      // 每個等待的上限取「自己的逾時」與「剩餘時間」較小者，超過就丟與逾時同類的錯誤走既有失敗處理。
      const budgetMs = runBudgetMsOf(task, { baseMs: budgetBaseMs, maxMs: budgetMaxMs, stepMaxMs: preActionStepMaxMs })
      const deadlineAt = Date.now() + budgetMs
      const remaining = () => Math.max(0, deadlineAt - Date.now())
      const within = (ms) => Math.min(ms, remaining())
      const checkDeadline = () => {
        if (Date.now() >= deadlineAt) throw deadlineError(budgetMs)
      }
      const pause = async (ms) => {
        await keepAliveSleep(within(ms), { intervalMs: keepAliveMs })
      }
      // 送訊息：逾時取較小者；是被總時限截短而逾時的，改丟總時限錯誤
      const send = async (message, frameId, ownMs, label) => {
        const ms = within(ownMs)
        try {
          return await sendToFrame(tabId, message, frameId, ms, label)
        } catch (err) {
          if (err?.afTimeout && ms < ownMs) throw deadlineError(budgetMs)
          throw err
        }
      }
      // 框架定位：輪詢逾時與探測逾時都取較小者；被總時限截斷的失敗不得記成「找不到框架」
      const locate = async (frame, locator, ownMs) => {
        const found = await locateFrame(tabId, frame, locator, {
          pollMs,
          timeoutMs: within(ownMs),
          probeTimeoutMs: within(opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS)
        })
        if (!frameFound(found) && Date.now() >= deadlineAt) throw deadlineError(budgetMs)
        return found
      }
      // 開頁、等載入的上限也跟著剩餘時間走
      const loadMs = () => within(loadTimeoutMs)

      try {
        // 取得分頁：指定分頁存在則用、否則開前景分頁或走專用抓取分頁
        checkDeadline()
        let tab = null
        if (opts.tabId !== undefined && opts.tabId !== null) {
          try {
            tab = await chrome.tabs.get(opts.tabId)
          } catch {}
        }

        // 前景抓取開不起來(沒有任何一般視窗)就退回背景那條路,不讓整次抓取失敗
        let fg = null
        if (!(tab && sameOriginPath(tab.url, task.url)) && task.foreground === true) {
          try {
            fg = await openForegroundTab(task.url, { pollMs, loadTimeoutMs: loadMs() })
          } catch {}
        }

        // 這次有沒有真的載入頁面:沿用同一頁時不必再等一次「額外等待秒數」
        let pageLoaded = true
        if (tab && sameOriginPath(tab.url, task.url)) {
          tabId = tab.id
          await waitTabReady(tabId, { pollMs, loadTimeoutMs: loadMs() })
        } else if (fg !== null) {
          tabId = fg.tabId
          restoreForeground = fg.restore
        } else {
          const loadsBefore = queueCtx.fetchTab?.loads
          // 同一頁、同一組前置動作、而且那之後頁面沒被換掉 → 前置動作留下的狀態就是這個任務要的:
          // 不重載、不重跑,一個分頁接著抓(使用者定案:同一頁的值一次抓完)。
          // 頁面有沒有被換掉只看入口的載入次數 `loads`(前置動作可能把網址導去別處,不能比網址)。
          const preSig = hasPreActions ? JSON.stringify(task.preActions) : null
          const applied = queueCtx.preApplied
          let canKeep = preSig !== null && applied?.sig === preSig && sameOriginPath(applied.url, task.url)
          const freshLoad = !canKeep && (queueCtx.pageDirty === true || hasPreActions)
          tabId = await acquireFetchTab(queueCtx, task.url, { pollMs, loadTimeoutMs: loadMs(), freshLoad, keepPage: canKeep })
          if (canKeep && queueCtx.fetchTab?.loads !== applied.loads) {
            // 做完前置動作之後頁面被換過(中間插進來的站台檢查導去登入頁、或被卸載而重載當下的網址):
            // 前置動作的狀態沒了——回到任務網址重跑
            tabId = await acquireFetchTab(queueCtx, task.url, { pollMs, loadTimeoutMs: loadMs(), freshLoad: true })
            canKeep = false
          }
          reusedPreActions = canKeep
          if (!reusedPreActions) {
            queueCtx.pageDirty = false
            queueCtx.preApplied = null
          }
          acquiredTab = true
          pageLoaded = queueCtx.fetchTab?.loads !== loadsBefore
        }

        checkDeadline()
        if (pageLoaded && extraDelayMs > 0) await pause(extraDelayMs)

        // 8. 確認登入狀態（若停留在登入頁則執行自動登入）
        checkDeadline()
        const login = await ensureLoggedIn(tabId, task, { pollMs, loadTimeoutMs, extraDelayMs, deadlineAt })
        // 登入流程填了表單、換了頁,入口的載入次數量不到它:自己標記頁面被動過。
        // 本來打算沿用前置動作狀態的(session 剛好在兩個任務之間過期),回任務網址重跑。
        if (login?.attempted === true && acquiredTab) {
          queueCtx.pageDirty = true
          queueCtx.preApplied = null
          if (reusedPreActions && login.ok === true) {
            tabId = await acquireFetchTab(queueCtx, task.url, { pollMs, loadTimeoutMs: loadMs(), freshLoad: true })
            queueCtx.pageDirty = false
            reusedPreActions = false
            if (extraDelayMs > 0) await pause(extraDelayMs)
          }
        }
        if (login?.ok !== true) {
          // 登入途中被總時限截斷的，記成超過時限（走重試），不記成登入失敗
          checkDeadline()
          if (dryRun) return isMulti ? multiFailureResult(task, 'login_failed', login?.reason || '無法登入') : { ok: false, error: 'login_failed' }
          if (isMulti) {
            return await writeMultiFailureRecords(task, slot, 'login_failed', login?.reason || '無法登入', { skipLedger: isManual })
          }
          return await writeRecord({
            taskId: task.id,
            slot,
            capturedAt: new Date().toISOString(),
            status: 'login_failed',
            error: login?.reason || '無法登入'
          }, { parentId: task.id, skipLedger: isManual })
        }

        // 9. 注入 content script（必須在送訊息之前）
        await injectContent(tabId)

        // 執行前置動作（若有指定）：一次一個，各自定位自己的 frame。
        // 「先點按鈕，iframe 才出現」是常見情境，整批送給同一個 frame 一定失敗。
        const ranPreActions = hasPreActions && !reusedPreActions
        if (ranPreActions) {
          // 同站台共用分頁，前一個任務的點擊會留在頁面上，開關型按鈕第二次按會收回去；
          // 中途失敗也算按過，所以在迴圈前就標記、做完才記下「哪一組做好了」
          if (acquiredTab) {
            queueCtx.pageDirty = true
            queueCtx.preApplied = null
          }
          for (let i = 0; i < task.preActions.length; i++) {
            const action = task.preActions[i]
            checkDeadline()
            const startedAt = Date.now()
            if (action?.type === 'wait') {
              // 執行時上限：使用者存的值不改，超過照上限跑並在軌跡／紀錄註明
              const step = capStepMs(waitMsOf(action), preActionStepMaxMs)
              if (step.ms > 0) await pause(step.ms)
              const entry = { step: i + 1, type: 'wait', ok: true, ms: Date.now() - startedAt }
              if (step.capped) {
                entry.error = PRE_ACTION_STEP_CAP_NOTE
                capNotes.push(`前置動作第 ${i + 1} 步：${PRE_ACTION_STEP_CAP_NOTE}`)
              }
              preActionTrace.push(entry)
              continue
            }
            // hover 的停留由 content 照上限跑；這裡只負責註明
            const holdCapped = action?.type === 'hover' && capStepMs(holdMsOf(action), preActionStepMaxMs).capped
            if (holdCapped) capNotes.push(`前置動作第 ${i + 1} 步：${PRE_ACTION_STEP_CAP_NOTE}`)
            const actionTimeout = action?.type === 'waitFor'
              ? timeoutMsOf(action)
              : (opts.frameTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
            let actionLoc = await locate(action?.frame, action?.locator, actionTimeout)
            // `locateFrame` 失敗時回的是帶候選清單的物件（診斷用），判定一律看有沒有 frameId
            if (!frameFound(actionLoc)) {
              preActionTrace.push({ step: i + 1, type: action?.type, ok: false, ms: Date.now() - startedAt })
              throw new Error(preActionFailure(i, action, 'frame_not_found'))
            }
            // 前置動作自己也可能「送不到」：前一步的點擊讓頁面換掉，這一步就打中將死的文件
            // （SPEC §4 推薦的「點擊切頁籤 → 等元素出現」正是這種）。
            // **只有 `waitFor` 可以重送**——它只觀察不動頁面；`hover`／`click` 有副作用，
            // 重放就是再按一次，所以只能停下來用中文說清楚。
            // 沒有逾時的話，回應一旦跟著換掉的文件消失，整個抓取會吊到 service worker 被回收；
            // 逾時值必須涵蓋動作自己需要的時間（`messageTimeoutMs`，唯一一份）。
            const resendable = action?.type === 'waitFor'
            const preAttempts = resendable ? 1 + reviveDelaysMs.length : 1
            let preRes = null
            let preLiveErr = null
            for (let pa = 0; pa < preAttempts; pa++) {
              if (pa > 0) {
                await pause(reviveDelaysMs[pa - 1])
                checkDeadline()
                const again = await locate(action?.frame, action?.locator, actionTimeout)
                if (!frameFound(again)) break
                actionLoc = again
              }
              try {
                await injectContent(tabId, { frameId: actionLoc.frameId })
                preRes = await send({
                  type: MSG.RUN_PRE_ACTIONS,
                  actions: [action]
                }, actionLoc.frameId, opts.preActionTimeoutMs ?? messageTimeoutMs(action), 'Pre-action')
                preLiveErr = null
                break
              } catch (err) {
                if (err?.afDeadline) {
                  preActionTrace.push({ step: i + 1, type: action?.type, ok: false, ms: Date.now() - startedAt })
                  throw err
                }
                if (err?.afTimeout) {
                  preActionTrace.push({ step: i + 1, type: action?.type, ok: false, ms: Date.now() - startedAt })
                  throw new Error(preActionFailure(i, action, 'no_response'))
                }
                preLiveErr = err
              }
            }
            if (preLiveErr !== null) {
              preActionTrace.push({ step: i + 1, type: action?.type, ok: false, ms: Date.now() - startedAt })
              // 原文留給診斷（與擷取那條同一個鍵），使用者看的是說得出怎麼辦的中文
              try { await diag.log('fetch_page_gone', `「${task.name}」${String(preLiveErr?.message || preLiveErr)}`) } catch {}
              throw new Error(preActionFailure(i, action, 'page_gone'))
            }
            if (preRes?.ok !== true) {
              preActionTrace.push({ step: i + 1, type: action?.type, ok: false, ms: Date.now() - startedAt })
              // 訊息要說得出「第幾步、哪一種動作、怎麼了」，使用者才知道要調哪一列
              throw new Error(preActionFailure(i, action, contentErrorText(preRes)))
            }
            const doneEntry = { step: i + 1, type: action?.type, ok: true, ms: Date.now() - startedAt }
            if (holdCapped) doneEntry.error = PRE_ACTION_STEP_CAP_NOTE
            preActionTrace.push(doneEntry)
          }
          if (acquiredTab) {
            queueCtx.preApplied = { sig: JSON.stringify(task.preActions), url: task.url, loads: queueCtx.fetchTab?.loads }
          }
        }

        // 前置動作跑完之後再等一次「額外等待秒數」（AF-13）：
        // 前置動作的點擊常常讓頁面換頁，擷取若趕在導覽生效前打中**舊文件**，
        // 而 locator 剛好在舊頁面上匹配得到，就會回一個成功的錯誤值靜靜寫進紀錄——那比看到錯誤更糟。
        // **這只是縮小窗口，不是關閉窗口**：真實瀏覽器實測，子框架導覽時分頁狀態全程 `complete`，
        // 沒有任何訊號能證明「頁面已經安定」。
        if (ranPreActions && extraDelayMs > 0) await pause(extraDelayMs)

        // 10. 取得目標並擷取：定位 → 注入 → 捲動 → 擷取，四步是一個整體。
        // 中間任何一步「送不到」都代表文件被換掉了（content script 隨舊文件一起消失），
        // 這時重新走一次就好；**逾時不重試**（那是頁面沒回應，重試只會把 15 秒乘以四），
        // **找不到框架也不重試**（`locateFrame` 自己已經輪詢到逾時才放棄）。
        // 前置動作留在這個區塊**外面**：它有副作用，重放就是把按鈕再按一次。
        let res
        let lastLiveErr = null
        if (isMulti) {
          // AF-22 E1：每個來源都是獨立的定位／注入／擷取單位；共用前置動作已在上方只執行一次。
          // 來源失敗只填自己的 field，不能退回 task.locator 或用第一個來源的結果遮住其他值。
          const fields = {}
          const sourceFields = normalizeTaskSources(task)
          let retryWholeTask = false
          for (const field of sourceFields) {
            const key = field?.key
            let fieldRes = null
            let fieldLoc = null
            let fieldLiveErr = null
            if (typeof key !== 'string' || key.length === 0 || !field?.source?.locator) {
              fields[key || `field-${Object.keys(fields).length}`] = {
                ok: false, error: 'invalid_source', message: '多來源欄位缺少有效來源'
              }
              continue
            }
            const maxFieldAttempts = 1 + reviveDelaysMs.length
            for (let a = 0; a < maxFieldAttempts; a++) {
              if (a > 0) await pause(reviveDelaysMs[a - 1])
              checkDeadline()
              fieldLoc = await locate(field.source.frame, field.source.locator, opts.frameTimeoutMs ?? 20000)
              loc = fieldLoc
              if (!frameFound(fieldLoc)) {
                fieldRes = { ok: false, error: 'frame_not_found', message: '找不到目標所在的框架' }
                break
              }
              try {
                await injectContent(tabId, { frameId: fieldLoc.frameId })
                try {
                  await send({ type: MSG.SCROLL_INTO_VIEW, locator: field.source.locator }, fieldLoc.frameId, scrollTimeoutMs, 'Scroll')
                } catch (err) {
                  if (!err?.afTimeout || err.afDeadline) throw err
                }
                const extractMsg = { type: MSG.EXTRACT, locator: field.source.locator, spec: field.spec }
                if ((task.notFoundStreak || 0) >= 1) extractMsg.settleMs = 0
                fieldRes = await send(extractMsg, fieldLoc.frameId, extractTimeoutMs, 'Extract')
                fieldLiveErr = null
                break
              } catch (err) {
                if (err?.afDeadline) throw err
                // 一個 field 的 message timeout 不應中斷同批其他來源；文件通訊錯誤則在本 field 內有界重試。
                if (err?.afTimeout) {
                  fieldRes = { ok: false, error: 'timeout', message: String(err?.message || '擷取逾時') }
                  fieldLiveErr = null
                  break
                }
                fieldLiveErr = err
              }
            }
            if (!fieldRes) {
              const raw = String(fieldLiveErr?.message || fieldLiveErr || '擷取失敗')
              fieldRes = { ok: false, error: 'error', message: raw }
            }
            // all-field not_found 仍沿用任務層的有限 alarm retry；已有成功值時先完整寫下部分結果。
            if (fieldRes.ok !== true && fieldRes.error === 'not_found') retryWholeTask = true
            fields[key] = fieldRes
          }
          const fieldList = Object.values(fields)
          if (fieldList.length === 0) {
            res = { ok: false, error: 'invalid_multi', message: '多來源任務沒有可執行欄位' }
          } else {
            const anySuccess = fieldList.some(field => field?.ok === true)
            const anyFailure = fieldList.some(field => field?.ok !== true)
            res = { ok: true, fields, ...(anyFailure ? { partial: true } : {}) }
            if (!anySuccess && retryWholeTask && !isManual && attempt < 3) {
              await scheduleRetry(task.id, attempt, false, slot)
              return null
            }
          }
        } else {
          const maxAttempts = 1 + reviveDelaysMs.length
          for (let a = 0; a < maxAttempts; a++) {
            if (a > 0) await pause(reviveDelaysMs[a - 1])
            checkDeadline()
            loc = await locate(task.frame, task.locator, opts.frameTimeoutMs ?? 20000)
            if (!frameFound(loc)) break
            try {
              await injectContent(tabId, { frameId: loc.frameId })
              // 捲動到可視區是**盡力而為**：它逾時不代表擷取也會失敗，
              // 為它重試就是把 10 秒乘以四卡住同站台佇列，所以逾時就往下走，讓擷取自己去判定。
              // 但捲動「送不到」是另一回事——那是文件被換掉的訊號，要讓它往上冒出去觸發重試。
              try {
                await send({ type: MSG.SCROLL_INTO_VIEW, locator: task.locator }, loc.frameId, scrollTimeoutMs, 'Scroll')
              } catch (err) {
                // 總時限到了不算「盡力而為」的那種逾時
                if (!err?.afTimeout || err.afDeadline) throw err
              }
              // 已知找不到元素的任務不必每次再多等短等待（3 秒）：連一次都沒抓到過，等了也是白等
              const extractMsg = { type: MSG.EXTRACT, locator: task.locator, spec: task.spec }
              if ((task.notFoundStreak || 0) >= 1) extractMsg.settleMs = 0
              res = await send(extractMsg, loc.frameId, extractTimeoutMs, 'Extract')
              lastLiveErr = null
              break
            } catch (err) {
              if (err?.afTimeout) throw err
              lastLiveErr = err
            }
          }
          if (!frameFound(loc)) {
            if (dryRun) return { ok: false, error: 'frame_not_found', debug: await buildDebug(task, tabId, loc, preActionTrace, { error: 'frame_not_found' }) }
            return await writeRecord({
              taskId: task.id,
              slot,
              capturedAt: new Date().toISOString(),
              status: 'not_found',
              error: '找不到目標所在的框架'
            }, { parentId: task.id, skipLedger: isManual })
          }
          if (lastLiveErr !== null) {
            // 重試耗盡：標成「頁面沒了」，錯誤訊息在最外層的 catch 統一轉譯
            lastLiveErr.afPageGone = true
            throw lastLiveErr
          }
        }

        // 演練模式：直接回傳 content script 擷取回覆（附上前置動作做了哪幾步）
        if (dryRun) {
          const out = preActionTrace.length > 0 ? { ...res, preActionTrace } : { ...res }
          // 失敗才附診斷：成功時沒有人要看，白帶一份大字串。
          // **多值任務要看逐值結果**：表格解析得出來就是 ok:true，即使每個值都失敗（SPEC §7），
          // 只看 res.ok 的話，本輪主打的情境（多值表格試抓失敗）反而沒有匯出入口。
          const fieldsFailed = res?.fields && typeof res.fields === 'object'
            && Object.values(res.fields).some(f => f?.ok !== true)
          if (res?.ok !== true || fieldsFailed) {
            const page = res?.debug?.page
            delete out.debug
            out.debug = await buildDebug(task, tabId, loc, preActionTrace,
              { error: res?.error, message: res?.message }, page)
          }
          return out
        }

        // 結果處理：成功路徑
        if (res?.ok === true) {
          if (res.fields && typeof res.fields === 'object' && Object.keys(res.fields).length === 0) {
            // 任務宣告了多值卻一個值都沒有：不寫紀錄、不動帳本與燈號，當成設定沒做完
            return null
          }

          if (res.fields && typeof res.fields === 'object') {
            const date = (typeof slot === 'string' && slot.length >= 10)
              ? slot.slice(0, 10)
              : getLocalDateStr(new Date())
            const capturedAt = new Date().toISOString()
            const records = []

            for (const [key, r] of Object.entries(res.fields)) {
              const rec = {
                taskId: seriesIdOf(task.id, key),
                slot,
                capturedAt
              }
              if (r?.ok) {
                rec.value = r.value
                rec.raw = r.raw
                rec.status = (reason === 'late' || lateRun) ? 'late' : (r.status || 'ok')
                if (r.strategyUsed !== undefined) {
                  rec.strategyUsed = r.strategyUsed
                }
                if (r.layer !== undefined) {
                  rec.layer = r.layer
                }
                if (r.used !== undefined) {
                  rec.used = r.used
                }
                if (r.skipped !== undefined) {
                  rec.skipped = r.skipped
                }
                // 位置定位抓到的值要記下是哪一列：每天的最後一筆會變，
                // 光看數字看不出抓的是今天還是昨天那一列
                if (r.label !== undefined) {
                  rec.label = r.label
                }
                if (r.excluded !== undefined) {
                  rec.excluded = r.excluded
                }
                if (r.message !== undefined) {
                  rec.error = r.message
                }
              } else {
                rec.status = r?.error || 'error'
                if (r?.raw !== undefined) {
                  rec.raw = r.raw
                }
                if (r?.message !== undefined) {
                  rec.error = r.message
                }
              }
              if (res.partial === true) {
                rec.partial = true
              }
              if (capNotes.length > 0) {
                rec.error = [rec.error, ...capNotes].filter(Boolean).join('；')
              }
              records.push(slimRecord(rec))
            }

            // 告警評估：整組只讀一次 getRecordsInRange
            const [y, m, d] = date.split('-').map(Number)
            const pastDate = new Date(y, m - 1, d - 6, 12, 0, 0)
            const fromDate = getLocalDateStr(pastDate)
            const recordsInRange = await getRecordsInRange(fromDate, date)

            for (const rec of records) {
              await processAlerts(rec, recordsInRange)
            }

            // 批次寫入：整組紀錄只呼叫一次 appendRecords
            await appendRecords(date, records)

            // 帳本：整組只寫一次，用父任務 id（手動抓取不寫帳本）
            if (!isManual) {
              const hasSuccess = records.some(r => isSuccess(r))
              const firstFail = records.find(r => !isSuccess(r))
              const ledgerStatus = hasSuccess ? 'ok' : (firstFail ? firstFail.status : 'error')
              await setRunStatus(task.id, slot, ledgerStatus)
            }

            // lastValues：成功的值各自以子序列 id 寫入（整組一次寫完，不逐個讀寫）
            const lastEntries = {}
            for (const rec of records) {
              if (isSuccess(rec)) {
                lastEntries[rec.taskId] = { value: rec.value, capturedAt: rec.capturedAt }
              }
            }
            await setLastValues(lastEntries)

            // health：整個任務只寫一次，寫在父任務 id 上；狀態的算法與單值共用同一份
            const failCount = records.filter(r => !isSuccess(r)).length
            await updateHealth(task.id, healthFromRecords(records, res.partial))
            if (hasAnySuccess(records)) await clearNotifyLog(task.id)

            if (failCount === 0) {
              await clearNotFoundStreak(task.id)
            }

            // 設定頁的診斷要看得出這一次抓了幾個值、哪幾個沒抓到
            // 診斷頁是用字串串接顯示；環形緩衝只有 500 筆，全成功就不占位子（否則會把看門狗紀錄擠掉）
            const failedNames = records
              .filter(r => !isSuccess(r))
              .map(r => buildSeriesIndex([task]).byId[r.taskId]?.shortName || r.taskId)
            if (failedNames.length > 0) {
              await diag.log('fetch_fields', `「${task.name}」${records.length} 個值，失敗 ${failedNames.length}：${failedNames.join('、')}`)
            }

            const firstSuccess = records.find(r => isSuccess(r))
            return firstSuccess || records[0] || null
          }

          await clearNotFoundStreak(task.id)

          const status = (reason === 'late' || lateRun) ? 'late' : (res.status || 'ok')
          const record = {
            taskId: task.id,
            slot,
            capturedAt: new Date().toISOString(),
            value: res.value,
            raw: res.raw,
            status,
            strategyUsed: res.strategyUsed,
            layer: res.layer
          }

          if (res.used !== undefined) {
            record.used = res.used
          }
          if (res.skipped !== undefined) {
            record.skipped = res.skipped
          }
          if (res.label !== undefined) {
            record.label = res.label
          }
          if (res.excluded !== undefined) {
            record.excluded = res.excluded
          }
          if (res.message !== undefined) {
            record.error = res.message
          }
          if (capNotes.length > 0) {
            record.error = [record.error, ...capNotes].filter(Boolean).join('；')
          }
          if (res.partial === true) {
            record.partial = true
          }

          return await writeRecord(record, { parentId: task.id, skipLedger: isManual })
        }

        // multi 的格式／協調錯誤也要依 field 產生結果；不能回到單值父任務紀錄。
        if (isMulti) {
          const error = contentErrorText(res) || res?.message || '擷取失敗'
          if (dryRun) return multiFailureResult(task, res?.error || 'error', error)
          if (!isManual && attempt < 3) {
            await scheduleRetry(task.id, attempt, false, slot)
            return null
          }
          return await writeMultiFailureRecords(task, slot, res?.error || 'error', error, { skipLedger: isManual })
        }

        // 結果處理：元素未找到（可重試）
        if (res?.error === 'not_found') {
          if (!isManual && attempt < 3) {
            await scheduleRetry(task.id, attempt, false, slot)
            return null
          }

          if (!isManual) {
            // 重試用盡：更新 notFoundStreak，連兩次建議前台擷取
            await updateTasks([task.id], (t) => {
              const streak = (t.notFoundStreak || 0) + 1
              t.notFoundStreak = streak
              if (streak >= 2) t.suggestForeground = true
              return t
            })

            // 冷卻（同狀態 24 小時一次）＋同站台 5 分鐘內合併成一則（AF-21 批次 2 定案 8）
            await notifySiteFailure(origin, task, 'not_found')
          }

          return await writeRecord({
            taskId: task.id,
            slot,
            capturedAt: new Date().toISOString(),
            status: 'not_found',
            // 「標題找不到，改用位置定位」這種訊息要留在紀錄裡，
            // 只寫 not_found 的話使用者看到的永遠是同一句沒有解法的話
            ...(res.message !== undefined ? { error: res.message } : {})
          }, { parentId: task.id, skipLedger: isManual })
        }

        // 結果處理：解析錯誤（不重試，不得含 value 欄位）
        if (res?.error === 'parse_error') {
          return await writeRecord({
            taskId: task.id,
            slot,
            capturedAt: new Date().toISOString(),
            status: 'parse_error',
            raw: res.raw
          }, { parentId: task.id, skipLedger: isManual })
        }

        // 其他未知錯誤
        if (!isManual && attempt < 3) {
          await scheduleRetry(task.id, attempt, false, slot)
          return null
        }
        return await writeRecord({
          taskId: task.id,
          slot,
          capturedAt: new Date().toISOString(),
          status: 'error',
          error: contentErrorText(res) || '擷取失敗'
        }, { parentId: task.id, skipLedger: isManual })

      } catch (err) {
        // 存活重試耗盡才會走到這裡：把 Chrome 的英文原文換成說得出怎麼辦的中文，
        // **原文寫進診斷不丟掉**（除錯時找不到原文就等於什麼線索都沒有）。
        // 轉譯只能在這裡做一次：放進重試迴圈的話，每重試一次就把原文覆蓋一次。
        const raw = String(err?.message || err)
        let shown = raw
        if (err?.afPageGone === true) {
          shown = PAGE_GONE_MESSAGE
          try { await diag.log('fetch_page_gone', `「${task.name}」${raw}`) } catch {}
        }
        // 立即測試失敗時也要帶軌跡：使用者最需要知道的是「hover 有做、卡在第幾步」，
        // 只回一句錯誤訊息就是把軌跡丟掉
        if (dryRun) {
          if (isMulti) return multiFailureResult(task, 'error', shown)
          const out = { ok: false, error: shown }
          if (preActionTrace.length > 0) out.preActionTrace = preActionTrace
          out.debug = await buildDebug(task, tabId, loc, preActionTrace, { error: shown, raw })
          return out
        }
        if (!isManual && attempt < 3) {
          await scheduleRetry(task.id, attempt, false, slot)
          return null
        }
        if (isMulti) {
          return await writeMultiFailureRecords(task, slot, 'error', shown, { skipLedger: isManual })
        }
        return await writeRecord({
          taskId: task.id,
          slot,
          capturedAt: new Date().toISOString(),
          status: 'error',
          error: shown
        }, { parentId: task.id, skipLedger: isManual })
      } finally {
        if (restoreForeground) {
          try {
            await restoreForeground()
          } catch {}
        }
      }
    })
  } finally {
    // 不論成功、失敗、提早 return 或丟例外都移除自己那一項；移除失敗不得蓋掉抓取結果
    if (runKey) {
      try {
        await dropRunState(runKey)
      } catch (err) {
        try { await diag.log('run_state_error', `${runKey}：${String(err?.message || err)}`) } catch {}
      }
    }
  }
}
