// AutoFetcher 設定頁邏輯模組 (F4)
import {
  getSettings,
  saveSettings,
  getTasks,
  getStorageStats,
  importRecords,
  getDiagList,
  getSites,
  updateSite,
  deleteSite,
  getHealthMap, deleteHealthEntry,
  countRecordsBeyondRetention, getRecordsInRange } from '../../shared/storage.js'
import { buildExport, download } from '../../shared/export.js'
import { exportSettings, previewSettingsImport, applySettingsImport, numericSettingProblem } from '../../shared/settings-io.js'
import { confirmDialog } from '../modal.js'
import * as diag from '../../shared/diag.js'
import { MSG } from '../../shared/messages.js'
import { statusTextOf, isRed } from '../../shared/record-status.js'
import { applyTheme, applySavedTheme } from '../theme-apply.js'
import { icon } from '../icons.js'

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

// 近 7 天本輪新增的靜默保護各發生幾次（AF-21）：它們平常不打擾使用者，管理的人要看得到有沒有在發生。
// 純函式，測試直接呼叫：diag 取 kind 計數、中斷取紀錄的 interrupted 狀態
export const GUARD_WINDOW_MS = 7 * 86400000
export function countGuardEvents(diagEntries, records, nowMs) {
  const since = nowMs - GUARD_WINDOW_MS
  const recent = (Array.isArray(diagEntries) ? diagEntries : []).filter(e => e && typeof e.at === 'number' && e.at >= since)
  const kinds = (list) => recent.filter(e => list.includes(e.kind)).length
  return {
    interrupted: (Array.isArray(records) ? records : []).filter(r => r?.status === 'interrupted').length,
    lockTimeout: kinds(['lock_timeout']),
    forbidden: kinds(['forbidden']),
    errors: kinds(['alarm_error', 'message_error', 'startup_error'])
  }
}

async function renderGuards() {
  const el = document.getElementById('health-guards')
  if (!el) return
  const now = Date.now()
  const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  let entries = []
  let records = []
  try { entries = await diag.getAll() } catch {}
  try { records = await getRecordsInRange(day(now - GUARD_WINDOW_MS), day(now)) } catch {}
  const c = countGuardEvents(entries, records, now)
  el.textContent = `近 7 天：被瀏覽器中斷 ${c.interrupted} 次、取鎖逾時 ${c.lockTimeout} 次、擋下網頁送來的訊息 ${c.forbidden} 次、背景錯誤 ${c.errors} 次`
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

// 匯出按鈕旁的結果（role=status）；建一次、之後沿用
function exportResultOf(btn) {
  let el = document.getElementById(`${btn.id}-result`)
  if (!el) {
    el = document.createElement('span')
    el.id = `${btn.id}-result`
    el.setAttribute('role', 'status')
    btn.after(el)
  }
  return el
}

// 匯出：download 丟例外（含在另存視窗按取消）或沒回下載 id 都算沒完成；成功才記時間
async function runExport(btn, work, stampKey) {
  const resultEl = exportResultOf(btn)
  resultEl.className = ''
  resultEl.textContent = '匯出中…'
  let id
  try {
    id = await work()
  } catch (e) {
    resultEl.className = 'field-error'
    resultEl.textContent = `匯出沒有完成：${e?.message || e}`
    return
  }
  if (typeof id !== 'number') {
    resultEl.className = 'field-error'
    resultEl.textContent = '匯出沒有完成：瀏覽器沒有開始下載'
    return
  }
  resultEl.className = 'inline-status'
  resultEl.textContent = '已開始下載'
  try {
    await saveSettings({ [stampKey]: new Date().toISOString() })
    await renderStorageStats()
  } catch {}
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

      await runExport(exportRunBtn, async () => download(await buildExport({ from, to, format })), 'lastRecordsExportAt')
    })
  }

  const settingsExportBtn = document.getElementById('settings-export')
  if (settingsExportBtn && !settingsExportBtn._afBound) {
    settingsExportBtn._afBound = true
    settingsExportBtn.addEventListener('click', async () => {
      const includePasswords = document.getElementById('settings-include-passwords')?.checked || false
      const passphrase = document.getElementById('settings-passphrase')?.value || ''
      await runExport(settingsExportBtn, async () => {
        const content = await exportSettings({ includePasswords, passphrase })
        return download({ filename: 'AutoFetcher/autofetcher-settings.json', content })
      }, 'lastSettingsExportAt')
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
      // 自檢沒有專屬結果位置：失敗訊息接在「最近診斷紀錄」最上面（不新增版面）
      let failText = ''
      try {
        const res = await chrome.runtime.sendMessage({ type: MSG.SELF_CHECK })
        if (res && res.ok === false) failText = `自檢失敗：${res.error || '背景處理失敗'}`
      } catch {
        failText = '自檢沒有完成，請再試一次'
      }
      try { await renderDiag() } catch {}
      const diagBox = document.getElementById('health-diag')
      if (failText && diagBox) {
        const row = document.createElement('div')
        row.className = 'selfcheck-result'
        row.textContent = failText
        diagBox.prepend(row)
      }
    })
  }
}

