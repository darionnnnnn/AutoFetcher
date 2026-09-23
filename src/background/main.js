// AutoFetcher MV3 Background Service Worker 入口總接線
import {
  init as initStorage, getTask, updateTasks, getRecordsByDate, updateRepickTabs, getRepickTabs,
  getPanelCtx, setPanelCtx, mergePanelCtx, clearPanelCtx,
  getSettings, subscribe, deleteLastValues, getSite
} from '../shared/storage.js'
import { pruneSeries } from '../shared/layout-store.js'
import { openPanel, closePanel } from '../shared/panel.js'
import { MSG, CONTENT_ALLOWED } from '../shared/messages.js'
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
import { runTask, recoverRunState, isLateStart, parseRetryName } from './fetcher.js'
import { refreshMissed, catchUpAll, skipAll, catchUpOne, skipOne } from './missed.js'
import { runWatchdog, selfCheck } from './watchdog.js'
import { cleanOrphanFetchTabs } from './fetch-tab.js'
import { refreshBadge, markRead } from './health.js'
import {
  schedulePrechecks,
  runPrecheck,
  parsePrecheckName
} from './precheck.js'
import { injectContent } from './inject.js'
import { sendToFrame } from './messaging.js'
import { locateFrame, listFrames, matchFrameByUrl, sameOriginPath } from './frames.js'
import { isAnchorText, putSkip } from '../shared/table.js'
import { pickSpecOf, pickSourceOf, reconcileFields, sameSpec, stripPos } from '../shared/field-match.js'
import { parseNumber } from '../shared/extract.js'
import { withInnerLabel } from '../shared/describe.js'
import { scheduleSiteCheck, runSiteCheck } from './sitecheck.js'
import { testLogin } from './login.js'
import { decryptSecret } from '../shared/crypto.js'
import { isSuccess, statusTextOf } from '../shared/record-status.js'
import { parentIdOf, buildSeriesIndex, nameOf, seriesIdOf } from '../shared/series-index.js'
import {
  beginPickDraft,
  readPickDraftMessage,
  handlePickDraftOperation,
  completePickDraft,
  abandonPickDraft,
  pausePickDraft,
  clearPickDraftForTab,
  protocolErrorResponse
} from '../shared/pick-protocol.js'
import { getPickDraft, updatePickDraft } from '../shared/pick-draft.js'

// 面板 ctx 可能尚未寫入就收到 pagehide；用短命記號避免無 ctx 時重複清場，
// 同時讓新一輪開啟能再次廣播 EXIT_PICK。
const exitedPickTabs = new Set()

// AF-22 C2a：選取中的 frame 是短命執行期狀態，不能寫進草稿（frameId 每次載入都會變）。
// 這份索引只用來讓進出 frame 有一個可核對的來源，避免舊 frame 的延遲回報改到新階段。
const activePickFrames = new Map()
const pickParticipantFrames = new Map()
const groupNamePickRequests = new Map()
// Per-field repair grants are deliberately worker-memory only: a worker restart
// invalidates every outstanding grant, so a stale page cannot replay a repair.
const fieldRepairSessions = new Map()

async function beginFieldRepair(msg) {
  if (typeof msg.taskId !== 'string' || typeof msg.fieldKey !== 'string' ||
      !['repair', 'replace'].includes(msg.repairMode)) return { ok: false, error: 'invalid_repair' }
  const task = await getTask(msg.taskId)
  const fields = Array.isArray(task?.fields) ? task.fields : []
  const field = fields.find(item => item?.key === msg.fieldKey)
  const specs = Array.isArray(task?.spec?.fields) ? task.spec.fields : []
  const fieldSpec = specs.find(item => item?.key === msg.fieldKey)
  const source = field?.source || fieldSpec?.source || task?.source
  const locator = source?.locator || task?.locator
  if (!task || !field || !fieldSpec || !locator || task.mode !== 'multi') {
    return { ok: false, error: 'field_not_found', message: '找不到這個多值任務欄位，請重新載入設定' }
  }
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let tabId = null
  let keepTab = false
  let failureCode = 'tab_failed'
  try {
    const tab = await chrome.tabs.create({ url: task.url, active: true })
    tabId = Number.isInteger(tab?.id) ? tab.id : null
    if (tabId === null) return { ok: false, error: 'tab_failed', message: '無法開啟來源頁面' }

    failureCode = 'frame_not_found'
    const loc = await locateFrame(tabId, source.frame, locator)
    if (!loc || !Number.isInteger(loc.frameId)) {
      return { ok: false, error: 'frame_not_found', message: '找不到此值原本所在的框架' }
    }
    let frames = []
    try { frames = await listFrames(tabId) } catch {}
    const frameUrl = frames.find(item => item.frameId === loc.frameId)?.url || task.url
    const routeIdentity = { url: frameUrl }
    const documentGeneration = `repair:${sessionId}`

    failureCode = 'enter_failed'
    await injectContent(tabId, { frameId: loc.frameId })
    // Injection may reject. Do not create the worker-memory one-shot grant until
    // the source script is ready; a failed handoff then has nothing replayable.
    fieldRepairSessions.set(sessionId, {
      sessionId, taskId: task.id, fieldKey: field.key, repairMode: msg.repairMode,
      tabId, frameId: loc.frameId, frameUrl,
      documentGeneration, routeIdentity
    })
    const entered = await sendToFrame(tabId, {
      type: MSG.ENTER_PICK, purpose: 'repick', taskId: task.id, locator,
      repairSessionId: sessionId, repairFieldKey: field.key, repairMode: msg.repairMode,
      documentGeneration, routeIdentity,
      preselect: fieldSpec.spec?.cell ? [{ cell: fieldSpec.spec.cell }]
        : fieldSpec.spec?.block ? [{ block: fieldSpec.spec.block }]
          : fieldSpec.cell ? [{ cell: fieldSpec.cell }]
            : fieldSpec.block ? [{ block: fieldSpec.block }] : undefined
    }, loc.frameId, CONTENT_MESSAGE_TIMEOUT_MS, 'Enter field repair pick')
    if (entered?.ok === false) {
      return { ok: false, error: 'enter_failed', message: '無法進入此值的重選模式' }
    }
    keepTab = true
    return { ok: true, sessionId, tabId }
  } catch (error) {
    return {
      ok: false,
      error: failureCode,
      message: failureCode === 'frame_not_found' ? '找不到此值原本所在的框架' : '無法進入此值的重選模式',
      ...(error?.afTimeout ? { retryable: true } : {})
    }
  } finally {
    if (!keepTab) {
      fieldRepairSessions.delete(sessionId)
      if (Number.isInteger(tabId)) {
        try { await chrome.tabs.remove(tabId) } catch {}
      }
    }
  }
}

