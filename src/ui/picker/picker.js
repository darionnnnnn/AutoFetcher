import { saveTask, getTask, getSettings, saveSettings } from '../../shared/storage.js'
import { MSG } from '../../shared/messages.js'
import { getLayout, addCard } from '../../shared/layout-store.js'
import { seriesIdOf } from '../../shared/series-index.js'

let currentCtx = null
let currentBlock = null
const fieldSpecs = new Map()
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function getFormData() {
  const name = document.getElementById('name')?.value ?? ''
  const urlEl = document.getElementById('url')
  const url = (urlEl?.value ?? urlEl?.textContent ?? currentCtx?.url ?? '').trim()
  const mode = document.getElementById('mode')?.value || 'number'
  const strategy = document.getElementById('strategy')?.value || 'auto'
  const regex = document.getElementById('regex')?.value ?? ''
  const scheduleType = document.getElementById('schedule-type')?.value || 'daily'

  const timesRaw = document.getElementById('times')?.value ?? ''
  const times = timesRaw.trim() ? timesRaw.split(',').map(s => s.trim()) : []

  const weekdays = Array.from(
    document.querySelectorAll('#weekdays input[type="checkbox"]:checked')
  ).map(cb => Number(cb.value)).sort((a, b) => a - b)

  const emRaw = document.getElementById('every-minutes')?.value
  const everyMinutes = (emRaw !== undefined && emRaw !== null && emRaw !== '') ? Number(emRaw) : NaN

  const windowFrom = document.getElementById('window-from')?.value ?? ''
  const windowTo = document.getElementById('window-to')?.value ?? ''

  const alertRows = document.querySelectorAll('[data-alert-row]')
  const alerts = Array.from(alertRows).map(row => {
    const id = row.dataset.id || crypto.randomUUID()
    const type = row.querySelector('select.alert-type')?.value || row.querySelector('select')?.value || 'gt'
    const valInput = row.querySelector('input:not([type="checkbox"])') || row.querySelector('input')
    const valStr = valInput?.value?.trim() ?? ''
    const value = valStr === '' ? NaN : Number(valStr)
    const cb = row.querySelector('input[type="checkbox"]')
    const enabled = cb ? cb.checked : true
    const alertItem = { id, type, value, enabled }
    const fieldSel = row.querySelector('select[data-alert-field]')
    const fieldVal = fieldSel?.value?.trim()
    if (fieldVal) {
      alertItem.field = fieldVal
    }
    return alertItem
  })

  const preActionRows = document.querySelectorAll('[data-preaction-row]')
  const preActions = Array.from(preActionRows).map(row => {
    const type = row.querySelector('select')?.value || 'waitFor'
    const locator = row._locator || null
    const valInput = row.querySelector('input[type="number"]') || row.querySelector('input')
    const valStr = valInput?.value?.trim() ?? ''
    const num = valStr === '' ? NaN : Number(valStr)

    if (type === 'waitFor') {
      return {
        type,
        locator,
        timeoutMs: Number.isFinite(num) ? num : (valStr === '' ? 20000 : NaN)
      }
    }
    if (type === 'click') {
      return {
        type,
        locator
      }
    }
    if (type === 'wait') {
      return {
        type,
        ms: num
      }
    }
    return { type, locator }
  })

  const aggregateValue = document.getElementById('block-aggregate')?.value || 'sum'
  const fieldRows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  let fields = undefined
  if (fieldRows.length > 0) {
    fields = fieldRows.map((row, index) => {
      const key = row.dataset.fieldKey || ''
      const rawName = row.querySelector('input[data-field-name]')?.value?.trim()
      const name = rawName || `值 ${index + 1}`
      const spec = row._spec || fieldSpecs.get(key) || {}
      const item = { key, name }
      if (spec.cell) item.cell = spec.cell
      // 整欄／整列的值要聚合，聚合方式來自表單（全任務一份）；
      // 少了這一行，抓取端會拿不到設定而預設成加總，下拉等於裝飾品
      if (spec.block) item.block = { ...spec.block, aggregate: aggregateValue }
      return item
    })
  }

  const data = {
    name, url, mode, strategy, regex, scheduleType, times, weekdays, everyMinutes, windowFrom, windowTo,
    alerts,
    preActions
  }

  if (fields) {
    data.fields = fields
  } else if (mode === 'block') {
    const agg = document.getElementById('block-aggregate')?.value || 'sum'
    data.block = {
      axis: currentBlock?.axis,
      index: currentBlock?.index,
      headerText: currentBlock?.headerText,
      aggregate: agg
    }
  }

  return data
}

export function validateForm(values) {
  const errors = {}

  if (!values.name || typeof values.name !== 'string' || values.name.trim() === '') {
    errors.name = '名稱不可空白'
  }

  if (values.scheduleType === 'daily') {
    if (!Array.isArray(values.times) || values.times.length === 0 || !values.times.every(t => typeof t === 'string' && TIME_RE.test(t))) {
      errors.times = '時間格式必須為 HH:mm 且至少設定一筆'
    }
    if (!Array.isArray(values.weekdays) || values.weekdays.length === 0) {
      errors.weekdays = '至少選擇一個星期'
    }
  } else if (values.scheduleType === 'interval') {
    const em = values.everyMinutes
    if (typeof em !== 'number' || !Number.isInteger(em) || em < 1) {
      errors.everyMinutes = '間隔分鐘必須為 1 以上的整數'
    }
  }

  if (values.strategy === 'regex') {
    if (!values.regex || typeof values.regex !== 'string' || values.regex.trim() === '') {
      errors.regex = '正規表達式為必填'
    } else {
      try {
        new RegExp(values.regex)
      } catch {
        errors.regex = '正規表達式語法不正確'
      }
    }
  }

  // 時段只有 interval 用得到;daily 時該欄位是隱藏的,殘值不可擋住存檔
  const hasFrom = values.scheduleType === 'interval' && typeof values.windowFrom === 'string' && values.windowFrom.trim() !== ''
  const hasTo = values.scheduleType === 'interval' && typeof values.windowTo === 'string' && values.windowTo.trim() !== ''
  if ((hasFrom && !hasTo) || (!hasFrom && hasTo)) {
    errors.window = '時段起訖必須同時填寫或同時空白'
  } else if (hasFrom && hasTo) {
    if (!TIME_RE.test(values.windowFrom.trim()) || !TIME_RE.test(values.windowTo.trim())) {
      errors.window = '時段格式錯誤'
    }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true }
}