// ---- 欄位就地回饋（AF-21 4-D）：設定頁維持即時生效，每一欄寫入後說清楚存了沒 ----

// 已儲存提示顯示多久
const SAVED_HINT_MS = 2000

// 欄位旁的「已儲存」＋打勾圖示（role=status）與欄位下方的原因（aria-describedby）；建一次、之後沿用
function feedbackOf(el) {
  if (el._afFeedback) return el._afFeedback
  const row = el.closest('.settings-row') || el.parentElement
  const status = document.createElement('span')
  status.className = 'inline-status'
  status.id = `${el.id}-status`
  status.setAttribute('role', 'status')
  const error = document.createElement('div')
  error.className = 'field-error'
  error.id = `${el.id}-error`
  error.hidden = true
  row.appendChild(status)
  row.appendChild(error)
  el.setAttribute('aria-describedby', error.id)
  el._afFeedback = { status, error, timer: null }
  return el._afFeedback
}

function showFieldError(el, text) {
  const fb = feedbackOf(el)
  clearTimeout(fb.timer)
  fb.status.textContent = ''
  fb.error.textContent = text
  fb.error.hidden = false
  el.setAttribute('aria-invalid', 'true')
}

function clearFieldError(el) {
  const fb = feedbackOf(el)
  fb.error.textContent = ''
  fb.error.hidden = true
  el.removeAttribute('aria-invalid')
}

function showFieldSaved(el) {
  const fb = feedbackOf(el)
  clearFieldError(el)
  clearTimeout(fb.timer)
  // 打勾是 SVG 圖示（不用符號字元，AF-21 批次 8）；念出來的是文字「已儲存」
  fb.status.replaceChildren(document.createTextNode('已儲存 '), icon('check', { size: 14 }))
  fb.timer = setTimeout(() => { fb.status.textContent = '' }, SAVED_HINT_MS)
}

// 寫一欄設定：成功顯示「已儲存」、失敗說原因；回傳有沒有寫成
async function persistField(el, patch) {
  try {
    await saveSettings(patch)
  } catch (e) {
    showFieldError(el, `沒有儲存：${e?.message || e}`)
    return false
  }
  showFieldSaved(el)
  return true
}

