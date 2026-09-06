// AutoFetcher 匯出模組：JSON、CSV 與 HTML 報表產生及手動下載 (SPEC §5, K1)

import { getTasks, getRecordsByDate, getRecordsInRange, getHealthMap, getMissedList } from './storage.js'
import { getLayout } from './layout-store.js'
import { renderCard } from '../ui/report/cards.js'
import { isSuccess } from './record-status.js'
import { effectiveTimeOf } from '../ui/report/series.js'

// 跳脫 HTML 特殊字元
function escapeHtml(str) {
  if (str === null || str === undefined) {
    return ''
  }
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// 跳脫 CSV 欄位值（含逗號、雙引號或換行時以雙引號包覆，內部雙引號成雙）
function escapeCsvCell(val) {
  if (val === undefined || val === null) {
    return ''
  }
  const str = String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replaceAll('"', '""')}"`
  }
  return str
}

// 逐日走訪日期範圍，取得每日紀錄資料（含頭尾，依日期由舊到新）
async function collectDays(from, to) {
  const cur = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  const days = []

  while (cur <= end) {
    const date = cur.toISOString().slice(0, 10)
    const records = await getRecordsByDate(date)
    days.push({ date, records })
    cur.setUTCDate(cur.getUTCDate() + 1)
  }

  return days
}

// 將紀錄資料格式化為 JSON 字串
function formatJson(days, taskMap, isSingleDay) {
  const dayObjects = days.map(({ date, records }) => {
    const dayTasks = {}
    for (const record of records) {
      const taskId = record.taskId
      if (!dayTasks[taskId]) {
        dayTasks[taskId] = {
          name: taskMap.get(taskId) ?? taskId,
          records: []
        }
      }
      dayTasks[taskId].records.push(record)
    }
    return { date, tasks: dayTasks }
  })

  const output = isSingleDay ? dayObjects[0] : { days: dayObjects }
  return JSON.stringify(output, null, 2)
}

// 將紀錄資料格式化為 CSV 字串
function formatCsv(days, taskMap) {
  const lines = ['date,slot,capturedAt,taskId,taskName,value,raw,status']

  for (const { date, records } of days) {
    for (const record of records) {
      const taskId = record.taskId
      const taskName = taskMap.get(taskId) ?? taskId
      const row = [
        escapeCsvCell(date),
        escapeCsvCell(record.slot),
        escapeCsvCell(record.capturedAt),
        escapeCsvCell(taskId),
        escapeCsvCell(taskName),
        escapeCsvCell(record.value),
        escapeCsvCell(record.raw),
        escapeCsvCell(record.status)
      ]
      lines.push(row.join(','))
    }
  }

  return lines.join('\n') + '\n'
}

// 取得 theme.css 的亮色 :root 區塊，若失敗則退回最小 CSS 變數樣板
async function loadThemeCss() {
  try {
    const url = await chrome.runtime.getURL('ui/theme.css')
    const css = await (await fetch(url)).text()
    const match = css.match(/:root\s*\{[^}]*\}/)
    if (match) {
      return match[0]
    }
  } catch {}

  return `:root {
      --bg: var(--bg, canvas);
      --surface: var(--surface, canvas);
      --text: var(--text, canvastext);
      --text-muted: var(--text-muted, gray);
      --border: var(--border, currentColor);
      --primary: var(--primary, currentColor);
      --danger: var(--danger, currentColor);
      --danger-bg: var(--danger-bg, canvas);
      --hover: var(--hover, canvas);
      --radius: 6px;
      --ok: var(--ok, currentColor);
      --warn: var(--warn, currentColor);
      --chart-1: var(--chart-1, currentColor);
      --chart-2: var(--chart-2, currentColor);
      --chart-3: var(--chart-3, currentColor);
      --chart-4: var(--chart-4, currentColor);
      --chart-5: var(--chart-5, currentColor);
      --chart-6: var(--chart-6, currentColor);
      --chart-7: var(--chart-7, currentColor);
      --chart-8: var(--chart-8, currentColor);
    }`
}

