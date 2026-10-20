// AF-23 E1 picker measurement. Uses Chrome for Testing, a private profile and localhost fixtures.
// Run: BROWSER_PATH=/path/to/chrome node tests/smoke/af23_perf_pick.mjs
import puppeteer from 'puppeteer-core'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

const SRC = resolve(process.env.AF23_EXTENSION_PATH || 'src')
const CHROME = process.env.BROWSER_PATH
const PICK_CASE = process.env.AF23_PICK_CASE || 'all'
const RESUME_HOVER = process.env.AF23_HOVER_RESUME === '1'
const WARM = 20
const COLD = 5
const HOVER_RAW = resolve('work/perf-pick-hover-samples.jsonl')
const wait = ms => new Promise(done => setTimeout(done, ms))
const sorted = xs => [...xs].sort((a, b) => a - b)
const percentile = (xs, p) => sorted(xs)[Math.ceil(p * xs.length) - 1] ?? null
const summary = xs => ({ count: xs.length, p50Ms: +percentile(xs, 0.5).toFixed(2), p95Ms: +percentile(xs, 0.95).toFixed(2), maxMs: +Math.max(...xs).toFixed(2) })
const coldSummary = xs => xs.length
  ? ({ count: xs.length, medianMs: +percentile(xs, 0.5).toFixed(2), maxMs: +Math.max(...xs).toFixed(2) })
  : ({ count: 0, medianMs: null, maxMs: null })
const bounded = async (label, fn, ms = 30000) => {
  let timer
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms) })]) }
  finally { clearTimeout(timer) }
}

const MATRIX = [
  { id: '1group-1value', groups: 1, totalValues: 1 },
  { id: '5group-20values', groups: 5, totalValues: 20 },
  { id: '20group-100values', groups: 20, totalValues: 100 }
]
let server
let browser
let profile
let fixtureUrl

function fixtureHtml() {
  const rows = Array.from({ length: 1000 }, (_, row) => `<tr>${Array.from({ length: 10 }, (_, col) => {
    const value = row * 10 + col
    return `<td id="cell-${row}-${col}" data-value="${value}">${value}</td>`
  }).join('')}</tr>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>AF23 1000x10 table fixture</title><table><tbody>${rows}</tbody></table>`
}

async function startServer() {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(fixtureHtml())
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  fixtureUrl = `http://127.0.0.1:${server.address().port}/`
}

async function closeBrowser() {
  if (browser) {
    const process = browser.process?.()
    try { await Promise.race([browser.close(), wait(2500)]) } catch {}
    if (process && process.exitCode === null && !process.killed) process.kill()
    browser = null
  }
  if (profile) {
    const root = resolve(os.tmpdir())
    const path = resolve(profile)
    if (path.startsWith(`${root}${sep}`) && path.split(/[\\/]/).pop()?.startsWith('af23-perf-pick-')) {
      rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    } else throw new Error(`refused to clean profile outside temp directory: ${path}`)
    profile = null
  }
}

async function launch() {
  profile = mkdtempSync(join(os.tmpdir(), 'af23-perf-pick-'))
  browser = await bounded('launch isolated CfT', () => puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  }), 45000)
  const worker = await bounded('extension worker', async () => {
    for (let i = 0; i < 120; i++) {
      const target = browser.targets().find(item => item.type() === 'service_worker' && item.url().includes('/background/main.js'))
      if (target) return target
      await wait(100)
    }
    throw new Error('extension service worker not found')
  }, 15000)
  const extId = new URL(worker.url()).host
  const source = await browser.newPage()
  await source.setViewport({ width: 1280, height: 900 })
  await source.goto(fixtureUrl, { waitUntil: 'load' })
  const ui = await browser.newPage()
  await ui.setViewport({ width: 1100, height: 900 })
  const uiStarted = performance.now()
  await ui.goto(`chrome-extension://${extId}/ui/picker/picker.html`, { waitUntil: 'domcontentloaded' })
  await ui.waitForFunction(() => document.readyState === 'complete')
  await ui.evaluate(async () => {
    window.__af23Picker = await import(chrome.runtime.getURL('ui/picker/picker.js'))
    window.__af23Storage = await import(chrome.runtime.getURL('shared/storage.js'))
    await window.__af23Storage.init()
    window.__af23Io = { events: 0, bytes: 0, setCalls: 0 }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      for (const change of Object.values(changes)) {
        window.__af23Io.events++
        window.__af23Io.bytes += new TextEncoder().encode(JSON.stringify(change.newValue ?? null)).length
      }
    })
  })
  await ui.waitForFunction(() => Boolean(window.__af23Picker?.renderPickDraft && window.__af23Picker?.renderFromPanelCtx))
  return { extId, source, ui, uiOpenMs: +(performance.now() - uiStarted).toFixed(2) }
}