// 設定頁的「今天」：與看門狗清理用的本地日期同一種算法
function localDateText() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 數值欄：空白或超出值域不寫入、欄位下說原因，離開焦點恢復成上一個有效值（值域與匯入白名單同一份）
// beforeSave(next, prev) 回 false 表示使用者取消（欄位恢復原值、不寫入）
function bindNumericField(el, key, value, beforeSave = null) {
  el.value = value
  el._afLastValid = value
  el._afInvalid = false
  feedbackOf(el)
  if (el._afBound) return
  el._afBound = true
  el.addEventListener('change', async () => {
    const raw = String(el.value).trim()
    const next = raw === '' ? NaN : Number(raw)
    const problem = raw === '' ? '不能空白' : numericSettingProblem(key, next)
    if (problem) {
      el._afInvalid = true
      showFieldError(el, `沒有儲存：${problem}（離開欄位後恢復成 ${el._afLastValid}）`)
      return
    }
    el._afInvalid = false
    clearFieldError(el)
    const prev = el._afLastValid
    if (next === prev) return
    if (beforeSave && !(await beforeSave(next, prev))) {
      el.value = prev
      return
    }
    if (await persistField(el, { [key]: next })) el._afLastValid = next
  })
  el.addEventListener('blur', () => {
    if (!el._afInvalid) return
    el._afInvalid = false
    el.value = el._afLastValid
    el.removeAttribute('aria-invalid')
  })
}

// 保留天數調低：看門狗下一輪就會不可逆地刪，先問（調高不問）
async function confirmRetentionLowered(next, prev) {
  if (!(next < prev)) return true
  let count = 0
  try {
    count = (await countRecordsBeyondRetention(next, localDateText())).count
  } catch {}
  return await confirmDialog({
    title: '調低紀錄保留天數',
    body: `將會刪除 ${next} 天以前的紀錄（約 ${count} 筆），無法復原。`,
    confirmText: '確定調低',
    cancelText: '取消',
    danger: true
  }) === true
}

// 一般欄位（勾選／下拉／時間）：改了就寫，寫完就地回饋
function bindField(el, patchOf, after = null) {
  if (el._afBound) return
  el._afBound = true
  feedbackOf(el)
  el.addEventListener('change', async () => {
    const patch = patchOf()
    if (await persistField(el, patch) && after) after(patch)
  })
}

