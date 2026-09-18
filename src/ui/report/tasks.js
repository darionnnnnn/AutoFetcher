import { getTask, saveTasks, deleteTasks, getTasks, countRecordsForTasks, listDates, setPanelCtx } from '../../shared/storage.js'
import { openPanel } from '../../shared/panel.js'
import { MSG } from '../../shared/messages.js'
import { buildExport, download } from '../../shared/export.js'
import { describeSchedule, describeTarget, targetOfTask, exclusionOfTarget } from '../../shared/describe.js'

let currentTasks = []
let currentHealth = {}
let currentMissed = []
let currentCtx = {}
const selectedIds = new Set()
let lastPickedId = null
let renaming = null
let isSavingRename = false
// 改名中又按了另一列的「改名」：上一列失焦存檔會整份重畫，那顆按鈕節點跟著被換掉、click 不會來；
// 在 pointerdown（比 blur 早）先記下意圖，存檔完成後兌現
let pendingRenameId = null
// 整批刪除對話框是依哪一組選取開的（單列刪除為 null）；選取一變就收掉，確認鈕刪的永遠是訊息說的那幾個
let dialogSelectionSig = null
const selectionSig = () => [...selectedIds].sort().join('|')

// 純函式：依關鍵字與健康狀態篩選任務
export function filterTasks(tasks, { q, failedOnly } = {}, health = {}) {
  if (!Array.isArray(tasks)) return []
  const query = typeof q === 'string' ? q.trim().toLowerCase() : ''
  const healthMap = health && typeof health === 'object' ? health : {}

  return tasks.filter((t) => {
    if (!t) return false

    if (query) {
      const name = (t.name || '').toLowerCase()
      const url = (t.url || '').toLowerCase()
      if (!name.includes(query) && !url.includes(query)) {
        return false
      }
    }

    if (failedOnly) {
      const h = healthMap[t.id]
      if (!h || h.status === 'ok') {
        return false
      }
    }

    return true
  })
}

// 純函式：複製任務，產生新 id、名稱加副本、預設停用，移除 notFoundStreak 與 order
export function duplicateTask(task) {
  const copy = { ...task }
  copy.id = crypto.randomUUID()
  copy.name = `${task?.name || ''}(副本)`
  copy.enabled = false
  delete copy.notFoundStreak
  delete copy.order
  return copy
}

// 依 id 陣列順序重新編號 order 並存入 storage
export async function applyOrder(ids) {
  if (!Array.isArray(ids)) return
  const tasks = await getTasks()
  const map = new Map(tasks.map(t => [t.id, t]))
  const toUpdate = []
  let nextOrder = 0
  for (const id of ids) {
    const t = map.get(id)
    if (t) {
      toUpdate.push({ ...t, order: nextOrder++ })
    }
  }
  if (toUpdate.length > 0) {
    await saveTasks(toUpdate)
  }
}

