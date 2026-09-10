// AutoFetcher 擷取流程：開分頁、注入、擷取、寫紀錄、重試
import { getTask, saveTask, appendRecord, appendRecords, getRecordsInRange, getSettings, getAlertLog, setAlertLog, setLastValue, setLastValues } from '../shared/storage.js'
import { waitMsOf, timeoutMsOf, preActionFailure, DEFAULT_WAIT_TIMEOUT_MS, messageTimeoutMs } from '../shared/preaction.js'
import { seriesIdOf, parentIdOf, buildSeriesIndex, nameOf } from '../shared/series-index.js'
import { MSG } from '../shared/messages.js'
import { slotOf } from './scheduler.js'
import { notify } from './notify.js'
import { injectContent } from './inject.js'
import { evaluateAlerts } from '../shared/alerts.js'
import { isSuccess, healthStatusOf } from '../shared/record-status.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { ensureLoggedIn } from './login.js'
import { locateFrame, sameOriginPath } from './frames.js'

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

// 我們自己丟的逾時要**帶得出身分**：判斷「該不該重試」不得比對 Chrome 的英文錯誤字串，
// 那串字會隨瀏覽器版本與語系變，比對它就是把契約押在別人的文案上（AF-13）。
function timeoutError(message) {
  const err = new Error(message)
  err.afTimeout = true
  return err
}

/**
 * 送訊息給 content，並且**一定要有逾時**。
 * 計時器贏了要清、輸了更要清：不清的話每送一次就留一個計時器吊著事件迴圈，
 * MV3 的 service worker 因此遲遲不能閒置回收（AF-12 發現，AF-13 把捲動與前置動作也納入）。
 */
function sendToFrame(tabId, message, frameId, timeoutMs, label) {
  let timer = null
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message, { frameId }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(`${label} timeout`)), timeoutMs)
    })
  ]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

// 解析 URL 取得 origin
function getOrigin(url) {
  try {
    return new URL(url).origin
  } catch {
    return url || ''
  }
}

// 讀取執行帳本（runs 鍵）
async function getLedger() {
  const res = await chrome.storage.local.get('runs')
  return res.runs || {}
}

// 寫入執行帳本（runs 鍵）
async function recordLedger(taskId, slot, status) {
  const runs = await getLedger()
  if (!runs[taskId]) runs[taskId] = {}
  runs[taskId][slot] = status
  await chrome.storage.local.set({ runs })
}

// 寫入 inflight 狀態至 storage.session
async function setInflight(key, stateObj) {
  const res = await chrome.storage.session.get('inflight')
  const inflight = res.inflight || {}
  inflight[key] = stateObj
  await chrome.storage.session.set({ inflight })
  if (Array.isArray(chrome?.__calls)) {
    chrome.__calls.push({ api: 'session.set', args: [{ inflight }] })
  }
}

// 清除 storage.session 中的 inflight 狀態
async function removeInflight(key) {
  const res = await chrome.storage.session.get('inflight')
  const inflight = res.inflight || {}
  delete inflight[key]
  await chrome.storage.session.set({ inflight })
  if (Array.isArray(chrome?.__calls)) {
    chrome.__calls.push({ api: 'session.set', args: [{ inflight }] })
  }
}