// 綁定偏好設定控制項事件
function setupPreferenceListeners(settings) {
  const retentionEl = document.getElementById('pref-retention')
  if (retentionEl) bindNumericField(retentionEl, 'retentionDays', settings.retentionDays ?? 365, confirmRetentionLowered)

  const notificationsEl = document.getElementById('pref-notifications')
  if (notificationsEl) {
    notificationsEl.checked = settings.notifications ?? true
    bindField(notificationsEl, () => ({ notifications: Boolean(notificationsEl.checked) }))
  }

  const extraDelayEl = document.getElementById('pref-extra-delay')
  if (extraDelayEl) bindNumericField(extraDelayEl, 'extraDelaySec', settings.extraDelaySec ?? 3)

  // 兩種都不會碰使用者開著的分頁；預設背景分頁（不閃）。「視窗」不佔分頁列，但建立的瞬間可能閃一下（AF-20）
  const fetchTabModeEl = document.getElementById('pref-fetch-tab-mode')
  if (fetchTabModeEl) {
    fetchTabModeEl.value = settings.fetchTabMode === 'window' ? 'window' : 'tab'
    bindField(fetchTabModeEl, () => ({ fetchTabMode: fetchTabModeEl.value }))
  }

  const alertCooldownEl = document.getElementById('pref-alert-cooldown')
  if (alertCooldownEl) bindNumericField(alertCooldownEl, 'alertCooldownMin', settings.alertCooldownMin ?? 60)

  const siteCheckTimeEl = document.getElementById('pref-site-check-time')
  if (siteCheckTimeEl) {
    siteCheckTimeEl.value = settings.siteCheckTime ?? '08:00'
    bindField(siteCheckTimeEl, () => ({ siteCheckTime: siteCheckTimeEl.value }))
  }

  const themeEl = document.getElementById('pref-theme')
  if (themeEl) {
    themeEl.value = settings.theme ?? 'system'
    bindField(themeEl, () => ({ theme: themeEl.value }), (patch) => applyTheme(patch.theme))
  }

  const helpMenuEl = document.getElementById('pref-help-menu')
  if (helpMenuEl) {
    helpMenuEl.checked = settings.showHelpMenu !== false
    bindField(helpMenuEl, () => ({ showHelpMenu: helpMenuEl.checked }))
  }

  const clearPinnedBtn = document.getElementById('clear-pinned-defaults')
  if (clearPinnedBtn && !clearPinnedBtn._afBound) {
    clearPinnedBtn._afBound = true
    clearPinnedBtn.addEventListener('click', async () => {
      const currentSettings = await getSettings()
      if (!currentSettings.pickerDefaults || typeof currentSettings.pickerDefaults !== 'object') {
        return
      }
      const nextDefaults = { ...currentSettings.pickerDefaults }
      delete nextDefaults.pinned
      await saveSettings({ pickerDefaults: nextDefaults })
      const resultEl = document.getElementById('clear-pinned-result') || clearPinnedBtn.nextElementSibling
      if (resultEl) {
        resultEl.textContent = '已清除固定的預設值'
      }
    })
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
      // 在 sites 鎖內以最新站台切換，只改 enabled／failStreak（背景登入同時累加的計數不得被舊副本蓋掉）
      let nextEnabled = null
      await updateSite(origin, (site) => {
        nextEnabled = site.enabled === false
        site.enabled = nextEnabled
        if (nextEnabled) site.failStreak = 0
        return site
      })
      if (nextEnabled === null) return
      if (!nextEnabled) {
        // 停用後不再檢查，舊的失敗狀態要一併拿掉，否則燈號永遠紅著
        await deleteHealthEntry('site:' + origin)
      }
      await renderSitesList()
    } else if (action === 'site-delete') {
      const ok = await confirmDialog({
        title: '刪除站台登入設定',
        body: `確定要刪除「${origin}」的登入設定（含加密保存的密碼）嗎？刪除後排程抓取不會再替這個站台自動登入。`,
        confirmText: '刪除',
        cancelText: '取消',
        danger: true
      })
      if (ok !== true) return
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
    statusEl.className = isEnabled ? 'site-status chip is-ok' : 'site-status chip is-off'
    statusEl.textContent = isEnabled ? '啟用中' : '已停用'
    row.appendChild(statusEl)

    const streakEl = document.createElement('span')
    streakEl.className = 'site-streak'
    streakEl.textContent = `失敗次數：${site.failStreak || 0}`
    row.appendChild(streakEl)

    const healthEl = document.createElement('span')
    healthEl.className = 'site-health'
    const record = healthMap['site:' + origin]
    if (isRed(record)) row.classList.add('failed')
    let healthText = '尚未檢查'
    if (record && record.status) {
      if (record.status === 'ok') {
        healthText = '正常'
      } else if (record.status === 'login_failed') {
        healthText = record.reason || '無法登入'
      } else {
        healthText = record.reason || statusTextOf(record.status)
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
    renderGuards(),
    renderDiag(),
    renderStorageStats(),
    renderSitesList()
  ])

  renderPrivacyNote()
}

// 待確認的設定匯入計畫（選檔後 preview 產生；確認或取消後清掉）
let pendingSettingsImport = null

// 在結果區塊加一行文字
function appendLine(parent, text, className) {
  const el = document.createElement('div')
  if (className) el.className = className
  el.textContent = text
  parent.appendChild(el)
  return el
}

// 在結果區塊加一段「標題＋條列」
function appendList(parent, title, items) {
  appendLine(parent, title)
  const ul = document.createElement('ul')
  for (const text of items) {
    const li = document.createElement('li')
    li.textContent = text
    ul.appendChild(li)
  }
  parent.appendChild(ul)
}

// 設定匯入摘要：新增／覆寫／略過／要重新輸入密碼的站台／被拒絕的設定
function renderImportSummary(resultEl, summary) {
  resultEl.textContent = ''
  const box = document.createElement('div')
  box.className = 'settings-import-summary'
  appendList(box, '內容', [
    `任務：新增 ${summary.tasks.add} 個、覆寫 ${summary.tasks.update} 個、略過 ${summary.tasks.skipped.length} 個`,
    `站台：新增 ${summary.sites.add} 個、覆寫 ${summary.sites.update} 個`,
    `設定：套用 ${summary.settings.applied.length} 項、拒絕 ${summary.settings.rejected.length} 項`,
    summary.layout ? '儀表板版面：會以設定檔的版面取代' : '儀表板版面：不變'
  ])
  if (summary.tasks.skipped.length > 0) {
    appendList(box, '略過的任務', summary.tasks.skipped.map(s => `${s.name}：${s.reason}`))
  }
  if (summary.sites.needPassword.length > 0) {
    appendList(box, `${summary.sites.needPassword.length} 個站台匯入後要重新輸入密碼`, summary.sites.needPassword)
  }
  if (summary.settings.rejected.length > 0) {
    appendList(box, '被拒絕的設定', summary.settings.rejected.map(r => `${r.key}：${r.reason}`))
  }

  // 共用 modal（AF-21 4-D，取代 3-A 暫放在結果區的按鈕）；對話框元素掛在結果區底下，
  // showModal 一律進最上層，掛哪裡不影響顯示；不等它關閉（選檔的處理到此結束）
  const plan = pendingSettingsImport
  confirmDialog({
    title: '即將匯入（尚未寫入）',
    body: box,
    confirmText: '確認匯入',
    cancelText: '取消',
    container: resultEl,
    ids: { confirm: 'settings-import-confirm', cancel: 'settings-import-cancel' }
  }).then((ok) => {
    // 已經被新的一次選檔取代：不動
    if (pendingSettingsImport !== plan) return
    if (ok === true) confirmSettingsImport()
    else cancelSettingsImport()
  })
}

// 處理設定匯入：選檔後只做 preview、顯示摘要與確認／取消（零寫入）
export async function handleSettingsImport(jsonText) {
  const resultEl = document.getElementById('settings-import-result')
  pendingSettingsImport = null
  try {
    const passphraseEl = document.getElementById('settings-passphrase')
    const passphrase = passphraseEl?.value || ''
    const { plan, summary } = await previewSettingsImport(jsonText, { passphrase })
    pendingSettingsImport = plan
    if (resultEl) renderImportSummary(resultEl, summary)
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = `設定匯入失敗：${err.message || '未知錯誤'}`
    }
  }
}