// 開啟刪除確認對話框並計算關聯紀錄數
async function openDeleteDialog(ids, fromSelection = false) {
  if (!Array.isArray(ids) || ids.length === 0) return
  const dlg = document.getElementById('task-delete-dialog')
  if (!dlg) return
  dialogSelectionSig = fromSelection ? selectionSig() : null

  const { total } = await countRecordsForTasks(ids)
  const count = total || 0

  let msgText = ''
  if (ids.length === 1) {
    const taskObj = currentTasks.find((t) => t.id === ids[0])
    const taskName = taskObj?.name || ids[0]
    msgText = `確定要刪除「${taskName}」嗎？此操作將一併刪除 ${count} 筆歷史紀錄。`
  } else {
    msgText = `確定要刪除這 ${ids.length} 個任務嗎？此操作將一併刪除合計 ${count} 筆歷史紀錄。`
  }

  const msgEl = dlg.querySelector('.dialog-message')
  if (msgEl) {
    msgEl.textContent = msgText
  } else {
    let p = dlg.querySelector('p')
    if (!p) {
      p = document.createElement('p')
      dlg.prepend(p)
    }
    p.textContent = msgText
  }

  dlg.hidden = false

  const cancelBtn = dlg.querySelector('[data-action="cancel"]')
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      dlg.hidden = true
    }
  }

  const confirmBtn = dlg.querySelector('[data-action="confirm"]')
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      await deleteTasks(ids)
      for (const id of ids) {
        selectedIds.delete(id)
      }
      dlg.hidden = true
      const remaining = await getTasks()
      renderTasks(remaining, currentHealth, currentMissed, currentCtx)
    }
  }

  const exportBtn = dlg.querySelector('[data-action="export-then-delete"]')
  if (exportBtn) {
    exportBtn.onclick = async () => {
      const d = new Date()
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      const today = `${y}-${m}-${day}`
      // 匯出範圍從最舊的紀錄日起算（重構後 dates 不再由外層提供，改在此取得）
      const dates = await listDates()
      const from = dates[0] || today
      const to = today

      // 下載沒成功（使用者在另存視窗按取消、配額）就不刪：說出來，對話框留著讓他改選「確定刪除」或取消
      try {
        const exp = await buildExport({ from, to, format: 'csv' })
        await download(exp)
      } catch (e) {
        if (msgEl) msgEl.textContent = `${msgText}匯出沒有完成（${e?.message || e}），所以還沒有刪除。`
        return
      }
      await deleteTasks(ids)
      for (const id of ids) {
        selectedIds.delete(id)
      }
      dlg.hidden = true
      const remaining = await getTasks()
      renderTasks(remaining, currentHealth, currentMissed, currentCtx)
    }
  }
}

// 整批切換選取任務的啟用狀態並重建排程
async function setBulkEnabled(enabled) {
  const bar = document.getElementById('task-bulk-bar')
  const buttons = bar ? bar.querySelectorAll('button') : []
  const actionBtn = bar ? bar.querySelector(`[data-action="bulk-${enabled ? 'enable' : 'disable'}"]`) : null
  const origText = actionBtn ? actionBtn.textContent : ''

  buttons.forEach((btn) => { btn.disabled = true })
  if (actionBtn) {
    actionBtn.textContent = enabled ? '啟用中…' : '停用中…'
  }

  try {
    const tasks = await getTasks()
    const targetTasks = tasks.filter((t) => selectedIds.has(t.id))
    const updated = targetTasks.map((t) => ({ ...t, enabled }))
    if (updated.length > 0) {
      await saveTasks(updated)
      await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
    }
    const note = document.getElementById('task-note')
    if (note) {
      note.textContent = `已${enabled ? '啟用' : '停用'} ${updated.length} 個任務。`
    }
    const freshTasks = await getTasks()
    renderTasks(freshTasks, currentHealth, currentMissed, currentCtx)
  } catch (e) {
    // 整批寫入是全有全無（saveTasks 先驗證再寫）：失敗就是一個都沒改，要說出來，不能靜默
    const note = document.getElementById('task-note')
    if (note) note.textContent = `${enabled ? '啟用' : '停用'}失敗，沒有任何任務被改動：${e?.message || e}`
  } finally {
    buttons.forEach((btn) => { btn.disabled = false })
    if (actionBtn) {
      actionBtn.textContent = origText
    }
  }
}

// 開啟側邊面板以整批修改排程
async function openBulkSchedule(ids) {
  let tabId
  try { tabId = (await chrome.tabs.getCurrent())?.id } catch {}
  if (tabId === undefined) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = tabs?.[0]?.id
  }
  if (tabId === undefined) {
    const note = document.getElementById('task-note')
    if (note) note.textContent = '找不到這個報表所在的分頁，開不了設定面板；請重新整理這一頁再試。'
    return
  }
  await setPanelCtx(tabId, { kind: 'bulk', taskIds: ids })
  await openPanel(tabId, 'picker')
}

