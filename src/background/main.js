// AutoFetcher MV3 Background Service Worker 入口總接線
import {
  init as initStorage, getTask, saveTask, getRecordsByDate,
  getPanelCtx, setPanelCtx, mergePanelCtx, clearPanelCtx,
  getSettings, subscribe, deleteLastValues
} from '../shared/storage.js'
import { pruneSeries } from '../shared/layout-store.js'
import { openPanel, closePanel } from '../shared/panel.js'
import { MSG } from '../shared/messages.js'
import * as diag from '../shared/diag.js'
import {
  rebuildAlarms,
  ensureWatchdog,
  slotOf,
  nextDailyRun,
  shouldRunInterval,
  nextIntervalRun,
  parseAlarmName
} from './scheduler.js'
import { runTask } from './fetcher.js'
import { refreshMissed, catchUpAll, skipAll, catchUpOne, skipOne } from './missed.js'
import { runWatchdog, selfCheck } from './watchdog.js'
import { refreshBadge, markRead } from './health.js'
import {
  schedulePrechecks,
  runPrecheck,
  parsePrecheckName
} from './precheck.js'
import { injectContent } from './inject.js'
import { locateFrame, listFrames, matchFrameByUrl } from './frames.js'
import { isAnchorText, putSkip } from '../shared/table.js'
import { pickSpecOf, reconcileFields } from '../shared/field-match.js'
import { withInnerLabel } from '../shared/describe.js'
import { scheduleSiteCheck, runSiteCheck } from './sitecheck.js'
import { isSuccess } from '../shared/record-status.js'
import { parentIdOf, buildSeriesIndex, nameOf, seriesIdOf } from '../shared/series-index.js'


// 重選時把選好的值寫回任務：沒動的值保留原本的 key 與名稱（紀錄靠 key），新值配新 key。
// 「是不是同一個值」的判定在 shared/field-match.js（Picker 換目標也用同一份）
const POS_NAMES = { first: '第一', last: '最後一', 'last-1': '倒數第二' }
// 能當定位錨點的標題才能拿來命名；純數值（4318 這種每天會變的值）退回下一層
function anchorOnly(header) {
  const text = typeof header === 'string' ? header.trim() : ''
  return isAnchorText(text) ? text : ''
}
function defaultFieldName(pick, n, pos = {}) {
  if (pick?.cell) {
    // 用位置定位的軸不能把標題寫進名稱：每天取最後一列的話，那個日期明天就變了；
    // 純數值的標題同理（判準與定位同一份，`shared/table.js`）
    const r = pos.rowPos ? '' : anchorOnly(pick.cell.row?.header)
    const c = pos.colPos ? '' : anchorOnly(pick.cell.col?.header)
    const suffix = [
      pos.rowPos ? `${POS_NAMES[pos.rowPos]}列` : '',
      pos.colPos ? `${POS_NAMES[pos.colPos]}欄` : ''
    ].filter(Boolean).join('、')
    const base = withInnerLabel([r, c].filter(Boolean).join(' · '), pick.cell.inner) || (suffix ? '值' : `值 ${n}`)
    return suffix ? `${base}（${suffix}）` : base
  }
  return withInnerLabel(anchorOnly(pick?.block?.headerText), pick?.block?.inner) || `值 ${n}`
}

// 任務目前用的定位方式（重選新增的值要跟著它命名）
function posOfTask(task) {
  const first = Array.isArray(task?.spec?.fields) && task.spec.fields.length > 0
    ? task.spec.fields[0]
    : task?.spec?.block
  if (!first) return { rowPos: '', colPos: '' }
  if (first.cell) return { rowPos: first.cell.row?.pos || '', colPos: first.cell.col?.pos || '' }
  // 整欄／整列的 pos 掛在另一軸上：整欄的 pos 是列的位置、整列的 pos 是欄的位置
  const b = first.block || first
  if (!b.pos) return { rowPos: '', colPos: '' }
  return b.axis === 'row' ? { rowPos: '', colPos: b.pos } : { rowPos: b.pos, colPos: '' }
}
// 重選只換位置與標題，使用者原本設的「定位方式」（依標題／第一筆／最後一筆）要留著，
// 不然重選一次就默默退回依標題，每天新增列的表格隔天就抓不到了。
function keepPos(nextSpec, prevSpec) {
  if (!nextSpec || !prevSpec) return nextSpec
  if (nextSpec.cell && prevSpec.cell) {
    for (const axis of ['row', 'col']) {
      const pos = prevSpec.cell[axis]?.pos
      if (pos && nextSpec.cell[axis]) nextSpec.cell[axis].pos = pos
    }
  } else if (nextSpec.block && prevSpec.block && prevSpec.block.pos) {
    // block 的 pos 是「另一軸」的位置：整欄的 pos 指列、整列的 pos 指欄；換軸就不能照搬
    if (nextSpec.block.axis === prevSpec.block.axis) nextSpec.block.pos = prevSpec.block.pos
  } else if (nextSpec.block && prevSpec.cell) {
    // 儲存格改成整欄／整列：把對應那一軸的位置搬過去（整欄要的是列的位置）
    const carry = nextSpec.block.axis === 'row' ? prevSpec.cell.col?.pos : prevSpec.cell.row?.pos
    if (carry) nextSpec.block.pos = carry
  }
  return nextSpec
}

