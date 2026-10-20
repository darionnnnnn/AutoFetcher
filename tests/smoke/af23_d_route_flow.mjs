// AC-D2/D3 + F1 flow four: real report controls, history navigation and
// import/delete/export consistency over two rounds of the same 1k-record set.
// Run from a project root with:
//   AF23_QA_SRC=/path/to/qa/src BROWSER_PATH=/path/to/chrome node tests/smoke/af23_d_route_flow.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import puppeteer from 'puppeteer-core'

const EXTENSION_PATH = resolve(process.env.AF23_QA_SRC || process.env.AF23_EXTENSION_PATH || 'src')
const CHROME = process.env.BROWSER_PATH
const HEADLESS = process.env.AF23_HEADLESS === '1'
const OUT = resolve(process.env.AF23_D3_EVIDENCE || 'work/af23_d_route_flow.json')
const TASK_ID = 'af23-d-route-flow'
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const shiftDate = (dateText, days) => {
  const date = new Date(`${dateText}T12:00:00`)
  date.setDate(date.getDate() + days)
  return localDate(date)
}
const today = localDate(new Date())
const from = shiftDate(today, -7)
const roundEvidence = []
let browser
let profile
let extensionId
let page

async function timedClick(label, selector, ready) {
  const started = performance.now()
  await page.click(selector)
  if (ready) await ready()
  return { action: label, kind: 'click', selector, elapsedMs: +(performance.now() - started).toFixed(2) }
}

async function waitFor(label, ready) {
  const started = performance.now()
  await ready()
  return { action: label, kind: 'wait-for-result', elapsedMs: +(performance.now() - started).toFixed(2) }
}

async function currentView() {
  return page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('view'))
}

async function clickTab(name) {
  return timedClick(`open ${name}`, `#tab-${name}`, () => page.waitForFunction(view => {
    const panel = document.getElementById(`panel-${view}`)
    return new URLSearchParams(location.hash.slice(1)).get('view') === view && panel && !panel.hidden
  }, {}, name))
}

async function summaryTotal() {
  return page.evaluate(() => [...document.querySelectorAll('#summary tbody tr')]
    .reduce((total, row) => total + (Number(String(row.children[1]?.textContent || '').replaceAll(',', '').trim()) || 0), 0))
}

async function waitForSummary(expected) {
  try {
    await page.waitForFunction(count => {
      const rows = [...document.querySelectorAll('#summary tbody tr')]
      const total = rows.reduce((sum, row) => sum + (Number(String(row.children[1]?.textContent || '').replaceAll(',', '').trim()) || 0), 0)
      return total === count
    }, { timeout: 20000 }, expected)
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const storage = await import(chrome.runtime.getURL('shared/storage.js'))
      const dates = await storage.listDates()
      const records = (await Promise.all(dates.map(date => storage.getRecordsByDate(date)))).flat()
      const today = document.getElementById('range-to')?.value || ''
      const todayKeys = today ? await chrome.storage.local.get([`rec:${today}`, ...Array.from({ length: 24 }, (_, hour) => `rec2:${today}:${String(hour).padStart(2, '0')}`)]) : {}
      return {
        hash: location.hash,
        importedStatus: document.getElementById('records-import-result')?.textContent,
        summary: document.querySelector('#summary')?.innerText,
        rows: document.querySelectorAll('#record-table tbody > tr:not(.detail)').length,
        error: document.querySelector('#history-load-error')?.textContent,
        recordsInRange: records.filter(record => record.slot >= `${new URLSearchParams(location.hash.slice(1)).get('from')}T00:00` && record.slot <= `${new URLSearchParams(location.hash.slice(1)).get('to')}T23:59`).length,
        dates,
        today,
        todayStorageKeys: Object.fromEntries(Object.entries(todayKeys).filter(([, value]) => Array.isArray(value) && value.length).map(([key, value]) => [key, value.map(record => ({ taskId: record.taskId, slot: record.slot, raw: record.raw, capturedAt: record.capturedAt }))])),
        todayRecords: records.filter(record => record.slot?.startsWith(`${new Date().toLocaleDateString('sv-SE')}T`)).map(record => ({ taskId: record.taskId, slot: record.slot, raw: record.raw, capturedAt: record.capturedAt }))
      }
    })
    console.error('[waitForSummary diagnostic]', diagnostic)
    throw error
  }
}

