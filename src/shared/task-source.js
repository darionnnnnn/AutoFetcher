// 任務來源契約：把舊單值、舊同表多值與 AF-22 multi 讀成同一種 field 形狀。
// 這個模組只做純資料轉換與驗證；不會回寫 storage，也不會修改呼叫端物件。

export const TASK_FIELD_MODES = Object.freeze(['number', 'text', 'block'])

const MODE_SET = new Set(TASK_FIELD_MODES)

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function sourceOfLegacyTask(task) {
  const source = {}
  if (isPlainObject(task?.locator) && Object.keys(task.locator).length > 0) {
    source.locator = clone(task.locator)
  }
  if (task?.frame !== undefined) source.frame = clone(task.frame)
  return source
}

function singleSpecOfLegacyField(field) {
  if (!isPlainObject(field)) return {}
  if (isPlainObject(field.spec)) return clone(field.spec)
  if (Object.prototype.hasOwnProperty.call(field, 'cell')) {
    return { mode: 'block', cell: clone(field.cell) }
  }
  if (Object.prototype.hasOwnProperty.call(field, 'block')) {
    return { mode: 'block', block: clone(field.block) }
  }
  const next = clone(field)
  delete next.key
  delete next.name
  delete next.mode
  delete next.source
  return next
}

function legacyField(task, field, specField, index) {
  const key = typeof field?.key === 'string' ? field.key : (typeof specField?.key === 'string' ? specField.key : '')
  const name = typeof field?.name === 'string' ? field.name : ''
  const mode = typeof task?.mode === 'string' && task.mode !== 'multi'
    ? task.mode
    : (typeof task?.spec?.mode === 'string' ? task.spec.mode : 'number')
  return {
    key,
    name,
    mode,
    source: sourceOfLegacyTask(task),
    spec: singleSpecOfLegacyField(specField || task?.spec)
  }
}

/**
 * 讀取任務的擷取來源為統一的 field 陣列。
 *
 * 新格式每個 spec.fields 項目本身就是完整來源；舊單值與舊 block fields
 * 則補上共用的 task.locator/frame，並把 cell/block 包成單目標 spec。
 * 回傳值與輸入完全獨立，呼叫端可安全修改回傳值。
 */
export function normalizeTaskSources(task) {
  if (!isPlainObject(task)) return []

  const metadata = Array.isArray(task.fields) ? task.fields : []
  const specFields = Array.isArray(task.spec?.fields) ? task.spec.fields : []
  const isMulti = task.mode === 'multi' || task.spec?.mode === 'multi'

  if (isMulti) {
    const byKey = new Map(metadata.map((field) => [field?.key, field]))
    return specFields.map((field, index) => {
      const meta = byKey.get(field?.key) || metadata[index] || {}
      return {
        key: typeof field?.key === 'string' ? field.key : (typeof meta.key === 'string' ? meta.key : ''),
        name: typeof meta.name === 'string' ? meta.name : '',
        mode: field?.mode,
        source: clone(field?.source),
        spec: clone(field?.spec)
      }
    })
  }

  if (metadata.length > 0) {
    const byKey = new Map(specFields.map((field) => [field?.key, field]))
    return metadata.map((field, index) => legacyField(task, field, byKey.get(field?.key) || specFields[index], index))
  }

  // 單值任務以空 key 表示「父序列本身」，以維持既有 task.id 序列 id。
  return [legacyField(task, { key: '', name: task.name || task.id || '' }, task.spec, 0)]
}

// 便於不需要記住模組內部命名的呼叫端；兩者是同一個純函式契約。
export const taskSourcesOf = normalizeTaskSources

function invalid(message) {
  throw new Error(`multi 任務格式錯誤：${message}`)
}

function validateKey(value, label) {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${label} 必須為非空字串`)
  if (value.includes('#')) invalid(`${label} 不得包含保留字元 #`)
}

function validateSource(source) {
  if (!isPlainObject(source)) invalid('source 必須為物件')
  if (!isPlainObject(source.locator) || Object.keys(source.locator).length === 0) {
    invalid('source.locator 必須是非空物件')
  }
  if (Object.prototype.hasOwnProperty.call(source, 'frameId')) {
    invalid('source 不得包含 frameId')
  }
  if (source.frame !== undefined) {
    if (!isPlainObject(source.frame) || typeof source.frame.url !== 'string' || source.frame.url.trim() === '') {
      invalid('source.frame.url 必須為非空字串')
    }
    if (Object.prototype.hasOwnProperty.call(source.frame, 'frameId')) {
      invalid('source.frame 不得包含 frameId')
    }
    if (Object.keys(source.frame).some((key) => key !== 'url')) {
      invalid('source.frame 只允許非空 url')
    }
  }
}

function validateSingleSpec(spec) {
  if (!isPlainObject(spec)) invalid('field.spec 必須為物件')
  if (spec.mode === 'multi' || Array.isArray(spec.fields)) {
    invalid('field.spec 不得遞迴 multi')
  }
}

/**
 * 驗證 AF-22 multi 的深層契約。舊格式由 storage 的既有驗證路徑處理。
 * @param {object} task
 */
export function validateMultiTask(task) {
  if (task?.mode !== 'multi' || task?.spec?.mode !== 'multi') {
    invalid('task.mode 與 spec.mode 必須同時為 multi')
  }
  if (!isPlainObject(task.spec) || !Array.isArray(task.spec.fields) || task.spec.fields.length === 0) {
    invalid('spec.fields 必須為非空陣列')
  }
  if (!Array.isArray(task.fields) || task.fields.length === 0) {
    invalid('task.fields 必須為非空陣列')
  }

  const taskKeys = new Set()
  for (const field of task.fields) {
    validateKey(field?.key, 'task.fields key')
    if (taskKeys.has(field.key)) invalid(`task.fields key 重複：${field.key}`)
    taskKeys.add(field.key)
  }

  const specKeys = new Set()
  for (const field of task.spec.fields) {
    validateKey(field?.key, 'spec.fields key')
    if (specKeys.has(field.key)) invalid(`spec.fields key 重複：${field.key}`)
    specKeys.add(field.key)
    if (!MODE_SET.has(field?.mode)) invalid(`field mode 不支援：${field?.mode}`)
    validateSource(field?.source)
    validateSingleSpec(field?.spec)
  }

  if (taskKeys.size !== specKeys.size || [...taskKeys].some((key) => !specKeys.has(key))) {
    invalid('task.fields 與 spec.fields 的 key 必須一一對應')
  }
}
