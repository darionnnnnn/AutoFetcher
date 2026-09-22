// AutoFetcher 工具列 popup 控制器 (SPEC §12.2)
import { getTasks, updateTasks, getHealthMap, getMissedList, getLastValues, getSites } from '../../shared/storage.js'
import { openPanel } from '../../shared/panel.js'
import { MSG } from '../../shared/messages.js'
import { statusTextOf, RED_STATUSES, isRed, isWarn } from '../../shared/record-status.js'
import { setIcon, levelChipOf } from '../icons.js'
import { applySavedTheme } from '../theme-apply.js'
import { seriesIdOf } from '../../shared/series-index.js'
import { computeHealth } from '../../background/health.js'
import { isGap, gapTextOf } from '../../shared/describe.js'
import { describeSchedule, describeTarget, describeField, targetOfTask, EMPTY_GUIDE } from '../../shared/describe.js'

let currentCtx = null

// 數值千分位格式化
function formatValue(raw) {
  if (raw === undefined || raw === null) return '—'
  return typeof raw === 'number' ? raw.toLocaleString() : String(raw)
}

// 時間格式化為本地 HH:mm
function formatTime(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  if (isNaN(d.getTime())) return '—'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 健康紀錄裡站台項目的鍵前綴（與 background/health.js 相同）
const SITE_PREFIX = 'site:'

// 擴充功能內頁的網址（真實環境 getURL 是同步的，await 一個字串照樣拿到字串）
async function extUrl(path) {
  const fn = globalThis.chrome?.runtime?.getURL
  return typeof fn === 'function' ? await chrome.runtime.getURL(path) : path
}

async function openExtPage(path) {
  chrome.tabs.create({ url: await extUrl(path) })
}

function originOf(url) {
  try { return new URL(url).origin } catch { return '' }
}

// 站台的登入頁：有設定站台登入就用它的 loginUrl，否則退回給定的網址
function loginUrlOf(origin, sites, fallback) {
  const site = origin ? sites?.[origin] : null
  return (site && typeof site.loginUrl === 'string' && site.loginUrl) ? site.loginUrl : fallback
}

// 依狀態挑下一步：找不到／解析不出 → 重選目標；登入失敗 → 前往登入頁（AF-21 批次 5）
function nextStepButton(task, status, sites) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'next-step'
  if (status === 'selector_lost' || status === 'parse_error') {
    btn.dataset.action = 'repick'
    btn.textContent = '重選目標'
    // 報表只讀 hash（report.js 的 initFromHash），任務頁依 task 參數捲到那一列並高亮（tasks.js 的 focusTaskRow）
    btn.onclick = () => openExtPage(`ui/report/report.html#view=tasks&task=${encodeURIComponent(task.id)}`)
    return btn
  }
  if (status === 'login_failed') {
    btn.dataset.action = 'go-login'
    btn.textContent = '前往登入頁'
    btn.onclick = () => {
      chrome.tabs.create({ url: loginUrlOf(originOf(task.url), sites, task.url) })
    }
    return btn
  }
  return null
}

// 「知道了」沒有完成時就地說原因：寫在按鈕所在的那一列，不移除按鈕、不做本地重算
// （與空窗列的「知道了」同一套寫法）
function showAckError(reportEl, text) {
  if (!reportEl) return
  let note = reportEl.querySelector('[data-ack-error]')
  if (!note) {
    note = reportEl.ownerDocument.createElement('span')
    note.dataset.ackError = ''
    reportEl.appendChild(note)
  }
  note.textContent = text
  note.hidden = false
}

// 「知道了」：只標指定的 health 項目已讀，燈號由 background 重算；畫面就地更新（紅燈維持紅）
export async function acknowledge(ids, { reportEl = null } = {}) {
  const list = (ids || []).filter(Boolean)
  if (list.length === 0) return
  // 背景沒回應或回 ok:false 時不得靜默、也不得本地重算（畫面會顯示成已知悉，實際沒存成）
  let res
  try {
    res = await markAllSeen(list)
  } catch (e) {
    showAckError(reportEl, `知道了沒有完成：${e?.message || e || '背景沒有回應'}`)
    return
  }
  if (res?.ok === false) {
    showAckError(reportEl, `知道了沒有完成：${res.error || '背景處理失敗'}`)
    return
  }
  if (!currentCtx) return
  const healthMap = { ...(currentCtx.healthMap || {}) }
  for (const id of list) {
    if (healthMap[id]) healthMap[id] = { ...healthMap[id], read: true }
  }
  const health = computeHealth(currentCtx.tasks, healthMap, currentCtx.missed)
  render({ ...currentCtx, healthMap, health })
}

