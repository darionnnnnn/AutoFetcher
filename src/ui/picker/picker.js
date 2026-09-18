import { saveTask, getTask, getTasks, saveTasks, getSettings, saveSettings, getPanelCtx, setPanelCtx, mergePanelCtx, subscribe, deleteLastValues
} from '../../shared/storage.js'
import { applySavedTheme } from '../theme-apply.js'
import { DEFAULT_HOVER_HOLD_MS, DEFAULT_WAIT_TIMEOUT_MS } from '../../shared/preaction.js'
import { MSG, MAX_BATCH_TASKS } from '../../shared/messages.js'
import { getLayout, addCard, pruneSeries } from '../../shared/layout-store.js'
import { seriesIdOf } from '../../shared/series-index.js'
import { describeSchedule, describeTarget, describeDashboard, numericHeaderAxis, POS_TEXT, withInnerLabel, skipNote } from '../../shared/describe.js'
import { nextIntervalRun } from '../../shared/schedule-math.js'
import { isAnchorText, putInner, skipOf, putSkip, excludeOf, putExclude } from '../../shared/table.js'
import { reconcileFields } from '../../shared/field-match.js'
import { download } from '../../shared/export.js'

let currentCtx = null
let currentBlock = null
const fieldSpecs = new Map()
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
// 批次畫面（AF-18 G-3）的模組狀態：放在檔頭，面板啟動流程（檔尾的正式接線）不論先後都讀得到
let batchItems = null
let batchViewOn = false
// 整批改排程（AF-19 作業 C）的模組狀態
let bulkTaskIds = null
let bulkCount = 0
let bulkViewOn = false
const WAITING_TEXT = {
  single: { title: '正在頁面上選取…', desc: '把滑鼠移到要抓的內容上，點一下選取；好了按頁面右下角的「完成」。' },
  batch: {
    title: '正在頁面上選取（一次建立多個任務）…',
    desc: '點你要抓的內容；不同的表格或元素會各自成為一個任務。好了按頁面右下角的「完成」。'
  }
}
const SHARED_IDS = ['schedule-type', 'times', 'every-minutes', 'window-enabled', 'window-from', 'window-to', 'dashboard-select']

function skipFromForm() {
  const row = document.querySelector('[data-skip-row]')
  if (!row || row.hidden) return { head: 0, tail: 0 }
  const head = Number(document.getElementById('skip-head')?.value)
  const tail = Number(document.getElementById('skip-tail')?.value)
  const blank = document.getElementById('skip-blank')?.checked ?? false
  return skipOf({ head, tail, blank })
}

// 整欄用「列」、整列用「格」、混著用「筆」：略過欄位的標籤與儲存摘要共用這一份
function skipUnitOf(blockSpecs) {
  if (blockSpecs.length > 0 && blockSpecs.every(b => b.axis === 'col')) return '列'
  if (blockSpecs.length > 0 && blockSpecs.every(b => b.axis === 'row')) return '格'
  return '筆'
}

// 儲存前的摘要：略過是整個任務一份、存了就套到每個整欄整列的值，要在按儲存之前說出來（白話經 describe.js）
function updateSaveSummary() {
  const summaryEl = document.getElementById('save-summary')
  if (!summaryEl) return
  const n = document.querySelectorAll('#field-list [data-field-row]').length
  if (n < 2) {
    summaryEl.hidden = true
    return
  }
  summaryEl.hidden = false
  const base = currentCtx?.task ? `這個任務有 ${n} 個值` : `將建立 1 個任務、${n} 個值`
  summaryEl.textContent = base + skipNote(skipFromForm(), skipUnitOf(currentBlockSpecs()))
}

function currentBlockSpecs() {
  const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  const n = rows.length
  return n > 0
    ? rows.map(r => (r._spec || fieldSpecs.get(r.dataset.fieldKey || ''))?.block).filter(Boolean)
    : ((currentBlock && !currentBlock.cell && currentBlock.axis) ? [currentBlock] : [])
}

