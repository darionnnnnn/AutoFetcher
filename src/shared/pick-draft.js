// AF-22 C1a：可恢復的選取工作階段草稿資料層。
//
// 這一層只保存可重建的資料：DOM 節點、frameId、事件與其他執行期物件
// 都不進 session。訊息協定與頁面協調在 C1b/C2；這裡只提供純序列化、
// 身分核對，以及帶鎖的 session 存取入口。
import {
  getSessionValue,
  updateSessionValue,
  clearSessionValue,
  mutateSessionValue,
  REMOVE_SESSION_VALUE
} from './storage.js'
import { withLock, lockNameOf } from './lock.js'

export const PICK_DRAFT_VERSION = 1
export const MAX_PICK_DRAFT_GROUPS = 20
export const MAX_PICK_DRAFT_VALUES = 100
export const MAX_DRAFT_STRING_LENGTH = 4096
export const MAX_PICK_DRAFT_BYTES = 512 * 1024
export const MAX_PICK_DRAFT_DEPTH = 8

// 相容的別名，讓消費端不必複製這些界限。
export const MAX_GROUPS = MAX_PICK_DRAFT_GROUPS
export const MAX_VALUES_PER_GROUP = MAX_PICK_DRAFT_VALUES
export const MAX_DRAFT_BYTES = MAX_PICK_DRAFT_BYTES

const KEY_PREFIX = 'pickDraft:'
const STAGES = new Set([
  'empty', 'naming', 'selecting', 'paused', 'settings', 'saving', 'partial', 'completed', 'cancelled'
])
const DRAFT_KEYS = new Set([
  'sessionId', 'version', 'revision', 'tabId', 'documentGeneration', 'routeIdentity',
  'documentIdentity', 'frame',
  'groups', 'activeGroupKey', 'stage', 'form', 'preActions', 'saveStates',
  'operationId', 'appliedOperationIds', 'paused', 'createdAt', 'updatedAt'
])
const GROUP_KEYS = new Set(['key', 'name', 'values', 'saveState', 'taskId', 'error'])
const VALUE_KEYS = new Set([
  'key', 'name', 'source', 'spec', 'mode', 'preview', 'previewValue', 'locator', 'frame'
])

export class PickDraftValidationError extends Error {
  constructor(message) {
    super(`選取草稿格式錯誤：${message}`)
    this.name = 'PickDraftValidationError'
  }
}

export class PickDraftConflictError extends Error {
  constructor(message) {
    super(`選取草稿已過期或身分不符：${message}`)
    this.name = 'PickDraftConflictError'
  }
}