// 「停用這個任務」：不想管的壞任務＝停用它（紅燈只有修好或停用才會消）
export async function disableTask(taskId) {
  await updateTasks([taskId], t => ({ ...t, enabled: false }))
  await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
  if (!currentCtx) return
  const tasks = await getTasks()
  const health = computeHealth(tasks, currentCtx.healthMap, currentCtx.missed)
  render({ ...currentCtx, tasks, health })
}

// 異常項目的「知道了」／「已知悉・尚未修復」區塊；紅項已知悉時可附停用鈕
function appendAckControls(container, id, record, { onDisable } = {}) {
  if (record.read !== true) {
    const ack = document.createElement('button')
    ack.type = 'button'
    ack.className = 'ack'
    ack.dataset.action = 'ack'
    ack.textContent = '知道了'
    ack.onclick = () => acknowledge([id], { reportEl: container })
    container.appendChild(ack)
    return
  }
  if (!RED_STATUSES.includes(record.status)) return
  const note = document.createElement('span')
  note.className = 'ack-note'
  note.textContent = '已知悉・尚未修復'
  container.appendChild(note)
  if (onDisable) {
    const off = document.createElement('button')
    off.type = 'button'
    off.className = 'disable-task btn-danger'
    off.dataset.action = 'disable'
    off.textContent = '停用這個任務'
    off.onclick = onDisable
    container.appendChild(off)
  }
}

// 站台異常列（health 的 site:<origin> 紅燈項目）：popup 開不了 side panel（手勢在網頁分頁），只能提示走右鍵
function renderSiteRow(origin, record, sites) {
  const row = document.createElement('div')
  row.className = 'site-row is-bad'
  row.dataset.origin = origin

  const title = document.createElement('div')
  title.className = 'task-main'
  const name = document.createElement('span')
  name.className = 'task-name'
  name.textContent = `${origin} ${statusTextOf(record.status) || '無法登入'}`
  title.appendChild(name)
  row.appendChild(title)

  if (record.reason) {
    const reason = document.createElement('div')
    reason.className = 'task-sub'
    const span = document.createElement('span')
    span.className = 'task-reason is-bad'
    span.textContent = record.reason
    reason.appendChild(span)
    row.appendChild(reason)
  }

  const hint = document.createElement('div')
  hint.className = 'site-hint'
  hint.textContent = '在登入頁按右鍵 → AutoFetcher → 設定此站台登入'
  row.appendChild(hint)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'next-step'
  go.dataset.action = 'go-login'
  go.textContent = '前往登入頁'
  go.onclick = () => {
    chrome.tabs.create({ url: loginUrlOf(origin, sites, origin) })
  }
  actions.appendChild(go)
  appendAckControls(actions, SITE_PREFIX + origin, record)
  row.appendChild(actions)
  return row
}

// 零任務的三步引導：主要按鈕是最上面那顆「在這個頁面選取」（同一個畫面只留一顆主按鈕）
function renderEmptyGuide() {
  const box = document.createElement('div')
  box.className = 'empty-state empty-guide'
  const lead = document.createElement('p')
  lead.textContent = EMPTY_GUIDE.lead
  box.appendChild(lead)
  const ol = document.createElement('ol')
  for (const s of EMPTY_GUIDE.steps) {
    const li = document.createElement('li')
    li.textContent = s
    ol.appendChild(li)
  }
  box.appendChild(ol)
  const help = document.createElement('a')
  help.href = '#'
  help.className = 'help-link'
  help.dataset.action = 'open-help'
  help.textContent = '使用教學'
  help.onclick = (e) => { e.preventDefault(); openExtPage('ui/help/help.html') }
  box.appendChild(help)
  return box
}

