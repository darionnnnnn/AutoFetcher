// AutoFetcher 工具列 popup 控制器 (SPEC §12.2)
import { getTasks, saveTask, getHealthMap, getMissedList, getLastValues } from '../../shared/storage.js'
import { MSG } from '../../shared/messages.js'
import { seriesIdOf } from '../../shared/series-index.js'
import { computeHealth } from '../../background/health.js'

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

// 畫單一任務列（規格限制：只寫一份函式）
function renderTaskRow(task, { lastValues, nextRuns, healthMap }) {
  const row = document.createElement('div')
  row.className = 'task-row'
  if (task.enabled === false) row.classList.add('disabled')

  // 主要資訊：名稱與最後數值
  const mainDiv = document.createElement('div')
  mainDiv.className = 'task-main'

  const nameSpan = document.createElement('span')
  nameSpan.className = 'task-name'
  nameSpan.textContent = task.name || task.id || ''
  mainDiv.appendChild(nameSpan)

  const valueSpan = document.createElement('span')
  valueSpan.className = 'task-value'
  // 多值任務的最後值記在子序列 id 底下，查父任務永遠是空的；最多列三個，其餘用 +N 帶過
  const fields = Array.isArray(task.fields) ? task.fields : []
  if (fields.length > 0) {
    const shown = fields.slice(0, 3)
      .map(f => `${f.name || f.key}: ${formatValue(lastValues?.[seriesIdOf(task.id, f.key)]?.value)}`)
    valueSpan.textContent = shown.join('  ') + (fields.length > 3 ? `  +${fields.length - 3}` : '')
  } else {
    valueSpan.textContent = formatValue(lastValues?.[task.id]?.value)
  }
  mainDiv.appendChild(valueSpan)
  row.appendChild(mainDiv)

  // 次要資訊：下次執行時間、暫停狀態、異常原因
  const subDiv = document.createElement('div')
  subDiv.className = 'task-sub'

  const nextSpan = document.createElement('span')
  nextSpan.className = 'task-next'
  nextSpan.textContent = formatTime(nextRuns?.[task.id])
  subDiv.appendChild(nextSpan)

  if (task.enabled === false) {
    const pausedSpan = document.createElement('span')
    pausedSpan.className = 'task-paused'
    pausedSpan.textContent = '暫停'
    subDiv.appendChild(pausedSpan)
  }

  const healthInfo = healthMap?.[task.id]
  const isAbnormal = healthInfo && healthInfo.status !== undefined && healthInfo.status !== 'ok'

  if (isAbnormal && healthInfo.reason) {
    const reasonSpan = document.createElement('span')
    reasonSpan.className = 'task-reason'
    reasonSpan.textContent = healthInfo.reason
    subDiv.appendChild(reasonSpan)
  }
  row.appendChild(subDiv)

  // 異常任務按鈕：立即重試與開啟頁面
  if (isAbnormal) {
    const actionsDiv = document.createElement('div')
    actionsDiv.className = 'task-actions'

    const retryBtn = document.createElement('button')
    retryBtn.type = 'button'
    retryBtn.className = 'retry'
    retryBtn.textContent = '立即重試'
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
          showResult(`失敗：${res?.error || res?.status || ''}`.trim())
        }
      } catch (err) {
        showResult(`失敗：${err?.message || String(err)}`)
      } finally {
        retryBtn.disabled = false
      }
    })
    actionsDiv.appendChild(retryBtn)

    const openPageBtn = document.createElement('button')
    openPageBtn.type = 'button'
    openPageBtn.className = 'open-page'
    openPageBtn.textContent = '開啟頁面'
    openPageBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: task.url })
    })
    actionsDiv.appendChild(openPageBtn)

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
    healthMap = {}
  } = ctx || {}

  // 1. 燈號摘要文字與顏色類別
  const summaryEl = document.getElementById('status-summary')
  if (summaryEl) summaryEl.textContent = health?.summary || ''

  const dotEl = document.getElementById('status-dot')
  if (dotEl) {
    const levelMap = { green: 'ok', yellow: 'warn', red: 'bad', off: 'off' }
    const targetClass = levelMap[health?.level] || 'off'
    const preserved = dotEl.className.split(/\s+/).filter(c => c && !['ok', 'warn', 'bad', 'off'].includes(c))
    preserved.push(targetClass)
    dotEl.className = preserved.join(' ')
  }

  // 2. 清空並填入任務清單
  const taskListEl = document.getElementById('task-list')
  if (taskListEl) {
    taskListEl.textContent = ''
    if (!tasks || tasks.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'empty-hint'
      emptyEl.textContent = '還沒有任務。到想抓的網頁上按右鍵，選 AutoFetcher 就能建立。'
      taskListEl.appendChild(emptyEl)
    } else {
      for (const t of tasks) {
        taskListEl.appendChild(renderTaskRow(t, { lastValues, nextRuns, healthMap }))
      }
    }
  }

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

  const openReportBtn = document.getElementById('open-report')
  if (openReportBtn) {
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

// 全部暫停 / 恢復
export async function handleToggleAll() {
  const tasks = await getTasks()
  const hasActive = tasks.some(t => t.enabled !== false)
  const nextEnabled = !hasActive
  for (const t of tasks) {
    await saveTask({ ...t, enabled: nextEnabled })
  }
  chrome.runtime.sendMessage({ type: MSG.REBUILD_ALARMS })
}

// 標記異常任務為已讀
export async function markAllSeen(taskIds) {
  return chrome.runtime.sendMessage({ type: 'MARK_READ', taskIds })
}

// 取得最後一次 render 的狀態
export function getState() {
  return currentCtx
}

// 擴充功能環境下自動初始化
if (typeof document !== 'undefined' && globalThis.chrome?.runtime?.id) {
  (async () => {
    try {
      const tasks = await getTasks()
      // UI 一律經 shared/storage，不直接碰 chrome.storage
      const [healthMap, missed, lastValues] = await Promise.all([
        getHealthMap(), getMissedList(), getLastValues()
      ])
      const health = computeHealth(tasks, healthMap, missed)

      // 取得 alarms 下次執行時間
      const nextRuns = {}
      if (chrome.alarms?.getAll) {
        const alarms = await chrome.alarms.getAll()
        for (const a of alarms) {
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

      // 取得最後數值

      render({ health, tasks, lastValues, nextRuns, healthMap })

      const abnormalIds = Object.keys(healthMap).filter(id => {
        const h = healthMap[id]
        return h && h.status !== undefined && h.status !== 'ok'
      })
      if (abnormalIds.length > 0) {
        await markAllSeen(abnormalIds)
      }
    } catch (err) {
      console.error('AutoFetcher popup 初始化失敗:', err)
    }
  })()
}