export const BUILTIN_DEFAULTS = {
  scheduleType: 'daily',
  times: ['09:30'],
  everyMinutes: 15,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  windowFrom: '',
  windowTo: '',
  aggregate: 'sum',
  dashboardId: '',
  cardTypes: []
}

export function buildSpec(values) {
  const spec = { strategy: values.strategy }
  if (values.fields) {
    spec.mode = 'block'
    spec.fields = values.fields.map(f => {
      const item = { key: f.key }
      if (f.cell) item.cell = f.cell
      if (f.block) item.block = f.block
      return item
    })
  } else {
    if (values.mode === 'text') spec.mode = 'text'
    if (values.mode === 'block' && values.block) {
      // extract.js 是看 spec.mode 分派的，少了這一行會落回數值策略鏈、抓到整張表的第一個數字
      spec.mode = 'block'
      spec.block = values.block
    }
  }
  for (const k of ['regex', 'attr', 'childSel', 'labelText']) {
    if (values[k]) spec[k] = values[k]
  }
  return spec
}

export async function applyPickerDefaults(task) {
  if (task) return

  const settings = await getSettings()
  const defaults = settings?.pickerDefaults
  let target = null
  if (defaults?.pinned) {
    target = defaults.pinned
  } else if (defaults?.last) {
    target = defaults.last
  } else {
    target = BUILTIN_DEFAULTS
  }

  if (target.scheduleType !== undefined) {
    const el = document.getElementById('schedule-type')
    if (el) el.value = target.scheduleType
  }
  if (target.times !== undefined) {
    const el = document.getElementById('times')
    if (el) {
      el.value = Array.isArray(target.times) ? target.times.join(', ') : target.times
    }
  }
  if (target.everyMinutes !== undefined) {
    const el = document.getElementById('every-minutes')
    if (el) el.value = target.everyMinutes
  }
  if (target.weekdays !== undefined && Array.isArray(target.weekdays)) {
    const wds = new Set(target.weekdays.map(Number))
    document.querySelectorAll('#weekdays input[type="checkbox"]').forEach(cb => {
      cb.checked = wds.has(Number(cb.value))
    })
  }
  if (target.windowFrom !== undefined) {
    const el = document.getElementById('window-from')
    if (el) el.value = target.windowFrom
  }
  if (target.windowTo !== undefined) {
    const el = document.getElementById('window-to')
    if (el) el.value = target.windowTo
  }
  if (target.aggregate !== undefined) {
    const el = document.getElementById('block-aggregate')
    if (el) el.value = target.aggregate
  }
  // 目標儀表板與卡片型別也是「上次怎麼設就怎麼帶回來」的一部分；
  // 只存不還原等於每次都要重選一遍
  if (target.dashboardId) {
    const sel = document.getElementById('dashboard-select')
    if (sel && [...sel.options].some(o => o.value === target.dashboardId)) {
      sel.value = target.dashboardId
    }
  }
  if (Array.isArray(target.cardTypes) && target.cardTypes.length > 0) {
    const wanted = new Set(target.cardTypes)
    for (const cb of document.querySelectorAll('#card-types input[type="checkbox"]')) {
      cb.checked = wanted.has(cb.value)
    }
  }

  syncScheduleFields()
}