// 儲存任務就地改名的結果
async function saveRename(id, val) {
  if (isSavingRename) return
  isSavingRename = true
  try {
    const trimmed = (val || '').trim()
    if (!trimmed) {
      const note = document.getElementById('task-note')
      if (note) {
        note.textContent = '名稱不能空白。'
      }
      return
    }
    const cur = await getTask(id)
    if (!cur) {
      renaming = null
      renderListRows()
      return
    }
    await saveTasks([{ ...cur, name: trimmed }])
    renaming = null
    const fresh = await getTasks()
    // 存檔前使用者已經按了另一列的「改名」：接著開那一列
    const next = pendingRenameId && fresh.find((x) => x.id === pendingRenameId)
    pendingRenameId = null
    if (next) renaming = { id: next.id, value: next.name || '' }
    renderTasks(fresh, currentHealth, currentMissed, currentCtx)
  } finally {
    isSavingRename = false
  }
}

// 更新多選工具列與全選勾選框的狀態
function updateSelectionUI() {
  const taskList = document.getElementById('task-list')
  const visibleRows = taskList ? [...taskList.querySelectorAll('[data-task-id]')] : []
  const visibleIds = visibleRows.map((r) => r.dataset.taskId)

  for (const row of visibleRows) {
    const id = row.dataset.taskId
    const box = row.querySelector('[data-action="select"]')
    const isSelected = selectedIds.has(id)
    if (box) box.checked = isSelected
    row.classList.toggle('selected', isSelected)
  }

  const selectAll = document.getElementById('task-select-all')
  if (selectAll) {
    const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length
    if (visibleIds.length > 0 && selectedVisibleCount === visibleIds.length) {
      selectAll.checked = true
      selectAll.indeterminate = false
    } else if (selectedVisibleCount > 0) {
      selectAll.checked = false
      selectAll.indeterminate = true
    } else {
      selectAll.checked = false
      selectAll.indeterminate = false
    }
  }

  const dlg = document.getElementById('task-delete-dialog')
  if (dlg && !dlg.hidden && dialogSelectionSig !== null && dialogSelectionSig !== selectionSig()) {
    dlg.hidden = true
    dialogSelectionSig = null
    const note = document.getElementById('task-note')
    if (note) note.textContent = '選取已經變了，刪除確認已收起；要刪除請再按一次「刪除」。'
  }

  const bulkBar = document.getElementById('task-bulk-bar')
  if (bulkBar) {
    if (selectedIds.size === 0) {
      bulkBar.hidden = true
    } else {
      bulkBar.hidden = false
      const hiddenCount = [...selectedIds].filter((id) => !visibleIds.includes(id)).length
      let text = `已選 ${selectedIds.size} 個`
      if (hiddenCount > 0) {
        text += `（${hiddenCount} 個不在目前篩選中）`
      }
      const countEl = bulkBar.querySelector('[data-bulk-count]')
      if (countEl) countEl.textContent = text
    }
  }
}

// 重新渲染任務清單的每一列並同步選取與焦點狀態
function renderListRows() {
  const taskList = document.getElementById('task-list')
  if (!taskList) return

  const activeRenameInput = taskList.querySelector('input[data-rename-input]')
  if (activeRenameInput && renaming) {
    renaming.value = activeRenameInput.value
  }

  taskList.textContent = ''
  const searchInput = document.getElementById('task-search')
  const failedCheckbox = document.getElementById('task-failed-only')
  const q = searchInput ? searchInput.value : ''
  const failedOnly = failedCheckbox ? failedCheckbox.checked : false
  const filtered = filterTasks(currentTasks, { q, failedOnly }, currentHealth)

  for (const t of filtered) {
    taskList.appendChild(createTaskRow(t))
  }

  if (renaming) {
    const inputEl = taskList.querySelector('input[data-rename-input]')
    if (inputEl) {
      try {
        inputEl.focus()
        const len = inputEl.value.length
        inputEl.setSelectionRange(len, len)
      } catch {}
    }
  }

  updateSelectionUI()
}

// 建立單一任務列元素
const AGGREGATE_TEXT = { max: '最大值', min: '最小值', avg: '平均', sum: '加總', count: '筆數' }

