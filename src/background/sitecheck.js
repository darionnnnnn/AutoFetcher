// AutoFetcher 每日站台健康檢查（SPEC §4.2）
import { getSites, getSettings } from '../shared/storage.js'
import { setTaskHealth, refreshBadge } from './health.js'
import { nextDailyRun } from './scheduler.js'
import { notify } from './notify.js'
import { ensureLoggedIn } from './login.js'

// 短暫等待輔助函式
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 排定每日站台健康檢查的 alarm
export async function scheduleSiteCheck() {
  const settings = await getSettings()
  const time = settings?.siteCheckTime || '08:00'
  const when = nextDailyRun(Date.now(), [time], [0, 1, 2, 3, 4, 5, 6])
  if (when !== null) {
    await chrome.alarms.create('__sitecheck', { when })
  }
}

// 執行每日站台健康檢查
export async function runSiteCheck(opts = {}) {
  const pollMs = opts?.pollMs ?? 250
  const loadTimeoutMs = opts?.loadTimeoutMs ?? 30000

  const sites = await getSites()

  for (const [origin, site] of Object.entries(sites)) {
    if (!site || site.enabled === false) continue

    let tab = null
    try {
      tab = await chrome.tabs.create({ url: site.loginUrl, active: false, autoDiscardable: false })
      let tabInfo = await chrome.tabs.get(tab.id)
      const loadStart = Date.now()
      while (tabInfo?.status !== 'complete' && Date.now() - loadStart < loadTimeoutMs) {
        await sleep(pollMs)
        tabInfo = await chrome.tabs.get(tab.id)
      }

      const res = await ensureLoggedIn(tab.id, { url: site.loginUrl }, opts)
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
    } finally {
      if (tab?.id) {
        try {
          await chrome.tabs.remove(tab.id)
        } catch {}
      }
    }
  }

  await refreshBadge()
}