export function buildTask(values, locator, existing) {
  const id = existing?.id || crypto.randomUUID()
  const spec = buildSpec(values)
  if (existing?.spec) {
    // 下拉會把舊策略當一個選項顯示，所以表單選什麼就是使用者要什麼；
    // 沒有對應控制項的參數（attr / childSel / labelText）一律保留
    for (const k of ['attr', 'childSel', 'labelText']) {
      if (existing.spec[k] !== undefined) {
        spec[k] = existing.spec[k]
      }
    }
  }

  let schedule
  if (values.scheduleType === 'daily') {
    schedule = { type: 'daily', times: values.times || [], weekdays: values.weekdays || [] }
  } else {
    schedule = { type: 'interval', everyMinutes: values.everyMinutes, weekdays: values.weekdays || [] }
    const hasFrom = typeof values.windowFrom === 'string' && values.windowFrom.trim() !== ''
    const hasTo = typeof values.windowTo === 'string' && values.windowTo.trim() !== ''
    if (hasFrom && hasTo) {
      schedule.window = { from: values.windowFrom.trim(), to: values.windowTo.trim() }
    }
  }

  const task = {
    id,
    name: values.name.trim(),
    url: values.url,
    mode: values.fields ? 'block' : values.mode,
    enabled: true,
    locator,
    spec,
    schedule
  }
  if (values.fields) {
    task.fields = values.fields.map(f => ({ key: f.key, name: f.name }))
  }
  if (Array.isArray(values.alerts)) {
    const validAlerts = values.alerts
      .filter(a => a && typeof a === 'object' && Number.isFinite(a.value))
      .map(a => {
        const item = {
          id: a.id || crypto.randomUUID(),
          type: a.type,
          value: Number(a.value),
          enabled: a.enabled !== false
        }
        if (a.field) {
          item.field = a.field
        }
        return item
      })
    if (validAlerts.length > 0) {
      task.alerts = validAlerts
    }
  }
  if (Array.isArray(values.preActions)) {
    const validPreActions = values.preActions
      .map(a => {
        if (!a || typeof a !== 'object') return null
        if (a.type === 'click') {
          const hasLoc = a.locator && typeof a.locator === 'object' && (a.locator.css || a.locator.path || a.locator.xpath || a.locator.anchor)
          if (!hasLoc) return null
          return { type: 'click', locator: a.locator }
        }
        if (a.type === 'waitFor') {
          const hasLoc = a.locator && typeof a.locator === 'object' && (a.locator.css || a.locator.path || a.locator.xpath || a.locator.anchor)
          if (!hasLoc) return null
          const timeoutMs = Number.isFinite(Number(a.timeoutMs)) ? Number(a.timeoutMs) : 20000
          return { type: 'waitFor', locator: a.locator, timeoutMs }
        }
        if (a.type === 'wait') {
          // 空字串經 Number() 會變成 0，看起來合法但其實是使用者沒填
          if (a.ms === '' || a.ms === null || a.ms === undefined) return null
          const ms = Number(a.ms)
          if (!Number.isFinite(ms)) return null
          return { type: 'wait', ms }
        }
        return null
      })
      .filter(Boolean)
    if (validPreActions.length > 0) {
      task.preActions = validPreActions
    }
  }
  if (existing?.order !== undefined) task.order = existing.order
  return task
}

