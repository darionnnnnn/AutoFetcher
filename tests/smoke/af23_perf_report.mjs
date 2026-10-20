// AF-23 E1 report UI browser measurement. Run with:
// BROWSER_PATH="/path/to/Chrome for Testing" node tests/smoke/af23_perf_report.mjs
// Fixed seed, isolated Chrome profile, local extension storage only. Writes raw JSON to /tmp
// (or AF23_PERF_OUTPUT); performance numbers come from a real Chromium page, not jsdom.
import puppeteer from 'puppeteer-core'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SRC = resolve(ROOT, 'src')
const SEED = 23012026
const WARM_N = 20
const COLD_N = 5
const FROM_OFFSET = 110
const SCENARIOS = [
  { records: 1_000, cards: 1 },
  { records: 10_000, cards: 10 },
  { records: 100_000, cards: 30 }
]
const CHROME_CANDIDATES = [
  process.env.BROWSER_PATH,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  join(os.homedir(), 'Downloads', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join(os.tmpdir(), 'af22-cft', 'chrome', 'mac-arm64', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join(os.tmpdir(), 'af22-cft', 'chrome', 'win64-154.0.8037.57', 'chrome-win64', 'chrome.exe')
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find(path => existsSync(path))

const pad = n => String(n).padStart(2, '0')
const dateText = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const today = dateText(new Date())
const fromDate = new Date(`${today}T00:00:00`)
fromDate.setDate(fromDate.getDate() - FROM_OFFSET)
const from = dateText(fromDate)
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const p95 = values => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, 18)] ?? 0 // 20 samples: sorted index 18 by nearest-rank p95
const timeout = (promise, label, ms = 45_000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms) })]).finally(() => clearTimeout(timer))
}

function installBrowserInstrumentation() {
  const stats = window.__af23Stats = {
    getCalls: 0, getBytes: 0, recordGetCalls: 0, recordKeyCount: 0,
    setCalls: 0, setBytes: 0, instrumentationErrors: []
  }
  window.__af23NavStart = performance.now()
  window.__af23ExpectedAction = null
  window.__af23Mark = null
  const local = globalThis.chrome?.storage?.local
  if (local) {
    try {
      const get = local.get.bind(local)
      local.get = (...args) => {
        stats.getCalls++
        const keys = args[0]
        if (Array.isArray(keys)) {
          const recordKeys = keys.filter(key => typeof key === 'string' && /^rec2?:/.test(key))
          if (recordKeys.length) {
            stats.recordGetCalls++
            stats.recordKeyCount += recordKeys.length
          }
        }
        const result = get(...args)
        if (result && typeof result.then === 'function') {
          return result.then(value => {
            try { stats.getBytes += new TextEncoder().encode(JSON.stringify(value ?? null)).length } catch {}
            return value
          })
        }
        return result
      }
      const set = local.set.bind(local)
      local.set = (...args) => {
        stats.setCalls++
        try { stats.setBytes += new TextEncoder().encode(JSON.stringify(args[0] ?? null)).length } catch {}
        return set(...args)
      }
    } catch (error) {
      stats.instrumentationErrors.push(`storage: ${String(error)}`)
    }
  } else {
    stats.instrumentationErrors.push('chrome.storage.local unavailable during init')
  }

  const originalAdd = EventTarget.prototype.addEventListener
  const originalRemove = EventTarget.prototype.removeEventListener
  const listeners = new WeakMap()
  let activeListeners = 0
  const captureOf = options => typeof options === 'boolean' ? options : Boolean(options?.capture)
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (listener) {
      let byType = listeners.get(this)
      if (!byType) { byType = new Map(); listeners.set(this, byType) }
      let entries = byType.get(type)
      if (!entries) { entries = []; byType.set(type, entries) }
      const capture = captureOf(options)
      if (!entries.some(entry => entry.listener === listener && entry.capture === capture)) {
        entries.push({ listener, capture })
        activeListeners++
      }
    }
    return originalAdd.call(this, type, listener, options)
  }
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const entries = listeners.get(this)?.get(type)
    const capture = captureOf(options)
    const index = entries?.findIndex(entry => entry.listener === listener && entry.capture === capture) ?? -1
    if (index >= 0) { entries.splice(index, 1); activeListeners-- }
    return originalRemove.call(this, type, listener, options)
  }
  window.__af23ListenerCount = () => activeListeners
  window.__af23Arm = id => { window.__af23ExpectedAction = id; window.__af23Mark = { id, start: null, feedbackMs: null } }
  const markAction = event => {
    const id = window.__af23ExpectedAction
    if (!id) return
    const relevant = event.type === 'click'
      ? event.target?.closest?.('#tab-dashboard, #tab-history, #tab-settings')
      : event.type === 'change' && event.target?.id === 'filter-keyword'
    if (!relevant) return
    const mark = window.__af23Mark = { id, start: performance.now(), feedbackMs: null }
    requestAnimationFrame(frameTime => {
      if (window.__af23Mark === mark) mark.feedbackMs = frameTime - mark.start
    })
    window.__af23ExpectedAction = null
  }
  document.addEventListener('click', markAction, true)
  document.addEventListener('change', markAction, true)
}

