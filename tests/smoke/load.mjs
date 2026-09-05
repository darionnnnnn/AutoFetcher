// 真實瀏覽器煙霧測試:把擴充功能載入 Chrome / Edge,確認能跑起來且沒有 console 錯誤。
// 用法:node tests/smoke/load.mjs            (預設 Chrome)
//       BROWSER_PATH="/path/to/Edge" node tests/smoke/load.mjs
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../src')

const CANDIDATES = [
  process.env.BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean)

const exe = CANDIDATES.find(p => existsSync(p))
if (!exe) {
  console.log('SKIP:找不到 Chrome 或 Edge 執行檔')
  process.exit(0)
}
const browserName = exe.includes('Edge') ? 'Edge' : 'Chrome'

const errors = []
let browser
try {
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: [
      `--disable-extensions-except=${SRC}`,
      `--load-extension=${SRC}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  })

  // 1. service worker 有起來
  const target = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().includes('background/main.js'),
    { timeout: 20000 }
  )
  const workerUrl = target.url()
  const extId = new URL(workerUrl).host
  console.log(`${browserName}:service worker 已啟動 (${extId})`)

  // 註:MV3 的 service worker 閒置就會被回收,不能靠 worker.evaluate,
  //    所有檢查一律從擴充功能頁面做(頁面同樣有完整的 chrome API)。

  // 2. 三個 UI 頁面都打得開,而且沒有 console 錯誤
  for (const page of ['ui/report/report.html', 'ui/popup/popup.html', 'ui/picker/picker.html']) {
    const p = await browser.newPage()
    const pageErrors = []
    p.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()) })
    p.on('pageerror', e => pageErrors.push(String(e)))
    await p.goto(`chrome-extension://${extId}/${page}`, { waitUntil: 'domcontentloaded' })
    await new Promise(r => setTimeout(r, 800))
    const bodyLen = await p.evaluate(() => document.body.innerText.trim().length)
    if (bodyLen === 0) errors.push(`${page} 畫面是空的`)
    for (const e of pageErrors) errors.push(`${page}: ${e}`)
    console.log(`${browserName}:${page} 開啟正常 (${bodyLen} 字)`)
    await p.close()
  }

  // 3. 端到端:從擴充功能頁面寫任務 → 送訊息給 background → 檢查 alarm 真的建起來
  //    (service worker 不允許動態 import,所以不能在 worker 裡 import 模組)
  const ext = await browser.newPage()
  await ext.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  await ext.evaluate(async () => {
    await chrome.storage.local.set({
      schemaVersion: 1,
      tasks: [{
        id: 'smoke-1', name: '煙霧測試', url: 'https://example.com/',
        mode: 'number', enabled: true, order: 0,
        locator: { css: 'h1', path: '', anchor: null, xpath: '' },
        spec: { mode: 'text' },
        schedule: { type: 'daily', times: ['09:00', '15:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
      }]
    })
    await chrome.runtime.sendMessage({ type: 'REBUILD_ALARMS' })
  })
  await new Promise(r => setTimeout(r, 1500))
  const alarms = await ext.evaluate(() => chrome.alarms.getAll())
  const names = alarms.map(a => a.name)
  // 名稱格式由 scheduler.alarmName / precheck 決定,這裡只要求「每個時間點各有一個正式與一個預檢」
  const taskAlarms = names.filter(n => n.includes('smoke-1') && !n.includes(':pre:'))
  const preAlarms = names.filter(n => n.includes('smoke-1') && n.includes(':pre:'))
  const missing = []
  if (taskAlarms.length !== 2) missing.push(`正式 alarm 應有 2 個,實際 ${taskAlarms.length}`)
  if (preAlarms.length !== 2) missing.push(`預檢 alarm 應有 2 個,實際 ${preAlarms.length}`)
  if (!names.includes('__watchdog')) missing.push('看門狗 alarm 不存在')
  const now = Date.now()
  for (const a of alarms.filter(x => x.name.includes('smoke-1'))) {
    if (!(a.scheduledTime > now)) missing.push(`${a.name} 的觸發時間不在未來`)
    if (a.periodInMinutes) missing.push(`${a.name} 不該用 periodInMinutes(每日排程會漂移)`)
  }
  if (missing.length) {
    errors.push(`缺少 alarm:${missing.join(', ')}(實際有:${names.join(', ') || '無'})`)
  } else {
    console.log(`${browserName}:端到端排程正常 (${names.length} 個 alarm,含正式與預檢)`)
  }
  const manifestVersion = await ext.evaluate(() => chrome.runtime.getManifest().manifest_version)
  if (manifestVersion !== 3) errors.push(`manifest_version 應為 3,實際 ${manifestVersion}`)
  const badge = await ext.evaluate(() => chrome.action.getBadgeText({}))
  console.log(`${browserName}:圖示 badge = ${JSON.stringify(badge)}`)
  await ext.evaluate(() => chrome.storage.local.clear())
  await ext.close()
} catch (e) {
  errors.push(String(e))
} finally {
  if (browser) await browser.close()
}

if (errors.length) {
  console.error(`\n${browserName} 煙霧測試失敗:`)
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log(`\n${browserName} 煙霧測試全部通過`)