function draftFor(scenario, url) {
  let ordinal = 0
  const groups = Array.from({ length: scenario.groups }, (_, gi) => {
    const valuesInGroup = Math.floor(scenario.totalValues / scenario.groups) + (gi < scenario.totalValues % scenario.groups ? 1 : 0)
    return {
      key: `g${gi + 1}`, name: `群組 ${gi + 1}`,
      values: Array.from({ length: valuesInGroup }, () => {
        const index = ordinal++
        return {
          key: `v${index + 1}`, name: `值 ${index + 1}`, mode: 'number',
          source: { locator: { css: `#cell-${Math.floor(index / 10)}-${index % 10}` } },
          spec: { strategy: 'auto' }
        }
      })
    }
  })
  return {
    version: 1, revision: 0, tabId: 1, sessionId: `perf-${scenario.id}`,
    documentGeneration: 'perf-document', routeIdentity: { url }, groups,
    activeGroupKey: groups[0].key, stage: 'selecting', form: {}
  }
}

function tasksFor(scenario, url) {
  const draft = draftFor(scenario, url)
  return draft.groups.map((group, index) => {
    const fields = group.values.map(value => ({ ...value }))
    return {
      id: `perf-${scenario.id}-task-${index + 1}`, name: group.name, url,
      mode: 'multi', enabled: true, spec: { mode: 'multi', fields },
      fields: fields.map(({ key, name, mode }) => ({ key, name, mode })),
      schedule: { type: 'daily', times: ['23:59'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
    }
  })
}

async function measureUi(ui, scenario, url, iteration) {
  const draft = draftFor(scenario, url)
  const switched = await ui.evaluate(async ({ draft, iteration }) => {
    const api = window.__af23Picker
    const group = draft.groups[iteration % draft.groups.length]
    const active = { ...draft, activeGroupKey: group.key }
    const started = performance.now()
    api.setPickDraftContext(active, { render: false })
    api.renderPickDraft(active)
    await new Promise(requestAnimationFrame)
    return {
      elapsedMs: performance.now() - started,
      groups: document.querySelectorAll('[data-group-row]').length,
      values: document.querySelectorAll('[data-group-value]').length,
      domNodes: document.getElementsByTagName('*').length
    }
  }, { draft, iteration })

  const items = draft.groups.map(group => {
    const fields = group.values.map(value => ({ ...value }))
    return {
      key: group.key, nameHint: `${group.name} ${iteration}`, url,
      locator: fields[0]?.source.locator || {},
      picks: fields.map(field => field.spec),
      valueSources: fields.map(field => ({ locator: field.source.locator })), fields
    }
  })
  const completed = await ui.evaluate(async items => {
    const started = performance.now()
    const result = await window.__af23Picker.renderFromPanelCtx({ kind: 'batch', batch: true, items })
    await new Promise(requestAnimationFrame)
    return {
      elapsedMs: performance.now() - started, rendered: result?.rendered === true,
      itemCount: document.querySelectorAll('[data-batch-item], [data-batch-row], [data-batch-task]').length,
      domNodes: document.getElementsByTagName('*').length
    }
  }, items)

  await ui.evaluate(async () => {
    await chrome.storage.local.clear()
    window.__af23Io = { events: 0, bytes: 0, setCalls: 0 }
  })
  const tasks = tasksFor(scenario, url)
  const saved = await ui.evaluate(async tasks => {
    const started = performance.now()
    const result = await window.__af23Storage.saveTasks(tasks)
    await new Promise(resolve => setTimeout(resolve, 0))
    return { elapsedMs: performance.now() - started, saved: result.length, io: { ...window.__af23Io }, taskCount: tasks.length }
  }, tasks)
  return {
    iteration,
    groupSwitch: { elapsedMs: +switched.elapsedMs.toFixed(2), groups: switched.groups, totalValues: switched.values, domNodes: switched.domNodes, runtimeMessages: 0, storageEvents: 0, storageBytes: 0 },
    completionRender: { elapsedMs: +completed.elapsedMs.toFixed(2), rendered: completed.rendered, itemCount: items.length, domNodes: completed.domNodes, runtimeMessages: 0, storageEvents: 0, storageBytes: 0 },
    save: { elapsedMs: +saved.elapsedMs.toFixed(2), correctSavedCount: saved.saved === tasks.length, taskCount: saved.taskCount, storageEvents: saved.io.events, storageBytes: saved.io.bytes, domNodes: completed.domNodes, runtimeMessages: 0 }
  }
}

function priorHoverSamples(fingerprint) {
  if (!RESUME_HOVER || !existsSync(HOVER_RAW)) return []
  const records = readFileSync(HOVER_RAW, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const unique = new Map()
  for (const record of records) {
    if (record.kind !== 'sample' || record.fingerprint !== fingerprint || record.sample?.status !== 'PASS') continue
    if (record.sample.environment?.visibilityState !== 'visible' || record.sample.environment?.hasFocus !== true ||
        record.sample.environment?.pickMode !== 'cell' || record.sample.correct !== true) continue
    if (Number.isInteger(record.sampleIndex) && record.sampleIndex >= 0 && record.sampleIndex < WARM) unique.set(record.sampleIndex, record.sample)
  }
  const contiguous = []
  for (let index = 0; index < WARM && unique.has(index); index++) contiguous.push(unique.get(index))
  return contiguous
}

async function measureHover(source, extId, { fingerprint, resume = [] } = {}) {
  mkdirSync(resolve('work'), { recursive: true })
  const extension = await browser.newPage()
  await extension.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  const tabId = await extension.evaluate(async url => (await chrome.tabs.query({ url }))[0]?.id, fixtureUrl)
  if (!Number.isInteger(tabId)) throw new Error('fixture tab ID unavailable for hover measurement')
  let entered
  try {
    entered = await bounded('ENTER_PICK for hover fixture', () => extension.evaluate(async tabId => chrome.runtime.sendMessage({ type: 'ENTER_PICK', purpose: 'task', tabId, frameId: 0 }), tabId), 12000)
  } catch (error) {
    return { status: 'FAIL', stage: 'ENTER_PICK', message: error?.message || String(error), warmRequested: WARM, warmCompleted: 0, rawMs: [] }
  }
  if (entered?.ok === false) throw new Error(`ENTER_PICK hover failed: ${entered.message || entered.error}`)
  await source.bringToFront()
  try {
    await bounded('picker toolbar appears', () => source.waitForSelector('[data-af-toolbar]', { timeout: 10000 }), 12000)
    await bounded('set single-cell hover mode', () => source.evaluate(() => document.querySelector('[data-af-tool="cell"]')?.click()), 5000)
  } catch (error) {
    return { status: 'FAIL', stage: 'picker-toolbar', message: error?.message || String(error), warmRequested: WARM, warmCompleted: resume.length, rawMs: resume.map(sample => sample.elapsedMs), samples: resume }
  }
  const setupEnvironment = await source.evaluate(() => ({
    visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
    pickMode: document.querySelector('[data-af-tool][data-af-active]')?.getAttribute('data-af-tool') || null
  }))
  if (setupEnvironment.visibilityState !== 'visible' || setupEnvironment.hasFocus !== true || setupEnvironment.pickMode !== 'cell') {
    return { status: 'FAIL', stage: 'hover-precondition', warmRequested: WARM, warmCompleted: resume.length, environment: setupEnvironment, rawMs: resume.map(sample => sample.elapsedMs), samples: resume }
  }
  const sampleRecords = resume.slice()
  const samples = resume.map(sample => sample.elapsedMs)
  for (let i = resume.length; i < WARM; i++) {
    const row = 1 + (i * 41) % 998
    const col = (i * 7) % 10
    const environment = await source.evaluate(() => ({
      visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
      pickMode: document.querySelector('[data-af-tool][data-af-active]')?.getAttribute('data-af-tool') || null
    }))
    if (environment.visibilityState !== 'visible' || environment.hasFocus !== true || environment.pickMode !== 'cell') {
      return { status: 'FAIL', stage: 'hover-precondition', row, col, warmRequested: WARM, warmCompleted: samples.length, environment, rawMs: samples, samples: sampleRecords }
    }
    let rect
    try {
      await bounded(`scroll cell ${row},${col}`, () => source.$eval(`#cell-${row}-${col}`, el => el.scrollIntoView({ block: 'center', inline: 'center' })), 5000)
      rect = await bounded(`measure cell ${row},${col}`, () => source.$eval(`#cell-${row}-${col}`, el => {
      const r = el.getBoundingClientRect()
      const table = el.closest('table').getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, cell: { left: r.left, top: r.top, width: r.width, height: r.height }, table: { left: table.left, top: table.top, width: table.width, height: table.height } }
      }), 5000)
    } catch (error) {
      return { status: 'FAIL', stage: 'fixture-cell-query', row, col, message: error?.message || String(error), warmRequested: WARM, warmCompleted: samples.length, rawMs: samples, samples: sampleRecords }
    }
    const started = performance.now()
    try {
      await bounded(`mousemove fixture ${row},${col}`, () => source.mouse.move(rect.x, rect.y), 8000)
      await bounded('hover paint frame', () => source.evaluate(() => new Promise(requestAnimationFrame)), 5000)
    } catch (error) {
      const elapsedMs = +(performance.now() - started).toFixed(2)
      samples.push(elapsedMs)
      const failedSample = { row, col, elapsedMs, environment, correct: false, status: 'FAIL', message: error?.message || String(error) }
      appendFileSync(HOVER_RAW, `${JSON.stringify({ kind: 'sample', timestamp: new Date().toISOString(), fingerprint, sampleIndex: i, sample: failedSample })}\n`)
      return { status: 'FAIL', stage: 'hover-response-frame', row, col, message: error?.message || String(error), warmRequested: WARM, warmCompleted: sampleRecords.length, failureAfterMs: elapsedMs, rawMs: samples, samples: [...sampleRecords, failedSample] }
    }
    const elapsedMs = +(performance.now() - started).toFixed(2)
    samples.push(elapsedMs)
    const correct = await source.evaluate(({ x, y, row, col, table }) => {
      const target = document.elementFromPoint(x, y)
      const highlight = document.querySelector('[data-af-highlight]')?.getBoundingClientRect()
      const expectedCell = target?.closest(`#cell-${row}-${col}`)
      const tableMatches = highlight && Math.abs(highlight.left - table.left) < 3 && Math.abs(highlight.top - table.top) < 3 && Math.abs(highlight.width - table.width) < 3
      return Boolean(expectedCell && tableMatches)
    }, { x: rect.x, y: rect.y, row, col, table: rect.table })
    const sampleEnvironment = await source.evaluate(() => ({
      visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
      pickMode: document.querySelector('[data-af-tool][data-af-active]')?.getAttribute('data-af-tool') || null
    }))
    const sample = { row, col, elapsedMs, environment: sampleEnvironment, correct, status: correct && sampleEnvironment.visibilityState === 'visible' && sampleEnvironment.hasFocus === true && sampleEnvironment.pickMode === 'cell' ? 'PASS' : 'FAIL' }
    sampleRecords.push(sample)
    appendFileSync(HOVER_RAW, `${JSON.stringify({ kind: 'sample', timestamp: new Date().toISOString(), fingerprint, sampleIndex: i, sample })}\n`)
    if (sample.status !== 'PASS') return { status: 'FAIL', stage: 'hover-correctness-or-focus', warmRequested: WARM, warmCompleted: sampleRecords.length - 1, rawMs: samples, samples: sampleRecords }
  }
  await extension.close()
  return { status: sampleRecords.length === WARM ? 'PASS' : 'FAIL', expectedRows: 1000, columnsPerRow: 10, warmRequested: WARM, warmCompleted: sampleRecords.length, response: samples.length ? summary(samples) : null, rawMs: samples, correctness: sampleRecords.length ? sampleRecords.filter(sample => sample.correct).length / sampleRecords.length : 0, setupEnvironment, samples: sampleRecords }
}

let report
let cases = []
try {
  if (!CHROME || !existsSync(CHROME)) throw new Error('Set BROWSER_PATH to a Chrome for Testing executable; normal Chrome is not supported.')
  if (!['all', 'hover'].includes(PICK_CASE)) throw new Error('AF23_PICK_CASE must be all or hover.')
  await startServer()
  const runtime = { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, logicalCpus: os.cpus().length }
  let extId
  const coldStarts = []
  if (PICK_CASE === 'all') {
    for (let i = 0; i < COLD; i++) {
      const started = performance.now()
      const instance = await launch()
      coldStarts.push(+(performance.now() - started).toFixed(2))
      extId = instance.extId
      await closeBrowser()
    }
  }
  const instance = await launch()
  extId = instance.extId
  runtime.browserVersion = await browser.version()
  for (const scenario of (PICK_CASE === 'all' ? MATRIX : [])) {
    const raw = []
    for (let i = 0; i < WARM; i++) {
      raw.push(await measureUi(instance.ui, scenario, fixtureUrl, i + 1))
      if ((i + 1) % 5 === 0) console.log(`[AF23 pick] ${scenario.id} ${i + 1}/${WARM}`)
    }
    const metric = key => raw.map(sample => sample[key].elapsedMs)
    const correctness = raw.every(sample => sample.groupSwitch.groups === scenario.groups &&
      sample.groupSwitch.totalValues === scenario.totalValues && sample.completionRender.rendered && sample.save.correctSavedCount)
    if (!correctness) throw new Error(`${scenario.id} fixture / UI correctness assertion failed: ${JSON.stringify(raw.filter(sample => !(sample.groupSwitch.groups === scenario.groups && sample.groupSwitch.totalValues === scenario.totalValues && sample.completionRender.rendered && sample.save.correctSavedCount)))}`)
    cases.push({
      scenario, warm: WARM, raw,
      groupSwitchMs: summary(metric('groupSwitch')),
      completionRenderMs: summary(metric('completionRender')),
      saveMs: summary(metric('save')),
      correctness: { groupAndValueCounts: true, completionRendered: true, savedTaskCountMatches: true }
    })
  }
  const hoverFingerprint = [CHROME, runtime.browserVersion, SRC, `${os.platform()}-${os.release()}-${os.arch()}`, 'headful', '1000x10', 'cell', 'visible-focus'].join('|')
  const prior = PICK_CASE === 'hover' ? priorHoverSamples(hoverFingerprint) : []
  const hover = await measureHover(instance.source, extId, { fingerprint: hoverFingerprint, resume: prior })
  const status = hover.status === 'PASS' ? 'PASS' : 'FAIL'
  if (status === 'FAIL') process.exitCode = 1
  report = {
    id: 'AF-23-E1-picker', status, timestamp: new Date().toISOString(), browser: CHROME, runtime, caseFilter: PICK_CASE, hoverFingerprint, resumedSamples: prior.length,
    fixture: { url: fixtureUrl, table: '1000 rows × 10 columns', values: 'row*10+column', seed: 0 },
    samplePlan: { coldStart: PICK_CASE === 'all' ? COLD : 0, warmOperationsPerScenario: PICK_CASE === 'all' ? WARM : null, hoverWarmSamples: WARM },
    measurementBoundary: {
      groupSwitch: 'Directly invokes the production Picker renderer once per sample with a new activeGroupKey; this isolates the render path and reports zero runtime-message/storage I/O.',
      completion: 'Calls production renderFromPanelCtx(batch) with a changed fixture item list; save separately calls production shared storage.saveTasks.',
      hover: 'Uses real ENTER_PICK and real pointer movement over the localhost table; the fixture tab is foregrounded before timing.'
    },
    coldStart: { extensionPageOpen: coldSummary(coldStarts), rawMs: coldStarts }, cases, hover
  }
} catch (error) {
  report = { id: 'AF-23-E1-picker', status: 'FAIL', timestamp: new Date().toISOString(), browser: CHROME || null, error: error?.stack || String(error), completedCases: cases }
  process.exitCode = 1
} finally {
  try { await closeBrowser() } catch (error) { report = { ...(report || {}), status: 'FAIL', cleanupError: String(error) }; process.exitCode = 1 }
  if (server?.listening) {
    server.closeAllConnections?.()
    await new Promise(done => server.close(done))
  }
}
if (report) {
  const output = resolve(PICK_CASE === 'hover' ? 'work/perf-pick-hover.json' : 'work/perf-pick.json')
  mkdirSync(resolve('work'), { recursive: true })
  report.outputFile = output
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  if (PICK_CASE === 'hover') appendFileSync(resolve('work/perf-pick-hover-runs.jsonl'), `${JSON.stringify(report)}\n`)
}
console.log(JSON.stringify(report, null, 2))