export function render(ctx) {
  currentCtx = ctx || {}
  const previewEl = document.getElementById('preview')
  if (previewEl) {
    if (ctx?.preview !== undefined && ctx?.previewValue !== undefined && ctx.preview !== ctx.previewValue) {
      previewEl.textContent = `${ctx.preview} (${ctx.previewValue})`
    } else if (ctx?.preview !== undefined) {
      previewEl.textContent = String(ctx.preview)
    } else if (ctx?.previewValue !== undefined) {
      previewEl.textContent = String(ctx.previewValue)
    } else {
      previewEl.textContent = ''
    }
  }

  const urlEl = document.getElementById('url')
  if (urlEl) {
    if ('value' in urlEl) urlEl.value = ctx?.url || ''
    urlEl.textContent = ctx?.url || ''
  }

  if (ctx?.task) {
    const t = ctx.task
    if (t.name !== undefined) document.getElementById('name').value = t.name
    if (t.url !== undefined && urlEl) {
      if ('value' in urlEl) urlEl.value = t.url
      urlEl.textContent = t.url
    }
    if (t.mode !== undefined) document.getElementById('mode').value = t.mode
    if (t.spec?.strategy) {
      const sel = document.getElementById('strategy')
      const legacy = !['auto', 'regex'].includes(t.spec.strategy)
      // 下拉已不提供的舊策略：補一個選項讓它顯示得出來，否則會假裝成「自動」
      if (legacy && sel && ![...sel.options].some(o => o.value === t.spec.strategy)) {
        const opt = document.createElement('option')
        opt.value = t.spec.strategy
        opt.textContent = `${t.spec.strategy}（舊策略，保留）`
        sel.appendChild(opt)
      }
      if (sel) sel.value = t.spec.strategy
    }
    // 這個任務用的是已經從下拉移除的策略：不說明的話使用者會以為設定不見了
    const legacyNote = document.getElementById('legacy-strategy-note')
    if (legacyNote) {
      const legacy = t.spec?.strategy && !['auto', 'regex'].includes(t.spec.strategy)
      legacyNote.hidden = !legacy
      legacyNote.textContent = legacy
        ? `這個任務用的抓取策略是「${t.spec.strategy}」，下拉已不再提供，但設定會原樣保留;改選其他策略就會換掉。`
        : ''
    }
    if (t.spec?.regex !== undefined) document.getElementById('regex').value = t.spec.regex
    if (t.schedule?.type) document.getElementById('schedule-type').value = t.schedule.type
    if (t.schedule?.times) document.getElementById('times').value = t.schedule.times.join(', ')
    if (t.schedule?.everyMinutes !== undefined) document.getElementById('every-minutes').value = t.schedule.everyMinutes
    if (t.schedule?.weekdays) {
      const wds = new Set(t.schedule.weekdays)
      document.querySelectorAll('#weekdays input[type="checkbox"]').forEach(cb => {
        cb.checked = wds.has(Number(cb.value))
      })
    }
    if (t.schedule?.window) {
      if (t.schedule.window.from) document.getElementById('window-from').value = t.schedule.window.from
      if (t.schedule.window.to) document.getElementById('window-to').value = t.schedule.window.to
    }
    if (t.spec?.block) {
      currentBlock = { ...t.spec.block }
      const aggEl = document.getElementById('block-aggregate')
      if (aggEl && t.spec.block.aggregate) aggEl.value = t.spec.block.aggregate
    }
  } else {
    const nameEl = document.getElementById('name')
    if (nameEl && !nameEl.value.trim()) {
      let defaultName = ''
      if (ctx?.nameHint && String(ctx.nameHint).trim()) {
        defaultName = String(ctx.nameHint).trim()
      } else if (ctx?.locator?.anchor?.text && String(ctx.locator.anchor.text).trim()) {
        defaultName = String(ctx.locator.anchor.text).trim()
      } else if (ctx?.preview !== undefined && ctx?.preview !== null && String(ctx.preview).trim()) {
        defaultName = String(ctx.preview).trim().slice(0, 20)
      }
      if (defaultName) {
        nameEl.value = defaultName
      }
    }
  }

  const isMulti = Boolean((ctx?.picks && Array.isArray(ctx.picks) && ctx.picks.length >= 2) || (ctx?.task && Array.isArray(ctx.task.fields) && ctx.task.fields.length > 0))
  if (isMulti) {
    const modeEl = document.getElementById('mode')
    if (modeEl) modeEl.value = 'block'
  }

  if (ctx?.picks && Array.isArray(ctx.picks) && ctx.picks.length === 1 && ctx.picks[0].block) {
    currentBlock = {
      ...(currentBlock || {}),
      ...ctx.picks[0].block
    }
    const modeEl = document.getElementById('mode')
    if (modeEl) modeEl.value = 'block'
  } else if (ctx?.blockInfo && (ctx.blockInfo.kind === 'table' || ctx.blockInfo.kind === 'grid')) {
    const b = ctx.blockInfo
    currentBlock = {
      axis: b.axis,
      index: b.index,
      headerText: b.headerText,
      rows: b.rows,
      cols: b.cols,
      kind: b.kind
    }
    const modeEl = document.getElementById('mode')
    if (modeEl) modeEl.value = 'block'
  } else if (!ctx?.task?.spec?.block && !isMulti) {
    currentBlock = null
    const modeEl = document.getElementById('mode')
    if (modeEl && !ctx?.task && modeEl.value === 'block') {
      modeEl.value = 'number'
    }
  }

  if (ctx?.picks && Array.isArray(ctx.picks) && ctx.picks.length >= 2) {
    const usedKeys = new Set()
    const nameCounts = new Map()
    const items = ctx.picks.map((pick, index) => {
      let key = crypto.randomUUID().slice(0, 8)
      while (usedKeys.has(key)) {
        key = crypto.randomUUID().slice(0, 8)
      }
      usedKeys.add(key)

      let rawName = ''
      if (pick.cell) {
        const rowH = pick.cell.row?.header?.trim() || ''
        const colH = pick.cell.col?.header?.trim() || ''
        if (rowH && colH) {
          rawName = `${rowH} · ${colH}`
        } else if (rowH || colH) {
          rawName = rowH || colH
        } else {
          rawName = `值 ${index + 1}`
        }
      } else if (pick.block) {
        rawName = pick.block.headerText?.trim() || `值 ${index + 1}`
      } else {
        rawName = `值 ${index + 1}`
      }

      const count = (nameCounts.get(rawName) || 0) + 1
      nameCounts.set(rawName, count)
      const name = count === 1 ? rawName : `${rawName} ${count}`

      const spec = {}
      if (pick.cell) spec.cell = pick.cell
      if (pick.block) spec.block = pick.block

      return { key, name, spec }
    })
    renderFieldList(items)
    // 值的數量會改變預設要建哪幾張卡，清單建好才算得準
    applyDefaultCardTypes()
  } else if (ctx?.task && Array.isArray(ctx.task.fields) && ctx.task.fields.length > 0) {
    const items = ctx.task.fields.map(field => {
      const matchingSpec = ctx.task.spec?.fields?.find(f => f.key === field.key)
      const spec = {}
      if (matchingSpec?.cell) spec.cell = matchingSpec.cell
      if (matchingSpec?.block) spec.block = matchingSpec.block
      return {
        key: field.key,
        name: field.name,
        spec
      }
    })
    renderFieldList(items)
    // 值的數量會改變預設要建哪幾張卡，清單建好才算得準
    applyDefaultCardTypes()
  } else {
    renderFieldList([])
    // 值的數量會改變預設要建哪幾張卡，清單建好才算得準
    applyDefaultCardTypes()
  }

  const alertList = document.getElementById('alert-list')
  if (alertList) {
    alertList.replaceChildren()
  }
  if (Array.isArray(ctx?.task?.alerts)) {
    for (const a of ctx.task.alerts) {
      addAlertRow(a)
    }
  }

  const preactionList = document.getElementById('preaction-list')
  if (preactionList) {
    preactionList.replaceChildren()
  }
  if (Array.isArray(ctx?.task?.preActions)) {
    for (const pa of ctx.task.preActions) {
      addPreActionRow(pa)
    }
  }

  const advSection = document.getElementById('advanced-section')
  if (advSection) {
    if (ctx?.task) {
      const t = ctx.task
      const hasStrategy = t.spec?.strategy && t.spec.strategy !== 'auto'
      const hasRegex = Boolean(t.spec?.regex)
      const hasWindow = Boolean(t.schedule?.window)
      const hasAlerts = Array.isArray(t.alerts) && t.alerts.length > 0
      const hasPreActions = Array.isArray(t.preActions) && t.preActions.length > 0

      if (hasStrategy || hasRegex || hasWindow || hasAlerts || hasPreActions) {
        advSection.setAttribute('open', '')
      } else {
        advSection.removeAttribute('open')
      }
    } else {
      advSection.removeAttribute('open')
    }
  }

  bindModeEvents()
  syncScheduleFields()
  bindAlertEvents()
  bindPreActionEvents()
  bindPreActionMessageListener()
  updateBlockSection()
}

// 卡片型別對應的預設尺寸
const CARD_SIZES = {
  number: { w: 3, h: 2 },
  gauge: { w: 3, h: 2 },
  line: { w: 6, h: 3 },
  bar: { w: 6, h: 3 },
  table: { w: 12, h: 3 }
}

/**
 * 依目前模式套用預設勾選
 */