// 畫單一任務列（規格限制：只寫一份函式）
function renderTaskRow(task, { lastValues, nextRuns, healthMap, sites }) {
  const row = document.createElement('div')
  row.className = 'task-row'
  if (task.enabled === false) row.classList.add('disabled')

  // 主要資訊：名稱與最後數值
  const mainDiv = document.createElement('div')
  mainDiv.className = 'task-main'

  const nameSpan = document.createElement('span')
  nameSpan.className = 'task-name'
  // 抓什麼的白話（含略過／排除）與 Picker 摘要卡、任務頁同一份；multi 顯示群組、值型別與來源
  const target = targetOfTask(task)
  nameSpan.textContent = target.mode === 'multi'
    ? `群組：${task.name || task.id || ''}`
    : (task.name || task.id || '')
  if (target.mode === 'block' || target.mode === 'multi') nameSpan.title = describeTarget(target)
  mainDiv.appendChild(nameSpan)

  const valueSpan = document.createElement('span')
  valueSpan.className = 'task-value'
  // 多值任務的最後值記在子序列 id 底下，查父任務永遠是空的；最多列三個，其餘用 +N 帶過
  const fields = Array.isArray(task.fields) ? task.fields : []
  if (fields.length > 0) {
    const detailByKey = new Map((target.fields || []).map(field => [field.key, field]))
    const shown = fields.slice(0, 3)
      .map(f => {
        const field = target.mode === 'multi' ? (detailByKey.get(f.key) || f) : f
        const label = target.mode === 'multi' ? describeField(field) : (f.name || f.key)
        return `${label}: ${formatValue(lastValues?.[seriesIdOf(task.id, f.key)]?.value)}`
      })
    valueSpan.textContent = shown.join('  ') + (fields.length > 3 ? `  +${fields.length - 3}` : '')
  } else {
    valueSpan.textContent = formatValue(lastValues?.[task.id]?.value)
  }
  mainDiv.appendChild(valueSpan)
  row.appendChild(mainDiv)

  // 第二行：狀態 chip＋下次執行時間
  const subDiv = document.createElement('div')
  subDiv.className = 'task-sub'

  const healthInfo = healthMap?.[task.id]
  const isAbnormal = healthInfo && healthInfo.status !== undefined && healthInfo.status !== 'ok'
  // 紅／黃判定只經 record-status.js；列左側的狀態色條與 chip 同一個等級
  const tone = isRed(healthInfo) ? 'bad' : (isWarn(healthInfo) ? 'warn' : '')

  const chip = document.createElement('span')
  if (task.enabled === false) {
    chip.className = 'chip is-off task-paused'
    chip.textContent = '暫停'
  } else if (isAbnormal) {
    chip.className = `chip ${tone === 'bad' ? 'is-bad' : (tone === 'warn' ? 'is-warn' : 'is-off')}`
    chip.textContent = statusTextOf(healthInfo.status) || healthInfo.status
  } else {
    chip.className = 'chip is-ok'
    chip.textContent = '正常'
  }
  subDiv.appendChild(chip)

  const nextSpan = document.createElement('span')
  nextSpan.className = 'task-next'
  nextSpan.textContent = `下次 ${formatTime(nextRuns?.[task.id])}`
  // 只寫一個時刻，久沒用回來看不出這是每天還是每十分鐘一次；
  // 排程白話走 shared/describe.js（與 Picker 摘要卡、任務頁同一份）
  nextSpan.title = describeSchedule(task.schedule)
  subDiv.appendChild(nextSpan)
  row.appendChild(subDiv)

  if (isAbnormal && tone) row.classList.add(`is-${tone}`)

  // 異常原因：黃燈用 --warn-text、紅燈用 --danger-text（以前一律紅字）
  if (isAbnormal && healthInfo.reason) {
    const reasonDiv = document.createElement('div')
    reasonDiv.className = `task-reason${tone ? ` is-${tone}` : ''}`
    reasonDiv.textContent = healthInfo.reason
    reasonDiv.title = healthInfo.reason
    row.appendChild(reasonDiv)
  }

  // 異常任務按鈕：立即重試與開啟頁面
  if (isAbnormal) {
    const actionsDiv = document.createElement('div')
    actionsDiv.className = 'task-actions'

    const retryBtn = document.createElement('button')
    retryBtn.type = 'button'
    retryBtn.className = 'retry'
    setIcon(retryBtn, 'refresh', { text: '立即重試' })
    retryBtn.addEventListener('click', async () => {
      // 每一列只有一個結果位置，重複按就地更新
      const showResult = (text) => {
        let el = row.querySelector('.task-run-result')
        if (!el) {
          el = document.createElement('span')
          el.className = 'task-run-result'
          retryBtn.after(el)
        }
        el.textContent = text
      }
      retryBtn.disabled = true
      try {
        const res = await chrome.runtime.sendMessage({ type: MSG.RUN_TASK, taskId: task.id })
        if (Array.isArray(res?.values) && res.values.length > 0) {
          showResult(res.values.map(v => `${v.name}: ${v.ok ? v.value : (v.error || '失敗')}`).join('  '))
        } else if (res && res.outcome === 'done') {
          showResult(res.value !== null && res.value !== undefined ? `抓到 ${res.value}` : '抓到值')
        } else {
          showResult(`失敗：${res?.error || (res?.status ? statusTextOf(res.status) : '')}`.trim())
        }
      } catch (err) {
        // 訊息通道被拒絕，與 ok:false 是兩條路，兩條都要有字
        showResult('抓取被中斷，請再試一次')
      } finally {
        retryBtn.disabled = false
      }
    })
    actionsDiv.appendChild(retryBtn)

    const openPageBtn = document.createElement('button')
    openPageBtn.type = 'button'
    openPageBtn.className = 'open-page btn-text'
    setIcon(openPageBtn, 'external', { text: '開啟頁面' })
    openPageBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: task.url })
    })
    actionsDiv.appendChild(openPageBtn)

    // 依狀態的下一步排在最前面；其他失敗維持「立即重試」
    const next = nextStepButton(task, healthInfo.status, sites)
    if (next) actionsDiv.insertBefore(next, actionsDiv.firstChild)

    appendAckControls(actionsDiv, task.id, healthInfo, {
      onDisable: task.enabled === false ? null : () => disableTask(task.id)
    })

    row.appendChild(actionsDiv)
  }

  return row
}

