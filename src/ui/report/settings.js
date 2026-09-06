// AutoFetcher 設定頁邏輯模組 (F4)
import {
  getSettings,
  saveSettings,
  getTasks,
  getStorageStats,
  importRecords,
  getDiagList,
  getSites,
  getSite,
  saveSite,
  deleteSite,
  getHealthMap
} from '../../shared/storage.js'
import { buildExport, download } from '../../shared/export.js'
import { exportSettings, importSettings } from '../../shared/settings-io.js'
import * as diag from '../../shared/diag.js'
import { MSG } from '../../shared/messages.js'
import { applyTheme } from './report.js'

// 重新繪製儲存用量區
async function renderStorageStats() {
  const statsBox = document.getElementById('storage-stats')
  if (!statsBox) return
  statsBox.textContent = ''

  const stats = await getStorageStats()
  const items = [
    `儲存用量：${stats.bytes} 位元組`,
    `紀錄總筆數：${stats.recordCount} 筆`,
    `最舊紀錄日期：${stats.oldestDate ?? '—'}`,
    `上次設定匯出時間：${stats.lastSettingsExportAt ? new Date(stats.lastSettingsExportAt).toLocaleString() : '—'}`,
    `上次紀錄匯出時間：${stats.lastRecordsExportAt ? new Date(stats.lastRecordsExportAt).toLocaleString() : '—'}`
  ]

  for (const text of items) {
    const p = document.createElement('p')
    p.textContent = text
    statsBox.appendChild(p)
  }
}

// 繪製最近診斷紀錄（最多 20 筆最新）
async function renderDiag() {
  const diagBox = document.getElementById('health-diag')
  if (!diagBox) return
  diagBox.textContent = ''

  let entries = []
  try {
    entries = await diag.getAll()
  } catch {}

  const latest = entries.slice(-20)
  for (const entry of latest) {
    const row = document.createElement('div')
    row.setAttribute('data-diag', '')
    const timeStr = entry.at
      ? (typeof entry.at === 'number' ? new Date(entry.at).toLocaleString() : String(entry.at))
      : '—'
    row.textContent = `[${timeStr}] [${entry.kind || ''}] ${entry.detail || ''}`
    diagBox.appendChild(row)
  }
}

// 繪製看門狗上次巡檢時間
async function renderWatchdog() {
  const wdEl = document.getElementById('health-watchdog')
  if (!wdEl) return

  let lastTime = null
  try {
    const diagList = await getDiagList()
    const wdEntries = diagList.filter((e) => e && e.kind === 'watchdog')
    if (wdEntries.length > 0) {
      lastTime = wdEntries[wdEntries.length - 1].at
    }
  } catch {}

  if (lastTime) {
    wdEl.textContent = typeof lastTime === 'number'
      ? new Date(lastTime).toLocaleString()
      : String(lastTime)
  } else {
    wdEl.textContent = '—'
  }
}

// 繪製各任務下次觸發時間清單
async function renderNextRuns() {
  const box = document.getElementById('health-next-runs')
  if (!box) return
  box.textContent = ''

  let nextRuns = null
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_NEXT_RUNS })
    if (res && typeof res === 'object' && res.nextRuns && typeof res.nextRuns === 'object') {
      nextRuns = res.nextRuns
    }
  } catch {}

  if (!nextRuns) nextRuns = {}

  let tasks = []
  try {
    tasks = await getTasks()
  } catch {}

  for (const t of tasks) {
    const row = document.createElement('div')
    row.dataset.taskId = t.id
    const scheduled = nextRuns[t.id]
    const timeStr = typeof scheduled === 'number'
      ? new Date(scheduled).toLocaleString()
      : '—'
    row.textContent = `${t.name}：${timeStr}`
    box.appendChild(row)
  }
}

