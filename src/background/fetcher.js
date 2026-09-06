// AutoFetcher 擷取流程：開分頁、注入、擷取、寫紀錄、重試
import { getTask, saveTask, appendRecord, getRecordsInRange, getSettings, getAlertLog, setAlertLog, setLastValue, trimOldRecords } from '../shared/storage.js'
import { MSG } from '../shared/messages.js'
import { slotOf } from './scheduler.js'
import { notify } from './notify.js'
import { injectContent } from './inject.js'
import { evaluateAlerts } from '../shared/alerts.js'
import { isSuccess } from '../shared/record-status.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { ensureLoggedIn } from './login.js'

// 短暫等待輔助函式（非排程）
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
async function scheduleRetry(taskId, attempt, isOffline = false) {
  const delayMs = isOffline ? 10 * 60 * 1000 : (attempt === 1 ? 2 * 60 * 1000 : 10 * 60 * 1000)
  await chrome.alarms.create(`${taskId}:retry:${attempt}`, { when: Date.now() + delayMs })
}

// 取得本地日期字串（YYYY-MM-DD）
function getLocalDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 評估告警並發送通知
async function processAlerts(record) {
  if (!record || !record.taskId) return

  // 1. 取任務：沒有 alerts 或空陣列直接返回
  const task = await getTask(record.taskId)
  if (!task || !Array.isArray(task.alerts) || task.alerts.length === 0) {
    return
  }

  // 2. 取先前紀錄當 prevRecords：今天與前 6 天（共 7 天）
  const today = (typeof record.slot === 'string' && record.slot.length >= 10)
    ? record.slot.slice(0, 10)
    : getLocalDateStr(new Date())

  const [y, m, d] = today.split('-').map(Number)
  const pastDate = new Date(y, m - 1, d - 6, 12, 0, 0)
  const fromDate = getLocalDateStr(pastDate)

  const recordsInRange = await getRecordsInRange(fromDate, today)
  // 本筆還沒寫入，所以範圍查詢不會包含它；只要挑出同一任務、由舊到新即可
  const prevRecords = recordsInRange
    .filter(r => r.taskId === record.taskId)
    .sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''))

  // 3. 評估告警
  const { hits } = evaluateAlerts(task, record, prevRecords)
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

  const taskAlerts = alertLog[task.id] ? { ...alertLog[task.id] } : {}
  let logChanged = false

  for (const hit of hits) {
    const lastNotified = taskAlerts[hit.alertId]
    if (typeof lastNotified === 'number' && (now - lastNotified) < cooldownMs) {
      continue
    }

    const notificationId = `${task.id}:alert:${hit.alertId}:${today}`
    const title = `AutoFetcher: ${task.name}`
    await notify(notificationId, { title, message: hit.message })

    taskAlerts[hit.alertId] = now
    logChanged = true
  }

  if (logChanged) {
    alertLog[task.id] = taskAlerts
    await setAlertLog(alertLog)
  }
}

// 寫入抓取紀錄並更新帳本
async function writeRecord(record) {
  await processAlerts(record)
  await appendRecord(record.slot.slice(0, 10), record)
  await recordLedger(record.taskId, record.slot, record.status)
  // popup 顯示「最後值」讀的是 lastValues；失敗的紀錄不覆蓋上一次成功的值
  if (isSuccess(record)) {
    await setLastValue(record.taskId, { value: record.value, capturedAt: record.capturedAt })
  }
  // 保留天數是設定頁的偏好，總得有人真的去清
  try {
    await trimOldRecords(getLocalDateStr(new Date()))
  } catch {}
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
    dryRun = false
  } = opts

  let extraDelayMs
  if (opts.extraDelayMs !== undefined) {
    extraDelayMs = opts.extraDelayMs
  } else if (typeof task?.extraDelaySec === 'number') {
    extraDelayMs = task.extraDelaySec * 1000
  } else {
    const settings = await getSettings()
    extraDelayMs = typeof settings?.extraDelaySec === 'number' ? settings.extraDelaySec * 1000 : 3000
  }

  // 1. 冪等檢查：已在帳本中則直接返回 null（dryRun 略過）
  if (!dryRun) {
    const ledger = await getLedger()
    if (ledger[task.id]?.[slot]) return null
  }

  // 2. 離線檢查：若離線則排 10 分鐘後重試，不得開分頁
  if (globalThis.navigator?.onLine === false) {
    if (!dryRun) await scheduleRetry(task.id, attempt, true)
    return dryRun ? { ok: false, error: 'offline' } : null
  }

  // 同站台串行佇列執行
  const origin = getOrigin(task.url)
  return enqueueForOrigin(origin, async (queueCtx) => {
    // 佇列中再次確認冪等，防止併發重複執行（dryRun 略過）
    if (!dryRun) {
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

      // 5. 分頁檢查：已存在則沿用，無則建立分頁
      const tabs = await chrome.tabs.query({ url: task.url })
      let tabId
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
          active: task.foreground === true,
          autoDiscardable: false
        })
        tabId = newTab.id
        queueCtx.createdTabs.add(tabId)
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
        })
      }

      // 9. 注入 content script（必須在送訊息之前）
      await injectContent(tabId)

      // 執行前置動作（若有指定）
      if (Array.isArray(task.preActions) && task.preActions.length > 0) {
        const preRes = await chrome.tabs.sendMessage(tabId, {
          type: MSG.RUN_PRE_ACTIONS,
          actions: task.preActions
        })
        if (preRes?.ok !== true) {
          throw new Error(`前置動作失敗：${preRes?.error || '未知錯誤'}`)
        }
      }

      // 10. 擷取：先 SCROLL_INTO_VIEW，再 EXTRACT
      await chrome.tabs.sendMessage(tabId, { type: MSG.SCROLL_INTO_VIEW, locator: task.locator })

      const res = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT, locator: task.locator, spec: task.spec }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Extract timeout')), extractTimeoutMs))
      ])

      // 演練模式：直接回傳 content script 擷取回覆
      if (dryRun) return res

      // 結果處理：成功路徑
      if (res?.ok === true) {
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
        if (res.partial === true) {
          record.partial = true
          await setTaskHealth(task.id, { status: 'partial', reason: '只抓到部分', detail: '' })
          await refreshBadge()
        }

        return await writeRecord(record)
      }

      // 結果處理：元素未找到（可重試）
      if (res?.error === 'not_found') {
        if (attempt < 3) {
          await scheduleRetry(task.id, attempt, false)
          return null
        }

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

        return await writeRecord({
          taskId: task.id,
          slot,
          capturedAt: new Date().toISOString(),
          status: 'not_found',
          snippet: res.snippet
        })
      }

      // 結果處理：解析錯誤（不重試，不得含 value 欄位）
      if (res?.error === 'parse_error') {
        return await writeRecord({
          taskId: task.id,
          slot,
          capturedAt: new Date().toISOString(),
          status: 'parse_error',
          raw: res.raw
        })
      }

      // 其他未知錯誤
      if (attempt < 3) {
        await scheduleRetry(task.id, attempt, false)
        return null
      }
      return await writeRecord({
        taskId: task.id,
        slot,
        capturedAt: new Date().toISOString(),
        status: 'error',
        error: String(res?.error || '擷取失敗')
      })

    } catch (err) {
      if (dryRun) return { ok: false, error: String(err?.message || err) }
      if (attempt < 3) {
        await scheduleRetry(task.id, attempt, false)
        return null
      }
      return await writeRecord({
        taskId: task.id,
        slot,
        capturedAt: new Date().toISOString(),
        status: 'error',
        error: String(err?.message || err)
      })
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
