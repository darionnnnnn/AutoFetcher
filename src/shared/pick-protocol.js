// AF-22 C1b：選取草稿的安全訊息協定。
//
// 這個檔案是 content、side panel/fallback 與 background 之間的共同契約。
// 訊息本身只攜帶可序列化資料；真正的讀改寫一律交給 pick-draft 的鎖內入口。
// frameId 可以存在於短命訊息中供 background 核對，但永不寫入草稿。
import {
  PICK_DRAFT_VERSION,
  PickDraftConflictError,
  getPickDraft,
  savePickDraft,
  updatePickDraft,
  clearPickDraft,
  normalizePickDraft,
  withPickDraftLock,
  MAX_PICK_DRAFT_GROUPS,
  PICK_SAVE_STATES
} from './pick-draft.js'

export const PICK_PROTOCOL_VERSION = 1
export const PICK_OPERATION_TYPES = Object.freeze([
  'create-group', 'add', 'remove', 'move', 'rename', 'set-active', 'patch-form', 'save-state', 'pause', 'abandon'
])
export const DRAFT_OPERATION_TYPES = PICK_OPERATION_TYPES

const MAX_APPLIED_OPERATION_IDS = 512
const IDENTITY_KEYS = ['sessionId', 'tabId', 'documentGeneration', 'documentIdentity', 'routeIdentity', 'frame']

export class PickProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PickProtocolError'
    this.code = code
    Object.assign(this, details)
  }
}

const fail = (code, message, details) => { throw new PickProtocolError(code, message, details) }
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k)

function assertExtensionSender(sender) {
  const url = typeof sender?.url === 'string' ? sender.url : ''
  let extensionOrigin = ''
  try { extensionOrigin = typeof chrome?.runtime?.getURL === 'function' ? chrome.runtime.getURL('') : '' } catch {}
  const isExtensionUrl = (extensionOrigin && url.startsWith(extensionOrigin)) ||
    /^(?:chrome|edge|moz)-extension:\/\//.test(url)
  if (!isExtensionUrl) fail('forbidden_sender', '草稿協定只接受擴充功能頁訊息')
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeDeep(child)
  return Object.freeze(value)
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('invalid', `${field} 必須是非空字串`)
  return value
}

function integer(value, field) {
  if (!Number.isInteger(value) || value < 0) fail('invalid', `${field} 必須是非負整數`)
  return value
}

function protocolIdentity(input = {}) {
  const value = {}
  for (const key of IDENTITY_KEYS) if (own(input, key)) value[key] = clone(input[key])
  return value
}

function identityConflict(current, expected) {
  if (expected.sessionId !== undefined && current.sessionId !== expected.sessionId) return 'sessionId 不符'
  if (expected.tabId !== undefined && current.tabId !== expected.tabId) return 'tabId 不符'
  for (const key of ['documentGeneration', 'documentIdentity', 'routeIdentity', 'frame']) {
    if (expected[key] !== undefined && stable(current[key]) !== stable(expected[key])) return `${key} 不符`
  }
  return ''
}

function assertIdentity(current, expected) {
  const message = identityConflict(current, expected)
  if (message) fail('identity_conflict', `草稿身分不符：${message}`, {
    currentRevision: current.revision,
    sessionId: current.sessionId,
    tabId: current.tabId
  })
}

function operationParts(input = {}) {
  const source = input.operation && typeof input.operation === 'object' ? input.operation : input
  const type = source.op || source.action || source.kind || source.type
  const operationId = input.operationId ?? source.operationId
  const expectedRevision = input.expectedRevision ?? source.expectedRevision
  return { source, type, operationId, expectedRevision }
}

function appliedIdsOf(draft) {
  return Array.isArray(draft.appliedOperationIds) ? draft.appliedOperationIds : []
}

function markOperation(draft, operationId) {
  const previous = appliedIdsOf(draft)
  draft.appliedOperationIds = [...previous.filter(id => id !== operationId), operationId]
    .slice(-MAX_APPLIED_OPERATION_IDS)
  draft.operationId = operationId
}

