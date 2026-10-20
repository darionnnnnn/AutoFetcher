// AF-23 E1 real-browser scheduler measurement. Isolated CfT profile + local fixtures only.
// Run: BROWSER_PATH=/path/to/chrome node tests/smoke/af23_perf_schedule.mjs
import puppeteer from 'puppeteer-core'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import { join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

const ROOT = resolve(process.env.AF23_EXTENSION_PATH || 'src')
const CHROME = process.env.BROWSER_PATH
const SCENARIO_FILTER = process.env.AF23_SCHEDULE_CASE || 'all'
const DIAGNOSTIC = process.env.AF23_SCHEDULE_DIAGNOSTIC === '1'
const RESUME = process.env.AF23_SCHEDULE_RESUME === '1'
const PHASE = process.env.AF23_SCHEDULE_PHASE || 'all'
const SCHEDULE_RAW = resolve('work/perf-schedule-samples.jsonl')
const WARM_SAMPLES = 20
const COLD_SAMPLES = 5
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1] ?? null
const summary = xs => ({ count: xs.length, p50Ms: +percentile(xs, 0.5).toFixed(2), p95Ms: +percentile(xs, 0.95).toFixed(2), maxMs: +Math.max(...xs).toFixed(2) })
const coldSummary = xs => ({ count: xs.length, medianMs: +percentile(xs, 0.5).toFixed(2), maxMs: +Math.max(...xs).toFixed(2) })
const bounded = async (label, fn, ms = 60000) => {
  let timer
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms) })]) }
  finally { clearTimeout(timer) }
}

const MATRIX = [
  { id: '1site-2task-1value', sites: 1, tasksPerSite: 2, valuesPerTask: 1 },
  { id: '5site-2task-20value', sites: 5, tasksPerSite: 2, valuesPerTask: 20 },
  { id: '20site-2task-20value', sites: 20, tasksPerSite: 2, valuesPerTask: 20 },
  { id: '1site-1task-100value', sites: 1, tasksPerSite: 1, valuesPerTask: 100 }
]

const servers = []
const ports = []
const fixtureEvents = []
let browser = null
let profile = null
let browserVersion = null
let measurementPage = null
let sourceFingerprint = null

function fingerprintSource() {
  const files = []
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full, rel)
      else if (entry.isFile()) files.push({ path: rel, bytes: readFileSync(full) })
    }
  }
  visit(ROOT)
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path).update('\0').update(file.bytes).update('\0')
  }
  return { root: ROOT, algorithm: 'sha256', files: files.length, value: hash.digest('hex') }
}

async function openServer(siteIndex) {
  const server = http.createServer((req, res) => {
    const requestStartedAt = performance.now()
    const slow = new URL(req.url, 'http://127.0.0.1').searchParams.get('speed') === 'slow'
    setTimeout(() => {
      const fixture = new URL(req.url, 'http://127.0.0.1')
      const taskIndex = Number(fixture.pathname.match(/\/t(\d+)$/)?.[1] || 0)
      const valueCount = Number(fixture.searchParams.get('values') || 1)
      const cells = Array.from({ length: valueCount }, (_, fieldIndex) => {
        const value = 100 + siteIndex * 10000 + taskIndex * 1000 + fieldIndex
        return `<span id="s${siteIndex}t${taskIndex}f${fieldIndex}" data-value="${value}">${value}</span>`
      }).join('')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html><meta charset="utf-8"><title>AF23 schedule fixture ${siteIndex}</title>${cells}`)
      fixtureEvents.push({ siteIndex, path: fixture.pathname, requestStartedAtMs: +requestStartedAt.toFixed(2), responseEndedAtMs: +performance.now().toFixed(2), responseDelayMs: slow ? 500 : 50 })
    }, slow ? 500 : 50)
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen()) })
  servers.push(server)
  ports.push(server.address().port)
}

function tasksFor(scenario) {
  const tasks = []
  for (let site = 0; site < scenario.sites; site++) {
    const taskCount = scenario.sites === 1 && scenario.tasksPerSite === 1 ? 1 : scenario.tasksPerSite
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex++) {
      const id = `e1-${scenario.id}-s${site}-t${taskIndex}`
      const speed = taskCount === 1 ? 'slow' : (taskIndex === 0 ? 'fast' : 'slow')
      const fields = Array.from({ length: scenario.valuesPerTask }, (_, fieldIndex) => {
        const key = `f${fieldIndex}`
        return {
          key, name: `值 ${fieldIndex + 1}`, mode: 'number',
          source: { locator: { css: `#s${site}t${taskIndex}f${fieldIndex}` } },
          spec: { strategy: 'auto' }
        }
      })
      tasks.push({
        id, name: `${scenario.id} ${site + 1}-${taskIndex + 1}`,
        url: `http://127.0.0.1:${ports[site]}/t${taskIndex}?speed=${speed}&values=${scenario.valuesPerTask}`,
        mode: 'multi', enabled: true,
        spec: { mode: 'multi', fields: structuredClone(fields) },
        fields: fields.map(({ key, name, mode }) => ({ key, name, mode })),
        schedule: { type: 'daily', times: ['23:59'], weekdays: [1, 2, 3, 4, 5, 6, 0] }
      })
    }
  }
  return tasks
}

