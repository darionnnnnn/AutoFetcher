// AutoFetcher 匯出模組：JSON 與 CSV 產生及手動下載 (SPEC §5)

import { getTasks, getRecordsByDate } from './storage.js'

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

// 產生指定日期範圍與格式之匯出檔案內容與檔名
export async function buildExport({ from, to, format }) {
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
  const mime = isCsv ? 'text/csv' : 'application/json'
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`
  return await chrome.downloads.download({ url, filename, saveAs: true })
}