function groupOf(draft, key) {
  const group = draft.groups.find(item => item.key === key)
  if (!group) fail('invalid_operation', `找不到群組：${key}`)
  return group
}

function valueOf(group, key) {
  const value = group.values.find(item => item.key === key)
  if (!value) fail('invalid_operation', `找不到值：${key}`)
  return value
}

function valuePayload(source) {
  const value = source.value ?? source.item ?? source.pick
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_operation', 'add 缺少 value')
  if (typeof value.key !== 'string' || value.key.trim() === '') fail('invalid_operation', 'value.key 必須是非空字串')
  return clone(value)
}

function applyAdd(draft, source) {
  const groupKey = source.groupKey ?? source.toGroupKey ?? source.group?.key
  const group = groupOf(draft, groupKey)
  const value = valuePayload(source)
  if (group.values.some(item => item.key === value.key)) return
  group.values.push(value)
}

function applyCreateGroup(draft, source) {
  if (draft.groups.length >= MAX_PICK_DRAFT_GROUPS) {
    fail('operation_conflict', `最多 ${MAX_PICK_DRAFT_GROUPS} 組`)
  }
  const group = source.group && typeof source.group === 'object'
    ? clone(source.group)
    : { key: source.groupKey, name: source.name, values: source.values ?? [] }
  if (typeof group.key !== 'string' || group.key.trim() === '') {
    fail('invalid_operation', 'create-group 缺少 group.key')
  }
  if (draft.groups.some(item => item.key === group.key)) {
    fail('operation_conflict', `群組已存在：${group.key}`)
  }
  if (group.name === undefined) group.name = ''
  if (!Array.isArray(group.values)) group.values = []
  draft.groups.push(group)
}

function applyRemove(draft, source) {
  const groupKey = source.groupKey ?? source.fromGroupKey
  const group = groupOf(draft, groupKey)
  const valueKey = source.valueKey ?? source.key
  if (valueKey === undefined) {
    draft.groups = draft.groups.filter(item => item.key !== groupKey)
    if (draft.activeGroupKey === groupKey) draft.activeGroupKey = draft.groups[0]?.key || null
    return
  }
  group.values = group.values.filter(item => item.key !== valueKey)
}

function applyMove(draft, source) {
  const from = groupOf(draft, source.fromGroupKey ?? source.groupKey)
  const to = groupOf(draft, source.toGroupKey)
  const valueKey = nonEmpty(source.valueKey ?? source.key, 'valueKey')
  if (to.values.some(item => item.key === valueKey)) {
    fail('operation_conflict', `目標群組已有相同值：${valueKey}`)
  }
  const index = from.values.findIndex(item => item.key === valueKey)
  if (index < 0) fail('invalid_operation', `找不到值：${valueKey}`)
  const [value] = from.values.splice(index, 1)
  to.values.push(value)
}

function applyRename(draft, source) {
  const name = typeof source.name === 'string' ? source.name : fail('invalid_operation', 'rename 缺少 name')
  const groupKey = source.groupKey
  if (source.valueKey !== undefined) {
    valueOf(groupOf(draft, groupKey), source.valueKey).name = name
    return
  }
  groupOf(draft, groupKey).name = name
}

function applyPatchForm(draft, source) {
  const patch = source.patch ?? source.form
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('invalid_operation', 'patch-form 缺少 patch')
  draft.form = { ...draft.form, ...clone(patch) }
}