async function applyFieldRepair(msg, sender) {
  const grant = typeof msg.repairSessionId === 'string' ? fieldRepairSessions.get(msg.repairSessionId) : null
  const tabId = sender?.tab?.id
  const frameId = sender?.frameId ?? 0
  if (!grant || grant.taskId !== msg.taskId || grant.fieldKey !== msg.repairFieldKey ||
      grant.repairMode !== msg.repairMode || tabId !== grant.tabId || frameId !== grant.frameId ||
      msg.documentGeneration !== grant.documentGeneration || !sameOriginPath(sender?.url, grant.frameUrl)) {
    return { ok: false, error: 'stale_field_repair', message: '這次單值重選已失效，請重新開始' }
  }
  if (msg.cancelled === true) {
    fieldRepairSessions.delete(grant.sessionId)
    try { await chrome.tabs.remove(grant.tabId) } catch {}
    return { ok: true, cancelled: true }
  }
  if (!Array.isArray(msg.picks) || msg.picks.length !== 1) {
    return { ok: false, error: 'invalid_repair_pick', message: '一次只能重選一個值' }
  }
  const pick = msg.picks[0]
  let spec = pickSpecOf(pick)
  const selectedMode = msg.pickModes?.[0]
  const hasLocator = value => value && typeof value === 'object' &&
    ['css', 'path', 'xpath'].some(key => typeof value[key] === 'string' && value[key].trim() !== '')
  const locatorSignature = value => hasLocator(value)
    ? JSON.stringify(['css', 'path', 'xpath'].map(key => value[key] || ''))
    : ''
  if (!spec && ['number', 'text'].includes(selectedMode) && hasLocator(pick?.locator) &&
      locatorSignature(pick.locator) === locatorSignature(msg.locator)) {
    // A non-table metric is identified by its URL-only locator and has no
    // cell/block selector. Accept only the one target emitted by this pick and
    // retain the content-side scalar type hint.
    spec = { mode: selectedMode }
  }
  if (!spec) return { ok: false, error: 'invalid_repair_pick', message: '這個選取沒有可用的定位規格' }
  const locator = msg.locator && typeof msg.locator === 'object' ? structuredClone(msg.locator) : {}
  if (!hasLocator(locator)) return { ok: false, error: 'invalid_repair_pick', message: '這個選取沒有可用的定位規格' }
  const frame = frameDescriptorOf(sender, msg)
  const source = { locator, ...(frame?.url ? { frame: { url: frame.url } } : {}) }
  // One-shot grant: duplicate delivery cannot repair twice, and a worker restart
  // naturally loses the grant so old page messages fail closed.
  fieldRepairSessions.delete(grant.sessionId)
  let found = false
  let replacement = null
  let archivedField = null
  const oldSeriesId = seriesIdOf(grant.taskId, grant.fieldKey)
  const [updated] = await updateTasks([grant.taskId], task => {
    const fields = Array.isArray(task.fields) ? task.fields : []
    const field = fields.find(item => item?.key === grant.fieldKey)
    const specs = Array.isArray(task.spec?.fields) ? task.spec.fields : []
    const entry = specs.find(item => item?.key === grant.fieldKey)
    if (!field || !entry || task.mode !== 'multi') return null
    const previous = entry.spec || (entry.cell ? { cell: entry.cell } : entry.block ? { block: entry.block } : {})
    if (grant.repairMode === 'repair' &&
        (Boolean(previous.cell) !== Boolean(spec.cell) || Boolean(previous.block) !== Boolean(spec.block))) {
      return null
    }
    const next = structuredClone(spec)
    if (next.cell && previous.cell) {
      for (const axis of ['row', 'col']) {
        if (previous.cell[axis]?.pos && next.cell[axis]) next.cell[axis].pos = previous.cell[axis].pos
      }
      if (!next.cell.inner && previous.cell.inner) next.cell.inner = structuredClone(previous.cell.inner)
    } else if (next.block && previous.block) {
      for (const key of ['aggregate', 'skip', 'exclude', 'pos', 'inner']) {
        if (next.block[key] === undefined && previous.block[key] !== undefined) next.block[key] = structuredClone(previous.block[key])
      }
    }
    if (grant.repairMode === 'replace') {
      const newKey = `field-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
      const fieldIndex = fields.findIndex(item => item?.key === grant.fieldKey)
      const name = defaultFieldName(pick, fields.length + 1)
      const mode = ['number', 'text'].includes(selectedMode) ? selectedMode : (field.mode || pick.mode || 'number')
      const oldAlerts = (Array.isArray(task.alerts) ? task.alerts : []).filter(alert => alert?.field === grant.fieldKey)
      task.archivedFields = Array.isArray(task.archivedFields) ? task.archivedFields : []
      archivedField = {
        key: grant.fieldKey, name: field.name || grant.fieldKey, mode: field.mode,
        source: structuredClone(entry.source || field.source || {}), spec: structuredClone(previous),
        alerts: structuredClone(oldAlerts), archivedAt: new Date().toISOString()
      }
      task.archivedFields.push(archivedField)
      task.fields[fieldIndex] = { ...field, key: newKey, name, mode }
      entry.key = newKey
      entry.name = name
      entry.mode = mode
      entry.source = source
      entry.spec = next
      task.alerts = (Array.isArray(task.alerts) ? task.alerts : []).filter(alert => alert?.field !== grant.fieldKey)
      if (task.alerts.length === 0) delete task.alerts
      replacement = { oldFieldKey: grant.fieldKey, newFieldKey: newKey, name, oldSeriesId }
    } else {
      entry.source = source
      entry.spec = next
      // Legacy normalized copies are removed so future reads use this single spec.
      delete entry.cell
      delete entry.block
    }
    found = true
    return task
  })
  if (!updated || !found) return { ok: false, error: 'field_not_found', message: '這個值已移除或選取類型不同，沒有套用重選結果' }
  if (replacement) {
    await pruneSeries([replacement.oldSeriesId])
    await deleteLastValues([replacement.oldSeriesId])
    await rebuildAlarms()
  }
  const resultFieldKey = replacement?.newFieldKey || grant.fieldKey
  const repaired = updated.spec.fields.find(item => item.key === resultFieldKey)
  const result = { ok: true, taskId: updated.id, fieldKey: resultFieldKey,
    source: structuredClone(repaired.source), spec: structuredClone(repaired.spec) }
  if (replacement) Object.assign(result, replacement, {
    repairMode: 'replace', fieldName: replacement.name,
    archivedField: structuredClone(archivedField)
  })
  try { await chrome.runtime.sendMessage({ type: 'FIELD_REPAIR_DONE', ...result }) } catch {}
  try { await chrome.tabs.remove(grant.tabId) } catch {}
  return result
}

function frameDescriptorOf(sender, extra = {}) {
  const frameId = sender?.frameId
  if (frameId === undefined || frameId === 0) return undefined
  const url = typeof sender?.url === 'string' && sender.url.trim() !== ''
    ? sender.url
    : (typeof extra.frameUrl === 'string' ? extra.frameUrl : '')
  if (!url) return undefined
  const anchor = extra.frameAnchor ?? extra.frame?.anchor
  return {
    url,
    ...(anchor && typeof anchor === 'object' ? { anchor: structuredClone(anchor) } : {})
  }
}

// task/source 與 draft value 的持久格式只允許穩定網址；iframe 的 anchor
// 只供本輪進出 frame 時核對，不能混進日後 buildTask 會保存的 source。
function stableFrameOf(sender, extra = {}) {
  const frame = frameDescriptorOf(sender, extra)
  return frame ? { url: frame.url } : undefined
}

function frameStateOf(tabId) {
  return activePickFrames.get(tabId) || null
}

function rememberPickFrame(tabId, state) {
  if (!Number.isInteger(tabId) || !state || !Number.isInteger(state.frameId)) return
  activePickFrames.set(tabId, { ...state })
}

function forgetPickFrame(tabId) {
  activePickFrames.delete(tabId)
}

function rememberPickParticipant(tabId, sessionId, sender) {
  if (!Number.isInteger(tabId) || typeof sessionId !== 'string' || !Number.isInteger(sender?.frameId)) return
  let state = pickParticipantFrames.get(tabId)
  if (!state || state.sessionId !== sessionId) state = { sessionId, frames: new Map() }
  state.frames.set(sender.frameId, {
    url: sender.frameId === 0 ? '' : (sender.url || ''),
    ...(typeof sender.documentId === 'string' && sender.documentId ? { documentId: sender.documentId } : {})
  })
  pickParticipantFrames.set(tabId, state)
}

async function drainPickDraft(tabId, draft, timeoutMs, resume = false) {
  if (!draft || !Number.isInteger(tabId)) return { ok: false, message: '選取草稿不存在，無法同步' }
  const registered = pickParticipantFrames.get(tabId)
  const activeBeforeDrain = frameStateOf(tabId)
  const hasQueuedValues = (draft.groups || []).some(group => (group.values || []).length > 0)
  // Before the first value is selected, the panel may safely create/switch its
  // initial group without any page content frame participating in the session.
  if (!hasQueuedValues && registered?.sessionId !== draft.sessionId && activeBeforeDrain?.sessionId !== draft.sessionId) {
    return { ok: true }
  }
  const listed = await listFrames(tabId)
  const targets = new Set()
  if (registered?.sessionId === draft.sessionId) {
    for (const [frameId, identity] of registered.frames) {
      const frame = listed.find(item => item.frameId === frameId)
      if (!frame || (identity.url && frame.url !== identity.url) ||
          (identity.documentId && frame.documentId && frame.documentId !== identity.documentId)) {
        return { ok: false, message: '有參與選取的框架已失聯或文件已變更，請重新進入該框架後重試' }
      }
      targets.add(frameId)
    }
  }
  const urls = new Set()
  for (const group of draft.groups || []) for (const value of group.values || []) {
    const url = value?.source?.frame?.url
    if (typeof url === 'string' && url) urls.add(url)
  }
  let tabUrl = ''
  try { tabUrl = (await chrome.tabs.get(tabId))?.url || '' } catch {}
  if (tabUrl) urls.add(tabUrl)
  for (const url of urls) {
    const matches = listed.filter(frame => frame.url === url)
    if (matches.length !== 1) return { ok: false, message: matches.length ? '找到多個相同網址的框架，無法確認所有選取都已同步' : '有參與選取的框架已失聯，請返回頁面重試' }
    targets.add(matches[0].frameId)
  }
  if (!targets.size) return { ok: false, message: '找不到可同步的選取框架，請返回頁面重試' }
  const active = frameStateOf(tabId)
  if (active?.sessionId === draft.sessionId) targets.add(active.frameId)
  let failure = null
  for (const frameId of targets) {
    try {
      const response = await sendToFrame(tabId, {
        type: MSG.PICK_DRAIN, sessionId: draft.sessionId, resume,
        documentGeneration: draft.documentGeneration, routeIdentity: draft.routeIdentity
      }, frameId, timeoutMs, 'Drain picker queue')
      if (response?.ok !== true) { failure = response?.message || '有選取尚未同步，請重試'; break }
    } catch {
      failure = '有參與選取的框架沒有回覆同步確認，請返回該框架重試'
      break
    }
  }
  if (failure && !resume) {
    await Promise.all([...targets].map(frameId => sendToFrame(tabId, {
      type: MSG.PICK_DRAIN, sessionId: draft.sessionId, resume: true,
      documentGeneration: draft.documentGeneration, routeIdentity: draft.routeIdentity
    }, frameId, timeoutMs, 'Resume picker after failed drain').catch(() => null)))
    return { ok: false, message: failure }
  }
  if (failure) return { ok: false, message: failure }
  return { ok: true }
}

function pickIdentityOf(msg = {}) {
  const activeGroupKey = msg.activeGroupKey ?? msg.groupKey
  return {
    ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
    ...(msg.groupKey !== undefined ? { groupKey: msg.groupKey } : {}),
    ...(activeGroupKey !== undefined ? { activeGroupKey } : {}),
    ...(msg.documentGeneration !== undefined ? { documentGeneration: structuredClone(msg.documentGeneration) } : {}),
    ...(msg.routeIdentity !== undefined ? { routeIdentity: structuredClone(msg.routeIdentity) } : {})
  }
}

function pickTransitionError(hint, candidates = []) {
  const ambiguous = hint === 'frame_ambiguous'
  return {
    ok: false,
    error: ambiguous ? 'frame_ambiguous' : 'frame_unavailable',
    retryable: true,
    hint,
    candidates: Array.isArray(candidates) ? candidates : [],
    message: ambiguous ? '找到了多個相同網址的框架，請重新選取要進入的框架' : '目前無法進入這個框架，請重試'
  }
}


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
    if (!spec) return []
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
  // 少掉的序列：它們的卡片來源與 lastValues 會變成孤兒，呼叫端要清（紀錄一律保留）。
  // 單值任務變成多值時，原本那一條序列的 id 就是任務 id 本身（SPEC §7），同樣不會再有新紀錄
  return hadFields ? matched.removed.map(k => seriesIdOf(task.id, k)) : [task.id]
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

// 晚超過這麼久才觸發的 daily alarm 不執行（把今天的值寫進好幾天前那格沒有意義），那一格交給錯過清單
const DAILY_STALE_MS = 24 * 60 * 60 * 1000

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
      // 只重排自己那個任務；全部重建只留給 REBUILD_ALARMS、安裝、啟動
      await schedulePrechecks(Date.now(), { taskId: precheck.taskId })
      return
    }

    // 4. 重試機制
    const retry = parseRetryName(name)
    if (retry !== null) {
      const { task, active } = await getValidTask(retry.taskId)
      if (!task || !active) return
      // 重試補的是原本那一格;舊格式沒帶槽時才退回當下時刻
      const retrySlot = retry.slot || slotOf(Date.now())
      await runTask(task, { slot: retrySlot, attempt: retry.attempt + 1, markLate: isLateStart(retrySlot, Date.now()), ...testOpts })
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
      // interval 與 daily 都是 one-shot alarm,必須先把下一次排好,任何提早 return 或例外都不能跳過重排
      if (task.schedule?.type === 'interval') {
        const nextWhen = nextIntervalRun(task, Date.now())
        if (nextWhen !== null) await chrome.alarms.create(alarm.name, { when: nextWhen })
        // 用「排定時刻」判斷時段,不是實際觸發時刻:
        // 晚觸發(休眠喚醒、worker 冷啟動)會滑出時段末端,把本來合法的那一格丟掉
        const decideAt = alarm.scheduledTime ?? Date.now()
        if (!shouldRunInterval(task, decideAt)) return
      }
      if (task.schedule?.type === 'daily') {
        const times = task.schedule.times
        const weekdays = task.schedule.weekdays ?? task.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
        if (Array.isArray(times) && times[parsed.index]) {
          const when = nextDailyRun(Date.now(), [times[parsed.index]], weekdays)
          if (when !== null) await chrome.alarms.create(alarm.name, { when })
        }
        if (typeof alarm.scheduledTime === 'number' && Date.now() - alarm.scheduledTime > DAILY_STALE_MS) return
      }

      // 槽一律取 alarm 排定時刻:晚觸發(跨日)不可寫進隔天那一格,冪等帳本與錯過清單都靠它
      const slot = slotOf(alarm.scheduledTime ?? Date.now())
      await runTask(task, { slot, markLate: isLateStart(slot, Date.now()), ...testOpts })
      await refreshBadge()
    }
  } catch (err) {
    // 寫診斷本身失敗才吞掉
    await diag.log('alarm_error', `${alarm?.name}：${String(err?.message || err)}`).catch(() => {})
  }
}

// 處理內部訊息分派
// 送訊息那個 frame 的身分；最上層不留欄位（舊任務零遷移的前提）
function frameIdentityOf(sender, extra = {}) {
  if (sender?.frameId === undefined || sender.frameId === 0) return {}
  const frame = stableFrameOf(sender, extra)
  return {
    frameId: sender.frameId,
    frameUrl: sender.url,
    ...(frame ? { frame } : {})
  }
}

// 選取結果 → 面板要的 payload（逐欄挑，補上分頁與框架身分）；單任務與批次每一組共用這一份
function taskPayloadOf(src, sender, msg = {}) {
  const frame = stableFrameOf(sender, msg)
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
    picks: src?.picks,
    ...(frame ? { source: { frame } } : {}),
    ...pickIdentityOf(msg)
  }
  Object.assign(payload, frameIdentityOf(sender, msg))
  // C2a 的跨 frame 草稿尚未進入正式 task schema；先把每個值的來源以可序列化
  // 形狀留在 panel ctx，後續設定頁接線時不必猜「這批值原本在哪一層」。
  if (Array.isArray(payload.picks)) {
    payload.valueSources = payload.picks.map((spec) => ({
      locator: payload.locator,
      ...(frame ? { frame } : {}),
      spec: structuredClone(spec)
    }))
  }
  return payload
}

function hashStable(value) {
  const text = stableValue(value)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function valueModeOf(pick, payload, index = 0) {
  if (typeof pick?.mode === 'string' && pick.mode.trim() !== '') return pick.mode
  const hinted = payload?.pickModes?.[index] ?? payload?.valueModes?.[index]
  if (hinted === 'number' || hinted === 'text' || hinted === 'block') return hinted
  if (pick?.block) return 'block'
  // A single value can use its actual preview as a fallback. For multiple
  // values content supplies one explicit mode per value; otherwise remain
  // undecided instead of guessing text from a missing preview.
  if (Array.isArray(payload?.picks) && payload.picks.length === 1 && typeof payload.preview === 'string') {
    return parseNumber(payload.preview) !== null ? 'number' : 'text'
  }
  return 'pending'
}

function draftValueOf(payload, pick, sender, msg, index = 0) {
  const frame = stableFrameOf(sender, msg)
  const locator = payload?.locator ? structuredClone(payload.locator) : {}
  const rawSpec = pickSpecOf(pick) || {}
  // pickSpecOf keeps optional fields explicit for comparison; the draft
  // serializer accepts JSON data only, so drop undefined optional members.
  const spec = JSON.parse(JSON.stringify(rawSpec))
  const source = pickSourceOf({
    locator,
    ...(frame ? { frame } : {})
  }) || { locator }
  // B2 identity ignores position-only and block skip/exclude settings.
  const identitySpec = stripPos(spec)
  const identity = {
    source,
    spec: identitySpec
  }
  const value = {
    key: `pick-${hashStable(identity)}`,
    mode: valueModeOf(pick, payload, index),
    source,
    spec,
    locator,
    ...(payload?.preview !== undefined ? { preview: payload.preview } : {}),
    ...(payload?.previewValue !== undefined ? { previewValue: payload.previewValue } : {})
  }
  return value
}

async function extensionDraftSender(tabId) {
  let url = 'chrome-extension://autofetcher/ui/picker/picker.html'
  try {
    if (typeof chrome?.runtime?.getURL === 'function') url = await chrome.runtime.getURL('ui/picker/picker.html')
  } catch {}
  return { url, tab: { id: tabId }, frameId: 0 }
}

// Content 端仍只能送 PICKED；background 在收到它後，以 C1b add operation
// 逐值寫入同一份 draft。operation id 由 content 的一次 PICKED 操作加值索引
// 派生；同一 source/spec 則即使換了 operation id 也保持冪等。
async function appendPickedToDraft(msg, sender, payload = msg) {
  const tabId = sender?.tab?.id
  const groupKey = msg?.groupKey ?? msg?.activeGroupKey
  if (msg?.purpose !== 'task' || !Number.isInteger(tabId) || typeof msg?.sessionId !== 'string' ||
      typeof groupKey !== 'string' || !Array.isArray(payload?.picks)) return null

  const draft = await getPickDraft(tabId, { sessionId: msg.sessionId })
  if (!draft) {
    return { ok: false, error: 'missing_draft', retryable: true, message: '選取草稿已不存在，請重新開始這一輪選取' }
  }
  if (!draft.groups.some(group => group.key === groupKey)) {
    return { ok: false, error: 'group_not_found', retryable: true, message: '目前作用中的選取組已不存在，請重新選取' }
  }
  if (!draftRouteMatchesTab(draft.routeIdentity, sender?.tab?.url)) {
    return { ok: false, error: 'stale_route', retryable: true, message: '目前頁面路徑已變更，請重新確認來源後再選取' }
  }
  if (!draftIdentityMatches(msg, draft)) {
    return { ok: false, error: 'stale_document', retryable: true, message: '頁面已變更，請重新整理後再選取' }
  }

  const operationSender = await extensionDraftSender(tabId)
  let latest = draft
  try {
    const operationBase = typeof msg.operationId === 'string' && msg.operationId.trim() !== ''
      ? msg.operationId
      : `background-pick:${draft.sessionId}:${groupKey}:${Date.now()}-${Math.random().toString(36).slice(2)}`
    for (const [index, pick] of payload.picks.entries()) {
      const value = draftValueOf(payload, pick, sender, msg, index)
      const group = latest.groups.find(item => item.key === groupKey)
      if (group?.values.some(existing => sameSpec(existing, value))) continue
      const operationId = `${operationBase}:${index}`
      const result = await handlePickDraftOperation({
        type: MSG.PICK_DRAFT_OPERATION,
        operationId,
        expectedRevision: latest.revision,
        sessionId: draft.sessionId,
        tabId,
        operation: { type: 'add', groupKey, value }
      }, operationSender)
      if (!result?.ok || !result.draft) return result || { ok: false, error: 'draft_write_failed', retryable: true }
      latest = result.draft
    }
    // 新群組模式點已選值＝移除；仍沿用 PICKED content 白名單，background
    // 以同一份 source/spec 找回穩定 value key，再走正式 remove operation。
    if (Array.isArray(payload?.removePicks)) {
      for (const [index, pick] of payload.removePicks.entries()) {
        const value = draftValueOf(payload, pick, sender, msg, index)
        const group = latest.groups.find(item => item.key === groupKey)
        const existing = group?.values.find(item => sameSpec(item, value))
        if (!existing) continue
        const operationId = `${operationBase}:remove:${index}`
        const result = await handlePickDraftOperation({
          type: MSG.PICK_DRAFT_OPERATION,
          operationId,
          expectedRevision: latest.revision,
          sessionId: draft.sessionId,
          tabId,
          operation: { type: 'remove', groupKey, valueKey: existing.key }
        }, operationSender)
        if (!result?.ok || !result.draft) return result || { ok: false, error: 'draft_write_failed', retryable: true }
        latest = result.draft
      }
    }
    // Context-menu exclude/include edits replace the selector atomically. Keep
    // the original value key/source so ACK retries and source identity remain stable.
    if (Array.isArray(payload?.replacePicks)) {
      for (const [index, item] of payload.replacePicks.entries()) {
        const pick = item?.pick
        const value = draftValueOf(payload, pick, sender, msg, index)
        const group = latest.groups.find(entry => entry.key === groupKey)
        const existing = group?.values.find(entry => sameSpec(entry, value))
        if (!existing) continue
        const replacement = {
          ...value,
          key: existing.key,
          source: structuredClone(existing.source),
          locator: structuredClone(existing.locator || value.locator)
        }
        const operationId = `${operationBase}:replace:${index}`
        const result = await handlePickDraftOperation({
          type: MSG.PICK_DRAFT_OPERATION,
          operationId,
          expectedRevision: latest.revision,
          sessionId: draft.sessionId,
          tabId,
          operation: { type: 'replace-value', groupKey, valueKey: existing.key, value: replacement }
        }, operationSender)
        if (!result?.ok || !result.draft) return result || { ok: false, error: 'draft_write_failed', retryable: true }
        latest = result.draft
      }
    }
  } catch (error) {
    const response = protocolErrorResponse(error)
    return response || { ok: false, error: 'draft_write_failed', retryable: true, message: String(error?.message || error) }
  }

  await mergePanelCtx(tabId, {
    pickDraft: latest,
    pickSessionId: latest.sessionId,
    pickGroupKey: groupKey
  })
  return { ok: true, draft: latest, revision: latest.revision }
}

// F1a：完成屏障取得的 immutable snapshot 是跨面板的唯一選取結果；
// 這裡把單一群組的值轉成設定頁可直接 render 的欄位形狀。
// 每個 field 的來源與單值 spec 都保留，不能退回以第一個 locator 假裝整組同源。
async function pickerContextOfSnapshot(snapshot) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : []
  const group = groups.find(item => Array.isArray(item?.values) && item.values.length > 0) || groups[0]
  const values = Array.isArray(group?.values) ? group.values : []
  const fields = values.map((value, index) => ({
    key: value.key,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : `值 ${index + 1}`,
    mode: value.mode === 'text' || value.mode === 'block' ? value.mode : 'number',
    source: structuredClone(value.source || { locator: value.locator || {} }),
    spec: structuredClone(value.spec || {})
  }))
  let url = typeof snapshot?.routeIdentity?.url === 'string' ? snapshot.routeIdentity.url : ''
  try {
    const tabUrl = (await chrome.tabs.get(snapshot?.tabId))?.url
    if (typeof tabUrl === 'string' && tabUrl) url = tabUrl
  } catch {}
  const first = fields[0]
  return {
    tabId: snapshot?.tabId,
    url,
    nameHint: group?.name || '',
    locator: first?.source?.locator,
    ...(first?.source?.frame?.url ? { frameUrl: first.source.frame.url, frame: first.source.frame } : {}),
    picks: fields.map(field => structuredClone(field.spec)),
    valueSources: fields.map(field => ({ locator: structuredClone(field.source.locator), ...(field.source.frame ? { frame: structuredClone(field.source.frame) } : {}) })),
    fields
  }
}

function pickerBatchItemsOfSnapshot(snapshot, baseCtx = {}) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : []
  return groups.map((group, groupIndex) => {
    const values = Array.isArray(group?.values) ? group.values : []
    const fields = values.map((value, index) => ({
      key: value.key,
      name: typeof value.name === 'string' && value.name.trim() ? value.name : `值 ${index + 1}`,
      mode: value.mode === 'text' || value.mode === 'block' ? value.mode : 'number',
      source: structuredClone(value.source || { locator: value.locator || {} }),
      spec: structuredClone(value.spec || {})
    }))
    const first = fields[0]
    return {
      key: group.key || `g${groupIndex + 1}`,
      nameHint: typeof group.name === 'string' ? group.name : '',
      tabId: snapshot?.tabId,
      url: baseCtx.url || snapshot?.routeIdentity?.url || '',
      locator: first?.source?.locator || {},
      ...(first?.source?.frame?.url ? { frameUrl: first.source.frame.url, frame: first.source.frame } : {}),
      picks: fields.map(field => structuredClone(field.spec)),
      valueSources: fields.map(field => ({
        locator: structuredClone(field.source?.locator || {}),
        ...(field.source?.frame ? { frame: structuredClone(field.source.frame) } : {})
      })),
      fields,
      taskSaveState: group.taskSaveState || group.saveState || 'pending',
      firstRunState: group.firstRunState || 'pending',
      saveState: group.taskSaveState || group.saveState || 'pending',
      ...(group.taskId ? { taskId: group.taskId } : {})
    }
  })
}

async function markPickSnapshotSettings(snapshot) {
  return updatePickDraft(snapshot.tabId, current => ({
    ...current,
    stage: 'settings',
    paused: false
  }), {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    documentGeneration: snapshot.documentGeneration,
    documentIdentity: snapshot.documentIdentity,
    routeIdentity: snapshot.routeIdentity,
    frame: snapshot.frame
  })
}

// D1a/D1b 取名請求只啟動 content 的取名狀態；不得把頁面文字當成 PICKED 或寫進值草稿。
async function requestGroupNamePick(msg) {
  const tabId = msg?.tabId
  if (!Number.isInteger(tabId) || typeof msg?.sessionId !== 'string' || typeof msg?.groupKey !== 'string' ||
      typeof msg?.requestId !== 'string' || msg.requestId.trim() === '') {
    return { ok: false, error: 'invalid_group_name_request', message: '取名請求缺少工作階段身分' }
  }
  const draft = await getPickDraft(tabId, { sessionId: msg.sessionId })
  if (!draft || !draft.groups.some(group => group.key === msg.groupKey)) {
    return { ok: false, error: 'group_not_found', message: '目前群組已不存在，請重新整理面板' }
  }
  if (!draftIdentityMatches(msg, draft)) {
    return { ok: false, error: 'stale_document', message: '頁面已變更，請重新整理後再取名' }
  }
  if (draft.activeGroupKey !== msg.groupKey) {
    return { ok: false, error: 'inactive_group', message: '請先切換到要命名的群組，再從頁面取名' }
  }
  let active = frameStateOf(tabId)
  let frameId = active?.frameId ?? 0
  if (active && (active.sessionId !== msg.sessionId || !draftIdentityMatches(msg, active))) {
    return { ok: false, error: 'group_conflict', message: '目前頁面選取階段已切換，請重新取名' }
  }
  // set-active drains every participant but deliberately leaves the last frame
  // identity tagged with the previous group. A page-name gesture belongs to the
  // currently active group; after a drain barrier it can safely move to the top
  // document, where text outside the previously selected iframe is reachable.
  if (active && active.groupKey && active.groupKey !== msg.groupKey) {
    const drained = await drainPickDraft(tabId, draft, CONTENT_MESSAGE_TIMEOUT_MS)
    if (!drained.ok) return { ok: false, error: 'drain_failed', retryable: true, message: drained.message }
    const latest = await getPickDraft(tabId, { sessionId: msg.sessionId })
    active = frameStateOf(tabId)
    if (!latest || latest.activeGroupKey !== msg.groupKey || latest.sessionId !== msg.sessionId ||
        !draftIdentityMatches(msg, latest) || !active || active.sessionId !== msg.sessionId || !draftIdentityMatches(msg, active)) {
      return { ok: false, error: 'group_conflict', retryable: true, message: '目前頁面選取階段已切換，請重新取名' }
    }
    frameId = 0
    rememberPickFrame(tabId, { ...active, frameId, groupKey: msg.groupKey })
    try { await injectContent(tabId, { frameId }) } catch (error) {
      return { ok: false, error: 'name_pick_unavailable', retryable: true, message: String(error?.message || error) }
    }
  }
  let expectedUrl = ''
  try { expectedUrl = (await chrome.tabs.get(tabId))?.url || '' } catch {}
  try {
    await sendToFrame(tabId, {
      type: MSG.PICK_GROUP_NAME,
      tabId,
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      groupKey: msg.groupKey,
      documentGeneration: draft.documentGeneration,
      routeIdentity: draft.routeIdentity
    }, frameId, CONTENT_MESSAGE_TIMEOUT_MS, 'Enter group name pick')
    groupNamePickRequests.set(tabId, {
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      groupKey: msg.groupKey,
      documentGeneration: structuredClone(draft.documentGeneration),
      routeIdentity: structuredClone(draft.routeIdentity),
      frameId,
      expectedUrl
    })
    return { ok: true, frameId }
  } catch (error) {
    return { ok: false, error: 'name_pick_unavailable', message: String(error?.message || error), retryable: true }
  }
}

function draftIdentityMatches(message, draft) {
  for (const field of ['documentGeneration', 'routeIdentity']) {
    if (message?.[field] !== undefined && stableValue(message[field]) !== stableValue(draft?.[field])) return false
  }
  return true
}

function draftRouteMatchesTab(routeIdentity, tabUrl) {
  const expectedUrl = routeIdentity && typeof routeIdentity === 'object' && typeof routeIdentity.url === 'string'
    ? routeIdentity.url
    : ''
  return !expectedUrl || expectedUrl === tabUrl
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableValue(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// 同一草稿／同一組收到另一個 frame 的 PICKED 時追加值；跨 frame 不能把前一層
// 的 ctx 當成 retarget 覆寫掉。相同來源重送只留一份，避免重試製造重複值。
function mergeFramePickPayload(previous, next) {
  if (!previous || !next || !Array.isArray(previous.picks) || !Array.isArray(next.picks)) return next
  const oldSources = Array.isArray(previous.valueSources) ? previous.valueSources : []
  const newSources = Array.isArray(next.valueSources) ? next.valueSources : []
  const keys = new Set(oldSources.map(stableValue))
  const picks = previous.picks.slice()
  const valueSources = oldSources.map((item) => structuredClone(item))
  next.picks.forEach((pick, i) => {
    const source = newSources[i] || { locator: next.locator, spec: pick }
    const key = stableValue(source)
    if (keys.has(key)) return
    keys.add(key)
    picks.push(structuredClone(pick))
    valueSources.push(structuredClone(source))
  })
  return {
    ...next,
    picks,
    valueSources,
    // 顯示用的共用預覽取最新 frame，但保留前面各值的來源清單。
    source: next.source || previous.source
  }
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
function pickEntryOf(ctx, batch, sessionId, groupKey, tabId) {
  if (canStartPick(ctx)) return { start: true }
  if (ctx?.kind === 'bulk') return { blocked: '有一批任務的排程改到一半，請先套用或取消，再開始選取' }
  if (batch) {
    if (ctx?.kind === 'new' && ctx.batch === true) {
      const draft = ctx.pickDraft
      const validDraftEntry = typeof sessionId === 'string' && draft?.sessionId === sessionId &&
        draft?.tabId === tabId && draft?.activeGroupKey === groupKey &&
        Array.isArray(draft?.groups) && draft.groups.some(group => group?.key === groupKey)
      if (validDraftEntry) return { start: false }
      return { blocked: '多值選取草稿或作用組已變更，請重新整理草稿後再試' }
    }
    return { blocked: ctx.kind === 'batch'
      ? '多任務清單還沒存，請先全部儲存或取消，再開始新的多任務'
      : '有一個任務設定到一半，請先儲存或取消，再開始多任務' }
  }
  if (ctx.kind === 'batch') return { blocked: '多任務設定到一半，請先全部儲存或取消，再選單一任務' }
  return { start: false }
}

// 依 pickEntryOf 的結果處理面板 ctx；回傳 false＝被擋（已留說明），呼叫端不得進選取模式
async function applyPickEntry(tabId, batch, sessionId, groupKey, documentGeneration, routeIdentity) {
  const ctx = await getPanelCtx(tabId)
  if (batch && ctx?.kind === 'new' && ctx.batch === true) {
    const draft = typeof sessionId === 'string'
      ? await getPickDraft(tabId, { sessionId, documentGeneration, routeIdentity })
      : null
    const validDraftEntry = draft?.tabId === tabId && draft.activeGroupKey === groupKey &&
      Array.isArray(draft.groups) && draft.groups.some(group => group?.key === groupKey)
    if (!validDraftEntry) {
      const message = '多值選取草稿或作用組已變更，請重新整理草稿後再試'
      await mergePanelCtx(tabId, { notice: message })
      return false
    }
    return true
  }
  const entry = pickEntryOf(ctx, batch, sessionId, groupKey, tabId)
  if (entry.blocked) {
    await mergePanelCtx(tabId, { notice: entry.blocked })
    return false
  }
  if (entry.start) await setPanelCtx(tabId, batch ? { kind: 'waiting', purpose: 'task', batch: true } : { kind: 'waiting', purpose: 'task' })
  return true
}

// 選取模式相關訊息送給 content 的逾時（AF-21 批次 2 定案 6，暫定值）：
// 那幾則都是頁面上立刻完成的動作，回應遺失時不要吊到 worker 被回收
const CONTENT_MESSAGE_TIMEOUT_MS = 10000

// forbidden 診斷節流（AF-21 終檢）：同一來源（sender.url 的 origin）＋同一型別 60 秒內只寫一筆。
// 網頁若一直送，diag 環形緩衝會被洗掉；計數放模組層即可（worker 重啟歸零無妨）
const FORBIDDEN_LOG_WINDOW_MS = 60 * 1000
const forbiddenLoggedAt = new Map()

function originOfUrl(url) {
  try { return new URL(String(url ?? '')).origin } catch { return String(url ?? '') }
}

async function logForbidden(sender, type, detail) {
  const key = `${originOfUrl(sender?.url)}|${type}`
  const now = Date.now()
  const last = forbiddenLoggedAt.get(key)
  if (typeof last === 'number' && now - last < FORBIDDEN_LOG_WINDOW_MS) return
  forbiddenLoggedAt.set(key, now)
  // 過期的鍵順手清掉，Map 不會越長越大
  for (const [k, at] of forbiddenLoggedAt) {
    if (now - at >= FORBIDDEN_LOG_WINDOW_MS) forbiddenLoggedAt.delete(k)
  }
  await diag.log('forbidden', detail)
}

// 本擴充功能的來源取自 getURL('')（＝ chrome-extension://<runtime.id>/）
async function isFromContentScript(sender) {
  if (!sender?.tab) return false
  const origin = await chrome.runtime.getURL('')
  return !String(sender.url ?? '').startsWith(origin)
}

// 站台面板的「測試登入」（AF-21 批次 4）：表單上尚未儲存的設定＋明文密碼（或 useSaved 由這裡解密已存密文）。
// 密碼只活在這則訊息與函式參數裡：不寫 diag、紀錄、storage；失敗不累加站台的失敗計數
async function handleTestLogin(msg, runOpts = {}) {
  const src = msg.site && typeof msg.site === 'object' ? msg.site : {}
  const loginUrl = typeof src.loginUrl === 'string' ? src.loginUrl.trim() : ''
  let origin = ''
  try { origin = new URL(loginUrl).origin } catch {}
  if (!origin || !/^https?:/.test(loginUrl)) return { ok: false, error: '登入頁網址不是合法的網址' }
  const sel = src.selectors || {}
  if (!sel.user || !sel.pass || !sel.submit) return { ok: false, error: '帳號欄位、密碼欄位、送出按鈕都要先選好' }
  const successCheck = src.successCheck && typeof src.successCheck === 'object' ? src.successCheck : {}
  if (!['urlPrefix', 'element'].includes(successCheck.type) || typeof successCheck.value !== 'string' || !successCheck.value) {
    return { ok: false, error: '沒有設定成功判定值' }
  }
  let password = typeof msg.password === 'string' ? msg.password : ''
  if (!password && msg.useSaved === true) {
    const saved = await getSite(origin)
    if (!saved?.passwordEnc) return { ok: false, error: '沒有已儲存的密碼，請填入密碼再測' }
    try {
      password = await decryptSecret(saved.passwordEnc)
    } catch {
      return { ok: false, error: '已儲存的密碼解不開，請重新填入密碼' }
    }
  }
  if (!password) return { ok: false, error: '請填入密碼再測' }
  const site = {
    loginUrl,
    selectors: { user: sel.user, pass: sel.pass, submit: sel.submit },
    loginCheck: { type: 'urlPrefix', value: loginUrl },
    successCheck: { type: successCheck.type, value: successCheck.value },
    username: typeof src.username === 'string' ? src.username : ''
  }
  return await testLogin(site, password, runOpts)
}

export async function handleMessage(msg, sender, runOpts = {}) {
  const contentMs = runOpts.contentTimeoutMs ?? CONTENT_MESSAGE_TIMEOUT_MS
  try {
    if (!msg || typeof msg !== 'object') return undefined

    // sender 守門（AF-21 批次 3 定案 3）：有 tab 且網址不是本擴充功能頁 → content script，
    // 只准送 CONTENT_ALLOWED 內的型別。Report 開在分頁裡也有 tab，所以要連網址一起看
    if (await isFromContentScript(sender) && !CONTENT_ALLOWED.has(msg.type)) {
      await logForbidden(sender, msg.type, `${msg.type} 來自 ${sender.url}`)
      return { ok: false, error: 'forbidden' }
    }

    if (msg.type === MSG.PICK_GROUP_NAME) return await requestGroupNamePick(msg)
    if (msg.type === MSG.BEGIN_FIELD_REPAIR) return await beginFieldRepair(msg)
    if (msg.type === MSG.PICK_GROUP_NAME_RESULT) {
      const tabId = sender?.tab?.id
      const active = Number.isInteger(tabId) ? frameStateOf(tabId) : null
      const request = Number.isInteger(tabId) ? groupNamePickRequests.get(tabId) : null
      let currentTabUrl = ''
      try { currentTabUrl = Number.isInteger(tabId) ? ((await chrome.tabs.get(tabId))?.url || '') : '' } catch {}
      if (!Number.isInteger(tabId) || typeof msg.sessionId !== 'string' || typeof msg.groupKey !== 'string' ||
          typeof msg.requestId !== 'string' || !request || request.requestId !== msg.requestId ||
          request.sessionId !== msg.sessionId || request.groupKey !== msg.groupKey ||
          !draftIdentityMatches(msg, request) ||
          (request.expectedUrl && currentTabUrl && request.expectedUrl !== currentTabUrl) ||
          (active && (active.sessionId !== msg.sessionId || (active.groupKey && active.groupKey !== msg.groupKey) ||
            active.frameId !== (sender?.frameId ?? 0) || !draftIdentityMatches(msg, active))) ||
          (!active && (sender?.frameId ?? 0) !== 0)) {
        return { ok: false, error: 'stale_frame', message: '取名回報來自已失效的選取階段' }
      }
      const draft = await getPickDraft(tabId, { sessionId: msg.sessionId })
      if (!draft || draft.activeGroupKey !== msg.groupKey || !draft.groups.some(group => group.key === msg.groupKey) || !draftIdentityMatches(msg, draft)) {
        return { ok: false, error: 'group_not_found', message: '目前群組已不存在' }
      }
      try {
        await chrome.runtime.sendMessage({
          type: MSG.PICK_GROUP_NAME_RESULT,
          tabId,
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          groupKey: msg.groupKey,
          documentGeneration: draft.documentGeneration,
          routeIdentity: draft.routeIdentity,
          text: typeof msg.text === 'string' ? msg.text : ''
        })
      } catch {}
      groupNamePickRequests.delete(tabId)
      return { ok: true }
    }

    // C1b：草稿訊息只由 extension page 送出，所有變更都在 pick-protocol
    // 的 session 鎖內完成。這條路與舊 PICKED／repick 路徑分開，保留舊單任務相容性。
    if (msg.type === MSG.PICK_DRAFT_BEGIN) return await beginPickDraft(msg, sender)
    if (msg.type === MSG.PICK_DRAFT_READ) return await readPickDraftMessage(msg, sender)
    if (msg.type === MSG.PICK_DRAFT_OPERATION) {
      const operation = msg.operation || msg
      if (operation.type === 'set-active' || operation.op === 'set-active') {
        const tabId = msg.tabId ?? sender?.tab?.id
        const draft = await getPickDraft(tabId, { sessionId: msg.sessionId })
        if (!draft || draft.sessionId !== msg.sessionId) return { ok: false, error: 'stale_session', message: '選取階段已變更，請重新整理後重試' }
        const drained = await drainPickDraft(tabId, draft, contentMs)
        if (!drained.ok) return { ok: false, error: 'drain_failed', retryable: true, message: drained.message }
        const latest = await getPickDraft(tabId, { sessionId: draft.sessionId })
        if (!latest || latest.sessionId !== draft.sessionId) return { ok: false, error: 'stale_session', message: '選取階段已變更，請重新整理後重試' }
        try {
          const result = await handlePickDraftOperation({ ...msg, expectedRevision: latest.revision }, sender)
          if (!result?.ok) await drainPickDraft(tabId, latest, contentMs, true)
          return result
        } catch (error) {
          await drainPickDraft(tabId, latest, contentMs, true)
          throw error
        }
      }
      return await handlePickDraftOperation(msg, sender)
    }
    if (msg.type === MSG.PICK_DRAFT_COMPLETE) {
      const tabId = msg.tabId ?? sender?.tab?.id
      const before = await getPickDraft(tabId, { sessionId: msg.sessionId })
      if (!before || before.sessionId !== msg.sessionId) return { ok: false, error: 'stale_session', message: '選取階段已變更，請重新整理後重試' }
      if (!before.groups?.length || before.groups.some(group => !Array.isArray(group.values) || group.values.length === 0)) {
        return { ok: false, synchronized: false, error: 'empty_group', message: '每個群組完成前都必須至少有一個值' }
      }
      const drained = await drainPickDraft(tabId, before, contentMs)
      if (!drained.ok) return { ok: false, error: 'drain_failed', retryable: true, message: drained.message }
      const latest = await getPickDraft(tabId, { sessionId: before.sessionId })
      if (!latest || latest.sessionId !== before.sessionId) return { ok: false, error: 'stale_session', message: '選取階段已變更，請重新整理後重試' }
      if (!latest.groups?.length || latest.groups.some(group => !Array.isArray(group.values) || group.values.length === 0)) {
        await drainPickDraft(tabId, latest, contentMs, true)
        return { ok: false, synchronized: false, error: 'empty_group', message: '每個群組完成前都必須至少有一個值' }
      }
      let completed
      try {
        completed = await completePickDraft({ ...msg, expectedRevision: latest.revision }, sender)
      } catch (error) {
        await drainPickDraft(tabId, latest, contentMs, true)
        throw error
      }
      if (!completed?.ok) await drainPickDraft(tabId, latest, contentMs, true)
      if (completed?.ok && completed.snapshot) {
        const groups = Array.isArray(completed.snapshot.groups) ? completed.snapshot.groups : []
        if (groups.length === 0 || groups.some(group => !Array.isArray(group?.values) || group.values.length === 0)) {
          return {
            ...completed,
            ok: false,
            synchronized: false,
            error: 'empty_group',
            message: '每個群組完成前都必須至少有一個值'
          }
        }
        const previousPanel = await getPanelCtx(completed.tabId)
        const stagedDraft = await markPickSnapshotSettings(completed.snapshot)
        const ctx = await pickerContextOfSnapshot(completed.snapshot)
        const batch = previousPanel?.batch === true
        const items = batch ? pickerBatchItemsOfSnapshot(completed.snapshot, ctx) : null
        const batchNames = batch
          ? Object.fromEntries(groups.map((group, index) => [group.key, typeof group.name === 'string' && group.name.trim() ? group.name : `值 ${index + 1}`]))
          : null
        const panelContext = batch
          ? {
              kind: 'batch',
              batch: true,
              items,
              draft: { ...(completed.snapshot.form || {}), batchNames },
              pickSessionId: completed.snapshot.sessionId,
              pickGroupKey: null
            }
          : {
              kind: 'new',
              ctx,
              draft: { name: groups[0]?.name || '', ...(completed.snapshot.form || {}) },
              pickSessionId: completed.snapshot.sessionId,
              pickGroupKey: groups[0]?.key
            }
        // 完成後把設定階段寫回同一個分頁 ctx；面板重載時仍會進設定頁，
        // 而不是再次顯示「等待設定畫面」或重新建立欄位。
        await setPanelCtx(completed.tabId, panelContext)
        return { ...completed, draft: stagedDraft, context: ctx, panelContext }
      }
      return completed
    }
    if (msg.type === MSG.PICK_DRAFT_ABANDON || msg.type === MSG.PICK_DRAFT_FINALIZE) {
      const result = await abandonPickDraft(msg, sender)
      if (result?.ok) {
        const tabId = msg.tabId ?? sender?.tab?.id
        pickParticipantFrames.delete(tabId)
        forgetPickFrame(tabId)
      }
      return result
    }
    if (msg.type === MSG.PICK_DRAFT_PAUSE) {
      const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : msg.tabId
      if (msg.operationId !== undefined || msg.expectedRevision !== undefined || msg.operation) {
        return await handlePickDraftOperation({ ...msg, operation: msg.operation || { type: 'pause' } }, sender)
      }
      const draft = await pausePickDraft(tabId)
      return { ok: true, paused: Boolean(draft), draft }
    }

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
      const multi = task.mode === 'multi' || task.spec?.mode === 'multi'
      if (multi && (!Array.isArray(task.fields) || task.fields.length === 0)) {
        return { ok: false, outcome: 'failed', status: 'error', error: '多來源任務沒有可執行欄位', values: [] }
      }
      const hasDeclaredFields = Array.isArray(task.fields) && task.fields.length > 0
      const executionId = globalThis.crypto?.randomUUID?.() || `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const record = await runTask(task, {
        slot: slotOf(Date.now()),
        ...runOpts,
        reason: 'manual',
        ...(hasDeclaredFields ? { executionId } : {})
      })
      if (!record) {
        return { ok: true, outcome: 'failed', status: 'error', error: '沒有結果' }
      }
      // 多值任務要逐值回報，只回第一筆使用者看不出另外幾個值怎麼了
      let values
      if (hasDeclaredFields && typeof record.slot === 'string') {
        const recordsById = new Map()
        for (const r of await getRecordsByDate(record.slot.slice(0, 10))) {
          if (r.slot !== record.slot || r.executionId !== executionId || parentIdOf(r.taskId) !== task.id) continue
          recordsById.set(r.taskId, r)
        }
        const idx = buildSeriesIndex([task])
        values = task.fields.map(field => {
          const r = recordsById.get(seriesIdOf(task.id, field.key))
          return r ? ({
            // 按鈕就在那個任務旁邊，用值名就夠，不必每個都重複任務名
            name: idx.byId[r.taskId]?.shortName || nameOf(idx, r.taskId),
            ok: isSuccess(r),
            value: isSuccess(r) ? r.value : undefined,
            error: isSuccess(r) ? undefined : (r.error || statusTextOf(r.status))
          }) : ({ name: field.name || field.key, ok: false, error: '本次沒有結果' })
        })
        const successes = values.filter(value => value.ok).length
        // 新 multi 協定公開整批完成度；舊 block 呼叫端沿用父紀錄的成功語意。
        const outcome = multi
          ? (successes === values.length ? 'done' : successes > 0 ? 'partial' : 'failed')
          : (isSuccess(record) ? 'done' : 'failed')
        return { ok: true, outcome, status: record.status, values }
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
      const removed = await skipOne(msg.taskId, msg.slot)
      await refreshBadge()
      // 比不到就不能靜默成功：畫面上那一筆已經過期（gap 的 slot 每輪會延），要請使用者重新整理
      if (removed === 0) return { ok: false, error: '這一筆已經不在清單裡，請重新整理' }
      return { ok: true, removed }
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
      if (msg.repairSessionId !== undefined) return await applyFieldRepair(msg, sender)
      const pickedTabId = sender?.tab?.id
      const activeFrame = Number.isInteger(pickedTabId) ? frameStateOf(pickedTabId) : null
      const participant = Number.isInteger(pickedTabId) ? pickParticipantFrames.get(pickedTabId) : null
      // Legacy PICKED has no sessionId. Do not match two absent ids and then
      // dereference a participant frame map; only C2b session messages may use
      // the per-session participant document guard.
      const knownParticipant = participant && msg.sessionId !== undefined &&
        participant.sessionId === msg.sessionId
        ? participant.frames.get(sender?.frameId ?? 0)
        : null
      if (knownParticipant?.documentId && sender?.documentId && knownParticipant.documentId !== sender.documentId) {
        return { ok: false, error: 'stale_document', retryable: true, message: '這個框架的文件已重新載入，請重新進入後再選取' }
      }
      // 進入下一個 frame 後，舊文件晚到的完成回報不可覆蓋新階段。
      // 沒有 C2a session 欄位的舊單任務仍沿用既有相容路徑。
      if (activeFrame && msg.sessionId !== undefined) {
        if (activeFrame.sessionId !== msg.sessionId || activeFrame.frameId !== (sender?.frameId ?? 0)) {
          await logForbidden(sender, 'PICKED:stale-frame', `選取回報來自非作用中的框架 ${sender?.frameId ?? 0}`)
          return { ok: false, error: 'stale_frame', retryable: true, message: '這個框架的選取階段已經變更，請重試' }
        }
        if (activeFrame.groupKey !== undefined && msg.groupKey !== undefined && activeFrame.groupKey !== msg.groupKey) {
          return { ok: false, error: 'group_conflict', retryable: true, message: '目前作用中的群組已變更，請重新選取' }
        }
        if (!draftIdentityMatches(msg, activeFrame)) {
          return { ok: false, error: 'stale_document', retryable: true, message: '頁面已變更，請重新整理後再選取' }
        }
      }
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
        // 只有那個重選分頁自己送的取消才收掉它（任何網頁送一個取消就能關掉我們開的分頁，AF-21 終檢）
        if (msg.purpose === 'repick' && msg.taskId !== undefined) {
          const expected = (await getRepickTabs())[msg.taskId]
          if (!sender?.tab || sender.tab.id === expected) await closeRepickTab(msg.taskId)
        }
        return { ok: true }
      }

      // AF-22 C2a：有 C1b session/group 的選取結果，先在鎖內寫回 draft；
      // 舊的無 session PICKED 才走下面相容的 panel ctx 路徑。
      if (msg.purpose === 'task' && msg.sessionId !== undefined &&
          (msg.groupKey !== undefined || msg.activeGroupKey !== undefined)) {
        const draftResult = await appendPickedToDraft(msg, sender)
        if (draftResult?.ok === true) rememberPickParticipant(sender?.tab?.id, msg.sessionId, sender)
        if (draftResult) return draftResult
      }

      if (msg.purpose === 'task') {
        const tabId = sender?.tab?.id
        // 批次（一次建立多個任務）：每一組補上與單任務相同的欄位，另給穩定鍵；不帶舊草稿、不算換目標
        if (Array.isArray(msg.batch)) {
          const items = msg.batch.map((one, i) => ({ key: `b${i + 1}`, ...taskPayloadOf(one, sender) }))
          await setPanelCtx(tabId, { kind: 'batch', items })
          return { ok: true }
        }
        let payload = taskPayloadOf(msg, sender, msg)
        // 面板已經開著、使用者也填了一半的表單時，**只換目標**：
        // 名稱、排程、儀表板、進階設定全部留著（右鍵重選一個目標不該把表單清空）
        const existing = await getPanelCtx(tabId)
        // 面板已經關掉（暫存被清），頁面卻還在選取模式：值選好了沒有人接。
        // 使用者看到的是「選完什麼都沒發生」，沒有這一筆就查不出原因
        if (!existing) {
          await diag.log('panel_missing_on_pick', { tabId, purpose: msg.purpose })
        }
        const keepDraft = existing && (existing.kind === 'new' || existing.kind === 'edit')
        const sameFrameDraft = existing && existing.pickSessionId !== undefined &&
          msg.sessionId !== undefined && existing.pickSessionId === msg.sessionId &&
          (existing.pickGroupKey === undefined || msg.groupKey === undefined || existing.pickGroupKey === msg.groupKey)
        if (sameFrameDraft) {
          payload = mergeFramePickPayload(existing.ctx, payload)
        }
        await mergePanelCtx(tabId, {
          kind: 'new',
          ctx: payload,
          ...(msg.sessionId !== undefined ? { pickSessionId: msg.sessionId } : {}),
          ...(msg.groupKey !== undefined ? { pickGroupKey: msg.groupKey } : {}),
          retarget: Boolean(keepDraft && existing.ctx),
          // 淺層合併：被擋時留下的說明與等待態的多任務旗標不得跟到新表單上（AF-18 終檢）
          notice: undefined,
          batch: undefined
        })
        return { ok: true }
      }

      if (msg.purpose === 'repick') {
        // 只認「為了重選而開的那個分頁」送來的（AF-21 終檢）：別的網頁的 content script 也送得出 PICKED，
        // 不核對分頁的話任何頁面都能改掉任意任務的定位
        const expectedTab = (await getRepickTabs())[msg.taskId]
        const senderTab = sender?.tab?.id
        if (typeof expectedTab !== 'number' || senderTab !== expectedTab) {
          await logForbidden(sender, 'PICKED:repick', `重選 ${msg.taskId} 來自分頁 ${senderTab}（${sender?.url}），不是重選開的分頁 ${expectedTab}`)
          return { ok: false, error: 'forbidden' }
        }
        // 鎖內讀最新的任務再套用重選，不會把同時寫入的 notFoundStreak 之類洗掉
        let orphanSeries = []
        const [task] = await updateTasks([msg.taskId], (t) => {
          t.locator = msg.locator
          orphanSeries = applyRepick(t, Array.isArray(msg.picks) ? msg.picks : [])
          return t
        })
        if (!task) {
          return { ok: true }
        }
        // 被移除的值：清掉它們在儀表板上的來源與最後一次的值，紀錄留到保留天數自然到期。
        // 不清的話卡片會一直指著不存在的序列，使用者只看得到一張永遠空白的卡
        if (Array.isArray(orphanSeries) && orphanSeries.length > 0) {
          await pruneSeries(orphanSeries)
          await deleteLastValues(orphanSeries)
          await diag.log('fields_pruned', { taskId: task.id, series: orphanSeries })
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
      const fromFrameId = sender?.frameId ?? 0
      const activeFrame = frameStateOf(tabId)
      if (msg.sessionId !== undefined && activeFrame &&
          (activeFrame.sessionId !== msg.sessionId || activeFrame.frameId !== fromFrameId)) {
        return { ok: false, error: 'stale_frame', retryable: true, message: '這個框架的選取階段已經變更，請重試' }
      }
      if (msg.direction === 'ascend') {
        if (!activeFrame || activeFrame.frameId !== fromFrameId || !Number.isInteger(activeFrame.parentFrameId)) {
          return { ok: false, error: 'frame_parent_unknown', retryable: true, message: '找不到這個框架的上一層，請重新進入選取' }
        }
        const parentId = activeFrame.parentFrameId
        const enterParent = {
          type: MSG.ENTER_PICK,
          purpose: msg.purpose,
          taskId: msg.taskId,
          ...pickIdentityOf(msg),
          ...(msg.documentGeneration !== undefined ? { documentGeneration: structuredClone(msg.documentGeneration) } : {}),
          ...(msg.routeIdentity !== undefined ? { routeIdentity: structuredClone(msg.routeIdentity) } : {}),
          ...(msg.draftValues !== undefined ? { draftValues: structuredClone(msg.draftValues) } : {}),
          ...(msg.draftRevision !== undefined ? { draftRevision: msg.draftRevision } : {}),
          ...(activeFrame.parentFrame ? { frame: activeFrame.parentFrame } : {})
        }
        try { await sendToFrame(tabId, { type: MSG.EXIT_PICK, ...pickIdentityOf(msg) }, fromFrameId, contentMs, 'Exit child pick frame') } catch {}
        try {
          await injectContent(tabId, { frameId: parentId })
          const entered = await sendToFrame(tabId, enterParent, parentId, contentMs, 'Enter parent pick frame')
          const expectedGroup = msg.activeGroupKey ?? msg.groupKey
          if (expectedGroup !== undefined && entered?.activeGroupKey !== expectedGroup) {
            const err = new Error('active_group_not_confirmed')
            err.code = 'group_conflict'
            throw err
          }
          rememberPickFrame(tabId, {
            frameId: parentId,
            sessionId: msg.sessionId,
            groupKey: msg.groupKey,
            ...(msg.documentGeneration !== undefined ? { documentGeneration: structuredClone(msg.documentGeneration) } : {}),
            ...(msg.routeIdentity !== undefined ? { routeIdentity: structuredClone(msg.routeIdentity) } : {}),
            ...(activeFrame.parentFrame ? { frame: activeFrame.parentFrame } : {})
          })
          return { ok: true, frameId: parentId, activeGroupKey: msg.activeGroupKey ?? msg.groupKey }
        } catch (err) {
          try {
            await injectContent(tabId, { frameId: fromFrameId })
            await sendToFrame(tabId, { ...enterParent, hint: 'frame_not_found', frameError: 'parent_inject_denied' }, fromFrameId, contentMs, 'Resume child pick frame')
          } catch {}
          return { ...pickTransitionError('frame_unavailable'), detail: String(err?.message || err) }
        }
      }
      const enter = {
        type: MSG.ENTER_PICK,
        purpose: msg.purpose,
        taskId: msg.taskId,
        preselect: msg.preselect,
        ...pickIdentityOf(msg),
        ...(msg.documentGeneration !== undefined ? { documentGeneration: structuredClone(msg.documentGeneration) } : {}),
        ...(msg.routeIdentity !== undefined ? { routeIdentity: structuredClone(msg.routeIdentity) } : {}),
        ...(msg.draftValues !== undefined ? { draftValues: structuredClone(msg.draftValues) } : {}),
        ...(msg.frameAnchor ? { frameAnchor: msg.frameAnchor } : {}),
        ...(msg.draftRevision !== undefined ? { draftRevision: msg.draftRevision } : {})
      }
      // 鑽進 iframe 之後仍是同一輪批次選取
      if (msg.batch === true) enter.batch = true
      // 選取當下沒有目標的 locator 可以驗證，所以只用網址比對；
      // 不是唯一命中就退回原本那一層，硬猜會鑽錯 iframe
      let frames = []
      try { frames = await listFrames(tabId) } catch {}
      const matched = matchFrameByUrl(frames, msg.src)
      if (matched?.frameId !== undefined) {
        // 舊 frame 先停掉；失敗時會在同一層重新進入並帶明確可重試原因。
        try { await sendToFrame(tabId, { type: MSG.EXIT_PICK, ...pickIdentityOf(msg) }, fromFrameId, contentMs, 'Exit old pick frame') } catch {}
        try {
          await injectContent(tabId, { frameId: matched.frameId })
          const entered = await sendToFrame(tabId, {
            ...enter,
            parentFrameId: fromFrameId,
            frame: { url: frames.find(f => f.frameId === matched.frameId)?.url || msg.src,
              ...(msg.frameAnchor ? { anchor: msg.frameAnchor } : {}) }
          }, matched.frameId, contentMs, 'Enter pick')
          const expectedGroup = msg.activeGroupKey ?? msg.groupKey
          if (expectedGroup !== undefined && entered?.activeGroupKey !== expectedGroup) {
            const err = new Error('active_group_not_confirmed')
            err.code = 'group_conflict'
            throw err
          }
          rememberPickFrame(tabId, {
            frameId: matched.frameId,
            sessionId: msg.sessionId,
            groupKey: msg.groupKey,
            ...(msg.documentGeneration !== undefined ? { documentGeneration: structuredClone(msg.documentGeneration) } : {}),
            ...(msg.routeIdentity !== undefined ? { routeIdentity: structuredClone(msg.routeIdentity) } : {}),
            parentFrameId: fromFrameId,
            ...(fromFrameId !== 0 && typeof sender?.url === 'string' ? { parentFrame: { url: sender.url } } : {}),
            frame: { url: frames.find(f => f.frameId === matched.frameId)?.url || msg.src,
              ...(msg.frameAnchor ? { anchor: structuredClone(msg.frameAnchor) } : {}) }
          })
          return { ok: true, frameId: matched.frameId, frame: frameStateOf(tabId).frame, activeGroupKey: msg.activeGroupKey ?? msg.groupKey }
        } catch (err) {
          // 目的 frame 可能拒絕注入（權限／文件剛換）；不退回頂層靜默繼續。
          rememberPickFrame(tabId, {
            frameId: fromFrameId,
            sessionId: msg.sessionId,
            groupKey: msg.groupKey,
            ...(msg.documentGeneration !== undefined ? { documentGeneration: structuredClone(msg.documentGeneration) } : {}),
            ...(msg.routeIdentity !== undefined ? { routeIdentity: structuredClone(msg.routeIdentity) } : {})
          })
          try {
            await injectContent(tabId, { frameId: fromFrameId })
            await sendToFrame(tabId, { ...enter, hint: 'frame_not_found', frameError: 'inject_denied' }, fromFrameId, contentMs, 'Resume old pick frame')
          } catch {}
          return { ...pickTransitionError('frame_unavailable', frames), detail: String(err?.message || err) }
        }
      }
      // 舊 content 只認 frame_not_found；詳細的 ambiguous/unavailable 留在回傳狀態，
      // 讓既有頁面仍能顯示可重試提示而不誤當成成功。
      const hint = 'frame_not_found'
      const transitionHint = matched?.ambiguous ? 'frame_ambiguous' : (frames.length === 0 ? 'frame_unavailable' : hint)
      const backTo = fromFrameId
      // 只退回發出要求的那一層，並保留 session／group；絕不猜成 top frame。
      try {
        await sendToFrame(tabId, { ...enter, hint, frameError: transitionHint }, backTo, contentMs, 'Resume pick frame')
      } catch {}
      return { ...pickTransitionError(transitionHint, matched?.ambiguous || frames), frameId: backTo }
    }

    if (msg.type === MSG.ENTER_PICK) {
      if (msg.tabId) {
        if (msg.sessionId !== undefined && msg.routeIdentity !== undefined) {
          const currentTab = await chrome.tabs.get(msg.tabId).catch(() => null)
          if (!draftRouteMatchesTab(msg.routeIdentity, currentTab?.url)) {
            return { ok: false, error: 'stale_route', retryable: true, message: '目前頁面路徑已變更，請重新確認選取來源' }
          }
        }
        groupNamePickRequests.delete(msg.tabId)
        let frameId = msg.frameId ?? null
        let frameCandidates = []
        if (frameId === null && msg.frame?.url) {
          try { frameCandidates = await listFrames(msg.tabId) } catch {}
          const matched = matchFrameByUrl(frameCandidates, msg.frame.url)
          if (matched?.frameId === undefined) {
            const hint = matched?.ambiguous ? 'frame_ambiguous' : 'frame_unavailable'
            return pickTransitionError(hint, matched?.ambiguous || frameCandidates)
          }
          frameId = matched.frameId
        }
        if (frameId === null) frameId = 0
        // popup 的「選取要抓的內容」走這裡：面板已由 popup 自己開好，
        // 但沒有表單時要先顯示等待態（同右鍵入口），否則面板是一張空白表單
        const batch = msg.batch === true
        // popup 送完就關視窗：被擋時一定要把說明留在面板上，不能只回 ok:false（靜默無事）
        if (msg.purpose === 'task' && !(await applyPickEntry(
          msg.tabId, batch, msg.sessionId, msg.groupKey, msg.documentGeneration, msg.routeIdentity
        ))) {
          return { ok: false, error: 'pick_entry_blocked', retryable: true,
            message: '多值草稿無法進入頁面選取；請確認目前作用組，再重試' }
        }
        const previousFrame = frameStateOf(msg.tabId)
        if (previousFrame && previousFrame.frameId !== frameId) {
          try { await sendToFrame(msg.tabId, { type: MSG.EXIT_PICK, ...pickIdentityOf(msg) }, previousFrame.frameId, contentMs, 'Exit old pick frame') } catch {}
        }
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
        Object.assign(enter, pickIdentityOf(msg))
        if (msg.documentGeneration !== undefined) enter.documentGeneration = structuredClone(msg.documentGeneration)
        if (msg.routeIdentity !== undefined) enter.routeIdentity = structuredClone(msg.routeIdentity)
        if (msg.draftValues !== undefined) enter.draftValues = structuredClone(msg.draftValues)
        if (msg.frameAnchor) enter.frameAnchor = msg.frameAnchor
        if (batch) enter.batch = true
        await sendToFrame(msg.tabId, enter, frameId, contentMs, 'Enter pick')
        const frameUrl = frameCandidates.find(f => f.frameId === frameId)?.url || msg.frame?.url
        rememberPickFrame(msg.tabId, {
          frameId,
          sessionId: msg.sessionId,
          groupKey: msg.groupKey,
          ...(msg.documentGeneration !== undefined ? { documentGeneration: structuredClone(msg.documentGeneration) } : {}),
          ...(msg.routeIdentity !== undefined ? { routeIdentity: structuredClone(msg.routeIdentity) } : {}),
          ...(frameUrl ? { frame: { url: frameUrl, ...(msg.frameAnchor ? { anchor: structuredClone(msg.frameAnchor) } : {}) } } : {})
        })
        return { ok: true, frameId, activeGroupKey: msg.activeGroupKey ?? msg.groupKey }
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
      await sendToFrame(tab.id, {
        type: MSG.ENTER_PICK,
        purpose: msg.purpose || 'repick',
        taskId: msg.taskId,
        // 這是重選最常走的那條路（任務頁不帶 tabId）：新分頁沒有「上次右鍵的元素」，
        // 不帶這兩個欄位就沒有預選對象，既有的值也勾不回來
        locator: msg.locator || task.locator,
        preselect: msg.preselect || preselectOf(task)
      }, frameId, contentMs, 'Enter pick')
      return { ok: true }
    }

    if (msg.type === MSG.TEST_LOGIN) {
      return await handleTestLogin(msg, runOpts)
    }

    if (msg.type === MSG.MARK_READ) {
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
  } catch (err) {
    const protocolError = protocolErrorResponse(err)
    if (protocolError) return protocolError
    // 背景出錯不得靜默：UI 等結果的按鈕要拿得到 ok:false 與原因
    const message = String(err?.message || err)
    try { await diag.log('message_error', `${msg?.type}：${message}`) } catch {}
    return { ok: false, error: `背景處理失敗：${message}` }
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

async function rememberRepickTab(taskId, tabId) {
  await updateRepickTabs((cur) => ({ ...cur, [taskId]: tabId }))
}

async function closeRepickTab(taskId) {
  let tabId
  await updateRepickTabs((cur) => {
    tabId = cur[taskId]
    const next = { ...cur }
    delete next[taskId]
    return next
  })
  if (tabId === undefined) return
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
  groupNamePickRequests.delete(tabId)
  // AF-22 D02/C1b：關閉面板只暫停本輪選取，session 草稿留給 side panel
  // 或 fallback 視窗恢復；分頁真正關閉時才由 onRemoved 明確清除。
  let pauseError = null
  try { await pausePickDraft(tabId) } catch (err) {
    pauseError = err
    const protocolError = protocolErrorResponse(err)
    try {
      await diag.log('pick_draft_pause_failed', {
        tabId, error: protocolError?.error || 'storage', message: String(err?.message || err)
      })
    } catch {}
  }
  // 三條通道會重複觸發（onClosed + 分頁關閉…），暫存還在才代表「這一輪還沒清過」。
  // 不擋的話每次都對頁面廣播一輪 EXIT_PICK，白花訊息也可能清到下一輪剛貼上的標示
  const pending = await getPanelCtx(tabId)
  await clearPanelCtx(tabId)
  if (opts.keepMarks) {
    forgetPickFrame(tabId)
    pickParticipantFrames.delete(tabId)
    exitedPickTabs.delete(tabId)
    if (opts.clearDraft) {
      try { await clearPickDraftForTab(tabId) } catch (err) {
        try { await diag.log('pick_draft_clear_failed', { tabId, message: String(err?.message || err) }) } catch {}
      }
    }
    return pauseError ? { ok: false, error: String(pauseError?.message || pauseError) } : { ok: true }
  }
  if (!pending && exitedPickTabs.has(tabId)) {
    forgetPickFrame(tabId)
    pickParticipantFrames.delete(tabId)
    if (opts.clearDraft) {
      try { await clearPickDraftForTab(tabId) } catch (err) {
        try { await diag.log('pick_draft_clear_failed', { tabId, message: String(err?.message || err) }) } catch {}
      }
    }
    return pauseError ? { ok: false, error: String(pauseError?.message || pauseError) } : { ok: true, alreadyClosed: true }
  }
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
    try { await sendToFrame(tabId, { type: MSG.EXIT_PICK }, frameId, opts.contentTimeoutMs ?? CONTENT_MESSAGE_TIMEOUT_MS, 'Exit pick') } catch {}
  }
  exitedPickTabs.add(tabId)
  forgetPickFrame(tabId)
  pickParticipantFrames.delete(tabId)
  if (opts.clearDraft) {
    try { await clearPickDraftForTab(tabId) } catch (err) {
      try { await diag.log('pick_draft_clear_failed', { tabId, message: String(err?.message || err) }) } catch {}
    }
  }
  return pauseError ? { ok: false, error: String(pauseError?.message || pauseError) } : { ok: true }
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
      exitedPickTabs.delete(tab.id)
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
      await sendToFrame(tab.id, { type: MSG.ENTER_PICK, purpose: 'login-user' }, 0, CONTENT_MESSAGE_TIMEOUT_MS, 'Enter pick')
      return
    }

    if (info.menuItemId === 'af-pick') {
      if (!tab?.id) return
      exitedPickTabs.delete(tab.id)
      const frameId = info.frameId ?? 0
      // 面板先開起來顯示「正在頁面上選取…」，使用者才知道東西在哪裡、也才有地方可以取消。
      // **`open` 要排在最前面**：手勢跨越非同步等待有失效風險
      await openPanel(tab.id, 'picker', `tabId=${tab.id}`)
      // 面板已經有表單（使用者填到一半又回頁面按右鍵）就不動 ctx：
      // 蓋成等待態會把草稿一起洗掉，選完也認不出這是「換目標」
      if (!(await applyPickEntry(tab.id, false))) return
      await injectContent(tab.id, { frameId })
      await sendToFrame(tab.id, { type: MSG.ENTER_PICK, purpose: 'task' }, frameId, CONTENT_MESSAGE_TIMEOUT_MS, 'Enter pick')
      return
    }

    if (info.menuItemId === 'af-pick-batch') {
      if (!tab?.id) return
      exitedPickTabs.delete(tab.id)
      const frameId = info.frameId ?? 0
      // 手勢規則同 af-pick：`open` 必須是第一個 await
      await openPanel(tab.id, 'picker', `tabId=${tab.id}`)
      if (!(await applyPickEntry(tab.id, true))) return
      await injectContent(tab.id, { frameId })
      await sendToFrame(tab.id, { type: MSG.ENTER_PICK, purpose: 'task', batch: true }, frameId, CONTENT_MESSAGE_TIMEOUT_MS, 'Enter pick')
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
chrome.tabs?.onRemoved?.addListener?.((tabId) => { closePanelFor(tabId, { keepMarks: true, clearDraft: true }) })

// worker 每次啟動（不只瀏覽器啟動）：上一個 worker 留下的抓取分頁與排隊中／執行中的排程槽。
// storage 是空的時候兩者都只讀不寫
cleanOrphanFetchTabs().catch((err) => diag.log('startup_error', `cleanOrphanFetchTabs：${String(err?.message || err)}`).catch(() => {}))
recoverRunState().catch((err) => diag.log('startup_error', `recoverRunState：${String(err?.message || err)}`).catch(() => {}))