async function seedDataset() {
  await page.evaluate(async ({ taskId, today }) => {
    const buckets = new Map()
    const task = {
      id: taskId, name: 'AF23 報表流程任務', url: 'https://fixture.invalid/',
      mode: 'number', enabled: true, order: 0, locator: { css: '#value' },
      spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
    }
    const previousDates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(`${today}T12:00:00`)
      date.setDate(date.getDate() - (index + 1))
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    })
    for (let i = 0; i < 1000; i++) {
      const date = previousDates[i % previousDates.length]
      const hour = String(i % 24).padStart(2, '0')
      const minute = String(Math.floor(i / 24) % 60).padStart(2, '0')
      const key = `rec2:${date}:${hour}`
      if (!buckets.has(key)) buckets.set(key, [])
      const stamp = `${date}T${hour}:${minute}:00+08:00`
      buckets.get(key).push({
        taskId, capturedAt: stamp, slot: `${date}T${hour}:${minute}:00`,
        value: i + 1, raw: `base-record-${i + 1}`, status: 'ok'
      })
    }
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      schemaVersion: 4,
      tasks: [task],
      layout: { version: 1, lastDashboardId: '00000000-0000-4000-8000-000000000001', dashboards: [] },
      settings: { theme: 'system', history: { tableMode: 'list' } }
    })
    const entries = [...buckets.entries()]
    for (let index = 0; index < entries.length; index += 25) {
      await chrome.storage.local.set(Object.fromEntries(entries.slice(index, index + 25)))
    }
    return { count: 1000, dates: previousDates, importedDate: today }
  }, { taskId: TASK_ID, today })
}

async function installDownloadCapture() {
  await page.evaluate(() => {
    window.__af23Downloads = []
    let nextId = 7000
    chrome.downloads.download = async options => {
      const content = await (await fetch(options.url)).text()
      window.__af23Downloads.push({ filename: options.filename, saveAs: options.saveAs, content })
      return nextId++
    }
  })
}

async function exportRecords(round, stage) {
  const action = await timedClick(`round ${round} ${stage} export`, '#export-run', async () => {
    await page.waitForFunction(() => document.getElementById('export-run-result')?.textContent.includes('已開始下載'), { timeout: 20000 })
  })
  const exported = await page.evaluate(() => window.__af23Downloads.at(-1))
  assert.ok(exported, '匯出控制項必須呼叫正式 buildExport/download 路徑')
  assert.equal(exported.saveAs, true)
  const parsed = JSON.parse(exported.content)
  const days = Array.isArray(parsed.days) ? parsed.days : [parsed]
  const records = days.flatMap(day => Object.values(day.tasks || {}).flatMap(task => task.records || []))
  return { action, filename: exported.filename, count: records.length, records }
}

async function importOneRecord(round, marker, importPath) {
  const record = {
    taskId: TASK_ID, slot: `${today}T12:00:00`, capturedAt: `${today}T12:00:00.000+08:00`,
    value: 900000 + round, raw: marker, status: 'ok'
  }
  writeFileSync(importPath, JSON.stringify({ date: today, tasks: { [TASK_ID]: { name: 'AF23 報表流程任務', records: [record] } } }))
  const started = performance.now()
  const fileInput = await page.$('#records-import-file')
  assert.ok(fileInput, '歷史紀錄匯入控制項存在')
  await fileInput.uploadFile(importPath)
  await page.waitForFunction(({ roundNo, marker, date }) => {
    const status = document.getElementById('records-import-result')?.textContent || ''
    if (!status.includes('已新增 1 筆')) return false
    const key = `rec2:${date}:12`
    return chrome.storage.local.get(key).then(result =>
      (result[key] || []).some(record => record.raw === marker && record.value === 900000 + roundNo))
  }, { timeout: 15000 }, { roundNo: round, marker, date: today })
  return { action: `round ${round} import history`, kind: 'file-control', selector: '#records-import-file', elapsedMs: +(performance.now() - started).toFixed(2), marker }
}