function applySaveState(draft, source) {
  const groupKey = nonEmpty(source.groupKey, 'groupKey')
  const state = nonEmpty(source.state, 'state')
  const phase = source.phase === undefined ? 'task' : nonEmpty(source.phase, 'phase')
  if (phase !== 'task' && phase !== 'first-run') fail('invalid_operation', `不支援的保存階段：${phase}`)
  if (!PICK_SAVE_STATES.includes(state)) fail('invalid_operation', `不支援的保存狀態：${state}`)
  const group = groupOf(draft, groupKey)
  const next = { state }
  if (source.taskId !== undefined) next.taskId = nonEmpty(source.taskId, 'taskId')
  if (source.error !== undefined) next.error = String(source.error)
  if (phase === 'task') {
    group.taskSaveState = state
    // 舊批次草稿仍讀 saveState；新流程以 taskSaveState/firstRunState 分開。
    group.saveState = state
    next.taskState = state
    if (source.taskFingerprint !== undefined) {
      if (!source.taskId) fail('invalid_operation', 'taskFingerprint 必須綁定 taskId')
      if (typeof source.taskFingerprint !== 'string' || source.taskFingerprint.trim() === '') {
        fail('invalid_operation', 'taskFingerprint 必須是非空字串')
      }
      group.taskCheckpoint = {
        taskId: source.taskId,
        taskFingerprint: source.taskFingerprint,
        ...(typeof source.taskName === 'string' ? { taskName: source.taskName } : {}),
        ...(typeof source.taskUrl === 'string' ? { taskUrl: source.taskUrl } : {})
      }
      next.taskFingerprint = source.taskFingerprint
    }
  } else {
    group.firstRunState = state
    next.firstRunState = state
  }
  if (next.taskId !== undefined) group.taskId = next.taskId
  if (next.error !== undefined) group.error = next.error
  else delete group.error
  draft.saveStates = { ...(draft.saveStates || {}), [groupKey]: next }
  if (phase === 'task' && state === 'inflight') draft.stage = 'saving'
  if (state === 'uncertain') draft.stage = 'partial'
  if (phase === 'first-run' && (state === 'inflight' || state === 'done')) draft.stage = 'saving'
  if (phase === 'first-run' && (state === 'done' || state === 'saved') &&
      draft.groups.length > 0 && draft.groups.every(item => ['done', 'saved'].includes(item.taskSaveState || item.saveState) &&
        ['done', 'saved'].includes(item.firstRunState))) {
    draft.stage = 'completed'
  }
}

/** 純函式：核對身分、revision、operationId 並產生下一份草稿。 */
export function applyPickDraftOperation(inputDraft, inputOperation, context = {}) {
  const current = normalizePickDraft(inputDraft)
  const { source, type, operationId, expectedRevision } = operationParts({ ...inputOperation, ...context })
  nonEmpty(operationId, 'operationId')
  integer(expectedRevision, 'expectedRevision')
  assertIdentity(current, protocolIdentity({ ...inputOperation, ...context }))

  if (appliedIdsOf(current).includes(operationId)) {
    return {
      draft: current,
      ack: ackOf(current, operationId, { duplicate: true }),
      duplicate: true
    }
  }
  if (expectedRevision !== current.revision) {
    fail('revision_conflict', `草稿 revision ${current.revision} 與操作期待的 ${expectedRevision} 不同`, {
      currentRevision: current.revision,
      sessionId: current.sessionId,
      tabId: current.tabId
    })
  }

  const next = clone(current)
  if (!PICK_OPERATION_TYPES.includes(type)) fail('invalid_operation', `不支援的草稿操作：${type}`)
  if (type === 'create-group') applyCreateGroup(next, source)
  else if (type === 'add') applyAdd(next, source)
  else if (type === 'remove') applyRemove(next, source)
  else if (type === 'move') applyMove(next, source)
  else if (type === 'rename') applyRename(next, source)
  else if (type === 'set-active') {
    const active = source.activeGroupKey ?? source.groupKey
    if (active !== null) groupOf(next, active)
    next.activeGroupKey = active ?? null
  } else if (type === 'patch-form') applyPatchForm(next, source)
  else if (type === 'save-state') applySaveState(next, source)
  else if (type === 'pause') {
    next.stage = 'paused'
    next.paused = true
  } else if (type === 'abandon') {
    next.stage = 'cancelled'
  }
  next.revision = current.revision + 1
  next.updatedAt = Date.now()
  markOperation(next, operationId)
  return { draft: normalizePickDraft(next), ack: ackOf(next, operationId) }
}

function ackOf(draft, operationId, extra = {}) {
  return {
    protocolVersion: PICK_PROTOCOL_VERSION,
    ok: true,
    operationId,
    sessionId: draft.sessionId,
    tabId: draft.tabId,
    revision: draft.revision,
    ...extra
  }
}