export function getFormData() {
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

    const frame = row._frame || null
    if (type === 'waitFor') {
      // 畫面是秒、資料是毫秒；沒填就交給 buildTask 那一份預設值（不要兩層各寫一份）
      const act = { type, locator }
      if (valStr !== '' && Number.isFinite(num)) act.timeoutMs = Math.round(num * 1000)
      const visibleBox = row.querySelector('[data-preaction-visible]')
      if (visibleBox && !visibleBox.checked) act.visible = false
      if (frame) act.frame = frame
      return act
    }
    if (type === 'hover') {
      const act = { type, locator }
      if (valStr !== '' && Number.isFinite(num)) act.holdMs = num
      if (frame) act.frame = frame
      return act
    }
    if (type === 'click') {
      const act = { type, locator }
      if (frame) act.frame = frame
      return act
    }
    if (type === 'wait') {
      return {
        type,
        sec: valStr === '' ? '' : num
      }
    }
    return { type, locator }
  })

  const aggregateValue = document.getElementById('block-aggregate')?.value || 'sum'
  const rowPos = posValueOf('row-pos')
  const colPos = posValueOf('col-pos')
  const fieldRows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  let fields = undefined
  if (fieldRows.length > 0) {
    fields = fieldRows.map((row, index) => {
      const key = row.dataset.fieldKey || ''
      const rawName = row.querySelector('input[data-field-name]')?.value?.trim()
      const name = rawName || `值 ${index + 1}`
      const spec = row._spec || fieldSpecs.get(key) || {}
      const item = { key, name }
      if (spec.cell) item.cell = applyPosToCell(spec.cell, rowPos, colPos)
      // 整欄／整列的值要聚合，聚合方式來自表單（全任務一份）；
      // 少了這一行，抓取端會拿不到設定而預設成加總，下拉等於裝飾品
      if (spec.block) {
        const block = { ...spec.block, aggregate: aggregateValue }
        delete block.skip
        putSkip(block, skipFromForm())
        item.block = applyPosToBlock(block, rowPos, colPos)
      }
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
    if (currentBlock && currentBlock.cell) {
      data.block = { cell: applyPosToCell(currentBlock.cell, rowPos, colPos) }
    } else {
      const agg = document.getElementById('block-aggregate')?.value || 'sum'
      const block = {
        axis: currentBlock?.axis,
        index: currentBlock?.index,
        headerText: currentBlock?.headerText,
        aggregate: agg
      }
      // 單值整欄只挑這幾個欄位重組，格內子路徑要另外帶上（多值走展開，本來就留得住）
      putInner(block, currentBlock?.inner)
      putSkip(block, skipFromForm())
      putExclude(block, currentBlock?.exclude)
      data.block = applyPosToBlock(block, rowPos, colPos)
    }
  }

  return data
}

// ---- 位置定位（第一筆／最後一筆／倒數第二筆）----
// 表格每天在最前或最後新增一筆時，「第幾筆」比會變動的標題可靠。
// 位置是任務層級的設定，寫進規格時每個值的同一軸各帶一份。
const POS_VALUES = ['first', 'last', 'last-1']
const POS_LABELS = { first: '第一', last: '最後一', 'last-1': '倒數第二' }

function posValueOf(id) {
  const v = document.getElementById(id)?.value || ''
  return POS_VALUES.includes(v) ? v : ''
}

// 有位置就不看索引與標題；沒有就把 pos 拿掉（改回依標題定位）
function withPos(axisSpec, pos) {
  const next = { ...(axisSpec || {}) }
  if (pos) next.pos = pos
  else delete next.pos
  return next
}

function applyPosToCell(cell, rowPos, colPos) {
  const next = {
    row: withPos(cell?.row, rowPos),
    col: withPos(cell?.col, colPos)
  }
  // 重組物件時要把格內子路徑帶著走：少了這一行，存下的規格會默默改回抓整格串接（AF-15 實測）
  putInner(next, cell?.inner)
  return next
}

// 整欄／整列加上「另一軸的位置」＝只取那一格：整欄配列的位置、整列配欄的位置
function applyPosToBlock(block, rowPos, colPos) {
  const cross = block?.axis === 'row' ? colPos : rowPos
  const next = { ...(block || {}) }
  if (cross) next.pos = cross
  else delete next.pos
  return next
}

// 從既有規格把位置帶回下拉（多值任務取第一個值，位置本來就是全任務一份）
function posFromSpec(spec) {
  if (!spec) return { rowPos: '', colPos: '' }
  const first = Array.isArray(spec.fields) && spec.fields.length > 0 ? spec.fields[0] : spec.block
  if (!first) return { rowPos: '', colPos: '' }
  if (first.cell) {
    return { rowPos: first.cell.row?.pos || '', colPos: first.cell.col?.pos || '' }
  }
  if (first.block || first.axis) {
    const b = first.block || first
    if (!b.pos) return { rowPos: '', colPos: '' }
    return b.axis === 'row' ? { rowPos: '', colPos: b.pos } : { rowPos: b.pos, colPos: '' }
  }
  return { rowPos: '', colPos: '' }
}

// 驗證排程設定欄位是否合法
export function validateSchedule(values) {
  const errors = {}

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

export function validateForm(values) {
  const errors = {}

  if (!values.name || typeof values.name !== 'string' || values.name.trim() === '') {
    errors.name = '名稱不可空白'
  }

  const schedRes = validateSchedule(values)
  if (!schedRes.ok) {
    Object.assign(errors, schedRes.errors)
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
  } else if (values.block && values.block.cell) {
    spec.mode = 'block'
    spec.block = { cell: values.block.cell }
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
    const winCb = document.getElementById('window-enabled')
    if (winCb && String(target.windowFrom).trim() !== '') winCb.checked = true
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

// 前置動作的 frame 只在合法時保留（要抓的按鈕可能在另一個 iframe 裡）
function withFrame(action, frame) {
  if (frame && typeof frame === 'object' && typeof frame.url === 'string' && frame.url !== '') {
    action.frame = { url: frame.url }
  }
  return action
}

/**
 * 表單值 → task.schedule。**唯一一份**：存檔與觸發預覽都走這裡，
 * 各組一份會讓畫面預告的時刻與實際排的 alarm 不一樣。
 * @param {Object} values getFormData() 的結果
 * @returns {Object} schedule
 */
export function buildSchedule(values) {
  if (values.scheduleType === 'daily') {
    return { type: 'daily', times: values.times || [], weekdays: values.weekdays || [] }
  }
  const schedule = {
    type: 'interval',
    everyMinutes: values.everyMinutes,
    weekdays: values.weekdays || []
  }
  const hasFrom = typeof values.windowFrom === 'string' && values.windowFrom.trim() !== ''
  const hasTo = typeof values.windowTo === 'string' && values.windowTo.trim() !== ''
  if (hasFrom && hasTo) {
    schedule.window = { from: values.windowFrom.trim(), to: values.windowTo.trim() }
  }
  return schedule
}

// 表單管不到、但任務執行時要用的欄位：編輯既有任務時原樣帶過去。
// 少了這一份清單，停用中的任務一改就復活、按過「改用前景抓取」的設定也會默默消失。
// 與 tasks.js 的 duplicateTask（複製時要丟掉哪些）是同一份口徑的兩面。
const RUNTIME_FIELDS = ['enabled', 'foreground', 'suggestForeground', 'notFoundStreak', 'precheckLeadMinutes']

export function buildTask(values, locator, existing, frame) {
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

  const schedule = buildSchedule(values)

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
  const resolvedFrame = frame || existing?.frame
  if (resolvedFrame) {
    task.frame = resolvedFrame
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
          return withFrame({ type: 'click', locator: a.locator }, a.frame)
        }
        if (a.type === 'hover') {
          const hasLoc = a.locator && typeof a.locator === 'object' && (a.locator.css || a.locator.path || a.locator.xpath || a.locator.anchor)
          if (!hasLoc) return null
          const act = { type: 'hover', locator: a.locator }
          const hold = Number(a.holdMs)
          if (Number.isFinite(hold) && hold >= 0) act.holdMs = hold
          return withFrame(act, a.frame)
        }
        if (a.type === 'waitFor') {
          const hasLoc = a.locator && typeof a.locator === 'object' && (a.locator.css || a.locator.path || a.locator.xpath || a.locator.anchor)
          if (!hasLoc) return null
          const timeoutMs = Number.isFinite(Number(a.timeoutMs)) ? Number(a.timeoutMs) : DEFAULT_WAIT_TIMEOUT_MS
          const act = { type: 'waitFor', locator: a.locator, timeoutMs }
          if (a.visible === false) act.visible = false
          return withFrame(act, a.frame)
        }
        if (a.type === 'wait') {
          // 空字串經 Number() 會變成 0，看起來合法但其實是使用者沒填
          const raw = a.sec !== undefined ? a.sec : a.ms
          if (raw === '' || raw === null || raw === undefined) return null
          const n = Number(raw)
          if (!Number.isFinite(n)) return null
          // 舊任務存的是 ms，重存一律寫 sec（讀取端仍相容 ms）
          return a.sec !== undefined ? { type: 'wait', sec: n } : { type: 'wait', sec: n / 1000 }
        }
        return null
      })
      .filter(Boolean)
    if (validPreActions.length > 0) {
      task.preActions = validPreActions
    }
  }
  if (existing?.order !== undefined) task.order = existing.order
  // 既有任務有哪個鍵才帶哪個：沒有的不得憑空長出來（`enabled` 缺省照舊視為啟用）
  if (existing) {
    for (const k of RUNTIME_FIELDS) {
      if (existing[k] !== undefined) task[k] = existing[k]
    }
  }
  return task
}

// 標題列：編輯既有任務時顯示它的名稱，新增時顯示通用標題；
// 副標是目標主機（網址整串太長，只有主機名認得出是哪一站）
function renderHeader(ctx) {
  const titleEl = document.getElementById('picker-title')
  if (titleEl) {
    const name = ctx?.task?.name
    titleEl.textContent = (typeof name === 'string' && name.trim()) ? name.trim() : '設定抓取任務'
  }
  const hostEl = document.getElementById('target-host')
  if (hostEl) {
    let host = ''
    const url = ctx?.url ?? ctx?.task?.url
    if (typeof url === 'string' && url.trim()) {
      try {
        host = new URL(url).hostname
      } catch {
        host = ''
      }
    }
    hostEl.textContent = host
    hostEl.title = host
  }
  // 停用中的任務改完存檔仍然不會抓：以前存檔會把它意外復活，所以看起來「會跑」；
  // 修掉復活之後就得說出來，不然使用者以為改完就生效了
  const statusEl = document.getElementById('task-status-note')
  if (statusEl) {
    const paused = Boolean(ctx?.task) && ctx.task.enabled === false
    statusEl.hidden = !paused
    statusEl.textContent = paused ? '此任務目前停用，不會排程；到任務頁啟用後才會抓。' : ''
  }
}

// 預覽的狀態色：只有測過才有狀態（成功綠、失敗紅），還沒測過不上色
function setPreviewState(state) {
  const el = document.getElementById('preview')
  if (!el) return
  if (state) {
    el.dataset.state = state
  } else {
    delete el.dataset.state
  }
}

// 將排程物件的值填入排程相關表單欄位
function fillSchedule(schedule) {
  if (!schedule) return
  if (schedule.type) document.getElementById('schedule-type').value = schedule.type
  if (schedule.times) document.getElementById('times').value = schedule.times.join(', ')
  if (schedule.everyMinutes !== undefined) document.getElementById('every-minutes').value = schedule.everyMinutes
  if (schedule.weekdays) {
    const wds = new Set(schedule.weekdays)
    document.querySelectorAll('#weekdays input[type="checkbox"]').forEach(cb => {
      cb.checked = wds.has(Number(cb.value))
    })
  }
  if (schedule.window) {
    if (schedule.window.from) document.getElementById('window-from').value = schedule.window.from
    if (schedule.window.to) document.getElementById('window-to').value = schedule.window.to
    // 既有任務有時段就要把開關勾起來，否則欄位藏著、使用者以為沒設定
    const winCb = document.getElementById('window-enabled')
    if (winCb) winCb.checked = true
  }
}

export function render(ctx) {
  currentCtx = ctx || {}
  // 位置定位要最先決定：預設名稱會用到它，而且同一個視窗可能 render 第二次
  //（下鑽 iframe 回來、重選回填），殘留在下拉裡的舊值會算出錯的名稱
  applyPositionDefaults(currentCtx)
  renderHeader(currentCtx)
  setPreviewState(null)
  // 換了目標就不能留著上一個目標的診斷：按下去會匯出別一頁的網址與 HTML 片段
  // （與 AF-7 的 pickedTableEl、AF-9 的 undoSnapshot 同型的狀態殘留）
  setDiagAvailable(null)
  resetTestDetail()
  const previewEl = document.getElementById('preview')
  if (previewEl) {
    // 比較要正規化成字串：preview 是文字、previewValue 是數字，直接比永遠不相等，
    // 純數值的格子會顯示成「42 (42)」
    if (ctx?.preview !== undefined && ctx?.previewValue !== undefined &&
        String(ctx.preview).trim() !== String(ctx.previewValue)) {
      previewEl.textContent = `${ctx.preview} (${ctx.previewValue})`
    } else if (ctx?.preview !== undefined) {
      previewEl.textContent = String(ctx.preview)
    } else if (ctx?.previewValue !== undefined) {
      previewEl.textContent = String(ctx.previewValue)
    } else {
      previewEl.textContent = ''
    }
    // 整欄／整列的前幾格文字只接在畫面上，不進任務名稱（每天會變）
    if (typeof ctx?.previewSamples === 'string' && ctx.previewSamples) {
      previewEl.textContent += `：${ctx.previewSamples}`
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
    fillSchedule(t.schedule)
    if (t.spec?.block) {
      if (t.spec.block.cell) {
        currentBlock = { cell: t.spec.block.cell }
      } else {
        currentBlock = { ...t.spec.block }
      }
      const aggEl = document.getElementById('block-aggregate')
      if (aggEl && t.spec.block.aggregate) aggEl.value = t.spec.block.aggregate
    }
    const skipSource = t.spec?.block?.skip
      || t.spec?.fields?.find(f => f.block?.skip)?.block?.skip
    const { head, tail, blank } = skipOf(skipSource)
    const headEl = document.getElementById('skip-head')
    if (headEl) headEl.value = String(head)
    const tailEl = document.getElementById('skip-tail')
    if (tailEl) tailEl.value = String(tail)
    const blankEl = document.getElementById('skip-blank')
    if (blankEl) blankEl.checked = blank
  } else {
    const nameEl = document.getElementById('name')
    if (nameEl && !nameEl.value.trim()) {
      const defaultName = defaultTaskName(ctx)
      if (defaultName) {
        nameEl.value = defaultName
        // 記下自動填的值：使用者之後改了定位方式時，只重算他沒有手動改過的名稱
        nameEl._afAutoName = defaultName
      }
    }
  }

  const isMulti = Boolean((ctx?.picks && Array.isArray(ctx.picks) && ctx.picks.length >= 2) || (ctx?.task && Array.isArray(ctx.task.fields) && ctx.task.fields.length > 0))
  if (isMulti) {
    const modeEl = document.getElementById('mode')
    if (modeEl) modeEl.value = 'block'
  }

  if (ctx?.picks && Array.isArray(ctx.picks) && ctx.picks.length === 1 && ctx.picks[0].cell) {
    currentBlock = { cell: ctx.picks[0].cell }
    const modeEl = document.getElementById('mode')
    if (modeEl) modeEl.value = 'block'
  } else if (ctx?.picks && Array.isArray(ctx.picks) && ctx.picks.length === 1 && ctx.picks[0].block) {
    // 換目標時 render 會再跑一次：舊目標的排除清單、格內子路徑、略過與位置不得併進新 pick——
    // 新 pick 沒帶那個鍵就會殘留，排除列套到新表錯誤的列上（AF-16 終檢；inner 是 AF-15 起的同型缺陷）
    const prevBlock = { ...(currentBlock || {}) }
    for (const k of ['exclude', 'inner', 'skip', 'pos']) delete prevBlock[k]
    currentBlock = {
      ...prevBlock,
      ...ctx.picks[0].block
    }
    const modeEl = document.getElementById('mode')
    if (modeEl) modeEl.value = 'block'
  } else if (!ctx?.task?.spec?.block && ctx?.blockInfo && (ctx.blockInfo.kind === 'table' || ctx.blockInfo.kind === 'grid')) {
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

      // 名稱與定位方式綁在一起（用位置的軸不放會變的標題），只有這一份
      const rawName = defaultPickName(pick, index)

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
  bindPosEvents()
  updateFrameHint(currentCtx)
  updateBlockSection()
}

// 新任務的預設名稱（單任務表單與批次清單每一列共用這一份；位置定位下拉要先由 applyPositionDefaults 決定）
function defaultTaskName(ctx) {
  // 單值儲存格：使用者選的是「成交金額」那一格，名稱就用欄標題。
  // 用整張表的標題（nameHint）或左邊那格的文字（anchor.text）都不是他選的東西。
  const soleCell = (Array.isArray(ctx?.picks) && ctx.picks.length === 1 && ctx.picks[0].cell)
    ? ctx.picks[0].cell
    : null
  const cellName = soleCell ? singleCellName(soleCell) : ''
  if (cellName) return cellName
  if (ctx?.nameHint && String(ctx.nameHint).trim()) return String(ctx.nameHint).trim()
  if (ctx?.locator?.anchor?.text && String(ctx.locator.anchor.text).trim()) return String(ctx.locator.anchor.text).trim()
  if (ctx?.preview !== undefined && ctx?.preview !== null && String(ctx.preview).trim()) {
    return String(ctx.preview).trim().slice(0, 20)
  }
  return ''
}

// 目標在 iframe 裡時提醒使用者可能要先點個什麼：那個框架常常是點了頁籤或按鈕才出現，
// 而排程是開一個乾淨的新分頁，不會沿用現在畫面上的狀態。
let frameHintDismissedFor = null
function updateFrameHint(ctx) {
  const hint = document.getElementById('frame-hint')
  if (!hint) return
  const textEl = document.getElementById('frame-hint-text')
  const hasPreActions = Array.isArray(ctx?.task?.preActions) && ctx.task.preActions.length > 0
  // 編輯既有任務不提示：使用者已經決定過要不要加了
  // 使用者按過「不需要」之後，同一個框架的任何一次 re-render 都不該再跳出來
  const show = Boolean(ctx?.frameUrl) && !ctx?.task && !hasPreActions && frameHintDismissedFor !== ctx.frameUrl
  hint.hidden = !show
  if (!show) return

  let host = ctx.frameUrl
  try {
    host = new URL(ctx.frameUrl).hostname || ctx.frameUrl
  } catch {}
  if (textEl) {
    textEl.textContent = `目標在框架（${host}）內。若這個框架要先點頁籤或按鈕才會出現，`
      + '請加入「點元素」前置動作；排程抓取是開新分頁，不會沿用你現在看到的畫面。'
  }
  const advSection = document.getElementById('advanced-section')
  if (advSection) advSection.setAttribute('open', '')

  bindFrameHintEvents()
}

function bindFrameHintEvents() {
  const addBtn = document.getElementById('frame-hint-add')
  if (addBtn && !addBtn._frameHintBound) {
    addBtn.addEventListener('click', () => {
      const row = addPreActionRow({ type: 'click' })
      const hint = document.getElementById('frame-hint')
      if (hint) hint.hidden = true
      // 直接開始選：讓使用者自己再去找一次「在頁面上選取」是多餘的一步
      row?.querySelector('[data-action="preaction-pick"]')?.click()
    })
    addBtn._frameHintBound = true
  }
  const dismissBtn = document.getElementById('frame-hint-dismiss')
  if (dismissBtn && !dismissBtn._frameHintBound) {
    dismissBtn.addEventListener('click', () => {
      const hint = document.getElementById('frame-hint')
      if (hint) hint.hidden = true
      frameHintDismissedFor = currentCtx?.frameUrl || null
    })
    dismissBtn._frameHintBound = true
  }
}

// 使用者點的是第一列或最後一列時「建議」改用位置定位，但**不替他改設定**：
// 兩列的匯率表點第一列（美金）跟每日成交表點最後一列，在資料上長得一模一樣，
// 猜錯就是默默換掉定位方式。建議寫在摘要那一行，決定權留給使用者。
let posSuggestion = ''
function applyPositionDefaults(ctx) {
  posSuggestion = ''
  const rowEl = document.getElementById('row-pos')
  const colEl = document.getElementById('col-pos')
  if (!rowEl || !colEl) return

  // 編輯既有任務：一律從規格回填
  if (ctx?.task?.spec) {
    const { rowPos, colPos } = posFromSpec(ctx.task.spec)
    rowEl.value = rowPos
    colEl.value = colPos
    return
  }

  rowEl.value = ''
  colEl.value = ''

  const rows = Number(ctx?.blockInfo?.rows)
  const picks = Array.isArray(ctx?.picks) ? ctx.picks : []
  const cellPicks = picks.filter(p => p?.cell)
  if (!Number.isFinite(rows) || rows <= 1 || cellPicks.length === 0) return
  const indices = new Set(cellPicks.map(p => Number(p.cell.row?.index)))
  if (indices.size !== 1) return
  const idx = [...indices][0]
  if (idx === rows - 1) {
    posSuggestion = '你選的是最後一列。若這張表每天在最後新增一列，把「列定位」改成「最後一筆」'
      + '就會每次都抓新的那筆；最後一列若是合計，選「倒數第二筆」。'
  } else if (idx === 0) {
    posSuggestion = '你選的是第一列。若這張表每天在最前面新增一列，把「列定位」改成「第一筆」'
      + '就會每次都抓新的那筆。'
  }
}

// 整欄的「欄」是使用者自己點的、整列的「列」也是，那一軸的位置定位對它沒有意義。
// 留著能選但選了不生效，就是一個靜默無效的設定；直接停用並說明。
function syncPosControls() {
  const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  const specs = rows.length > 0
    ? rows.map(r => (r._spec || fieldSpecs.get(r.dataset.fieldKey || ''))).filter(Boolean)
    : (currentBlock ? [currentBlock.cell ? { cell: currentBlock.cell } : { block: currentBlock }] : [])
  const hasCell = specs.some(s => s.cell)
  const axes = new Set(specs.map(s => s.block?.axis || (s.axis && !s.cell ? s.axis : null)).filter(Boolean))
  // 有任何一個儲存格型的值，兩軸的定位就都有意義（儲存格的欄不是使用者「點欄」得來的）
  const onlyCol = !hasCell && axes.size === 1 && axes.has('col')
  const onlyRow = !hasCell && axes.size === 1 && axes.has('row')

  setPosDisabled('col-pos', onlyCol, '整欄的欄是你自己點的，不用位置定位')
  setPosDisabled('row-pos', onlyRow, '整列的列是你自己點的，不用位置定位')
}

function setPosDisabled(id, disabled, reason) {
  const el = document.getElementById(id)
  if (!el) return
  if (disabled && el.value !== '') el.value = ''
  el.disabled = disabled
  if (disabled) el.setAttribute('title', reason)
  else el.removeAttribute('title')
}

function bindPosEvents() {
  for (const id of ['row-pos', 'col-pos']) {
    const el = document.getElementById(id)
    if (!el || el._posEventsBound) continue
    el.addEventListener('change', () => {
      // 改了定位方式就不再顯示建議，並把還沒被手動改過的名稱重算
      posSuggestion = ''
      refreshDefaultNames()
      updateBlockSection()
      updateFieldListState()
    })
    el._posEventsBound = true
  }
}

// 定位方式一改，預設名稱的意義就變了（「115/09/07 · 成交金額」→「成交金額（最後一列）」）。
// 只重算使用者沒有手動改過的那些，手改過的一律尊重。
function refreshDefaultNames() {
  const picks = Array.isArray(currentCtx?.picks) ? currentCtx.picks : []
  const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  rows.forEach((row, index) => {
    const input = row.querySelector('input[data-field-name]')
    if (!input) return
    if (input._afAutoName !== undefined && input.value !== input._afAutoName) return
    // 列會被上下移／移除，picks[index] 對不上；列自己帶的 spec 才跟著列走
    const pick = row._spec ? { ...row._spec } : (picks[index] || null)
    if (!pick) return
    const next = defaultPickName(pick, index)
    input.value = next
    input._afAutoName = next
  })

  if (rows.length === 0 && picks.length === 1 && picks[0].cell) {
    const nameEl = document.getElementById('name')
    if (nameEl && (nameEl._afAutoName === undefined || nameEl.value === nameEl._afAutoName)) {
      // 位置定位把唯一的標題吃掉時（那個標題正是會過期的那個），退回表格名稱，
      // 與第一次 render 的順序一致；不能留著舊名字，它就是那個明天會過期的日期
      const next = singleCellName(picks[0].cell) ||
        String(currentCtx?.nameHint || '').trim() || nameEl.value
      nameEl.value = next
      nameEl._afAutoName = next
    }
  }
}

// 單值儲存格的預設任務名稱：使用者選的是那一欄，名稱就用欄標題。
// 後綴（最後一列…）與多值那份共用，否則同一張表的單值與多值在 Report 上分不出定位方式。
function singleCellName(cell) {
  const rowPos = posValueOf('row-pos')
  const colPos = posValueOf('col-pos')
  // 純數值的標題不當名稱：那個數字明天就變了（判準與定位同一份）
  const colH = colPos ? '' : anchorOnly(cell?.col?.header)
  const rowH = rowPos ? '' : anchorOnly(cell?.row?.header)
  const base = withInnerLabel(colH || rowH, cell?.inner)
  if (!base) return ''
  const suffix = [
    rowPos ? `${POS_LABELS[rowPos]}列` : '',
    colPos ? `${POS_LABELS[colPos]}欄` : ''
  ].filter(Boolean).join('、')
  return suffix ? `${base}（${suffix}）` : base
}

// 多值任務裡每個值的預設名稱；用位置定位的那一軸不放會變動的標題
// 能當定位錨點的標題才能拿來命名；純數值退回下一層
function anchorOnly(header) {
  const text = typeof header === 'string' ? header.trim() : ''
  return isAnchorText(text) ? text : ''
}

function defaultPickName(pick, index) {
  if (pick?.cell) {
    const rowPos = posValueOf('row-pos')
    const colPos = posValueOf('col-pos')
    // 純數值的標題不進名稱（判準與定位同一份）——這是命名鏈的第四個消費端
    const rowH = rowPos ? '' : anchorOnly(pick.cell.row?.header)
    const colH = colPos ? '' : anchorOnly(pick.cell.col?.header)
    const suffix = [
      rowPos ? `${POS_LABELS[rowPos]}列` : '',
      colPos ? `${POS_LABELS[colPos]}欄` : ''
    ].filter(Boolean).join('、')
    let base = withInnerLabel([rowH, colH].filter(Boolean).join(' · '), pick.cell.inner)
    if (!base) base = suffix ? '值' : `值 ${index + 1}`
    return suffix ? `${base}（${suffix}）` : base
  }
  if (pick?.block) return withInnerLabel(anchorOnly(pick.block.headerText), pick.block.inner) || `值 ${index + 1}`
  return `值 ${index + 1}`
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
  // 使用者自己動過卡片型別之後就不要再覆蓋：移除一個值、上下移、改定位都會
  // 走到這裡，無聲把他的選擇改回預設是最難察覺的一種「東西自己變了」
  if (cardTypes._afTouched) return
  // 多個值用一張樞紐表加一張折線就看得完；一個值長兩張卡會被當成重複
  const multi = document.querySelectorAll('#field-list [data-field-row]').length >= 2
  const checkboxes = cardTypes.querySelectorAll('input[type="checkbox"]')
  for (const cb of checkboxes) {
    if (multi) {
      cb.checked = (cb.value === 'table' || cb.value === 'line')
    } else if (modeVal === 'text') {
      cb.checked = (cb.value === 'table')
    } else {
      // 數字卡看「現在多少」，折線看「趨勢」——只給數字卡的話，
      // 使用者存完會看到一張沒有脈絡的數字，不知道要自己去加折線（AF-9 定案）
      cb.checked = (cb.value === 'number' || cb.value === 'line')
    }
  }
}

// 位置定位的白話說明：講使用者的情境，不是講欄位名稱
function updatePosHint() {
  const hintEl = document.getElementById('pos-hint')
  if (!hintEl) return
  const rowPos = posValueOf('row-pos')
  const colPos = posValueOf('col-pos')
  let text = (rowPos || colPos)
    ? '每次抓取都重算位置，表格新增資料時會自動跟著走。最後一列若是合計，改選「倒數第二筆」。'
    : '表格每天在最後加一列（例如每日成交資訊）→ 列定位改選「最後一筆」；'
      + '最後一列是合計 → 選「倒數第二筆」。標題不會變的表格維持「依標題」即可。'
  // 停用的下拉在多數瀏覽器不會顯示 title，理由要寫在看得到的地方
  for (const id of ['row-pos', 'col-pos']) {
    const el = document.getElementById(id)
    if (el?.disabled && el.getAttribute('title')) text += `（${el.getAttribute('title')}）`
  }
  const blockSpecs = currentBlockSpecs()
  const hasExcludeWithPos = blockSpecs.some(b => {
    if (excludeOf(b).length === 0) return false
    const pos = b.axis === 'row' ? colPos : rowPos
    return Boolean(pos)
  })
  if (hasExcludeWithPos) {
    text += '位置定位下排除不生效（取的是那一格）。'
  }
  hintEl.textContent = text
}

// 摘要那一行：說出這次會抓哪一格；還沒設定位置但看起來用得上時給建議
function positionSummaryText() {
  const rowPos = posValueOf('row-pos')
  const colPos = posValueOf('col-pos')
  if (!rowPos && !colPos) return posSuggestion
  const parts = []
  if (rowPos) parts.push(`${POS_LABELS[rowPos]}列`)
  if (colPos) parts.push(`${POS_LABELS[colPos]}欄`)
  return `每次抓取取${parts.join('的')}，不看標題`
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
  syncPosControls()
  updatePosHint()
  const summaryEl = document.getElementById('block-summary')
  if (!summaryEl) return

  const posNote = positionSummaryText()
  const hasFields = document.querySelectorAll('#field-list [data-field-row]').length > 0
  if (hasFields) {
    const base = (currentBlock && currentBlock.rows !== undefined && currentBlock.cols !== undefined)
      ? `表格 ${currentBlock.rows} 列 × ${currentBlock.cols} 欄`
      : ''
    summaryEl.textContent = [base, posNote].filter(Boolean).join('\n')
    return
  }
  if (posNote) {
    summaryEl.textContent = posNote
    return
  }

  if (currentBlock && currentBlock.cell) {
    const row = currentBlock.cell.row
    const col = currentBlock.cell.col
    const rowH = (row && typeof row.header === 'string') ? row.header.trim() : ''
    const colH = (col && typeof col.header === 'string') ? col.header.trim() : ''
    if (rowH && colH) {
      summaryEl.textContent = `表格，取「${rowH} · ${colH}」這一格`
    } else if (rowH || colH) {
      summaryEl.textContent = `表格，取「${rowH || colH}」這一格`
    } else {
      const rIdx = Number(row ? row.index : 0) + 1
      const cIdx = Number(col ? col.index : 0) + 1
      summaryEl.textContent = `表格，取第 ${rIdx} 列第 ${cIdx} 欄這一格`
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
 * 頂部摘要卡：把「抓什麼／多久抓一次／抓完放哪裡」三個問題各用一句白話回答。
 * 使用者不必把散在各區的欄位在腦中組起來，久沒用回來也一眼看得出這個任務在做什麼。
 * 文字一律走 shared/describe.js，與任務頁、popup 同一份。
 */
export function updateSetupSummary() {
  const box = document.getElementById('setup-summary')
  if (!box) return
  const values = getFormData()
  const fieldRows = document.querySelectorAll('#field-list [data-field-row]')

  const targetEl = document.getElementById('summary-target')
  if (targetEl) {
    const first = values.fields?.[0]
    const cellArg = values.block?.cell || first?.cell
    const blockArg = values.block?.axis ? values.block : first?.block
    // 摘要卡說了「請改用列定位」就要讓使用者到得了那個下拉（它在「抓什麼」區，不是進階區）。
    // 哪一軸要提示，只由 describe.js 的 numericHeaderAxis 決定（整欄／整列沒有可換的下拉，不出鈕）
    const rowPosNow = document.getElementById('row-pos')?.value || ''
    const colPosNow = document.getElementById('col-pos')?.value || ''
    const numericAxis = numericHeaderAxis(cellArg, rowPosNow, colPosNow)
    const gotoBtn = document.getElementById('goto-rowpos')
    if (gotoBtn) {
      gotoBtn.hidden = !numericAxis
      gotoBtn.textContent = `去設定「${numericAxis === 'col' ? '欄' : '列'}定位」`
      gotoBtn.dataset.target = numericAxis === 'col' ? 'col-pos' : 'row-pos'
    }
    targetEl.textContent = describeTarget({
      url: values.url || currentCtx?.url || '',
      mode: values.fields ? 'block' : values.mode,
      fieldCount: fieldRows.length,
      cell: values.block?.cell || first?.cell,
      block: values.block?.axis ? values.block : first?.block,
      rowPos: rowPosNow,
      colPos: colPosNow
    })
  }

  const schedEl = document.getElementById('summary-schedule')
  if (schedEl) schedEl.textContent = describeSchedule(buildSchedule(values))

  const dashEl = document.getElementById('summary-dashboard')
  if (dashEl) {
    const sel = document.getElementById('dashboard-select')
    const name = (sel && sel.value !== 'none') ? (sel.selectedOptions?.[0]?.textContent || '') : ''
    const types = Array.from(document.querySelectorAll('#card-types input[type="checkbox"]:checked')).map(cb => cb.value)
    dashEl.textContent = describeDashboard(name, types)
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
  syncWindowFields()
  renderTimeChips()
  updateSchedulePreview()
}

/**
 * 時段欄位只在勾了「只在某個時段內執行」時出現；
 * 取消勾選要把兩個欄位清空，否則殘值會被 buildTask 寫成 schedule.window
 */
function syncWindowFields() {
  const cb = document.getElementById('window-enabled')
  const fields = document.getElementById('window-fields')
  if (!cb || !fields) return
  fields.hidden = !cb.checked
}

/**
 * 取消勾選「只在某個時段內執行」時才清空欄位——殘值留著會被 buildSchedule
 * 寫成 schedule.window，變成使用者沒要求的時段限制。
 * 只在 change 事件呼叫，不在每次 sync 呼叫（切換排程型別不得清掉已填的值）
 */
function clearWindowIfDisabled() {
  const cb = document.getElementById('window-enabled')
  if (!cb || cb.checked) return
  const from = document.getElementById('window-from')
  const to = document.getElementById('window-to')
  if (from) from.value = ''
  if (to) to.value = ''
}

// #times 是事實來源；chip 只是它的介面
function readTimes() {
  const raw = document.getElementById('times')?.value ?? ''
  return raw.split(',').map(t => t.trim()).filter(t => t !== '')
}

function writeTimes(list) {
  const el = document.getElementById('times')
  if (el) el.value = list.join(', ')
  renderTimeChips()
  updateSchedulePreview()
}

/**
 * 把 #times 畫成可移除的 chip
 */
export function renderTimeChips() {
  const box = document.getElementById('time-chips')
  if (!box) return
  const times = readTimes()
  box.replaceChildren()
  for (const t of times) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.setAttribute('data-time-chip', t)
    chip.setAttribute('role', 'listitem')
    const label = document.createElement('span')
    label.textContent = t
    const rm = document.createElement('button')
    rm.type = 'button'
    rm.setAttribute('data-time-remove', t)
    rm.setAttribute('aria-label', `移除 ${t}`)
    rm.textContent = '×'
    rm.onclick = () => {
      writeTimes(readTimes().filter(x => x !== t))
    }
    chip.appendChild(label)
    chip.appendChild(rm)
    box.appendChild(chip)
  }
}

/**
 * 加入一個執行時刻：去重並排序
 */
export function addTime(value) {
  if (!TIME_RE.test(value)) return false
  const list = readTimes()
  if (!list.includes(value)) {
    list.push(value)
    list.sort()
  }
  writeTimes(list)
  return true
}

/**
 * 觸發預覽：第一行是白話句，interval 另外把今天實際會跑的時刻列出來，
 * 讓使用者當場確認「08:30、08:40 … 09:20，共 6 次」而不是自己心算
 */
export function updateSchedulePreview(nowMs = Date.now()) {
  const el = document.getElementById('schedule-preview')
  if (!el) return
  const values = getFormData()
  // validateForm 回的是 { ok, errors }；直接讀 errs.times 會永遠是 undefined，
  // 整個錯誤分支就成了死碼，畫面會對著一個永遠不會執行的排程說「每天」
  const errs = validateForm(values).errors || {}
  const schedule = buildSchedule(values)
  const lines = [describeSchedule(schedule)]

  const firstError = errs.times || errs.everyMinutes || errs.window || errs.weekdays
  if (firstError) {
    lines.push(firstError)
  } else if (values.scheduleType === 'interval') {
    const dayStart = new Date(nowMs)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000
    const hits = []
    let cursor = dayStart.getTime() - 1
    // 迭代同一份 nextIntervalRun，不另算一套（算法漂移就會與實際觸發不一致）
    for (let i = 0; i < 200; i++) {
      const next = nextIntervalRun({ schedule }, cursor)
      if (next === null || next >= dayEnd) break
      hits.push(next)
      cursor = next
    }
    if (hits.length > 0) {
      const fmt = (ms) => {
        const d = new Date(ms)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }
      const head = hits.slice(0, 6).map(fmt).join('、')
      const tail = hits.length > 6 ? ' …' : ''
      lines.push(`今天會跑：${head}${tail}（共 ${hits.length} 次）`)
    } else {
      lines.push('今天不會執行（星期或時段不符）')
    }
  }
  el.textContent = lines.join('\n')
  // 排程一動，頂部摘要卡的第二行也要跟著變（畫面上只有一個事實來源）
  updateSetupSummary()
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

  for (const [id, style] of [['rename-col', 'col'], ['rename-cell', 'cell']]) {
    const btn = document.getElementById(id)
    if (btn && !btn._renameBound) {
      btn.addEventListener('click', () => renameFields(style))
      btn._renameBound = true
    }
  }
  const splitBtn = document.getElementById('split-tasks')
  if (splitBtn && !splitBtn._splitBound) {
    splitBtn.addEventListener('click', () => splitIntoTasks())
    splitBtn._splitBound = true
  }

  const dashSel = document.getElementById('dashboard-select')
  if (dashSel && !dashSel._summaryBound) {
    dashSel.addEventListener('change', () => updateSetupSummary())
    dashSel._summaryBound = true
  }
  document.querySelectorAll('#card-types input[type="checkbox"]').forEach(cb => {
    if (cb._summaryBound) return
    cb.addEventListener('change', () => {
      const box = document.getElementById('card-types')
      if (box) box._afTouched = true
      updateSetupSummary()
    })
    cb._summaryBound = true
  })
  // 摘要卡的第一行吃的是定位、模式與聚合方式，這些欄位一動就要重算，
  // 否則畫面會拿舊事實回答「抓什麼」——比不寫還糟
  for (const id of ['row-pos', 'col-pos', 'mode', 'block-aggregate', 'skip-head', 'skip-tail']) {
    const el = document.getElementById(id)
    if (el && !el._summaryBound) {
      el.addEventListener('change', () => updateSetupSummary())
      el._summaryBound = true
    }
  }
  // 略過一改，儲存摘要要跟著說（定位下拉改了會經 updateFieldListState 重算，不另綁）
  for (const id of ['skip-head', 'skip-tail']) {
    const el = document.getElementById(id)
    if (el && !el._saveSummaryBound) {
      el.addEventListener('change', () => updateSaveSummary())
      el._saveSummaryBound = true
    }
  }

  const addBtn = document.getElementById('time-add')
  if (addBtn && !addBtn._timeEventsBound) {
    addBtn.addEventListener('click', () => {
      const input = document.getElementById('time-input')
      if (input && addTime(input.value)) input.value = ''
    })
    addBtn._timeEventsBound = true
  }

  const winCb = document.getElementById('window-enabled')
  if (winCb && !winCb._windowEventsBound) {
    winCb.addEventListener('change', () => {
      clearWindowIfDisabled()
      syncWindowFields()
      updateSchedulePreview()
    })
    winCb._windowEventsBound = true
  }

  // 任何排程欄位變動都要重算預覽，否則畫面說的與實際排的會不一樣
  for (const id of ['every-minutes', 'window-from', 'window-to']) {
    const el = document.getElementById(id)
    if (el && !el._previewBound) {
      el.addEventListener('input', () => updateSchedulePreview())
      el._previewBound = true
    }
  }
  document.querySelectorAll('#weekdays input[type="checkbox"]').forEach(cb => {
    if (cb._previewBound) return
    cb.addEventListener('change', () => updateSchedulePreview())
    cb._previewBound = true
  })
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
  // 只有一個值時「一鍵命名」沒有東西可批次改，露出來只是多兩顆按鈕
  const renameRow = document.getElementById('field-rename')
  if (renameRow) renameRow.hidden = n < 2
  updateSplitButton(n)
  rows.forEach((r, i) => {
    const upBtn = r.querySelector('[data-field-up]')
    const downBtn = r.querySelector('[data-field-down]')
    if (upBtn) upBtn.setAttribute('aria-disabled', String(i === 0))
    if (downBtn) downBtn.setAttribute('aria-disabled', String(i === n - 1))
    // 順序變了，上一次的停用理由就不再適用
    setFieldRowHint(r, '')
  })

  // 一格就是一個值，沒有東西要聚合；有整欄／整列的值時才需要選聚合方式。
  // 值的數量也決定預設建哪幾張卡，移除／上下移之後都要重算
  const aggLabel = document.getElementById('block-aggregate')?.closest('label')
  const skipRow = document.querySelector('[data-skip-row]')
  if (aggLabel) {
    const blockSpecs = currentBlockSpecs()
    const hasBlockField = n > 0
      ? blockSpecs.length > 0
      : !(currentBlock && currentBlock.cell)
    // 只有「這些聚合真的都被位置取代掉」時才藏聚合下拉。
    // 整欄的位置來自列定位、整列的來自欄定位——看錯一邊就會藏掉還在生效的設定
    const allReplaced = blockSpecs.length > 0 && blockSpecs.every(b =>
      Boolean(b.axis === 'row' ? posValueOf('col-pos') : posValueOf('row-pos')))
    aggLabel.hidden = !hasBlockField || allReplaced
    if (skipRow) skipRow.hidden = aggLabel.hidden

    const unit = skipUnitOf(blockSpecs)
    const headSpan = document.querySelector('[data-skip-head-label]')
    if (headSpan) headSpan.textContent = `略過開頭（${unit}）`
    const tailSpan = document.querySelector('[data-skip-tail-label]')
    if (tailSpan) tailSpan.textContent = `略過結尾（${unit}）`
  }
  applyDefaultCardTypes()

  updateSaveSummary()

  updateAlertRowsFields()
  updateBlockSection()
}

// 「用「列 · 欄」命名」用的文字：與 fieldWhereText 同形，但純數值標題不進名稱
function fieldNameText(spec) {
  if (!spec) return ''
  if (spec.cell) {
    const r = anchorOnly(spec.cell.row?.header) || (spec.cell.row?.pos ? POS_TEXT[spec.cell.row.pos] : '')
    const c = anchorOnly(spec.cell.col?.header) || (spec.cell.col?.pos ? POS_TEXT[spec.cell.col.pos] : '')
    return withInnerLabel([r, c].filter(Boolean).join(' · '), spec.cell.inner)
  }
  if (spec.block) {
    const axis = spec.block.axis === 'row' ? '整列' : '整欄'
    const h = withInnerLabel(anchorOnly(spec.block.headerText), spec.block.inner)
    return h ? `${h} ${axis}` : axis
  }
  return ''
}

// 一個值在表格裡的位置說明（「美金 · 買入」／「買入 整欄」），純顯示，原文照給
function fieldWhereText(spec) {
  if (!spec) return ''
  if (spec.cell) {
    const r = spec.cell.row?.header || (spec.cell.row?.pos ? POS_TEXT[spec.cell.row.pos] : '')
    const c = spec.cell.col?.header || (spec.cell.col?.pos ? POS_TEXT[spec.cell.col.pos] : '')
    return withInnerLabel([r, c].filter(Boolean).join(' · '), spec.cell.inner)
  }
  if (spec.block) {
    const axis = spec.block.axis === 'row' ? '整列' : '整欄'
    const h = withInnerLabel(spec.block.headerText || '', spec.block.inner)
    let text = h ? `${h} ${axis}` : axis
    const k = excludeOf(spec.block).length
    if (k > 0) {
      const unit = spec.block.axis === 'row' ? '格' : '列'
      text += `（排除 ${k} ${unit}）`
    }
    return text
  }
  return ''
}

/**
 * 立即測試的逐值結果就地顯示在該列。
 * 名稱重複時依序對應（fields 的順序就是列的順序）。
 */
export function applyFieldResults(fields, res) {
  const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  rows.forEach((row, i) => {
    const cell = row.querySelector('[data-field-result]')
    if (!cell) return
    const f = fields?.[i]
    const r = f ? res?.fields?.[f.key] : null
    if (r && r.ok && (r.value !== undefined && r.value !== null || r.raw)) {
      cell.textContent = (r.value !== undefined && r.value !== null) ? String(r.value) : String(r.raw)
      cell.setAttribute('data-state', 'ok')
      cell.removeAttribute('title')
    } else if (r) {
      // 缺值一律 —，原因放 title（SPEC §8.6）
      cell.textContent = '—'
      cell.setAttribute('data-state', 'error')
      cell.title = r.message || r.error || '抓取失敗'
    } else {
      cell.textContent = '—'
      cell.removeAttribute('data-state')
      cell.removeAttribute('title')
    }
  })
}

/**
 * 一鍵重新命名：只動「沒有被使用者手改過」的列（_afAutoName 就是自動填的基準值）。
 * @param {'col'|'cell'} style 用欄標題，或用「列 · 欄」
 */
export function renameFields(style) {
  const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  for (const row of rows) {
    const input = row.querySelector('input[data-field-name]')
    if (!input) continue
    if (input.value !== input._afAutoName) continue
    const spec = row._spec || fieldSpecs.get(row.dataset.fieldKey || '')
    // 純數值標題不進名稱（命名鏈的第四個入口，判準與其他三處同一份）
    let next = ''
    if (style === 'col') {
      next = withInnerLabel(anchorOnly(spec?.cell?.col?.header), spec?.cell?.inner) ||
        withInnerLabel(anchorOnly(spec?.block?.headerText), spec?.block?.inner)
    } else {
      next = fieldNameText(spec)
    }
    if (!next) continue
    input.value = next
    input._afAutoName = next
  }
  updateAlertRowsFields()
  updateSetupSummary()
}

// 某一列的就地提示（上／下移停用時說原因）；空字串＝收起來
function setFieldRowHint(row, text) {
  if (!row) return
  let el = row.querySelector('[data-field-hint]')
  if (!text) {
    if (el) el.remove()
    return
  }
  if (!el) {
    el = document.createElement('span')
    el.setAttribute('data-field-hint', '')
    el.className = 'field-label'
    el.setAttribute('role', 'status')
    row.appendChild(el)
  }
  el.textContent = text
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
  // 自動填的基準值：改定位方式時只重算沒被手動改過的名稱
  input._afAutoName = name
  input.placeholder = '值名稱'
  input.addEventListener('input', () => {
    updateAlertRowsFields()
  })

  // 這個值在表格的哪個位置：使用者改了名字之後，還看得出它抓的是哪一格
  const whereEl = document.createElement('span')
  whereEl.setAttribute('data-field-where', '')
  whereEl.className = 'field-where'
  whereEl.textContent = fieldWhereText(spec)
  whereEl.title = whereEl.textContent

  // 立即測試回來的逐值結果就地顯示，不必到別的地方對照
  const resultEl = document.createElement('span')
  resultEl.setAttribute('data-field-result', '')
  resultEl.className = 'field-result'
  resultEl.textContent = '—'

  // 停用時用 `aria-disabled` 而不是原生 `disabled`：原生的點了完全沒回饋，
  // 使用者不知道是自己沒點到還是功能壞了（與工具列「停用不得靜默無事」同一條）
  const upBtn = document.createElement('button')
  upBtn.type = 'button'
  upBtn.setAttribute('data-field-up', '')
  upBtn.textContent = '上移'
  upBtn.addEventListener('click', () => {
    if (upBtn.getAttribute('aria-disabled') === 'true') {
      setFieldRowHint(row, '這個值已經是第一個了')
      return
    }
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
    if (downBtn.getAttribute('aria-disabled') === 'true') {
      setFieldRowHint(row, '這個值已經是最後一個了')
      return
    }
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
  row.appendChild(whereEl)
  row.appendChild(resultEl)
  row.appendChild(upBtn)
  row.appendChild(downBtn)
  row.appendChild(removeBtn)

  return row
}


// 「拆成每個值一個任務」只給新建的多值表單：編輯既有任務拆了會多出新任務、原任務還在
function updateSplitButton(n) {
  const btn = document.getElementById('split-tasks')
  if (!btn) return
  btn.hidden = n < 2 || Boolean(currentCtx?.task)
  btn.setAttribute('aria-disabled', String(n > MAX_BATCH_TASKS))
  const hint = document.querySelector('[data-split-hint]')
  if (hint) hint.textContent = ''
}

// 把多值表單轉成多任務清單：每個值各成一個任務，名稱與共用設定（排程、儀表板）照搬。
// 走既有的 kind:'batch' 面板路徑，存檔、試抓都與「一次建立多個任務」同一條
async function splitIntoTasks() {
  const btn = document.getElementById('split-tasks')
  const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
  if (!btn || btn.hidden) return
  if (btn.getAttribute('aria-disabled') === 'true') {
    const hint = document.querySelector('[data-split-hint]')
    if (hint) hint.textContent = `一次最多 ${MAX_BATCH_TASKS} 個任務；請先移除一些值再拆`
    return
  }
  const tabId = currentCtx?.tabId ?? panelTabId
  if (tabId === null || tabId === undefined) return
  // 共同欄位照搬；整批的預覽（preview 等）不屬於任何單一個值，不帶
  const common = {}
  for (const k of ['locator', 'blockInfo', 'url', 'tabId', 'frameId', 'frameUrl', 'nameHint']) {
    if (currentCtx?.[k] !== undefined) common[k] = currentCtx[k]
  }
  const draft = { ...snapshotForm(), batchNames: {} }
  const items = rows.map((r, i) => {
    const key = `b${i + 1}`
    const name = r.querySelector('input[data-field-name]')?.value?.trim()
    draft.batchNames[key] = name || `值 ${i + 1}`
    return { key, ...common, picks: [r._spec || fieldSpecs.get(r.dataset.fieldKey || '')] }
  })
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
  await setPanelCtx(tabId, { kind: 'batch', items, draft })
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
  let text = (loc?.css || loc?.path || '') || '尚未選取'
  if (row._frame?.url) {
    try {
      const host = new URL(row._frame.url).hostname
      if (host) text += `（${host}）`
    } catch {}
  }
  targetEl.textContent = text
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
  const visibleWrap = row.querySelector('[data-preaction-visible-wrap]')
  if (visibleWrap) visibleWrap.hidden = (type !== 'waitFor')
  if (input) {
    input.hidden = (type === 'click')
    if (type === 'wait') {
      // 下拉寫「等待秒數」欄位卻收毫秒，使用者填 3 只會等 3 毫秒——單位一律用秒
      input.placeholder = '秒數'
      input.step = '0.1'
    } else if (type === 'hover') {
      input.placeholder = '停留毫秒'
      input.step = '50'
      if (!input.value) input.value = String(DEFAULT_HOVER_HOLD_MS)
    } else if (type === 'waitFor') {
      input.placeholder = '逾時秒數'
      input.step = '1'
      if (!input.value) {
        input.value = String(DEFAULT_WAIT_TIMEOUT_MS / 1000)
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
  row._frame = data.frame || null

  const select = document.createElement('select')
  select.className = 'preaction-type'
  const options = [
    { value: 'waitFor', text: '等元素出現' },
    { value: 'hover', text: '移到元素上' },
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
        taskId: currentCtx?.task?.id,
        // 一律從最上層開始：要點的按鈕跟要抓的值常常不在同一層（值在 iframe 裡、
        // 按鈕是外層的頁籤）。進到值所在的 frame 就選不到外層的按鈕了——
        // 選取模式只能往下鑽、回不去（SPEC §2）。
        frameId: 0
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
    // 舊任務存的是毫秒，畫面一律以秒顯示（換算只有 shared/preaction.js 一份）
    if (data.sec !== undefined && data.sec !== null && String(data.sec).trim() !== '') {
      input.value = String(data.sec)
    } else if (data.ms !== undefined && data.ms !== null && !Number.isNaN(data.ms) && String(data.ms).trim() !== '') {
      input.value = String(Number(data.ms) / 1000)
    }
  } else if (data.type === 'click') {
    input.value = ''
  } else if (data.type === 'hover') {
    input.value = data.holdMs !== undefined && data.holdMs !== null && String(data.holdMs).trim() !== ''
      ? String(data.holdMs)
      : String(DEFAULT_HOVER_HOLD_MS)
  } else {
    if (data.timeoutMs !== undefined && data.timeoutMs !== null && !Number.isNaN(data.timeoutMs) && String(data.timeoutMs).trim() !== '') {
      input.value = String(Number(data.timeoutMs) / 1000)
    } else {
      input.value = String(DEFAULT_WAIT_TIMEOUT_MS / 1000)
    }
  }

  // 「出現」預設是看得見：選單多半早就在 DOM 裡、靠 class 切換顯示，
  // 要點隱藏的項目時才把這個勾掉
  const visibleWrap = document.createElement('label')
  visibleWrap.setAttribute('data-preaction-visible-wrap', '')
  visibleWrap.className = 'preaction-visible'
  const visibleBox = document.createElement('input')
  visibleBox.type = 'checkbox'
  visibleBox.setAttribute('data-preaction-visible', '')
  visibleBox.checked = data.visible !== false
  visibleWrap.appendChild(visibleBox)
  visibleWrap.appendChild(document.createTextNode('要看得見'))
  visibleWrap.title = '勾選＝元素要真的顯示出來才算出現；取消＝只要在頁面裡就算'

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
  row.appendChild(visibleWrap)
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
        // 那一列可能已經被刪掉、或整份清單被重畫過（編輯既有任務時會 replaceChildren）：
        // 寫進孤兒節點的話，使用者會看到「選好了卻沒反應」
        if (lastPreActionPickRow && !lastPreActionPickRow.isConnected) {
          lastPreActionPickRow = null
        }
        if (lastPreActionPickRow && !msg.cancelled) {
          lastPreActionPickRow._locator = msg.locator || null
          lastPreActionPickRow._frame = msg.frameUrl ? { url: msg.frameUrl } : null
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

  bindModeEvents()
  // 還沒有任何勾選（例如測試或首次開啟）才給預設；已勾的（含還原回來的）不動
  if (![...document.querySelectorAll('#card-types input[type="checkbox"]')].some(cb => cb.checked)) {
    applyDefaultCardTypes()
  }
}

// 表單值＋目前 ctx → 任務物件（儲存、立即測試、批次的全部試抓／全部儲存都走這一份）
function taskFromForm(values, ctx) {
  return buildTask(values, ctx?.locator, ctx?.task, ctx?.frameUrl ? { url: ctx.frameUrl } : undefined)
}

/**
 * 儲存核心：表單值 → 任務 → 存檔 → 新建任務時依儀表板與卡片型別加卡。
 * 單任務與批次「全部儲存」共用這一份；重建排程、問下次時間、記住預設值留在呼叫端（批次只做一次）。
 * @param {Object} values getFormData() 的結果
 * @param {Object} ctx 目前 render 的 ctx
 * @returns {Promise<Object>} 存好的 task
 */
async function saveTaskFromForm(values, ctx) {
  const task = taskFromForm(values, ctx)
  await saveTask(task)
  return task
}

/**
 * 新建任務依畫面上勾選的卡片型別加進儀表板（單任務與批次共用）。
 * **與存任務分開、排在重建排程之後**：卡片寫不進去（配額、儀表板剛被刪）不得讓已存好的任務沒有排程（體檢抓到的退化）。
 */
async function addCardsForTask(task, ctx) {
  // 只有新建任務才處理加入儀表板卡片
  if (!ctx?.task) {
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
}

// 新建任務存完記住這次的排程與去處（pickerDefaults.last；勾了固定就一併寫 pinned）
async function rememberPickerDefaults(values) {
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

export async function handleSave() {
  if (batchItems) return handleBatchSave()
  if (bulkTaskIds) return handleBulkSave()
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''
  const busySave = setBusy('save', '儲存中…')

  const values = getFormData()
  if (!values.url && currentCtx?.url) values.url = currentCtx.url

  const validation = validateForm(values)
  if (!validation.ok) {
    if (errorsEl) errorsEl.textContent = Object.values(validation.errors).join('\n')
    // 表單沒過就把按鈕還回去，不然使用者改完也按不下去
    busySave()
    return
  }

  // 儲存到關窗之間任何一步失敗（storage 配額、service worker 被殺），按鈕都要還回去、錯誤要看得到，
  // 否則使用者只看到永遠的「儲存中…」
  let savedTask = null
  let savedNextRun = null
  let cardError = null
  let prunedCount = 0
  try {
  const task = await saveTaskFromForm(values, currentCtx)
  savedTask = task
  if (globalThis.chrome?.runtime?.sendMessage) {
    await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
    // 排程重建之後才問得到實際的下次觸發時間；這一步要留在「儲存中」期間，
    // 放到按鈕還原之後會讓「儲存中不可連按」出現空窗
    try {
      const runs = await chrome.runtime.sendMessage({ type: MSG.GET_NEXT_RUNS })
      savedNextRun = runs?.nextRuns?.[task.id] ?? null
    } catch {}
  }

  // 只有新建任務才記住預設值
  if (!currentCtx?.task) {
    await rememberPickerDefaults(values)
  }
  // 編輯時被移除的值：清掉它們在儀表板上的來源與最後一次的值（紀錄一律保留到保留天數到期）。
  // 不清的話卡片會一直指著不存在的序列，使用者只看得到一張永遠空白的卡
  prunedCount = 0
  const prevFields = Array.isArray(currentCtx?.task?.fields) ? currentCtx.task.fields : []
  if (prevFields.length > 0) {
    const liveKeys = new Set((task.fields || []).map(f => f.key))
    const removedKeys = prevFields.map(f => f.key).filter(k => !liveKeys.has(k))
    if (removedKeys.length > 0) {
      prunedCount = removedKeys.length
      const seriesIds = removedKeys.map(k => seriesIdOf(task.id, k))
      try {
        await pruneSeries(seriesIds)
        await deleteLastValues(seriesIds)
      } catch {}
    }
  }
  // 卡片排最後：任務與排程都好了，卡片失敗只是少一張卡，說出來就好
  try { await addCardsForTask(task, currentCtx) } catch (e) { cardError = e?.message || String(e) }

  } catch (e) {
    if (errorsEl) errorsEl.textContent = `儲存失敗：${e?.message || e}`
    return
  } finally {
    busySave()
  }
  await showSavedFeedback(savedTask, {
    nextRunMs: savedNextRun,
    hint: !currentCtx?.task,
    ...(prunedCount > 0 ? { note: `移除了 ${prunedCount} 個值；它們的歷史紀錄會保留到保留天數到期。` } : {}),
    ...(cardError ? { warning: `任務已經存好，但沒有加進儀表板：${cardError}。可以到報表的儀表板自己加。`, closeDelayMs: null } : {})
  })
}

/**
 * 儲存成功之後不要無聲關窗：說出「存好了、下次什麼時候抓」，
 * 並給一條去看結果的路。1.5 秒後自動關，使用者也可以自己點。
 */
export async function showSavedFeedback(task, { nextRunMs = null, closeDelayMs = 1500, tabId = panelTabId, count = null, hint = false, warning = '', note = '', text = null } = {}) {
  const form = document.getElementById('picker-form')
  if (!form || !task) return
  let when = ''
  if (nextRunMs) {
    const d = new Date(nextRunMs)
    when = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  // 批次（count 有值）說存了幾個；問不到實際 alarm 就退回白話句，不要讓這裡空著
  const head = count !== null ? `已儲存 ${count} 個任務。` : '已儲存。'
  // 停用中的任務不會抓，說「下次抓取」是誤導（以前存檔會把它復活，所以那句話碰巧是真的）
  const paused = count === null && task.enabled === false
  const finalText = (text !== null && text !== undefined)
    ? text
    : (paused
      ? `${head}此任務目前停用，不會排程；到任務頁啟用後才會抓。`
      : (when ? `${head}下次抓取：${when}` : `${head}${describeSchedule(task.schedule)}`))
  // 提示（新建的單任務才給）與警告都跟著 saved ctx 走：session 一寫面板就會照 ctx 重畫回饋區，
  // 只 append 在 DOM 上的會被洗掉（體檢實測：提示行在側邊面板永遠看不到）
  const saved = { kind: 'saved', text: finalText, ...(hint && count === null ? { hint: true } : {}), ...(warning ? { warning } : {}), ...(note ? { note } : {}) }
  buildSavedFeedback(form, saved)

  // 存好了就不再是「填到一半的表單」：草稿不得再寫回，session 收成 saved，
  // 關窗前使用者右鍵再選時 background 才會當成新的一輪，而不是換目標
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
  if (tabId !== null && tabId !== undefined) {
    try { await setPanelCtx(tabId, saved) } catch {}
  }

  // closeDelayMs 為 null：不自動關（回饋區有使用者一定要看的警告時）
  if (closeDelayMs !== null && typeof setTimeout === 'function') {
    // 記住是「哪一個視窗」：延遲期間全域的 window 可能已經換人，
    // 關掉別人的視窗比不關還糟
    const myWindow = typeof window !== 'undefined' ? window : null
    setTimeout(async () => {
      // 面板沒有 window.close()：請 background 關它，並清掉草稿——
      // 不清的話下一個新任務會被這一個的名稱與排程灌進去
      if (globalThis.chrome?.sidePanel) {
        // 到期前使用者已經開始下一輪（session 不再是 saved）：不得連面板一起關掉
        let current = null
        try { current = await getPanelCtx(tabId) } catch {}
        if (current?.kind === 'saved') finishPanelSession(tabId)
        return
      }
      if (myWindow && globalThis.window === myWindow && myWindow.close) myWindow.close()
    }, closeDelayMs)
  }
}

/**
 * 回饋區（一行文字＋「開啟報表」）：儲存當下與面板在 saved 態重載共用這一份。
 */
function buildSavedFeedback(form, saved) {
  const box = document.createElement('div')
  box.id = 'saved-feedback'
  box.setAttribute('role', 'status')
  const line = document.createElement('div')
  line.textContent = saved?.text || '已儲存。'
  box.appendChild(line)
  if (saved?.warning) {
    const warn = document.createElement('div')
    warn.setAttribute('data-saved-warning', '')
    warn.setAttribute('role', 'alert')
    warn.textContent = saved.warning
    box.appendChild(warn)
  }
  if (saved?.note) {
    const noteEl = document.createElement('div')
    noteEl.setAttribute('data-saved-note', '')
    noteEl.textContent = saved.note
    box.appendChild(noteEl)
  }
  if (saved?.hint) {
    const hintEl = document.createElement('div')
    hintEl.setAttribute('data-saved-hint', '')
    hintEl.textContent = '同一頁還要抓別的？下次在右鍵選「一次建立多個任務」'
    box.appendChild(hintEl)
  }

  const openBtn = document.createElement('button')
  openBtn.type = 'button'
  openBtn.id = 'saved-open-report'
  openBtn.className = 'btn-primary'
  openBtn.textContent = '開啟報表'
  openBtn.addEventListener('click', () => {
    try {
      const url = typeof chrome?.runtime?.getURL === 'function'
        ? chrome.runtime.getURL('ui/report/report.html')
        : 'ui/report/report.html'
      chrome.tabs.create({ url })
    } catch {}
    // 側邊面板沒有 window.close()：走與取消鈕同一條收尾（AF-18 終檢；以前按了面板不會關、session 也沒清）
    if (globalThis.chrome?.sidePanel) finishPanelSession()
    else if (typeof window !== 'undefined' && window.close) window.close()
  })
  box.appendChild(openBtn)

  const errorsEl = form.querySelector('#errors') || document.getElementById('errors')
  if (errorsEl) {
    errorsEl.textContent = ''
    box.appendChild(errorsEl)
  }

  form.replaceChildren(box)
}

// 上一次「立即測試」失敗時 background 給的診斷包。**只存在記憶體**：
// 不寫 storage、不進 diag 環形緩衝，使用者按下按鈕才落地成檔案（SPEC §3、§5）。
let lastDebug = null

// 匯出鈕與它的說明一起顯示或收起（收起時要把上一次的內容也丟掉，
// 否則使用者在下一次成功之後匯出到的是舊的那一份）
function setDiagAvailable(debug) {
  lastDebug = debug || null
  const btn = document.getElementById('export-diag')
  const note = document.getElementById('export-diag-note')
  const on = Boolean(lastDebug)
  if (btn) btn.hidden = !on
  if (note) note.hidden = !on
}

function diagFilename(name) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  const safe = String(name || '').trim().replace(/[\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'preview'
  return `autofetcher-diag-${safe}-${stamp}.json`
}

// 把使用者送到定位下拉那裡：說了「請改用列定位」卻要他自己找，等於沒說
export function focusPositionSelect(id) {
  const el = document.getElementById(id === 'col-pos' ? 'col-pos' : 'row-pos')
  if (!el) return
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' })
  if (typeof el.focus === 'function') el.focus()
}

export async function handleExportDiag() {
  if (!lastDebug) return
  try {
    await download({
      filename: diagFilename(document.getElementById('name')?.value),
      content: JSON.stringify(lastDebug, null, 2)
    })
  } catch {}
}

function blockCountsText(res) {
  if (!res || res.used === undefined) return ''
  const u = res.used
  const s = res.skipped ?? 0
  const e = res.excluded ?? 0
  const blankPart = res.blank > 0 ? `、空白 ${res.blank} 格` : ''
  // skipped＝非數字、excluded＝略過頭尾＋點選排除（與歷史頁明細同一套口徑）
  return `（用了 ${u} 格、非數字 ${s} 格${blankPart}、略過與排除 ${e} 格）`
}

// 逐格處置文字對照表（八種 use，不含單位）
const USE_TEXT = {
  used: '採用',
  nonnumeric: '非數字',
  blank: '空白',
  trimmed: '頭尾空白（已自動略過）',
  skipHead: '略過開頭',
  skipTail: '略過結尾',
  excluded: '排除',
  unresolved: '找不到子路徑'
}

// 明細表歸零：藏起、收合、清空。三個入口共用——測試開始、換目標重畫、畫表之前。
// 換目標那一處不能漏：上一個目標的整欄明細留在畫面上、旁邊卻是新目標的預覽，
// 與 AF-7 pickedTableEl、AF-9 undoSnapshot 同型的跨目標殘留
function resetTestDetail() {
  const detailEl = document.getElementById('test-detail')
  if (!detailEl) return null
  detailEl.hidden = true
  detailEl.open = false
  const bodyEl = detailEl.querySelector('[data-test-detail-body]')
  if (bodyEl) bodyEl.textContent = ''
  return bodyEl ? { detailEl, bodyEl } : null
}

// 明細表總格數不超過這個數就測完自動展開（多值任務以各值格數加總）
const DETAIL_AUTO_OPEN_MAX = 30

// 畫出立即測試的「看抓到的格子」明細表（成功與失敗兩條路共用）
function renderTestDetail(values, res) {
  const slots = resetTestDetail()
  if (!slots || !res) return
  const { detailEl, bodyEl } = slots

  const sections = []
  const isMulti = Array.isArray(values?.fields) && values.fields.length > 0
  if (isMulti) {
    for (const f of values.fields) {
      const items = res.fields?.[f.key]?.items
      if (Array.isArray(items) && items.length > 0) {
        sections.push({
          name: f.name,
          axis: f.block?.axis,
          items
        })
      }
    }
  } else {
    const items = res.items
    if (Array.isArray(items) && items.length > 0) {
      sections.push({
        axis: values?.block?.axis,
        items
      })
    }
  }

  if (sections.length === 0) {
    detailEl.hidden = true
    return
  }

  let totalItems = 0
  for (const sec of sections) {
    totalItems += sec.items.length
    const sectionEl = document.createElement('section')
    sectionEl.setAttribute('data-detail-field', '')

    if (isMulti) {
      const nameEl = document.createElement('div')
      nameEl.setAttribute('data-detail-name', '')
      nameEl.textContent = sec.name || ''
      sectionEl.appendChild(nameEl)
    }

    const table = document.createElement('table')
    const thead = document.createElement('thead')
    const headTr = document.createElement('tr')
    const col2Text = sec.axis === 'row' ? '欄標題' : '列標題'
    for (const title of ['#', col2Text, '內容', '數字', '處置']) {
      const th = document.createElement('th')
      th.textContent = title
      headTr.appendChild(th)
    }
    thead.appendChild(headTr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const it of sec.items) {
      const tr = document.createElement('tr')
      if (it.use) {
        tr.dataset.use = it.use
      }

      const tdIdx = document.createElement('td')
      tdIdx.textContent = String(it.index + 1)
      tr.appendChild(tdIdx)

      const tdHeader = document.createElement('td')
      tdHeader.textContent = (it.header !== undefined && it.header !== null) ? String(it.header) : ''
      tr.appendChild(tdHeader)

      const tdRaw = document.createElement('td')
      const rawText = (it.raw !== undefined && it.raw !== null) ? String(it.raw) : ''
      tdRaw.textContent = rawText
      if (it.raw !== undefined && it.raw !== null) {
        tdRaw.title = String(it.raw)
      }
      tr.appendChild(tdRaw)

      const tdNum = document.createElement('td')
      tdNum.textContent = (it.number !== undefined && it.number !== null) ? String(it.number) : ''
      tr.appendChild(tdNum)

      const tdUse = document.createElement('td')
      tdUse.textContent = USE_TEXT[it.use] || (it.use ?? '')
      tr.appendChild(tdUse)

      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    sectionEl.appendChild(table)
    bodyEl.appendChild(sectionEl)
  }

  const summaryEl = detailEl.querySelector('summary')
  if (summaryEl) {
    summaryEl.textContent = `查看抓到的 ${totalItems} 格`
  }
  detailEl.hidden = false
  // 少量格數直接攤開；整欄很長時維持收合，不把面板撐爆
  detailEl.open = totalItems <= DETAIL_AUTO_OPEN_MAX
}

// 立即測試結束後把「先試抓看看」區捲進可視範圍（按鈕在底部固定列，結果在畫面中段）
function scrollPreviewIntoView() {
  const section = document.getElementById('preview-section')
  if (!section || typeof section.scrollIntoView !== 'function') return
  const mm = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
  section.scrollIntoView({ block: 'nearest', behavior: mm?.matches ? 'auto' : 'smooth' })
}

export async function handleTestNow() {
  if (batchItems) return handleBatchTest()
  const previewEl = document.getElementById('preview')
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''
  const noteAtStart = document.getElementById('test-note')
  if (noteAtStart) {
    noteAtStart.textContent = ''
    delete noteAtStart.dataset.state
  }
  resetTestDetail()
  // 這一次的結果還沒出來，上一次的診斷先收起來
  setDiagAvailable(null)
  const busy = setBusy('test-now', '測試中…')

  const values = getFormData()
  if (!values.url && currentCtx?.url) values.url = currentCtx.url
  // buildTask 內部會呼叫 buildSpec(values) 組出規格
  const task = taskFromForm(values, currentCtx)
  // 這個任務不會被儲存，id 只是讓 runTask 的 inflight 鍵有個名字
  task.id = '__preview'

  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.TEST_TASK,
      task,
      tabId: currentCtx?.tabId
    })
    if (res && res.ok) {
      if (values.fields) {
        const lines = values.fields.map(f => {
          const fieldRes = res.fields?.[f.key]
          if (fieldRes && fieldRes.ok) {
            const val = fieldRes.value !== undefined ? String(fieldRes.value) : (fieldRes.raw ?? '')
            let line = `${f.name}: ${val}${blockCountsText(fieldRes)}`
            if (fieldRes.message) line += ` ⚠ ${fieldRes.message}`
            return line
          } else {
            const err = fieldRes?.message || fieldRes?.error || '抓取失敗'
            return `${f.name}: ${err}`
          }
        })
        if (previewEl) previewEl.textContent = lines.join('\n')
        // 逐值結果也要回到各自那一列，使用者才不必在預覽區裡對照名字
        applyFieldResults(values.fields, res)
        // 多值任務即使整體 ok，個別值仍可能失敗（SPEC §7）：那時 background 會附診斷
        setDiagAvailable(res.debug)
      } else {
        const val = res.value !== undefined ? String(res.value) : (res.raw ?? '')
        if (previewEl) previewEl.textContent = val + blockCountsText(res)
      }
      if (errorsEl) errorsEl.textContent = ''
      // 排除項找不到：值抓得到，但合計可能被加進去了——用警告色，不是成功的綠
      const warned = values.fields
        ? Object.values(res.fields || {}).some(f => f && f.ok && f.message)
        : Boolean(res.message)
      setPreviewState(warned ? 'warn' : 'ok')
      // 這次測試是在使用者眼前這個分頁跑的，iframe 已經開著；排程是開新分頁，
      // 兩者會不一樣，成功不代表排程也會成功
      const noPreActions = !Array.isArray(values.preActions) || values.preActions.length === 0
      const noteEl = document.getElementById('test-note')
      const notes = []
      if (noteEl && Array.isArray(res.preActionTrace) && res.preActionTrace.length > 0) {
        // 調 hover 選單時最需要知道的是「hover 有做、是 click 沒點到」還是「hover 就失敗」，
        // 只回一句「成功」等於什麼都沒說
        const total = res.preActionTrace.reduce((sum, step) => sum + (Number(step.ms) || 0), 0)
        notes.push(`前置動作 ${res.preActionTrace.length} 步完成（共 ${(total / 1000).toFixed(1)} 秒）`)
      } else if (noteEl && currentCtx?.frameUrl && noPreActions) {
        notes.push('這次測試在目前分頁執行；排程會開新分頁，若那個框架要先點才會出現，請加入前置動作。')
      }
      if (!values.fields && res.message) {
        notes.push(res.message)
      }
      if (noteEl) {
        noteEl.textContent = notes.join('\n')
        // 警告狀態只在這裡設；清除只有測試開始時那一份（不再各清一次）
        if (!values.fields && res.message) noteEl.dataset.state = 'warn'
      }
      renderTestDetail(values, res)
    } else {
      // 有解法的訊息優先：'not_found' 只說了失敗，沒說使用者能怎麼辦
      const err = res?.message || res?.error || '找不到目標元素'
      if (errorsEl) errorsEl.textContent = err
      if (previewEl) previewEl.textContent = '—'
      setPreviewState('error')
      // 失敗才有診斷可以匯出（成功時 background 不組）
      setDiagAvailable(res?.debug)
      // 走到第幾步也要說：調 hover 選單時，「hover 有做、click 沒點到」與「hover 就失敗」是兩種修法
      const noteEl = document.getElementById('test-note')
      if (noteEl && Array.isArray(res?.preActionTrace) && res.preActionTrace.length > 0) {
        const done = res.preActionTrace.filter(step => step.ok).length
        noteEl.textContent = `前置動作走到第 ${res.preActionTrace.length} 步（前 ${done} 步成功）`
      }
      renderTestDetail(values, res)
    }
  } catch (e) {
    const err = e?.message || '找不到目標元素'
    if (errorsEl) errorsEl.textContent = err
    if (previewEl) previewEl.textContent = '—'
    setPreviewState('error')
  } finally {
    busy()
    try { scrollPreviewIntoView() } catch {}
  }
}

// 按下之後到結果回來之間，按鈕要看得出正在做事，而且不能被連按
function setBusy(id, label) {
  const btn = document.getElementById(id)
  if (!btn) return () => {}
  const prevText = btn.textContent
  const prevDisabled = btn.disabled
  btn.textContent = label
  btn.disabled = true
  return () => {
    btn.textContent = prevText
    btn.disabled = prevDisabled
  }
}

// ---- side panel 啟動流程（AF-10 作業 B）----
// 面板無法自己判斷屬於哪個分頁：`sender.tab` 永遠是 null、網址參數重載後被丟掉、
// 載入當下查 active tab 會在切換競態拿到舊分頁（B-0 #11、#12）。
// 唯一穩的是 windowId（#14），而且要在**轉為可見時**才解析（#13）。
let panelTabId = null
let panelWindowId = null
let draftTimer = null
// 上一次真的畫過的 ctx 簽章：草稿寫回 session 會觸發 onChanged，
// 面板會再收到同一份 ctx（只多了 draft）——這時不能重畫，使用者正在打字
let lastPanelSig = null

/**
 * 問 background：這個視窗現在的作用分頁是哪個。
 * @returns {Promise<number|null>}
 */
async function resolvePanelTab() {
  if (panelWindowId === null) {
    try { panelWindowId = (await chrome.windows.getCurrent())?.id ?? null } catch { panelWindowId = null }
  }
  if (panelWindowId === null) return null
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.RESOLVE_PANEL_TAB, windowId: panelWindowId })
    return res?.tabId ?? null
  } catch { return null }
}

/**
 * 依 session 裡的 ctx 決定要顯示哪一個畫面。
 */
export async function renderFromPanelCtx(ctx, { reload = () => globalThis.location?.reload?.() } = {}) {
  // background 留下的說明（例如入口被擋）：簽章沒變也要更新這一句，但不得重畫表單
  const noticeEl = document.getElementById('panel-notice')
  if (noticeEl) {
    const notice = typeof ctx?.notice === 'string' ? ctx.notice.trim() : ''
    noticeEl.hidden = !notice
    noticeEl.textContent = notice
  }
  const sig = ctx ? JSON.stringify({ kind: ctx.kind, ctx: ctx.ctx, taskId: ctx.taskId, retarget: ctx.retarget, batch: ctx.batch, taskIds: ctx.taskIds }) : 'null'
  if (sig === lastPanelSig) return { rendered: false }
  // 剛存完、表單已被回饋區換掉，使用者又開始下一輪（等待態／新表單）：表單節點與綁在上面的監聽都不在了，
  // 在這份文件上 render 會畫不出來——重載面板文件，重載後照 session 畫（AF-18 批次 D 實作回報抓到）
  if (ctx && ctx.kind !== 'saved' && document.getElementById('saved-feedback')) {
    reload()
    return { rendered: false, reloading: true }
  }
  // 面板文件剛載入（還沒畫過）時，retarget 沒有「現有的表單」可以保留，
  // 要走完整路徑再把草稿貼回來，不然切分頁回來草稿就丟了
  const freshDocument = lastPanelSig === null
  lastPanelSig = sig
  const waiting = document.getElementById('panel-waiting')
  const form = document.getElementById('picker-form') || document.querySelector('.settings-body')
  const kind = ctx?.kind
  if (waiting) waiting.hidden = kind !== 'waiting'
  // 等待態時把表單藏起來：面板一開就看到一整頁空欄位，使用者不知道自己該做什麼
  if (form) form.hidden = kind === 'waiting'
  const footer = document.querySelector('.settings-footer') || document.getElementById('picker-actions')
  if (footer) footer.hidden = kind === 'waiting'
  if (kind !== 'saved') {
    const header = document.querySelector('[data-picker-header]')
    if (header) header.hidden = false
  }
  if (kind !== 'batch') setBatchView(false)
  if (kind !== 'bulk') setBulkView(false)
  if (kind === 'waiting') setWaitingText(ctx.batch === true)
  if (kind === 'waiting' || !ctx) return { rendered: true }

  if (kind === 'bulk' && Array.isArray(ctx.taskIds)) {
    await renderBulk(ctx)
    return { rendered: true }
  }

  if (kind === 'batch' && Array.isArray(ctx.items)) {
    await renderBatch(ctx)
    return { rendered: true }
  }

  // 剛存完、面板文件被重載：畫回同一個回饋區（表單已經不存在，不得露出空表單）
  if (kind === 'saved') {
    // 名稱欄在表單外的頁首：沒有表單可存時一起藏起來
    const header = document.querySelector('[data-picker-header]')
    if (header) header.hidden = true
    if (form) buildSavedFeedback(form, ctx)
    return { rendered: true }
  }

  if (kind === 'edit' && ctx.taskId) {
    const task = await getTask(ctx.taskId)
    if (!task) return { rendered: false }
    render({ task, locator: task.locator, url: task.url })
    const testNow = document.getElementById('test-now')
    if (testNow) testNow.hidden = true
    // 面板開在報表分頁旁，那裡沒有目標頁可選；選完回來還會被當成新表單而存出一個副本。
    // 要換目標一律走任務頁的「重選」（它會自己開目標頁）
    const repick = document.getElementById('repick-target')
    if (repick) repick.hidden = true
    await renderDashboardSection(task)
    restoreDraft(ctx.draft)
    return { rendered: true }
  }

  if (kind === 'new' && ctx.ctx) {
    // 換目標（面板已經開著、使用者填了一半）：只換目標欄位，
    // 名稱／排程／儀表板／進階留著——右鍵重選一個目標不該把表單清空
    if (ctx.retarget && !freshDocument) {
      applyRetarget(ctx.ctx)
      return { rendered: true }
    }
    render(ctx.ctx)
    await renderDashboardSection(ctx.ctx?.task)
    await applyPickerDefaults(ctx.ctx?.task)
    restoreDraft(ctx.draft)
    return { rendered: true }
  }
  return { rendered: false }
}

/**
 * 只換目標，保留使用者已經填的其他設定。
 */
function applyRetarget(payload) {
  // 先把畫面上現有的值抄下來（鍵是元素 id，才還原得回去），再換目標、再貼回來
  const keep = snapshotForm()
  // 多值清單、告警與前置動作都不在 DRAFT_FIELDS 裡（它只認有 id 的欄位），
  // 不另外抄就會在 render 的 replaceChildren 裡整批消失——而提示句還說「其他設定都留著」
  const prevRows = Array.from(document.querySelectorAll('#field-list [data-field-row]')).map(r => ({
    key: r.dataset.fieldKey || '',
    name: r.querySelector('input[data-field-name]')?.value ?? '',
    auto: r.querySelector('input[data-field-name]')?._afAutoName ?? null,
    spec: r._spec || fieldSpecs.get(r.dataset.fieldKey || '') || {}
  }))
  const prevForm = getFormData()
  const prevAlerts = Array.isArray(prevForm.alerts) ? prevForm.alerts : []
  const prevPreActions = Array.isArray(prevForm.preActions) ? prevForm.preActions : []

  render(payload)
  restoreDraft(keep, { skipTarget: true })

  // 同一格就沿用原本的 key 與名稱：key 重生會讓歷史序列斷掉（判定與重選共用 field-match）
  const picks = Array.isArray(payload?.picks) ? payload.picks : []
  const matched = prevRows.length > 0 && picks.length > 0 ? reconcileFields(prevRows, picks) : null
  const keyMap = new Map()
  if (matched) {
    const rows = Array.from(document.querySelectorAll('#field-list [data-field-row]'))
    rows.forEach((r, i) => {
      const m = matched[i]
      if (!m) return
      const oldKey = r.dataset.fieldKey || ''
      if (m.kept) {
        keyMap.set(oldKey, m.key)
        const spec = fieldSpecs.get(oldKey)
        fieldSpecs.delete(oldKey)
        if (spec) fieldSpecs.set(m.key, spec)
        r.dataset.fieldKey = m.key
        const input = r.querySelector('input[data-field-name]')
        if (input && m.name) {
          // 自動名基準也要跟著搬：不搬的話「使用者動過就不覆蓋」的守衛會誤判
          if (m.auto !== null && m.auto !== undefined) input._afAutoName = m.auto
          input.value = m.name
        }
      }
    })
    updateFieldListState()
  }

  // 告警與前置動作原樣重建；告警綁的值若已經不在清單裡，退回「全部值」而不是指著不存在的 key
  const liveKeys = new Set(Array.from(document.querySelectorAll('#field-list [data-field-row]')).map(r => r.dataset.fieldKey))
  for (const a of prevAlerts) {
    const next = { ...a }
    if (next.field) {
      const mapped = keyMap.get(next.field) || next.field
      next.field = liveKeys.has(mapped) ? mapped : ''
    }
    addAlertRow(next)
  }
  for (const pa of prevPreActions) {
    addPreActionRow(pa)
  }

  const note = document.getElementById('retarget-note')
  if (note) {
    note.hidden = false
    const dropped = matched ? matched.removed.length : 0
    note.textContent = '已換成新的目標；名稱、排程、告警、前置動作都留著。'
      + (dropped > 0 ? `對不到新目標的值移除了 ${dropped} 個。` : '')
  }
}

// 要跨「換目標」與「面板重載」保住的欄位（鍵一律是元素 id，restoreDraft 靠它還原）
const DRAFT_FIELDS = [
  'name', 'schedule-type', 'times', 'every-minutes', 'window-enabled', 'window-from', 'window-to',
  'block-aggregate', 'row-pos', 'col-pos', 'dashboard-select', 'regex'
]
// 沒有 id 的勾選群組（星期、卡片型別）以「容器選擇器 → 勾選的 value 陣列」存
const DRAFT_GROUPS = { weekdays: '#weekdays input[type="checkbox"]', cardTypes: '#card-types input[type="checkbox"]' }

/**
 * 把畫面上的表單值抄成 `{元素 id: 值}`。
 */
export function snapshotForm() {
  const out = {}
  for (const id of DRAFT_FIELDS) {
    const el = document.getElementById(id)
    if (!el) continue
    out[id] = el.type === 'checkbox' ? el.checked : el.value
  }
  for (const [key, sel] of Object.entries(DRAFT_GROUPS)) {
    const boxes = Array.from(document.querySelectorAll(sel))
    if (boxes.length > 0) out[key] = boxes.filter(cb => cb.checked).map(cb => cb.value)
  }
  return out
}

/**
 * 草稿還原：面板文件在切換分頁後會被重載（B-0 #5 實測），
 * 沒有這一段，使用者切去看一眼別的分頁回來就發現表單被清空了。
 */
function restoreDraft(draft, opts = {}) {
  if (!draft || typeof draft !== 'object') return
  for (const [id, value] of Object.entries(draft)) {
    if (opts.skipTarget && (id === 'url' || id === 'mode')) continue
    const el = document.getElementById(id)
    if (!el) continue
    if (el.type === 'checkbox') el.checked = Boolean(value)
    else if (value !== undefined && value !== null) el.value = String(value)
  }
  for (const [key, sel] of Object.entries(DRAFT_GROUPS)) {
    if (!Array.isArray(draft[key])) continue
    for (const cb of document.querySelectorAll(sel)) cb.checked = draft[key].includes(cb.value)
  }
  // 排程欄位是連動的（類型切換顯示哪一組、時刻 chip、時段欄、預覽與摘要）：值貼回去之後畫面要跟上
  syncScheduleFields()
  syncWindowFields()
  renderTimeChips()
  updateSchedulePreview()
  updateSetupSummary()
}

/**
 * 表單值變動就寫回草稿（節流）。
 */
/**
 * 存檔或取消後的收尾：清掉草稿並請 background 關面板。
 * 不清草稿的話，下一個新任務會被上一個的名稱與排程灌進去。
 */
async function finishPanelSession(tabId = panelTabId) {
  if (tabId === null || tabId === undefined) return
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
  try { await chrome.runtime.sendMessage({ type: MSG.CLOSE_PANEL, tabId }) } catch {}
}

function scheduleDraftSave() {
  if (panelTabId === null) return
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(async () => {
    draftTimer = null
    const draft = snapshotForm()
    if (batchItems) {
      // 批次畫面：各列名稱以穩定鍵記、共用的合成方式另記（單任務草稿的形狀不變）
      draft.batchNames = batchNamesFromDom()
      const agg = document.getElementById('batch-aggregate')
      if (agg) draft['batch-aggregate'] = agg.value
    }
    // 使用者已經在動表單了：被擋時留下的說明一併收掉（沒有別的清除路徑，會一直掛著；體檢抓到）
    try { await mergePanelCtx(panelTabId, { draft, notice: undefined }) } catch {}
  }, 300)
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
  const repick = document.getElementById('repick-target')
  if (repick) {
    repick.hidden = true
  }
}

if (typeof document !== 'undefined' && document.getElementById('save') && globalThis.chrome?.runtime?.id) {
  applySavedTheme()
  document.getElementById('save')?.addEventListener('click', () => handleSave())
  document.getElementById('cancel')?.addEventListener('click', () => {
    // 面板沒有 window.close()：請 background 關它，順便把草稿清掉
    finishPanelSession()
    if (!globalThis.chrome?.sidePanel) window.close()
  })
  // 回頁面重選目標：面板不必關，選好之後 background 會把新目標併進來
  document.getElementById('repick-target')?.addEventListener('click', async () => {
    if (panelTabId === null) return
    try {
      await chrome.runtime.sendMessage({
        type: MSG.ENTER_PICK, purpose: 'task', tabId: panelTabId, frameId: 0,
        preselect: Array.isArray(currentCtx?.picks) ? currentCtx.picks : undefined
      })
    } catch {}
  })
  document.getElementById('test-now')?.addEventListener('click', () => handleTestNow())
  document.getElementById('export-diag')?.addEventListener('click', () => handleExportDiag())
  document.getElementById('goto-rowpos')?.addEventListener('click', (e) => focusPositionSelect(e.currentTarget?.dataset?.target))
  bindModeEvents()
  bindAlertEvents()
  bindPreActionEvents()
  bindPreActionMessageListener()

  const search = typeof window !== 'undefined' ? window.location?.search : ''
  const params = new URLSearchParams(search || '')
  // side panel：沒有網址參數可用，改由 session 的 ctx 決定畫面
  if (!params.has('taskId') && !params.has('ctx') && globalThis.chrome?.sidePanel) {
    // 退路的彈出視窗不是面板：它的作用分頁是它自己，解析不到目標分頁。
    // 開它的人會在網址上寫明「你服務的是哪個分頁」
    const forcedTab = params.has('tabId') ? Number(params.get('tabId')) : null
    const boot = async () => {
      const tabId = Number.isFinite(forcedTab) && forcedTab !== null ? forcedTab : await resolvePanelTab()
      if (tabId === null) return
      const changed = tabId !== panelTabId
      panelTabId = tabId
      const ctx = await getPanelCtx(tabId)
      if (changed || ctx) await renderFromPanelCtx(ctx)
    }
    // 載入當下就解析會拿到切換前的舊分頁；轉為可見時再解析才正確，
    // 而且每次轉為可見都重解析一次（自癒）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') boot()
    })
    if (document.visibilityState === 'visible') boot()
    // ctx 變了（例如使用者在頁面上選好了目標）就重畫
    subscribe(() => { boot() }, { area: 'session' })
    document.addEventListener('input', scheduleDraftSave, true)
    document.addEventListener('change', scheduleDraftSave, true)
    document.getElementById('panel-cancel-pick')?.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: MSG.CLOSE_PANEL, tabId: panelTabId }) } catch {}
    })
  } else if (params.has('taskId')) {
    initFromQuery(search).then(() => {
      renderDashboardSection(currentCtx?.task)
    })
  } else if (params.has('ctx')) {
    // 順序不能並行：儀表板下拉要先建好，記住的 dashboardId 才還原得回去；
    // 預設值要最後套，才不會被儀表板區塊的預設勾選蓋掉
    let parsed = null
    try { parsed = JSON.parse(decodeURIComponent(params.get('ctx'))) } catch { parsed = null }
    ;(async () => {
      if (parsed) render(parsed)
      await renderDashboardSection(parsed?.task)
      await applyPickerDefaults(parsed?.task)
    })()
  } else {
    applyPickerDefaults(null)
    renderDashboardSection(null)
  }
}

// ---- 批次：一次建立多個任務（AF-18 批次 G-3）----
// 目前清單上的項目（依畫面順序由 DOM 決定）；null＝不是批次畫面

function setWaitingText(isBatch) {
  const t = isBatch ? WAITING_TEXT.batch : WAITING_TEXT.single
  const titleEl = document.getElementById('panel-waiting-title')
  if (titleEl) titleEl.textContent = t.title
  const descEl = document.getElementById('panel-waiting-desc')
  if (descEl) descEl.textContent = t.desc
}

// 批次畫面只露出清單、共用排程與去處；單任務那幾區一律藏起來。
// render(item) 會把「抓什麼」區打開，所以收集每一項之後都要再套一次
function setBatchView(on) {
  if (!on && !batchViewOn) return
  batchViewOn = on
  if (!on) batchItems = null
  const show = (id, visible) => {
    const el = document.getElementById(id)
    if (el) el.hidden = !visible
  }
  show('batch-section', on)
  if (on) {
    show('block-section', false)
    show('schedule-section', true)
    show('add-to-dashboard', true)
  }
  show('preview-section', !on)
  show('advanced-section', !on)
  show('repick-target', !on)
  const header = document.querySelector('[data-picker-header]')
  if (header && on) header.hidden = true
  const save = document.getElementById('save')
  if (save) save.textContent = on ? '全部儲存' : '儲存'
  const testNow = document.getElementById('test-now')
  if (testNow) testNow.textContent = on ? '全部試抓' : '立即測試'
  // 錯誤訊息平常在「先試抓看看」區；那一區在批次畫面藏著，錯誤要搬到看得見的清單區
  const errorsEl = document.getElementById('errors')
  const host = on ? document.getElementById('batch-section') : document.getElementById('preview-section')
  if (errorsEl && host && errorsEl.parentNode !== host) {
    if (on) host.appendChild(errorsEl)
    else document.getElementById('preview')?.after(errorsEl)
  }
}

function batchTabId() {
  return batchItems?.[0]?.tabId ?? panelTabId
}

function batchRows() {
  return Array.from(document.querySelectorAll('#batch-list [data-batch-item]'))
}

async function renderBatch(ctx) {
  batchItems = ctx.items.slice()
  setBatchView(true)
  await renderDashboardSection(null)
  await applyPickerDefaults(null)
  const batchAgg = document.getElementById('batch-aggregate')
  const blockAgg = document.getElementById('block-aggregate')
  if (batchAgg && blockAgg) batchAgg.value = blockAgg.value
  restoreDraft(ctx.draft)
  renderBatchList(ctx.draft?.batchNames)
  setBatchView(true)
}

function renderBatchList(savedNames) {
  const list = document.getElementById('batch-list')
  if (!list) return
  list.replaceChildren()
  const manual = (savedNames && typeof savedNames === 'object') ? savedNames : {}
  const used = new Set(batchItems.map(it => manual[it.key]).filter(n => typeof n === 'string' && n !== ''))
  for (const item of batchItems) {
    let name = typeof manual[item.key] === 'string' && manual[item.key] !== '' ? manual[item.key] : null
    let auto = null
    if (name === null) {
      // 與單任務同一份命名規則；位置下拉先照這一項重設，才算得出同樣的名稱
      applyPositionDefaults(item)
      const base = defaultTaskName(item)
      name = base
      for (let n = 2; base && used.has(name); n++) name = `${base} (${n})`
      if (name) used.add(name)
      auto = name
    }
    list.appendChild(createBatchRow(item, name, auto))
  }
  const aggLabel = document.getElementById('batch-aggregate-label')
  if (aggLabel) {
    aggLabel.hidden = !batchItems.some(it => Array.isArray(it.picks) && it.picks.some(p => p?.block))
  }
}

function batchWhereText(item) {
  const picks = Array.isArray(item?.picks) ? item.picks : []
  const isBlock = picks.some(p => p?.cell || p?.block) ||
    item?.blockInfo?.kind === 'table' || item?.blockInfo?.kind === 'grid'
  return describeTarget({
    url: item?.url || '',
    mode: isBlock ? 'block' : 'number',
    fieldCount: picks.length >= 2 ? picks.length : 0,
    cell: picks[0]?.cell,
    block: picks[0]?.block
  })
}

function createBatchRow(item, name, auto) {
  const row = document.createElement('div')
  row.setAttribute('data-batch-item', '')
  row.setAttribute('data-batch-key', item.key)

  const input = document.createElement('input')
  input.type = 'text'
  input.setAttribute('data-batch-name', '')
  input.placeholder = '任務名稱'
  input.value = name
  input._afAutoName = auto
  input.addEventListener('input', () => scheduleDraftSave())

  const where = document.createElement('div')
  where.setAttribute('data-batch-where', '')
  where.textContent = batchWhereText(item)

  const result = document.createElement('div')
  result.setAttribute('data-batch-result', '')
  result.textContent = '—'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.setAttribute('data-batch-remove', '')
  remove.title = '移除這個任務'
  remove.textContent = '×'
  remove.addEventListener('click', () => removeBatchItems([item.key]))

  row.append(input, remove, where, result)
  return row
}

// 使用者改過的名稱（與自動名稱不同的）以穩定鍵記進草稿，移除或重載都不錯位
function batchNamesFromDom() {
  const out = {}
  for (const row of batchRows()) {
    const input = row.querySelector('input[data-batch-name]')
    if (input && input.value !== input._afAutoName) out[row.getAttribute('data-batch-key')] = input.value
  }
  return out
}

function removeBatchItems(keys) {
  if (!batchItems) return
  const drop = new Set(keys)
  const tabId = batchTabId()
  for (const row of batchRows()) {
    if (drop.has(row.getAttribute('data-batch-key'))) row.remove()
  }
  batchItems = batchItems.filter(it => !drop.has(it.key))
  if (batchItems.length === 0) {
    // 清單清空＝取消，與取消鈕同一條收尾
    finishPanelSession(tabId)
    return
  }
  const items = batchItems.slice()
  ;(async () => {
    try {
      const cur = await getPanelCtx(tabId)
      if (cur?.kind === 'batch') await mergePanelCtx(tabId, { items, notice: undefined })
    } catch {}
  })()
}


// 共用設定（排程各欄、儀表板、卡片型別、合成方式）抄下來，每一項 render 完再貼回
function snapshotShared() {
  const out = { fields: {}, weekdays: [], cardTypes: [] }
  for (const id of SHARED_IDS) {
    const el = document.getElementById(id)
    if (el) out.fields[id] = el.type === 'checkbox' ? el.checked : el.value
  }
  out.weekdays = Array.from(document.querySelectorAll('#weekdays input[type="checkbox"]')).map(cb => cb.checked)
  out.cardTypes = Array.from(document.querySelectorAll('#card-types input[type="checkbox"]')).map(cb => cb.checked)
  out.aggregate = document.getElementById('batch-aggregate')?.value || 'sum'
  return out
}

function pasteShared(shared) {
  for (const [id, value] of Object.entries(shared.fields)) {
    const el = document.getElementById(id)
    if (!el) continue
    if (el.type === 'checkbox') el.checked = Boolean(value)
    else el.value = value
  }
  document.querySelectorAll('#weekdays input[type="checkbox"]').forEach((cb, i) => { cb.checked = Boolean(shared.weekdays[i]) })
  document.querySelectorAll('#card-types input[type="checkbox"]').forEach((cb, i) => { cb.checked = Boolean(shared.cardTypes[i]) })
  const blockAgg = document.getElementById('block-aggregate')
  if (blockAgg) blockAgg.value = shared.aggregate
}

// 一項 → 表單值：與單任務同一條「render → 收集」，不從 payload 另組
function collectBatchValues(item, name, shared) {
  render(item)
  setBatchView(true)
  const nameEl = document.getElementById('name')
  if (nameEl) nameEl.value = name
  pasteShared(shared)
  const values = getFormData()
  if (!values.url && currentCtx?.url) values.url = currentCtx.url
  return values
}

function batchEntries() {
  const byKey = new Map((batchItems || []).map(it => [it.key, it]))
  return batchRows().map(row => ({
    row,
    item: byKey.get(row.getAttribute('data-batch-key')),
    name: (row.querySelector('input[data-batch-name]')?.value || '').trim()
  })).filter(e => e.item)
}

async function handleBatchSave() {
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''
  const busySave = setBusy('save', '儲存中…')
  const busyTest = setBusy('test-now', '全部試抓')
  const busy = () => { busySave(); busyTest() }
  const shared = snapshotShared()
  const entries = batchEntries()
  const saved = []
  let lastValues = null
  let failure = null
  let postError = null
  const cardErrors = []
  for (let i = 0; i < entries.length; i++) {
    const { item, name } = entries[i]
    try {
      const values = collectBatchValues(item, name, shared)
      // 收集會把畫面套回批次文字，進度要在它之後寫（與「全部試抓」同一套）
      const saveBtn = document.getElementById('save')
      if (saveBtn) saveBtn.textContent = `儲存中 ${i + 1}／${entries.length}…`
      const validation = validateForm(values)
      if (!validation.ok) {
        failure = { k: i + 1, name, message: Object.values(validation.errors).join('；') }
        break
      }
      const task = await saveTaskFromForm(values, currentCtx)
      saved.push({ key: item.key, task })
      lastValues = values
      try { await addCardsForTask(task, currentCtx) } catch (e) { cardErrors.push(`「${name}」${e?.message || e}`) }
    } catch (e) {
      failure = { k: i + 1, name, message: e?.message || String(e) }
      break
    }
  }
  // 收集過程換過表單內容：共用設定貼回、畫面維持批次清單
  pasteShared(shared)
  setBatchView(true)

  let nextRunMs = null
  try {
    if (saved.length > 0 && globalThis.chrome?.runtime?.sendMessage) {
      await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
      if (!failure) {
        try {
          const runs = await chrome.runtime.sendMessage({ type: MSG.GET_NEXT_RUNS })
          for (const { task } of saved) {
            const t = runs?.nextRuns?.[task.id]
            if (typeof t === 'number' && (nextRunMs === null || t < nextRunMs)) nextRunMs = t
          }
        } catch {}
      }
    }
    if (!failure && lastValues) await rememberPickerDefaults(lastValues)
  } catch (e) {
    // 任務都已經存好、之後的排程重建或記預設值才失敗：不是某一項存檔失敗——
    // 當成失敗會把清單全部移除、清單變空就關面板，錯誤訊息寫在一個看不到的面板上（AF-18 終檢）
    if (!failure) postError = e?.message || String(e)
  }

  if (failure) {
    // 已存的從清單移除，再按一次不會重複建立
    if (saved.length > 0) removeBatchItems(saved.map(s => s.key))
    if (errorsEl) errorsEl.textContent = `已儲存 ${failure.k - 1} 個；第 ${failure.k} 個「${failure.name}」失敗：${failure.message}`
    busy()
    return
  }
  busy()
  if (saved.length === 0) return
  batchItems = null
  // 有後段錯誤時不自動關面板：這一句使用者一定要看得到
  const warnings = []
  if (postError) warnings.push(`任務已經存好，但排程重建沒有完成：${postError}。請到報表的「任務管理」確認下次抓取時間。`)
  if (cardErrors.length > 0) warnings.push(`任務已經存好，但有卡片沒加進儀表板：${cardErrors.join('；')}。`)
  await showSavedFeedback(saved[0].task, {
    nextRunMs, count: saved.length,
    ...(warnings.length > 0 ? { warning: warnings.join(' '), closeDelayMs: null } : {})
  })
}

async function handleBatchTest() {
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''
  const btn = document.getElementById('test-now')
  const prevText = btn?.textContent
  if (btn) btn.disabled = true
  // 試抓與儲存共用同一份表單逐項 render：進行中互鎖，否則後跑完的那一個會把畫面蓋回去（體檢抓到）
  const saveBtn = document.getElementById('save')
  if (saveBtn) saveBtn.disabled = true
  const shared = snapshotShared()
  const entries = batchEntries()
  try {
    for (let i = 0; i < entries.length; i++) {
      const { row, item, name } = entries[i]
      const resultEl = row.querySelector('[data-batch-result]')
      try {
        const values = collectBatchValues(item, name, shared)
        // 收集會把畫面套回批次文字，進度要在它之後寫
        if (btn) btn.textContent = `試抓中 ${i + 1}／${entries.length}…`
        const task = taskFromForm(values, currentCtx)
        task.id = '__preview'
        const res = await chrome.runtime.sendMessage({ type: MSG.TEST_TASK, task, tabId: item.tabId })
        if (res && res.ok) {
          let text
          if (values.fields) {
            text = values.fields.map(f => {
              const r = res.fields?.[f.key]
              if (r && r.ok) return `${f.name}: ${r.value !== undefined ? String(r.value) : (r.raw ?? '')}${blockCountsText(r)}`
              return `${f.name}: 失敗：${r?.message || r?.error || '抓取失敗'}`
            }).join('\n')
          } else {
            const val = res.value !== undefined ? String(res.value) : (res.raw ?? '')
            text = `${val}${blockCountsText(res)}`
          }
          if (resultEl) resultEl.textContent = text
        } else if (resultEl) {
          resultEl.textContent = `失敗：${res?.message || res?.error || '抓取失敗'}`
        }
      } catch (e) {
        if (resultEl) resultEl.textContent = `失敗：${e?.message || e}`
      }
    }
  } finally {
    pasteShared(shared)
    setBatchView(true)
    if (btn) {
      btn.textContent = prevText
      btn.disabled = false
    }
    if (saveBtn) saveBtn.disabled = false
  }
}

// ---- 整批改排程（AF-19 作業 C）----

// 切換整批改排程檢視模式
function setBulkView(on) {
  if (!on && !bulkViewOn) return
  bulkViewOn = on
  if (!on) {
    bulkTaskIds = null
    bulkCount = 0
  }
  const show = (id, visible) => {
    const el = document.getElementById(id)
    if (el) el.hidden = !visible
  }
  show('bulk-section', on)
  show('schedule-section', true)
  if (on) {
    show('block-section', false)
    show('preview-section', false)
    show('add-to-dashboard', false)
    show('advanced-section', false)
    show('repick-target', false)
    show('test-now', false)
    show('batch-section', false)
  } else {
    show('add-to-dashboard', true)
    show('preview-section', true)
    show('advanced-section', true)
    show('repick-target', true)
    show('test-now', true)
  }
  const header = document.querySelector('[data-picker-header]')
  if (header) header.hidden = on
  const pinLabel = document.getElementById('pin-defaults')?.closest('label')
  if (pinLabel) pinLabel.hidden = on
  const save = document.getElementById('save')
  if (save) {
    save.textContent = on ? `套用到 ${bulkCount} 個任務` : '儲存'
    save.hidden = false
  }
  const errorsEl = document.getElementById('errors')
  const host = on ? document.getElementById('bulk-section') : document.getElementById('preview-section')
  if (errorsEl && host && errorsEl.parentNode !== host) {
    if (on) host.appendChild(errorsEl)
    else document.getElementById('preview')?.after(errorsEl)
  }
}

// 正規化排程物件以利比較多個任務的排程是否相同
function normalizeSchedule(s) {
  if (!s) return null
  const type = s.type || 'daily'
  const weekdays = Array.isArray(s.weekdays) ? Array.from(new Set(s.weekdays.map(Number))).sort((a, b) => a - b) : []
  if (type === 'daily') {
    const times = Array.isArray(s.times) ? Array.from(new Set(s.times)).sort() : []
    return { type, times, weekdays }
  }
  const res = {
    type: 'interval',
    everyMinutes: s.everyMinutes,
    weekdays
  }
  const hasWindow = s.window && typeof s.window.from === 'string' && s.window.from.trim() !== '' &&
    typeof s.window.to === 'string' && s.window.to.trim() !== ''
  if (hasWindow) {
    res.window = { from: s.window.from.trim(), to: s.window.to.trim() }
  }
  return res
}

// 繪製整批改排程檢視
async function renderBulk(ctx) {
  const allTasks = await getTasks()
  const idSet = new Set(ctx.taskIds)
  const found = allTasks.filter(t => idSet.has(t.id))
  bulkTaskIds = ctx.taskIds.slice()
  bulkCount = found.length

  if (found.length === 0) {
    setBulkView(true)
    const list = document.getElementById('bulk-list')
    if (list) list.textContent = '找不到要修改的任務（可能已經被刪掉了）。'
    const save = document.getElementById('save')
    if (save) save.hidden = true
    return
  }

  setBulkView(true)
  const list = document.getElementById('bulk-list')
  if (list) {
    list.replaceChildren()
    for (const t of found) {
      const item = document.createElement('div')
      item.textContent = t.name
      list.appendChild(item)
    }
  }

  const titleEl = document.getElementById('picker-title')
  if (titleEl) {
    titleEl.textContent = found.length === 1
      ? `修改「${found[0].name}」的排程`
      : `整批修改 ${found.length} 個任務的排程`
  }

  const norm0 = JSON.stringify(normalizeSchedule(found[0].schedule))
  const allSame = found.every(t => JSON.stringify(normalizeSchedule(t.schedule)) === norm0)
  const noteEl = document.getElementById('bulk-note')
  fillSchedule(found[0].schedule)
  if (allSame) {
    if (noteEl) noteEl.textContent = `這 ${found.length} 個任務目前的排程相同。`
  } else {
    if (noteEl) noteEl.textContent = `所選任務的排程不同，目前顯示的是「${found[0].name}」的；套用後 ${found.length} 個任務都會改成下面的設定。`
  }

  syncScheduleFields()
  syncWindowFields()
  renderTimeChips()
  updateSchedulePreview()

  restoreDraft(ctx.draft)
  setBulkView(true)
}

// 整批改排程存檔
async function handleBulkSave() {
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''
  const busySave = setBusy('save', '套用中…')

  const values = getFormData()
  const validation = validateSchedule(values)
  if (!validation.ok) {
    if (errorsEl) errorsEl.textContent = Object.values(validation.errors).join('\n')
    busySave()
    return
  }

  const schedule = buildSchedule(values)
  try {
    const allTasks = await getTasks()
    const idSet = new Set(bulkTaskIds)
    const live = allTasks.filter(t => idSet.has(t.id))
    const missing = bulkTaskIds.length - live.length
    if (live.length === 0) {
      if (errorsEl) errorsEl.textContent = '這些任務都已經不存在了。'
      busySave()
      return
    }

    const updated = live.map(t => ({ ...t, schedule }))
    await saveTasks(updated)

    let nextRunMs = null
    const enabledTasks = live.filter(t => t.enabled !== false)
    if (globalThis.chrome?.runtime?.sendMessage) {
      try {
        await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
        if (enabledTasks.length > 0) {
          const runs = await chrome.runtime.sendMessage({ type: MSG.GET_NEXT_RUNS })
          for (const t of enabledTasks) {
            const r = runs?.nextRuns?.[t.id]
            if (typeof r === 'number' && (nextRunMs === null || r < nextRunMs)) nextRunMs = r
          }
        }
      } catch {}
    }

    let text
    if (enabledTasks.length === 0) {
      text = `已更新 ${live.length} 個任務的排程。所選任務都停用中，不會排程；到任務頁啟用後才會抓。`
    } else if (nextRunMs !== null) {
      const d = new Date(nextRunMs)
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      text = `已更新 ${live.length} 個任務的排程。下次抓取：${hhmm}`
    } else {
      text = `已更新 ${live.length} 個任務的排程。${describeSchedule(schedule)}`
    }
    if (missing > 0) {
      text += `（${missing} 個已不存在）`
    }

    bulkTaskIds = null
    await showSavedFeedback(live[0], { text })
  } catch (e) {
    if (errorsEl) errorsEl.textContent = `套用失敗：${e?.message || e}`
    busySave()
  }
}

