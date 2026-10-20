// AF-23 B1/B2 source identity matrix in real Chrome for Testing.
// Loads the QA-integrated extension and uses the actual Picker repair button,
// page clicks, and visible Done/Cancel controls. Fixture mutation is the only
// direct DOM operation; it simulates a site changing after selection.
// Run with:
// BROWSER_PATH=".../Google Chrome for Testing" node tests/smoke/af23_sources.mjs
// Set AF23_QA_SRC to override the default local src/; AF23_CASES accepts comma-separated case IDs.
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const QA_SRC = resolve(process.env.AF23_QA_SRC || join(ROOT, 'src'))
const OUTPUT = resolve(process.env.AF23_SOURCES_OUTPUT || join(ROOT, '../sources-browser.json'))
const CHROME = process.env.BROWSER_PATH || ''
const CASE_TIMEOUT_MS = 18_000
const RUN_TIMEOUT_MS = 240_000

const pad = n => String(n).padStart(2, '0')
const htmlFixture = frameUrl => `<!doctype html><meta charset="utf-8"><title>AF-23 source matrix</title>
<style>body{font:18px sans-serif;margin:24px}table{border-collapse:collapse;margin:20px}th,td{border:1px solid #777;padding:16px}iframe{display:block;width:760px;height:540px;margin:30px;border:1px solid #444}.css-grid{display:grid;grid-template-columns:repeat(2,100px);margin:20px}.css-grid>div{display:contents}.css-grid span{border:1px solid #777;padding:16px}</style>
<h1>Source identity fixtures</h1>
<table id="dup-row"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
<tr id="dup-selected-row"><th>1</th><td id="dup-selected">123</td></tr><tr><th>2</th><td>200</td></tr></tbody></table>
<table id="delete-row"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
<tr id="delete-selected-row"><th>A</th><td id="delete-selected">123</td></tr><tr><th>B</th><td>200</td></tr></tbody></table>
<table id="insert-col"><tbody>
<tr><th>A</th><td id="col-selected">123</td></tr><tr><th>B</th><td>200</td></tr></tbody></table>
<table id="replace-table"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
<tr><th>A</th><td id="replace-selected">123</td></tr><tr><th>B</th><td>200</td></tr></tbody></table>
<table id="refresh-table"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
<tr><th>A</th><td id="refresh-selected">123</td></tr></tbody></table>
<table id="first-table"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
<tr><th>A</th><td id="first-selected">100</td></tr><tr><th>B</th><td id="first-next">200</td></tr></tbody></table>
<table id="last-table"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
<tr><th>A</th><td>100</td></tr><tr><th>B</th><td id="last-prev">200</td></tr><tr><th>C</th><td id="last-selected">300</td></tr></tbody></table>
<table id="header-table"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody id="header-body">
<tr><th>A</th><td>100</td></tr><tr><th>B</th><td>200</td></tr></tbody></table>
<table id="unique-row-table"><thead><tr><th>區域</th><th>價格</th></tr></thead><tbody>
<tr id="unique-row"><th>北區</th><td id="unique-row-selected">100</td></tr><tr id="unique-row-other"><th>南區</th><td>200</td></tr></tbody></table>
<div id="aria-grid" role="grid" aria-label="ARIA fixture">
 <div role="row"><span role="columnheader">項目</span><span role="columnheader">價格</span></div>
 <div role="row"><span role="rowheader">1</span><span role="gridcell" id="aria-selected">123</span></div>
 <div role="row"><span role="rowheader">2</span><span role="gridcell">200</span></div>
</div>
<div id="css-grid" class="css-grid" role="table" aria-label="CSS fixture">
 <div role="row"><span role="rowheader">A</span><span role="cell" id="css-selected">123</span></div>
 <div role="row"><span role="rowheader">B</span><span role="cell">200</span></div>
</div>
<iframe title="source identity child frame" src="${frameUrl}"></iframe>`

const frameFixture = `<!doctype html><meta charset="utf-8"><title>AF-23 child frame</title>
<style>body{font:18px sans-serif;margin:20px}table{border-collapse:collapse}td,th{border:1px solid #777;padding:18px}</style>
<table id="frame-table"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
<tr><th>1</th><td id="frame-selected">123</td></tr><tr><th>2</th><td>200</td></tr></tbody></table>`