async function updateKeyword(marker, expectedRowCount) {
  const started = performance.now()
  await page.$eval('#filter-keyword', (input, value) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, marker)
  await page.waitForFunction(({ marker, expected }) => {
    const query = new URLSearchParams(location.hash.slice(1))
    const rows = document.querySelectorAll('#record-table tbody > tr:not(.detail)')
    const summary = document.querySelectorAll('#summary tbody tr')
    return query.get('keyword') === marker && rows.length === expected && summary.length === expected
  }, { timeout: 20000 }, { marker, expected: expectedRowCount })
  return { action: `filter history for ${marker}`, kind: 'form-change', selector: '#filter-keyword', elapsedMs: +(performance.now() - started).toFixed(2) }
}

async function waitForHistoryRoute(keyword, total) {
  await page.waitForFunction(({ keyword, total }) => {
    const query = new URLSearchParams(location.hash.slice(1))
    if (query.get('view') !== 'history' || (query.get('keyword') || '') !== keyword) return false
    const rows = [...document.querySelectorAll('#summary tbody tr')]
    const count = rows.reduce((sum, row) => sum + (Number(String(row.children[1]?.textContent || '').replaceAll(',', '').trim()) || 0), 0)
    return !document.getElementById('panel-history')?.hidden && count === total
  }, { timeout: 20000 }, { keyword, total })
}

async function verifyCalendarHasRecord(expected) {
  await page.waitForFunction(({ date, expected }) => {
    const cell = document.querySelector(`#calendar td[data-date="${date}"]`)
    return Boolean(cell) && cell.classList.contains('has-records') === expected
  }, { timeout: 20000 }, { date: today, expected })
}