// 繪製畫面
export function render(ctx) {
  currentCtx = ctx
  const {
    health = { level: 'off', summary: '' },
    tasks = [],
    lastValues = {},
    nextRuns = {},
    healthMap = {},
    missed = [],
    sites = {}
  } = ctx || {}

  // 1. 燈號摘要文字與顏色類別
  const summaryEl = document.getElementById('status-summary')
  if (summaryEl) summaryEl.textContent = health?.summary || ''

  // 燈號 chip：等級類別（ok／warn／bad／off）＋共用 chip 配色（is-*）；文字與 Report 應用列同一份
  const dotEl = document.getElementById('status-dot')
  if (dotEl) {
    const levelMap = { green: 'ok', yellow: 'warn', red: 'bad', off: 'off' }
    const targetClass = levelMap[health?.level] || 'off'
    const chip = levelChipOf(health?.level)
    const drop = ['ok', 'warn', 'bad', 'off', 'is-ok', 'is-warn', 'is-bad', 'is-off']
    const preserved = dotEl.className.split(/\s+/).filter(c => c && !drop.includes(c))
    preserved.push(targetClass, chip.cls)
    dotEl.className = preserved.join(' ')
    dotEl.textContent = chip.text
  }

  // 2. 清空並填入任務清單
  const taskListEl = document.getElementById('task-list')
  if (taskListEl) {
    taskListEl.textContent = ''
    // 站台異常列在任務之前：站台登不進去，底下的任務都會跟著失敗
    for (const [key, record] of Object.entries(healthMap || {})) {
      if (!key.startsWith(SITE_PREFIX) || !record || !RED_STATUSES.includes(record.status)) continue
      taskListEl.appendChild(renderSiteRow(key.slice(SITE_PREFIX.length), record, sites))
    }
    if (!tasks || tasks.length === 0) {
      taskListEl.appendChild(renderEmptyGuide())
    } else {
      for (const t of tasks) {
        taskListEl.appendChild(renderTaskRow(t, { lastValues, nextRuns, healthMap, sites }))
      }
    }
  }

  // 「全部知道了」：有尚未知悉的異常（任務或站台）才出現
  const ackAllBtn = document.getElementById('ack-all')
  if (ackAllBtn) {
    const unreadIds = unreadAbnormalIds(tasks, healthMap)
    ackAllBtn.hidden = unreadIds.length === 0
    ackAllBtn.onclick = () => acknowledge(unreadAbnormalIds(currentCtx?.tasks, currentCtx?.healthMap), { reportEl: ackAllBtn.parentElement })
  }

  const helpLink = document.getElementById('open-help')
  if (helpLink) {
    helpLink.onclick = (e) => { e?.preventDefault?.(); openExtPage('ui/help/help.html') }
  }

  // 2b. 休眠期間的空窗（interval 的 gap）：只能「知道了」，不可補抓
  renderGaps(taskListEl, Array.isArray(missed) ? missed.filter(isGap) : [], tasks)

  // 3. 綁定按鈕事件
  const toggleAllBtn = document.getElementById('toggle-all')
  if (toggleAllBtn) {
    toggleAllBtn.onclick = async () => {
      await handleToggleAll()
      if (currentCtx) {
        const updatedTasks = await getTasks()
        render({ ...currentCtx, tasks: updatedTasks })
      }
    }
  }

  // 最主要的入口：使用者裝好之後第一件想做的事就是「抓這一頁的東西」。
  // 只靠右鍵選單的話，沒人告訴他要按右鍵（AF-9）
  const pickBtn = document.getElementById('pick-here')
  const pickNote = document.getElementById('pick-here-note')
  if (pickBtn) {
    pickBtn.onclick = async () => {
      if (pickNote) pickNote.textContent = ''
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
        const tab = tabs?.[0]
        // 擴充功能頁、chrome:// 這些注入不進去，要說清楚而不是靜靜失敗
        if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
          if (pickNote) pickNote.textContent = '這個頁面無法選取，請切換到一般網頁再試'
          return
        }
        // 面板要在**這個點擊**裡開：手勢不跨 sendMessage，
        // 轉給 background 代開一定會被 Chrome 擋下（B-0 實測）
        await openPanel(tab.id, 'picker', `tabId=${tab.id}`)
        let res
        try {
          res = await chrome.runtime.sendMessage({
            type: MSG.ENTER_PICK,
            purpose: 'task',
            tabId: tab.id,
            // 一律從最上層開始：iframe 內的目標由選取模式自己往下鑽
            frameId: 0
          })
        } catch (e) {
          // 背景沒接到：說出原因、不關 popup（關了使用者只看到什麼都沒發生）
          if (pickNote) pickNote.textContent = `沒有進入選取模式：${e?.message || e || '背景沒有回應'}`
          return
        }
        if (res?.ok === false) {
          // 被擋（表單填到一半等）時背景已把說明寫在面板上；popup 也要說，而且不關
          if (pickNote) pickNote.textContent = `沒有進入選取模式：${res.error || '側邊面板上有說明，請先處理再試'}`
          return
        }
        if (typeof window !== 'undefined' && window.close) window.close()
      } catch {
        if (pickNote) pickNote.textContent = '這個頁面無法選取，請切換到一般網頁再試'
      }
    }
  }

  const openReportBtn = document.getElementById('open-report')
  if (openReportBtn) {
    if (!openReportBtn.querySelector('svg')) setIcon(openReportBtn, 'external', { text: '開啟報表' })
    openReportBtn.onclick = () => {
      let url = typeof chrome?.runtime?.getURL === 'function'
        ? chrome.runtime.getURL('ui/report/report.html')
        : 'ui/report/report.html'
      if (url && typeof url.then === 'function') {
        url.toString = () => 'chrome-extension://autofetcher/ui/report/report.html'
      }
      chrome.tabs.create({ url })
    }
  }
}