const cases = [
  { id: 'html-duplicate-row-insert', kind: 'reject', selector: '#dup-selected', locator: '#dup-row', spec: { cell: { row: { index: 0, header: '1' }, col: { index: 1, header: '價格' } } }, mutate: () => {
    const body = document.querySelector('#dup-row tbody')
    const row = document.createElement('tr'); row.innerHTML = '<th>1</th><td>111</td>'; body.prepend(row)
  } },
  { id: 'html-selected-row-delete', kind: 'reject', selector: '#delete-selected', locator: '#delete-row', spec: { cell: { row: { index: 0, header: 'A' }, col: { index: 1, header: '價格' } } }, mutate: () => document.querySelector('#delete-selected-row').remove() },
  { id: 'html-fixed-column-insert', kind: 'reject', selector: '#col-selected', locator: '#insert-col', spec: { cell: { row: { index: 0, header: 'A' }, col: { index: 1 } } }, mutate: () => {
    for (const row of document.querySelectorAll('#insert-col tbody tr')) { const td = document.createElement('td'); td.textContent = '111'; row.insertBefore(td, row.children[1]) }
  } },
  { id: 'html-table-node-replaced', kind: 'reject', selector: '#replace-selected', locator: '#replace-table', spec: { cell: { row: { index: 0, header: 'A' }, col: { index: 1, header: '價格' } } }, mutate: () => {
    const oldTable = document.querySelector('#replace-table'); const next = oldTable.cloneNode(true); oldTable.replaceWith(next)
  } },
  { id: 'aria-duplicate-row-insert', kind: 'reject', selector: '#aria-selected', locator: '#aria-grid', spec: { cell: { row: { index: 1, header: '1' }, col: { index: 1, header: '價格' } } }, mutate: () => {
    const row = document.createElement('div'); row.setAttribute('role', 'row'); row.innerHTML = '<span role="rowheader">1</span><span role="gridcell">111</span>'
    document.querySelector('#aria-grid').insertBefore(row, document.querySelector('#aria-grid').children[1])
  } },
  { id: 'css-grid-fixed-column-insert', kind: 'reject', selector: '#css-selected', locator: '#css-grid', spec: { cell: { row: { index: 0, header: 'A' }, col: { index: 1 } } }, mutate: () => {
    for (const row of document.querySelectorAll('#css-grid [role="row"]')) {
      const cell = document.createElement('span'); cell.setAttribute('role', 'cell'); cell.textContent = '111'; row.insertBefore(cell, row.children[1])
    }
  } },
  { id: 'same-node-value-refresh', kind: 'accept', selector: '#refresh-selected', locator: '#refresh-table', spec: { cell: { row: { index: 0, header: 'A' }, col: { index: 1, header: '價格' } } }, mutate: () => { document.querySelector('#refresh-selected').textContent = '124' } },
  { id: 'explicit-first-follows-insert', kind: 'accept', selector: '#first-selected', locator: '#first-table', spec: { cell: { row: { index: 0, header: 'A', pos: 'first' }, col: { index: 1, header: '價格' } } }, mutate: () => {
    const row = document.createElement('tr'); row.innerHTML = '<th>新列</th><td>111</td>'; document.querySelector('#first-table tbody').prepend(row)
  } },
  { id: 'explicit-last-follows-delete', kind: 'accept', selector: '#last-selected', locator: '#last-table', spec: { cell: { row: { index: 2, header: 'C', pos: 'last' }, col: { index: 1, header: '價格' } } }, mutate: () => document.querySelector('#last-selected').closest('tr').remove() },
  { id: 'unique-header-tbody-refresh', kind: 'accept', selector: null, locator: '#header-table', spec: { block: { axis: 'col', index: 1, headerText: '價格' } }, mutate: () => {
    const body = document.createElement('tbody'); body.id = 'header-body'; body.innerHTML = '<tr><th>A</th><td>101</td></tr><tr><th>B</th><td>201</td></tr>'; document.querySelector('#header-body').replaceWith(body)
  } },
  { id: 'unique-row-header-follows-reordered-row', kind: 'accept', selector: '#unique-row-selected', locator: '#unique-row-table', spec: { cell: { row: { index: 0, header: '北區' }, col: { index: 1, header: '價格' } } }, mutate: () => {
    const body = document.querySelector('#unique-row-table tbody'); body.append(body.querySelector('#unique-row'))
  } },
  { id: 'iframe-duplicate-row-insert', kind: 'reject', selector: '#frame-selected', locator: '#frame-table', frame: true, spec: { cell: { row: { index: 0, header: '1' }, col: { index: 1, header: '價格' } } }, mutate: () => {
    const row = document.createElement('tr'); row.innerHTML = '<th>1</th><td>111</td>'; document.querySelector('#frame-table tbody').prepend(row)
  } }
]
const caseFilterProvided = process.env.AF23_CASES !== undefined
const requestedCaseIds = (process.env.AF23_CASES || '').split(',').map(value => value.trim()).filter(Boolean)
if (caseFilterProvided) {
  assert.ok(requestedCaseIds.length, 'AF23_CASES was set but contained no case IDs')
  const unknownCaseIds = requestedCaseIds.filter(id => !cases.some(item => item.id === id))
  assert.deepEqual(unknownCaseIds, [], `Unknown AF23_CASES IDs: ${unknownCaseIds.join(', ')}`)
}
const runCases = caseFilterProvided ? cases.filter(item => requestedCaseIds.includes(item.id)) : cases

