// AF-23 E1 user-event UI gate. Unlike af23_perf_pick.mjs' isolated renderer
// microbench, this harness uses the real Side Panel and visible controls.
import puppeteer from 'puppeteer-core'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join, resolve, sep } from 'node:path'

const SRC = resolve(process.env.AF23_EXTENSION_PATH || 'src')
const CHROME = process.env.BROWSER_PATH
const WARM = 20
const DIAGNOSTIC = process.env.AF23_PICK_UI_DIAGNOSTIC === '1'
const SAMPLE_COUNT = Number(process.env.AF23_PICK_UI_SAMPLES || WARM)
const CASE_FILTER = process.env.AF23_PICK_UI_CASE || ''
const MATRIX = [
  { id: '1group-1value', groups: 1, totalValues: 1 },
  { id: '5group-20values', groups: 5, totalValues: 20 },
  { id: '20group-100values', groups: 20, totalValues: 100 }
]
const HASH_INPUTS = [
  'manifest.json', 'background/main.js', 'background/fetcher.js', 'background/login.js',
  'content/picker-mode.js', 'shared/pick-protocol.js', 'shared/storage.js',
  'ui/picker/picker.js', 'ui/picker/picker.html'
]
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const sorted = values => [...values].sort((a, b) => a - b)
const summary = values => ({ count: values.length, p50Ms: +sorted(values)[Math.ceil(values.length * 0.5) - 1].toFixed(2), p95Ms: +sorted(values)[Math.ceil(values.length * 0.95) - 1].toFixed(2), maxMs: +Math.max(...values).toFixed(2) })
const bounded = async (label, fn, ms = 30000) => {
  let timer
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms) })]) }
  finally { clearTimeout(timer) }
}
function extensionSourceHash() {
  const hash = createHash('sha256')
  for (const file of HASH_INPUTS) {
    const absolute = join(SRC, file)
    if (!existsSync(absolute)) throw new Error(`extension source hash input missing: ${absolute}`)
    hash.update(file).update('\0').update(readFileSync(absolute)).update('\0')
  }
  return { algorithm: 'sha256', files: HASH_INPUTS, value: hash.digest('hex') }
}

let server
let browser
let profile
let fixtureUrl
let fixtureHtml
let sourceFingerprint