async function launch() {
  profile = mkdtempSync(join(os.tmpdir(), 'af23-perf-schedule-'))
  browser = await bounded('launch CfT', () => puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: profile,
    protocolTimeout: 240000,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run', '--no-default-browser-check']
  }), 45000)
  const worker = await bounded('extension service worker', async () => {
    for (let i = 0; i < 120; i++) {
      const target = browser.targets().find(item => item.type() === 'service_worker' && item.url().includes('/background/main.js'))
      if (target) return target
      await wait(100)
    }
    throw new Error('extension worker not found')
  }, 15000)
  browserVersion = await browser.version()
  return new URL(worker.url()).host
}

async function executeSample(extId, tasks) {
  if (!browser?.isConnected()) throw new Error(`CfT browser disconnected before sample (extension ${extId})`)
  if (!measurementPage || measurementPage.isClosed()) {
    measurementPage = await browser.newPage()
    await measurementPage.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  }
  const page = measurementPage
  const storageBefore = await page.evaluate(async input => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    await storage.init()
    await chrome.storage.local.clear()
    await chrome.alarms.clearAll()
    await storage.saveTasks(input)
    const before = await chrome.storage.local.get(null)
    const readBytes = new TextEncoder().encode(JSON.stringify(before)).length
    if (!window.__af23PerfListenerInstalled) {
      window.__af23PerfIo = { writes: 0, writeBytes: 0 }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return
        for (const change of Object.values(changes)) {
          window.__af23PerfIo.writes++
          window.__af23PerfIo.writeBytes += new TextEncoder().encode(JSON.stringify(change.newValue ?? null)).length
        }
      })
      window.__af23PerfListenerInstalled = true
    }
    window.__af23PerfIo = { writes: 0, writeBytes: 0 }
    const fetcher = await import(chrome.runtime.getURL('background/fetcher.js'))
    return { keys: Object.keys(before).length, readBytes, executionDeadlinesMs: input.map(task => ({ taskId: task.id, budgetMs: fetcher.runBudgetMsOf(task) })) }
  }, tasks)
  const start = performance.now()
  const expected = tasks.map(task => ({
    taskId: task.id,
    values: task.spec.fields.map(field => {
      const [, site, taskIndex, fieldIndex] = field.source.locator.css.match(/^#s(\d+)t(\d+)f(\d+)$/).map(Number)
      return 100 + site * 10000 + taskIndex * 1000 + fieldIndex
    })
  }))
  const runAndResultReadStartedAt = performance.now()
  const results = await bounded('RUN_TASK matrix sample', () => page.evaluate(async expectedTasks => {
    const results = await Promise.all(expectedTasks.map(task => chrome.runtime.sendMessage({ type: 'RUN_TASK', taskId: task.taskId })))
    return results.map((result, index) => {
      const expected = expectedTasks[index]
      const fields = Array.isArray(result?.values) ? result.values : []
      const mismatchIndexes = []
      for (let i = 0; i < expected.values.length; i++) {
        if (fields[i]?.ok !== true || Number(fields[i]?.value) !== expected.values[i]) mismatchIndexes.push(i)
      }
      return { taskId: expected.taskId, outcome: result?.outcome, fields: fields.length,
        expectedFields: expected.values.length, mismatchIndexes, error: result?.error || null }
    })
  }, expected), 240000)
  const runAndResultReadElapsedMs = performance.now() - runAndResultReadStartedAt
  const elapsedMs = performance.now() - start
  const storageAfter = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null)
    const session = await chrome.storage.session.get(null)
    return { keys: Object.keys(all).length, readBytes: new TextEncoder().encode(JSON.stringify(all)).length,
      sessionKeys: Object.keys(session).length, sessionReadBytes: new TextEncoder().encode(JSON.stringify(session)).length,
      io: window.__af23PerfIo }
  })
  const io = storageAfter.io
  const correctness = results.every((result, i) => result?.outcome === 'done' &&
    result.taskId === expected[i].taskId && result.fields === expected[i].values.length &&
    result.expectedFields === expected[i].values.length && result.mismatchIndexes.length === 0)
  return { extensionSourceFingerprint: sourceFingerprint, browserFingerprint: { executablePath: CHROME, version: browserVersion }, elapsedMs: +elapsedMs.toFixed(2), runAndResultReadElapsedMs: +runAndResultReadElapsedMs.toFixed(2), taskAndResultElapsedMs: null, queueWaitMs: null,
    queueWaitDefinition: 'RUN_TASK does not expose enqueue/dequeue timestamps; see the separate same-case page diagnostic for per-task completion timing.',
    executionDeadlinesMs: storageBefore.executionDeadlinesMs, storageReadBytes: { before: storageBefore.readBytes, after: storageAfter.readBytes, sessionAfter: storageAfter.sessionReadBytes },
    io, correctness, tasks: results }
}

