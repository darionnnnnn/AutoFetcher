// AutoFetcher 匯出模組：JSON、CSV 與 HTML 報表產生及手動下載 (SPEC §5, K1)

import { getTasks, getRecordsByDate, getRecordsInRange } from './storage.js'
import { getLayout } from './layout-store.js'
import { renderCard } from '../ui/report/cards.js'

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

// 產生指定日期範圍之靜態 HTML 報表快照（純靜態、離線可開啟、無外部連結）
export async function buildHtmlReport({ from, to, dashId }) {
  const filename = `AutoFetcher/report-${from}_${to}.html`

  const tasks = await getTasks()
  const taskMap = new Map(tasks.map(t => [t.id, t.name]))
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]))
  const records = await getRecordsInRange(from, to)

  let health = {}
  let missed = []
  if (globalThis.chrome?.storage?.local?.get) {
    try {
      const data = await chrome.storage.local.get(['health', 'missed'])
      health = (data?.health && typeof data.health === 'object') ? data.health : {}
      missed = Array.isArray(data?.missed) ? data.missed : []
    } catch {}
  }

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
    const sortedRecords = [...records].sort((a, b) => {
      const timeA = a.slot || a.capturedAt || a.date || ''
      const timeB = b.slot || b.capturedAt || b.date || ''
      return timeA.localeCompare(timeB)
    })

    const rows = sortedRecords.map(r => {
      const time = r.slot || r.capturedAt || r.date || ''
      const taskName = taskMap.get(r.taskId) ?? r.taskId ?? ''
      const val = r.value !== undefined && r.value !== null
        ? String(r.value)
        : (r.raw !== undefined && r.raw !== null ? String(r.raw) : '—')
      const status = r.status || '—'
      const trClass = r.status && r.status !== 'ok' ? ' class="status-failed"' : ''
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
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --primary: #2563eb;
      --danger: #dc2626;
      --danger-bg: #fef2f2;
      --hover: #f1f5f9;
      --radius: 6px;
      --ok: #16a34a;
      --warn: #d97706;
      --chart-1: #2563eb;
      --chart-2: #16a34a;
      --chart-3: #ea580c;
      --chart-4: #9333ea;
      --chart-5: #0891b2;
      --chart-6: #db2777;
      --chart-7: #ca8a04;
      --chart-8: #4f46e5;
    }

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
        background: #ffffff;
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

