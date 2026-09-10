import { saveTask, getTask, getSettings, saveSettings, getPanelCtx, mergePanelCtx, subscribe
} from '../../shared/storage.js'
import { DEFAULT_HOVER_HOLD_MS, DEFAULT_WAIT_TIMEOUT_MS } from '../../shared/preaction.js'
import { MSG } from '../../shared/messages.js'
import { getLayout, addCard } from '../../shared/layout-store.js'
import { seriesIdOf } from '../../shared/series-index.js'
import { describeSchedule, describeTarget, describeDashboard, POS_TEXT } from '../../shared/describe.js'
import { nextIntervalRun } from '../../shared/schedule-math.js'
import { isAnchorText } from '../../shared/table.js'
import { download } from '../../shared/export.js'

let currentCtx = null
let currentBlock = null
const fieldSpecs = new Map()
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

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
      if (spec.block) item.block = applyPosToBlock({ ...spec.block, aggregate: aggregateValue }, rowPos, colPos)
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
      data.block = applyPosToBlock({
        axis: currentBlock?.axis,
        index: currentBlock?.index,
        headerText: currentBlock?.headerText,
        aggregate: agg
      }, rowPos, colPos)
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
  return {
    row: withPos(cell?.row, rowPos),
    col: withPos(cell?.col, colPos)
  }
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

// `rawHeader` 是選取端附上的顯示用原文（純數值標題的原字），
// **只給畫面看**：進了規格就會被存進 storage、參與規格比對，
// 下一輪又被當成錨點，等於這一輪修掉的問題重新長回來。
function stripRawHeader(part) {
  if (!part || typeof part !== 'object') return part
  const out = {}
  for (const [k, v] of Object.entries(part)) {
    if (k === 'rawHeader') continue
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? stripRawHeader(v) : v
  }
  return out
}

