// AF-23 D4 real-browser lifecycle smoke: keep one Picker document alive for
// ten create/edit/leave cycles. This is functional coverage, not a benchmark.
// Run with BROWSER_PATH pointing at Chrome/Chromium:
//   BROWSER_PATH=".../Google Chrome" node tests/smoke/af23_d4_picker_lifecycle.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { ROOT, findBrowser } from './browser-path.mjs'

const SRC = resolve(process.env.AF23_D4_SRC || join(ROOT, 'src'))
const CHROME = findBrowser()
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><meta charset="utf-8"><title>D4 fixture</title><div id="value">42</div>')
})
const listen = () => new Promise((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
})

let browser
let profile
try {
  profile = mkdtempSync(join(os.tmpdir(), 'af23-d4-picker-'))
  const port = await listen()
  const fixtureUrl = `http://127.0.0.1:${port}/`
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  })
  const worker = await browser.waitForTarget(target =>
    target.type() === 'service_worker' && target.url().includes('/background/main.js'), { timeout: 20_000 })
  const extensionId = new URL(worker.url()).host

  const target = await browser.newPage()
  await target.goto(fixtureUrl, { waitUntil: 'load' })
  const driver = await browser.newPage()
  await driver.goto(`chrome-extension://${extensionId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  const tabId = await driver.evaluate(async url => (await chrome.tabs.query({ url }))[0]?.id, fixtureUrl)
  assert.ok(Number.isInteger(tabId), 'fixture tab has a Chrome tab id')

  const task = {
    id: 'd4-browser-lifecycle-task', name: 'D4 編輯任務', url: fixtureUrl, mode: 'multi', enabled: true,
    fields: [{ key: 'field-1', name: '值 1', mode: 'number' }],
    spec: { mode: 'multi', fields: [{ key: 'field-1', name: '值 1', mode: 'number', source: { locator: { css: '#value' } }, spec: { strategy: 'auto' } }] }
  }
  const initialCtx = { kind: 'waiting', purpose: 'task' }
  await driver.evaluate(async ({ tabId, task, initialCtx }) => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    await storage.init()
    await storage.saveTask(task)
    await chrome.storage.session.set({ [`panel:${tabId}`]: initialCtx })
  }, { tabId, task, initialCtx })

  const picker = await browser.newPage()
  await picker.goto(`chrome-extension://${extensionId}/ui/picker/picker.html?tabId=${tabId}`, { waitUntil: 'domcontentloaded' })
  await picker.waitForFunction(() => document.body.dataset.afPickerReady === 'true', { timeout: 10_000 })
  const cdp = await picker.createCDPSession()
  await cdp.send('Runtime.enable')

  const listenerCount = async selector => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` })
    assert.ok(result.objectId, `listener target exists: ${selector}`)
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })
    return listeners.length
  }
  const stableListenerCounts = async () => Object.fromEntries(await Promise.all(
    ['#name', '#mode', '#save', '#test-now', '#cancel'].map(async selector => [selector, await listenerCount(selector)])
  ))
  const transition = async ctx => picker.evaluate(async context => {
    const module = await import(chrome.runtime.getURL('ui/picker/picker.js'))
    return module.renderFromPanelCtx(context)
  }, ctx)
  const waitForName = name => picker.waitForFunction(expected =>
    document.getElementById('name')?.value === expected && document.body.dataset.afPickerReady === 'true',
  { timeout: 5_000 }, name)

  let baselineListeners = null
  for (let cycle = 1; cycle <= 10; cycle++) {
    const nameHint = `新任務 ${cycle}`
    const newCtx = { kind: 'new', ctx: {
      tabId, nameHint, url: fixtureUrl, mode: 'number', locator: { css: '#value' }, preview: `預覽 ${cycle}`
    } }
    // Simulate the old form's visible state, then switch to a genuinely new context.
    await picker.evaluate(() => {
      document.getElementById('name').value = '上一任務名稱'
      const preview = document.getElementById('preview')
      preview.textContent = '上一任務預覽結果'
      const button = document.getElementById('test-now')
      button.textContent = '抓取中…'
      button.disabled = true
    })
    const create = await transition(newCtx)
    assert.equal(create.rendered, true, `cycle ${cycle}: new context renders`)
    await waitForName(nameHint)
    assert.equal(await picker.$eval('#preview', el => el.textContent), `預覽 ${cycle}`,
      `cycle ${cycle}: preview belongs to the new context`)
    assert.equal(await picker.$eval('#test-now', el => el.disabled), false,
      `cycle ${cycle}: new context is not left busy`)
    assert.equal(await picker.$eval('#test-now', el => el.textContent), '試抓',
      `cycle ${cycle}: busy label is cleared`)
    assert.equal(await picker.$$eval('#field-list [data-field-row]', rows => rows.length), 0,
      `cycle ${cycle}: new task has no stale field rows`)

    const dirtyName = `未存草稿 ${cycle}`
    await picker.locator('#name').fill(dirtyName)
    await picker.$eval('#preview', (el, value) => { el.textContent = value }, `未存預覽 ${cycle}`)
    const same = await transition(newCtx)
    assert.equal(same.rendered, false, `cycle ${cycle}: same context avoids repaint`)
    assert.equal(await picker.$eval('#name', el => el.value), dirtyName,
      `cycle ${cycle}: same context preserves unsaved name`)
    assert.equal(await picker.$eval('#preview', el => el.textContent), `未存預覽 ${cycle}`,
      `cycle ${cycle}: same context preserves current preview state`)

    const edit = await transition({ kind: 'edit', taskId: task.id })
    assert.equal(edit.rendered, true, `cycle ${cycle}: edit context renders`)
    await picker.waitForFunction(() => document.querySelector('#field-list [data-field-row]')?.dataset.fieldKey === 'field-1')
    await picker.locator('#name').fill(`編輯草稿 ${cycle}`)
    assert.equal(await picker.$$eval('#field-list [data-field-row]', rows => rows.length), 1,
      `cycle ${cycle}: exactly one task field row is present`)

    const listeners = await stableListenerCounts()
    if (baselineListeners === null) baselineListeners = listeners
    else assert.deepEqual(listeners, baselineListeners, `cycle ${cycle}: stable controls do not gain handlers`)

    // Exercise the real Cancel control; it closes the form session and clears its draft timer.
    await picker.click('#cancel')
    await wait(30)
    await transition({ kind: 'waiting', purpose: 'task' })
    assert.equal(await picker.$eval('#picker-form', el => el.hidden), true,
      `cycle ${cycle}: leaving returns the same document to waiting state`)
  }

  const finalListeners = await stableListenerCounts()
  assert.deepEqual(finalListeners, baselineListeners, 'ten cycles leave stable control listener counts')
  console.log(JSON.stringify({ status: 'PASS', cycles: 10, documentCount: 1, stableControlListeners: finalListeners }, null, 2))
} catch (error) {
  console.error(error?.stack || String(error))
  process.exitCode = 1
} finally {
  try { await browser?.close() } catch {}
  try { server.close() } catch {}
  try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch {}
}
