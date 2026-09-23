// AF-22 A1/G targeted browser check.
// This is intentionally independent from load.mjs: a missing browser or a
// launch failure is a blocking result, never a passing SKIP.
import puppeteer from 'puppeteer-core'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../src')
const WINDOWS_BROWSER_CANDIDATES = process.platform === 'win32'
  ? [
      process.env['ProgramFiles(x86)'] && resolve(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
      process.env.ProgramFiles && resolve(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
      process.env['ProgramFiles(x86)'] && resolve(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
      process.env.ProgramFiles && resolve(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
      process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe')
    ]
  : []
const browserPath = [process.env.BROWSER_PATH, ...WINDOWS_BROWSER_CANDIDATES].filter(Boolean).find(existsSync)
const browserName = browserPath?.toLowerCase().includes('edge') ? 'Edge' : 'Chrome'
const requestedCase = process.argv.find(arg => arg.startsWith('--case='))?.slice('--case='.length) || 'single'
const validCases = new Set(['single', 'zoom', 'batch', 'all'])
// The fixture's hostile-page mouse handlers deliberately take about five
// seconds per event; allow three minutes per case and eight for the serial suite.
const testDeadline = Date.now() + (requestedCase === 'all' ? 480_000 : 180_000)

function withTimeout(label, operation, timeoutMs = 15000) {
  const remaining = Math.max(1, Math.min(timeoutMs, testDeadline - Date.now()))
  const work = Promise.resolve().then(operation)
  work.catch(() => {})
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT ${label} (${remaining}ms)`)), remaining)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

async function step(label, operation, timeoutMs = 15000) {
  const started = Date.now()
  console.log(`[step:start] ${label}`)
  const result = await withTimeout(label, operation, timeoutMs)
  console.log(`[step:done] ${label} (${Date.now() - started}ms)`)
  return result
}

async function settle(operation, timeoutMs = 2500) {
  try { await Promise.race([Promise.resolve().then(operation), new Promise(resolve => setTimeout(resolve, timeoutMs))]) } catch {}
}

async function removeProfileBounded(path) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 })
      return true
    } catch (error) {
      if (attempt === 6) {
        console.error(`WARN:無法在有界重試內移除暫存瀏覽器 profile (${error?.code || error})：${path}`)
        return false
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250 * attempt))
    }
  }
  return false
}

async function waitForExtensionWorker(instance) {
  const deadline = Math.min(testDeadline, Date.now() + 20_000)
  let targets = []
  while (Date.now() < deadline) {
    targets = instance.targets().map(target => ({ type: target.type(), url: target.url() }))
    const workerTarget = instance.targets().find(target =>
      target.type() === 'service_worker' && target.url().includes('/background/main.js')
    )
    if (workerTarget) return workerTarget
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error(`等待 ${browserName} 擴充 service worker 逾時；目前瀏覽器 targets：${JSON.stringify(targets)}`)
}

const fixture = `<!doctype html>
<meta charset="utf-8">
<title>AF22 hostile picker fixture</title>
<style>
  /* Representative host reset from A1: buttons become unreadable and tiny. */
  button, [role="button"] {
    all: unset !important;
    display: block !important;
    width: 0 !important;
    min-width: 0 !important;
    height: 0 !important;
    min-height: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    color: transparent !important;
    font-size: 0 !important;
    line-height: 0 !important;
    cursor: default !important;
  }
  body { margin: 0; min-width: 900px; font: 16px/1.4 sans-serif; }
  header { height: 120px; background: #eee; padding: 16px; }
  .long { height: 1800px; padding: 16px; }
  table { border-collapse: collapse; margin: 20px 0; background: white; }
  td, th { border: 1px solid #777; padding: 12px 28px; min-width: 120px; }
  .spacer { height: 900px; }
</style>
<header>Hostile page controls and a long page</header>
<main class="long">
  <table id="single"><thead><tr><th>名稱</th><th>數值</th></tr></thead><tbody><tr><td>單值</td><td>101</td></tr></tbody></table>
  <table id="multi-a"><tbody><tr><td>批次 A</td><td>201</td></tr></tbody></table>
  <table id="multi-b"><tbody><tr><td>批次 B</td><td>202</td></tr></tbody></table>
  <div class="spacer">long content</div>
</main>`

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

async function waitForOverlay(page) {
  await step('waitForOverlay.selector', () => page.waitForSelector('[data-af-overlay] [data-af-done]', { timeout: 20000 }), 25000)
  await new Promise(resolveWait => setTimeout(resolveWait, 120))
}

async function tabIdOf(extPage, url) {
  return step('tabs.query target', () => extPage.evaluate(async (match) => {
    const tabs = await chrome.tabs.query({ url: `${match}*` })
    if (!tabs[0]) throw new Error(`找不到目標分頁: ${match}`)
    return tabs[0].id
  }, url))
}

async function injectPicker(extPage, tabId) {
  const result = await step('inject content/main.js', () => extPage.evaluate(async (id) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          if (window.__af22SendMessageProbe) return
          const send = chrome.runtime.sendMessage.bind(chrome.runtime)
          chrome.runtime.sendMessage = (message, ...args) => {
            const pending = send(message, ...args)
            Promise.resolve(pending).then(
              response => console.info(`AF22 runtime response ${message?.type || ''}: ${JSON.stringify(response)}`),
              error => console.error(`AF22 runtime rejection ${message?.type || ''}: ${String(error?.message || error)}`)
            )
            return pending
          }
          window.__af22SendMessageProbe = true
        }
      })
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: (url) => import(url),
        args: [chrome.runtime.getURL('content/main.js')]
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }, tabId))
  if (!result.ok) throw new Error(`注入 content/main.js 失敗: ${result.error}`)
}

async function sendToTarget(extPage, tabId, message) {
  const result = await step(`send ${message.type}`, () => extPage.evaluate(async ({ id, msg }) => {
    try {
      return await chrome.tabs.sendMessage(id, msg)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }, { id: tabId, msg: message }))
  if (result?.ok === false && result.error) throw new Error(`content message ${message.type} 失敗: ${result.error}`)
  return result
}

async function panelStats(page) {
  return step('panel stats evaluate', () => page.evaluate(() => {
    const done = document.querySelector('[data-af-done]')
    const panel = document.querySelector('[data-af-panel]')
    if (!done || !panel) return null
    const r = done.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    const style = getComputedStyle(done)
    return {
      text: done.textContent,
      width: r.width,
      height: r.height,
      fontSize: style.fontSize,
      color: style.color,
      display: style.display,
      pointerEvents: style.pointerEvents,
      panelLeft: p.left,
      panelRight: p.right,
      panelCorner: panel.style.left ? 'left' : 'right'
    }
  }))
}

async function approachFromBothSides(page) {
  const initial = await panelStats(page)
  if (!initial) throw new Error('找不到完成鈕')
  const paths = []
  for (const side of ['left', 'right']) {
    console.log(`    approach ${side} start`)
    const button = await step(`mouse.${side}.findButton`, () => page.$('[data-af-done]'))
    const box = await step(`mouse.${side}.boundingBox`, () => button.boundingBox())
    if (!box) throw new Error(`${side} 路徑開始前完成鈕沒有尺寸`)
    console.log(`    ${side} box ${JSON.stringify(box)}`)
    const width = await step(`mouse.${side}.viewport`, () => page.evaluate(() => innerWidth))
    const startX = side === 'left' ? 4 : Math.max(4, width - 4)
    const y = box.y + box.height / 2
    await step(`mouse.${side}.move.start (${startX},${y})`, () => page.mouse.move(startX, y), 30000)
    // One direct segment per side is enough to exercise the real cursor path;
    // each mouse event is intentionally bounded because this fixture's hostile
    // page makes the content handler take about five seconds to settle.
    for (let i = 1; i <= 1; i++) {
      const x = startX + (box.x + box.width / 2 - startX) * i
      await step(`mouse.${side}.move.${i} (${x},${y})`, () => page.mouse.move(x, y), 30000)
    }
    const after = await panelStats(page)
    if (!after) throw new Error(`${side} 路徑後完成鈕消失`)
    if (after.panelCorner !== initial.panelCorner || Math.abs(after.panelLeft - initial.panelLeft) > 1 || Math.abs(after.panelRight - initial.panelRight) > 1) {
      throw new Error(`${side} 路徑讓面板換邊: ${JSON.stringify({ initial, after })}`)
    }
    paths.push({ side, panelCorner: after.panelCorner, panelLeft: after.panelLeft, panelRight: after.panelRight })
  }
  return paths
}

async function prepareStorageProbe(extPage, tabId) {
  await step('storage probe install', () => extPage.evaluate((id) => {
    // Install one listener for the lifetime of the extension page. Replacing
    // the function per case leaves older closures registered and counts each
    // storage event multiple times.
    if (!window.__af22StorageListener) {
      window.__af22StorageListener = (changes, area) => {
        if (area === 'session' && window.__af22StorageKey && changes[window.__af22StorageKey]) {
          window.__af22PanelChanges.push(changes[window.__af22StorageKey])
        }
      }
      chrome.storage.onChanged.addListener(window.__af22StorageListener)
    }
    window.__af22StorageKey = `panel:${id}`
    window.__af22PanelChanges = []
  }, tabId))
}

async function resetCaseContext(extPage, tabId) {
  await step('reset case storage probe', () => extPage.evaluate(() => { window.__af22PanelChanges = [] }))
  await clearPanelContext(extPage, tabId)
}

async function clearPanelContext(extPage, tabId) {
  await step('clear previous panel context', () => extPage.evaluate(async id => {
    await chrome.storage.session.remove(`panel:${id}`)
  }, tabId))
}

async function panelResult(extPage, tabId) {
  await settle(() => extPage.waitForFunction(async id => {
    const value = (await chrome.storage.session.get(`panel:${id}`))[`panel:${id}`]
    return value !== undefined
  }, { timeout: 12000 }, tabId), 12500)
  return step('panel result evaluate', () => extPage.evaluate(async (id) => {
    const value = (await chrome.storage.session.get(`panel:${id}`))[`panel:${id}`]
    return { value, changes: window.__af22PanelChanges?.length || 0 }
  }, tabId))
}

async function runSingle(target, extPage, tabId, zoom) {
  console.log(`開始 single ${zoom ? '實際 tab zoom 200%' : '100%'} ...`)
  await step('target.setViewport', () => target.setViewport({ width: zoom ? 1000 : 560, height: zoom ? 800 : 420, deviceScaleFactor: 1 }))
  await resetCaseContext(extPage, tabId)
  await step('target.reload', () => target.reload({ waitUntil: 'load' }), 8000)
  console.log('  reloaded')
  const zoomInfo = await step('tabs.setZoom/getZoom', () => extPage.evaluate(async ({ id, level }) => {
    await chrome.tabs.setZoom(id, level ? 2 : 1)
    return { tabZoom: await chrome.tabs.getZoom(id) }
  }, { id: tabId, level: zoom }))
  console.log(`  tabZoom=${zoomInfo.tabZoom}`)
  if (zoom && zoomInfo.tabZoom !== 2) throw new Error(`tab zoom 應為 2，實際 ${zoomInfo.tabZoom}`)
  await injectPicker(extPage, tabId)
  console.log('  injected')
  await sendToTarget(extPage, tabId, { type: 'ENTER_PICK', purpose: 'task' })
  console.log('  entered')
  await waitForOverlay(target)
  console.log('  overlay')
  const firstViewport = await step('viewport evaluate', () => target.evaluate(() => ({ innerWidth, innerHeight, scale: window.visualViewport?.scale || 1 })))
  console.log(`  viewport=${JSON.stringify(firstViewport)}`)
  const first = await panelStats(target)
  if (!first || first.text !== '完成' || first.width <= 0 || first.height <= 0 || first.fontSize === '0px' || first.color === 'rgba(0, 0, 0, 0)') {
    throw new Error(`完成鈕 hostile CSS 檢查失敗: ${JSON.stringify(first)}`)
  }
  await step('scroll single table', () => target.evaluate(() => document.querySelector('#single').scrollIntoView({ block: 'start' })))
  console.log('  scrolled')
  // At the deliberately short/narrow viewport the fixed panel overlaps the
  // right-hand cell; choose the left cell so the test exercises a real page
  // click rather than clicking through the panel.
  const cell = await step('single.findCell', () => target.$('#single tbody td:first-child'))
  const cellBox = await step('single.cellBoundingBox', () => cell.boundingBox())
  if (!cellBox) throw new Error('single cell has no bounding box')
  const cellPoint = { x: cellBox.x + cellBox.width / 2, y: cellBox.y + cellBox.height / 2 }
  console.log(`  single cell box=${JSON.stringify(cellBox)} point=${JSON.stringify(cellPoint)}`)
  await step(`single.mouse.move (${cellPoint.x},${cellPoint.y})`, () => target.mouse.move(cellPoint.x, cellPoint.y), 30000)
  await step(`single.mouse.click (${cellPoint.x},${cellPoint.y})`, () => target.mouse.click(cellPoint.x, cellPoint.y), 30000)
  console.log('  selected click')
  const selected = await step('single.selected evaluate', () => target.evaluate(() => document.querySelectorAll('[data-af-picked]').length))
  if (selected !== 1) {
    const debug = await step('single.failureHitTest evaluate', () => target.evaluate(({ x, y }) => ({
      x, y,
      hit: document.elementFromPoint(x, y)?.outerHTML?.slice(0, 160),
      panel: document.querySelector('[data-af-panel]')?.textContent?.slice(0, 240),
      overlays: document.querySelectorAll('[data-af-overlay]').length,
      buttons: document.querySelectorAll('[data-af-done]').length
    }), cellPoint))
    throw new Error(`單任務點選後應有 1 格，實際 ${selected}: ${JSON.stringify(debug)}`)
  }
  await prepareStorageProbe(extPage, tabId)
  const paths = await approachFromBothSides(target)
  console.log('  approached')
  const done = await step('single.findDone', () => target.$('[data-af-done]'))
  const doneBox = await step('single.doneBoundingBox', () => done.boundingBox())
  if (!doneBox) throw new Error('single done button has no bounding box')
  const donePoint = { x: doneBox.x + doneBox.width / 2, y: doneBox.y + doneBox.height / 2 }
  console.log(`  done box=${JSON.stringify(doneBox)} point=${JSON.stringify(donePoint)}`)
  await step(`single.mouse.clickDone (${donePoint.x},${donePoint.y})`, () => target.mouse.click(donePoint.x, donePoint.y), 30000)
  console.log('  done click')
  await step('single.waitExit', () => target.waitForFunction(() => !document.querySelector('[data-af-overlay]'), { timeout: 20000 }), 25000)
  await new Promise(resolveWait => setTimeout(resolveWait, 500))
  const result = await panelResult(extPage, tabId)
  if (result.changes !== 1 || result.value?.kind !== 'new' || !result.value?.ctx) {
    throw new Error(`單任務完成應只寫一次 panel: ${JSON.stringify(result)}`)
  }
  console.log(`完成 single ${zoom ? '實際 tab zoom 200%' : '100%'}`)
  const browserScale = await step('viewport scale evaluate', () => target.evaluate(() => window.visualViewport?.scale || 1))
  return { zoom, tabZoom: zoomInfo.tabZoom, browserScale, viewport: firstViewport, button: first, paths, storageChanges: result.changes, picked: result.value.ctx.picks?.length || 0 }
}

async function runBatch(target, extPage, tabId) {
  console.log('開始 legacy batch ...')
  await step('batch.setViewport', () => target.setViewport({ width: 560, height: 420, deviceScaleFactor: 1 }))
  await resetCaseContext(extPage, tabId)
  await step('batch.reload', () => target.reload({ waitUntil: 'load' }), 8000)
  await step('batch.setZoom', () => extPage.evaluate(async id => chrome.tabs.setZoom(id, 1), tabId))
  await injectPicker(extPage, tabId)
  await sendToTarget(extPage, tabId, { type: 'ENTER_PICK', purpose: 'task', batch: true })
  await waitForOverlay(target)
  const first = await panelStats(target)
  if (!first || first.width <= 0 || first.height <= 0 || !first.text.includes('完成')) throw new Error(`批次完成鈕不可見: ${JSON.stringify(first)}`)
  await step('scroll batch table', () => target.evaluate(() => document.querySelector('#multi-a').scrollIntoView({ block: 'start' })))
  for (const selector of ['#multi-a td', '#multi-b td']) {
    const cell = await step(`batch.findCell ${selector}`, () => target.$(selector))
    const box = await step(`batch.cellBoundingBox ${selector}`, () => cell.boundingBox())
    if (!box) throw new Error(`${selector} has no bounding box`)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    console.log(`  ${selector} box=${JSON.stringify(box)} point=${JSON.stringify(point)}`)
    await step(`batch.mouse.move ${selector}`, () => target.mouse.move(point.x, point.y), 30000)
    await step(`batch.mouse.click ${selector}`, () => target.mouse.click(point.x, point.y), 30000)
  }
  const selected = await step('batch.selected evaluate', () => target.evaluate(() => document.querySelectorAll('[data-af-picked]').length))
  if (selected !== 2) throw new Error(`批次點選後應有 2 格，實際 ${selected}`)
  await prepareStorageProbe(extPage, tabId)
  // The left/right cursor-path contract is exercised by the single case;
  // keeping batch focused on the legacy multi-group completion avoids adding
  // eight slow hover events to this independently rerunnable case.
  const done = await step('batch.findDone', () => target.$('[data-af-done]'))
  const doneBox = await step('batch.doneBoundingBox', () => done.boundingBox())
  if (!doneBox) throw new Error('batch done button has no bounding box')
  const donePoint = { x: doneBox.x + doneBox.width / 2, y: doneBox.y + doneBox.height / 2 }
  console.log(`  batch done box=${JSON.stringify(doneBox)} point=${JSON.stringify(donePoint)}`)
  await step(`batch.mouse.clickDone (${donePoint.x},${donePoint.y})`, () => target.mouse.click(donePoint.x, donePoint.y), 30000)
  await step('batch.waitExit', () => target.waitForFunction(() => !document.querySelector('[data-af-overlay]'), { timeout: 20000 }), 25000)
  await new Promise(resolveWait => setTimeout(resolveWait, 500))
  const result = await panelResult(extPage, tabId)
  if (result.changes !== 1 || result.value?.kind !== 'batch' || !Array.isArray(result.value?.items) || result.value.items.length !== 2) {
    throw new Error(`批次完成應只寫一次且有 2 組: ${JSON.stringify(result)}`)
  }
  console.log('完成 legacy batch')
  return { button: first, storageChanges: result.changes, groups: result.value.items.length }
}

if (!validCases.has(requestedCase)) {
  console.error(`BLOCKED:未知 --case=${requestedCase}；此腳本支援 single|zoom|batch|all`)
  process.exit(2)
}
if (!browserPath) {
  console.error('BLOCKED:找不到 Chrome 或 Edge；請設定 BROWSER_PATH 或安裝在標準 Windows 路徑')
  process.exit(2)
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(fixture)
})
let browser
let userDataDir
try {
  const port = await withTimeout('fixture server listen', () => listen(server))
  const url = `http://127.0.0.1:${port}/`
  userDataDir = mkdtempSync(join(os.tmpdir(), 'af22-browser-'))
  browser = await step(`${browserName} launch`, () => puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    dumpio: true,
    userDataDir,
    args: [
      `--disable-extensions-except=${SRC}`,
      `--load-extension=${SRC}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  }), 15000)
  const worker = await step('service worker', () => waitForExtensionWorker(browser), 25000)
  const workerSession = await worker.createCDPSession()
  workerSession.on('Runtime.consoleAPICalled', event => {
    const message = event.args.map(argument => argument.value || argument.description || '').join(' ')
    if (message.startsWith('AF22 observed') || event.type === 'warning' || event.type === 'error') {
      console.log(`[worker:${event.type}] ${message}`)
    }
  })
  workerSession.on('Runtime.exceptionThrown', event => {
    console.error(`[worker:exception] ${event.exceptionDetails.exception?.description || event.exceptionDetails.text}`)
  })
  await workerSession.send('Runtime.enable')
  await workerSession.send('Runtime.evaluate', { expression: `chrome.runtime.onMessage.addListener((message, sender) => console.info('AF22 observed runtime message: ' + JSON.stringify({ type: message?.type, purpose: message?.purpose, tabId: sender?.tab?.id, frameId: sender?.frameId }))); chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && Object.keys(changes).some(key => key.startsWith('panel:'))) console.info('AF22 observed panel storage change: ' + JSON.stringify(Object.keys(changes).filter(key => key.startsWith('panel:')))) })` })
  const extId = new URL(worker.url()).host
  const target = await step('target newPage', () => browser.newPage())
  target.on('console', message => {
    if (message.text().startsWith('AF22 runtime ')) console.log(`[target:${message.type()}] ${message.text()}`)
  })
  target.on('pageerror', error => console.error(`[target:pageerror] ${error}`))
  await step('target initial viewport', () => target.setViewport({ width: 560, height: 420, deviceScaleFactor: 1 }))
  await step('target initial goto', () => target.goto(url, { waitUntil: 'load' }), 8000)
  const extPage = await step('extension newPage', () => browser.newPage())
  await step('extension goto', () => extPage.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' }), 8000)
  const tabId = await tabIdOf(extPage, url)
  const results = { browserPath, extension: extId }
  if (requestedCase === 'single') results.single = await runSingle(target, extPage, tabId, false)
  if (requestedCase === 'zoom') results.zoomed = await runSingle(target, extPage, tabId, true)
  if (requestedCase === 'batch') results.batch = await runBatch(target, extPage, tabId)
  if (requestedCase === 'all') {
    results.single = await runSingle(target, extPage, tabId, false)
    results.zoomed = await runSingle(target, extPage, tabId, true)
    results.batch = await runBatch(target, extPage, tabId)
  }
  console.log(`${browserName} AF22 A1/G ${requestedCase} 通過；${requestedCase === 'batch' ? 'legacy batch 完成一次且有兩組' : '完成鈕左右路徑均未換邊'}；各完成操作只寫一次`)
  console.log(JSON.stringify(results, null, 2))
  console.log('注意：此定向腳本未覆蓋 AF-22 新群組側欄的完整 E2E 流程。')
} catch (error) {
  console.error(`BLOCKED/FAIL: ${browserName} AF22 A1/G 定向測試未完成 (${error?.stack || error})`)
  process.exitCode = 1
} finally {
  if (browser) {
    const process = browser.process?.()
    await settle(() => browser.close(), 3000)
    if (process && process.exitCode === null && !process.killed) {
      process.kill()
      await settle(() => new Promise(resolveExit => process.once('exit', resolveExit)), 3000)
    }
    try { browser.disconnect() } catch {}
  }
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  await settle(() => new Promise(resolveClose => server.close(() => resolveClose())), 2000)
  if (userDataDir) {
    const tempRoot = resolve(os.tmpdir())
    const safeDir = resolve(userDataDir)
    const insideTemp = safeDir.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)
    if (insideTemp && safeDir.split(/[\\/]/).pop()?.startsWith('af22-browser-')) {
      await removeProfileBounded(safeDir)
    } else {
      console.error(`BLOCKED:拒絕刪除非本次 AF22 browser profile: ${safeDir}`)
    }
  }
}