function applyDefaultCardTypes() {
  const modeVal = document.getElementById('mode')?.value || 'number'
  const cardTypes = document.getElementById('card-types')
  if (!cardTypes) return
  // 多個值用一張樞紐表加一張折線就看得完；一個值長兩張卡會被當成重複
  const multi = document.querySelectorAll('#field-list [data-field-row]').length >= 2
  const checkboxes = cardTypes.querySelectorAll('input[type="checkbox"]')
  for (const cb of checkboxes) {
    if (multi) {
      cb.checked = (cb.value === 'table' || cb.value === 'line')
    } else if (modeVal === 'text') {
      cb.checked = (cb.value === 'table')
    } else {
      cb.checked = (cb.value === 'number')
    }
  }
}

/**
 * 更新區塊設定區顯示與說明文字
 */
function updateBlockSection() {
  const section = document.getElementById('block-section')
  if (!section) return
  const modeVal = document.getElementById('mode')?.value || 'number'
  if (modeVal !== 'block') {
    section.hidden = true
    return
  }

  section.hidden = false
  const summaryEl = document.getElementById('block-summary')
  if (!summaryEl) return

  const hasFields = document.querySelectorAll('#field-list [data-field-row]').length > 0
  if (hasFields) {
    if (currentBlock && currentBlock.rows !== undefined && currentBlock.cols !== undefined) {
      summaryEl.textContent = `表格 ${currentBlock.rows} 列 × ${currentBlock.cols} 欄`
    } else {
      summaryEl.textContent = ''
    }
    return
  }

  // index 為 null 代表使用者只選到表格、還沒點任何一欄或一列，不能當成選了第 0 欄
  if (currentBlock && (currentBlock.headerText || currentBlock.index !== undefined && currentBlock.index !== null)) {
    const isRow = currentBlock.axis === 'row'
    const targetDesc = currentBlock.headerText
      ? `「${currentBlock.headerText}」這${isRow ? '一列' : '一欄'}`
      : `第 ${Number(currentBlock.index) + 1} ${isRow ? '列' : '欄'}`

    const prefix = (currentBlock.rows !== undefined && currentBlock.cols !== undefined)
      ? `表格 ${currentBlock.rows} 列 × ${currentBlock.cols} 欄，`
      : '表格，'
    summaryEl.textContent = `${prefix}取${targetDesc}`
  } else {
    summaryEl.textContent = '請回到目標頁面重新選取，並在表格上點一欄或一列'
  }
}

/**
 * 依排程型別只顯示相關欄位(隱藏的欄位保留已填的值,切回來還在)
 */
function syncScheduleFields() {
  const type = document.getElementById('schedule-type')?.value || 'daily'
  document.querySelectorAll('[data-schedule-only]').forEach(el => {
    el.hidden = el.getAttribute('data-schedule-only') !== type
  })
}

/**
 * 綁定模式切換事件
 */
function bindModeEvents() {
  const modeEl = document.getElementById('mode')
  if (modeEl && !modeEl._modeEventsBound) {
    modeEl.addEventListener('change', () => {
      applyDefaultCardTypes()
      updateBlockSection()
    })
    modeEl._modeEventsBound = true
  }
  const schedEl = document.getElementById('schedule-type')
  if (schedEl && !schedEl._scheduleEventsBound) {
    schedEl.addEventListener('change', syncScheduleFields)
    schedEl._scheduleEventsBound = true
  }
}

function populateAlertFieldOptions(select, selectedKey) {
  select.replaceChildren()
  const allOpt = document.createElement('option')
  allOpt.value = ''
  allOpt.textContent = '全部值'
  select.appendChild(allOpt)

  const fieldRows = document.querySelectorAll('#field-list [data-field-row]')
  let keyFound = false
  fieldRows.forEach((row, i) => {
    const key = row.dataset.fieldKey || ''
    const inputVal = row.querySelector('input[data-field-name]')?.value?.trim()
    const name = inputVal || `值 ${i + 1}`
    const opt = document.createElement('option')
    opt.value = key
    opt.textContent = name
    if (key && key === selectedKey) {
      opt.selected = true
      keyFound = true
    }
    select.appendChild(opt)
  })

  if (selectedKey && keyFound) {
    select.value = selectedKey
  } else {
    select.value = ''
  }
}

function updateAlertRowsFields() {
  const fieldRows = document.querySelectorAll('#field-list [data-field-row]')
  const alertRows = document.querySelectorAll('[data-alert-row]')
  const hasMulti = fieldRows.length >= 2

  for (const row of alertRows) {
    let fieldSelect = row.querySelector('select[data-alert-field]')
    if (hasMulti) {
      if (!fieldSelect) {
        fieldSelect = document.createElement('select')
        fieldSelect.setAttribute('data-alert-field', '')
        const typeSelect = row.querySelector('select.alert-type') || row.querySelector('select')
        if (typeSelect) {
          row.insertBefore(fieldSelect, typeSelect)
        } else {
          row.prepend(fieldSelect)
        }
      }
      const currentVal = fieldSelect.value
      populateAlertFieldOptions(fieldSelect, currentVal)
    } else {
      if (fieldSelect) {
        fieldSelect.remove()
      }
    }
  }
}

function updateFieldListState() {
  const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  const n = rows.length
  rows.forEach((r, i) => {
    const upBtn = r.querySelector('[data-field-up]')
    const downBtn = r.querySelector('[data-field-down]')
    if (upBtn) upBtn.disabled = (i === 0)
    if (downBtn) downBtn.disabled = (i === n - 1)
  })

  const summaryEl = document.getElementById('save-summary')
  if (summaryEl) {
    if (n >= 2) {
      summaryEl.hidden = false
      if (currentCtx?.task) {
        summaryEl.textContent = `這個任務有 ${n} 個值`
      } else {
        summaryEl.textContent = `將建立 1 個任務、${n} 個值`
      }
    } else {
      summaryEl.hidden = true
    }
  }

  updateAlertRowsFields()
  updateBlockSection()
}