const mainServer = http.createServer()
const frameServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(frameFixture)
})
const listen = srv => new Promise((resolveListen, reject) => {
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => resolveListen(srv.address().port))
})

async function clickVisible(page, frame, selector) {
  await frame.waitForSelector(selector, { timeout: 8000 })
  for (let attempt = 0; attempt < 4; attempt++) {
    const element = await frame.$(selector)
    assert.ok(element, `visible target missing: ${selector}`)
    const frameElement = frame === page.mainFrame() ? null : await frame.frameElement()
    if (frameElement) await frameElement.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }))
    await page.bringToFront()
    await element.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }))
    const box = await element.boundingBox()
    assert.ok(box, `target has no visible bounds: ${selector}`)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const frameBox = frameElement ? await frameElement.boundingBox() : null
    const frameBorder = frameElement ? await frameElement.evaluate(node => ({
      left: parseFloat(getComputedStyle(node).borderLeftWidth) || 0,
      top: parseFloat(getComputedStyle(node).borderTopWidth) || 0
    })) : { left: 0, top: 0 }
    const localX = frameBox ? x - frameBox.x - frameBorder.left : x
    const localY = frameBox ? y - frameBox.y - frameBorder.top : y
    const parentHitTarget = frameElement
      ? await frameElement.evaluate((node, point) => {
          const hit = document.elementFromPoint(point.x, point.y)
          return Boolean(hit && (hit === node || node.contains(hit)))
        }, { x, y })
      : true
    const hitTarget = await frame.evaluate(({ selector, x, y }) => {
      const intended = document.querySelector(selector)
      const hit = document.elementFromPoint(x, y)
      return Boolean(intended && hit && (hit === intended || intended.contains(hit)))
    }, { selector, x: localX, y: localY })
    const withinViewport = await page.evaluate(({ x, y }) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight, { x, y })
    if (!parentHitTarget || !hitTarget || !withinViewport) continue
    await page.mouse.move(x, y)
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => resolveFrame())))
    await page.mouse.click(x, y)
    return
  }
  throw new Error(`could not hit-test and click ${selector}`)
}