// 綁定匯出與匯入控制項事件
function setupExportAndImportListeners() {
  const htmlOpt = document.querySelector('#export-format option[value="html"]')
  if (htmlOpt) {
    htmlOpt.disabled = false
    htmlOpt.textContent = 'HTML 報表'
  }

  const exportRunBtn = document.getElementById('export-run')
  if (exportRunBtn && !exportRunBtn._afBound) {
    exportRunBtn._afBound = true
    exportRunBtn.addEventListener('click', async () => {
      const fromEl = document.getElementById('export-from')
      const toEl = document.getElementById('export-to')
      const formatEl = document.getElementById('export-format')
      const today = new Date().toISOString().slice(0, 10)
      const from = fromEl?.value || today
      const to = toEl?.value || today
      const format = formatEl?.value || 'json'

      const data = await buildExport({ from, to, format })
      await download(data)
      await saveSettings({ lastRecordsExportAt: new Date().toISOString() })
      await renderStorageStats()
    })
  }

  const settingsExportBtn = document.getElementById('settings-export')
  if (settingsExportBtn && !settingsExportBtn._afBound) {
    settingsExportBtn._afBound = true
    settingsExportBtn.addEventListener('click', async () => {
      const includePasswords = document.getElementById('settings-include-passwords')?.checked || false
      const passphrase = document.getElementById('settings-passphrase')?.value || ''
      const content = await exportSettings({ includePasswords, passphrase })
      await download({ filename: 'AutoFetcher/autofetcher-settings.json', content })
      await saveSettings({ lastSettingsExportAt: new Date().toISOString() })
      await renderStorageStats()
    })
  }

  const settingsImportFileEl = document.getElementById('settings-import-file')
  if (settingsImportFileEl && !settingsImportFileEl._afBound) {
    settingsImportFileEl._afBound = true
    settingsImportFileEl.addEventListener('change', async () => {
      const file = settingsImportFileEl.files?.[0]
      if (!file) return
      const text = typeof file.text === 'function'
        ? await file.text()
        : await new Promise((res, rej) => {
            const reader = new FileReader()
            reader.onload = () => res(reader.result)
            reader.onerror = rej
            reader.readAsText(file)
          })
      await handleSettingsImport(text)
    })
  }

  const recordsImportFileEl = document.getElementById('records-import-file')
  if (recordsImportFileEl && !recordsImportFileEl._afBound) {
    recordsImportFileEl._afBound = true
    recordsImportFileEl.addEventListener('change', async () => {
      const files = Array.from(recordsImportFileEl.files || [])
      if (files.length === 0) return
      const texts = []
      for (const file of files) {
        const text = typeof file.text === 'function'
          ? await file.text()
          : await new Promise((res, rej) => {
              const reader = new FileReader()
              reader.onload = () => res(reader.result)
              reader.onerror = rej
              reader.readAsText(file)
            })
        texts.push(text)
      }
      await handleRecordsImport(texts)
    })
  }

  const selfCheckBtn = document.getElementById('health-selfcheck')
  if (selfCheckBtn && !selfCheckBtn._afBound) {
    selfCheckBtn._afBound = true
    selfCheckBtn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: MSG.SELF_CHECK })
        await renderDiag()
      } catch {}
    })
  }
}

// 綁定偏好設定控制項事件
function setupPreferenceListeners(settings) {
  const retentionEl = document.getElementById('pref-retention')
  if (retentionEl) {
    retentionEl.value = settings.retentionDays ?? 365
    if (!retentionEl._afBound) {
      retentionEl._afBound = true
      retentionEl.addEventListener('change', async () => {
        await saveSettings({ retentionDays: Number(retentionEl.value) })
      })
    }
  }

  const notificationsEl = document.getElementById('pref-notifications')
  if (notificationsEl) {
    notificationsEl.checked = settings.notifications ?? true
    if (!notificationsEl._afBound) {
      notificationsEl._afBound = true
      notificationsEl.addEventListener('change', async () => {
        await saveSettings({ notifications: Boolean(notificationsEl.checked) })
      })
    }
  }

  const extraDelayEl = document.getElementById('pref-extra-delay')
  if (extraDelayEl) {
    extraDelayEl.value = settings.extraDelaySec ?? 3
    if (!extraDelayEl._afBound) {
      extraDelayEl._afBound = true
      extraDelayEl.addEventListener('change', async () => {
        await saveSettings({ extraDelaySec: Number(extraDelayEl.value) })
      })
    }
  }

  const themeEl = document.getElementById('pref-theme')
  if (themeEl) {
    themeEl.value = settings.theme ?? 'system'
    if (!themeEl._afBound) {
      themeEl._afBound = true
      themeEl.addEventListener('change', async () => {
        const val = themeEl.value
        await saveSettings({ theme: val })
        applyTheme(val)
      })
    }
  }
}