function createFieldRow({ key, name, spec }) {
  const row = document.createElement('div')
  row.className = 'field-row'
  row.setAttribute('data-field-row', '')
  row.dataset.fieldKey = key
  row._spec = spec

  const input = document.createElement('input')
  input.type = 'text'
  input.setAttribute('data-field-name', '')
  input.value = name
  input.placeholder = '值名稱'
  input.addEventListener('input', () => {
    updateAlertRowsFields()
  })

  const upBtn = document.createElement('button')
  upBtn.type = 'button'
  upBtn.setAttribute('data-field-up', '')
  upBtn.textContent = '上移'
  upBtn.addEventListener('click', () => {
    const prev = row.previousElementSibling
    if (prev && prev.hasAttribute('data-field-row')) {
      row.parentNode.insertBefore(row, prev)
      updateFieldListState()
    }
  })

  const downBtn = document.createElement('button')
  downBtn.type = 'button'
  downBtn.setAttribute('data-field-down', '')
  downBtn.textContent = '下移'
  downBtn.addEventListener('click', () => {
    const next = row.nextElementSibling
    if (next && next.hasAttribute('data-field-row')) {
      row.parentNode.insertBefore(next, row)
      updateFieldListState()
    }
  })

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.setAttribute('data-field-remove', '')
  removeBtn.textContent = '移除'
  removeBtn.addEventListener('click', () => {
    row.remove()
    updateFieldListState()
  })

  row.appendChild(input)
  row.appendChild(upBtn)
  row.appendChild(downBtn)
  row.appendChild(removeBtn)

  return row
}

function renderFieldList(items) {
  const fieldList = document.getElementById('field-list')
  if (!fieldList) return
  fieldList.replaceChildren()
  fieldSpecs.clear()

  for (const item of items) {
    fieldSpecs.set(item.key, item.spec)
    const row = createFieldRow(item)
    fieldList.appendChild(row)
  }

  updateFieldListState()
  // 一格就是一個值，沒有東西要聚合；有整欄／整列的值時才需要選聚合方式
  const aggLabel = document.getElementById('block-aggregate')?.closest('label')
  if (aggLabel) {
    const hasBlockField = (items || []).some(it => it && it.spec && it.spec.block)
    aggLabel.hidden = (items || []).length > 0 && !hasBlockField
  }

}

/**
 * 在 #alert-list 裡新增一列告警條件
 */
function addAlertRow(data = {}) {
  const list = document.getElementById('alert-list')
  if (!list) return null

  const row = document.createElement('div')
  row.className = 'alert-row'
  row.setAttribute('data-alert-row', '')
  row.dataset.id = data.id || crypto.randomUUID()

  const fieldRows = document.querySelectorAll('#field-list [data-field-row]')
  if (fieldRows.length >= 2) {
    const fieldSelect = document.createElement('select')
    fieldSelect.setAttribute('data-alert-field', '')
    populateAlertFieldOptions(fieldSelect, data.field || '')
    row.appendChild(fieldSelect)
  }

  const select = document.createElement('select')
  select.className = 'alert-type'
  const options = [
    { value: 'gt', text: '值大於' },
    { value: 'lt', text: '值小於' },
    { value: 'eq', text: '值等於' },
    { value: 'deltaPct', text: '變動幅度(%)超過' },
    { value: 'failStreak', text: '連續失敗次數達到' }
  ]
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.text
    if (opt.value === (data.type || 'gt')) {
      el.selected = true
    }
    select.appendChild(el)
  }
  select.value = data.type || 'gt'

  const input = document.createElement('input')
  input.type = 'number'
  input.className = 'alert-value'
  input.placeholder = '數值'
  input.step = 'any'
  if (data.value !== undefined && data.value !== null && !Number.isNaN(data.value) && String(data.value).trim() !== '') {
    input.value = String(data.value)
  }

  const label = document.createElement('label')
  label.className = 'alert-enable'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'alert-enabled'
  checkbox.checked = data.enabled !== false
  label.appendChild(checkbox)
  label.appendChild(document.createTextNode('啟用'))

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.setAttribute('data-action', 'alert-remove')
  removeBtn.textContent = '刪除'
  removeBtn.addEventListener('click', () => {
    row.remove()
  })

  row.appendChild(select)
  row.appendChild(input)
  row.appendChild(label)
  row.appendChild(removeBtn)

  list.appendChild(row)
  return row
}

/**
 * 綁定告警條件新增按鈕事件（僅綁定一次）
 */
function bindAlertEvents() {
  const addBtn = document.getElementById('alert-add')
  if (addBtn && !addBtn._alertEventsBound) {
    addBtn.addEventListener('click', () => {
      addAlertRow()
    })
    addBtn._alertEventsBound = true
  }
}

let lastPreActionPickRow = null
let _preActionMessageBound = false

/**
 * 更新單列前置動作的定位資訊顯示文字
 */
function updatePreActionLocatorText(row) {
  const targetEl = row.querySelector('.preaction-target')
  if (!targetEl) return
  const loc = row._locator
  targetEl.textContent = (loc?.css || loc?.path || '') || '尚未選取'
}

/**
 * 切換單列前置動作欄位的顯示狀態
 */