function applyRepick(task, picks) {
  if (picks.length === 0) return []
  const hadFields = Array.isArray(task.fields) && task.fields.length > 0
  if (!hadFields && picks.length === 1) {
    // 單值任務只換定位與規格，聚合方式沿用
    const spec = pickSpecOf(picks[0])
    if (!spec) return
    task.mode = 'block'
    task.spec = { ...(task.spec || {}), mode: 'block' }
    delete task.spec.fields
    const prev = task.spec?.block
    // keepPos 吃的是 {cell} / {block} 兩種包裝，單值的 spec.block 是攤平的，進出都要包／拆
    let nextWrapped
    if (spec.cell) {
      nextWrapped = { cell: spec.cell }
    } else {
      const block = { ...spec.block, aggregate: task.spec?.block?.aggregate || 'sum' }
      putSkip(block, task.spec?.block?.skip)
      nextWrapped = { block }
    }
    const prevWrapped = prev ? (prev.cell ? { cell: prev.cell } : { block: prev }) : null
    const kept = keepPos(nextWrapped, prevWrapped)
    task.spec.block = kept.cell ? { cell: kept.cell } : kept.block
    return []
  }
  const aggregate = task.spec?.block?.aggregate
    || (task.spec?.fields || []).find(f => f.block?.aggregate)?.block?.aggregate
    || 'sum'
  const skip = task.spec?.block?.skip
    || (task.spec?.fields || []).find(f => f.block?.skip)?.block?.skip
  const taskPos = posOfTask(task)
  const oldSpecs = task.spec?.fields || []
  const oldNames = new Map((task.fields || []).map(f => [f.key, f.name]))
  // 「哪個 pick 是哪個既有的值」只有 shared/field-match 一份（Picker 換目標也用它）
  const prevRows = oldSpecs.map(f => ({
    key: f.key,
    name: oldNames.get(f.key) || '',
    spec: f.cell ? { cell: f.cell } : { block: f.block }
  }))
  const matched = reconcileFields(prevRows, picks)
  const keptByKey = new Map(oldSpecs.map(f => [f.key, f]))
  const fields = []
  const specFields = []
  picks.forEach((pick, i) => {
    const spec = pickSpecOf(pick)
    if (!spec) return
    const m = matched[i]
    const key = m.key
    const kept = m.kept ? keptByKey.get(key) : null
    const name = m.name || defaultFieldName(pick, i + 1, taskPos)
    fields.push({ key, name })
    let nextSpec
    if (spec.cell) {
      nextSpec = { cell: spec.cell }
    } else {
      const block = { ...spec.block, aggregate }
      putSkip(block, skip)
      nextSpec = { block }
    }
    const prevSpec = kept ? (kept.cell ? { cell: kept.cell } : { block: kept.block }) : null
    const withPos = prevSpec ? keepPos(nextSpec, prevSpec) : nextSpec
    specFields.push(withPos.cell ? { key, cell: withPos.cell } : { key, block: withPos.block })
  })
  task.mode = 'block'
  task.fields = fields
  task.spec = { ...(task.spec || {}), mode: 'block', fields: specFields }
  delete task.spec.block
  // 少掉的值：它們的卡片來源與 lastValues 會變成孤兒，呼叫端要清（紀錄一律保留）
  return matched.removed
}

// 由任務的擷取規格推出選取模式要預先勾回去的值（多值走 spec.fields，單值走 spec.block）
function preselectOf(task) {
  if (!task || !task.spec) return undefined
  if (Array.isArray(task.spec.fields) && task.spec.fields.length > 0) {
    return task.spec.fields
      .map(f => (f?.cell ? { cell: f.cell } : (f?.block ? { block: f.block } : null)))
      .filter(Boolean)
  }
  if (task.spec.block) {
    if (task.spec.block.cell) return [{ cell: task.spec.block.cell }]
    return [{ block: task.spec.block }]
  }
  return undefined
}

// 取任務並檢查存在與啟用狀態（共用小函式）
async function getValidTask(taskId) {
  if (!taskId) return { task: null, active: false }
  const task = await getTask(taskId)
  if (!task) return { task: null, active: false }
  return { task, active: task.enabled !== false }
}

// 解析任務 alarm 名稱（相容正式排程與測試名稱）
function parseTaskAlarm(name) {
  if (typeof name !== 'string') return null
  if (name.startsWith('precheck:') || name.includes(':retry:')) return null
  const parsed = parseAlarmName(name)
  if (parsed) return parsed
  const lastColon = name.lastIndexOf(':')
  if (lastColon === -1) return null
  const taskId = name.slice(0, lastColon)
  const indexStr = name.slice(lastColon + 1)
  if (!taskId || !/^\d+$/.test(indexStr)) return null
  return { taskId, index: Number(indexStr) }
}