// 初始化匯出日期預設值
function setupDefaultExportDates() {
  const rangeFromEl = document.getElementById('range-from')
  const rangeToEl = document.getElementById('range-to')
  const today = new Date().toISOString().slice(0, 10)
  const defaultFrom = rangeFromEl?.value || today
  const defaultTo = rangeToEl?.value || today

  const exportFromEl = document.getElementById('export-from')
  const exportToEl = document.getElementById('export-to')
  if (exportFromEl && !exportFromEl.value) {
    exportFromEl.value = defaultFrom
  }
  if (exportToEl && !exportToEl.value) {
    exportToEl.value = defaultTo
  }
}

// 渲染隱私與權限說明（若 DOM 中為空時填入）
function renderPrivacyNote() {
  const noteEl = document.getElementById('privacy-note')
  if (!noteEl || noteEl.textContent.trim().length > 0) return

  const p1 = document.createElement('p')
  p1.textContent = 'AutoFetcher 絕不連接任何外部伺服器，所有抓取與設定資料僅保存在使用者本機。'
  noteEl.appendChild(p1)

  const p2 = document.createElement('p')
  p2.textContent = '擴充功能權限用途說明：'
  noteEl.appendChild(p2)

  const ul = document.createElement('ul')
  const permissions = [
    'alarms：用於定時排程抓取與看門狗定期自我巡檢。',
    'downloads：用於手動匯出抓取紀錄（JSON/CSV）與備份設定檔案。',
    'notifications：用於發出抓取失敗、錯過排程與重要狀態通知。',
    'storage：用於在使用者本機儲存任務設定、全域偏好與歷次抓取紀錄。',
    'tabs：用於在背景或前景開啟目標網頁、報表檢視頁面與元素拾取器。',
    'scripting：用於在目標網頁執行擷取指令碼以讀取文字或數值內容。'
  ]
  for (const perm of permissions) {
    const li = document.createElement('li')
    li.textContent = perm
    ul.appendChild(li)
  }
  noteEl.appendChild(ul)
}

// 綁定站台清單事件處理（事件委派，避免重複監聽）
function setupSitesListListeners() {
  const listEl = document.getElementById('sites-list')
  if (!listEl || listEl._afBound) return
  listEl._afBound = true
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]')
    if (!btn) return
    const origin = btn.dataset.origin
    if (!origin) return
    const action = btn.dataset.action
    if (action === 'site-toggle') {
      const site = await getSite(origin)
      if (!site) return
      const nextEnabled = site.enabled === false ? true : false
      site.enabled = nextEnabled
      if (nextEnabled) {
        site.failStreak = 0
      }
      await saveSite(origin, site)
      await renderSitesList()
    } else if (action === 'site-delete') {
      await deleteSite(origin)
      await renderSitesList()
    }
  })
}