async function waitUntil(predicate, label, timeoutMs = CASE_TIMEOUT_MS) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await predicate()
    if (last) return last
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`)
}

const output = {
  schema: 'af23-sources-browser-v1',
  generatedAt: new Date().toISOString(),
  cases: [],
  failures: [],
  environment: { platform: process.platform, arch: process.arch, node: process.version, chromePath: CHROME, qaSrc: QA_SRC },
  qaCommit: null,
  extensionVersion: null,
  pass: false
}

let browser, profile, mainPort, framePort, runTimer
try {
  assert.ok(CHROME && existsSync(CHROME), `Set BROWSER_PATH to Chrome for Testing; got ${CHROME || '(empty)'}`)
  assert.ok(existsSync(join(QA_SRC, 'manifest.json')), `QA extension source missing: ${QA_SRC}`)
  output.extensionVersion = JSON.parse(readFileSync(join(QA_SRC, 'manifest.json'), 'utf8')).version
  try { output.qaCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(QA_SRC, '..'), encoding: 'utf8' }).trim() } catch {}
  mainPort = await listen(mainServer)
  framePort = await listen(frameServer)
  const fixtureUrl = `http://127.0.0.1:${mainPort}/`
  const frameUrl = `http://127.0.0.1:${framePort}/frame`
  mainServer.removeAllListeners('request')
  mainServer.on('request', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(htmlFixture(frameUrl))
  })
  profile = mkdtempSync(join(os.tmpdir(), 'af23-sources-'))
  browser = await puppeteer.launch({ executablePath: CHROME, headless: false, userDataDir: profile,
    args: [`--disable-extensions-except=${QA_SRC}`, `--load-extension=${QA_SRC}`, '--no-first-run', '--no-default-browser-check'] })
  const worker = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().endsWith('/background/main.js'), { timeout: 25000 })
  const extensionId = new URL(worker.url()).host
  const picker = await browser.newPage()
  assert.ok(runCases.length, `No cases selected by AF23_CASES=${requestedCaseIds.join(',')}`)
  const tasks = runCases.map((item, index) => {
    const key = `b1-${index + 1}`
    const source = { locator: { css: item.locator }, ...(item.frame ? { frame: { url: frameUrl } } : {}) }
    return { id: `af23-source-${item.id}`, name: item.id, url: fixtureUrl, mode: 'multi', enabled: false,
      locator: { css: item.locator }, fields: [{ key, name: item.id, mode: 'number', source }],
      spec: { mode: 'multi', fields: [{ key, name: item.id, mode: 'number', source, spec: item.spec }] },
      schedule: { type: 'daily', times: [`23:${pad(40 + (index % 10))}`], weekdays: [0, 1, 2, 3, 4, 5, 6] } }
  })
  await picker.goto(`chrome-extension://${extensionId}/ui/report/report.html#view=settings`, { waitUntil: 'domcontentloaded' })
  await picker.evaluate(async tasksToSave => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    await storage.init()
    for (const task of tasksToSave) await storage.saveTask(task)
  }, tasks)

  const overallDeadline = Date.now() + RUN_TIMEOUT_MS
  for (let index = 0; index < runCases.length; index++) {
    const item = runCases[index]
    const task = tasks[index]
    const result = { id: item.id, expected: item.kind, startedAt: new Date().toISOString() }
    output.cases.push(result)
    try {
      assert.ok(Date.now() < overallDeadline, 'source matrix exceeded its overall time budget')
      await picker.goto(`chrome-extension://${extensionId}/ui/picker/picker.html?taskId=${encodeURIComponent(task.id)}`, { waitUntil: 'domcontentloaded' })
      const key = task.fields[0].key
      await picker.waitForSelector(`[data-field-key="${key}"] [data-field-repair]`, { visible: true, timeout: 10000 })
      const beforeJournal = await picker.evaluate(async () => (await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || [])
      const existingTargets = new Set(browser.targets())
      await picker.click(`[data-field-key="${key}"] [data-field-repair]`)
      const targetInfo = await browser.waitForTarget(t => !existingTargets.has(t) && t.type() === 'page' && t.url() === fixtureUrl, { timeout: 15000 })
      const targetPage = await targetInfo.page()
      assert.ok(targetPage, 'repair opened its source tab')
      const sourceFrameUrl = item.frame ? frameUrl : fixtureUrl
      const frame = await waitUntil(() => targetPage.frames().find(f => f.url() === sourceFrameUrl), `frame ${sourceFrameUrl}`)
      try {
        await frame.waitForSelector('[data-af-overlay] [data-af-done]', { timeout: 12000 })
      } catch (error) {
        result.frameDiagnostics = await Promise.all(targetPage.frames().map(async candidate => ({
          url: candidate.url(),
          overlayCount: await candidate.$$eval('[data-af-overlay]', nodes => nodes.length).catch(() => null),
          doneInfo: await candidate.$eval('[data-af-overlay] [data-af-done]', node => ({
            text: node.textContent, rect: node.getBoundingClientRect().toJSON(),
            display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility,
            opacity: getComputedStyle(node).opacity, panelText: node.closest('[data-af-panel]')?.textContent || ''
          })).catch(() => null)
        })))
        throw error
      }
      if (item.selector) await clickVisible(targetPage, frame, item.selector)
      result.selectionPanel = await frame.$eval('[data-af-panel]', el => el.textContent || '')
      await frame.evaluate(item.mutate)
      result.mutationState = await frame.evaluate(({ selector, locator }) => ({
        selectedText: selector ? document.querySelector(selector)?.textContent || null : null,
        targetHtml: document.querySelector(locator)?.outerHTML || null
      }), { selector: item.selector, locator: item.locator })
      result.beforeMutation = { targetPresent: Boolean(item.selector), frameUrl: frame.url() }
      result.mutationApplied = true
      await clickVisible(targetPage, frame, '[data-af-done]')
      if (item.kind === 'reject') {
        let rejection
        try {
          rejection = await waitUntil(async () => {
            if (targetPage.isClosed()) return { closed: true }
            try {
              const text = await frame.$eval('[data-af-panel]', el => el.textContent || '')
              return /來源在送出前已改變|重新選取目前要抓的值|頁面剛剛更新過，請重新點選/.test(text) ? { closed: false, text } : null
            } catch { return null }
          }, 'source drift rejection text or unexpected submission')
        } catch (error) {
          const diagnostic = { closed: targetPage.isClosed(), panelText: null, journalCount: null }
          if (!targetPage.isClosed()) {
            try { diagnostic.panelText = await frame.$eval('[data-af-panel]', el => el.textContent || '') } catch (panelError) { diagnostic.panelError = String(panelError) }
            try { diagnostic.journalCount = await picker.evaluate(async () => ((await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || []).length) } catch (journalError) { diagnostic.journalError = String(journalError) }
          }
          result.rejectionDiagnostic = diagnostic
          throw error
        }
        if (rejection.closed) {
          const afterJournal = await picker.evaluate(async () => (await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || [])
          result.unexpectedSubmission = { journalDelta: afterJournal.length - beforeJournal.length, operation: afterJournal.at(-1) || null }
        }
        assert.equal(rejection.closed, false, `stale source unexpectedly submitted and closed the source tab: ${item.id}`)
        result.rejectionText = rejection.text.trim()
        await clickVisible(targetPage, frame, '[data-af-done]')
        await new Promise(resolveWait => setTimeout(resolveWait, 450))
        assert.equal(targetPage.isClosed(), false, 'repeated Done must not submit a stale source')
        const afterJournal = await picker.evaluate(async () => (await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || [])
        assert.equal(afterJournal.length, beforeJournal.length, 'stale source must not create a repair operation journal entry')
        result.journalDelta = afterJournal.length - beforeJournal.length
        await clickVisible(targetPage, frame, '[data-af-cancel]')
        await waitUntil(async () => targetPage.isClosed(), 'rejected repair tab cleanup', 6000)
      } else {
        await waitUntil(async () => targetPage.isClosed(), 'persisted repair ACK closes source tab')
        const afterJournal = await picker.evaluate(async () => (await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || [])
        assert.equal(afterJournal.length, beforeJournal.length + 1, 'accepted update must persist one repair operation')
        result.journalDelta = afterJournal.length - beforeJournal.length
        const liveTask = await picker.evaluate(async taskId => {
          const storage = await import(chrome.runtime.getURL('shared/storage.js'))
          return storage.getTask(taskId)
        }, task.id)
        assert.equal(liveTask?.fields?.[0]?.key, key, 'repair keeps the stable field key')
        result.fieldKey = liveTask.fields[0].key
      }
      result.pass = true
      result.finishedAt = new Date().toISOString()
      console.log(`[PASS] ${item.id}: ${item.kind}`)
    } catch (error) {
      result.pass = false
      result.error = String(error?.stack || error)
      result.finishedAt = new Date().toISOString()
      output.failures.push({ id: item.id, error: result.error })
      console.error(`[FAIL] ${item.id}: ${error?.message || error}`)
      break
    }
  }
  output.pass = output.failures.length === 0 && output.cases.length === runCases.length && output.cases.every(item => item.pass)
} catch (error) {
  output.failures.push({ id: 'setup', error: String(error?.stack || error) })
} finally {
  clearTimeout(runTimer)
  if (browser) { try { await browser.close() } catch {} }
  for (const srv of [mainServer, frameServer]) if (srv.listening) await new Promise(resolveClose => srv.close(resolveClose))
  if (profile) rmSync(profile, { recursive: true, force: true })
  output.generatedAt = new Date().toISOString()
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Raw source matrix JSON: ${OUTPUT}`)
}

if (!output.pass) process.exitCode = 1
