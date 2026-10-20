// AF-23 F1 edit-preview workflow through the real query editor UI.
// Run: BROWSER_PATH=/path/to/chrome node tests/smoke/af23_edit_flow.mjs
import puppeteer from 'puppeteer-core'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'

const SRC = resolve(process.env.AF23_EXTENSION_PATH || 'src')
const CHROME = process.env.BROWSER_PATH
const HEADLESS = process.env.AF23_HEADLESS === '1'
const OUT = resolve('work/af23-edit-flow.json')
const HISTORY = resolve('work/af23-edit-flow-runs.jsonl')
const TASK_ID = 'af23-edit-flow-fixture'
const wait = ms => new Promise(done => setTimeout(done, ms))
const bounded = async (label, fn, ms = 30000) => {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms) })
    ])
  } finally { clearTimeout(timer) }
}

const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>AF23 edit preview fixture</title>
<main><h1>本機試抓資料</h1><output id="target">42</output></main>`
const originalTask = url => ({
  id: TASK_ID, name: '電表讀數', url, mode: 'number', enabled: false,
  locator: { css: '#target' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  preActions: [{ type: 'waitFor', locator: { css: '#never-ready' }, timeoutMs: 200 }]
})

let server
let browser
let profile
let fixtureUrl
let fixtureRequests = []
let mouseClicks = 0
let controlEdits = 0
const pageVisits = []

function recordVisit(target) {
  target.page().then(page => {
    if (!page) return
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) pageVisits.push({ url: frame.url(), at: new Date().toISOString() })
    })
  }).catch(() => {})
}

async function startFixture() {
  server = http.createServer((req, res) => {
    fixtureRequests.push({ path: req.url, at: new Date().toISOString() })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(fixtureHtml)
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  fixtureUrl = `http://127.0.0.1:${server.address().port}/`
}

async function launch() {
  profile = mkdtempSync(join(os.tmpdir(), 'af23-edit-flow-'))
  browser = await bounded('launch isolated CfT', () => puppeteer.launch({
    executablePath: CHROME, headless: HEADLESS, userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  }), 45000)
  browser.on('targetcreated', recordVisit)
  const worker = await bounded('extension worker', async () => {
    for (let i = 0; i < 120; i++) {
      const target = browser.targets().find(item => item.type() === 'service_worker' && item.url().includes('/background/main.js'))
      if (target) return target
      await wait(100)
    }
    throw new Error('extension service worker not found')
  }, 15000)
  return new URL(worker.url()).host
}

async function click(page, selector, clicks = 1) {
  const element = await page.$(selector)
  if (!element) throw new Error(`missing control ${selector}`)
  await element.evaluate(el => el.scrollIntoView({ block: 'center' }))
  const box = await element.boundingBox()
  if (!box) throw new Error(`control is not visible: ${selector}`)
  for (let i = 0; i < clicks; i++) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    mouseClicks++
  }
}

async function editControl(page, selector, value) {
  const element = await page.$(selector)
  if (!element) throw new Error(`missing form control ${selector}`)
  await click(page, selector)
  await element.evaluate(el => el.select())
  await page.keyboard.type(String(value))
  controlEdits++
}

async function fillNativeTime(page, selector, value) {
  const element = await page.$(selector)
  if (!element) throw new Error(`missing time control ${selector}`)
  await click(page, selector)
  await element.evaluate((el, nextValue) => {
    el.value = nextValue
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, String(value))
  controlEdits++
}

async function seedTask(page) {
  await page.evaluate(async task => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    await storage.init()
    await storage.saveTask(task)
  }, originalTask(fixtureUrl))
}

async function storedTask(page) {
  return page.evaluate(async id => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    await storage.init()
    return storage.getTask(id)
  }, TASK_ID)
}

function relevantTask(task) {
  return task && {
    id: task.id, name: task.name, url: task.url, mode: task.mode,
    locator: task.locator, spec: task.spec, schedule: task.schedule, preActions: task.preActions
  }
}