// 繪製站台登入管理清單
async function renderSitesList() {
  const listEl = document.getElementById('sites-list')
  if (!listEl) return
  listEl.textContent = ''

  let sites = {}
  try {
    sites = await getSites()
  } catch {}

  const entries = Object.entries(sites)
  if (entries.length === 0) {
    const placeholder = document.createElement('div')
    placeholder.id = 'sites-placeholder'
    placeholder.textContent = '目前尚未設定任何站台。'
    listEl.appendChild(placeholder)
    return
  }

  let healthMap = {}
  try {
    healthMap = await getHealthMap()
  } catch {}

  for (const [origin, site] of entries) {
    if (!site) continue

    const row = document.createElement('div')
    row.className = 'site-row'

    const originEl = document.createElement('span')
    originEl.className = 'site-origin'
    originEl.textContent = origin
    row.appendChild(originEl)

    const userEl = document.createElement('span')
    userEl.className = 'site-user'
    userEl.textContent = site.username ? `帳號：${site.username}` : '無帳號'
    row.appendChild(userEl)

    const isEnabled = site.enabled !== false

    const statusEl = document.createElement('span')
    statusEl.className = 'site-status'
    statusEl.textContent = isEnabled ? '啟用中' : '已停用'
    row.appendChild(statusEl)

    const streakEl = document.createElement('span')
    streakEl.className = 'site-streak'
    streakEl.textContent = `失敗次數：${site.failStreak || 0}`
    row.appendChild(streakEl)

    const healthEl = document.createElement('span')
    healthEl.className = 'site-health'
    const record = healthMap['site:' + origin]
    let healthText = '尚未檢查'
    if (record && record.status) {
      if (record.status === 'ok') {
        healthText = '正常'
      } else if (record.status === 'login_failed') {
        healthText = record.reason || '無法登入'
      } else {
        healthText = record.reason || record.status
      }
    }
    healthEl.textContent = `最近檢查：${healthText}`
    row.appendChild(healthEl)

    const actionsEl = document.createElement('div')
    actionsEl.className = 'site-actions'

    const toggleBtn = document.createElement('button')
    toggleBtn.type = 'button'
    toggleBtn.dataset.action = 'site-toggle'
    toggleBtn.dataset.origin = origin
    toggleBtn.textContent = isEnabled ? '停用' : '啟用'
    actionsEl.appendChild(toggleBtn)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.dataset.action = 'site-delete'
    deleteBtn.dataset.origin = origin
    deleteBtn.textContent = '刪除'
    actionsEl.appendChild(deleteBtn)

    row.appendChild(actionsEl)
    listEl.appendChild(row)
  }

  setupSitesListListeners()
}

// 渲染整個設定頁
export async function renderSettings() {
  setupDefaultExportDates()

  let settings = {}
  try {
    settings = await getSettings()
  } catch {}

  setupPreferenceListeners(settings)
  setupExportAndImportListeners()

  await Promise.all([
    renderNextRuns(),
    renderWatchdog(),
    renderDiag(),
    renderStorageStats(),
    renderSitesList()
  ])

  renderPrivacyNote()
}

// 處理設定匯入
export async function handleSettingsImport(jsonText) {
  const resultEl = document.getElementById('settings-import-result')
  try {
    const passphraseEl = document.getElementById('settings-passphrase')
    const passphrase = passphraseEl?.value || ''
    await importSettings(jsonText, { passphrase })
    if (resultEl) {
      resultEl.textContent = '設定匯入成功'
    }
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = `設定匯入失敗：${err.message || '未知錯誤'}`
    }
  }
}

// 處理歷史紀錄匯入
export async function handleRecordsImport(jsonTextArray) {
  const resultEl = document.getElementById('records-import-result')
  try {
    if (!Array.isArray(jsonTextArray) || jsonTextArray.length === 0) {
      if (resultEl) resultEl.textContent = '請選擇要匯入的檔案'
      return
    }

    const allDays = []
    for (const text of jsonTextArray) {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        allDays.push(...parsed)
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.days)) {
        allDays.push(...parsed.days)
      } else if (parsed && typeof parsed === 'object' && parsed.date && parsed.tasks) {
        allDays.push(parsed)
      } else {
        throw new Error('匯入資料格式不符合日檔或打包格式')
      }
    }

    const { added, skipped } = await importRecords(allDays)
    if (resultEl) {
      resultEl.textContent = `已新增 ${added} 筆、略過 ${skipped} 筆`
    }
    await renderStorageStats()
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = `歷史紀錄匯入失敗：${err.message || '格式不符'}`
    }
  }
}