const chromeVersion = () => {
  if (!CHROME) return null
  try { return execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).trim() }
  catch (error) { return `unavailable: ${String(error)}` }
}
const gitCommit = () => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() }
  catch { return null }
}
const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('AF-23 report performance fixture')
})
const listen = () => new Promise((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
})

let browser
let profile
let port
const output = {
  schema: 'af23-perf-report-v1',
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  extensionVersion: manifest.version,
  seed: SEED,
  samplePlan: { coldPerScenario: COLD_N, warmPerOperation: WARM_N, percentile: 'warm p95 = sorted sample 19 (1-based); cold reports median and max' },
  environment: { platform: process.platform, arch: process.arch, node: process.version, chromePath: CHROME, chromeVersion: chromeVersion(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  targets: { buttonFeedbackP95Ms: 100, warmFilterAndTabSwitchP95MsFor10k: 300 },
  byteMeasurement: 'UTF-8 byte length of JSON.stringify(storage API payload/result)',
  scenarios: [],
  failures: []
}

async function seedScenario(extPage, scenario, scenarioIndex) {
  const { records, cards } = scenario
  const taskCount = cards
  return extPage.evaluate(async ({ records, taskCount, seed, fromOffset, today }) => {
    const pad = n => String(n).padStart(2, '0')
    const base = new Date(`${today}T00:00:00Z`)
    const dateAt = offset => {
      const d = new Date(base)
      d.setUTCDate(d.getUTCDate() - offset)
      return d.toISOString().slice(0, 10)
    }
    const tasks = Array.from({ length: taskCount }, (_, index) => ({
      id: `af23-report-task-${index}`,
      name: `AF23 任務 ${String(index + 1).padStart(2, '0')}`,
      url: 'https://fixture.invalid/', mode: 'number', enabled: true, order: index,
      spec: { strategy: 'text' }
    }))
    const defaultId = '00000000-0000-4000-8000-000000000001'
    const cards = Array.from({ length: taskCount }, (_, index) => ({
      id: `af23-report-card-${index}`, type: 'number', x: (index % 2) * 6, y: Math.floor(index / 2) * 4,
      w: 6, h: 4, source: [{ taskId: tasks[index].id, aggregation: 'raw' }], options: { period: fromOffset }
    }))
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      schemaVersion: 4,
      tasks,
      layout: { version: 1, lastDashboardId: defaultId, dashboards: [{ id: defaultId, name: 'AF23 Fixture', cards }] },
      settings: { theme: 'system', history: { tableMode: 'list' } }
    })
    const buckets = new Map()
    const latestByTask = Array(taskCount).fill(null)
    for (let i = 0; i < records; i++) {
      const dateOffset = i % (fromOffset + 1)
      const date = dateAt(dateOffset)
      const hour = i % 24
      const minute = Math.floor(i / 24) % 60
      const second = Math.floor(i / (24 * 60)) % 60
      const key = `rec2:${date}:${pad(hour)}`
      if (!buckets.has(key)) buckets.set(key, [])
      const taskIndex = i % taskCount
      const value = ((Math.imul(i + 1, 48271) + seed) >>> 0) % 100000 / 100
      const stamp = `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}+00:00`
      const valueRecord = {
        taskId: tasks[taskIndex].id, capturedAt: stamp, slot: `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
        value, raw: i % 1000 === 0 ? 'af23-match-token' : `seed-${seed}-${i}`,
        status: 'ok'
      }
      buckets.get(key).push(valueRecord)
      const capturedMs = Date.parse(stamp)
      if (!latestByTask[taskIndex] || capturedMs > latestByTask[taskIndex].capturedMs) {
        latestByTask[taskIndex] = { capturedMs, value }
      }
    }
    const entries = [...buckets.entries()]
    for (let offset = 0; offset < entries.length; offset += 25) {
      await chrome.storage.local.set(Object.fromEntries(entries.slice(offset, offset + 25)))
    }
    const readBack = await chrome.storage.local.get(['tasks', 'layout'])
    return {
      taskCount: tasks.length, cardCount: cards.length, storageKeyCount: buckets.size,
      expectedMatches: Math.ceil(records / 1000), fixtureDateCount: fromOffset + 1,
      expectedCardValues: latestByTask.map(value => String(value?.value ?? '—')),
      expectedChecksum: `${records}:${taskCount}:${seed}`, storedCards: readBack.layout.dashboards[0].cards.length
    }
  }, { records, taskCount, seed: SEED + scenarioIndex, fromOffset: FROM_OFFSET, today })
}

async function createReportPage(extId, url) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(installBrowserInstrumentation)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
  await timeout(page.goto(url, { waitUntil: 'domcontentloaded' }), 'open report')
  return { page, pageErrors }
}

async function waitForDashboard(page, expectedCards) {
  await timeout(page.waitForFunction(count => {
    const cards = document.querySelectorAll('#dashboard-grid .report-card').length
    return cards === count && !document.getElementById('panel-dashboard')?.hidden
  }, { timeout: 90_000 }, expectedCards), 'dashboard render', 95_000)
  return page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(time => resolveFrame(time))))
}
async function waitForHistory(page, expectedRecords) {
  await timeout(page.waitForFunction(expected => {
    const panel = document.getElementById('panel-history')
    if (!panel || panel.hidden) return false
    const rows = [...(document.querySelectorAll('#summary tbody tr') || [])]
    const total = rows.reduce((sum, row) => sum + (Number(String(row.children[1]?.textContent || '').replaceAll(',', '').trim()) || 0), 0)
    const tableHasContent = document.querySelectorAll('#record-table tbody tr').length > 0 || document.getElementById('empty-state')?.hidden === false
    return total === expected && tableHasContent
  }, { timeout: 120_000 }, expectedRecords), `history render (${expectedRecords})`, 125_000)
  return page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(time => resolveFrame(time))))
}
async function snapshotStats(page) {
  return page.evaluate(() => ({ ...window.__af23Stats }))
}
async function deltaStats(page, before) {
  const after = await snapshotStats(page)
  return Object.fromEntries(Object.keys(after).map(key => [key, typeof after[key] === 'number' ? after[key] - (before[key] || 0) : after[key]]))
}
async function pageShape(page) {
  return page.evaluate(() => ({
    domNodes: document.querySelectorAll('*').length,
    domEventListeners: window.__af23ListenerCount?.() ?? null,
    propertyEventHandlers: [...document.querySelectorAll('*')].reduce((sum, node) => sum + Object.keys(node).filter(key => /^on[a-z]+$/i.test(key) && typeof node[key] === 'function').length, 0)
  }))
}
async function actionMark(page, id) {
  await page.evaluate(actionId => window.__af23Arm(actionId), id)
}
async function timesFromMark(page, id, resultFrameTime) {
  return page.evaluate(({ id, resultFrameTime }) => {
    const mark = window.__af23Mark
    if (!mark || mark.id !== id || !Number.isFinite(mark.start)) throw new Error(`event timing mark missing: ${id}`)
    return { feedbackMs: mark.feedbackMs, resultMs: resultFrameTime - mark.start }
  }, { id, resultFrameTime })
}
async function frameAfterReady(page) {
  return page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(time => resolveFrame(time))))
}
async function summaryCount(page) {
  return page.evaluate(() => [...document.querySelectorAll('#summary tbody tr')].reduce((sum, row) => {
    const value = Number(String(row.children[1]?.textContent || '').replaceAll(',', '').trim())
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0))
}

try {
  if (!CHROME) throw new Error(`Chrome for Testing unavailable; set BROWSER_PATH. Checked: ${CHROME_CANDIDATES.join(', ')}`)
  port = await listen()
  profile = mkdtempSync(join(os.tmpdir(), 'af23-perf-report-'))
  browser = await timeout(puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  }), 'launch isolated CfT', 35_000)
  const worker = await timeout(browser.waitForTarget(target => target.type() === 'service_worker' && target.url().includes('/background/main.js'), { timeout: 25_000 }), 'extension service worker', 27_000)
  const extId = new URL(worker.url()).host
  const seedPage = await browser.newPage()
  await seedPage.goto(`chrome-extension://${extId}/ui/report/report.html#view=settings`, { waitUntil: 'domcontentloaded' })
  await seedPage.waitForFunction(() => Boolean(globalThis.chrome?.storage?.local))

  for (const [scenarioIndex, scenario] of SCENARIOS.entries()) {
    const seedResult = await seedScenario(seedPage, scenario, scenarioIndex)
    const result = {
      records: scenario.records, cards: scenario.cards, tasks: seedResult.taskCount,
      fixture: { seed: SEED + scenarioIndex, range: { from, to: today }, dateCount: seedResult.fixtureDateCount, storageKeyCount: seedResult.storageKeyCount, expectedRecords: scenario.records, expectedMatches: seedResult.expectedMatches, checksum: seedResult.expectedChecksum },
      cold: [], warm: { filter: [], tabSwitch: [], receivedRecord: [] },
      aggregates: {}, correctnessPercent: null
    }
    let retained = null
    for (let sampleIndex = 0; sampleIndex < COLD_N; sampleIndex++) {
      const url = `chrome-extension://${extId}/ui/report/report.html#from=${from}&to=${today}`
      const { page, pageErrors } = await createReportPage(extId, url)
      await waitForDashboard(page, scenario.cards)
      const openMs = await page.evaluate(() => performance.now() - window.__af23NavStart)
      const openStats = await snapshotStats(page)
      const shape = await pageShape(page)
      const cardValues = await page.$$eval('#dashboard-grid .report-card', cards => cards.map(card => ({
        id: card.dataset.cardId, value: card.querySelector('.card-number-value')?.textContent ?? ''
      })))
      const cardCount = cardValues.length
      const correctDashboard = cardCount === scenario.cards && openStats.recordGetCalls > 0
        && cardValues.every((card, index) => card.id === `af23-report-card-${index}` && card.value === seedResult.expectedCardValues[index])
      if (openStats.instrumentationErrors.length) output.failures.push(`${scenario.records}: instrumentation failed: ${openStats.instrumentationErrors.join('; ')}`)
      const coldSample = {
        sample: sampleIndex + 1, openMs, dashboardCardCount: cardCount, dashboardCardValues: cardValues, correct: correctDashboard,
        storage: openStats, ...shape, pageErrors: [...pageErrors]
      }
      await actionMark(page, `cold-history-${scenarioIndex}-${sampleIndex}`)
      const beforeHistoryStats = await snapshotStats(page)
      await timeout(page.click('#tab-history'), 'history tab click')
      await waitForHistory(page, scenario.records)
      const historyFrame = await frameAfterReady(page)
      const tabTiming = await timesFromMark(page, `cold-history-${scenarioIndex}-${sampleIndex}`, historyFrame)
      const historyStats = await deltaStats(page, beforeHistoryStats)
      coldSample.historyActivation = { ...tabTiming, storage: historyStats, correct: (await summaryCount(page)) === scenario.records }
      coldSample.historyActivation = { ...coldSample.historyActivation, ...await pageShape(page) }
      coldSample.pageErrors.push(...pageErrors.slice(coldSample.pageErrors.length))
      result.cold.push(coldSample)
      if (!coldSample.correct || !coldSample.historyActivation.correct) output.failures.push(`${scenario.records} cold ${sampleIndex + 1}: fixture/dashboard/history correctness failed`)
      if (pageErrors.length) output.failures.push(`${scenario.records} cold ${sampleIndex + 1}: ${pageErrors.join(' | ')}`)
      if (sampleIndex === COLD_N - 1) retained = { page, pageErrors }
      else await page.close()
    }

    const page = retained.page
    // Capture the settings-page zero-history-read invariant before measured warm operations.
    const readsBeforeSettings = await page.evaluate(() => window.__af23Stats.recordGetCalls)
    await page.click('#tab-settings')
    await timeout(page.waitForFunction(() => !document.getElementById('panel-settings')?.hidden), 'settings tab')
    const historyReadsOnSettings = await page.evaluate(() => window.__af23Stats.recordGetCalls)
    result.settingsHistoryRecordReads = historyReadsOnSettings - readsBeforeSettings
    if (result.settingsHistoryRecordReads !== 0) output.failures.push(`${scenario.records}: settings navigation read record keys (${result.settingsHistoryRecordReads})`)

    // Warm tab switching (20 samples): settings -> already-loaded history, with event feedback and final render frame.
    for (let index = 0; index < WARM_N; index++) {
      await page.click('#tab-settings')
      await timeout(page.waitForFunction(() => !document.getElementById('panel-settings')?.hidden), `settings prep ${index}`)
      const before = await snapshotStats(page)
      const actionId = `warm-tab-${scenarioIndex}-${index}`
      await actionMark(page, actionId)
      await page.click('#tab-history')
      await waitForHistory(page, scenario.records)
      const frame = await frameAfterReady(page)
      const timing = await timesFromMark(page, actionId, frame)
      result.warm.tabSwitch.push({ sample: index + 1, ...timing, storage: await deltaStats(page, before), ...await pageShape(page), correct: (await summaryCount(page)) === scenario.records })
    }

    // Warm filter (20 samples): alternating the seeded match and a guaranteed miss.
    for (let index = 0; index < WARM_N; index++) {
      const match = index % 2 === 0
      const expected = match ? seedResult.expectedMatches : 0
      const query = match ? 'af23-match-token' : `af23-no-match-${scenarioIndex}-${index}`
      const actionId = `warm-filter-${scenarioIndex}-${index}`
      const before = await snapshotStats(page)
      await actionMark(page, actionId)
      await page.evaluate(value => {
        const input = document.getElementById('filter-keyword')
        if (!input) throw new Error('history keyword filter missing')
        input.value = value
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }, query)
      await timeout(page.waitForFunction(expectedCount => {
        const total = [...document.querySelectorAll('#summary tbody tr')].reduce((sum, row) => sum + (Number(String(row.children[1]?.textContent || '').replaceAll(',', '').trim()) || 0), 0)
        const empty = document.getElementById('empty-state')?.hidden === false
        return total === expectedCount && (expectedCount > 0 || empty)
      }, { timeout: 90_000 }, expected), `filter render ${index}`, 95_000)
      const frame = await frameAfterReady(page)
      const timing = await timesFromMark(page, actionId, frame)
      result.warm.filter.push({ sample: index + 1, query, expectedCount: expected, ...timing, storage: await deltaStats(page, before), ...await pageShape(page), correct: (await summaryCount(page)) === expected })
    }
    // Leave an unfiltered, fully-loaded history view before external storage changes.
    await page.evaluate(() => {
      const input = document.getElementById('filter-keyword')
      input.value = ''
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitForHistory(page, scenario.records)

    // New-record notification (20 samples): append one fixture record and wait for the visible summary to include it.
    for (let index = 0; index < WARM_N; index++) {
      const expectedCount = scenario.records + index + 1
      const actionId = `new-record-${scenarioIndex}-${index}`
      const before = await snapshotStats(page)
      const record = await page.evaluate(async ({ index, today, actionId, taskId }) => {
        const key = `rec2:${today}:23`
        const current = (await chrome.storage.local.get(key))[key] || []
        const now = new Date()
        const capturedAt = new Date(now.getTime() + index + 1).toISOString()
        const entry = { taskId, capturedAt, slot: `${today}T23:59:${String(index).padStart(2, '0')}`, value: 900000 + index, raw: `af23-arrived-${index}`, status: 'ok' }
        window.__af23ExpectedAction = actionId
        window.__af23Mark = { id: actionId, start: performance.now(), feedbackMs: null }
        await chrome.storage.local.set({ [key]: [...current, entry] })
        return entry
      }, { index, today, actionId, taskId: 'af23-report-task-0' })
      await timeout(page.waitForFunction(expected => {
        const total = [...document.querySelectorAll('#summary tbody tr')].reduce((sum, row) => sum + (Number(String(row.children[1]?.textContent || '').replaceAll(',', '').trim()) || 0), 0)
        return total === expected
      }, { timeout: 90_000 }, expectedCount), `new record visible ${index}`, 95_000)
      const frame = await frameAfterReady(page)
      const timing = await timesFromMark(page, actionId, frame)
      const sample = {
        sample: index + 1, ...timing, storage: await deltaStats(page, before),
        ...await pageShape(page), correct: (await summaryCount(page)) === expectedCount,
        record: { taskId: record.taskId, date: today, value: record.value }
      }
      // Save the actual operation I/O delta by attaching the pre-write snapshot (read is part of trigger preparation).
      result.warm.receivedRecord.push(sample)
    }

    const summarize = samples => ({
      sampleCount: samples.length,
      p50Ms: median(samples.map(sample => sample.resultMs ?? sample.openMs)),
      p95Ms: samples.length === WARM_N ? p95(samples.map(sample => sample.resultMs)) : null,
      maxMs: Math.max(...samples.map(sample => sample.resultMs ?? sample.openMs)),
      feedbackP95Ms: samples.length === WARM_N ? p95(samples.map(sample => sample.feedbackMs ?? sample.resultMs)) : null
    })
    result.aggregates = {
      coldOpen: { sampleCount: COLD_N, medianMs: median(result.cold.map(sample => sample.openMs)), maxMs: Math.max(...result.cold.map(sample => sample.openMs)) },
      coldHistoryActivation: { sampleCount: COLD_N, medianMs: median(result.cold.map(sample => sample.historyActivation.resultMs)), maxMs: Math.max(...result.cold.map(sample => sample.historyActivation.resultMs)) },
      warmFilter: summarize(result.warm.filter), warmTabSwitch: summarize(result.warm.tabSwitch), warmReceivedRecord: summarize(result.warm.receivedRecord)
    }
    const checks = [...result.cold, ...result.warm.filter, ...result.warm.tabSwitch, ...result.warm.receivedRecord]
    const correctnessChecks = [...checks, ...result.cold.map(sample => sample.historyActivation)]
    result.correctnessPercent = correctnessChecks.length ? 100 * correctnessChecks.filter(sample => sample.correct).length / correctnessChecks.length : 0
    if (retained.pageErrors.length) output.failures.push(`${scenario.records} warm: ${retained.pageErrors.join(' | ')}`)
    if (result.correctnessPercent !== 100) output.failures.push(`${scenario.records}: correctness ${result.correctnessPercent}%`)
    const feedback = result.aggregates.warmTabSwitch.feedbackP95Ms
    if (feedback > output.targets.buttonFeedbackP95Ms) output.failures.push(`${scenario.records}: warm tab button feedback p95 ${feedback.toFixed(2)}ms > ${output.targets.buttonFeedbackP95Ms}ms`)
    if (scenario.records === 10_000) {
      for (const [name, value] of [['filter', result.aggregates.warmFilter.p95Ms], ['tab switch', result.aggregates.warmTabSwitch.p95Ms]]) {
        if (value > output.targets.warmFilterAndTabSwitchP95MsFor10k) output.failures.push(`10k warm ${name} p95 ${value.toFixed(2)}ms > ${output.targets.warmFilterAndTabSwitchP95MsFor10k}ms`)
      }
    }
    result.gates = {
      correctness100Percent: result.correctnessPercent === 100,
      buttonFeedbackP95Under100ms: feedback <= output.targets.buttonFeedbackP95Ms,
      tenKFilterAndTabP95Under300ms: scenario.records !== 10_000 || (result.aggregates.warmFilter.p95Ms <= 300 && result.aggregates.warmTabSwitch.p95Ms <= 300)
    }
    output.scenarios.push(result)
    await page.close()
    console.log(`[AF23 E1] ${scenario.records.toLocaleString()} records / ${scenario.cards} cards: cold median ${result.aggregates.coldOpen.medianMs.toFixed(1)}ms; warm filter p95 ${result.aggregates.warmFilter.p95Ms.toFixed(1)}ms; tab p95 ${result.aggregates.warmTabSwitch.p95Ms.toFixed(1)}ms; correctness ${result.correctnessPercent}%`)
  }

  output.pass = output.failures.length === 0
} catch (error) {
  output.pass = false
  output.failures.push(String(error?.stack || error))
} finally {
  try { await browser?.close() } catch {}
  try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch (error) { output.failures.push(`profile cleanup: ${String(error)}`); output.pass = false }
  try { server.close() } catch {}
}

const outputPath = process.env.AF23_PERF_OUTPUT || join(os.tmpdir(), `af23-perf-report-${Date.now()}.json`)
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`[AF23 E1] raw JSON: ${outputPath}`)
console.log(`[AF23 E1] ${output.pass ? 'PASS' : 'FAIL'}${output.failures.length ? `\n${output.failures.map(failure => `  - ${failure}`).join('\n')}` : ''}`)
if (!output.pass) process.exitCode = 1