function tabOf(msg, sender) {
  const senderTab = sender?.tab?.id
  if (Number.isInteger(senderTab) && msg?.tabId !== undefined && msg.tabId !== senderTab) {
    fail('identity_conflict', '訊息 tabId 與 sender.tab 不符', { tabId: senderTab })
  }
  if (Number.isInteger(sender?.frameId) && msg?.frameId !== undefined && msg.frameId !== sender.frameId) {
    fail('identity_conflict', '訊息 frameId 與 sender.frameId 不符', { frameId: sender.frameId })
  }
  const tabId = Number.isInteger(senderTab) ? senderTab : msg?.tabId
  return integer(tabId, 'tabId')
}

function identityOf(msg, draft) {
  return protocolIdentity({
    sessionId: msg.sessionId,
    tabId: msg.tabId,
    documentGeneration: msg.documentGeneration,
    documentIdentity: msg.documentIdentity,
    routeIdentity: msg.routeIdentity,
    frame: msg.frame
  })
}

function baseDraftOf(msg, tabId) {
  const sessionId = nonEmpty(msg.sessionId, 'sessionId')
  const documentGeneration = msg.documentGeneration ?? msg.documentIdentity
  if (documentGeneration === undefined) fail('invalid', 'documentGeneration 必須存在')
  const routeIdentity = msg.routeIdentity ?? msg.documentIdentity ?? documentGeneration
  return normalizePickDraft({
    sessionId,
    version: PICK_DRAFT_VERSION,
    revision: 0,
    tabId,
    documentGeneration: clone(documentGeneration),
    ...(msg.documentIdentity !== undefined ? { documentIdentity: clone(msg.documentIdentity) } : {}),
    ...(msg.frame !== undefined ? { frame: clone(msg.frame) } : {}),
    routeIdentity: clone(routeIdentity),
    groups: Array.isArray(msg.groups) ? clone(msg.groups) : [],
    activeGroupKey: msg.activeGroupKey ?? null,
    stage: msg.stage || 'empty',
    form: msg.form || {},
    preActions: msg.preActions || [],
    saveStates: msg.saveStates || {}
  })
}

/** 建立／恢復一輪工作階段；同 session 的重送回原草稿，不重置內容。 */
export async function beginPickDraft(msg, sender = {}) {
  assertExtensionSender(sender)
  const tabId = tabOf(msg, sender)
  const draft = baseDraftOf(msg, tabId)
  const existing = await getPickDraft(tabId)
  if (existing) {
    assertIdentity(existing, identityOf(msg, existing))
    if (existing.sessionId !== draft.sessionId) fail('session_conflict', '該分頁已有另一個工作階段', { currentRevision: existing.revision })
    return { ...ackOf(existing, msg.operationId || 'begin', { resumed: true }), draft: existing }
  }
  await savePickDraft(tabId, draft)
  return { ...ackOf(draft, msg.operationId || 'begin'), draft }
}

/** 對 session 草稿做一個冪等操作；storage 失敗會直接向外拋出。 */
export async function handlePickDraftOperation(msg, sender = {}) {
  assertExtensionSender(sender)
  const tabId = tabOf(msg, sender)
  const operationId = msg.operationId ?? msg.operation?.operationId
  const draft = await getPickDraft(tabId)
  if (!draft) fail('missing_draft', '找不到選取草稿')
  const operationType = operationParts(msg).type
  // 放棄是清理操作，不把 cancelled 草稿留在 session。它仍先走同一個
  // expectedRevision／身分屏障，避免舊頁面把新 session 清掉。
  if (operationType === 'abandon') {
    const applied = applyPickDraftOperation(draft, msg, { ...msg, tabId })
    await clearPickDraft(tabId, { sessionId: draft.sessionId, revision: draft.revision })
    return { ...applied.ack, cleared: true, draft: null }
  }
  const expected = { ...msg, tabId }
  const result = await updatePickDraft(tabId, current => {
    const applied = applyPickDraftOperation(current, msg, expected)
    if (applied.duplicate) return current
    return applied.draft
  }, {
    sessionId: msg.sessionId,
    revision: msg.expectedRevision,
    documentGeneration: msg.documentGeneration,
    documentIdentity: msg.documentIdentity,
    routeIdentity: msg.routeIdentity,
    frame: msg.frame,
    tabId,
    allowDuplicateOperationId: operationId
  })
  const applied = appliedOperationIdsOf(result, operationId)
  const duplicate = result.revision === draft.revision
  return { ...ackOf(result, operationId, duplicate ? { duplicate: true } : {}), draft: result }
}

