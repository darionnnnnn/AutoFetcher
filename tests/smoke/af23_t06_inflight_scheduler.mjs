// T06 minimum real-browser race: a scheduled EXTRACT is held at the real
// chrome.tabs.sendMessage boundary while the user repairs or deletes its task.
// Run with AF23_QA_SRC=".../qa/src" BROWSER_PATH=".../Google Chrome for Testing".
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBrowser } from './browser-path.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SRC = resolve(process.env.AF23_QA_SRC || join(ROOT, 'src'))
const CHROME = process.env.BROWSER_PATH || findBrowser()
const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>AF23 T06 fixture</title>
<main><strong id="old-value">500</strong><strong id="new-value">900</strong></main>`
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(fixtureHtml)
})
const listen = srv => new Promise((resolveListen, reject) => {
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => resolveListen(srv.address().port))
})
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const pad = value => String(value).padStart(2, '0')
const localDate = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

let browser
let tempRoot
let panel
try {
  assert.ok(existsSync(join(SRC, 'manifest.json')), `extension source is missing: ${SRC}`)
  tempRoot = mkdtempSync(join(os.tmpdir(), 'af23-t06-'))
  const extensionSrc = join(tempRoot, 'extension')
  cpSync(SRC, extensionSrc, { recursive: true })

  // This copy-only hook holds one real EXTRACT send until the test releases it.
  // The original Chrome API call still runs afterwards against the actual page.
  const mainPath = join(extensionSrc, 'background/main.js')
  let mainSource = readFileSync(mainPath, 'utf8')
  const insertBefore = '// 面板 ctx 可能尚未寫入就收到 pagehide'
  assert.ok(mainSource.includes(insertBefore), 'background injection point is present')
  const hook = `// AF23 T06 test-only EXTRACT gate (temporary extension copy only)