// One-case diagnostic mode keeps the completion marker in the page and returns compact
// summaries, so a slow CDP result serialization cannot masquerade as slow task execution.
async function executeDiagnosticSample(extId, tasks) {
  if (!browser?.isConnected()) throw new Error(`CfT browser disconnected before diagnostic sample (extension ${extId})`)
  if (!measurementPage || measurementPage.isClosed()) {
    measurementPage = await browser.newPage()
    await measurementPage.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  }
  const page = measurementPage
  const before = await page.evaluate(async input => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    const fetcher = await import(chrome.runtime.getURL('background/fetcher.js'))
    await storage.init()
    await chrome.storage.local.clear()
    await chrome.alarms.clearAll()
    await storage.saveTasks(input)
    const all = await chrome.storage.local.get(null)
    const readBytes = new TextEncoder().encode(JSON.stringify(all)).length
    window.__af23DiagIo = { writes: 0, writeBytes: 0 }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      for (const change of Object.values(changes)) {
        window.__af23DiagIo.writes++
        window.__af23DiagIo.writeBytes += new TextEncoder().encode(JSON.stringify(change.newValue ?? null)).length
      }
    })
    window.__af23LongTasks = []
    try {
      new PerformanceObserver(list => window.__af23LongTasks.push(...list.getEntries().map(entry => ({ startTimeMs: +entry.startTime.toFixed(2), durationMs: +entry.duration.toFixed(2) })))).observe({ type: 'longtask', buffered: true })
    } catch {}
    return { storageKeys: Object.keys(all).length, storageReadBytes: readBytes, executionDeadlinesMs: input.map(task => ({ taskId: task.id, budgetMs: fetcher.runBudgetMsOf(task) })) }
  }, tasks)
  const expected = tasks.map(task => ({
    taskId: task.id,
    values: task.spec.fields.map(field => {
      const [, site, taskIndex, fieldIndex] = field.source.locator.css.match(/^#s(\d+)t(\d+)f(\d+)$/).map(Number)
      return 100 + site * 10000 + taskIndex * 1000 + fieldIndex
    })
  }))
  const fixtureStart = fixtureEvents.length
  const nodeStartedAt = performance.now()
  const submission = await page.evaluate(expectedTasks => {
    window.__af23DiagRun = { phase: 'running', startedAtMs: performance.now(), tasks: {} }
    const pending = expectedTasks.map(task => {
      const mark = window.__af23DiagRun.tasks[task.taskId] = { acceptedAtMs: performance.now(), acceptedAtEpochMs: Date.now(), done: false }
      return chrome.runtime.sendMessage({ type: 'RUN_TASK', taskId: task.taskId }).then(result => {
        const fields = Array.isArray(result?.values) ? result.values : []
        const mismatchIndexes = []
        for (let i = 0; i < task.values.length; i++) {
          if (fields[i]?.ok !== true || Number(fields[i]?.value) !== task.values[i]) mismatchIndexes.push(i)
        }
        Object.assign(mark, { done: true, completedAtMs: performance.now(), completedAtEpochMs: Date.now(), outcome: result?.outcome || null, fieldCount: fields.length, expectedFields: task.values.length, mismatchIndexes, error: result?.error || null })
        return mark
      }, error => {
        Object.assign(mark, { done: true, completedAtMs: performance.now(), completedAtEpochMs: Date.now(), error: String(error?.message || error) })
        return mark
      })
    })
    window.__af23DiagRun.pending = Promise.all(pending).then(() => {
      window.__af23DiagRun.completedAtMs = performance.now()
      window.__af23DiagRun.phase = 'complete'
    })
    return { acceptedAtMs: window.__af23DiagRun.startedAtMs }
  }, expected)
  const pollStartedAt = performance.now()
  let marker = null
  let markerReadElapsedMs = null
  while (performance.now() - pollStartedAt < 180000) {
    const readStartedAt = performance.now()
    marker = await bounded('read in-page completion marker', () => page.evaluate(() => {
      const run = window.__af23DiagRun
      return run ? { phase: run.phase, startedAtMs: run.startedAtMs, completedAtMs: run.completedAtMs ?? null, tasks: Object.fromEntries(Object.entries(run.tasks).map(([id, task]) => [id, { ...task }])) } : null
    }), 15000)
    markerReadElapsedMs = performance.now() - readStartedAt
    if (marker?.phase === 'complete') break
    await wait(100)
  }
  const markerCompleted = marker?.phase === 'complete'
  const resultReadStartedAt = performance.now()
  const details = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null)
    const session = await chrome.storage.session.get(null)
    return {
      marker: window.__af23DiagRun ? { phase: window.__af23DiagRun.phase, startedAtMs: window.__af23DiagRun.startedAtMs, completedAtMs: window.__af23DiagRun.completedAtMs ?? null } : null,
      tasks: window.__af23DiagRun ? Object.fromEntries(Object.entries(window.__af23DiagRun.tasks).map(([id, task]) => [id, { ...task }])) : {},
      longTasks: window.__af23LongTasks || [], io: window.__af23DiagIo || { writes: 0, writeBytes: 0 },
      storageKeys: Object.keys(all).length, storageReadBytes: new TextEncoder().encode(JSON.stringify(all)).length,
      sessionKeys: Object.keys(session).length, sessionReadBytes: new TextEncoder().encode(JSON.stringify(session)).length
    }
  })
  const resultReadElapsedMs = performance.now() - resultReadStartedAt
  const actualTasks = Object.values(details.tasks)
  const correctness = markerCompleted && actualTasks.length === expected.length && actualTasks.every(task => task.outcome === 'done' && task.expectedFields === task.fieldCount && task.mismatchIndexes?.length === 0)
  const now = performance.now()
  const queuedTasks = []
  for (let siteIndex = 0; siteIndex < tasks.length / 2; siteIndex++) {
    const predecessor = actualTasks.find(task => task.taskId.endsWith(`-s${siteIndex}-t0`))
    const queued = actualTasks.find(task => task.taskId.endsWith(`-s${siteIndex}-t1`))
    if (predecessor?.completedAtEpochMs != null && queued?.acceptedAtEpochMs != null) {
      const queueWaitEstimateMs = Math.max(0, predecessor.completedAtEpochMs - queued.acceptedAtEpochMs)
      queuedTasks.push({ taskId: `e1-${SCENARIO_FILTER}-s${siteIndex}-t1`, predecessorTaskId: predecessor.taskId, queueWaitEstimateMs, executionElapsedAfterQueueEstimateMs: Math.max(0, queued.completedAtEpochMs - predecessor.completedAtEpochMs), definition: 'Estimate: predecessor RUN_TASK response completion minus this same-origin task acceptance. RUN_TASK does not expose the exact enqueue/dequeue timestamp.' })
    }
  }
  const queueWaitSamples = queuedTasks.map(task => task.queueWaitEstimateMs)
  return {
    status: correctness ? 'PASS' : 'FAIL', correctness, extensionSourceFingerprint: sourceFingerprint, browserFingerprint: { executablePath: CHROME, version: browserVersion },
    timing: {
      nodeEndToEndMs: +(now - nodeStartedAt).toFixed(2), pageTaskCompletionMs: marker?.startedAtMs != null && marker?.completedAtMs != null ? +(marker.completedAtMs - marker.startedAtMs).toFixed(2) : null,
      cdpCompletionMarkerReadMs: markerReadElapsedMs == null ? null : +markerReadElapsedMs.toFixed(2), cdpFinalResultAndStorageReadMs: +resultReadElapsedMs.toFixed(2),
      queueWaitMsEstimated: { count: queueWaitSamples.length, p50: queueWaitSamples.length ? +percentile(queueWaitSamples, 0.5).toFixed(2) : null, p95: queueWaitSamples.length ? +percentile(queueWaitSamples, 0.95).toFixed(2) : null, max: queueWaitSamples.length ? +Math.max(...queueWaitSamples).toFixed(2) : null },
      queueWaitDefinition: 'Exact dequeue time is not exposed by RUN_TASK; per-origin estimates use predecessor response completion minus queued-task acceptance.',
      executionDeadlineDefinition: 'Per-task production runBudgetMsOf result; execution deadline starts after origin queue admission.'
    },
    taskCompletion: actualTasks.map(task => ({ ...task, elapsedFromAcceptanceMs: task.completedAtMs == null ? null : +(task.completedAtMs - task.acceptedAtMs).toFixed(2) })), originQueueWaitEstimates: queuedTasks,
    executionDeadlinesMs: before.executionDeadlinesMs,
    fixtureRequests: fixtureEvents.slice(fixtureStart), fixtureRequestCount: fixtureEvents.length - fixtureStart,
    reportRendererLongTasks: details.longTasks, storage: { before, after: { keys: details.storageKeys, readBytes: details.storageReadBytes }, sessionAfter: { keys: details.sessionKeys, readBytes: details.sessionReadBytes }, writes: details.io },
    pageMarker: { submission, marker, observedComplete: markerCompleted }
  }
}