function fail(message) {
  throw new PickDraftValidationError(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

// route identity 是結構身分，物件鍵的排列不應造成同一份文件被判成不同。
// 正規化之後資料已是 JSON-safe，因此這裡只需穩定排序物件鍵，保留陣列順序。
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function cloneJson(value, path = '$', depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_DRAFT_STRING_LENGTH) fail(`${path} 字串超過上限`)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} 必須是有限數字`)
    return value
  }
  if (typeof value !== 'object') fail(`${path} 不可序列化`)
  if (depth >= MAX_PICK_DRAFT_DEPTH) fail(`${path} 巢狀深度超過上限`)
  if (seen.has(value)) fail(`${path} 不得包含遞迴結構`)
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = value.map((item, index) => cloneJson(item, `${path}[${index}]`, depth + 1, seen))
  } else if (isPlainObject(value)) {
    result = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail(`${path}.${key} 不允許`)
      result[key] = cloneJson(item, `${path}.${key}`, depth + 1, seen)
    }
  } else {
    fail(`${path} 必須是 JSON 物件、陣列或基本值`)
  }
  seen.delete(value)
  return result
}

function stringField(value, path, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.trim() === '')) fail(`${path} 必須是非空字串`)
  if (value.length > MAX_DRAFT_STRING_LENGTH) fail(`${path} 字串超過上限`)
  return value
}

function identityValue(value, path) {
  if (typeof value === 'string') return stringField(value, path)
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) fail(`${path} 必須是非負整數或字串`)
    return value
  }
  if (isPlainObject(value)) return cloneJson(value, path)
  fail(`${path} 必須是字串、非負整數或物件`)
}

function normalizeValue(value, groupIndex, valueIndex) {
  if (!isPlainObject(value)) fail(`groups[${groupIndex}].values[${valueIndex}] 必須是物件`)
  const result = {}
  for (const key of VALUE_KEYS) {
    if (own(value, key)) result[key] = cloneJson(value[key], `groups[${groupIndex}].values[${valueIndex}].${key}`)
  }
  stringField(result.key, `groups[${groupIndex}].values[${valueIndex}].key`)
  if (result.name !== undefined) stringField(result.name, `groups[${groupIndex}].values[${valueIndex}].name`, { empty: true })
  if (result.spec && isPlainObject(result.spec) && (result.spec.mode === 'multi' || Array.isArray(result.spec.fields))) {
    fail(`groups[${groupIndex}].values[${valueIndex}].spec 不得遞迴 multi`)
  }
  return result
}

function normalizeGroup(group, groupIndex) {
  if (!isPlainObject(group)) fail(`groups[${groupIndex}] 必須是物件`)
  const result = {}
  for (const key of GROUP_KEYS) {
    if (own(group, key)) result[key] = cloneJson(group[key], `groups[${groupIndex}].${key}`)
  }
  stringField(result.key, `groups[${groupIndex}].key`)
  if (result.name !== undefined) stringField(result.name, `groups[${groupIndex}].name`, { empty: true })
  if (!Array.isArray(result.values)) fail(`groups[${groupIndex}].values 必須是陣列`)
  if (result.values.length > MAX_PICK_DRAFT_VALUES) fail(`每組最多 ${MAX_PICK_DRAFT_VALUES} 個值`)
  result.values = result.values.map((item, index) => normalizeValue(item, groupIndex, index))
  const keys = result.values.map(item => item.key)
  if (new Set(keys).size !== keys.length) fail(`groups[${groupIndex}].values key 不得重複`)
  return result
}

function normalizeSaveStates(value) {
  if (value === undefined) return {}
  if (!isPlainObject(value)) fail('saveStates 必須是物件')
  const result = cloneJson(value, '$.saveStates')
  for (const [key, state] of Object.entries(result)) {
    if (!isPlainObject(state)) fail(`saveStates.${key} 必須是物件`)
    if (state.state !== undefined && !['pending', 'saving', 'saved', 'failed'].includes(state.state)) {
      fail(`saveStates.${key}.state 不支援`)
    }
  }
  return result
}

/**
 * 正規化並驗證草稿。回傳值與輸入完全獨立，呼叫端可以安全修改。
 */
export function normalizePickDraft(input) {
  if (!isPlainObject(input)) fail('草稿必須是物件')
  const result = {}
  for (const key of DRAFT_KEYS) {
    if (own(input, key)) result[key] = cloneJson(input[key], `$.${key}`)
  }
  stringField(result.sessionId, 'sessionId')
  if (result.version !== PICK_DRAFT_VERSION) fail(`version 必須是 ${PICK_DRAFT_VERSION}`)
  if (!Number.isInteger(result.revision) || result.revision < 0) fail('revision 必須是非負整數')
  if (!Number.isInteger(result.tabId) || result.tabId < 0) fail('tabId 必須是非負整數')
  result.documentGeneration = identityValue(result.documentGeneration, 'documentGeneration')
  result.routeIdentity = identityValue(result.routeIdentity, 'routeIdentity')
  if (result.documentIdentity !== undefined) result.documentIdentity = cloneJson(result.documentIdentity, 'documentIdentity')
  if (result.frame !== undefined) result.frame = cloneJson(result.frame, 'frame')
  if (result.appliedOperationIds !== undefined) {
    if (!Array.isArray(result.appliedOperationIds)) fail('appliedOperationIds 必須是陣列')
    result.appliedOperationIds = result.appliedOperationIds.map((id, i) => stringField(id, `appliedOperationIds[${i}]`))
  }
  if (!Array.isArray(result.groups)) fail('groups 必須是陣列')
  if (result.groups.length > MAX_PICK_DRAFT_GROUPS) fail(`最多 ${MAX_PICK_DRAFT_GROUPS} 組`)
  result.groups = result.groups.map(normalizeGroup)
  const groupKeys = result.groups.map(group => group.key)
  if (new Set(groupKeys).size !== groupKeys.length) fail('groups key 不得重複')
  if (result.activeGroupKey !== null && result.activeGroupKey !== undefined) {
    stringField(result.activeGroupKey, 'activeGroupKey')
    if (!groupKeys.includes(result.activeGroupKey)) fail('activeGroupKey 必須指向現有群組')
  } else {
    result.activeGroupKey = null
  }
  stringField(result.stage, 'stage')
  if (!STAGES.has(result.stage)) fail(`stage 不支援：${result.stage}`)
  result.form = result.form === undefined ? {} : cloneJson(result.form, '$.form')
  result.preActions = result.preActions === undefined ? [] : cloneJson(result.preActions, '$.preActions')
  result.saveStates = normalizeSaveStates(result.saveStates)
  // 明確白名單：外部附帶的 DOM／事件／測試欄位不進 session。
  for (const key of Object.keys(result)) {
    if (!DRAFT_KEYS.has(key)) delete result[key]
  }
  return result
}

export function validatePickDraft(input) {
  normalizePickDraft(input)
  return true
}

export function serializePickDraft(input) {
  const normalized = normalizePickDraft(input)
  const encoded = JSON.stringify(normalized)
  const bytes = typeof TextEncoder === 'function'
    ? new TextEncoder().encode(encoded).byteLength
    : encoded.length
  if (bytes > MAX_PICK_DRAFT_BYTES) fail(`草稿大小超過 ${MAX_PICK_DRAFT_BYTES} bytes 上限`)
  return encoded
}

export function deserializePickDraft(value) {
  if (typeof value !== 'string') fail('序列化草稿必須是字串')
  if (value.length > MAX_PICK_DRAFT_BYTES) fail('序列化草稿超過大小上限')
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    fail('序列化草稿不是有效 JSON')
  }
  return normalizePickDraft(parsed)
}

export function samePickDraftIdentity(a, b) {
  try {
    const left = normalizePickDraft(a)
    const right = normalizePickDraft(b)
    return left.sessionId === right.sessionId && left.version === right.version &&
      left.tabId === right.tabId && stableJson(left.documentGeneration) === stableJson(right.documentGeneration) &&
      stableJson(left.routeIdentity) === stableJson(right.routeIdentity)
  } catch {
    return false
  }
}

export function isCurrentPickDraft(draft, identity = {}) {
  let value
  try { value = normalizePickDraft(draft) } catch { return false }
  if (identity.tabId !== undefined && value.tabId !== identity.tabId) return false
  if (identity.sessionId !== undefined && value.sessionId !== identity.sessionId) return false
  if (identity.version !== undefined && value.version !== identity.version) return false
  if (identity.revision !== undefined && value.revision !== identity.revision) return false
  if (identity.documentGeneration !== undefined && stableJson(value.documentGeneration) !== stableJson(identity.documentGeneration)) return false
  if (identity.routeIdentity !== undefined && stableJson(value.routeIdentity) !== stableJson(identity.routeIdentity)) return false
  if (identity.documentIdentity !== undefined && stableJson(value.documentIdentity) !== stableJson(identity.documentIdentity)) return false
  if (identity.frame !== undefined && stableJson(value.frame) !== stableJson(identity.frame)) return false
  return true
}

function tabKey(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError('tabId 必須是非負整數')
  return KEY_PREFIX + tabId
}

function conflict(message) {
  throw new PickDraftConflictError(message)
}

function assertExpected(current, tabId, options = {}) {
  if (current.tabId !== tabId) conflict('草稿所屬分頁不符')
  if (options.sessionId !== undefined && current.sessionId !== options.sessionId) conflict('sessionId 不符')
  if (options.version !== undefined && current.version !== options.version) conflict('version 不符')
  if (options.revision !== undefined && current.revision !== options.revision) conflict('revision 不符')
  if (options.documentGeneration !== undefined && stableJson(current.documentGeneration) !== stableJson(options.documentGeneration)) conflict('文件世代不符')
  if (options.routeIdentity !== undefined && stableJson(current.routeIdentity) !== stableJson(options.routeIdentity)) conflict('route identity 不符')
  if (options.documentIdentity !== undefined && stableJson(current.documentIdentity) !== stableJson(options.documentIdentity)) conflict('文件身分不符')
  if (options.frame !== undefined && stableJson(current.frame) !== stableJson(options.frame)) conflict('frame 身分不符')
}

// 所有 session 寫入都先經同一份序列化大小守門；實際仍存 JSON-safe 物件，
// 讓 Chrome session 與既有讀取端保持方便的物件形狀。
function checkedDraft(input) {
  const normalized = normalizePickDraft(input)
  serializePickDraft(normalized)
  return normalized
}

/** 讀取分頁草稿；身分不符或已損壞時回 null，storage 本身的錯誤仍向外拋出。 */
export async function getPickDraft(tabId, identity = {}) {
  const key = tabKey(tabId)
  if (identity.tabId !== undefined && identity.tabId !== tabId) return null
  const stored = await getSessionValue(key)
  if (stored === undefined || stored === null) return null
  let draft
  try { draft = typeof stored === 'string' ? deserializePickDraft(stored) : normalizePickDraft(stored) } catch { return null }
  return isCurrentPickDraft(draft, { ...identity, tabId }) ? draft : null
}

/**
 * 以完整快照保存一份草稿。新 session 可替換舊 session；同一 session 的
 * 舊 revision 會拒絕，避免延遲回報覆蓋較新的操作。
 */
export async function savePickDraft(tabId, input, options = {}) {
  const key = tabKey(tabId)
  const draft = checkedDraft(input)
  if (draft.tabId !== tabId) conflict('草稿所屬分頁不符')
  return updateSessionValue(key, (current) => current, (current) => {
    if (current !== undefined) {
      const existing = typeof current === 'string' ? deserializePickDraft(current) : normalizePickDraft(current)
      // 身分守門必須先於去重；否則舊 session 可冒用已見 operationId。
      const identityOptions = { ...options }
      delete identityOptions.revision
      delete identityOptions.allowDuplicateOperationId
      assertExpected(existing, tabId, identityOptions)
      // 可重送操作的去重只略過 revision 守門：同一 operationId 重送時
      // current revision 已經前進，仍應回原結果而不是被誤報為過期。
      if (options.allowDuplicateOperationId &&
        Array.isArray(existing.appliedOperationIds) && existing.appliedOperationIds.includes(options.allowDuplicateOperationId)) {
        return existing
      }
      assertExpected(existing, tabId, options)
      if (existing.sessionId === draft.sessionId) {
        if (draft.revision < existing.revision) conflict('revision 太舊')
        if (draft.revision === existing.revision && stableJson(draft) !== stableJson(existing)) {
          conflict('相同 revision 的內容不一致')
        }
      }
    }
    return draft
  })
}

/**
 * 在鎖內套用一個完整 patch 或 mutator。呼叫端可用 sessionId／revision
 * 作為樂觀鎖；未通過時原草稿保持不變。
 */
export async function updatePickDraft(tabId, patchOrMutator, options = {}) {
  const key = tabKey(tabId)
  return updateSessionValue(key, (current) => current, (current) => {
    if (current === undefined || current === null) conflict('找不到草稿')
    const existing = typeof current === 'string' ? deserializePickDraft(current) : normalizePickDraft(current)
    // 身分守門先做，再判斷 operationId。重送時草稿可能已前進，
    // 但同一操作仍必須回原稿 ACK，而不是被誤判為舊 revision。
    const identityOptions = { ...options }
    delete identityOptions.revision
    delete identityOptions.allowDuplicateOperationId
    assertExpected(existing, tabId, identityOptions)
    if (options.allowDuplicateOperationId &&
      Array.isArray(existing.appliedOperationIds) && existing.appliedOperationIds.includes(options.allowDuplicateOperationId)) {
      return existing
    }
    assertExpected(existing, tabId, options)
    let next
    if (typeof patchOrMutator === 'function') {
      next = patchOrMutator(structuredClone(existing))
    } else if (patchOrMutator && typeof patchOrMutator === 'object') {
      next = { ...existing, ...structuredClone(patchOrMutator) }
    } else {
      throw new TypeError('草稿 patch 必須是物件或函式')
    }
    if (next === undefined) next = existing
    if (next.sessionId !== existing.sessionId) conflict('不可在 update 中更換 sessionId')
    if (next.tabId !== tabId) conflict('草稿所屬分頁不符')
    if (next.revision === existing.revision) next.revision = existing.revision + 1
    if (next.revision < existing.revision) conflict('revision 太舊')
    return checkedDraft(next)
  })
}

/** 明確放棄／完成時清除草稿；提供身分時會先核對，避免舊 session 誤清新 session。 */
export async function clearPickDraft(tabId, identity = {}) {
  const key = tabKey(tabId)
  if (identity && Object.keys(identity).length > 0) {
    await mutateSessionValue(key, (current) => {
      if (current === undefined) return undefined
      const existing = typeof current === 'string' ? deserializePickDraft(current) : normalizePickDraft(current)
      assertExpected(existing, tabId, identity)
      return REMOVE_SESSION_VALUE
    })
    return
  }
  await clearSessionValue(key)
}

/**
 * 在指定草稿鍵的 session lock 內讀取並執行唯讀操作。
 * 用於完成屏障等必須把最後 revision 檢查與 snapshot 取得綁在一起的流程；
 * callback 的回傳值不會寫回 storage。
 */
export async function withPickDraftLock(tabId, callback) {
  const key = tabKey(tabId)
  if (typeof callback !== 'function') throw new TypeError('草稿 lock callback 必須是函式')
  return withLock(lockNameOf(key, 'session'), async () => {
    // getSessionValue 本身不取鎖；這裡已持有同一把 key lock，
    // 因此可以把讀取與 callback 的 revision 檢查維持在同一臨界區。
    const stored = await getSessionValue(key)
    if (stored === undefined || stored === null) return callback(null)
    const draft = typeof stored === 'string' ? deserializePickDraft(stored) : normalizePickDraft(stored)
    return callback(draft)
  })
}

export const putPickDraft = savePickDraft
export const readPickDraft = getPickDraft
export const removePickDraft = clearPickDraft