// 空窗提示列：容器接在任務清單後面（沒有就建一個），每次整份重畫
function renderGaps(anchorEl, gaps, tasks) {
  let box = document.getElementById('missed-gaps')
  if (!box) {
    if (!anchorEl?.parentNode) return
    box = document.createElement('div')
    box.id = 'missed-gaps'
    anchorEl.parentNode.insertBefore(box, anchorEl.nextSibling)
  }
  box.textContent = ''
  box.hidden = gaps.length === 0
  const nameOf = new Map((tasks || []).map(t => [t.id, t.name || t.id]))
  for (const g of gaps) {
    const row = document.createElement('div')
    row.className = 'missed-gap'
    row.dataset.taskId = g.taskId
    const text = document.createElement('span')
    text.textContent = `${g.taskName || nameOf.get(g.taskId) || g.taskId}：${gapTextOf(g)} `
    row.appendChild(text)
    const ack = document.createElement('button')
    ack.type = 'button'
    ack.dataset.action = 'ack-gap'
    ack.textContent = '知道了'
    ack.onclick = async () => {
      // 失敗不得靜默、也不移除這一列（移除了使用者以為已處理）
      let res
      try {
        // kind:'gap' 讓背景分得出這是休眠空窗的「知道了」（與錯過補抓的略過不同）
        res = await chrome.runtime.sendMessage({ type: MSG.SKIP_ONE, taskId: g.taskId, slot: g.slot, kind: 'gap' })
      } catch (e) {
        text.textContent = `${g.taskName || nameOf.get(g.taskId) || g.taskId}：知道了沒有完成：${e?.message || e || '背景沒有回應'} `
        return
      }
      if (res?.ok === false) {
        text.textContent = `${g.taskName || nameOf.get(g.taskId) || g.taskId}：知道了沒有完成：${res.error || '背景處理失敗'} `
        return
      }
      row.remove()
      if (!box.firstChild) box.hidden = true
    }
    row.appendChild(ack)
    box.appendChild(row)
  }
}

