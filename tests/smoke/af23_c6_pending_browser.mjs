// Narrow C6 browser proof: fail replacement cleanup once, then use the real
// content-page "confirm same operation" control and verify exactly-once state.
// BROWSER_PATH and AF23_EXTENSION_PATH are explicit so this can target the
// integrated QA source without copying other worktree files.
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = resolve(process.env.AF23_EXTENSION_PATH || join(ROOT, 'src'))
const BROWSER = process.env.BROWSER_PATH
if (!BROWSER) throw new Error('Set BROWSER_PATH to Chrome for Testing')
const TASK_ID = 'af23-c6-pending-retry'
const FIELD_KEY = 'price'
const fixture = `<!doctype html><meta charset="utf-8"><title>AF23 pending retry fixture</title>
<style>body{font:20px sans-serif}strong{display:block;margin:36px;padding:16px;border:1px solid #888}</style>
<table id="prices"><tbody><tr><td id="old-value">123</td></tr></tbody></table>
<strong id="replacement">777</strong>`
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(fixture)
})
const listen = () => new Promise((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
})
let browser
let profile
try {
  profile = mkdtempSync(join(os.tmpdir(), 'af23-c6-pending-'))
  const port = await listen()
  const url = `http://127.0.0.1:${port}/`
  console.log('[C6 pending] fixture ready')
  browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: process.env.AF23_HEADLESS === '1' ? 'new' : false,
    userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  })
  const workerTarget = await browser.waitForTarget(target =>
    target.type() === 'service_worker' && target.url().endsWith('/background/main.js'), { timeout: 20_000 })
  const extensionId = new URL(workerTarget.url()).host
  const worker = await workerTarget.worker()
  console.log('[C6 pending] extension worker ready')

  const setup = await browser.newPage()
  await setup.goto(`chrome-extension://${extensionId}/ui/report/report.html#view=settings`)
  await setup.evaluate(async ({ url, taskId, fieldKey }) => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    const layoutStore = await import(chrome.runtime.getURL('shared/layout-store.js'))
    await storage.saveTask({
      id: taskId, name: 'Pending replacement fixture', url, mode: 'multi', enabled: true,
      fields: [{ key: fieldKey, name: '價格', mode: 'number' }],
      spec: { mode: 'multi', fields: [{ key: fieldKey, name: '價格', mode: 'number',
        source: { locator: { css: '#prices' } }, spec: { cell: { row: { index: 0 }, col: { index: 0 } } } }] },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
    })
    const layout = await layoutStore.getLayout()
    const dashboardId = layout.dashboards[0].id
    await layoutStore.addCard(dashboardId, {
      type: 'number', x: 0, y: 0, w: 3, h: 2,
      source: [{ taskId: `${taskId}#${fieldKey}`, aggregation: 'raw' }], options: {}
    })
  }, { url, taskId: TASK_ID, fieldKey: FIELD_KEY })
  console.log('[C6 pending] task and old-series card seeded')
  const picker = await browser.newPage()
  await picker.goto(`chrome-extension://${extensionId}/ui/picker/picker.html?taskId=${TASK_ID}`)
  await picker.waitForSelector(`[data-field-key="${FIELD_KEY}"] [data-field-replace]`, { visible: true, timeout: 10_000 })
  console.log('[C6 pending] edit picker ready')

  const previousTargets = new Set(browser.targets())
  console.log('[C6 pending] clicking replace action')
  picker.once('dialog', dialog => dialog.accept())
  const sourceTargetPromise = browser.waitForTarget(target => !previousTargets.has(target) && target.url() === url, { timeout: 10_000 })
  // Opening its own source tab backgrounds the extension tab before Chromium
  // acknowledges the click command. The real tab creation is our completion signal.
  void picker.click(`[data-field-key="${FIELD_KEY}"] [data-field-replace]`).catch(() => {})
  console.log('[C6 pending] replace click dispatched')
  const sourceTarget = await sourceTargetPromise
  console.log('[C6 pending] source tab target found')
  const source = await sourceTarget.page()
  await source.waitForSelector('[data-af-done]', { visible: true, timeout: 10_000 })
  console.log('[C6 pending] replacement picker opened')

  // Fail only the layout cleanup write. The replacement task and durable
  // journal are allowed to commit; retry must finish cleanup under the same id.
  await worker.evaluate(() => {
    const realSet = chrome.storage.local.set.bind(chrome.storage.local)
    self.__af23FailLayoutCleanupOnce = true
    chrome.storage.local.set = async values => {
      if (self.__af23FailLayoutCleanupOnce && Object.hasOwn(values || {}, 'layout')) {
        self.__af23FailLayoutCleanupOnce = false
        throw new Error('AF23 injected one-time layout cleanup failure')
      }
      return realSet(values)
    }
  })

  await source.click('#replacement')
  await source.waitForFunction(() => /777/.test(document.querySelector('[data-af-panel]')?.textContent || ''), { timeout: 5_000 })
  await source.click('[data-af-done]')
  await source.waitForFunction(() => /再次確認同一操作/.test(document.querySelector('[data-af-done]')?.textContent || ''), { timeout: 15_000 })
  console.log('[C6 pending] injected cleanup failure is visible in source picker')

  const pending = await picker.evaluate(async ({ taskId, fieldKey }) => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    const operations = (await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || {}
    const operation = Object.values(operations).find(item => item.taskId === taskId && item.repairMode === 'replace')
    const task = await storage.getTask(taskId)
    return {
      operation: operation && { id: operation.id, status: operation.status },
      fields: task.fields.map(field => field.key), archived: task.archivedFields || [],
      source: task.spec.fields[0].source.locator.css, fieldKey
    }
  }, { taskId: TASK_ID, fieldKey: FIELD_KEY })
  assert.equal(pending.operation?.status, 'cleanup', 'task replacement is committed while cleanup is pending')
  assert.equal(pending.fields.length, 1, 'the task has exactly one active field before retry')
  assert.equal(pending.source, '#replacement', 'the selected source was persisted before cleanup pending')
  assert.notEqual(pending.fields[0], FIELD_KEY, 'replacement has one new stable key')
  assert.equal(pending.archived.filter(field => field.repairOperationId === pending.operation.id).length, 1)
  assert.equal(await picker.$eval(`[data-field-key="${FIELD_KEY}"] [data-field-repair]`, element => element.disabled), true,
    'settings UI keeps the operation locked while cleanup is pending')

  // This is the actual in-page retry control, not a direct message/handler call.
  const operationComplete = picker.waitForFunction(async operationId => {
    const operations = (await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || {}
    return operations.find(operation => operation.id === operationId)?.status === 'complete'
  }, { timeout: 15_000 }, pending.operation.id)
  await source.bringToFront()
  assert.equal(await source.$eval('[data-af-done]', element => element.disabled), false,
    'the visible same-operation retry control is actionable')
  void source.click('[data-af-done]').catch(() => {})
  console.log('[C6 pending] clicked same-operation confirmation')
  try {
    await operationComplete
  } catch (error) {
    const diagnostic = await Promise.all([
      picker.evaluate(async operationId => ((await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || [])
        .find(operation => operation.id === operationId), pending.operation.id),
      source.evaluate(() => ({ done: document.querySelector('[data-af-done]')?.outerHTML,
        panel: document.querySelector('[data-af-panel]')?.textContent?.slice(0, 500) })).catch(error => ({ detached: error.message }))
    ])
    console.error('[C6 pending retry diagnostic]', JSON.stringify(diagnostic))
    throw error
  }

  const final = await picker.evaluate(async ({ taskId, operationId, fieldKey }) => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    const layoutStore = await import(chrome.runtime.getURL('shared/layout-store.js'))
    const task = await storage.getTask(taskId)
    const operation = await storage.getFieldRepairOperation(operationId)
    const layout = await layoutStore.getLayout()
    const sources = layout.dashboards.flatMap(dashboard => dashboard.cards.flatMap(card => card.source || []))
    return {
      fields: task.fields.map(field => field.key),
      archived: task.archivedFields || [],
      operation: { id: operation.id, status: operation.status, resultKey: operation.result?.fieldKey },
      oldSeriesStillReferenced: sources.some(source => source.taskId === `${taskId}#${fieldKey}`)
    }
  }, { taskId: TASK_ID, operationId: pending.operation.id, fieldKey: FIELD_KEY })
  assert.deepEqual(final.fields, pending.fields, 'retry does not create a second field key')
  assert.equal(final.archived.filter(field => field.repairOperationId === final.operation.id).length, 1,
    'retry archives the replaced field exactly once')
  assert.equal(final.operation.status, 'complete')
  assert.equal(final.operation.resultKey, final.fields[0])
  assert.equal(final.oldSeriesStillReferenced, false, 'retry completes the original layout cleanup')
  console.log(JSON.stringify({ status: 'PASS', flow: 'C6 pending cleanup → visible same-operation retry',
    operationId: final.operation.id, fieldKeys: final.fields, archivedCount: 1,
    retryClicks: 1, browser: await browser.version(), extensionSource: SRC }, null, 2))
} catch (error) {
  console.error(error?.stack || String(error))
  process.exitCode = 1
} finally {
  try { await browser?.close() } catch {}
  try { server.closeAllConnections?.() } catch {}
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
  try { if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }) } catch {}
}