export function buildSpec(values) {
  const spec = { strategy: values.strategy }
  if (values.fields) {
    spec.mode = 'block'
    spec.fields = values.fields.map(f => {
      const item = { key: f.key }
      if (f.cell) item.cell = stripRawHeader(f.cell)
      if (f.block) item.block = stripRawHeader(f.block)
      return item
    })
  } else if (values.block && values.block.cell) {
    spec.mode = 'block'
    spec.block = { cell: stripRawHeader(values.block.cell) }
  } else {
    if (values.mode === 'text') spec.mode = 'text'
    if (values.mode === 'block' && values.block) {
      // extract.js 是看 spec.mode 分派的，少了這一行會落回數值策略鏈、抓到整張表的第一個數字
      spec.mode = 'block'
      spec.block = stripRawHeader(values.block)
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
      // 既有任務有時段就要把開關勾起來，否則欄位藏著、使用者以為沒設定
      const winCb = document.getElementById('window-enabled')
      if (winCb) winCb.checked = true
    }
    if (t.spec?.block) {
      if (t.spec.block.cell) {
        currentBlock = { cell: t.spec.block.cell }
      } else {
        currentBlock = { ...t.spec.block }
      }
      const aggEl = document.getElementById('block-aggregate')
      if (aggEl && t.spec.block.aggregate) aggEl.value = t.spec.block.aggregate
    }
  } else {
    const nameEl = document.getElementById('name')
    if (nameEl && !nameEl.value.trim()) {
      let defaultName = ''
      // 單值儲存格：使用者選的是「成交金額」那一格，名稱就用欄標題。
      // 用整張表的標題（nameHint）或左邊那格的文字（anchor.text）都不是他選的東西。
      const soleCell = (Array.isArray(ctx?.picks) && ctx.picks.length === 1 && ctx.picks[0].cell)
        ? ctx.picks[0].cell
        : null
      const cellName = soleCell ? singleCellName(soleCell) : ''
      if (cellName) {
        defaultName = cellName
      } else if (ctx?.nameHint && String(ctx.nameHint).trim()) {
        defaultName = String(ctx.nameHint).trim()
      } else if (ctx?.locator?.anchor?.text && String(ctx.locator.anchor.text).trim()) {
        defaultName = String(ctx.locator.anchor.text).trim()
      } else if (ctx?.preview !== undefined && ctx?.preview !== null && String(ctx.preview).trim()) {
        defaultName = String(ctx.preview).trim().slice(0, 20)
      }
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
    currentBlock = {
      ...(currentBlock || {}),
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
  const base = colH || rowH
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
    let base
    if (rowH && colH) base = `${rowH} · ${colH}`
    else if (rowH || colH) base = rowH || colH
    else base = suffix ? '值' : `值 ${index + 1}`
    return suffix ? `${base}（${suffix}）` : base
  }
  if (pick?.block) return anchorOnly(pick.block.headerText) || `值 ${index + 1}`
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
// 哪一軸的標題因為是純數值而沒能當錨點：取選取端附上的原文給 describeTarget 說明用。
// 列優先（單列數值表是最常見的形狀），兩軸都被擋下時先講列。
function rawHeaderNoteOf(cell, block) {
  const rowRaw = String(cell?.row?.rawHeader || '').trim()
  const colRaw = String(cell?.col?.rawHeader || '').trim()
  const blockRaw = String(block?.rawHeader || '').trim()
  if (rowRaw) return { rawHeader: rowRaw, rawHeaderAxis: 'row' }
  if (colRaw) return { rawHeader: colRaw, rawHeaderAxis: 'col' }
  if (blockRaw) return { rawHeader: blockRaw, rawHeaderAxis: block?.axis === 'row' ? 'row' : 'col' }
  return {}
}

export function updateSetupSummary() {
  const box = document.getElementById('setup-summary')
  if (!box) return
  const values = getFormData()
  const fieldRows = document.querySelectorAll('#field-list [data-field-row]')

  const targetEl = document.getElementById('summary-target')
  if (targetEl) {
    const first = values.fields?.[0]
    const noteOpts = rawHeaderNoteOf(values.block?.cell || first?.cell,
      values.block?.axis ? values.block : first?.block)
    // 說了「請改用列定位」就要讓使用者到得了那個下拉（它在「抓什麼」區，不是進階區）
    const gotoBtn = document.getElementById('goto-rowpos')
    if (gotoBtn) {
      const axis = noteOpts.rawHeaderAxis === 'col' ? '欄' : '列'
      gotoBtn.hidden = !noteOpts.rawHeader
      gotoBtn.textContent = `去設定「${axis}定位」`
      gotoBtn.dataset.target = noteOpts.rawHeaderAxis === 'col' ? 'col-pos' : 'row-pos'
    }
    targetEl.textContent = describeTarget({
      url: values.url || currentCtx?.url || '',
      mode: values.fields ? 'block' : values.mode,
      fieldCount: fieldRows.length,
      cell: values.block?.cell || first?.cell,
      block: values.block?.axis ? values.block : first?.block,
      rowPos: document.getElementById('row-pos')?.value || '',
      colPos: document.getElementById('col-pos')?.value || '',
      // 純數值標題被判準擋下時，摘要卡要當場說出來（原文只在這裡用，不進規格）
      ...noteOpts
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
  for (const id of ['row-pos', 'col-pos', 'mode', 'block-aggregate']) {
    const el = document.getElementById(id)
    if (el && !el._summaryBound) {
      el.addEventListener('change', () => updateSetupSummary())
      el._summaryBound = true
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
  rows.forEach((r, i) => {
    const upBtn = r.querySelector('[data-field-up]')
    const downBtn = r.querySelector('[data-field-down]')
    if (upBtn) upBtn.disabled = (i === 0)
    if (downBtn) downBtn.disabled = (i === n - 1)
  })

  // 一格就是一個值，沒有東西要聚合；有整欄／整列的值時才需要選聚合方式。
  // 值的數量也決定預設建哪幾張卡，移除／上下移之後都要重算
  const aggLabel = document.getElementById('block-aggregate')?.closest('label')
  if (aggLabel) {
    const blockSpecs = n > 0
      ? rows.map(r => (r._spec || fieldSpecs.get(r.dataset.fieldKey || ''))?.block).filter(Boolean)
      : ((currentBlock && !currentBlock.cell && currentBlock.axis) ? [currentBlock] : [])
    const hasBlockField = n > 0
      ? blockSpecs.length > 0
      : !(currentBlock && currentBlock.cell)
    // 只有「這些聚合真的都被位置取代掉」時才藏聚合下拉。
    // 整欄的位置來自列定位、整列的來自欄定位——看錯一邊就會藏掉還在生效的設定
    const allReplaced = blockSpecs.length > 0 && blockSpecs.every(b =>
      Boolean(b.axis === 'row' ? posValueOf('col-pos') : posValueOf('row-pos')))
    aggLabel.hidden = !hasBlockField || allReplaced
  }
  applyDefaultCardTypes()

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

// 一個值在表格裡的位置說明（「美金 · 買入」／「買入 整欄」）
function fieldWhereText(spec) {
  if (!spec) return ''
  if (spec.cell) {
    const r = spec.cell.row?.header || (spec.cell.row?.pos ? POS_TEXT[spec.cell.row.pos] : '')
    const c = spec.cell.col?.header || (spec.cell.col?.pos ? POS_TEXT[spec.cell.col.pos] : '')
    return [r, c].filter(Boolean).join(' · ')
  }
  if (spec.block) {
    const axis = spec.block.axis === 'row' ? '整列' : '整欄'
    return spec.block.headerText ? `${spec.block.headerText} ${axis}` : axis
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
    let next = ''
    if (style === 'col') {
      next = spec?.cell?.col?.header || spec?.block?.headerText || ''
    } else {
      next = fieldWhereText(spec)
    }
    if (!next) continue
    input.value = next
    input._afAutoName = next
  }
  updateAlertRowsFields()
  updateSetupSummary()
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
  row.appendChild(whereEl)
  row.appendChild(resultEl)
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

export async function handleSave() {
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
  try {
  const task = buildTask(values, currentCtx?.locator, currentCtx?.task, currentCtx?.frameUrl ? { url: currentCtx.frameUrl } : undefined)
  await saveTask(task)
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

  } catch (e) {
    if (errorsEl) errorsEl.textContent = `儲存失敗：${e?.message || e}`
    return
  } finally {
    busySave()
  }
  await showSavedFeedback(savedTask, { nextRunMs: savedNextRun })
}

/**
 * 儲存成功之後不要無聲關窗：說出「存好了、下次什麼時候抓」，
 * 並給一條去看結果的路。1.5 秒後自動關，使用者也可以自己點。
 */
export async function showSavedFeedback(task, { nextRunMs = null, closeDelayMs = 1500 } = {}) {
  const form = document.getElementById('picker-form')
  if (!form || !task) return
  let when = ''
  if (nextRunMs) {
    const d = new Date(nextRunMs)
    when = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const box = document.createElement('div')
  box.id = 'saved-feedback'
  box.setAttribute('role', 'status')
  const line = document.createElement('div')
  // 問不到實際 alarm 就退回白話句，不要讓這裡空著
  line.textContent = when
    ? `已儲存。下次抓取：${when}`
    : `已儲存。${describeSchedule(task.schedule)}`
  box.appendChild(line)

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
    if (typeof window !== 'undefined' && window.close) window.close()
  })
  box.appendChild(openBtn)

  form.replaceChildren(box)
  if (typeof setTimeout === 'function') {
    // 記住是「哪一個視窗」：延遲期間全域的 window 可能已經換人，
    // 關掉別人的視窗比不關還糟
    const myWindow = typeof window !== 'undefined' ? window : null
    setTimeout(() => {
      // 面板沒有 window.close()：請 background 關它，並清掉草稿——
      // 不清的話下一個新任務會被這一個的名稱與排程灌進去
      if (globalThis.chrome?.sidePanel) {
        finishPanelSession()
        return
      }
      if (myWindow && globalThis.window === myWindow && myWindow.close) myWindow.close()
    }, closeDelayMs)
  }
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

export async function handleTestNow() {
  const previewEl = document.getElementById('preview')
  const errorsEl = document.getElementById('errors')
  if (errorsEl) errorsEl.textContent = ''
  const noteAtStart = document.getElementById('test-note')
  if (noteAtStart) noteAtStart.textContent = ''
  // 這一次的結果還沒出來，上一次的診斷先收起來
  setDiagAvailable(null)
  const busy = setBusy('test-now', '測試中…')

  const values = getFormData()
  if (!values.url && currentCtx?.url) values.url = currentCtx.url
  // buildTask 內部會呼叫 buildSpec(values) 組出規格
  const task = buildTask(values, currentCtx?.locator, currentCtx?.task, currentCtx?.frameUrl ? { url: currentCtx.frameUrl } : undefined)
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
            return `${f.name}: ${val}`
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
        if (previewEl) previewEl.textContent = res.value !== undefined ? String(res.value) : (res.raw ?? '')
      }
      if (errorsEl) errorsEl.textContent = ''
      setPreviewState('ok')
      // 這次測試是在使用者眼前這個分頁跑的，iframe 已經開著；排程是開新分頁，
      // 兩者會不一樣，成功不代表排程也會成功
      const noPreActions = !Array.isArray(values.preActions) || values.preActions.length === 0
      const noteEl = document.getElementById('test-note')
      if (noteEl && Array.isArray(res.preActionTrace) && res.preActionTrace.length > 0) {
        // 調 hover 選單時最需要知道的是「hover 有做、是 click 沒點到」還是「hover 就失敗」，
        // 只回一句「成功」等於什麼都沒說
        const total = res.preActionTrace.reduce((sum, step) => sum + (Number(step.ms) || 0), 0)
        noteEl.textContent = `前置動作 ${res.preActionTrace.length} 步完成（共 ${(total / 1000).toFixed(1)} 秒）`
      } else if (noteEl && currentCtx?.frameUrl && noPreActions) {
        noteEl.textContent = '這次測試在目前分頁執行；排程會開新分頁，若那個框架要先點才會出現，請加入前置動作。'
      }
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
    }
  } catch (e) {
    const err = e?.message || '找不到目標元素'
    if (errorsEl) errorsEl.textContent = err
    if (previewEl) previewEl.textContent = '—'
    setPreviewState('error')
  } finally {
    busy()
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
export async function renderFromPanelCtx(ctx) {
  const sig = ctx ? JSON.stringify({ kind: ctx.kind, ctx: ctx.ctx, taskId: ctx.taskId, retarget: ctx.retarget }) : 'null'
  if (sig === lastPanelSig) return { rendered: false }
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
  if (kind === 'waiting' || !ctx) return { rendered: true }

  if (kind === 'edit' && ctx.taskId) {
    const task = await getTask(ctx.taskId)
    if (!task) return { rendered: false }
    render({ task, locator: task.locator, url: task.url })
    const testNow = document.getElementById('test-now')
    if (testNow) testNow.hidden = true
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
  render(payload)
  restoreDraft(keep, { skipTarget: true })
  const note = document.getElementById('retarget-note')
  if (note) {
    note.hidden = false
    note.textContent = '已換成新的目標，其他設定都留著。'
  }
}

// 要跨「換目標」與「面板重載」保住的欄位（鍵一律是元素 id，restoreDraft 靠它還原）
const DRAFT_FIELDS = [
  'name', 'schedule-type', 'interval-value', 'interval-unit', 'daily-time',
  'agg', 'row-pos', 'col-pos', 'dashboard-select', 'regex', 'multiplier', 'decimals'
]

/**
 * 把畫面上的表單值抄成 `{元素 id: 值}`。
 */
function snapshotForm() {
  const out = {}
  for (const id of DRAFT_FIELDS) {
    const el = document.getElementById(id)
    if (!el) continue
    out[id] = el.type === 'checkbox' ? el.checked : el.value
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
}

/**
 * 表單值變動就寫回草稿（節流）。
 */
/**
 * 存檔或取消後的收尾：清掉草稿並請 background 關面板。
 * 不清草稿的話，下一個新任務會被上一個的名稱與排程灌進去。
 */
async function finishPanelSession() {
  if (panelTabId === null) return
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
  try { await chrome.runtime.sendMessage({ type: MSG.CLOSE_PANEL, tabId: panelTabId }) } catch {}
}

function scheduleDraftSave() {
  if (panelTabId === null) return
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(async () => {
    draftTimer = null
    try { await mergePanelCtx(panelTabId, { draft: snapshotForm() }) } catch {}
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
}

if (typeof document !== 'undefined' && document.getElementById('save') && globalThis.chrome?.runtime?.id) {
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