// 取消：零寫入、清掉摘要
export function cancelSettingsImport() {
  pendingSettingsImport = null
  const resultEl = document.getElementById('settings-import-result')
  if (resultEl) resultEl.textContent = ''
  const fileEl = document.getElementById('settings-import-file')
  if (fileEl) fileEl.value = ''
}

// 確認：寫入；成功後重畫整個設定頁（欄位才會顯示匯入後的值），失敗說明已還原
export async function confirmSettingsImport() {
  const plan = pendingSettingsImport
  if (!plan) return
  pendingSettingsImport = null
  const resultEl = document.getElementById('settings-import-result')
  if (resultEl) resultEl.textContent = '匯入中…'
  try {
    await applySettingsImport(plan)
  } catch (err) {
    if (resultEl) {
      const restored = err?.restoreError ? '還原匯入前的設定時也失敗了，請重新整理後檢查' : '已還原成匯入前的設定'
      resultEl.textContent = `設定匯入失敗：${err?.message || '未知錯誤'}；${restored}`
    }
    return
  }
  try {
    await renderSettings()
    // 匯入可能改了主題：當下就套用，不必重新整理頁面
    await applySavedTheme()
  } catch {}
  if (resultEl) resultEl.textContent = '設定匯入成功'
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

    const { added, skipped, invalid = [] } = await importRecords(allDays)
    if (resultEl) {
      resultEl.textContent = `已新增 ${added} 筆、略過 ${skipped} 筆`
      if (invalid.length > 0) {
        appendList(resultEl, '不合格而略過的紀錄（前幾筆）', invalid.map(v => `${v.date} ${v.taskId || '（無 taskId）'}：${v.reason}`))
      }
    }
    await renderStorageStats()
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = `歷史紀錄匯入失敗：${err.message || '格式不符'}`
    }
  }
}