function updatePreActionRowVisibility(row) {
  const select = row.querySelector('select')
  const pickBtn = row.querySelector('[data-action="preaction-pick"]')
  const targetEl = row.querySelector('.preaction-target')
  const input = row.querySelector('input[type="number"]')

  const type = select?.value || 'waitFor'
  if (pickBtn) pickBtn.hidden = (type === 'wait')
  if (targetEl) targetEl.hidden = (type === 'wait')
  if (input) {
    input.hidden = (type === 'click')
    if (type === 'wait') {
      input.placeholder = '毫秒數'
    } else if (type === 'waitFor') {
      input.placeholder = '逾時毫秒'
      if (!input.value) {
        input.value = '20000'
      }
    }
  }
}

/**
 * 在 #preaction-list 裡新增一列前置動作
 */
function addPreActionRow(data = {}) {
  const list = document.getElementById('preaction-list')
  if (!list) return null

  const row = document.createElement('div')
  row.className = 'preaction-row'
  row.setAttribute('data-preaction-row', '')
  row._locator = data.locator || null

  const select = document.createElement('select')
  select.className = 'preaction-type'
  const options = [
    { value: 'waitFor', text: '等元素出現' },
    { value: 'click', text: '點擊元素' },
    { value: 'wait', text: '等待秒數' }
  ]
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.text
    if (opt.value === (data.type || 'waitFor')) {
      el.selected = true
    }
    select.appendChild(el)
  }
  select.value = data.type || 'waitFor'
  select.addEventListener('change', () => {
    updatePreActionRowVisibility(row)
  })

  const pickBtn = document.createElement('button')
  pickBtn.type = 'button'
  pickBtn.setAttribute('data-action', 'preaction-pick')
  pickBtn.textContent = '在頁面上選取'
  pickBtn.addEventListener('click', () => {
    lastPreActionPickRow = row
    if (globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: MSG.ENTER_PICK,
        purpose: 'preaction',
        tabId: currentCtx?.tabId,
        taskId: currentCtx?.task?.id
      })
    }
  })

  const targetEl = document.createElement('span')
  targetEl.className = 'preaction-target'

  const input = document.createElement('input')
  input.type = 'number'
  input.className = 'preaction-num'
  input.min = '0'
  input.step = '1'
  if (data.type === 'wait') {
    if (data.ms !== undefined && data.ms !== null && !Number.isNaN(data.ms) && String(data.ms).trim() !== '') {
      input.value = String(data.ms)
    }
  } else if (data.type === 'click') {
    input.value = ''
  } else {
    if (data.timeoutMs !== undefined && data.timeoutMs !== null && !Number.isNaN(data.timeoutMs) && String(data.timeoutMs).trim() !== '') {
      input.value = String(data.timeoutMs)
    } else {
      input.value = '20000'
    }
  }

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.setAttribute('data-action', 'preaction-remove')
  removeBtn.textContent = '刪除'
  removeBtn.addEventListener('click', () => {
    if (lastPreActionPickRow === row) {
      lastPreActionPickRow = null
    }
    row.remove()
  })

  row.appendChild(select)
  row.appendChild(pickBtn)
  row.appendChild(targetEl)
  row.appendChild(input)
  row.appendChild(removeBtn)

  updatePreActionLocatorText(row)
  updatePreActionRowVisibility(row)

  list.appendChild(row)
  return row
}

/**
 * 綁定前置動作新增按鈕事件（僅綁定一次）
 */
function bindPreActionEvents() {
  const addBtn = document.getElementById('preaction-add')
  if (addBtn && !addBtn._preactionEventsBound) {
    addBtn.addEventListener('click', () => {
      addPreActionRow()
    })
    addBtn._preactionEventsBound = true
  }
}

/**
 * 綁定選取結果接收監聽器（僅綁定一次）
 */
function bindPreActionMessageListener() {
  if (_preActionMessageBound) return
  if (globalThis.chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === MSG.PICKED && msg.purpose === 'preaction') {
        if (lastPreActionPickRow && !msg.cancelled) {
          lastPreActionPickRow._locator = msg.locator || null
          updatePreActionLocatorText(lastPreActionPickRow)
        }
      }
    })
    _preActionMessageBound = true
  }
}

/**
 * 渲染加入儀表板區塊
 */
export async function renderDashboardSection(task) {
  const section = document.getElementById('add-to-dashboard')
  if (task) {
    if (section) section.hidden = true
    return
  }
  if (section) {
    section.hidden = false
  }

  const select = document.getElementById('dashboard-select')
  if (select) {
    select.replaceChildren()
    const layout = await getLayout()
    const dashboards = layout?.dashboards || []
    for (const d of dashboards) {
      const opt = document.createElement('option')
      opt.value = d.id
      opt.textContent = d.name
      select.appendChild(opt)
    }
    const noneOpt = document.createElement('option')
    noneOpt.value = 'none'
    noneOpt.textContent = '不加入'
    select.appendChild(noneOpt)

    if (dashboards.length > 0) {
      select.value = dashboards[0].id
    } else {
      select.value = 'none'
    }
  }

  applyDefaultCardTypes()
  bindModeEvents()
}

