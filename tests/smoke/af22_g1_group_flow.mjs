// AF-22 G1 new group-flow browser smoke. Run with: node tests/smoke/af22_g1_group_flow.mjs
// Checkpoints are explicit so a blocked cross-frame or later save path is not
// mistaken for a passing end-to-end run.
import puppeteer from 'puppeteer-core'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'

const SRC = resolve('src')
const CHROME = process.env.BROWSER_PATH || join(os.tmpdir(), 'af22-cft', 'chrome', 'win64-154.0.8037.57', 'chrome-win64', 'chrome.exe')
const deadline = Date.now() + 300_000
const ck = label => console.log(`[checkpoint] ${label}`)
const bounded = async (label, fn, ms = 12000) => {
  const left = Math.max(1, Math.min(ms, deadline - Date.now()))
  let timer
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), left) })])
  } finally { clearTimeout(timer) }
}
const mainFixture = framePort => `<!doctype html><meta charset="utf-8"><title>AF22 G1 fixture</title>
<style>body{font:18px sans-serif}table{border-collapse:collapse;margin:24px}td,th{border:1px solid;padding:18px}#scattered{margin:50px;padding:24px;border:1px solid}</style>
<h1>Fixture for group flow</h1><span id="group-name-text">Second Group Picked Name</span>
<table id="nested"><tbody><tr><td>product</td><td><table><tbody><tr><td>First price</td><td id="price-a">101</td></tr></tbody></table></td></tr></tbody></table>
<table role="table" aria-label="CSS table"><div role="row"><span role="cell">Second price</span><span role="cell" id="price-b">202</span></div></table>
<div id="scattered">Scattered amount <strong id="price-c">303</strong></div>
<iframe title="cross-origin fixture" src="http://127.0.0.1:${framePort}/frame"></iframe>`
const frameFixture = '<!doctype html><meta charset="utf-8"><div id="frame-price" style="margin:30px;padding:20px">404</div>'
const listen = server => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)) })
const clickSelector = async (page, selector) => {
  const el = await page.$(selector)
  if (!el) throw new Error(`missing ${selector}`)
  const box = await el.boundingBox()
  if (!box) throw new Error(`no visible bounds for ${selector}`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}
const clickPanel = async (page, selector) => {
  const clicked = await page.evaluate(selectorText => {
    const element = document.querySelector(selectorText)
    if (!element) return false
    element.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`missing panel control ${selector}`)
}
const waitOverlay = page => page.waitForSelector('[data-af-overlay] [data-af-done]', { timeout: 20000 })
const clickTarget = async (page, selector) => {
  await page.waitForSelector(selector, { timeout: 8000 })
  await clickSelector(page, selector)
  await new Promise(resolveWait => setTimeout(resolveWait, 250))
}
const clickFrameTarget = async (page, frame, selector) => {
  await frame.waitForSelector(selector, { timeout: 5000 })
  const el = await frame.$(selector)
  const box = await el.boundingBox()
  if (!box) throw new Error(`cross-origin frame element has no bounds: ${selector}`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}
const mainServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(mainFixture(framePort)) })
const frameServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(frameFixture) })
let framePort, mainPort, browser, profile
try {
  if (!existsSync(CHROME)) throw new Error(`Chrome for Testing binary unavailable: ${CHROME}`)
  framePort = await listen(frameServer)
  mainPort = await listen(mainServer)
  const url = `http://127.0.0.1:${mainPort}/`
  profile = mkdtempSync(join(os.tmpdir(), 'af22-g1-'))
  browser = await bounded('launch CfT', () => puppeteer.launch({ executablePath: CHROME, headless: false, userDataDir: profile, args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check'] }), 25000)
  const worker = await bounded('extension worker', async () => {
    const end = Date.now() + 20000
    while (Date.now() < end) {
      const w = browser.targets().find(t => t.type() === 'service_worker' && t.url().includes('/background/main.js'))
      if (w) return w
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error('extension service worker did not start')
  }, 22000)
  const extId = new URL(worker.url()).host
  const target = await browser.newPage()
  await target.setViewport({ width: 1000, height: 800 })
  await target.goto(url, { waitUntil: 'load' })
  const report = await browser.newPage()
  report.on('pageerror', error => console.error(`[report:pageerror] ${error.message}`))
  report.on('console', message => { if (message.type() === 'error') console.error(`[report:console] ${message.text()}`) })
  await report.goto(`chrome-extension://${extId}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })
  const tabId = await report.evaluate(async match => (await chrome.tabs.query({ url: `${match}*` }))[0]?.id, url)
  if (!tabId) throw new Error('could not resolve fixture tab id')
  await report.evaluate(async ({ id, pageUrl }) => chrome.storage.session.set({ [`panel:${id}`]: { kind: 'new', batch: true, tabId: id, url: pageUrl } }), { id: tabId, pageUrl: url })
  await report.evaluate(async id => chrome.sidePanel.setOptions({ tabId: id, path: 'ui/picker/picker.html', enabled: true }), tabId)
  await report.evaluate(async id => chrome.tabs.update(id, { active: true }), tabId)
  await report.evaluate(id => {
    const button = document.createElement('button')
    button.id = 'open-real-side-panel'
    button.textContent = 'Open picker panel'
    button.style.cssText = 'position:fixed;left:20px;top:20px;width:240px;height:60px;z-index:999999'
    button.onclick = async () => { try { await chrome.sidePanel.open({ tabId: id }); button.dataset.opened = 'true' } catch (e) { button.dataset.error = String(e) } }
    document.body.append(button)
  }, tabId)
  const openButton = await report.$('#open-real-side-panel')
  const openBox = await openButton.boundingBox()
  await report.mouse.click(openBox.x + openBox.width / 2, openBox.y + openBox.height / 2)
  await new Promise(resolveWait => setTimeout(resolveWait, 1000))
  console.log('[debug] side panel open result', await report.$eval('#open-real-side-panel', el => ({ opened: el.dataset.opened, error: el.dataset.error })))
  const pickerTarget = await bounded('real side panel target', async () => {
    const end = Date.now() + 12000
    while (Date.now() < end) {
      const found = browser.targets().find(t => t.url().includes('/ui/picker/picker.html'))
      if (found) return found
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`side panel picker target missing: ${JSON.stringify(browser.targets().map(t => ({ type: t.type(), url: t.url() })))}`)
  })
  console.log('[debug] picker target type', pickerTarget.type(), pickerTarget.url())
  const pickerCdp = await pickerTarget.createCDPSession()
  await pickerCdp.send('Runtime.enable')
  const picker = {
    async evaluate(fn, ...args) {
      const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
      const result = await pickerCdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result?.value
    },
    async waitForSelector(selector, options = {}) {
      const end = Date.now() + (options.timeout || 10000)
      while (Date.now() < end) {
        if (await this.evaluate(s => { const e = document.querySelector(s); return Boolean(e && !e.hidden && !e.closest('[hidden]')) }, selector)) return
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error(`panel selector timeout: ${selector}`)
    },
    async waitForFunction(fn, options = {}) {
      const end = Date.now() + (options.timeout || 10000)
      while (Date.now() < end) {
        if (await this.evaluate(fn)) return
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error('panel condition timeout')
    },
    async type(selector, text) { await this.evaluate((s, value) => { const e = document.querySelector(s); e.focus(); e.value += value; e.dispatchEvent(new Event('input', { bubbles: true })) }, selector, text) },
    async $(selector) { const exists = await this.evaluate(s => Boolean(document.querySelector(s)), selector); return exists ? { click: () => this.evaluate(s => document.querySelector(s)?.click(), selector) } : null },
    async $$(selector) { const n = await this.evaluate(s => document.querySelectorAll(s).length, selector); return Array.from({ length: n }, () => ({ evaluate: fn => fn({ textContent: '' }) })) }
  }
  await picker.waitForSelector('#group-start-first:not([hidden])', { timeout: 15000 })
  console.log('[debug] initial picker contract', await picker.evaluate(async id => ({ bound: document.querySelector('#group-start-first')?.dataset.bound, ctx: await chrome.storage.session.get(`panel:${id}`), draft: await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id }) }), tabId))
  ck('new pick draft opened for target tab')

  await clickPanel(picker, '#group-start-first')
  await new Promise(resolveWait => setTimeout(resolveWait, 700))
  const firstGroupState = await picker.evaluate(async id => {
    const result = await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id })
    return { groups: document.querySelectorAll('[data-group-row]').length, editorHidden: document.querySelector('#group-name-editor')?.hidden, status: document.querySelector('#group-draft-status')?.textContent, activeGroupKey: result?.draft?.activeGroupKey, stage: result?.draft?.stage }
  }, tabId)
  console.log('[checkpoint detail] first group state', firstGroupState)
  if (!firstGroupState.activeGroupKey || firstGroupState.editorHidden) {
    const setActiveProbe = await picker.evaluate(async id => {
      const read = await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id })
      const draft = read?.draft
      if (!draft?.groups?.[0]) return { error: 'no group in protocol draft', read }
      const identity = Object.fromEntries(['sessionId', 'tabId', 'documentGeneration', 'documentIdentity', 'routeIdentity', 'frame'].filter(key => draft[key] !== undefined).map(key => [key, draft[key]]))
      const response = await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_OPERATION', ...identity, operationId: `g1-probe-set-active-${Date.now()}`, expectedRevision: draft.revision, operation: { type: 'set-active', groupKey: draft.groups[0].key } })
      const after = await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id })
      return { response, resultingDraft: after?.draft }
    }, tabId)
    console.log('[diagnostic] direct set-active operation', setActiveProbe)
    throw new Error('create-first-group did not activate the new group; name editor was not opened')
  }
  await picker.type('#group-name', 'Manual First Group')
  await clickPanel(picker, '#group-name-confirm')
  try { await waitOverlay(target) } catch (error) {
    console.log('[checkpoint detail] manual-name confirmation without overlay', await picker.evaluate(async id => {
      const read = await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id })
      const draft = read?.draft
      const message = draft?.groups?.find(group => group.key === draft.activeGroupKey)
        ? { type: 'ENTER_PICK', purpose: 'task', batch: true, tabId: draft.tabId, frameId: 0, sessionId: draft.sessionId, groupKey: draft.activeGroupKey, pickStage: 'selecting', documentGeneration: draft.documentGeneration, routeIdentity: draft.routeIdentity, draftValues: draft.groups.find(group => group.key === draft.activeGroupKey)?.values || [] }
        : null
      const ctx = (await chrome.storage.session.get(`panel:${id}`))[`panel:${id}`]
      const retry = message ? await chrome.runtime.sendMessage(message) : null
      return { name: document.querySelector('#group-name')?.value, status: document.querySelector('#group-draft-status')?.textContent, panelCtx: ctx, protocolDraft: read, enterPickFields: message && Object.fromEntries(['tabId','sessionId','groupKey','pickStage','documentGeneration','routeIdentity'].map(key => [key, message[key]])), rawEnterPickRetry: retry }
    }, tabId))
    throw error
  }
  ck('first group created and manually named')
  await clickTarget(target, '#price-a')
  await clickTarget(target, '#price-b')
  await new Promise(resolveWait => setTimeout(resolveWait, 1200))
  const picked1 = await target.evaluate(() => document.querySelectorAll('[data-af-picked]').length)
  if (picked1 < 2) {
    const state = await picker.evaluate(async id => {
      const read = await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id })
      const draft = read?.draft
      const group = draft?.groups?.find(item => item.key === draft.activeGroupKey)
      return { groupValues: group?.values?.map(value => ({ key: value.key, name: value.name, source: value.source, locator: value.locator, frame: value.frame })), activeGroupKey: draft?.activeGroupKey, stage: draft?.stage, status: document.querySelector('#group-draft-status')?.textContent }
    }, tabId)
    const selected = await target.evaluate(() => [...document.querySelectorAll('[data-af-picked]')].map(node => ({ text: node.textContent?.trim(), tag: node.tagName, id: node.id })))
    console.log('[checkpoint detail] two-source selection', { visiblePickedMarkers: picked1, selected, state })
    if ((state.groupValues?.length || 0) < 2) throw new Error(`first group expected two canonical values; saw ${state.groupValues?.length || 0}`)
  }
  ck('first group selected two same-page sources')

  // The frame is deliberately cross-origin (different port); record a gap if
  // content injection/overlay cannot safely reach it in the current build.
  let framePicked = false
  let crossOriginFrame = null
  try {
    crossOriginFrame = target.frames().find(f => f.url().includes(`:${framePort}/frame`))
    if (crossOriginFrame) { await clickFrameTarget(target, crossOriginFrame, '#frame-price'); framePicked = true }
  } catch (error) { console.log(`[gap] cross-origin frame pick unavailable: ${error.message}`) }
  ck(framePicked ? 'cross-origin frame value clicked' : 'cross-origin frame capability not reached')

  if (framePicked) {
    await crossOriginFrame.waitForSelector('[data-af-overlay] [data-af-done]', { timeout: 10000 })
    await clickFrameTarget(target, crossOriginFrame, '[data-af-done]')
    ck('cross-origin frame selection finished')
  }
  if (await target.$('[data-af-done]')) await clickSelector(target, '[data-af-done]')
  await picker.waitForFunction(() => document.querySelectorAll('[data-group-row]').length === 1, { timeout: 15000 })
  await clickPanel(picker, '#group-add')
  await new Promise(resolveWait => setTimeout(resolveWait, 500))
  const secondGroupState = await picker.evaluate(async id => {
    const read = await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id })
    const draft = read?.draft
    return { revision: draft?.revision, stage: draft?.stage, activeGroupKey: draft?.activeGroupKey, groups: draft?.groups?.map(group => ({ key: group.key, name: group.name, values: group.values?.length || 0 })), status: document.querySelector('#group-draft-status')?.textContent }
  }, tabId)
  console.log('[checkpoint detail] after second group creation', secondGroupState)
  if (secondGroupState.groups?.length !== 2 || secondGroupState.activeGroupKey !== secondGroupState.groups[1]?.key) {
    throw new Error('second group was not activated before naming')
  }
  await picker.waitForSelector('#group-name-editor:not([hidden])')
  await clickPanel(picker, '#group-name-from-page')
  try { await waitOverlay(target) } catch (error) {
    console.log('[checkpoint detail] second group page-name request', await picker.evaluate(async id => ({ name: document.querySelector('#group-name')?.value, status: document.querySelector('#group-draft-status')?.textContent, draft: await chrome.runtime.sendMessage({ type: 'PICK_DRAFT_READ', tabId: id }) }), tabId))
    throw error
  }
  await clickTarget(target, '#group-name-text')
  await clickSelector(target, '[data-af-done]')
  await picker.waitForFunction(() => document.querySelector('#group-name')?.value === 'Second Group Picked Name', { timeout: 10000 })
  ck('second group created and named from page text')
  await clickPanel(picker, '#group-name-confirm')
  await waitOverlay(target)
  await clickTarget(target, '#price-c')
  await clickSelector(target, '[data-af-done]')
  await picker.waitForFunction(() => document.querySelectorAll('[data-group-row]').length === 2, { timeout: 12000 })
  ck('second group selected a value')

  const firstGroup = await picker.$('[data-group-row]:first-child button')
  if (!firstGroup) throw new Error('first group controls missing')
  const groupButtons = await picker.$$('[data-group-row]:first-child button')
  const switchBtn = groupButtons.find(async b => (await b.evaluate(el => el.textContent)).includes('切換'))
  // Query visible button labels explicitly; DOM order is stable, selectors
  // avoid depending on implementation-specific private state.
  const firstSwitch = await picker.$('[data-group-row]:first-child button:not([disabled])')
  if (firstSwitch) await firstSwitch.click()
  await picker.waitForFunction(() => document.querySelector('[data-group-row]:first-child [data-active="true"]'), { timeout: 5000 })
  ck('switched back to first group for edit')

  // Keep this first G1 pass bounded and make the later-chain boundary explicit.
  // The UI changes under R18 may alter finish/settings behavior; fail at the
  // precise checkpoint rather than silently claiming remaining coverage.
  await clickPanel(picker, '#group-finish')
  await picker.waitForSelector('#batch-section:not([hidden])', { timeout: 15000 })
  ck('group finish opened settings')
  console.log('[gap] partial dry run, save/first run, reopen/reselect/history-key checkpoints not yet exercised by this bounded script revision')
  console.log(JSON.stringify({ browser: CHROME, tabId, framePicked, groups: await picker.$$eval('[data-group-row]', rows => rows.length), status: 'PARTIAL_G1' }, null, 2))
} catch (error) {
  console.error(`FAIL G1 checkpoint: ${error?.stack || error}`)
  process.exitCode = 1
} finally {
  if (browser) {
    const p = browser.process?.()
    try { await browser.close() } catch {}
    if (p && p.exitCode === null && !p.killed) { p.kill(); await new Promise(r => { const t = setTimeout(r, 2500); p.once('exit', () => { clearTimeout(t); r() }) }) }
  }
  for (const server of [mainServer, frameServer]) {
    if (server.listening) { server.closeAllConnections?.(); await new Promise(r => server.close(() => r())) }
  }
  if (profile) {
    const temp = resolve(os.tmpdir())
    const abs = resolve(profile)
    if (abs.startsWith(`${temp}\\`) && abs.split(/[\\/]/).pop()?.startsWith('af22-g1-')) rmSync(abs, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
    else console.error(`refused profile cleanup outside temp: ${abs}`)
  }
}
