// AutoFetcher 擷取流程：開分頁、注入、擷取、寫紀錄、重試
import { getTask, saveTask, appendRecord, appendRecords, getRecordsInRange, getSettings, getAlertLog, setAlertLog, setLastValue, setLastValues } from '../shared/storage.js'
import { seriesIdOf, parentIdOf, buildSeriesIndex, nameOf } from '../shared/series-index.js'
import { MSG } from '../shared/messages.js'
import { slotOf } from './scheduler.js'
import { notify } from './notify.js'
import { injectContent } from './inject.js'
import { evaluateAlerts } from '../shared/alerts.js'
import { isSuccess, healthStatusOf } from '../shared/record-status.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { ensureLoggedIn } from './login.js'
import * as diag from '../shared/diag.js'

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
        }, { parentId: task.id, skipLedger: isManual })
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
            } else {
              rec.status = r?.error || 'error'
              if (r?.raw !== undefined) {
                rec.raw = r.raw
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
          snippet: res.snippet
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
      if (dryRun) return { ok: false, error: String(err?.message || err) }
      if (!isManual && attempt < 3) {
        await scheduleRetry(task.id, attempt, false, slot)
        return null
      }
      return await writeRecord({
        taskId: task.id,
        slot,
        capturedAt: new Date().toISOString(),
        status: 'error',
        error: String(err?.message || err)
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