// 全部暫停 / 恢復
export async function handleToggleAll() {
  const tasks = await getTasks()
  const hasActive = tasks.some(t => t.enabled !== false)
  const nextEnabled = !hasActive
  // 只換 enabled：鎖內對最新任務改，不拿讀到的舊副本整份蓋回去
  await updateTasks(tasks.map(t => t.id), t => ({ ...t, enabled: nextEnabled }))
  chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
}

// 畫面上尚未知悉的異常項目（任務列與站台列），「全部知道了」標的就是這些
function unreadAbnormalIds(tasks, healthMap) {
  const map = healthMap || {}
  const ids = []
  for (const t of tasks || []) {
    const h = map[t?.id]
    if (h && h.status !== undefined && h.status !== 'ok' && h.read !== true) ids.push(t.id)
  }
  for (const [key, h] of Object.entries(map)) {
    if (key.startsWith(SITE_PREFIX) && h && RED_STATUSES.includes(h.status) && h.read !== true) ids.push(key)
  }
  return ids
}

// 把指定項目標成已讀（「全部知道了」用；開 popup 不再自動呼叫，AF-21 批次 5）
export async function markAllSeen(taskIds) {
  return chrome.runtime.sendMessage({ type: MSG.MARK_READ, taskIds })
}

// 取得最後一次 render 的狀態
export function getState() {
  return currentCtx
}

// 讀資料並畫出 popup。開啟時**不**標已讀：使用者還沒看懂就關掉的話，紅燈不能因此消失（AF-21 批次 5）
export async function init() {
  const tasks = await getTasks()
  // UI 一律經 shared/storage，不直接碰 chrome.storage
  const [healthMap, missed, lastValues, sites] = await Promise.all([
    getHealthMap(), getMissedList(), getLastValues(), getSites()
  ])
  const health = computeHealth(tasks, healthMap, missed)

  // 取得 alarms 下次執行時間
  const nextRuns = {}
  if (chrome.alarms?.getAll) {
    const alarms = await chrome.alarms.getAll()
    for (const a of alarms || []) {
      if (a.name?.startsWith('task:')) {
        const parts = a.name.slice(5).split(':')
        const taskId = parts.slice(0, -1).join(':') || parts[0]
        if (taskId && a.scheduledTime) {
          if (!nextRuns[taskId] || a.scheduledTime < nextRuns[taskId]) {
            nextRuns[taskId] = a.scheduledTime
          }
        }
      }
    }
  }

  render({ health, tasks, lastValues, nextRuns, healthMap, missed, sites })
}

// 擴充功能環境下自動初始化
if (typeof document !== 'undefined' && globalThis.chrome?.runtime?.id) {
  applySavedTheme()
  // 行首是括號：前面一定要有分號，否則會被接成 applySavedTheme()(async …)（真實瀏覽器煙霧抓到）
  ;(async () => {
    try {
      await init()
    } catch (err) {
      console.error('AutoFetcher popup 初始化失敗:', err)
    }
  })()
}
