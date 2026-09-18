// AutoFetcher 每日站台健康檢查（SPEC §4.2）
import { getSites, getSettings } from '../shared/storage.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { nextDailyRun } from './scheduler.js'
import { notify } from './notify.js'
import { ensureLoggedIn } from './login.js'
import { enqueueForOrigin, acquireFetchTab } from './fetch-tab.js'

// 排定每日站台健康檢查的 alarm
export async function scheduleSiteCheck() {
  const settings = await getSettings()
  const time = settings?.siteCheckTime || '08:00'
  const when = nextDailyRun(Date.now(), [time], [0, 1, 2, 3, 4, 5, 6])
  if (when !== null) {
    await chrome.alarms.create('__sitecheck', { when })
  }
}

// 確認每日站台檢查的 alarm 還在；不在才補建（看門狗每 15 分鐘呼叫，不能每次都把時間往後推）
export async function ensureSiteCheck() {
  const existing = await chrome.alarms.get('__sitecheck')
  if (existing) return
  await scheduleSiteCheck()
}

// 執行每日站台健康檢查
export async function runSiteCheck(opts = {}) {
  const pollMs = opts?.pollMs ?? 250
  const loadTimeoutMs = opts?.loadTimeoutMs ?? 30000

  const sites = await getSites()

  for (const [origin, site] of Object.entries(sites)) {
    if (!site || site.enabled === false) continue

    try {
      // 與抓取走同一條同站台佇列與同一個專用視窗（AF-20）：
      // 登入檢查會填表單、按送出，和同站台的抓取同時操作就會互相踩到登入狀態。
      // 一律重新載入登入頁，並標記頁面被動過，排在後面的抓取才會先重載。
      const res = await enqueueForOrigin(origin, async (holder) => {
        const tabId = await acquireFetchTab(holder, site.loginUrl, { pollMs, loadTimeoutMs, freshLoad: true })
        holder.pageDirty = true
        return ensureLoggedIn(tabId, { url: site.loginUrl }, opts)
      })
      if (res?.ok === true) {
        await setTaskHealth('site:' + origin, { status: 'ok' })
      } else {
        const reason = res?.reason || '無法登入'
        await setTaskHealth('site:' + origin, { status: 'login_failed', reason })
        await notify('site:' + origin + ':check', {
          title: 'AutoFetcher 站台健康檢查失敗',
          message: `站台「${origin}」登入檢查失敗：${reason}。`
        })
      }
    } catch (err) {
      const reason = err?.message || '檢查失敗'
      await setTaskHealth('site:' + origin, { status: 'login_failed', reason })
      await notify('site:' + origin + ':check', {
        title: 'AutoFetcher 站台健康檢查失敗',
        message: `站台「${origin}」檢查過程發生錯誤：${reason}。`
      })
    }
  }

  await refreshBadge()
}
