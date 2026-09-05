import { saveTask, getTask } from '../../shared/storage.js'
import { MSG } from '../../shared/messages.js'
import { getLayout, addCard } from '../../shared/layout-store.js'

let currentCtx = null
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

  return { name, url, mode, strategy, regex, scheduleType, times, weekdays, everyMinutes, windowFrom, windowTo }
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

  const hasFrom = typeof values.windowFrom === 'string' && values.windowFrom.trim() !== ''
  const hasTo = typeof values.windowTo === 'string' && values.windowTo.trim() !== ''
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
  }
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
      cb.checked = (cb.value === 'number' || cb.value === 'line')
    }
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

  const modeEl = document.getElementById('mode')
  if (modeEl && !modeEl._dashSectionBound) {
    modeEl.addEventListener('change', applyDefaultCardTypes)
    modeEl._dashSectionBound = true
  }
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