// 描述抓取模式；區塊任務要看得出取哪一欄／列與聚合方式
function describeMode(t) {
  const mode = t.mode || 'number'
  const block = t.spec?.block
  if (mode !== 'block' || !block) return mode

  const axisText = block.axis === 'row' ? '列' : '欄'
  // index 是 0 起算，顯示給人看用 1 起算
  const target = block.headerText
    ? `「${block.headerText}」`
    : (Number.isFinite(Number(block.index)) ? `第 ${Number(block.index) + 1} ${axisText}` : `某一${axisText}`)
  const agg = AGGREGATE_TEXT[block.aggregate] || block.aggregate || '加總'
  return `區塊 ${target}${block.headerText ? `這一${axisText}` : ''} ${agg}`
}

function createTaskRow(t) {
  const row = document.createElement('div')
  row.className = 'task-row'
  row.dataset.taskId = t.id

  const selectBox = document.createElement('input')
  selectBox.type = 'checkbox'
  selectBox.dataset.action = 'select'
  selectBox.setAttribute('aria-label', `選取「${t.name || t.id}」`)
  selectBox.checked = selectedIds.has(t.id)
  selectBox.addEventListener('click', (e) => {
    const taskList = document.getElementById('task-list')
    const visibleRows = taskList ? [...taskList.querySelectorAll('[data-task-id]')] : []
    const visibleIds = visibleRows.map((r) => r.dataset.taskId)
    const isShift = e.shiftKey && lastPickedId !== null && visibleIds.includes(lastPickedId)
    const nextState = !selectedIds.has(t.id)

    if (isShift) {
      const lastIdx = visibleIds.indexOf(lastPickedId)
      const curIdx = visibleIds.indexOf(t.id)
      const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx]
      const rangeIds = visibleIds.slice(start, end + 1)
      if (nextState) {
        for (const id of rangeIds) {
          selectedIds.add(id)
        }
      } else {
        for (const id of rangeIds) {
          selectedIds.delete(id)
        }
      }
    } else {
      if (nextState) {
        selectedIds.add(t.id)
      } else {
        selectedIds.delete(t.id)
      }
    }
    lastPickedId = t.id
    updateSelectionUI()
  })
  row.appendChild(selectBox)

  if (selectedIds.has(t.id)) {
    row.classList.add('selected')
  }

  const toggleLabel = document.createElement('label')
  toggleLabel.className = 'task-toggle-label'
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.dataset.action = 'toggle'
  toggle.checked = t.enabled !== false
  toggle.addEventListener('change', async () => {
    const current = await getTask(t.id)
    if (current) {
      current.enabled = toggle.checked
      await saveTasks([current])
      await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
    }
  })
  toggleLabel.appendChild(toggle)
  row.appendChild(toggleLabel)

  if (renaming && renaming.id === t.id) {
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.dataset.renameInput = ''
    nameInput.setAttribute('aria-label', '任務名稱')
    nameInput.value = renaming.value
    nameInput.addEventListener('pointerdown', (e) => e.stopPropagation())
    nameInput.addEventListener('click', (e) => e.stopPropagation())
    nameInput.addEventListener('input', () => {
      if (renaming && renaming.id === t.id) {
        renaming.value = nameInput.value
      }
    })
    nameInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        await saveRename(t.id, nameInput.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        renaming = null
        renderListRows()
      }
    })
    nameInput.addEventListener('blur', async () => {
      if (!renaming || renaming.id !== t.id) return
      await saveRename(t.id, nameInput.value)
    })
    row.appendChild(nameInput)
  } else {
    const nameEl = document.createElement('span')
    nameEl.className = 'task-name'
    nameEl.textContent = t.name || t.id
    row.appendChild(nameEl)
  }

  const renameBtn = document.createElement('button')
  renameBtn.type = 'button'
  renameBtn.dataset.action = 'rename'
  renameBtn.textContent = '改名'
  renameBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
    if (renaming && renaming.id !== t.id) pendingRenameId = t.id
  })
  renameBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    // 另一列還在改名（沒有失焦存檔就點過來）：先把那一列存掉，畫面上同時只會有一個輸入框
    if (renaming && renaming.id !== t.id) {
      const prevInput = document.querySelector('#task-list input[data-rename-input]')
      pendingRenameId = null
      await saveRename(renaming.id, prevInput ? prevInput.value : renaming.value)
      if (renaming && renaming.id !== t.id) return
    }
    renaming = { id: t.id, value: t.name || '' }
    renderListRows()
    const curInput = document.querySelector('#task-list input[data-rename-input]')
    if (curInput) {
      try {
        curInput.focus()
        // 剛按「改名」＝全選原值（直接打字就取代）；重畫時還原的是打到一半的字，那時才把游標放結尾
        curInput.select()
      } catch {}
    }
  })
  row.appendChild(renameBtn)

  if (Array.isArray(t.fields) && t.fields.length > 0) {
    const fieldsEl = document.createElement('span')
    fieldsEl.className = 'task-fields'
    const fieldNames = t.fields.map(f => (f && f.name) ? f.name : (f?.key || '')).filter(Boolean)
    let text = ''
    if (t.fields.length > 3) {
      text = `${fieldNames.slice(0, 3).join('、')} 等 ${t.fields.length} 個值`
    } else {
      text = fieldNames.join('、')
    }
    fieldsEl.textContent = text
    row.appendChild(fieldsEl)
  }

  const urlEl = document.createElement('span')
  urlEl.className = 'task-url'
  urlEl.textContent = t.url || ''
  row.appendChild(urlEl)

  const modeEl = document.createElement('span')
  modeEl.className = 'task-mode'
  // 模式欄維持原本的短字；有略過／排除時接上 describe.js 的那一段，完整白話句放 title（與 Picker 摘要卡同一份）
  const target = targetOfTask(t)
  modeEl.textContent = describeMode(t) + exclusionOfTarget(target)
  // 只給區塊任務：數值／文字任務的完整句（「抓 a.test 頁面上的數字」）沒有新資訊，
  // 而且列上的 title 已經有人用（連續失敗的最後錯誤放在 title）
  if (target.mode === 'block') modeEl.title = describeTarget(target)
  row.appendChild(modeEl)

  // 有設告警 / 前置動作的任務要一眼看得出來，否則只能逐一點進去看
  const activeAlerts = Array.isArray(t.alerts) ? t.alerts.filter((a) => a && a.enabled !== false) : []
  if (activeAlerts.length > 0) {
    const alertEl = document.createElement('span')
    alertEl.className = 'task-alerts'
    alertEl.textContent = `🔔 ${activeAlerts.length}`
    alertEl.title = `${activeAlerts.length} 條告警條件`
    row.appendChild(alertEl)
  }

  if (Array.isArray(t.preActions) && t.preActions.length > 0) {
    const preEl = document.createElement('span')
    preEl.className = 'task-preactions'
    preEl.textContent = `前置 ${t.preActions.length}`
    preEl.title = `抓取前會先執行 ${t.preActions.length} 個動作`
    row.appendChild(preEl)
  }

  const scheduleBtn = document.createElement('button')
  scheduleBtn.type = 'button'
  scheduleBtn.className = 'task-link task-schedule'
  scheduleBtn.dataset.action = 'edit-schedule'
  scheduleBtn.title = '修改排程'
  // 排程白話一律走 shared/describe.js（Picker 摘要卡與 popup 也用同一份，
  // 各寫一份會讓同一個任務在三個畫面上長得不一樣）
  scheduleBtn.textContent = describeSchedule(t.schedule)
  scheduleBtn.addEventListener('click', async () => {
    await openBulkSchedule([t.id])
  })
  row.appendChild(scheduleBtn)

  const nextEl = document.createElement('span')
  nextEl.className = 'task-next'
  const nextVal = currentCtx?.nextRuns?.[t.id]
  nextEl.textContent = nextVal ? new Date(nextVal).toLocaleString() : '—'
  row.appendChild(nextEl)

  const healthInfo = currentHealth?.[t.id]
  const statusEl = document.createElement('span')
  statusEl.className = 'task-status'
  statusEl.textContent = healthInfo?.status || 'ok'
  if (healthInfo && healthInfo.reason) {
    statusEl.setAttribute('title', healthInfo.reason)
  }
  row.appendChild(statusEl)

  if (typeof t.notFoundStreak === 'number' && t.notFoundStreak > 0) {
    const streakEl = document.createElement('span')
    streakEl.className = 'task-streak'
    streakEl.textContent = `連續失敗 ${t.notFoundStreak} 次`
    row.appendChild(streakEl)
  }

  if (t.suggestForeground === true && !t.foreground) {
    const suggestEl = document.createElement('span')
    suggestEl.className = 'task-suggest-foreground'
    suggestEl.textContent = '連續抓不到，建議改用前景抓取'

    const useFgBtn = document.createElement('button')
    useFgBtn.type = 'button'
    useFgBtn.dataset.action = 'use-foreground'
    useFgBtn.textContent = '改用前景抓取'
    useFgBtn.addEventListener('click', async () => {
      const current = await getTask(t.id)
      if (current) {
        current.foreground = true
        await saveTasks([current])
        const idx = currentTasks.findIndex((taskItem) => taskItem.id === t.id)
        if (idx !== -1) {
          currentTasks[idx] = current
        }
        const updated = await getTask(t.id)
        const newRow = createTaskRow(updated || current)
        row.replaceWith(newRow)
      }
    })
    suggestEl.appendChild(useFgBtn)
    row.appendChild(suggestEl)
  }

  const actionsEl = document.createElement('div')
  actionsEl.className = 'task-actions'

  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.dataset.action = 'run'
  runBtn.textContent = '立即抓取'
  runBtn.addEventListener('click', async () => {
    // 每一列只有一個結果位置，重複按就地更新
    const showResult = (msg) => {
      let el = row.querySelector('.task-run-result')
      if (!el) {
        el = document.createElement('span')
        el.className = 'task-run-result'
        runBtn.after(el)
      }
      el.textContent = msg
    }
    runBtn.disabled = true
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.RUN_TASK, taskId: t.id })
      if (Array.isArray(res?.values) && res.values.length > 0) {
        // 多值任務逐值回報，只說一個數字看不出其他值怎麼了
        showResult(res.values
          .map(v => `${v.name}: ${v.ok ? v.value : (v.error || '失敗')}`)
          .join('  '))
      } else if (res && res.outcome === 'done') {
        showResult(res.value !== null && res.value !== undefined ? `抓到 ${res.value}` : '抓到值')
      } else {
        showResult(`失敗：${res?.error || res?.status || ''}`.trim())
      }
    } catch (err) {
      showResult(`失敗：${err?.message || String(err)}`)
    } finally {
      runBtn.disabled = false
    }
  })
  actionsEl.appendChild(runBtn)

  const editBtn = document.createElement('button')
  editBtn.type = 'button'
  editBtn.dataset.action = 'edit'
  editBtn.textContent = '編輯'
  editBtn.addEventListener('click', async () => {
    // 新增與編輯用同一個載體（面板）：以前編輯是另開一個普通分頁，
    // 「保持在最上層」對分頁根本不適用。網址參數不能用（面板重載會丟掉），走 session。
    // 擴充功能頁問自己在哪個分頁用 getCurrent（查作用分頁在切換競態下會拿到別人的）
    let tabId
    try { tabId = (await chrome.tabs.getCurrent())?.id } catch {}
    if (tabId === undefined) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      tabId = tabs?.[0]?.id
    }
    if (tabId === undefined) return
    await setPanelCtx(tabId, { kind: 'edit', taskId: t.id })
    await openPanel(tabId, 'picker', `taskId=${encodeURIComponent(t.id)}`)
  })
  actionsEl.appendChild(editBtn)

  const dupBtn = document.createElement('button')
  dupBtn.type = 'button'
  dupBtn.dataset.action = 'duplicate'
  dupBtn.textContent = '複製'
  dupBtn.addEventListener('click', async () => {
    const copy = duplicateTask(t)
    await saveTasks([copy])
    const freshTasks = await getTasks()
    renderTasks(freshTasks, currentHealth, currentMissed, currentCtx)
  })
  actionsEl.appendChild(dupBtn)

  const repickBtn = document.createElement('button')
  repickBtn.type = 'button'
  repickBtn.dataset.action = 'repick'
  repickBtn.textContent = '重選'
  repickBtn.addEventListener('click', async () => {
    let res = null
    try {
      res = await chrome.runtime.sendMessage({
        type: MSG.ENTER_PICK,
        taskId: t.id,
        purpose: 'repick'
      })
    } catch {}

    const note = document.getElementById('task-note')
    if (note) {
      if (res && res.ok) {
        note.textContent = '已開啟目標頁，請在頁面上選取要抓的元素。'
      } else {
        note.textContent = '無法直接啟動選取模式，請在開啟的頁面上使用右鍵選單重新選取元素。'
      }
    }
  })
  actionsEl.appendChild(repickBtn)

  const delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.dataset.action = 'delete'
  delBtn.textContent = '刪除'
  delBtn.addEventListener('click', async () => {
    await openDeleteDialog([t.id])
  })
  actionsEl.appendChild(delBtn)

  row.appendChild(actionsEl)

  // 拖曳排序事件綁定
  let isDragging = false
  row.addEventListener('pointerdown', (e) => {
    if (['INPUT', 'BUTTON', 'A', 'SELECT'].includes(e.target.tagName)) return
    isDragging = true
    if (typeof row.setPointerCapture === 'function') {
      try {
        row.setPointerCapture(e.pointerId)
      } catch {}
    }
  })

  row.addEventListener('pointermove', (e) => {
    if (!isDragging) return
    const clientY = e.clientY
    const container = document.getElementById('task-list')
    if (!container) return
    const siblings = [...container.querySelectorAll('[data-task-id]')].filter((el) => el !== row)
    for (const sib of siblings) {
      const rect = sib.getBoundingClientRect()
      const mid = rect.top + rect.height / 2
      if (clientY < mid) {
        container.insertBefore(row, sib)
        return
      }
    }
    if (siblings.length > 0) {
      container.appendChild(row)
    }
  })

  const handlePointerEnd = async (e) => {
    if (!isDragging) return
    isDragging = false
    if (typeof row.releasePointerCapture === 'function') {
      try {
        row.releasePointerCapture(e.pointerId)
      } catch {}
    }
    const container = document.getElementById('task-list')
    if (container) {
      const ids = [...container.querySelectorAll('[data-task-id]')].map((el) => el.dataset.taskId)
      await applyOrder(ids)
    }
  }

  row.addEventListener('pointerup', handlePointerEnd)
  row.addEventListener('pointercancel', handlePointerEnd)

  return row
}