async function runRound(round, importPath) {
  const marker = `AF23_ROUTE_IMPORT_ROUND_${round}`
  const actions = []
  const historyStart = performance.now()
  await page.goto(`chrome-extension://${extensionId}/ui/report/report.html#view=dashboard&from=${from}&to=${today}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(document.querySelector('#tab-settings')))

  actions.push(await clickTab('settings'))
  actions.push(await importOneRecord(round, marker, importPath))
  // Give the storage subscription its normal debounce window while history is hidden.
  await waitFor( `round ${round} hidden history cache invalidation`, () => wait(180))

  actions.push(await clickTab('history'))
  await waitForSummary(1001)
  await verifyCalendarHasRecord(true)
  actions.push(await updateKeyword(marker, 1))
  await waitForHistoryRoute(marker, 1)
  const filteredBefore = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#record-table tbody > tr:not(.detail)')].map(row => row.textContent),
    summary: document.querySelector('#summary tbody')?.textContent || ''
  }))
  assert.equal(filteredBefore.rows.length, 1)
  assert.match(filteredBefore.summary, /1/)
  await page.click('#record-table tbody > tr:not(.detail) .row-expand')
  await page.waitForSelector('#record-table tbody tr.detail .detail-box', { visible: true })
  const importedRawDetail = await page.$eval('#record-table tbody tr.detail .detail-box', el => el.textContent)
  assert.ok(importedRawDetail.includes(marker), '篩選結果明細顯示匯入原文')

  const backStart = performance.now()
  await page.goBack()
  await waitForHistoryRoute('', 1001)
  actions.push({ action: `round ${round} browser back to unfiltered history`, kind: 'history-back', elapsedMs: +(performance.now() - backStart).toFixed(2) })
  const forwardStart = performance.now()
  await page.goForward()
  await waitForHistoryRoute(marker, 1)
  actions.push({ action: `round ${round} browser forward restores filter`, kind: 'history-forward', elapsedMs: +(performance.now() - forwardStart).toFixed(2) })

  actions.push(await clickTab('settings'))
  const exportDates = await page.evaluate(({ from, today }) => {
    document.getElementById('export-from').value = from
    document.getElementById('export-to').value = today
    return { from: document.getElementById('export-from').value, to: document.getElementById('export-to').value }
  }, { from, today })
  assert.deepEqual(exportDates, { from, to: today })
  const importedExport = await exportRecords(round, 'after import')
  assert.equal(importedExport.count, 1001, '匯入後匯出涵蓋完整日期範圍的最新資料')
  assert.ok(importedExport.records.some(record => record.raw === marker))
  actions.push(importedExport.action)

  actions.push(await clickTab('history'))
  await waitForHistoryRoute(marker, 1)
  await page.click('#record-table tbody > tr:not(.detail) .row-expand')
  await page.waitForSelector('#record-table tbody tr.detail [data-action="delete-record"]', { visible: true })
  const deleteStarted = performance.now()
  await page.click('#record-table tbody tr.detail [data-action="delete-record"]')
  await page.waitForSelector('dialog[open] button[data-action="confirm"]', { visible: true })
  await page.click('dialog[open] button[data-action="confirm"]')
  await waitForHistoryRoute(marker, 0)
  await verifyCalendarHasRecord(false)
  actions.push({ action: `round ${round} delete imported record through detail dialog`, kind: 'click-confirm', selector: '[data-action="delete-record"] → dialog confirm', elapsedMs: +(performance.now() - deleteStarted).toFixed(2) })
  assert.equal(await page.$$eval('#record-table tbody > tr:not(.detail)', rows => rows.length), 0)
  assert.equal(await page.$$eval('#summary tbody tr', rows => rows.length), 0)

  actions.push(await clickTab('settings'))
  const deletedExport = await exportRecords(round, 'after delete')
  assert.equal(deletedExport.count, 1000, '刪除後匯出回到原始資料量')
  assert.ok(!deletedExport.records.some(record => record.raw === marker), '刪除後匯出不可含已刪紀錄')
  actions.push(deletedExport.action)

  const view = await currentView()
  assert.equal(view, 'settings')
  const clicks = actions.filter(action => action.kind === 'click' || action.kind === 'click-confirm').length
  return {
    round, marker, recordsBeforeImport: 1000, recordsAfterImport: importedExport.count,
    recordsAfterDelete: deletedExport.count, elapsedMs: +(performance.now() - historyStart).toFixed(2),
    requiredClicks: clicks, reportSettingsHistoryTrips: 4,
    filteredBefore, importedRawDetail, exportAfterImport: { count: importedExport.count, includesImported: true },
    exportAfterDelete: { count: deletedExport.count, includesImported: false }, actions
  }
}

try {
  if (!CHROME) throw new Error('請設定 BROWSER_PATH 指向 Chrome for Testing')
  if (!EXTENSION_PATH || !EXTENSION_PATH.endsWith('/src')) throw new Error(`AF23_QA_SRC 應指向 extension src 目錄：${EXTENSION_PATH}`)
  profile = mkdtempSync(join(tmpdir(), 'af23-d-route-flow-'))
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: HEADLESS, userDataDir: profile,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run', '--no-default-browser-check']
  })
  const worker = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().endsWith('/background/main.js'), { timeout: 25000 })
  extensionId = new URL(worker.url()).host
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.goto(`chrome-extension://${extensionId}/ui/report/report.html#view=settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.chrome?.storage?.local))
  const seeded = await seedDataset()
  await installDownloadCapture()

  for (let round = 1; round <= 2; round++) {
    const importPath = join(profile, `history-import-round-${round}.json`)
    roundEvidence.push(await runRound(round, importPath))
  }

  const evidence = {
    status: 'passed', test: 'AC-D2/D3 + F1 flow four',
    browser: CHROME, browserVersion: await browser.version(), extensionPath: EXTENSION_PATH,
    fixture: { ...seeded, taskId: TASK_ID, range: { from, to: today }, datasetRecords: 1000 },
    rounds: roundEvidence
  }
  mkdirSync(resolve(OUT, '..'), { recursive: true })
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ status: evidence.status, rounds: roundEvidence.length, output: OUT, requiredClicks: roundEvidence.map(round => round.requiredClicks), elapsedMs: roundEvidence.map(round => round.elapsedMs) }, null, 2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
}