// 排定重試 alarm
async function scheduleRetry(taskId, attempt, isOffline = false, slot = '') {
  const delayMs = isOffline ? 10 * 60 * 1000 : (attempt === 1 ? 2 * 60 * 1000 : 10 * 60 * 1000)
  // 名稱帶上原始排程槽,重試補的才是同一格(冪等帳本與樞紐表都靠 slot)
  const suffix = slot ? `@${slot}` : ''
  await chrome.alarms.create(`${taskId}:retry:${attempt}${suffix}`, { when: Date.now() + delayMs })
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

  // 5. 去重與通知
  const alertLog = await getAlertLog()
  const settings = await getSettings()
  const cooldownMin = typeof settings?.alertCooldownMin === 'number' ? settings.alertCooldownMin : 60
  const cooldownMs = cooldownMin * 60 * 1000
  const now = Date.now()

  const taskAlerts = alertLog[record.taskId] ? { ...alertLog[record.taskId] } : {}
  let logChanged = false

  for (const hit of hits) {
    const lastNotified = taskAlerts[hit.alertId]
    if (typeof lastNotified === 'number' && (now - lastNotified) < cooldownMs) {
      continue
    }

    const notificationId = `${record.taskId}:alert:${hit.alertId}:${today}`
    const title = `AutoFetcher: ${displayName}`
    await notify(notificationId, { title, message: hit.message })

    taskAlerts[hit.alertId] = now
    logChanged = true
  }

  if (logChanged) {
    alertLog[record.taskId] = taskAlerts
    await setAlertLog(alertLog)
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

// 寫入抓取紀錄並更新帳本與 health
async function writeRecord(record, opts = {}) {
  const { parentId, skipLedger } = opts
  await processAlerts(record)
  await appendRecord(record.slot.slice(0, 10), record)
  if (!skipLedger) {
    await recordLedger(parentId, record.slot, record.status)
  }
  await updateHealth(parentId, healthFromRecords([record], record.partial))
  // popup 顯示「最後值」讀的是 lastValues；失敗的紀錄不覆蓋上一次成功的值
  if (isSuccess(record)) {
    await setLastValue(record.taskId, { value: record.value, capturedAt: record.capturedAt })
  }
  return record
}

// 同站台 Promise 佇列管理器
const originQueues = new Map()

// 同站台串行排隊執行
function enqueueForOrigin(origin, fn) {
  let entry = originQueues.get(origin)
  if (!entry) {
    entry = {
      chain: Promise.resolve(),
      pending: 0,
      createdTabs: new Set(),
      createdWindows: new Set()
    }
    originQueues.set(origin, entry)
  }
  entry.pending++

  const run = async () => {
    try {
      return await fn(entry)
    } finally {
      entry.pending--
      if (entry.pending === 0) {
        originQueues.delete(origin)
        for (const tabId of entry.createdTabs) {
          try { await chrome.tabs.remove(tabId) } catch {}
        }
        for (const winId of entry.createdWindows) {
          try { await chrome.windows.remove(winId) } catch {}
        }
      }
    }
  }

  const resultPromise = entry.chain.then(run, run)
  entry.chain = resultPromise.catch(() => {})
  return resultPromise
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
    dryRun = false
  } = opts
  const isManual = reason === 'manual'

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
    const ledger = await getLedger()
    if (ledger[task.id]?.[slot]) return null
  }

  // 2. 離線檢查：若離線則排 10 分鐘後重試，不得開分頁
  if (globalThis.navigator?.onLine === false) {
    if (dryRun) return { ok: false, error: 'offline' }
    // 手動抓取一律不重試，但要留一筆看得到的紀錄，否則使用者按了沒有任何反應
    if (isManual) {
      return await writeRecord({
        taskId: task.id,
        slot,
        capturedAt: new Date().toISOString(),
        status: 'error',
        error: '目前離線'
      }, { parentId: task.id, skipLedger: true })
    }
    await scheduleRetry(task.id, attempt, true, slot)
    return null
  }

  // 同站台串行佇列執行
  const origin = getOrigin(task.url)
  return enqueueForOrigin(origin, async (queueCtx) => {
    // 前置動作的逐步軌跡：立即測試要說得出「hover 有做、是 click 沒點到」，
    // 只回一句「成功」的話，使用者在調 hover 選單時完全沒有線索
    const preActionTrace = []
    // 分頁 id 在 try 外面宣告：最外層的 catch 要用它組診斷包（讀分頁實際網址）
    let tabId
    // 佇列中再次確認冪等，防止併發重複執行（dryRun 與手動抓取略過）
    if (!dryRun && !isManual) {
      const currentLedger = await getLedger()
      if (currentLedger[task.id]?.[slot]) return null
    }

    const inflightKey = `${task.id}:${slot}`
    // 3. 開始執行：寫入 session inflight 並呼叫延壽 API
    await setInflight(inflightKey, { state: 'running', startedAt: new Date().toISOString() })
    await chrome.runtime.getPlatformInfo()

    let originalTabId = null
    try {
      // 4. 視窗檢查：若目前無視窗則建立最小化視窗
      const windows = await chrome.windows.getAll()
      if (windows.length === 0) {
        const win = await chrome.windows.create({ state: 'minimized' })
        if (win?.id) queueCtx.createdWindows.add(win.id)
      }

      // 若為前景抓取，先記住目前作用中的分頁
      if (task.foreground === true) {
        try {
          const currentActive = await chrome.tabs.query({ active: true, currentWindow: true })
          if (Array.isArray(currentActive) && currentActive[0]?.id != null) {
            originalTabId = currentActive[0].id
          }
        } catch {}
      }

      // 5. 分頁檢查：指定分頁存在則直接用，無則沿用既有網址分頁或新建
      if (opts.tabId !== undefined && opts.tabId !== null) {
        try {
          const tab = await chrome.tabs.get(opts.tabId)
          // 那個分頁可能已經被使用者導去別的網站；讀它現在的網址核對過才用，
          // 否則會在不相干的頁面上定位與擷取（對不上就退回原本的找分頁流程）
          if (tab !== undefined && tab !== null && sameOriginPath(tab.url, task.url)) {
            tabId = tab.id
          }
        } catch {}
      }

      if (tabId === undefined) {
        const tabs = await chrome.tabs.query({ url: task.url })
        if (tabs.length > 0) {
          tabId = tabs[0].id
          if (task.foreground === true) {
            try {
              await chrome.tabs.update(tabId, { active: true })
            } catch {}
          }
        } else {
          const newTab = await chrome.tabs.create({
            url: task.url,
            active: task.foreground === true
          })
          tabId = newTab.id
          // `autoDiscardable` **不是 `tabs.create` 的屬性**，只有 `tabs.update` 吃它。
          // 放進 create 會讓整個呼叫被 Chrome 擋下（Unexpected property），
          // 等於「目標頁沒開著」的排程抓取一律失敗——開案就寫錯，AF-13 的煙霧測試才抓到。
          // 省電模式會卸載背景分頁，所以還是要設，只是要設在對的地方。
          try {
            await chrome.tabs.update(tabId, { autoDiscardable: false })
          } catch {}
          queueCtx.createdTabs.add(tabId)
        }
      }

      // 6. 檢查分頁是否已被丟棄，若是則重新載入
      let tabInfo = await chrome.tabs.get(tabId)
      if (tabInfo?.discarded === true) {
        await chrome.tabs.reload(tabId)
        tabInfo = await chrome.tabs.get(tabId)
      }

      // 7. 等候載入完成：每 pollMs 檢查一次，最多等 loadTimeoutMs（逾時不失敗）
      const loadStart = Date.now()
      while (tabInfo?.status !== 'complete' && Date.now() - loadStart < loadTimeoutMs) {
        await sleep(pollMs)
        tabInfo = await chrome.tabs.get(tabId)
      }
      if (extraDelayMs > 0) await sleep(extraDelayMs)

      // 8. 確認登入狀態（若停留在登入頁則執行自動登入）
      const login = await ensureLoggedIn(tabId, task, { pollMs, loadTimeoutMs, extraDelayMs })
      if (login?.ok !== true) {
        if (dryRun) return { ok: false, error: 'login_failed' }
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
      const ranPreActions = Array.isArray(task.preActions) && task.preActions.length > 0
      if (ranPreActions) {
        for (let i = 0; i < task.preActions.length; i++) {
          const action = task.preActions[i]
          const startedAt = Date.now()
          if (action?.type === 'wait') {
            const ms = waitMsOf(action)
            if (ms > 0) await sleep(ms)
            preActionTrace.push({ step: i + 1, type: 'wait', ok: true, ms: Date.now() - startedAt })
            continue
          }
          const actionTimeout = action?.type === 'waitFor'
            ? timeoutMsOf(action)
            : (opts.frameTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
          let actionLoc = await locateFrame(tabId, action?.frame, action?.locator, { pollMs, timeoutMs: actionTimeout })
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
              await sleep(reviveDelaysMs[pa - 1])
              const again = await locateFrame(tabId, action?.frame, action?.locator, { pollMs, timeoutMs: actionTimeout })
              if (!frameFound(again)) break
              actionLoc = again
            }
            try {
              await injectContent(tabId, { frameId: actionLoc.frameId })
              preRes = await sendToFrame(tabId, {
                type: MSG.RUN_PRE_ACTIONS,
                actions: [action]
              }, actionLoc.frameId, opts.preActionTimeoutMs ?? messageTimeoutMs(action), 'Pre-action')
              preLiveErr = null
              break
            } catch (err) {
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
            throw new Error(preActionFailure(i, action, preRes?.error))
          }
          preActionTrace.push({ step: i + 1, type: action?.type, ok: true, ms: Date.now() - startedAt })
        }
      }

      // 前置動作跑完之後再等一次「額外等待秒數」（AF-13）：
      // 前置動作的點擊常常讓頁面換頁，擷取若趕在導覽生效前打中**舊文件**，
      // 而 locator 剛好在舊頁面上匹配得到，就會回一個成功的錯誤值靜靜寫進紀錄——那比看到錯誤更糟。
      // **這只是縮小窗口，不是關閉窗口**：真實瀏覽器實測，子框架導覽時分頁狀態全程 `complete`，
      // 沒有任何訊號能證明「頁面已經安定」。
      if (ranPreActions && extraDelayMs > 0) await sleep(extraDelayMs)

      // 10. 取得目標並擷取：定位 → 注入 → 捲動 → 擷取，四步是一個整體。
      // 中間任何一步「送不到」都代表文件被換掉了（content script 隨舊文件一起消失），
      // 這時重新走一次就好；**逾時不重試**（那是頁面沒回應，重試只會把 15 秒乘以四），
      // **找不到框架也不重試**（`locateFrame` 自己已經輪詢到逾時才放棄）。
      // 前置動作留在這個區塊**外面**：它有副作用，重放就是把按鈕再按一次。
      let loc = null
      let res
      let lastLiveErr = null
      const maxAttempts = 1 + reviveDelaysMs.length
      for (let a = 0; a < maxAttempts; a++) {
        if (a > 0) await sleep(reviveDelaysMs[a - 1])
        loc = await locateFrame(tabId, task.frame, task.locator, { pollMs, timeoutMs: opts.frameTimeoutMs ?? 20000 })
        if (!frameFound(loc)) break
        try {
          await injectContent(tabId, { frameId: loc.frameId })
          // 捲動到可視區是**盡力而為**：它逾時不代表擷取也會失敗，
          // 為它重試就是把 10 秒乘以四卡住同站台佇列，所以逾時就往下走，讓擷取自己去判定。
          // 但捲動「送不到」是另一回事——那是文件被換掉的訊號，要讓它往上冒出去觸發重試。
          try {
            await sendToFrame(tabId, { type: MSG.SCROLL_INTO_VIEW, locator: task.locator }, loc.frameId, scrollTimeoutMs, 'Scroll')
          } catch (err) {
            if (!err?.afTimeout) throw err
          }
          res = await sendToFrame(tabId, { type: MSG.EXTRACT, locator: task.locator, spec: task.spec }, loc.frameId, extractTimeoutMs, 'Extract')
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

      // 演練模式：直接回傳 content script 擷取回覆（附上前置動作做了哪幾步）
      if (dryRun) {
        const out = preActionTrace.length > 0 ? { ...res, preActionTrace } : { ...res }
        // 失敗才附診斷：成功時沒有人要看，白帶一份大字串
        if (res?.ok !== true) {
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
              rec.status = reason === 'late' ? 'late' : (r.status || 'ok')
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
            records.push(rec)
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
            await recordLedger(task.id, slot, ledgerStatus)
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

          if (failCount === 0) {
            const currentTask = await getTask(task.id)
            if (currentTask && ((currentTask.notFoundStreak || 0) > 0 || currentTask.suggestForeground)) {
              currentTask.notFoundStreak = 0
              delete currentTask.suggestForeground
              await saveTask(currentTask)
            }
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

        const currentTask = await getTask(task.id)
        if (currentTask && ((currentTask.notFoundStreak || 0) > 0 || currentTask.suggestForeground)) {
          currentTask.notFoundStreak = 0
          delete currentTask.suggestForeground
          await saveTask(currentTask)
        }

        const status = reason === 'late' ? 'late' : (res.status || 'ok')
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
        if (res.partial === true) {
          record.partial = true
        }

        return await writeRecord(record, { parentId: task.id, skipLedger: isManual })
      }

      // 結果處理：元素未找到（可重試）
      if (res?.error === 'not_found') {
        if (!isManual && attempt < 3) {
          await scheduleRetry(task.id, attempt, false, slot)
          return null
        }

        if (!isManual) {
          // 重試用盡：更新 notFoundStreak，連兩次建議前台擷取
          const currentTask = (await getTask(task.id)) || { ...task }
          const streak = (currentTask.notFoundStreak || 0) + 1
          currentTask.notFoundStreak = streak
          if (streak >= 2) currentTask.suggestForeground = true
          await saveTask(currentTask)

          await notify(`${task.id}:not_found`, {
            title: `AutoFetcher: ${task.name}`,
            message: '擷取失敗：找不到目標元素'
          })
        }

        return await writeRecord({
          taskId: task.id,
          slot,
          capturedAt: new Date().toISOString(),
          status: 'not_found',
          snippet: res.snippet,
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
        error: String(res?.error || '擷取失敗')
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
        const out = { ok: false, error: shown }
        if (preActionTrace.length > 0) out.preActionTrace = preActionTrace
        out.debug = await buildDebug(task, tabId, null, preActionTrace, { error: shown, raw })
        return out
      }
      if (!isManual && attempt < 3) {
        await scheduleRetry(task.id, attempt, false, slot)
        return null
      }
      return await writeRecord({
        taskId: task.id,
        slot,
        capturedAt: new Date().toISOString(),
        status: 'error',
        error: shown
      }, { parentId: task.id, skipLedger: isManual })
    } finally {
      // 若有記錄前景抓取前作用中的分頁，將焦點還原
      if (originalTabId != null) {
        try {
          await chrome.tabs.update(originalTabId, { active: true })
        } catch {}
      }
      // 清除 inflight 狀態
      await removeInflight(inflightKey)
    }
  })
}