async function performRound(extId, browserPage, round) {
  mouseClicks = 0
  controlEdits = 0
  const visitsAtStart = pageVisits.length
  const requestsAtStart = fixtureRequests.length
  const flowStarted = performance.now()
  const original = originalTask(fixtureUrl)
  await browserPage.goto(`chrome-extension://${extId}/ui/picker/picker.html?taskId=${encodeURIComponent(TASK_ID)}`, { waitUntil: 'domcontentloaded' })
  await browserPage.waitForFunction(() => document.readyState === 'complete' && document.getElementById('name')?.value === '電表讀數')
  await browserPage.waitForSelector('#test-now:not([hidden])')

  await editControl(browserPage, '#name', '電表未儲存名稱')
  await fillNativeTime(browserPage, '#time-input', '10:15')
  await click(browserPage, '#time-add')
  await browserPage.waitForFunction(() => document.getElementById('times')?.value.includes('10:15'))
  const unsavedForm = await browserPage.evaluate(() => ({
    name: document.getElementById('name').value,
    scheduleType: document.getElementById('schedule-type').value,
    times: document.getElementById('times').value,
    preAction: (() => {
      const row = document.querySelector('#preaction-list [data-preaction-row]')
      return { type: row?.querySelector('select')?.value, value: row?.querySelector('input[type="number"]')?.value }
    })()
  }))
  if (unsavedForm.name !== '電表未儲存名稱' || !unsavedForm.times.includes('10:15') || unsavedForm.preAction.type !== 'waitFor') {
    throw new Error(`form edit did not take: ${JSON.stringify(unsavedForm)}`)
  }

  const beforePreview = relevantTask(await storedTask(browserPage))
  const firstTestStarted = performance.now()
  await click(browserPage, '#test-now')
  await browserPage.waitForFunction(() => {
    const preview = document.getElementById('preview')
    return preview && preview.dataset.state === 'error' && document.getElementById('errors')?.textContent.trim()
  }, { timeout: 25000 })
  const failed = await browserPage.evaluate(() => ({
    message: document.getElementById('errors').textContent.trim(),
    state: document.getElementById('preview').dataset.state,
    name: document.getElementById('name').value
  }))
  const afterFailedPreview = relevantTask(await storedTask(browserPage))
  if (JSON.stringify(beforePreview) !== JSON.stringify(afterFailedPreview)) throw new Error('failed preview changed the persisted task')
  if (!failed.message || !failed.message.includes('前置動作') || failed.name !== unsavedForm.name) {
    throw new Error(`failed preview did not retain draft or explain the failed action: ${JSON.stringify(failed)}`)
  }
  const failedPreviewMs = +(performance.now() - firstTestStarted).toFixed(2)

  const actionSelect = '#preaction-list [data-preaction-row] select'
  await click(browserPage, actionSelect)
  // Chromium renders native select options outside the page DOM in headless
  // mode; set the actual control value and emit the normal UI change event.
  await browserPage.$eval(actionSelect, select => {
    select.value = 'wait'
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await browserPage.waitForFunction(selector => document.querySelector(selector)?.value === 'wait', {}, actionSelect)
  controlEdits++
  await editControl(browserPage, '#preaction-list [data-preaction-row] input[type="number"]', '0.02')
  const correctedAction = await browserPage.$eval('#preaction-list [data-preaction-row]', row => ({
    type: row.querySelector('select').value,
    seconds: row.querySelector('input[type="number"]').value
  }))
  if (correctedAction.type !== 'wait' || correctedAction.seconds !== '0.02') throw new Error(`UI correction did not take: ${JSON.stringify(correctedAction)}`)

  const secondTestStarted = performance.now()
  await click(browserPage, '#test-now')
  await browserPage.waitForFunction(() => document.getElementById('preview')?.dataset.state === 'ok' && document.getElementById('preview')?.textContent.trim() === '42', { timeout: 25000 })
  const successful = await browserPage.evaluate(() => ({
    preview: document.getElementById('preview').textContent.trim(),
    state: document.getElementById('preview').dataset.state,
    name: document.getElementById('name').value
  }))
  const afterSuccessfulPreview = relevantTask(await storedTask(browserPage))
  if (JSON.stringify(beforePreview) !== JSON.stringify(afterSuccessfulPreview)) throw new Error('successful preview saved the draft before the Save action')
  if (successful.name !== unsavedForm.name) throw new Error('successful preview lost the unsaved name')
  const successfulPreviewMs = +(performance.now() - secondTestStarted).toFixed(2)

  const saveStarted = performance.now()
  await click(browserPage, '#save')
  await browserPage.waitForSelector('#saved-feedback', { timeout: 15000 })
  const saved = relevantTask(await storedTask(browserPage))
  const expected = {
    id: TASK_ID, name: '電表未儲存名稱', url: fixtureUrl, mode: 'number',
    locator: { css: '#target' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:30', '10:15'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    preActions: [{ type: 'wait', sec: 0.02 }]
  }
  if (!isDeepStrictEqual(saved, expected)) {
    throw new Error(`saved task mismatch\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(saved)}`)
  }

  const saveMs = +(performance.now() - saveStarted).toFixed(2)
  const totalMs = +(performance.now() - flowStarted).toFixed(2)
  return {
    round, status: 'PASS', entryRoute: `?taskId=${TASK_ID}`,
    fixtureDataset: { url: fixtureUrl, targetText: '42', seededTask: original },
    stages: {
      entryAndEditMs: +(totalMs - failedPreviewMs - successfulPreviewMs - saveMs).toFixed(2),
      failedPreviewMs, successfulPreviewMs, saveMs, totalMs
    },
    controls: { mouseClicks, formEdits: controlEdits, visibleSteps: ['未儲存表單編輯', '失敗試抓', '修正前置動作', '成功試抓', '儲存'] },
    pageVisits: pageVisits.slice(visitsAtStart), fixtureRequests: fixtureRequests.slice(requestsAtStart),
    navigationProxy: {
      pickerQueryEntryLoads: pageVisits.slice(visitsAtStart).filter(visit => visit.url.includes('/ui/picker/picker.html?taskId=')).length,
      sourceFixturePageLoads: fixtureRequests.slice(requestsAtStart).filter(request => request.path === '/').length,
      definition: 'HTTP fixture GET / per TEST_TASK is one isolated source-page load/return; picker query entry is separately counted.'
    },
    evidence: {
      unsavedForm, failed, correctedAction, successful,
      persistedBeforeSave: beforePreview, persistedAfterFailedPreview: afterFailedPreview,
      persistedAfterSuccessfulPreview: afterSuccessfulPreview,
      previewsUnchangedPersisted: isDeepStrictEqual(beforePreview, afterFailedPreview) && isDeepStrictEqual(beforePreview, afterSuccessfulPreview),
      persistedAfterSave: saved
    }
  }
}

async function closeBrowser() {
  if (browser) {
    const process = browser.process?.()
    try { await Promise.race([browser.close(), wait(3000)]) } catch {}
    if (process && process.exitCode === null && !process.killed) process.kill()
    browser = null
  }
  if (profile) {
    const temp = resolve(os.tmpdir())
    const path = resolve(profile)
    if (path.startsWith(`${temp}${sep}`) && path.split(/[\\/]/).pop()?.startsWith('af23-edit-flow-')) {
      rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    } else throw new Error(`refused to clean profile outside temp directory: ${path}`)
    profile = null
  }
}

let report = { id: 'AF-23-F1-edit-flow', status: 'FAIL', timestamp: new Date().toISOString(), browser: CHROME || null, browserMode: HEADLESS ? 'headless' : 'headful', extensionPath: SRC, rounds: [] }
try {
  if (!CHROME || !existsSync(CHROME)) throw new Error('Set BROWSER_PATH to a Chrome for Testing executable; normal Chrome is not supported.')
  if (!existsSync(SRC)) throw new Error(`extension source not found: ${SRC}`)
  await startFixture()
  const extId = await launch()
  const setup = await browser.newPage()
  await setup.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  await setup.waitForFunction(() => Boolean(chrome?.runtime?.id))
  await seedTask(setup)
  const editor = await browser.newPage()
  await editor.setViewport({ width: 1100, height: 900 })
  report.extensionId = extId
  report.browserVersion = await browser.version()
  for (let round = 1; round <= 2; round++) {
    if (round === 2) await seedTask(setup) // restore the identical fixture before replaying the same UI flow
    report.rounds.push(await performRound(extId, editor, round))
  }
  report.status = 'PASS'
} catch (error) {
  report.error = error?.stack || String(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  report.pageVisits = pageVisits
  report.fixtureRequests = fixtureRequests
  report.requiredClickCount = report.rounds.map(round => ({ round: round.round, mouseClicks: round.controls.mouseClicks, formEdits: round.controls.formEdits }))
  mkdirSync('work', { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
  appendFileSync(HISTORY, `${JSON.stringify(report)}\n`)
  console.log(JSON.stringify({ status: report.status, rounds: report.rounds.length, requiredClickCount: report.requiredClickCount, output: OUT, rawHistory: HISTORY, error: report.error || null }, null, 2))
  await closeBrowser()
  if (server) await new Promise(resolveClose => server.close(resolveClose))
}