// 解析重試 alarm 名稱（格式：<taskId>:retry:<n>）
function parseRetryName(name) {
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

// 計算每日任務當日時間槽（格式：YYYY-MM-DDTHH:mm）
function getDailySlot(task, index) {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const time = task?.schedule?.times?.[index] || '00:00'
  const [h = '00', min = '00'] = time.split(':')
  return `${y}-${m}-${day}T${h.padStart(2, '0')}:${min.padStart(2, '0')}`
}

// 短暫等待輔助函式
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 「使用教學」要不要顯示：缺省＝顯示，只有明確 false 才隱藏
function helpMenuShown(settings) {
  return settings?.showHelpMenu !== false
}

// 上次建立選單時採用的「使用教學」顯示值（null＝還沒建過）
let helpMenuBuiltWith = null
// 重建串行化：後一次等前一次 removeAll＋全部 create 完成才開始
let menuQueue = Promise.resolve()

// 建立右鍵選單項目
export function setupContextMenus() {
  menuQueue = menuQueue.then(buildContextMenus, buildContextMenus)
  return menuQueue
}

async function buildContextMenus() {
  let showHelp = true
  try {
    showHelp = helpMenuShown(await getSettings())
  } catch {}
  helpMenuBuiltWith = showHelp
  try {
    await chrome.contextMenus.removeAll()
    chrome.contextMenus.create({ id: 'af-root', title: 'AutoFetcher', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-pick', parentId: 'af-root', title: '選取要抓的內容', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-pick-batch', parentId: 'af-root', title: '一次建立多個任務', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-site-login', parentId: 'af-root', title: '設定此站台登入', contexts: ['all'] })
    chrome.contextMenus.create({ id: 'af-open-report', parentId: 'af-root', title: '開啟 AutoFetcher 報表', contexts: ['all'] })
    if (showHelp) {
      chrome.contextMenus.create({ id: 'af-open-help', parentId: 'af-root', title: '使用教學', contexts: ['all'] })
    }
  } catch {}
}

// 設定變動（設定頁切換、匯入設定檔）時，「使用教學」的有效值變了才重建選單
export function handleSettingsChanged(changes) {
  if (!changes?.settings) return
  const shown = helpMenuShown(changes.settings.newValue)
  // service worker 重啟後還沒建過選單（null）：拿變動前的值當基準。不然第一次任何設定寫入
  // （每存一個任務都會寫 pickerDefaults）都會把整組右鍵選單拆掉重建（體檢抓到）
  const before = helpMenuBuiltWith ?? helpMenuShown(changes.settings.oldValue)
  if (shown === before) return
  setupContextMenus()
}

// 處理擴充功能安裝或更新事件
export async function handleInstalled(details) {
  try {
    await initStorage()
    await disablePanelGlobally()
    await setupContextMenus()
    await rebuildAlarms()
    await schedulePrechecks()
    await scheduleSiteCheck()
    await ensureWatchdog()
    await refreshBadge()
  } catch {}
}

// 處理瀏覽器啟動事件
export async function handleStartup() {
  try {
    await initStorage()
    await disablePanelGlobally()
    await rebuildAlarms()
    await schedulePrechecks()
    await scheduleSiteCheck()
    await ensureWatchdog()
    await refreshMissed(Date.now())
    await refreshBadge()
  } catch {}
}

// 處理 Alarm 觸發事件
export async function handleAlarm(alarm, testOpts = {}) {
  try {
    if (!alarm?.name) return
    const { name } = alarm

    // 1. 看門狗巡檢
    if (name === '__watchdog') {
      await runWatchdog()
      await refreshBadge()
      return
    }

    // 2. 自檢記錄
    if (name === '__selftest') {
      await diag.log('selftest', '測試 alarm 準時觸發')
      return
    }

    // 3. 站台健康檢查
    if (name === '__sitecheck') {
      await runSiteCheck(testOpts)
      await scheduleSiteCheck()
      return
    }

    // 4. 預檢演練
    const precheck = parsePrecheckName(name)
    if (precheck !== null) {
      const { task, active } = await getValidTask(precheck.taskId)
      if (!task || !active) return
      await runPrecheck(task, testOpts)
      await schedulePrechecks()
      return
    }

    // 4. 重試機制
    const retry = parseRetryName(name)
    if (retry !== null) {
      const { task, active } = await getValidTask(retry.taskId)
      if (!task || !active) return
      // 重試補的是原本那一格;舊格式沒帶槽時才退回當下時刻
      const retrySlot = retry.slot || slotOf(Date.now())
      await runTask(task, { slot: retrySlot, attempt: retry.attempt + 1, ...testOpts })
      return
    }

    // 5. 正式抓取
    const parsed = parseTaskAlarm(name)
    if (parsed !== null) {
      const { task, active } = await getValidTask(parsed.taskId)
      if (!task) return
      if (!active) {
        await chrome.alarms.clear(alarm.name)
        return
      }
      // interval 是 one-shot alarm,必須先把下一次排好,任何提早 return 都不能跳過重排
      if (task.schedule?.type === 'interval') {
        const nextWhen = nextIntervalRun(task, Date.now())
        if (nextWhen !== null) await chrome.alarms.create(alarm.name, { when: nextWhen })
        // 用「排定時刻」判斷時段,不是實際觸發時刻:
        // 晚觸發(休眠喚醒、worker 冷啟動)會滑出時段末端,把本來合法的那一格丟掉
        const decideAt = alarm.scheduledTime ?? Date.now()
        if (!shouldRunInterval(task, decideAt)) return
      }

      // interval 的槽取 alarm 排定時刻(對齊格線),晚觸發不可自成新槽,冪等帳本靠它
      const slot = task.schedule?.type === 'daily'
        ? getDailySlot(task, parsed.index)
        : slotOf(alarm.scheduledTime ?? Date.now())
      await runTask(task, { slot, ...testOpts })

      if (task.schedule?.type === 'daily') {
        const times = task.schedule.times
        const weekdays = task.schedule.weekdays ?? task.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
        if (Array.isArray(times) && times[parsed.index]) {
          const when = nextDailyRun(Date.now(), [times[parsed.index]], weekdays)
          if (when !== null) await chrome.alarms.create(alarm.name, { when })
        }
      }
      await refreshBadge()
    }
  } catch {}
}

// 處理內部訊息分派
// 送訊息那個 frame 的身分；最上層不留欄位（舊任務零遷移的前提）
function frameIdentityOf(sender) {
  if (sender?.frameId === undefined || sender.frameId === 0) return {}
  return { frameId: sender.frameId, frameUrl: sender.url }
}

// 選取結果 → 面板要的 payload（逐欄挑，補上分頁與框架身分）；單任務與批次每一組共用這一份
function taskPayloadOf(src, sender) {
  const payload = {
    locator: src?.locator,
    preview: src?.preview,
    previewSamples: src?.previewSamples,
    previewValue: src?.previewValue,
    blockInfo: src?.blockInfo,
    tabId: sender?.tab?.id,
    url: sender?.tab?.url,
    nameHint: src?.nameHint,
    // 使用者一次挑的那幾個值；漏掉這一個欄位，多值任務就會退化成單值
    picks: src?.picks
  }
  Object.assign(payload, frameIdentityOf(sender))
  return payload
}

/**
 * 訊息處理。
 * @param {object} msg 訊息本身——**訊息裡的欄位一律只當資料看**，不得拿來改執行方式。
 * @param {object} sender
 * @param {object} runOpts 執行選項（時序、dryRun 等），**只有直接呼叫的人給得了**：
 *   正式接線只傳 `(msg, sender)`，所以網頁或任何送得出 runtime 訊息的來源都影響不到。
 *   測試要縮短等待就從這裡傳，形狀比照 `handleAlarm(alarm, testOpts)`。
 */
/**
 * ctx 能不能寫成等待態：沒有面板、已在等待、站台設定，或剛存完（saved）才可以；
 * 表單填到一半（new／edit）不動，選完才認得出是換目標。右鍵與 ENTER_PICK 共用這一份。
 */
function canStartPick(ctx) {
  return !ctx || ctx.kind === 'waiting' || ctx.kind === 'site' || ctx.kind === 'saved'
}

/**
 * 進選取模式之前的唯一判定（右鍵兩項與 ENTER_PICK 訊息共用；AF-18 終檢收成一份）：
 * 回傳 { start: true }（寫等待態再進）、{ start: false }（單任務換目標：不動 ctx 直接進），
 * 或 { blocked: '說明句' }（不進選取，把這句寫進面板的 notice）。
 * 單任務與多任務互不插隊：多任務清單還沒存時不開單任務；表單或清單填到一半時不開多任務。
 */
function pickEntryOf(ctx, batch) {
  if (canStartPick(ctx)) return { start: true }
  if (ctx?.kind === 'bulk') return { blocked: '有一批任務的排程改到一半，請先套用或取消，再開始選取' }
  if (batch) {
    return { blocked: ctx.kind === 'batch'
      ? '多任務清單還沒存，請先全部儲存或取消，再開始新的多任務'
      : '有一個任務設定到一半，請先儲存或取消，再開始多任務' }
  }
  if (ctx.kind === 'batch') return { blocked: '多任務設定到一半，請先全部儲存或取消，再選單一任務' }
  return { start: false }
}

// 依 pickEntryOf 的結果處理面板 ctx；回傳 false＝被擋（已留說明），呼叫端不得進選取模式
async function applyPickEntry(tabId, batch) {
  const entry = pickEntryOf(await getPanelCtx(tabId), batch)
  if (entry.blocked) {
    await mergePanelCtx(tabId, { notice: entry.blocked })
    return false
  }
  if (entry.start) await setPanelCtx(tabId, batch ? { kind: 'waiting', purpose: 'task', batch: true } : { kind: 'waiting', purpose: 'task' })
  return true
}

export async function handleMessage(msg, sender, runOpts = {}) {
  try {
    if (!msg || typeof msg !== 'object') return undefined

    if (msg.type === MSG.TEST_TASK) {
      const task = msg.task
      if (!task || typeof task !== 'object' || !task.url || !task.locator || !task.spec) {
        return { ok: false, error: '任務設定不完整' }
      }
      return await runTask(task, { dryRun: true, reason: 'manual', tabId: msg.tabId })
    }

    if (msg.type === MSG.RUN_TASK) {
      const { task } = await getValidTask(msg.taskId)
      if (!task) {
        return { ok: false, outcome: 'failed', error: '找不到任務' }
      }
      const record = await runTask(task, {
        slot: slotOf(Date.now()),
        ...runOpts,
        reason: 'manual'
      })
      if (!record) {
        return { ok: true, outcome: 'failed', status: 'error', error: '沒有結果' }
      }
      // 多值任務要逐值回報，只回第一筆使用者看不出另外幾個值怎麼了
      let values
      if (Array.isArray(task.fields) && task.fields.length > 0 && typeof record.slot === 'string') {
        // 同一分鐘按兩次會有兩組紀錄，每個值只留最新的那一筆
        const latestById = new Map()
        for (const r of await getRecordsByDate(record.slot.slice(0, 10))) {
          if (r.slot !== record.slot || parentIdOf(r.taskId) !== task.id) continue
          const prev = latestById.get(r.taskId)
          if (!prev || String(r.capturedAt) >= String(prev.capturedAt)) latestById.set(r.taskId, r)
        }
        const sameSlot = [...latestById.values()]
        if (sameSlot.length > 0) {
          const idx = buildSeriesIndex([task])
          values = sameSlot.map(r => ({
            // 按鈕就在那個任務旁邊，用值名就夠，不必每個都重複任務名
            name: idx.byId[r.taskId]?.shortName || nameOf(idx, r.taskId),
            ok: isSuccess(r),
            value: isSuccess(r) ? r.value : undefined,
            error: isSuccess(r) ? undefined : (r.error || r.status)
          }))
        }
      }

      if (isSuccess(record)) {
        return { ok: true, outcome: 'done', status: record.status, value: record.value, values }
      }
      return { ok: true, outcome: 'failed', status: record.status, error: record.error || '', values }
    }

    if (msg.type === MSG.REBUILD_ALARMS) {
      await rebuildAlarms()
      await schedulePrechecks()
      // 任務清單變了,燈號要跟著更新(否則 popup 上的燈號會停在舊狀態)
      await refreshBadge()
      return { ok: true }
    }

    if (msg.type === MSG.CATCH_UP_ONE) {
      await catchUpOne(msg.taskId, msg.slot, (task, opts) => runTask(task, opts))
      await refreshBadge()
      return { ok: true }
    }

    if (msg.type === MSG.SKIP_ONE) {
      await skipOne(msg.taskId, msg.slot)
      await refreshBadge()
      return { ok: true }
    }

    // 面板無法自己判斷歸屬：它的 sender.tab 永遠是 null、網址參數重載後會被丟掉，
    // 載入當下查 active tab 又會在切換競態中拿到舊分頁（B-0 #11、#12）。
    // 面板改成拿得到的 windowId 來問，由這裡回答那個視窗現在的作用分頁。
    if (msg.type === MSG.RESOLVE_PANEL_TAB) {
      const windowId = msg.windowId
      if (windowId === undefined || windowId === null) return { ok: false }
      // 查不到就回 null：猜一個別的視窗的作用分頁，會讓面板拿別人的 ctx 去讀寫。
      // 面板下一次轉為可見時會自己再問一次（自癒）
      const tabs = await chrome.tabs.query({ active: true, windowId })
      const tabId = tabs?.[0]?.id ?? null
      return { ok: tabId !== null, tabId }
    }

    if (msg.type === MSG.PANEL_CLOSING) {
      await closePanelFor(msg.tabId)
      return { ok: true }
    }

    if (msg.type === MSG.CLOSE_PANEL) {
      await closePanel(msg.tabId)
      await closePanelFor(msg.tabId)
      return { ok: true }
    }

    if (msg.type === MSG.PICKED) {
      // 取消也要轉發給面板：不轉的話「在頁面上選取」那顆按鈕會一直卡在等待狀態
      // （AF-10 修正：原本 cancelled 在轉發之前就 return 了）
      if (msg.purpose === 'preaction' || (typeof msg.purpose === 'string' && msg.purpose.startsWith('login-'))) {
        try {
          await chrome.runtime.sendMessage({ ...msg, ...frameIdentityOf(sender) })
        } catch {}
        return { ok: true }
      }

      if (msg.cancelled === true) {
        // 取消也要收掉「為了重選而開的那個分頁」，否則每取消一次殘留一個
        if (msg.purpose === 'repick' && msg.taskId !== undefined) {
          await closeRepickTab(msg.taskId)
        }
        return { ok: true }
      }

      if (msg.purpose === 'task') {
        const tabId = sender?.tab?.id
        // 批次（一次建立多個任務）：每一組補上與單任務相同的欄位，另給穩定鍵；不帶舊草稿、不算換目標
        if (Array.isArray(msg.batch)) {
          const items = msg.batch.map((one, i) => ({ key: `b${i + 1}`, ...taskPayloadOf(one, sender) }))
          await setPanelCtx(tabId, { kind: 'batch', items })
          return { ok: true }
        }
        const payload = taskPayloadOf(msg, sender)
        // 面板已經開著、使用者也填了一半的表單時，**只換目標**：
        // 名稱、排程、儀表板、進階設定全部留著（右鍵重選一個目標不該把表單清空）
        const existing = await getPanelCtx(tabId)
        // 面板已經關掉（暫存被清），頁面卻還在選取模式：值選好了沒有人接。
        // 使用者看到的是「選完什麼都沒發生」，沒有這一筆就查不出原因
        if (!existing) {
          await diag.log('panel_missing_on_pick', { tabId, purpose: msg.purpose })
        }
        const keepDraft = existing && (existing.kind === 'new' || existing.kind === 'edit')
        await mergePanelCtx(tabId, {
          kind: 'new',
          ctx: payload,
          retarget: Boolean(keepDraft && existing.ctx),
          // 淺層合併：被擋時留下的說明與等待態的多任務旗標不得跟到新表單上（AF-18 終檢）
          notice: undefined,
          batch: undefined
        })
        return { ok: true }
      }

      if (msg.purpose === 'repick') {
        const task = await getTask(msg.taskId)
        if (!task) {
          return { ok: true }
        }
        task.locator = msg.locator
        const removedKeys = applyRepick(task, Array.isArray(msg.picks) ? msg.picks : [])
        await saveTask(task)
        // 被移除的值：清掉它們在儀表板上的來源與最後一次的值，紀錄留到保留天數自然到期。
        // 不清的話卡片會一直指著不存在的序列，使用者只看得到一張永遠空白的卡
        if (Array.isArray(removedKeys) && removedKeys.length > 0) {
          const seriesIds = removedKeys.map(k => seriesIdOf(task.id, k))
          await pruneSeries(seriesIds)
          await deleteLastValues(seriesIds)
          await diag.log('fields_pruned', { taskId: task.id, keys: removedKeys })
        }
        // 定位換了會影響抓取：排程與燈號要跟著重算（其他改任務的路徑都有做，這裡漏了）
        await rebuildAlarms()
        await refreshBadge()
        // 為了重選而開的分頁由我們收掉（使用者原本就開著的那個不動）
        await closeRepickTab(msg.taskId)
        return { ok: true }
      }

      return { ok: true }
    }

    if (msg.type === MSG.DESCEND_FRAME) {
      const tabId = sender?.tab?.id
      if (!tabId) return { ok: true }
      const enter = {
        type: MSG.ENTER_PICK,
        purpose: msg.purpose,
        taskId: msg.taskId,
        preselect: msg.preselect
      }
      // 鑽進 iframe 之後仍是同一輪批次選取
      if (msg.batch === true) enter.batch = true
      // 選取當下沒有目標的 locator 可以驗證，所以只用網址比對；
      // 不是唯一命中就退回原本那一層，硬猜會鑽錯 iframe
      const matched = matchFrameByUrl(await listFrames(tabId), msg.src)
      if (matched?.frameId !== undefined) {
        await injectContent(tabId, { frameId: matched.frameId })
        await chrome.tabs.sendMessage(tabId, enter, { frameId: matched.frameId })
        return { ok: true }
      }
      const backTo = sender?.frameId ?? 0
      await chrome.tabs.sendMessage(tabId, { ...enter, hint: 'frame_not_found' }, { frameId: backTo })
      return { ok: true }
    }

    if (msg.type === MSG.ENTER_PICK) {
      if (msg.tabId) {
        const frameId = msg.frameId ?? 0
        // popup 的「選取要抓的內容」走這裡：面板已由 popup 自己開好，
        // 但沒有表單時要先顯示等待態（同右鍵入口），否則面板是一張空白表單
        const batch = msg.batch === true
        // popup 送完就關視窗：被擋時一定要把說明留在面板上，不能只回 ok:false（靜默無事）
        if (msg.purpose === 'task' && !(await applyPickEntry(msg.tabId, batch))) return { ok: false }
        await injectContent(msg.tabId, { frameId })
        const known = msg.taskId ? await getTask(msg.taskId) : null
        const enter = {
          type: MSG.ENTER_PICK,
          purpose: msg.purpose,
          taskId: msg.taskId,
          // 重選開的是新分頁，那裡沒有「上次右鍵的元素」可用；
          // 要靠任務自己的 locator 才找得到目標，也才勾得回既有的值
          locator: msg.locator || known?.locator,
          preselect: msg.preselect || preselectOf(known)
        }
        if (batch) enter.batch = true
        await chrome.tabs.sendMessage(msg.tabId, enter, { frameId })
        return { ok: true }
      }

      const task = await getTask(msg.taskId)
      if (!task) {
        return { ok: false }
      }
      const tab = await chrome.tabs.create({ url: task.url, active: true })
      if (!tab?.id) return { ok: false }
      // 這個分頁是我們為了重選開的，選完（或取消）要收掉，不然每重選一次留一個
      await rememberRepickTab(msg.taskId, tab.id)
      const pollMs = msg.pollMs ?? 250
      const loadTimeoutMs = msg.loadTimeoutMs ?? 30000
      let tabInfo = await chrome.tabs.get(tab.id)
      const loadStart = Date.now()
      while (tabInfo?.status !== 'complete' && Date.now() - loadStart < loadTimeoutMs) {
        await sleep(pollMs)
        tabInfo = await chrome.tabs.get(tab.id)
      }

      const loc = await locateFrame(tab.id, task.frame, task.locator, { pollMs })
      // 失敗時回的是帶候選清單的物件（診斷用），判定看有沒有 frameId
      if (!loc || typeof loc.frameId !== 'number') {
        return { ok: false, error: 'frame_not_found' }
      }

      const frameId = loc.frameId
      await injectContent(tab.id, { frameId })
      await chrome.tabs.sendMessage(tab.id, {
        type: MSG.ENTER_PICK,
        purpose: msg.purpose || 'repick',
        taskId: msg.taskId,
        // 這是重選最常走的那條路（任務頁不帶 tabId）：新分頁沒有「上次右鍵的元素」，
        // 不帶這兩個欄位就沒有預選對象，既有的值也勾不回來
        locator: msg.locator || task.locator,
        preselect: msg.preselect || preselectOf(task)
      }, { frameId })
      return { ok: true }
    }

    if (msg.type === 'MARK_READ') {
      if (Array.isArray(msg.taskIds)) {
        for (const id of msg.taskIds) await markRead(id)
      }
      await refreshBadge()
      return { ok: true }
    }

    if (msg.type === MSG.GET_NEXT_RUNS) {
      const alarms = await chrome.alarms.getAll()
      const nextRuns = {}
      for (const alarm of alarms) {
        const parsed = parseTaskAlarm(alarm.name)
        if (parsed?.taskId && typeof alarm.scheduledTime === 'number') {
          const prev = nextRuns[parsed.taskId]
          if (prev === undefined || alarm.scheduledTime < prev) {
            nextRuns[parsed.taskId] = alarm.scheduledTime
          }
        }
      }
      return { nextRuns }
    }

    if (msg.type === MSG.SELF_CHECK) {
      await selfCheck()
      return { ok: true }
    }

    return undefined
  } catch {
    return undefined
  }
}

// 處理通知按鈕點擊事件
export async function handleNotificationButton(notificationId, buttonIndex) {
  try {
    if (typeof notificationId === 'string' && notificationId.startsWith('missed')) {
      if (buttonIndex === 0) {
        await catchUpAll((task, opts) => runTask(task, opts))
      } else if (buttonIndex === 1) {
        await skipAll()
      }
      await refreshBadge()
      await chrome.notifications.clear(notificationId)
    }
  } catch {}
}

// 處理通知本體點擊事件
export async function handleNotificationClick(notificationId) {
  try {
    if (typeof notificationId !== 'string') return

    // 格式：<taskId>:alert:<alertId>:<YYYY-MM-DD>
    const match = notificationId.match(/^(.+):alert:(.+):(\d{4}-\d{2}-\d{2})$/)
    if (!match) return

    const taskId = match[1]
    const date = match[3]

    const base = typeof chrome.runtime?.getURL === 'function'
      ? await chrome.runtime.getURL('ui/report/report.html')
      : 'ui/report/report.html'
    // 報表的 hash 參數是 taskIds（複數），寫成 task= 的話只會定位到日期、篩不到任務
    const url = `${base}#view=history&from=${date}&to=${date}&taskIds=${encodeURIComponent(taskId)}`

    await chrome.tabs.create({ url })
    await chrome.notifications.clear(notificationId)
  } catch {}
}

// 為了重選而開的分頁：`taskId -> tabId`。使用者原本就開著的分頁不進這張表，也就不會被收掉。
// 放 `storage.session` 而不是模組級 Map——MV3 的 service worker 一被回收就整張歸零，
// 而重選流程（開分頁→等載入→使用者慢慢選）很容易跨過閒置回收。
const REPICK_KEY = 'repickTabs'

async function rememberRepickTab(taskId, tabId) {
  const cur = (await chrome.storage.session.get(REPICK_KEY))[REPICK_KEY] || {}
  cur[taskId] = tabId
  await chrome.storage.session.set({ [REPICK_KEY]: cur })
}

async function closeRepickTab(taskId) {
  const cur = (await chrome.storage.session.get(REPICK_KEY))[REPICK_KEY] || {}
  const tabId = cur[taskId]
  if (tabId === undefined) return
  delete cur[taskId]
  await chrome.storage.session.set({ [REPICK_KEY]: cur })
  try { await chrome.tabs.remove(tabId) } catch {}
}

/**
 * 面板關掉了：把頁面上的標示清乾淨，並丟掉那個分頁的暫存 ctx。
 * 三條通道都走這裡（`sidePanel.onClosed`、面板自己的 `pagehide`、分頁被關閉），
 * 重複觸發是常態，所以整件事必須是冪等的。
 * @param {number} tabId 分頁 id
 * @param {{keepMarks?: boolean}} opts 分頁都關了就不必再送訊息
 */
export async function closePanelFor(tabId, opts = {}) {
  if (tabId === undefined || tabId === null) return
  // 三條通道會重複觸發（onClosed + 分頁關閉…），暫存還在才代表「這一輪還沒清過」。
  // 不擋的話每次都對頁面廣播一輪 EXIT_PICK，白花訊息也可能清到下一輪剛貼上的標示
  const pending = await getPanelCtx(tabId)
  await clearPanelCtx(tabId)
  if (opts.keepMarks || !pending) return
  // 「面板關掉了、頁面上的標示也清了」要留痕跡：使用者回報「藍框自己不見了」時，
  // 診斷區看得到是哪一次清場、當時面板停在哪個狀態
  await diag.log('panel_closed', { tabId, kind: pending?.kind })
  // 最上層一定在，先送它；其餘 frame 能列出來就一起送（選取模式可能鑽進了 iframe）。
  // 一個分頁可能有多個 frame，不指名 frameId 就是廣播（見 CLAUDE.md 的 D13 規約）
  const targets = new Set([0])
  try {
    for (const f of await listFrames(tabId)) {
      if (typeof f?.frameId === 'number') targets.add(f.frameId)
    }
  } catch {}
  for (const frameId of targets) {
    try { await chrome.tabs.sendMessage(tabId, { type: MSG.EXIT_PICK }, { frameId }) } catch {}
  }
}

// 處理右鍵選單點擊事件
export async function handleContextMenu(info, tab) {
  try {
    if (!info) return

    if (info.menuItemId === 'af-open-help') {
      await chrome.tabs.create({ url: await chrome.runtime.getURL('ui/help/help.html') })
      return
    }

    if (info.menuItemId === 'af-open-report') {
      const url = typeof chrome.runtime?.getURL === 'function'
        ? await chrome.runtime.getURL('ui/report/report.html')
        : 'ui/report/report.html'
      await chrome.tabs.create({ url })
      return
    }

    if (info.menuItemId === 'af-site-login') {
      if (!tab?.id) return
      let origin = ''
      try {
        origin = tab.url ? new URL(tab.url).origin : ''
      } catch {}
      // 網址參數在面板重載後會被丟掉（B-0 實測），參數一律走 storage.session
      // **先開面板再寫 ctx**：手勢必須留在 contextMenus.onClicked 裡（轉給別人開一定失敗），
      // 而且中間不要夾非同步等待——面板先顯示等待態，ctx 晚一步到達由 session 監聽補畫
      await openPanel(tab.id, 'site', `origin=${encodeURIComponent(origin)}&tabId=${tab.id}`)
      await setPanelCtx(tab.id, { kind: 'site', origin, tabId: tab.id })
      await injectContent(tab.id, { frameId: 0 })
      await chrome.tabs.sendMessage(tab.id, { type: MSG.ENTER_PICK, purpose: 'login-user' }, { frameId: 0 })
      return
    }

    if (info.menuItemId === 'af-pick') {
      if (!tab?.id) return
      const frameId = info.frameId ?? 0
      // 面板先開起來顯示「正在頁面上選取…」，使用者才知道東西在哪裡、也才有地方可以取消。
      // **`open` 要排在最前面**：手勢跨越非同步等待有失效風險
      await openPanel(tab.id, 'picker', `tabId=${tab.id}`)
      // 面板已經有表單（使用者填到一半又回頁面按右鍵）就不動 ctx：
      // 蓋成等待態會把草稿一起洗掉，選完也認不出這是「換目標」
      if (!(await applyPickEntry(tab.id, false))) return
      await injectContent(tab.id, { frameId })
      await chrome.tabs.sendMessage(tab.id, { type: MSG.ENTER_PICK, purpose: 'task' }, { frameId })
      return
    }

    if (info.menuItemId === 'af-pick-batch') {
      if (!tab?.id) return
      const frameId = info.frameId ?? 0
      // 手勢規則同 af-pick：`open` 必須是第一個 await
      await openPanel(tab.id, 'picker', `tabId=${tab.id}`)
      if (!(await applyPickEntry(tab.id, true))) return
      await injectContent(tab.id, { frameId })
      await chrome.tabs.sendMessage(tab.id, { type: MSG.ENTER_PICK, purpose: 'task', batch: true }, { frameId })
      return
    }
  } catch {}
}

// 註冊所有事件監聽器（載入時僅註冊，不執行副作用）
// 全域停用面板（分頁層 `enabled: true` 仍可開，B-0 #9 實測）：
// 不停用的話，工具列圖示右鍵的「開啟側邊面板」會開出一張沒有 ctx 的空表單
async function disablePanelGlobally() {
  try { await chrome.sidePanel?.setOptions?.({ enabled: false }) } catch {}
}

chrome.alarms.onAlarm.addListener(handleAlarm)
subscribe(handleSettingsChanged, { keys: ['settings'] })
chrome.runtime.onInstalled.addListener(handleInstalled)
chrome.runtime.onStartup.addListener(handleStartup)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse)
  return true
})
chrome.notifications.onButtonClicked.addListener(handleNotificationButton)
chrome.notifications.onClicked.addListener(handleNotificationClick)
chrome.contextMenus.onClicked.addListener(handleContextMenu)
// 面板關閉的三條通道，全部收斂到 closePanelFor（冪等）：
// 主要是 onClosed（Chrome 142+，B-0 實測切分頁不會誤觸發），
// 面板自己的 pagehide 當補漏，分頁被關掉時節點也沒了、只要清掉暫存。
if (chrome.sidePanel?.onClosed?.addListener) {
  chrome.sidePanel.onClosed.addListener((info) => { closePanelFor(info?.tabId) })
}
chrome.tabs?.onRemoved?.addListener?.((tabId) => { closePanelFor(tabId, { keepMarks: true }) })
