import { saveTask, getTask } from '../../shared/storage.js'
import { MSG } from '../../shared/messages.js'
import { getLayout, addCard } from '../../shared/layout-store.js'

let currentCtx = null
let currentBlock = null
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
    const type = row.querySelector('select')?.value || 'gt'
    const valInput = row.querySelector('input:not([type="checkbox"])') || row.querySelector('input')
    const valStr = valInput?.value?.trim() ?? ''
    const value = valStr === '' ? NaN : Number(valStr)
    const cb = row.querySelector('input[type="checkbox"]')
    const enabled = cb ? cb.checked : true
    return { id, type, value, enabled }
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

  const data = {
    name, url, mode, strategy, regex, scheduleType, times, weekdays, everyMinutes, windowFrom, windowTo,
    alerts,
    preActions
  }

  if (mode === 'block') {
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

export function buildTask(values, locator, existing) {
  const id = existing?.id || crypto.randomUUID()
  const spec = { strategy: values.strategy }
  if (values.mode === 'text') spec.mode = 'text'
  if (values.mode === 'block' && values.block) {
    // extract.js 是看 spec.mode 分派的，少了這一行會落回數值策略鏈、抓到整張表的第一個數字
    spec.mode = 'block'
    spec.block = values.block
  }
  for (const k of ['regex', 'attr', 'childSel', 'labelText']) {
    if (values[k]) spec[k] = values[k]
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
    mode: values.mode,
    enabled: true,
    locator,
    spec,
    schedule
  }
  if (Array.isArray(values.alerts)) {
    const validAlerts = values.alerts
      .filter(a => a && typeof a === 'object' && Number.isFinite(a.value))
      .map(a => ({
        id: a.id || crypto.randomUUID(),
        type: a.type,
        value: Number(a.value),
        enabled: a.enabled !== false
      }))
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
    if (t.spec?.strategy) document.getElementById('strategy').value = t.spec.strategy
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
  }

  if (ctx?.blockInfo && (ctx.blockInfo.kind === 'table' || ctx.blockInfo.kind === 'grid')) {
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
  } else if (!ctx?.task?.spec?.block) {
    currentBlock = null
    const modeEl = document.getElementById('mode')
    if (modeEl && !ctx?.task && modeEl.value === 'block') {
      modeEl.value = 'number'
    }
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
  const checkboxes = cardTypes.querySelectorAll('input[type="checkbox"]')
  for (const cb of checkboxes) {
    if (modeVal === 'text') {
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
          for (const box of checkedBoxes) {
            const type = box.value
            const size = CARD_SIZES[type] ?? { w: 6, h: 3 }
            await addCard(targetDash.id, {
              type,
              source: [{ taskId: task.id, aggregation: 'raw' }],
              options: type === 'table' ? { mode: 'recent' } : {},
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
  const spec = { strategy: values.strategy }
  if (values.mode === 'text') spec.mode = 'text'
  for (const k of ['regex', 'attr', 'childSel', 'labelText']) {
    if (values[k]) spec[k] = values[k]
  }

  try {
    const res = await chrome.tabs.sendMessage(currentCtx?.tabId, {
      type: MSG.EXTRACT,
      locator: currentCtx?.locator,
      spec
    })
    if (res && res.ok) {
      if (previewEl) previewEl.textContent = res.value !== undefined ? String(res.value) : (res.raw ?? '')
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
      renderDashboardSection(parsed?.task)
    } catch {
      renderDashboardSection(null)
    }
  } else {
    renderDashboardSection(null)
  }
}
