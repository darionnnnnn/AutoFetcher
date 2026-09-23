// AF-22 R15 bounded real-browser capacity/lifecycle audit.
// Run with: node tests/smoke/af22_r15_capacity.mjs
// Uses an isolated CfT profile and a local fixture; never touches user Chrome data.
import puppeteer from 'puppeteer-core'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'

const SRC = resolve('src')
const CHROME = process.env.BROWSER_PATH || join(os.tmpdir(), 'af22-cft', 'chrome', 'win64-154.0.8037.57', 'chrome-win64', 'chrome.exe')
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><title>AF22 R15 fixture</title><div id="price">123.45</div>')
})
const listen = () => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)) })
const bounded = async (label, fn, ms = 15000) => {
  let timer
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms) })]) }
  finally { clearTimeout(timer) }
}
const median = xs => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] || 0 }

let browser, profile, port
try {
  if (!existsSync(CHROME)) throw new Error(`Chrome for Testing binary unavailable: ${CHROME}`)
  port = await listen()
  const fixtureUrl = `http://127.0.0.1:${port}/`
  profile = mkdtempSync(join(os.tmpdir(), 'af22-r15-'))
  browser = await bounded('launch isolated CfT', () => puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  }), 30000)
  const worker = await bounded('extension worker', async () => {
    for (let i = 0; i < 100; i++) {
      const target = browser.targets().find(t => t.type() === 'service_worker' && t.url().includes('/background/main.js'))
      if (target) return target
      await wait(200)
    }
    throw new Error('extension service worker did not start')
  }, 22000)
  const extId = new URL(worker.url()).host
  const targetPage = await browser.newPage()
  await targetPage.setViewport({ width: 1000, height: 800 })
  await targetPage.goto(fixtureUrl, { waitUntil: 'load' })
  const extensionPage = await browser.newPage()
  await extensionPage.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  const tabId = await extensionPage.evaluate(async url => (await chrome.tabs.query({ url }))[0]?.id, fixtureUrl)
  if (!tabId) throw new Error('could not resolve fixture tab id')
  await extensionPage.evaluate(async ({ id }) => {
    await chrome.sidePanel.setOptions({ tabId: id, path: 'ui/picker/picker.html', enabled: true })
    await chrome.tabs.update(id, { active: true })
    const button = document.createElement('button')
    button.id = 'r15-open-panel'
    button.textContent = 'Open R15 panel'
    button.style.cssText = 'position:fixed;left:10px;top:10px;width:180px;height:50px;z-index:999999'
    button.onclick = async () => {
      try { await chrome.sidePanel.open({ tabId: id }); button.dataset.opened = 'true' }
      catch (error) { button.dataset.error = String(error) }
    }
    document.body.append(button)
  }, { id: tabId })
  await extensionPage.waitForSelector('#r15-open-panel')
  await extensionPage.click('#r15-open-panel')
  const pickerTarget = await bounded('real side panel target', async () => {
    for (let i = 0; i < 80; i++) {
      const target = browser.targets().find(t => t.url().includes('/ui/picker/picker.html'))
      if (target) return target
      await wait(150)
    }
    throw new Error('side panel picker target missing')
  })
  const pickerCdp = await pickerTarget.createCDPSession()
  await pickerCdp.send('Runtime.enable')
  const picker = {
    async evaluate(fn, ...args) {
      const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
      const result = await pickerCdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result?.value
    }
  }

  // Actual session-backed protocol: 20 groups × 100 values in one begin, then
  // 100 set-active ACKs through main.js (including content drain/forwarding).
  const sessionId = `r15-${Date.now()}`
  const documentGeneration = `doc-${Date.now()}`
  const routeIdentity = { url: fixtureUrl }
  const groups = Array.from({ length: 20 }, (_, gi) => ({
    key: `group-${gi}`, name: `Group ${gi + 1}`,
    values: Array.from({ length: 100 }, (_, vi) => ({
      key: `g${gi}-v${vi}`, name: `Value ${gi + 1}-${vi + 1}`,
      spec: { selector: '#price', type: 'text' }
    }))
  }))
  console.log('[R15] CfT started; sending 20×100 draft')
  const beginAt = performance.now()
  const begun = await bounded('PICK_DRAFT_BEGIN', () => picker.evaluate(async payload => chrome.runtime.sendMessage({ type: 'PICK_DRAFT_BEGIN', ...payload }), {
    sessionId, tabId, documentGeneration, routeIdentity, groups, activeGroupKey: groups[0].key, stage: 'selecting', form: {}
  }), 25000)
  if (!begun?.ok) throw new Error(`PICK_DRAFT_BEGIN failed: ${JSON.stringify(begun)}`)
  const beginMs = performance.now() - beginAt
  const stats = { writes: 0, writeBytes: 0, writeEvents: [] }
  await extensionPage.evaluate(() => {
    window.__r15StorageStats = { writes: 0, writeBytes: 0, writeEvents: [] }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session' || !changes['pickDraft:' + window.__r15TabId]) return
      const raw = JSON.stringify(changes['pickDraft:' + window.__r15TabId].newValue ?? null)
      window.__r15StorageStats.writes++
      window.__r15StorageStats.writeBytes += new TextEncoder().encode(raw).length
      window.__r15StorageStats.writeEvents.push(performance.now())
    })
  })
  await extensionPage.evaluate(id => { window.__r15TabId = id }, tabId)
  // Enter the content picker with the exact identities used by the draft.
  const entered = await picker.evaluate(async payload => chrome.runtime.sendMessage({
    type: 'ENTER_PICK', purpose: 'task', batch: true, ...payload, frameId: 0,
    pickStage: 'selecting', draftValues: payload.values
  }), { tabId, sessionId, groupKey: groups[0].key, documentGeneration, routeIdentity, values: groups[0].values })
  if (entered?.ok === false) throw new Error(`ENTER_PICK failed: ${JSON.stringify(entered)}`)
  console.log('[R15] picker entered; measuring 100 active-group switches')
  await wait(150)

  let revision = begun.draft.revision
  const switchLatencies = []
  for (let i = 0; i < 100; i++) {
    const groupKey = groups[(i + 1) % groups.length].key
    const started = performance.now()
    const response = await bounded(`set-active ${i + 1}`, () => picker.evaluate(async args => chrome.runtime.sendMessage({
      type: 'PICK_DRAFT_OPERATION', tabId: args.tabId, sessionId: args.sessionId,
      expectedRevision: args.revision, operationId: `switch-${args.index}`,
      documentGeneration: args.documentGeneration, routeIdentity: args.routeIdentity,
      operation: { type: 'set-active', activeGroupKey: args.groupKey }
    }), { tabId, sessionId, revision, documentGeneration, routeIdentity, groupKey, index: i }), 12000)
    switchLatencies.push(performance.now() - started)
    if (!response?.ok) throw new Error(`set-active ${i + 1} failed: ${JSON.stringify(response)}`)
    revision = response.revision
    if ((i + 1) % 10 === 0) console.log(`[R15] switches ${i + 1}/100`)
  }
  await wait(100)
  const sessionValue = await extensionPage.evaluate(async id => (await chrome.storage.session.get(`pickDraft:${id}`))[`pickDraft:${id}`], tabId)
  const serializedSessionBytes = new TextEncoder().encode(JSON.stringify(sessionValue)).length
  Object.assign(stats, await extensionPage.evaluate(() => window.__r15StorageStats))

  const cdp = await targetPage.createCDPSession()
  await cdp.send('Runtime.enable')
  await cdp.send('Performance.enable')
  const inspectBodyListeners = async () => {
    const bodyEval = await cdp.send('Runtime.evaluate', { expression: 'document.body', returnByValue: false })
    const result = await cdp.send('DOMDebugger.getEventListeners', { objectId: bodyEval.result.objectId })
    return result.listeners?.length ?? null
  }
  const inspectHeap = async () => {
    const snapshot = await cdp.send('Performance.getMetrics')
    return snapshot.metrics.find(x => x.name === 'JSHeapUsedSize')?.value ?? null
  }
  const listenersBefore = await inspectBodyListeners()
  const heapBefore = await inspectHeap()

  // Ten real ENTER_PICK/EXIT_PICK lifecycle cycles on the fixture document.
  const cycleMs = []
  const cycleEvidence = []
  console.log('[R15] switch measurement complete; measuring 10 enter/exit cycles')
  for (let i = 0; i < 10; i++) {
    const start = performance.now()
    const enter = await picker.evaluate(async args => chrome.runtime.sendMessage({
      type: 'ENTER_PICK', purpose: 'task', batch: true, tabId: args.tabId,
      sessionId: args.sessionId, groupKey: args.groupKey, pickStage: 'selecting',
      documentGeneration: args.documentGeneration, routeIdentity: args.routeIdentity, draftValues: []
    }), { tabId, sessionId, groupKey: groups[i % groups.length].key, documentGeneration, routeIdentity })
    if (enter?.ok === false) throw new Error(`lifecycle ENTER_PICK ${i + 1} failed: ${JSON.stringify(enter)}`)
    const exit = await extensionPage.evaluate(async id => {
      try { return await chrome.tabs.sendMessage(id, { type: 'EXIT_PICK' }) }
      catch (error) { return { ok: false, error: error.message } }
    }, tabId)
    if (exit?.ok === false) throw new Error(`lifecycle EXIT_PICK ${i + 1} failed: ${JSON.stringify(exit)}`)
    cycleMs.push(performance.now() - start)
    await wait(30)
    cycleEvidence.push(await targetPage.evaluate(() => ({
      marks: document.querySelectorAll('[data-af-picked], [data-af-excluded], [data-af-mark], [data-af-overlay]').length,
      bodyMarks: [...document.body.attributes].filter(a => a.name.startsWith('data-af-')).length,
      domNodes: document.getElementsByTagName('*').length
    })))
  }
  const final = cycleEvidence.at(-1)
  if (final.marks || final.bodyMarks) throw new Error(`picker marks leaked after exit: ${JSON.stringify(final)}`)

  const listenersAfter = await inspectBodyListeners()
  const heapAfter = await inspectHeap()
  const system = await extensionPage.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform || navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null
  }))
  const result = {
    status: 'PASS', browser: CHROME, system, fixture: fixtureUrl,
    model: { groups: 20, valuesPerGroup: 100, totalValues: 2000, beginMs: +beginMs.toFixed(2), serializedSessionBytes },
    switches: { requested: 100, completed: switchLatencies.length, writes: stats.writes, writeBytes: stats.writeBytes,
      latencyMs: { median: +median(switchLatencies).toFixed(2), max: +Math.max(...switchLatencies).toFixed(2) } },
    lifecycle: { rounds: cycleMs.length, medianMs: +median(cycleMs).toFixed(2), maxMs: +Math.max(...cycleMs).toFixed(2), finalDom: final,
      bodyEventListeners: { before: listenersBefore, after: listenersAfter, delta: listenersBefore === null || listenersAfter === null ? null : listenersAfter - listenersBefore },
      jsHeapUsedSizeBytes: { before: heapBefore, after: heapAfter, delta: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore } },
    baseline: { source: 'docs/AF-22-PLAN.md R15 evidence; Node mock only', mockSwitches: 100, mockWrites: 101, mockAverageMs: 167,
      comparison: 'Different runtime/path; descriptive only, not a real-Chrome baseline.' },
    limitations: ['WeakMap/Map source-cache cardinality is not directly observable from the isolated content script.',
      'CDP listener count is for the inspected page-world body object; it does not enumerate isolated-world listeners.',
      'Same-site queue-delay measurement is not included in this revision; no pre-AF22 real-browser baseline is available.']
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`FAIL R15 capacity audit: ${error?.stack || error}`)
  process.exitCode = 1
} finally {
  if (browser) {
    const p = browser.process?.()
    try { await browser.close() } catch {}
    if (p && p.exitCode === null && !p.killed) { p.kill(); await new Promise(r => { const timer = setTimeout(r, 2000); p.once('exit', () => { clearTimeout(timer); r() }) }) }
  }
  if (server.listening) { server.closeAllConnections?.(); await new Promise(resolveClose => server.close(resolveClose)) }
  if (profile) {
    const temp = resolve(os.tmpdir())
    const abs = resolve(profile)
    if (abs.startsWith(`${temp}\\`) && abs.split(/[\\/]/).pop()?.startsWith('af22-r15-')) rmSync(abs, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
    else console.error(`refused profile cleanup outside temp: ${abs}`)
  }
}