export async function handleSave() {
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''

  const values = getFormData()
  if (!values.url && currentCtx?.url) values.url = currentCtx.url

  const validation = validateForm(values)
  if (!validation.ok) {
    if (errorsEl) errorsEl.textContent = Object.values(validation.errors).join('\n')
    return
  }

  const task = buildTask(values, currentCtx?.locator, currentCtx?.task)
  await saveTask(task)
  if (globalThis.chrome?.runtime?.sendMessage) {
    await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
  }

  // 只有新建任務才記住預設值
  if (!currentCtx?.task) {
    const currentDefaults = {
      scheduleType: values.scheduleType || 'daily',
      times: values.times || [],
      everyMinutes: Number.isFinite(values.everyMinutes) && values.everyMinutes > 0 ? values.everyMinutes : 15,
      weekdays: values.weekdays || [],
      windowFrom: values.windowFrom || '',
      windowTo: values.windowTo || '',
      aggregate: document.getElementById('block-aggregate')?.value || 'sum',
      dashboardId: (document.getElementById('dashboard-select')?.value !== 'none' ? document.getElementById('dashboard-select')?.value : '') || '',
      cardTypes: Array.from(document.querySelectorAll('#card-types input[type="checkbox"]:checked')).map(cb => cb.value)
    }
    const settings = await getSettings()
    const existingDefaults = settings?.pickerDefaults || {}
    const newDefaults = { ...existingDefaults, last: currentDefaults }
    const pinChecked = document.getElementById('pin-defaults')?.checked
    if (pinChecked) {
      newDefaults.pinned = currentDefaults
    }
    await saveSettings({ pickerDefaults: newDefaults })
  }

  // 只有新建任務才處理加入儀表板卡片
  if (!currentCtx?.task) {
    const dashSelect = document.getElementById('dashboard-select')
    const selectedDashId = dashSelect?.value
    if (dashSelect && selectedDashId !== 'none') {
      const checkedBoxes = Array.from(document.querySelectorAll('#card-types input[type="checkbox"]:checked'))
      if (checkedBoxes.length > 0) {
        const layout = await getLayout()
        const dashboards = layout?.dashboards || []
        let targetDash = dashboards.find(d => d.id === selectedDashId)
        if (!targetDash && dashboards.length > 0) {
          targetDash = dashboards[0]
        }
        if (targetDash) {
          // 多值任務的紀錄寫在子序列 id 底下，卡片來源指到父任務會永遠顯示破折號
          const sourceIds = Array.isArray(task.fields) && task.fields.length > 0
            ? task.fields.map(f => seriesIdOf(task.id, f.key))
            : [task.id]
          for (const box of checkedBoxes) {
            const type = box.value
            const size = CARD_SIZES[type] ?? { w: 6, h: 3 }
            // 單一來源的卡片型別只吃第一個值，多來源的型別全部帶上
            const ids = ['number', 'gauge'].includes(type) ? sourceIds.slice(0, 1) : sourceIds
            await addCard(targetDash.id, {
              type,
              source: ids.map(id => ({ taskId: id, aggregation: 'raw' })),
              options: type === 'table'
                ? (sourceIds.length > 1
                    // 多個值要看的是「同一時刻各值並排」與「每天差多少」
                    ? { mode: 'pivot', bucketMinutes: 1440, showDelta: true }
                    : { mode: 'recent' })
                : {},
              x: 0,
              y: 0,
              w: size.w,
              h: size.h
            })
          }
        }
      }
    }
  }

  if (typeof window !== 'undefined' && window.close) {
    window.close()
  }
}

export async function handleTestNow() {
  const previewEl = document.getElementById('preview')
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''

  const values = getFormData()
  const spec = buildSpec(values)

  try {
    const res = await chrome.tabs.sendMessage(currentCtx?.tabId, {
      type: MSG.EXTRACT,
      locator: currentCtx?.locator,
      spec
    })
    if (res && res.ok) {
      if (values.fields) {
        const lines = values.fields.map(f => {
          const fieldRes = res.fields?.[f.key]
          if (fieldRes && fieldRes.ok) {
            const val = fieldRes.value !== undefined ? String(fieldRes.value) : (fieldRes.raw ?? '')
            return `${f.name}: ${val}`
          } else {
            const err = fieldRes?.error || '抓取失敗'
            return `${f.name}: ${err}`
          }
        })
        if (previewEl) previewEl.textContent = lines.join('\n')
      } else {
        if (previewEl) previewEl.textContent = res.value !== undefined ? String(res.value) : (res.raw ?? '')
      }
    } else {
      const err = res?.error || '找不到目標元素'
      if (previewEl) previewEl.textContent = err
      if (errorsEl) errorsEl.textContent = err
    }
  } catch (e) {
    const err = e?.message || '找不到目標元素'
    if (previewEl) previewEl.textContent = err
    if (errorsEl) errorsEl.textContent = err
  }
}

export async function initFromQuery(search) {
  const params = new URLSearchParams(search || '')
  const taskId = params.get('taskId')
  if (!taskId) return
  const task = await getTask(taskId)
  if (!task) return
  render({ task, locator: task.locator, url: task.url })
  const testNow = document.getElementById('test-now')
  if (testNow) {
    testNow.hidden = true
  }
}

if (typeof document !== 'undefined' && document.getElementById('save') && globalThis.chrome?.runtime?.id) {
  document.getElementById('save')?.addEventListener('click', () => handleSave())
  document.getElementById('cancel')?.addEventListener('click', () => window.close())
  document.getElementById('test-now')?.addEventListener('click', () => handleTestNow())
  bindModeEvents()
  bindAlertEvents()
  bindPreActionEvents()
  bindPreActionMessageListener()

  const search = typeof window !== 'undefined' ? window.location?.search : ''
  const params = new URLSearchParams(search || '')
  if (params.has('taskId')) {
    initFromQuery(search).then(() => {
      renderDashboardSection(currentCtx?.task)
    })
  } else if (params.has('ctx')) {
    try {
      const parsed = JSON.parse(decodeURIComponent(params.get('ctx')))
      render(parsed)
      applyPickerDefaults(parsed?.task)
      renderDashboardSection(parsed?.task)
    } catch {
      applyPickerDefaults(null)
      renderDashboardSection(null)
    }
  } else {
    applyPickerDefaults(null)
    renderDashboardSection(null)
  }
}