async function startFixture() {
  fixtureHtml = `<!doctype html><meta charset="utf-8"><title>AF23 picker UI fixture</title><table><tbody>${Array.from({ length: 1000 }, (_, row) => `<tr>${Array.from({ length: 10 }, (_, col) => `<td id="cell-${row}-${col}" data-value="${row * 10 + col}">${row * 10 + col}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(fixtureHtml)
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`
}

async function closeBrowser() {
  if (browser) {
    const proc = browser.process?.()
    try { await Promise.race([browser.close(), wait(3000)]) } catch {}
    if (proc && proc.exitCode === null && !proc.killed) proc.kill()
    browser = null
  }
  if (profile) {
    const tmp = resolve(os.tmpdir())
    const abs = resolve(profile)
    if (!abs.startsWith(`${tmp}${sep}`) || !abs.split(/[\\/]/).pop()?.startsWith('af23-pick-ui-')) throw new Error(`refused to remove profile outside temp root: ${abs}`)
    rmSync(abs, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    profile = null
  }
}

async function launch() {
  profile = mkdtempSync(join(os.tmpdir(), 'af23-pick-ui-'))
  browser = await bounded('launch isolated CfT', () => puppeteer.launch({
    executablePath: CHROME, headless: false, userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  }), 45000)
  const worker = await bounded('extension service worker', async () => {
    for (let i = 0; i < 120; i++) {
      const target = browser.targets().find(item => item.type() === 'service_worker' && item.url().includes('/background/main.js'))
      if (target) return target
      await wait(100)
    }
    throw new Error('extension worker not found')
  }, 15000)
  return new URL(worker.url()).host
}

async function pickerTargetFor(tabId) {
  let lastCandidates = []
  const target = await bounded(`side panel target for tab ${tabId}`, async () => {
    for (let i = 0; i < 120; i++) {
      const candidates = browser.targets().filter(item => item.url().includes('/ui/picker/picker.html'))
      lastCandidates = []
      for (const candidate of candidates) {
        try {
          const probe = await candidate.createCDPSession()
          await probe.send('Runtime.enable')
          const result = await probe.send('Runtime.evaluate', { expression: `(async()=>({tab:(await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id, visible:document.visibilityState, ready:Boolean(document.querySelector('#group-start-first'))}))()`, awaitPromise: true, returnByValue: true })
          const value = result.result?.value
          lastCandidates.push({ url: candidate.url(), ...value })
          await probe.detach()
          if (value?.tab === tabId && value.visible === 'visible' && value.ready) return candidate
        } catch (error) { lastCandidates.push({ url: candidate.url(), error: String(error?.message || error) }) }
      }
      await wait(100)
    }
    throw new Error(`no visible side panel for tab ${tabId}; candidates=${JSON.stringify(lastCandidates)}`)
  }, 15000)
  const cdp = await target.createCDPSession()
  await cdp.send('Runtime.enable')
  const evaluate = async (fn, ...args) => {
    const result = await cdp.send('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  const actualClick = async selector => {
    const inspect = s => {
        const element = document.querySelector(s)
        if (!element) return { missing: true }
        element.scrollIntoView({ block: 'center' })
        const rect = element.getBoundingClientRect()
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
        const hit = document.elementFromPoint(x, y)
        return { x, y, width: rect.width, height: rect.height, hidden: element.hidden || Boolean(element.closest('[hidden]')), disabled: Boolean(element.disabled), matched: hit === element || element.contains(hit) }
    }
    let info = await evaluate(inspect, selector)
    for (let attempt = 0; attempt < 5 && (!info || info.missing || info.hidden || info.disabled || !info.matched || info.width <= 0 || info.height <= 0); attempt++) {
      await evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
      info = await evaluate(inspect, selector)
    }
    if (!info || info.missing || info.hidden || info.disabled || !info.matched || info.width <= 0 || info.height <= 0) {
      const state = await evaluate(() => ({
        visibility: document.visibilityState,
        groupSectionHidden: document.querySelector('#group-draft-section')?.hidden ?? null,
        groupRows: [...document.querySelectorAll('#group-list [data-group-row]')].map(row => ({ key: row.dataset.groupKey, values: row.querySelectorAll('[data-group-value]').length })),
        startFirstHidden: document.querySelector('#group-start-first')?.hidden ?? null,
        finishHidden: document.querySelector('#group-finish')?.hidden ?? null,
        batchHidden: document.querySelector('#batch-section')?.hidden ?? null,
        waiting: document.querySelector('#panel-waiting')?.textContent?.trim() || ''
      }))
      throw new Error(`side panel control unavailable: ${selector} ${JSON.stringify({ info, state })}`)
    }
    let stable = false
    for (let attempt = 0; attempt < 4; attempt++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y })
      await evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
      const settled = await evaluate(inspect, selector)
      if (!settled || settled.missing || settled.hidden || settled.disabled || !settled.matched || settled.width <= 0 || settled.height <= 0) {
        throw new Error(`side panel control changed after hover: ${selector} ${JSON.stringify(settled)}`)
      }
      if (Math.abs(settled.x - info.x) <= 1 && Math.abs(settled.y - info.y) <= 1 && Math.abs(settled.width - info.width) <= 1 && Math.abs(settled.height - info.height) <= 1) {
        info = settled
        stable = true
        break
      }
      info = settled
    }
    if (!stable) throw new Error(`side panel control did not settle after hover: ${selector} ${JSON.stringify(info)}`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  }
  return { target, cdp, evaluate, actualClick }
}

async function visibleClick(page, selector) {
  await page.waitForSelector(selector, { timeout: 10000 })
  const element = await page.$(selector)
  await element.evaluate(node => node.scrollIntoView({ block: 'center' }))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const box = await element.boundingBox()
  if (!box) throw new Error(`fixture click target has no visible bounds: ${selector}`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function installMeters(picker) {
  await picker.evaluate(() => {
    const meter = window.__af23Meter = { api: [], events: [], listeners: 0 }
    const bytes = value => { try { return new TextEncoder().encode(JSON.stringify(value ?? null)).length } catch { return 0 } }
    const wrap = (object, area, method) => {
      const original = object?.[method]
      if (typeof original !== 'function') return false
      try {
        object[method] = function (...args) {
          const call = { area, method, requestBytes: bytes(args), responseBytes: 0, startedAt: performance.now() }
          meter.api.push(call)
          const result = original.apply(this, args)
          return Promise.resolve(result).then(value => { call.responseBytes = bytes(value); call.completedAt = performance.now(); return value })
        }
        return object[method] !== original
      } catch { return false }
    }
    const wrapped = {
      localGet: wrap(chrome.storage.local, 'local', 'get'), localSet: wrap(chrome.storage.local, 'local', 'set'),
      sessionGet: wrap(chrome.storage.session, 'session', 'get'), sessionSet: wrap(chrome.storage.session, 'session', 'set'),
      sendMessage: wrap(chrome.runtime, 'runtime', 'sendMessage')
    }
    if (Object.values(wrapped).some(value => !value)) throw new Error(`API interception unavailable: ${JSON.stringify(wrapped)}`)
    document.addEventListener('click', event => {
      const button = event.target?.closest?.('button')
      if (!button) return
      const selector = button.id ? `#${button.id}` : button.closest('[data-group-row]') ? `group:${button.closest('[data-group-row]').dataset.groupKey}:${button.textContent.trim()}` : null
      if (!selector) return
      const groupRow = button.closest('[data-group-row]')
      const record = {
        selector, sampleIndex: meter.pendingSampleIndex ?? null, startedAt: performance.now(), busyFrame: null,
        pressedControlBefore: { id: button.id || null, groupKey: groupRow?.dataset.groupKey || null, label: button.textContent?.trim() || '', disabled: Boolean(button.disabled), ariaDisabled: button.getAttribute('aria-disabled') }
      }
      meter.events.push(record)
      meter.pendingSampleIndex = null
      requestAnimationFrame(() => {
        const control = button.isConnected
          ? button
          : (record.pressedControlBefore.id
              ? document.getElementById(record.pressedControlBefore.id)
              : (record.pressedControlBefore.groupKey
                  ? document.querySelector(`[data-group-row][data-group-key="${record.pressedControlBefore.groupKey}"] button`)
                  : null))
        const groupStatus = document.querySelector('#group-draft-status')
        const batchSection = document.querySelector('#batch-section')
        const saved = document.querySelector('#saved-feedback')
        const resultRows = [...document.querySelectorAll('#batch-list [data-batch-item]')].map(row => row.querySelector('[data-batch-result]')?.textContent?.trim() || '')
        record.busyFrame = {
          at: performance.now(),
          control: control ? { id: control.id || null, groupKey: control.closest('[data-group-row]')?.dataset.groupKey || null, label: control.textContent?.trim() || '', disabled: Boolean(control.disabled), ariaDisabled: control.getAttribute('aria-disabled') } : null,
          resultUi: { groupStatus: groupStatus?.textContent?.trim() || '', batchHidden: Boolean(batchSection?.hidden), batchRows: resultRows.length, batchResults: resultRows, savedText: saved?.textContent?.trim() || '' }
        }
      })
    }, true)
  })
}

async function readDraft(picker, tabId) {
  const response = await picker.evaluate(async id => chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id }), tabId)
  if (response?.ok !== true) throw new Error(`PICK_DRAFT_READ failed for tab ${tabId}: ${JSON.stringify(response)}`)
  return response.draft
}

async function applyOperation(picker, draft, operation, sequence, { render = true } = {}) {
  const response = await picker.evaluate(async ({ draft, operation, sequence }) => chrome.runtime.sendMessage({
    type: 'PICK_DRAFT_OPERATION', tabId: draft.tabId, sessionId: draft.sessionId,
    documentGeneration: draft.documentGeneration, documentIdentity: draft.documentIdentity,
    routeIdentity: draft.routeIdentity, frame: draft.frame,
    operationId: `af23-ui-${sequence}-${Date.now()}`, expectedRevision: draft.revision, operation
  }), { draft, operation, sequence })
  if (response?.ok !== true || !response.draft) throw new Error(`PICK_DRAFT_OPERATION failed: ${JSON.stringify(response)}`)
  if (render) {
    await picker.evaluate(next => {
      const api = window.__af23Picker
      api.setPickDraftContext(next, { render: false })
      api.renderPickDraft(next)
    }, response.draft)
  }
  return response.draft
}

async function eventResult(picker, sampleIndex, expected) {
  return bounded(`wait for correct UI frame ${expected.kind} sample ${sampleIndex}`, () => picker.evaluate(({ sampleIndex, expected }) => new Promise((resolveResult, reject) => {
    const deadline = performance.now() + 10000
    const checkFrame = () => requestAnimationFrame(() => {
      const current = [...window.__af23Meter.events].reverse().find(event => event.sampleIndex === sampleIndex)
      if (current) {
        let ok = false
        if (expected.kind === 'active') ok = document.querySelector(`[data-group-row][data-group-key="${expected.key}"]`)?.dataset.active === 'true'
        if (expected.kind === 'settings') ok = !document.querySelector('#batch-section')?.hidden && document.querySelectorAll('#batch-list [data-batch-item]').length === expected.count
        if (expected.kind === 'saved') ok = Boolean(document.querySelector('#saved-feedback'))
        if (ok) return resolveResult({ startedAt: current.startedAt, resultFrameAt: performance.now(), elapsedMs: +(performance.now() - current.startedAt).toFixed(2), busyFrame: current.busyFrame, state: expected.kind })
      }
      if (performance.now() > deadline) {
        const section = document.querySelector('#batch-section')
        const rows = [...document.querySelectorAll('#batch-list [data-batch-item]')]
        const groupRows = [...document.querySelectorAll('#group-list [data-group-row]')]
        const diagnostics = {
          expected, lastClick: current || null,
          batchHidden: section?.hidden ?? null, batchRowCount: rows.length,
          batchLabels: rows.map(row => row.querySelector('[data-batch-name]')?.value || ''),
          groupDraftHidden: document.querySelector('#group-draft-section')?.hidden ?? null,
          groupRows: groupRows.map(row => ({ key: row.dataset.groupKey, active: row.dataset.active, values: row.querySelectorAll('[data-group-value]').length })),
          finish: { hidden: document.querySelector('#group-finish')?.hidden ?? null, disabled: document.querySelector('#group-finish')?.disabled ?? null },
          status: document.querySelector('#group-draft-status')?.textContent?.trim() || '',
          panelWaiting: document.querySelector('#panel-waiting')?.textContent?.trim() || ''
        }
        return reject(new Error(`result frame timeout: ${JSON.stringify(diagnostics)}`))
      }
      setTimeout(check, 20)
    })
    const check = () => {
      if (performance.now() > deadline && document.visibilityState !== 'visible') {
        const lastClick = [...window.__af23Meter.events].reverse().find(event => event.sampleIndex === sampleIndex) || null
        return reject(new Error(`no visible result frame before timeout: ${JSON.stringify({ expected, visibility: document.visibilityState, lastClick })}`))
      }
      if (performance.now() > deadline) return checkFrame()
      const current = [...window.__af23Meter.events].reverse().find(event => event.sampleIndex === sampleIndex)
      if (current && document.visibilityState === 'visible') return checkFrame()
      setTimeout(check, 20)
    }
    check()
  }), { sampleIndex, expected }), 12000)
}

async function eventListenerCounts(picker, selectors) {
  const output = {}
  for (const selector of selectors) {
    try {
      const remote = await picker.cdp.send('Runtime.evaluate', { expression: selector === 'document' ? 'document' : `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false })
      const objectId = remote.result?.objectId
      if (!objectId) { output[selector] = null; continue }
      const response = await picker.cdp.send('DOMDebugger.getEventListeners', { objectId, depth: 1, pierce: true })
      output[selector] = (response.listeners || []).length
    } catch { output[selector] = null }
  }
  return output
}

async function setupDraft(extId, scenario, sampleIndex) {
  const report = await browser.newPage()
  await report.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  await report.evaluate(async () => chrome.storage.local.clear())
  const target = await browser.newPage()
  await target.setViewport({ width: 1280, height: 900 })
  const url = `${fixtureUrl}?scenario=${scenario.id}&sample=${sampleIndex}`
  await target.goto(url, { waitUntil: 'load' })
  const tabId = await report.evaluate(async targetUrl => (await chrome.tabs.query({ url: targetUrl }))[0]?.id, url)
  if (!Number.isInteger(tabId)) throw new Error('fixture tab has no Chrome tab identity')
  await report.evaluate(async ({ tabId, url }) => {
    await chrome.storage.session.set({ [`panel:${tabId}`]: { kind: 'new', batch: true, tabId, url } })
    await chrome.sidePanel.setOptions({ tabId, path: 'ui/picker/picker.html', enabled: true })
    await chrome.tabs.update(tabId, { active: true })
  }, { tabId, url })
  // Opening the side panel is setup, not a measured product interaction. Use
  // an extension-page CDP user gesture while the fixture tab is the active tab;
  // mouse-clicking a background report tab can lose Chrome's active-tab check.
  const reportCdp = await report.createCDPSession()
  await reportCdp.send('Runtime.enable')
  const openResult = await reportCdp.send('Runtime.evaluate', {
    expression: `(async tabId => { try { await chrome.sidePanel.open({ tabId }); return { ok: true } } catch (error) { return { ok: false, error: String(error?.message || error) } } })(${JSON.stringify(tabId)})`,
    awaitPromise: true, returnByValue: true, userGesture: true
  })
  await reportCdp.detach()
  const openAck = openResult.result?.value
  if (openResult.exceptionDetails || openAck?.ok !== true) throw new Error(`sidePanel.open failed for active target tab ${tabId}: ${JSON.stringify(openAck || openResult.exceptionDetails)}`)
  const picker = await pickerTargetFor(tabId)
  await picker.evaluate(() => { window.__af23PickerPromise = import(chrome.runtime.getURL('ui/picker/picker.js')) })
  await picker.evaluate(() => window.__af23PickerPromise.then(api => { window.__af23Picker = api }))
  await picker.evaluate(() => new Promise(requestAnimationFrame))
  await picker.actualClick('#group-start-first')
  await picker.evaluate(() => new Promise(resolveInput => {
    const waitInput = () => document.querySelector('#group-name-editor:not([hidden])') ? resolveInput() : setTimeout(waitInput, 30)
    waitInput()
  }))
  await picker.evaluate(name => { const input = document.querySelector('#group-name'); input.value = name; input.dispatchEvent(new Event('input', { bubbles: true })) }, `Group 1 ${sampleIndex}`)
  await picker.actualClick('#group-name-confirm')
  await target.waitForSelector('[data-af-overlay] [data-af-done]', { timeout: 15000 })
  await visibleClick(target, '#cell-0-0')
  await wait(350)
  let draft = await readDraft(picker, tabId)
  if (!draft || draft.groups?.[0]?.values?.length !== 1) throw new Error(`first true selection did not produce exactly one value: ${JSON.stringify(draft?.groups?.[0]?.values?.length)}`)
  const identity = { tabId: draft.tabId, sessionId: draft.sessionId, documentGeneration: draft.documentGeneration, routeIdentity: draft.routeIdentity }
  if (draft.tabId !== tabId || !draft.sessionId || !draft.documentGeneration || !draft.routeIdentity || draft.groups.length !== 1 || draft.groups[0].values.length !== 1) throw new Error(`invalid real panel draft identity/selection: ${JSON.stringify(identity)}`)
  const actual = draft.groups[0].values[0]
  if (!actual?.source?.locator || !Number.isInteger(actual.spec?.cell?.row?.index) || !Number.isInteger(actual.spec?.cell?.col?.index)) throw new Error(`real selection did not produce a canonical table-cell source: ${JSON.stringify(actual)}`)
  const values = Array.from({ length: scenario.totalValues }, (_, i) => {
    const value = structuredClone(actual)
    if (i > 0) {
      value.key = `field-${i + 1}`
      value.name = `Value ${i + 1}`
    }
    return value
  })
  const perGroup = Math.floor(scenario.totalValues / scenario.groups)
  let cursor = 0
  const groups = Array.from({ length: scenario.groups }, (_, gi) => {
    const count = perGroup + (gi < scenario.totalValues % scenario.groups ? 1 : 0)
    const groupValues = values.slice(cursor, cursor + count)
    cursor += count
    return { key: gi === 0 ? draft.groups[0].key : `af23-group-${sampleIndex}-${gi + 1}`, name: `Group ${gi + 1} ${sampleIndex}`, values: groupValues }
  })
  if (groups[0].values[0].key !== actual.key) throw new Error('first canonical picked value was not retained during seed')
  for (const value of groups[0].values.slice(1)) {
    draft = await applyOperation(picker, draft, { type: 'add', groupKey: groups[0].key, value }, ++cursor, { render: false })
  }
  for (let gi = 1; gi < groups.length; gi++) {
    draft = await applyOperation(picker, draft, { type: 'create-group', group: groups[gi] }, ++cursor, { render: false })
  }
  draft = await applyOperation(picker, draft, { type: 'rename', groupKey: groups[0].key, name: groups[0].name }, ++cursor, { render: false })
  await picker.evaluate(next => {
    const api = window.__af23Picker
    api.setPickDraftContext(next, { render: false })
    api.renderPickDraft(next)
  }, draft)
  const finalDraft = await readDraft(picker, tabId)
  const sourceCells = finalDraft.groups.flatMap(group => group.values.map(value => ({ locator: value.source?.locator, cell: value.spec?.cell })))
  const sourceCorrect = sourceCells.length === scenario.totalValues && sourceCells.every(item => item.locator && item.cell?.row?.index === actual.spec.cell.row.index && item.cell?.col?.index === actual.spec.cell.col.index)
  const targetCorrect = await target.evaluate(cells => cells.every(({ locator, cell }) => {
    let table = null
    try {
      if (locator?.css) table = document.querySelector(locator.css)
      else if (locator?.path) table = document.querySelector(locator.path)
      else if (locator?.xpath) table = document.evaluate(locator.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
    } catch {}
    const targetCell = table?.rows?.[cell.row.index]?.cells?.[cell.col.index]
    return Boolean(targetCell && Number(targetCell.dataset.value) === 0)
  }), sourceCells)
  if (!sourceCorrect || !targetCorrect) throw new Error(`seeded draft source validation failed: ${JSON.stringify({ count: sourceCells.length, sourceCorrect, targetCorrect })}`)
  await installMeters(picker)
  if (!finalDraft) throw new Error('the real UI selection did not create a protocol draft')
  return { report, target, picker, tabId, draft: finalDraft, identity, scenario }
}

async function measureScenario(extId, scenario, sampleCount) {
  const scenarioStartedAt = performance.now()
  const groupSwitch = [], completion = [], save = [], samples = []
  for (let index = 0; index < sampleCount; index++) {
    const setup = await setupDraft(extId, scenario, index + 1)
    const { picker, target, report, tabId } = setup
    const beforeListeners = await eventListenerCounts(picker, ['document', '#group-finish', '#save'])
    const apiStart = await picker.evaluate(() => window.__af23Meter.api.length)
    const baselineTasks = await report.evaluate(async () => {
      const storage = await import(chrome.runtime.getURL('shared/storage.js'))
      const tasks = await storage.getTasks()
      return { count: tasks.length, fields: tasks.reduce((sum, task) => sum + (task.fields?.length || 0), 0) }
    })
    let switchResult = { notApplicable: true, reason: 'A one-group draft has no group-switch user action.' }
    if (scenario.groups > 1) {
      if (DIAGNOSTIC) console.log(`[diagnostic] sample ${index + 1}/${sampleCount}: click group switch`)
      // Each fresh draft is active on its first group, so always switch to
      // the last group; alternating here would make every other click a no-op.
      const targetGroup = setup.draft.groups.at(-1)
      await picker.evaluate(sampleIndex => { window.__af23Meter.pendingSampleIndex = sampleIndex }, index)
      await picker.actualClick(`[data-group-row][data-group-key="${targetGroup.key}"] button`)
      switchResult = await eventResult(picker, index, { kind: 'active', key: targetGroup.key })
      groupSwitch.push(switchResult.elapsedMs)
    }

    if (DIAGNOSTIC) console.log(`[diagnostic] sample ${index + 1}/${sampleCount}: click finish`)
    await picker.evaluate(sampleIndex => { window.__af23Meter.pendingSampleIndex = sampleIndex }, index)
    await picker.actualClick('#group-finish')
    const completionResult = await eventResult(picker, index, { kind: 'settings', count: scenario.groups })
    completion.push(completionResult.elapsedMs)

    if (DIAGNOSTIC) console.log(`[diagnostic] sample ${index + 1}/${sampleCount}: click save`)
    await picker.evaluate(sampleIndex => { window.__af23Meter.pendingSampleIndex = sampleIndex }, index)
    await picker.actualClick('#save')
    const saveResult = await eventResult(picker, index, { kind: 'saved' })
    const apiEnd = await picker.evaluate(() => window.__af23Meter.api.length)
    save.push(saveResult.elapsedMs)
    const afterListeners = await eventListenerCounts(picker, ['document', '#group-finish', '#save'])
    const persisted = await report.evaluate(async expected => {
      const storage = await import(chrome.runtime.getURL('shared/storage.js'))
      const tasks = await storage.getTasks()
      return { count: tasks.length, fields: tasks.reduce((sum, task) => sum + (task.fields?.length || 0), 0), expected }
    }, { groups: scenario.groups, values: scenario.totalValues })
    const correctSavedData = persisted.count - baselineTasks.count === scenario.groups && persisted.fields - baselineTasks.fields === scenario.totalValues
    if (!correctSavedData) throw new Error(`persisted UI save mismatch: ${JSON.stringify(persisted)}`)
    const api = await picker.evaluate(start => window.__af23Meter.api.slice(start).map(call => ({ area: call.area, method: call.method, requestBytes: call.requestBytes, responseBytes: call.responseBytes, elapsedMs: call.completedAt == null ? null : +(call.completedAt - call.startedAt).toFixed(2) })), apiStart)
    const clickCount = (scenario.groups > 1 ? 1 : 0) + 1 + 1 // measured group switch when applicable, finish, save; setup clicks excluded
    samples.push({ iteration: index + 1, groupSwitch: switchResult, completion: completionResult, save: saveResult, api, apiCount: apiEnd - apiStart, listenerCounts: { before: beforeListeners, after: afterListeners }, clickCount, correctSavedData })
    await target.close().catch(() => {})
    await report.close().catch(() => {})
    await wait(300)
  }
  return { scenario, wallElapsedMs: +(performance.now() - scenarioStartedAt).toFixed(2), wallElapsedIncludesSetup: true, measuredClickCount: samples.reduce((sum, sample) => sum + sample.clickCount, 0), panelInstancesForSetup: samples.length, warmRequested: sampleCount, warmCompleted: samples.length, groupSwitchMs: groupSwitch.length ? summary(groupSwitch) : null, completionMs: summary(completion), saveMs: summary(save), correctness: samples.every(sample => sample.correctSavedData), samples }
}

let report
try {
  if (!CHROME || !existsSync(CHROME)) throw new Error('Set BROWSER_PATH to a Chrome for Testing executable.')
  if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 1 || SAMPLE_COUNT > WARM) throw new Error(`AF23_PICK_UI_SAMPLES must be an integer from 1 to ${WARM}.`)
  const scenarios = CASE_FILTER ? MATRIX.filter(scenario => scenario.id === CASE_FILTER) : MATRIX
  if (scenarios.length === 0) throw new Error(`unknown AF23_PICK_UI_CASE: ${CASE_FILTER}`)
  const gateEligible = !DIAGNOSTIC && !CASE_FILTER && SAMPLE_COUNT === WARM && scenarios.length === MATRIX.length
  sourceFingerprint = extensionSourceHash()
  await startFixture()
  const extId = await launch()
  const cases = []
  for (const scenario of scenarios) {
    console.log(`[AF23 picker UI] ${scenario.id}: warm ${SAMPLE_COUNT}${gateEligible ? '' : ' (DIAGNOSTIC, not gate)'}`)
    const result = await measureScenario(extId, scenario, SAMPLE_COUNT)
    cases.push(result)
    if (result.warmCompleted !== SAMPLE_COUNT || !result.correctness) throw new Error(`${scenario.id} user-event UI ${gateEligible ? 'gate' : 'diagnostic'} failed`)
  }
  const endingFingerprint = extensionSourceHash()
  if (endingFingerprint.value !== sourceFingerprint.value) throw new Error('extension source changed during UI measurement; result is not comparable')
  report = { id: 'AF-23-E1-picker-ui', status: gateEligible ? 'PASS' : 'DIAGNOSTIC', gateEligible, timestamp: new Date().toISOString(), browser: CHROME, browserVersion: await browser.version(), extensionSource: SRC, extensionSourceHash: sourceFingerprint, runtime: { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}` }, fixture: { rows: 1000, columns: 10, seed: 0 }, samplePlan: { warm: SAMPLE_COUNT, diagnostic: !gateEligible, actualUserSelectionsPerSample: 1, measuredClicksPerSample: { oneGroup: 2, multipleGroups: 3 }, freshPanelSetupPerSample: true }, boundary: 'Visible side panel controls are driven by CDP mouse events. Each measured interval starts at the captured click event and ends on a later animation frame where the correct active/settings/saved state is visible. Every sample gets a fresh panel and one actual user-picked fixture cell; additional synthetic fields reuse that exact verified source/spec to scale draft size, so the setup does not assert distinct source coverage. Setup and case wall time are reported separately from measured click-to-result intervals. The harness captures actual storage/runtime API traffic. Any case/sample-filtered run is DIAGNOSTIC and cannot be reported as a gate pass.', cases }
} catch (error) {
  report = { id: 'AF-23-E1-picker-ui', status: 'FAIL', timestamp: new Date().toISOString(), browser: CHROME || null, error: error?.stack || String(error) }
  process.exitCode = 1
} finally {
  try { await closeBrowser() } catch (error) { report = { ...(report || {}), status: 'FAIL', cleanupError: String(error) }; process.exitCode = 1 }
  if (server?.listening) { server.closeAllConnections?.(); await new Promise(done => server.close(done)) }
}
mkdirSync(resolve('work'), { recursive: true })
report.outputFile = resolve('work/perf-pick-ui.json')
writeFileSync(report.outputFile, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
