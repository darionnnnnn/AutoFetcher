import { getTask, saveTask, deleteTask, getTasks, countRecordsForTask, listDates } from '../../shared/storage.js'
import { MSG } from '../../shared/messages.js'
import { buildExport, download } from '../../shared/export.js'

let currentTasks = []
let currentHealth = {}
let currentMissed = []
let currentCtx = {}

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
  for (let i = 0; i < ids.length; i++) {
    const t = await getTask(ids[i])
    if (t) {
      await saveTask({ ...t, order: i })
    }
  }
}

// 開啟刪除確認對話框並計算關聯紀錄數
async function openDeleteDialog(taskId) {
  const dlg = document.getElementById('task-delete-dialog')
  if (!dlg) return

  const count = await countRecordsForTask(taskId)

  const taskObj = currentTasks.find((t) => t.id === taskId)
  const taskName = taskObj?.name || taskId
  const msgText = `確定要刪除「${taskName}」嗎？此操作將一併刪除 ${count} 筆歷史紀錄。`

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
      await deleteTask(taskId)
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

      const exp = await buildExport({ from, to, format: 'csv' })
      await download(exp)
      await deleteTask(taskId)
      dlg.hidden = true
      const remaining = await getTasks()
      renderTasks(remaining, currentHealth, currentMissed, currentCtx)
    }
  }
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
      await saveTask(current)
      await chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
    }
  })
  toggleLabel.appendChild(toggle)
  row.appendChild(toggleLabel)

  const nameEl = document.createElement('span')
  nameEl.className = 'task-name'
  nameEl.textContent = t.name || t.id
  row.appendChild(nameEl)

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
  modeEl.textContent = describeMode(t)
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

  const scheduleEl = document.createElement('span')
  scheduleEl.className = 'task-schedule'
  if (t.schedule?.type === 'daily') {
    const times = Array.isArray(t.schedule.times) ? t.schedule.times.join(', ') : ''
    scheduleEl.textContent = `每日 ${times}`
  } else if (t.schedule?.type === 'interval') {
    scheduleEl.textContent = `每 ${t.schedule.everyMinutes || 15} 分鐘`
  } else {
    scheduleEl.textContent = '未排程'
  }
  row.appendChild(scheduleEl)

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
        await saveTask(current)
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
      if (res && res.outcome === 'done') {
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
    const raw = 'ui/picker/picker.html?taskId=' + t.id
    const url = typeof chrome?.runtime?.getURL === 'function'
      ? await chrome.runtime.getURL(raw)
      : raw
    await chrome.tabs.create({ url: String(url) })
  })
  actionsEl.appendChild(editBtn)

  const dupBtn = document.createElement('button')
  dupBtn.type = 'button'
  dupBtn.dataset.action = 'duplicate'
  dupBtn.textContent = '複製'
  dupBtn.addEventListener('click', async () => {
    const copy = duplicateTask(t)
    await saveTask(copy)
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
    await openDeleteDialog(t.id)
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
  const taskList = document.getElementById('task-list')
  const searchInput = document.getElementById('task-search')
  const failedCheckbox = document.getElementById('task-failed-only')

  function renderListRows() {
    if (!taskList) return
    taskList.textContent = ''
    const q = searchInput ? searchInput.value : ''
    const failedOnly = failedCheckbox ? failedCheckbox.checked : false
    const filtered = filterTasks(currentTasks, { q, failedOnly }, currentHealth)

    for (const t of filtered) {
      taskList.appendChild(createTaskRow(t))
    }
  }

  if (searchInput && !searchInput.__afBound) {
    searchInput.__afBound = true
    searchInput.addEventListener('input', () => renderListRows())
  }

  if (failedCheckbox && !failedCheckbox.__afBound) {
    failedCheckbox.__afBound = true
    failedCheckbox.addEventListener('change', () => renderListRows())
  }

  renderListRows()
}