async function closeBrowser() {
  if (browser) {
    const proc = browser.process?.()
    try { await Promise.race([browser.close(), wait(10000)]) } catch {}
    if (proc && proc.exitCode === null && !proc.killed) proc.kill()
    await wait(250)
    browser = null
  }
  measurementPage = null
  if (profile) {
    const temp = resolve(os.tmpdir())
    const abs = resolve(profile)
    if (abs.startsWith(`${temp}${sep}`) && abs.split(/[\\/]/).pop()?.startsWith('af23-perf-schedule-')) rmSync(abs, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    else throw new Error(`refused to clean profile outside temp directory: ${abs}`)
    profile = null
  }
}

let report
let cases = []
let priorCases = []
let priorReport = null
try {
  if (!CHROME || !existsSync(CHROME)) throw new Error('Set BROWSER_PATH to a Chrome for Testing executable; normal Chrome is not supported.')
  if (!['all', 'cold', 'warm'].includes(PHASE)) throw new Error(`Unknown AF23_SCHEDULE_PHASE: ${PHASE}`)
  sourceFingerprint = fingerprintSource()
  if (RESUME && !DIAGNOSTIC && existsSync(resolve('work/perf-schedule.json'))) {
    try {
      priorReport = JSON.parse(readFileSync(resolve('work/perf-schedule.json'), 'utf8'))
    } catch {}
  }
  if (RESUME && priorReport) {
    // Probe the exact CfT binary before accepting prior samples. Older reports
    // without these fingerprints remain archived evidence, never silent resumes.
    await launch()
    await closeBrowser()
    const compatible = priorReport.browser === CHROME && priorReport.browserVersion === browserVersion &&
      priorReport.extensionSourceFingerprint?.value === sourceFingerprint.value
    if (compatible) {
      priorCases = Array.isArray(priorReport.completedCases) ? priorReport.completedCases : (Array.isArray(priorReport.cases) ? priorReport.cases : [])
      cases = priorCases.slice()
    } else {
      console.log(`Resume fingerprints differ; prior samples are not reused. source=${sourceFingerprint.value}, priorSource=${priorReport.extensionSourceFingerprint?.value || 'missing'}, browser=${CHROME} ${browserVersion}, priorBrowser=${priorReport.browser || 'missing'} ${priorReport.browserVersion || 'missing'}`)
    }
  }
  const requestedScenarios = SCENARIO_FILTER === 'all' ? null : new Set(SCENARIO_FILTER.split(',').map(value => value.trim()).filter(Boolean))
  const selectedMatrix = requestedScenarios ? MATRIX.filter(scenario => requestedScenarios.has(scenario.id)) : MATRIX
  if (selectedMatrix.length === 0 || (requestedScenarios && selectedMatrix.length !== requestedScenarios.size)) throw new Error(`Unknown AF23_SCHEDULE_CASE: ${SCENARIO_FILTER}`)
  for (let site = 0; site < 20; site++) await openServer(site)
  const runtime = { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, logicalCpus: os.cpus().length }
  for (const scenario of selectedMatrix) {
    const tasks = tasksFor(scenario)
    const priorCase = RESUME ? priorCases.find(item => item?.scenario?.id === scenario.id) : null
    const priorCold = (priorCase?.cold?.raw || []).filter(sample => sample?.correctness === true)
    const priorWarm = (priorCase?.warm?.raw || []).filter(sample => sample?.correctness === true)
    const cold = priorCold.slice(0, COLD_SAMPLES)
    const caseResult = {
      scenario, extensionSourceFingerprint: sourceFingerprint, browserFingerprint: { executablePath: CHROME, version: browserVersion }, fixture: { siteCount: scenario.sites, responseDelayMs: [50, 500], correctness: 'all returned field values match deterministic fixture IDs' },
      cold: { launchMs: priorCase?.cold?.launchMs || null, endToEndMs: priorCase?.cold?.endToEndMs || null, raw: cold },
      warm: { endToEndMs: null, raw: priorWarm.slice(0, WARM_SAMPLES) }
    }
    const existingCaseIndex = cases.findIndex(item => item?.scenario?.id === scenario.id)
    if (existingCaseIndex >= 0) cases.splice(existingCaseIndex, 1, caseResult)
    else cases.push(caseResult)
    if (DIAGNOSTIC) {
      console.log(`E1 schedule diagnostic ${scenario.id}: single sample`)
      const extId = await launch()
      const measured = await executeDiagnosticSample(extId, tasks)
      caseResult.warm.raw.push(measured)
      await closeBrowser()
      if (!measured.correctness) throw new Error(`${scenario.id} diagnostic output mismatch or did not finish: ${JSON.stringify(measured)}`)
      report = { id: 'AF-23-E1-schedule-diagnostic', status: 'PASS', timestamp: new Date().toISOString(), browser: CHROME, browserVersion, browserFingerprint: { executablePath: CHROME, version: browserVersion }, extensionSourceFingerprint: sourceFingerprint, runtime, scenario: scenario.id, sampleCount: 1, diagnostic: measured, cases }
      break
    }
    for (let sample = cold.length; sample < COLD_SAMPLES; sample++) {
      console.log(`E1 schedule ${scenario.id}: cold ${sample + 1}/${COLD_SAMPLES}`)
      const launchStarted = performance.now()
      const extId = await launch()
      const launchMs = +(performance.now() - launchStarted).toFixed(2)
      const measured = await executeSample(extId, tasks)
      cold.push({ launchMs, ...measured, extensionSourceFingerprint: sourceFingerprint, browserFingerprint: { executablePath: CHROME, version: browserVersion } })
      appendFileSync(SCHEDULE_RAW, `${JSON.stringify({ kind: 'sample', scenario: scenario.id, phase: 'cold', sampleIndex: sample, extensionSourceFingerprint: sourceFingerprint, browserFingerprint: { executablePath: CHROME, version: browserVersion }, sample: cold.at(-1), timestamp: new Date().toISOString() })}\n`)
      if (!measured.correctness) throw new Error(`${scenario.id} cold sample ${sample + 1} fixture output mismatch: ${JSON.stringify(measured)}`)
      await closeBrowser()
    }
    const warm = caseResult.warm.raw
    if (PHASE !== 'cold' && warm.length < WARM_SAMPLES) {
    const extId = await launch()
    for (let sample = warm.length; sample < WARM_SAMPLES; sample++) {
      if (sample === 0 || (sample + 1) % 5 === 0) console.log(`E1 schedule ${scenario.id}: warm ${sample + 1}/${WARM_SAMPLES}`)
      const measured = await executeSample(extId, tasks)
      if (!measured.correctness) throw new Error(`${scenario.id} warm sample ${sample + 1} fixture output mismatch`)
      warm.push(measured)
      appendFileSync(SCHEDULE_RAW, `${JSON.stringify({ kind: 'sample', scenario: scenario.id, phase: 'warm', sampleIndex: sample, extensionSourceFingerprint: sourceFingerprint, browserFingerprint: { executablePath: CHROME, version: browserVersion }, sample: measured, timestamp: new Date().toISOString() })}\n`)
    }
    await closeBrowser()
    }
    if (cold.length) {
      caseResult.cold.launchMs = coldSummary(cold.map(sample => sample.launchMs))
      caseResult.cold.endToEndMs = coldSummary(cold.map(sample => sample.elapsedMs))
    }
    if (warm.length) caseResult.warm.endToEndMs = summary(warm.map(sample => sample.elapsedMs))
  }
  if (!report) report = { id: PHASE === 'cold' ? 'AF-23-E1-schedule-cold-retest' : 'AF-23-E1-schedule', status: 'PASS', timestamp: new Date().toISOString(), browser: CHROME, browserVersion, browserFingerprint: { executablePath: CHROME, version: browserVersion }, extensionSourceFingerprint: sourceFingerprint, runtime, phase: PHASE, samplePlan: { warm: PHASE === 'cold' ? 0 : WARM_SAMPLES, cold: PHASE === 'warm' ? 0 : COLD_SAMPLES }, measurementNotes: ['Source and CfT executable/version fingerprints are recorded on the report and every sample. Resume accepts prior samples only when both fingerprints match; legacy reports without fingerprints are kept as baseline and not silently reused. Exact queue wait is not exposed by RUN_TASK; diagnostic reports per-task completion and estimated origin queue waits.'], cases }
} catch (error) {
  report = { id: 'AF-23-E1-schedule', status: 'FAIL', timestamp: new Date().toISOString(), browser: CHROME || null, error: error?.stack || String(error), completedCases: cases }
  process.exitCode = 1
} finally {
  try { await closeBrowser() } catch (error) { report = { ...(report || {}), status: 'FAIL', cleanupError: String(error) }; process.exitCode = 1 }
  for (const server of servers) {
    if (!server.listening) continue
    server.closeAllConnections?.()
    await new Promise(resolveClose => server.close(resolveClose))
  }
}
const output = resolve(DIAGNOSTIC ? 'work/perf-schedule-diagnostic.json' : PHASE === 'cold' ? 'work/perf-schedule-cold-retest.json' : 'work/perf-schedule.json')
mkdirSync(resolve('work'), { recursive: true })
report.outputFile = output
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