// 渲染任務管理頁主進入點
export function renderTasks(tasks, health = {}, missed = [], ctx = {}) {
  currentTasks = tasks || []
  currentHealth = health || {}
  currentMissed = missed || []
  currentCtx = ctx || {}

  const currentTaskIds = new Set(currentTasks.map((t) => t.id))
  for (const id of selectedIds) {
    if (!currentTaskIds.has(id)) {
      selectedIds.delete(id)
    }
  }
  if (renaming && !currentTaskIds.has(renaming.id)) {
    renaming = null
  }

  // 1. 錯過清單橫幅
  const banner = document.getElementById('missed-banner')
  if (banner) {
    if (!currentMissed || currentMissed.length === 0) {
      banner.hidden = true
      banner.textContent = ''
    } else {
      banner.hidden = false
      banner.textContent = ''

      const taskMap = new Map(currentTasks.map((t) => [t.id, t.name || t.id]))
      const itemRows = []

      const header = document.createElement('div')
      header.className = 'missed-header'
      header.textContent = `錯過排程（共 ${currentMissed.length} 筆未執行）：`
      banner.appendChild(header)

      const listContainer = document.createElement('div')
      listContainer.className = 'missed-items'

      for (const m of currentMissed) {
        const label = document.createElement('label')
        label.className = 'missed-item'

        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = true

        const tName = m.taskName || taskMap.get(m.taskId) || m.taskId
        const textSpan = document.createElement('span')
        textSpan.textContent = ` ${tName} (${m.slot})`

        label.appendChild(checkbox)
        label.appendChild(textSpan)
        listContainer.appendChild(label)

        itemRows.push({ checkbox, item: m })
      }
      banner.appendChild(listContainer)

      const actions = document.createElement('div')
      actions.className = 'missed-actions'

      const catchUpBtn = document.createElement('button')
      catchUpBtn.type = 'button'
      catchUpBtn.dataset.action = 'catch-up'
      catchUpBtn.textContent = '補抓勾選項目'
      catchUpBtn.addEventListener('click', async () => {
        for (const { checkbox, item } of itemRows) {
          if (checkbox.checked) {
            await chrome.runtime.sendMessage({
              type: MSG.CATCH_UP_ONE,
              taskId: item.taskId,
              slot: item.slot
            })
          }
        }
      })
      actions.appendChild(catchUpBtn)

      const skipBtn = document.createElement('button')
      skipBtn.type = 'button'
      skipBtn.dataset.action = 'skip'
      skipBtn.textContent = '略過勾選項目'
      skipBtn.addEventListener('click', async () => {
        for (const { checkbox, item } of itemRows) {
          if (checkbox.checked) {
            await chrome.runtime.sendMessage({
              type: MSG.SKIP_ONE,
              taskId: item.taskId,
              slot: item.slot
            })
          }
        }
      })
      actions.appendChild(skipBtn)

      banner.appendChild(actions)
    }
  }

  // 2. 任務列表與搜尋綁定
  const searchInput = document.getElementById('task-search')
  const failedCheckbox = document.getElementById('task-failed-only')

  if (searchInput && !searchInput.__afBound) {
    searchInput.__afBound = true
    searchInput.addEventListener('input', () => renderListRows())
  }

  if (failedCheckbox && !failedCheckbox.__afBound) {
    failedCheckbox.__afBound = true
    failedCheckbox.addEventListener('change', () => renderListRows())
  }

  const selectAllBox = document.getElementById('task-select-all')
  if (selectAllBox && !selectAllBox.__afBound) {
    selectAllBox.__afBound = true
    selectAllBox.addEventListener('change', () => {
      const taskList = document.getElementById('task-list')
      const visibleRows = taskList ? [...taskList.querySelectorAll('[data-task-id]')] : []
      const visibleIds = visibleRows.map((r) => r.dataset.taskId)
      if (selectAllBox.checked) {
        for (const id of visibleIds) {
          selectedIds.add(id)
        }
      } else {
        for (const id of visibleIds) {
          selectedIds.delete(id)
        }
      }
      updateSelectionUI()
    })
  }

  const bulkBar = document.getElementById('task-bulk-bar')
  if (bulkBar && !bulkBar.__afBound) {
    bulkBar.__afBound = true
    const enableBtn = bulkBar.querySelector('[data-action="bulk-enable"]')
    if (enableBtn) {
      enableBtn.addEventListener('click', () => setBulkEnabled(true))
    }
    const disableBtn = bulkBar.querySelector('[data-action="bulk-disable"]')
    if (disableBtn) {
      disableBtn.addEventListener('click', () => setBulkEnabled(false))
    }
    const scheduleBtn = bulkBar.querySelector('[data-action="bulk-schedule"]')
    if (scheduleBtn) {
      scheduleBtn.addEventListener('click', () => openBulkSchedule([...selectedIds]))
    }
    const deleteBtn = bulkBar.querySelector('[data-action="bulk-delete"]')
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => openDeleteDialog([...selectedIds], true))
    }
    const clearBtn = bulkBar.querySelector('[data-action="bulk-clear"]')
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        selectedIds.clear()
        lastPickedId = null
        renderListRows()
      })
    }
  }

  renderListRows()
}
