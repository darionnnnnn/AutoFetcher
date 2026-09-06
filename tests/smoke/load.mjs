// 真實瀏覽器煙霧測試:把擴充功能載入 Chrome / Edge,確認能跑起來且沒有 console 錯誤。
// 用法:node tests/smoke/load.mjs            (預設 Chrome)
//       BROWSER_PATH="/path/to/Edge" node tests/smoke/load.mjs
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import http from 'node:http'
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
  // 只算正式排程：預檢（:pre:）與重試（:retry:）都不是。
  // 測試在 09:00/15:00 兩個時間點附近跑時，任務可能真的觸發並排出重試 alarm。
  const taskAlarms = names.filter(n => n.includes('smoke-1') && !n.includes(':pre:') && !n.includes(':retry:'))
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
  // 4. 報表頁真的看得到資料(使用者的核心需求:打開就直接看)
  const today = new Date()
  const pad = n => String(n).padStart(2, '0')
  const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  await ext.evaluate(async (d) => {
    await chrome.storage.local.set({
      ['rec:' + d]: [
        { taskId: 'smoke-1', slot: d + 'T09:00', capturedAt: d + 'T09:00:05+08:00', value: 1234, raw: '1,234', status: 'ok' },
        { taskId: 'smoke-1', slot: d + 'T15:00', capturedAt: d + 'T15:00:05+08:00', raw: '--', status: 'parse_error' }
      ]
    })
  }, dateStr)
  await ext.goto(`chrome-extension://${extId}/ui/report/report.html#view=history&from=${dateStr}&to=${dateStr}`,
    { waitUntil: 'domcontentloaded' })
  await new Promise(r => setTimeout(r, 1200))
  const view = await ext.evaluate(() => ({
    rows: document.querySelectorAll('#record-table tbody tr:not(.detail)').length,
    text: document.body.innerText,
    emptyHidden: document.getElementById('empty-state')?.hidden
  }))
  if (view.rows !== 2) errors.push(`報表應顯示 2 筆紀錄,實際 ${view.rows} 列`)
  if (!view.text.includes('1,234')) errors.push('報表沒有顯示抓到的值 1,234')
  if (/(^|[^\d])0([^\d]|$)/.test(view.text.split('\n').find(l => l.includes('--')) || '')) {
    errors.push('抓不到的紀錄被顯示成 0')
  }
  if (view.emptyHidden !== true) errors.push('有資料時空狀態沒有隱藏')
  if (view.rows === 2) console.log(`${browserName}:報表顯示 2 筆紀錄,含 1,234 與失敗列`)

  // 5. 真實注入:在一個真的網頁上注入 content script 並擷取(D1 的守門)
  //    這一段是本專案唯一抓得到「content script 根本沒載入」的手段——
  //    單元測試用 jsdom 直接 import 模組,永遠不會踩到 classic script 不支援 import 的問題。
  const fixtureHtml = `<!doctype html><meta charset="utf-8">
<div id="v">1,234</div>
<table id="t"><thead><tr><th>日期</th><th>數量</th></tr></thead>
<tbody><tr><td>09-01</td><td>10</td></tr><tr><td>09-02</td><td>32</td></tr></tbody></table>`
  const loginHtml = `<!doctype html><meta charset="utf-8">
<form><input id="u"><input id="p" type="password"><button id="go" type="button">送出</button></form>
<script>document.getElementById('go').onclick = () => {
  document.title = document.getElementById('u').value + '/' + document.getElementById('p').value
}</script>`
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(req.url.startsWith('/login') ? loginHtml : fixtureHtml)
  })
  await new Promise(r => server.listen(48123, '127.0.0.1', r))

  const pageUnderTest = await browser.newPage()
  const targetErrors = []
  pageUnderTest.on('pageerror', e => targetErrors.push(String(e)))
  await pageUnderTest.goto('http://127.0.0.1:48123/', { waitUntil: 'load' })

  const ext2 = await browser.newPage()
  await ext2.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  const injectResult = await ext2.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:48123/*' })
    if (tabs.length === 0) return { error: '找不到目標分頁' }
    const tabId = tabs[0].id
    const out = {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (url) => import(url),
        args: [chrome.runtime.getURL('content/main.js')]
      })
    } catch (e) { out.injectError = String(e) }
    try {
      out.extract = await chrome.tabs.sendMessage(tabId, {
        type: 'EXTRACT',
        locator: { css: '#v', path: '', anchor: null, xpath: '' },
        spec: { strategy: 'auto' }
      })
    } catch (e) { out.extractError = String(e) }
    try {
      await chrome.notifications.create('smoke-notify', {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: 'AutoFetcher', message: '煙霧測試'
      })
      out.notifyOk = true
    } catch (e) { out.notifyError = String(e) }
    return out
  })

  for (const e of targetErrors) errors.push(`目標頁注入後有錯誤:${e}`)
  if (injectResult.injectError) errors.push(`注入失敗:${injectResult.injectError}`)
  if (injectResult.extractError) errors.push(`擷取失敗(content script 沒載入?):${injectResult.extractError}`)
  if (injectResult.extract?.ok !== true) {
    errors.push(`擷取沒有成功:${JSON.stringify(injectResult.extract)}`)
  } else if (injectResult.extract.value !== 1234) {
    errors.push(`擷取到的值應為 1234,實際 ${injectResult.extract.value}`)
  } else {
    console.log(`${browserName}:真實網頁注入並擷取成功 (value=${injectResult.extract.value})`)
  }
  if (injectResult.notifyError) {
    errors.push(`通知發不出去(圖示載不到?):${injectResult.notifyError}`)
  } else {
    console.log(`${browserName}:通知送出正常`)
  }

  // 5c. 區塊聚合:對 fixture 的表格取「數量」欄加總（10 + 32 = 42）
  const blockResult = await ext2.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:48123/*' })
    return chrome.tabs.sendMessage(tabs[0].id, {
      type: 'EXTRACT',
      locator: { css: '#t', path: '', anchor: null, xpath: '' },
      spec: { mode: 'block', block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum' } }
    })
  })
  if (blockResult?.ok !== true) {
    errors.push(`區塊聚合失敗:${JSON.stringify(blockResult)}`)
  } else if (blockResult.value !== 42) {
    errors.push(`區塊聚合應得 42,實得 ${blockResult.value}`)
  } else {
    console.log(`${browserName}:區塊聚合正常 (數量欄加總 = ${blockResult.value})`)
  }

  // 5b. 選取模式:真的在網頁上畫出 overlay,離開時收乾淨
  const pickResult = await ext2.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:48123/*' })
    const tabId = tabs[0].id
    const out = {}
    await chrome.tabs.sendMessage(tabId, { type: 'ENTER_PICK', purpose: 'task' })
    const probe = () => chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        overlay: !!document.querySelector('[data-af-overlay]'),
        panel: (document.querySelector('[data-af-panel]')?.textContent || '').slice(0, 60)
      })
    }).then(r => r[0].result)
    out.during = await probe()
    await chrome.tabs.sendMessage(tabId, { type: 'EXIT_PICK' })
    out.after = await probe()
    return out
  })
  if (!pickResult.during?.overlay) errors.push('進入選取模式後頁面上沒有 overlay')
  if (pickResult.after?.overlay) errors.push('離開選取模式後 overlay 沒有移除')
  if (!pickResult.during?.panel) errors.push('選取模式面板沒有文字')
  if (pickResult.during?.overlay && !pickResult.after?.overlay) {
    console.log(`${browserName}:選取模式進出正常 (面板:${pickResult.during.panel.split('\n')[0]})`)
  }

  // 5d. 自動登入:content 真的填得進欄位並按得到送出鈕
  const loginPage = await browser.newPage()
  await loginPage.goto('http://127.0.0.1:48123/login', { waitUntil: 'load' })
  const loginResult = await ext2.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:48123/login*' })
    const tabId = tabs[0].id
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (url) => import(url),
      args: [chrome.runtime.getURL('content/main.js')]
    })
    const filled = await chrome.tabs.sendMessage(tabId, {
      type: 'FILL_LOGIN',
      selectors: {
        user: { css: '#u', path: '', anchor: null, xpath: '' },
        pass: { css: '#p', path: '', anchor: null, xpath: '' },
        submit: { css: '#go', path: '', anchor: null, xpath: '' }
      },
      username: 'wayne',
      password: 'hunter2'
    })
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ title: document.title, user: document.getElementById('u').value })
    })
    return { filled, page: probe[0].result }
  })
  if (loginResult.filled?.ok !== true) {
    errors.push(`自動登入填不進去:${JSON.stringify(loginResult.filled)}`)
  } else if (loginResult.page.user !== 'wayne') {
    errors.push(`帳號欄沒填到:${JSON.stringify(loginResult.page)}`)
  } else if (loginResult.page.title !== 'wayne/hunter2') {
    errors.push(`送出鈕沒被按到(標題應為 wayne/hunter2):${loginResult.page.title}`)
  } else {
    console.log(`${browserName}:自動登入填入與送出正常`)
  }
  await loginPage.close()

  await ext2.close()
  await pageUnderTest.close()
  await new Promise(r => server.close(r))

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