function appliedOperationIdsOf(draft, id) {
  return id && Array.isArray(draft.appliedOperationIds) && draft.appliedOperationIds.includes(id)
}

/** 完成屏障：期待 revision 必須是最後一個 ACK，成功才回傳不可變的 snapshot。 */
export async function completePickDraft(msg, sender = {}) {
  assertExtensionSender(sender)
  const tabId = tabOf(msg, sender)
  integer(msg.expectedRevision, 'expectedRevision')
  return withPickDraftLock(tabId, (draft) => {
    if (!draft) fail('missing_draft', '找不到選取草稿')
    assertIdentity(draft, { ...msg, tabId })
    if (msg.expectedRevision !== draft.revision) {
      fail('revision_conflict', '草稿尚未同步到最後一筆 ACK', { currentRevision: draft.revision })
    }
    const snapshot = freezeDeep(clone(draft))
    return {
      protocolVersion: PICK_PROTOCOL_VERSION,
      ok: true,
      synchronized: true,
      frozen: true,
      sessionId: draft.sessionId,
      tabId,
      revision: draft.revision,
      ackRevision: draft.revision,
      snapshot
    }
  })
}

export async function readPickDraftMessage(msg, sender = {}) {
  assertExtensionSender(sender)
  const tabId = tabOf(msg, sender)
  const draft = await getPickDraft(tabId)
  if (draft) assertIdentity(draft, { ...msg, tabId })
  return { protocolVersion: PICK_PROTOCOL_VERSION, ok: true, draft, revision: draft?.revision ?? null }
}

export async function abandonPickDraft(msg, sender = {}) {
  assertExtensionSender(sender)
  const tabId = tabOf(msg, sender)
  const draft = await getPickDraft(tabId)
  if (!draft) return { protocolVersion: PICK_PROTOCOL_VERSION, ok: true, cleared: false }
  assertIdentity(draft, { ...msg, tabId })
  await clearPickDraft(tabId, { sessionId: draft.sessionId, revision: draft.revision })
  return { protocolVersion: PICK_PROTOCOL_VERSION, ok: true, cleared: true, sessionId: draft.sessionId, tabId }
}

export async function pausePickDraft(tabId) {
  integer(tabId, 'tabId')
  const draft = await getPickDraft(tabId)
  if (!draft || draft.stage === 'paused' || draft.paused === true) return draft
  const operationId = `panel-pause:${draft.sessionId}:${draft.revision}`
  const result = await handlePickDraftOperation({
    type: 'pause', operation: { type: 'pause' }, operationId,
    sessionId: draft.sessionId, tabId, expectedRevision: draft.revision,
    documentGeneration: draft.documentGeneration, routeIdentity: draft.routeIdentity
  }, {
    url: typeof chrome?.runtime?.getURL === 'function'
      ? chrome.runtime.getURL('')
      : 'chrome-extension://internal/'
  })
  return result.draft
}

/** session 分頁關閉是唯一不需草稿身分的清理入口。 */
export async function clearPickDraftForTab(tabId) {
  return clearPickDraft(tabId)
}

export function protocolErrorResponse(error) {
  if (error instanceof PickProtocolError || error instanceof PickDraftConflictError) {
    return {
      protocolVersion: PICK_PROTOCOL_VERSION,
      ok: false,
      error: error.code || 'conflict',
      message: error.message,
      currentRevision: error.currentRevision
    }
  }
  return null
}

// 命名別名讓三個執行環境可以用同一份語意名稱；實作仍只有一份。
export const applyDraftOperation = applyPickDraftOperation
export const beginDraft = beginPickDraft
export const readDraft = readPickDraftMessage
export const handleDraftOperation = handlePickDraftOperation
export const completeDraft = completePickDraft
export const abandonDraft = abandonPickDraft