let __af23T06Arm = null
let __af23T06Release = null
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'AF23_T06_ARM') {
    __af23T06Arm = message.token
    sendResponse({ ok: true })
  } else if (message?.type === 'AF23_T06_RELEASE' && __af23T06Release?.token === message.token) {
    const release = __af23T06Release
    __af23T06Release = null
    release.resolve()
    sendResponse({ ok: true })
  }
})
const __af23T06NativeSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs)
chrome.tabs.sendMessage = async (tabId, message, options) => {
  if (message?.type === 'EXTRACT' && __af23T06Arm) {
    const token = __af23T06Arm
    __af23T06Arm = null
    let resolveHold
    const held = new Promise(resolve => { resolveHold = resolve })
    __af23T06Release = { token, resolve: resolveHold }
    await chrome.storage.local.set({ __af23T06Held: { token, tabId } })
    await held
  }
  return __af23T06NativeSendMessage(tabId, message, options)
}
`
  mainSource = mainSource.replace(insertBefore, `${hook}\n${insertBefore}`)
  writeFileSync(mainPath, mainSource)

  const port = await listen(server)
  const fixtureUrl = `http://127.0.0.1:${port}/`
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', userDataDir: join(tempRoot, 'profile'),
    args: [`--disable-extensions-except=${extensionSrc}`, `--load-extension=${extensionSrc}`, '--no-first-run', '--no-default-browser-check']
  })
  const worker = await browser.waitForTarget(target =>
    target.type() === 'service_worker' && target.url().endsWith('/background/main.js'), { timeout: 20_000 })
  const extensionId = new URL(worker.url()).host
  const fixture = await browser.newPage()
  await fixture.goto(fixtureUrl, { waitUntil: 'load' })
  panel = await browser.newPage()
  await panel.goto(`chrome-extension://${extensionId}/ui/report/report.html#view=settings`, { waitUntil: 'domcontentloaded' })
  await panel.waitForFunction(() => Boolean(chrome?.runtime?.id))
  const date = localDate()
  const seedTask = async (id, unrelated = false) => panel.evaluate(async ({ id, url, date, unrelated }) => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    const task = {
      id, name: id, url, mode: 'multi', enabled: true,
      fields: [{ key: 'price', name: '價格', mode: 'number', stateActions: [] }],
      spec: { mode: 'multi', fields: [{ key: 'price', mode: 'number',
        source: { locator: { css: '#old-value', path: '', xpath: '' } }, spec: { strategy: 'auto' } }] },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
      alerts: [{ id: 'price-high', field: 'price', type: 'gt', value: 100, enabled: true }]
    }
    await storage.saveTask(task)
    await storage.appendRecord(date, { taskId: `${id}#price`, slot: `${date}T08:00`,
      capturedAt: `${date}T00:00:00.000Z`, value: 12, raw: '12', status: 'ok' })
    await storage.updateHealthMap(current => ({ ...current, [id]: { status: 'ok', failStreak: 0, at: `${date}T00:00:00.000Z` } }))
    await storage.setLastValue(`${id}#price`, { value: 12, raw: '12', status: 'ok', at: `${date}T00:00:00.000Z` })
    await storage.updateAlertLog(current => ({ ...current, [`${id}#price:seed`]: Date.now() - 60_000 }))
    await storage.updateAlertCommitLog(current => ({ ...current, [`${id}#price:seed`]: { at: Date.now() - 60_000, status: 'ok' } }))
    if (unrelated) {
      await storage.saveTask({ ...task, id: `${id}-other`, name: 'unrelated' })
      await storage.appendRecord(date, { taskId: `${id}-other#price`, slot: `${date}T08:00`,
        capturedAt: `${date}T00:00:00.000Z`, value: 33, raw: '33', status: 'ok' })
    }
  }, { id, url: fixtureUrl, date, unrelated })

  const getSnapshot = id => panel.evaluate(async taskId => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    const today = new Date().toLocaleDateString('sv-SE')
    return {
      task: await storage.getTask(taskId),
      records: await storage.getRecordsByDate(today),
      health: await storage.getHealthMap(),
      lastValues: await storage.getLastValues(),
      alertLog: await storage.getAlertLog(),
      alertCommitLog: await storage.getAlertCommitLog(),
      runState: await storage.getRunState(),
      notifications: await chrome.notifications.getAll()
    }
  }, id)
  const waitHeld = token => panel.waitForFunction(async expected =>
    (await chrome.storage.local.get('__af23T06Held')).__af23T06Held?.token === expected, { timeout: 20_000 }, token)
  const armAndFire = async (id, token) => {
    const armed = await panel.evaluate(async expected => chrome.runtime.sendMessage({ type: 'AF23_T06_ARM', token: expected }), token)
    assert.equal(armed?.ok, true, 'test hook arms in the real extension worker')
    await panel.evaluate(async taskId => chrome.alarms.create(`task:${taskId}:0`, { when: Date.now() + 500 }), id)
    await waitHeld(token)
    const held = await panel.evaluate(() => chrome.storage.local.get('__af23T06Held'))
    return held.__af23T06Held.tabId
  }
  const release = async token => {
    const result = await panel.evaluate(expected => chrome.runtime.sendMessage({ type: 'AF23_T06_RELEASE', token: expected }), token)
    assert.equal(result?.ok, true, 'release resumes the real tabs.sendMessage(EXTRACT) call')
  }
  const waitRunFinished = async id => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const active = await panel.evaluate(async taskId => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    const runState = await storage.getRunState()
      return Object.keys(runState).some(key => key.includes(taskId))
      }, id)
      if (!active) return true
      await delay(100)
    }
    const state = await panel.evaluate(async taskId => {
      const storage = await import(chrome.runtime.getURL('shared/storage.js'))
      return { runState: await storage.getRunState(), task: await storage.getTask(taskId) }
    }, id)
    throw new Error(`run state did not finish for ${id}: ${JSON.stringify(state)}`)
  }

  // Repair case: the user finishes same-value repair through the real Picker UI.
  const repairId = 'af23-t06-repair'
  await seedTask(repairId)
  const beforeRepair = await getSnapshot(repairId)
  const originalTabId = await armAndFire(repairId, 'repair-on-the-wire')
  const picker = await browser.newPage()
  await picker.goto(`chrome-extension://${extensionId}/ui/picker/picker.html?taskId=${repairId}`, { waitUntil: 'domcontentloaded' })
  const repairButton = `[data-field-key="price"] [data-field-repair]`
  await picker.waitForSelector(repairButton, { visible: true })
  const oldTargets = new Set(browser.targets())
  await picker.click(repairButton)
  const sourceTarget = await browser.waitForTarget(target => !oldTargets.has(target) && target.url() === fixtureUrl, { timeout: 10_000 })
  const source = await sourceTarget.page()
  await source.waitForSelector('[data-af-done]', { visible: true })
  const sourceClosed = new Promise(resolveClosed => source.once('close', resolveClosed))
  await source.click('#new-value')
  await source.click('[data-af-done]')
  await Promise.race([sourceClosed, delay(10_000).then(() => { throw new Error('repair source tab did not close after ACK') })])
  await picker.waitForFunction(() => document.querySelector('[data-field-key="price"]')?.textContent.includes('立即儲存'),
    { timeout: 10_000 })
  const afterRepairMutation = await getSnapshot(repairId)
  assert.equal(afterRepairMutation.task.spec.fields[0].source.locator.css, '#new-value', 'real Picker repair persisted the new source')
  assert.deepEqual(afterRepairMutation.records.filter(record => record.taskId.startsWith(`${repairId}#`)),
    beforeRepair.records.filter(record => record.taskId.startsWith(`${repairId}#`)), 'repair mutation retains old committed history')
  await release('repair-on-the-wire')
  console.log('[T06] repair EXTRACT released to native Chrome messaging')
  await waitRunFinished(repairId)
  const afterRepairRun = await getSnapshot(repairId)
  assert.deepEqual(afterRepairRun.records.filter(record => record.taskId.startsWith(`${repairId}#`)),
    afterRepairMutation.records.filter(record => record.taskId.startsWith(`${repairId}#`)), 'stale EXTRACT does not append a repaired task record')
  assert.deepEqual(afterRepairRun.health[repairId], afterRepairMutation.health[repairId], 'stale run does not change task health')
  assert.deepEqual(afterRepairRun.lastValues[`${repairId}#price`], afterRepairMutation.lastValues[`${repairId}#price`], 'stale run does not publish a last value')
  assert.deepEqual(afterRepairRun.alertLog, afterRepairMutation.alertLog, 'stale value above threshold does not emit an alert')
  assert.deepEqual(afterRepairRun.alertCommitLog, afterRepairMutation.alertCommitLog, 'stale run does not claim an alert commit')
  assert.deepEqual(afterRepairRun.notifications, afterRepairMutation.notifications, 'stale run does not create a browser notification')
  console.log('[PASS] T06 scheduled EXTRACT held in Chrome; real Picker repair preserves history and rejects old result', { originalTabId })
  await picker.close()

  // Delete case: the actual Tasks page and confirmation dialog delete the task
  // while its scheduled extraction is still held in the worker.
  const deleteId = 'af23-t06-delete'
  await seedTask(deleteId, true)
  const beforeDelete = await getSnapshot(deleteId)
  await armAndFire(deleteId, 'delete-on-the-wire')
  const tasks = await browser.newPage()
  await tasks.goto(`chrome-extension://${extensionId}/ui/report/report.html#view=tasks`, { waitUntil: 'domcontentloaded' })
  const deleteButton = `#task-list [data-task-id="${deleteId}"] [data-action="delete"]`
  await tasks.waitForSelector(deleteButton, { visible: true, timeout: 10_000 })
  await tasks.click(deleteButton)
  await tasks.waitForSelector('dialog.modal [data-action="confirm"]', { visible: true })
  await tasks.click('dialog.modal [data-action="confirm"]')
  await tasks.waitForFunction(async id => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    return await storage.getTask(id) === null
  }, { timeout: 10_000 }, deleteId)
  const afterDeleteMutation = await getSnapshot(deleteId)
  assert.equal(afterDeleteMutation.task, null, 'the real delete action removed the task')
  assert.equal(afterDeleteMutation.records.some(record => record.taskId.startsWith(`${deleteId}#`)), false,
    'explicit deletion clears that task history as specified')
  assert.ok(afterDeleteMutation.records.some(record => record.taskId.startsWith(`${deleteId}-other#`)),
    'deletion preserves unrelated task history')
  await release('delete-on-the-wire')
  await waitRunFinished(deleteId)
  const afterDeleteRun = await getSnapshot(deleteId)
  assert.equal(afterDeleteRun.task, null, 'the stale run cannot recreate a deleted task')
  assert.equal(afterDeleteRun.records.some(record => record.taskId.startsWith(`${deleteId}#`)), false,
    'the held old extraction cannot write new history after deletion')
  assert.deepEqual(afterDeleteRun.records.filter(record => record.taskId.startsWith(`${deleteId}-other#`)),
    afterDeleteMutation.records.filter(record => record.taskId.startsWith(`${deleteId}-other#`)), 'unrelated history remains intact')
  assert.deepEqual(afterDeleteRun.health, afterDeleteMutation.health, 'stale run cannot republish health after deletion')
  assert.deepEqual(afterDeleteRun.lastValues, afterDeleteMutation.lastValues, 'stale run cannot republish last values after deletion')
  assert.deepEqual(afterDeleteRun.alertLog, afterDeleteMutation.alertLog, 'stale run cannot publish alert log after deletion')
  assert.deepEqual(afterDeleteRun.alertCommitLog, afterDeleteMutation.alertCommitLog, 'stale run cannot publish alert commit after deletion')
  assert.deepEqual(afterDeleteRun.notifications, afterDeleteMutation.notifications, 'stale run cannot emit a notification after deletion')
  console.log('[PASS] T06 scheduled EXTRACT held in Chrome; confirmed delete clears own history and stale run cannot recreate it')
} catch (error) {
  console.error(error?.stack || String(error))
  process.exitCode = 1
} finally {
  try { await browser?.close() } catch {}
  try { server.closeAllConnections?.() } catch {}
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
  try { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }) } catch {}
}