// 產生指定日期範圍之靜態 HTML 報表快照（純靜態、離線可開啟、無外部連結）
export async function buildHtmlReport({ from, to, dashId }) {
  const filename = `AutoFetcher/report-${from}_${to}.html`
  const themeCss = await loadThemeCss()

  const tasks = await getTasks()
  const taskMap = new Map(tasks.map(t => [t.id, t.name]))
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]))
  const records = await getRecordsInRange(from, to)

  let health = {}
  let missed = []
  try {
    health = await getHealthMap()
    missed = await getMissedList()
  } catch {}

  const ctx = {
    records,
    tasksById,
    health,
    nextRuns: {},
    missed,
    range: { from, to },
    today: to || new Date().toISOString().slice(0, 10),
    onPointClick: null
  }

  const layout = await getLayout()
  const dashboards = Array.isArray(layout?.dashboards) ? layout.dashboards : []
  const currentDash = (dashId ? dashboards.find(d => d && d.id === dashId) : null) || dashboards[0]
  const cards = Array.isArray(currentDash?.cards) ? currentDash.cards : []

  let cardsHtml = ''
  if (cards.length > 0) {
    const renderedList = []
    for (const card of cards) {
      const cardEl = renderCard(card, ctx)
      if (card.w) {
        cardEl.style.gridColumn = `span ${Math.min(12, Math.max(1, card.w))}`
      }
      renderedList.push(cardEl.outerHTML)
    }
    cardsHtml = `\n    <section class="cards-grid">\n      ${renderedList.join('\n      ')}\n    </section>`
  }

  let recordsTableHtml = ''
  if (!records || records.length === 0) {
    recordsTableHtml = '<p class="empty-state">所選範圍內沒有紀錄資料</p>'
  } else {
    // 時間一律用有效時刻(slot 是本地、capturedAt 是 UTC,不可混著比字串)
    const sortedRecords = [...records].sort((a, b) =>
      (effectiveTimeOf(a) || a.date || '').localeCompare(effectiveTimeOf(b) || b.date || ''))

    const rows = sortedRecords.map(r => {
      const time = effectiveTimeOf(r) || r.date || ''
      const taskName = taskMap.get(r.taskId) ?? r.taskId ?? ''
      const val = r.value !== undefined && r.value !== null
        ? String(r.value)
        : (r.raw !== undefined && r.raw !== null ? String(r.raw) : '—')
      const status = r.status || '—'
      const trClass = r.status && !isSuccess(r) ? ' class="status-failed"' : ''
      return `<tr${trClass}><td>${escapeHtml(time)}</td><td>${escapeHtml(taskName)}</td><td>${escapeHtml(val)}</td><td>${escapeHtml(status)}</td></tr>`
    }).join('\n          ')

    recordsTableHtml = `<table class="report-table">
          <thead>
            <tr>
              <th>時間</th>
              <th>任務名</th>
              <th>值</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
          ${rows}
          </tbody>
        </table>`
  }

  const rangeTitle = from === to ? from : `${from} ~ ${to}`

  const content = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AutoFetcher 報表 (${escapeHtml(rangeTitle)})</title>
  <style>
    ${themeCss}

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 1.5rem;
    }
    .report-header {
      margin-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    .report-title {
      font-size: 1.5rem;
      font-weight: 700;
    }
    .report-range {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-top: 0.25rem;
    }
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 12px;
      margin-bottom: 2rem;
    }
    .report-card {
      grid-column: span 6;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      break-inside: avoid;
    }
    .report-card[data-card-type="table"] {
      grid-column: span 12;
    }
    .report-card .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }
    .report-card .card-title {
      font-weight: 600;
      font-size: 1rem;
    }
    .report-card .card-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .report-card .card-period {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .report-card .card-actions {
      display: none;
    }
    .report-card .card-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .card-number-display {
      display: flex;
      align-items: baseline;
      gap: 0.25rem;
      margin: 0.5rem 0;
    }
    .card-number-value {
      font-size: 2rem;
      font-weight: 700;
      color: var(--text);
    }
    .card-number-unit {
      font-size: 1rem;
      color: var(--text-muted);
    }
    .card-number-diff {
      font-size: 0.9rem;
      font-weight: 500;
    }
    .diff-up { color: var(--ok); }
    .diff-down { color: var(--danger); }
    .card-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    .card-table th, .card-table td {
      padding: 0.4rem 0.6rem;
      border-bottom: 1px solid var(--border);
    }
    .card-table th {
      background: var(--hover);
      color: var(--text-muted);
      font-weight: 600;
    }
    .status-list {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .status-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.85rem;
    }
    .status-name { font-weight: 500; }
    .status-state, .status-next, .status-missed {
      color: var(--text-muted);
      font-size: 0.8rem;
    }
    .status-missed { color: var(--danger); }
    .records-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.25rem;
    }
    .records-section h2 {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }
    .report-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
      text-align: left;
    }
    .report-table th, .report-table td {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    .report-table thead th {
      background: var(--hover);
      color: var(--text-muted);
      font-weight: 600;
    }
    .report-table tbody tr:hover {
      background: var(--hover);
    }
    .report-table tbody tr.status-failed {
      background: var(--danger-bg);
      color: var(--danger);
    }
    .empty-state {
      text-align: center;
      padding: 2.5rem 1rem;
      color: var(--text-muted);
      font-size: 0.95rem;
    }
    @media print {
      body {
        padding: 0;
        background: var(--surface);
      }
      .report-card {
        break-inside: avoid;
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <header class="report-header">
    <h1 class="report-title">AutoFetcher 報表</h1>
    <div class="report-range">日期範圍：${escapeHtml(rangeTitle)}</div>
  </header>
  <main>${cardsHtml}
    <section class="records-section">
      <h2>紀錄列表</h2>
      ${recordsTableHtml}
    </section>
  </main>
</body>
</html>`

  return { filename, content }
}

// 產生指定日期範圍與格式之匯出檔案內容與檔名
export async function buildExport({ from, to, format, dashId }) {
  if (format === 'html') {
    return await buildHtmlReport({ from, to, dashId })
  }

  if (format !== 'json' && format !== 'csv') {
    throw new Error(`不支援的匯出格式: ${format}`)
  }

  const tasks = await getTasks()
  const taskMap = new Map(tasks.map(t => [t.id, t.name]))
  const days = await collectDays(from, to)

  const filename = from === to
    ? `AutoFetcher/${from}.${format}`
    : `AutoFetcher/${from}_${to}.${format}`

  const content = format === 'json'
    ? formatJson(days, taskMap, from === to)
    : formatCsv(days, taskMap)

  return { filename, content }
}

// 觸發使用者手動下載檔案（呼叫 chrome.downloads.download，saveAs 恆為 true）
export async function download({ filename, content }) {
  const isCsv = typeof filename === 'string' && filename.endsWith('.csv')
  const isHtml = typeof filename === 'string' && filename.endsWith('.html')
  const mime = isCsv ? 'text/csv' : (isHtml ? 'text/html' : 'application/json')
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`
  return await chrome.downloads.download({ url, filename, saveAs: true })
}

