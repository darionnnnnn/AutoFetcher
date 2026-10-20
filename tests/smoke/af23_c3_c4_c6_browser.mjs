// AF-23 C3/C4/C6 missing real-browser subclauses. Functional smoke only.
// Run from the QA worktree with its src, or set AF23_QA_SRC explicitly:
//   AF23_QA_SRC="../qa/src" BROWSER_PATH=".../Google Chrome for Testing" node tests/smoke/af23_c3_c4_c6_browser.mjs
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SRC = resolve(process.env.AF23_QA_SRC || join(ROOT, 'src'))
const CHROME = process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>AF23 C3 C4 C6 fixture</title>
<style>body{font:18px sans-serif;padding:24px}table{border-collapse:collapse}td,th{border:1px solid #777;padding:14px}strong{display:block;margin:20px}</style>
<table id="prices"><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody><tr><th>A</th><td id="value-a">123</td></tr><tr><th>B</th><td id="value-b">456</td></tr></tbody></table>
<strong id="replacement">777</strong>`
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(fixtureHtml)
})
const listen = () => new Promise((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
})
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const pad = value => String(value).padStart(2, '0')

let browser
let profile
const outcomes = []
try {
  profile = mkdtempSync(join(os.tmpdir(), 'af23-c3-c4-c6-'))
  const port = await listen()
  const fixtureUrl = `http://127.0.0.1:${port}/`
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', userDataDir: profile,
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  })
  const worker = await browser.waitForTarget(target =>
    target.type() === 'service_worker' && target.url().endsWith('/background/main.js'), { timeout: 20_000 })
  const extensionId = new URL(worker.url()).host
  console.log('[C3/C4/C6] extension worker ready')
  const fixture = await browser.newPage()
  await fixture.goto(fixtureUrl, { waitUntil: 'load' })
  const control = await browser.newPage()
  await control.goto(`chrome-extension://${extensionId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  await control.waitForFunction(() => Boolean(chrome?.runtime?.id))
  const tabId = await control.evaluate(async url => (await chrome.tabs.query({ url }))[0]?.id, fixtureUrl)
  assert.ok(Number.isInteger(tabId))
  console.log('[C3/C4/C6] fixture ready', fixtureUrl)

  const cell = index => ({ row: { index, header: index === 0 ? 'A' : 'B' }, col: { index: 1, header: '價格' } })
  const task = (id, fields) => ({
    id, name: `Fixture ${id}`, url: fixtureUrl, mode: 'multi', enabled: true,
    locator: { css: '#prices' }, fields: fields.map(({ key, name, mode = 'number' }) => ({ key, name, mode })),
    spec: { mode: 'multi', fields: fields.map(field => ({
      key: field.key, name: field.name, mode: field.mode || 'number',
      source: { locator: { css: field.css } }, spec: field.spec || { cell: cell(0) }
    })) },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  })
  const seed = async tasks => control.evaluate(async values => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    for (const value of values) await storage.saveTask(value)
  }, tasks)
  const editPage = async id => {
    const page = await browser.newPage()
    await page.goto(`chrome-extension://${extensionId}/ui/picker/picker.html?taskId=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#test-now:not([hidden])')
    return page
  }
  const openRepair = async (page, key, action = 'repair') => {
    const selector = `[data-field-key="${key}"] [data-field-${action}]`
    const old = new Set(browser.targets())
    await page.click(selector)
    const target = await browser.waitForTarget(item => !old.has(item) && item.url() === fixtureUrl, { timeout: 8000 })
    const source = await target.page()
    await source.waitForSelector('[data-af-done]', { visible: true })
    return source
  }
  const selectAndFinish = async (source, selector) => {
    await source.waitForSelector(selector, { visible: true })
    await source.click(selector)
    assert.ok(await source.$('[data-af-picked]'), `source selected ${selector}`)
    await source.click('[data-af-done]')
  }
  const taskState = id => control.evaluate(async taskId => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    return storage.getTask(taskId)
  }, id)

  // C3: burst mouse/keyboard input and competing repair/replace must still open one operation/tab.
  const rapidId = 'af23-c3-rapid'
  await seed([task(rapidId, [{ key: 'price', name: '價格', css: '#value-a', spec: { cell: cell(0) } }])])
  const rapid = await editPage(rapidId)
  console.log('[C3] rapid editor ready')
  const oldTargets = new Set(browser.targets())
  const repairSelector = '[data-field-key="price"] [data-field-repair]'
  const replaceSelector = '[data-field-key="price"] [data-field-replace]'
  await rapid.click(repairSelector)
  console.log('[C3] first repair click sent')
  const onlySource = await browser.waitForTarget(item => !oldTargets.has(item) && item.url() === fixtureUrl, { timeout: 8000 })
  console.log('[C3] source page opened')
  const source = await onlySource.page()
  await source.waitForSelector('[data-af-done]', { visible: true })
  await rapid.bringToFront()
  for (let i = 0; i < 10; i++) {
    await rapid.click(repairSelector)
    await rapid.focus(repairSelector)
    await rapid.keyboard.press('Enter')
    await rapid.click(replaceSelector)
    await rapid.focus(replaceSelector)
    await rapid.keyboard.press('Enter')
  }
  console.log('[C3] ten repair/replace click and Enter pairs sent while reserved')
  await wait(150)
  const sourceTabs = browser.targets().filter(item => !oldTargets.has(item) && item.url() === fixtureUrl)
  assert.equal(sourceTabs.length, 1, 'ten clicks/Enter and competing replace create one owned source tab')
  const activeOps = await control.evaluate(async taskId => {
    const values = (await chrome.storage.local.get('fieldRepairOperations')).fieldRepairOperations || {}
    return Object.values(values).filter(op => op.taskId === taskId && op.status !== 'complete' && op.status !== 'failed')
  }, rapidId)
  assert.equal(activeOps.length, 0, 'opening only a repair grant does not create an applied journal operation')
  assert.equal(await rapid.$eval(repairSelector, element => element.disabled), true)
  assert.equal(await rapid.$eval(replaceSelector, element => element.disabled), true,
    'repair and replace are mutually locked while the source tab is active')
  await source.close()
  await rapid.waitForFunction(() => !document.querySelector('[data-field-key="price"] [data-field-repair]')?.disabled, { timeout: 8000 })
  outcomes.push({ criterion: 'C3 rapid-click/Enter, interlock, manual source-close unlock', sourceTabs: sourceTabs.length, status: 'PASS' })

  // C3 retry: force one BEGIN startup refusal at the extension API seam, then retry with the real worker.
  const retryId = 'af23-c3-retry'
  await seed([task(retryId, [{ key: 'price', name: '價格', css: '#value-a', spec: { cell: cell(0) } }])])
  const retry = await editPage(retryId)
  console.log('[C3] retry editor ready')
  await retry.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    window.__af23SendMessage = original
    let once = true
    chrome.runtime.sendMessage = (message, ...args) => {
      if (once && message?.type === 'BEGIN_FIELD_REPAIR') {
        once = false
        return Promise.resolve({ ok: false, error: 'tab_create_failed', message: '來源頁開啟失敗（測試注入）' })
      }
      return original(message, ...args)
    }
  })
  await retry.click('[data-field-key="price"] [data-field-repair]')
  await retry.waitForFunction(() => /來源頁開啟失敗/.test(document.querySelector('[data-field-hint]')?.textContent || ''))
  assert.equal(await retry.$eval('[data-field-key="price"] [data-field-repair]', element => element.disabled), false,
    'startup refusal restores the retry action')
  await retry.evaluate(() => { chrome.runtime.sendMessage = window.__af23SendMessage })
  const retrySource = await openRepair(retry, 'price')
  console.log('[C3] retry source opened')
  await retrySource.click('[data-af-cancel]')
  await retry.waitForFunction(() => !document.querySelector('[data-field-key="price"] [data-field-repair]')?.disabled)
  outcomes.push({ criterion: 'C3 startup refusal then real retry and cancel unlock', status: 'PASS' })
  await retry.close()

  // C4: hold preview A's response, apply source B through the real repair UI, then release A.
  const c4Id = 'af23-c4-preview-race'
  await seed([task(c4Id, [{ key: 'price', name: '價格', css: '#value-a', spec: { cell: cell(0) } }])])
  const c4 = await editPage(c4Id)
  console.log('[C4] editor ready')
  await c4.locator('#name').fill('未儲存名稱 C4')
  console.log('[C4] unsaved name set')
  await c4.locator('#time-input').fill('10:15')
  await c4.click('#time-add')
  console.log('[C4] unsaved schedule set')
  await c4.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    window.__af23SendMessage = original
    window.__af23ReleasePreview = null
    chrome.runtime.sendMessage = (message, ...args) => message?.type === 'TEST_TASK'
      ? new Promise(resolvePreview => { window.__af23ReleasePreview = resolvePreview })
      : original(message, ...args)
  })
  await c4.click('#test-now')
  console.log('[C4] delayed preview started')
  await c4.waitForFunction(() => Boolean(window.__af23ReleasePreview) && document.querySelector('#test-now')?.disabled)
  const c4Source = await openRepair(c4, 'price')
  console.log('[C4] repair source opened')
  await selectAndFinish(c4Source, '#value-b')
  await c4.waitForFunction(async id => {
    const storage = await import(chrome.runtime.getURL('shared/storage.js'))
    return (await storage.getTask(id))?.spec?.fields?.[0]?.spec?.cell?.row?.index === 1 &&
      /來源已立即儲存/.test(document.querySelector('[data-field-key="price"]')?.textContent || '')
  }, { timeout: 10_000 }, c4Id)
  assert.equal(await c4.$eval('#name', element => element.value), '未儲存名稱 C4', 'repair preserves unsaved task name')
  assert.ok((await c4.$eval('#times', element => element.value)).includes('10:15'), 'repair preserves unsaved schedule')
  await c4.evaluate(() => {
    chrome.runtime.sendMessage = window.__af23SendMessage
    window.__af23ReleasePreview({ ok: true, value: 123, raw: '123' })
  })
  let stalePreviewNote = ''
  try {
    await c4.waitForFunction(() => /來源或設定已變更.*請重新試抓/.test(document.querySelector('#test-note')?.textContent || ''), { timeout: 2500 })
    stalePreviewNote = await c4.$eval('#test-note', element => element.textContent)
    outcomes.push({ criterion: 'C4 delayed preview A cannot overwrite repaired source B; unsaved form retained', status: 'PASS' })
  } catch {
    stalePreviewNote = await c4.$eval('#test-note', element => element.textContent)
    process.exitCode = 1
    outcomes.push({ criterion: 'C4 delayed preview A cannot overwrite repaired source B; unsaved form retained', status: 'FAIL', note: stalePreviewNote })
  }
  assert.notEqual(await c4.$eval('#preview', element => element.textContent), '123',
    'late result A cannot replace the current source B preview')
  await c4.close()

  // C6: actual partial TEST_TASK results and field-local repair action; then verify login-settings action route.
  const partialId = 'af23-c6-partial'
  await seed([task(partialId, [
    { key: 'good', name: '成功值', css: '#prices', spec: { cell: cell(0) } },
    { key: 'missing', name: '失敗值', css: '#not-present', spec: { strategy: 'auto' } }
  ])])
  const partial = await editPage(partialId)
  console.log('[C6] partial editor ready')
  await partial.click('#test-now')
  console.log('[C6] partial preview started')
  try {
    await partial.waitForFunction(() => !document.querySelector('#test-now')?.disabled && /成功 1 個、失敗 1 個/.test(document.querySelector('#preview')?.textContent || ''), { timeout: 20_000 })
  } catch (error) {
    console.log('[C6 partial diagnostic]', await partial.evaluate(() => ({ preview: document.querySelector('#preview')?.textContent,
      errors: document.querySelector('#errors')?.textContent, note: document.querySelector('#test-note')?.textContent,
      button: { text: document.querySelector('#test-now')?.textContent, disabled: document.querySelector('#test-now')?.disabled },
      rows: [...document.querySelectorAll('[data-field-row]')].map(row => ({ key: row.dataset.fieldKey, result: row.querySelector('[data-field-result]')?.textContent })) })))
    throw error
  }
  assert.equal(await partial.$eval('[data-field-key="good"] [data-field-result]', element => element.textContent.trim()), '123')
  const failedRow = await partial.$eval('[data-field-key="missing"] [data-field-result]', element => ({
    text: element.textContent, state: element.dataset.state, title: element.title
  }))
  assert.equal(failedRow.text, '—', 'failed field value is shown as a dash in its row')
  assert.equal(failedRow.state, 'error', 'failed field is visibly marked on the correct row')
  assert.match(failedRow.title, /找不到|失敗|not_found/, 'failed field reason stays attached to the correct key')
  const failedSource = await openRepair(partial, 'missing')
  await failedSource.click('[data-af-cancel]')
  assert.equal((await taskState(partialId)).spec.fields[1].source.locator.css, '#not-present',
    'the next-step action belongs to the failing field key and cancellation does not change its source')

  await partial.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime)
    window.__af23SendMessage = original
    chrome.runtime.sendMessage = (message, ...args) => message?.type === 'TEST_TASK'
      ? Promise.resolve({ ok: false, error: 'login_failed', message: '登入失敗（測試注入）' })
      : original(message, ...args)
  })
  await partial.click('#test-now')
  const loginAction = '[data-action="open-site-login-settings"]'
  await partial.waitForSelector(loginAction, { visible: true })
  assert.match(await partial.$eval('#test-note', element => element.textContent), /請檢查站台登入欄位/)
  const oldTabs = new Set(browser.targets())
  await partial.click(loginAction)
  const siteTarget = await browser.waitForTarget(item => !oldTabs.has(item) &&
    item.url().startsWith(`chrome-extension://${extensionId}/ui/site/site.html?`), { timeout: 8_000 })
  const siteUrl = new URL(siteTarget.url())
  assert.equal(siteUrl.searchParams.get('origin'), new URL(fixtureUrl).origin,
    'login failure action opens settings for the affected site origin')
  outcomes.push({ criterion: 'C6 partial counts/key-specific repair and login-settings route', partialSummary: '1 success / 1 failure', siteOrigin: siteUrl.searchParams.get('origin'), status: 'PASS' })

  console.log(JSON.stringify({ status: outcomes.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL', browserVersion: await browser.version(), source: SRC, outcomes }, null, 2))
} catch (error) {
  console.error(error?.stack || String(error))
  process.exitCode = 1
} finally {
  try { await browser?.close() } catch {}
  try { server.closeAllConnections?.() } catch {}
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
  try { if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }) } catch {}
}
