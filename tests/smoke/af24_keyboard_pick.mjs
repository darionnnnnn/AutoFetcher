// AF-24 D-b：真實 Chrome 裡只用鍵盤完成一次選取——數字鍵切模式、Tab 走到「完成」、Enter 送出。
// jsdom 沒有真實焦點移動，Tab 會不會被頁面或 overlay 吃掉只有真實瀏覽器答得出來。
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findBrowser, ROOT } from './browser-path.mjs'

const profile = mkdtempSync(join(tmpdir(), 'af24-keyboard-'))
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><title>Keyboard fixture</title>
  <table id="t"><thead><tr><th>幣別</th><th>買入</th></tr></thead>
  <tbody><tr><td>美金</td><td id="a1">31.2</td></tr><tr><td>日圓</td><td id="b1">0.21</td></tr></tbody></table>`)
})
let browser
try {
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r) })
  const url = `http://127.0.0.1:${server.address().port}/`
  browser = await puppeteer.launch({ executablePath: findBrowser(), headless: process.env.AF23_HEADLESS === '1', userDataDir: profile,
    args: [`--disable-extensions-except=${resolve(ROOT, 'src')}`, `--load-extension=${resolve(ROOT, 'src')}`, '--no-first-run', '--no-default-browser-check'] })
  const worker = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background/main.js'))
  const ext = new URL(worker.url()).host
  const control = await browser.newPage()
  await control.goto(`chrome-extension://${ext}/ui/report/report.html#view=settings`)
  const source = await browser.newPage()
  await source.goto(url, { waitUntil: 'load' })
  const tabId = await control.evaluate(async u => (await chrome.tabs.query({ url: u })).at(-1).id, url)
  const enter = await control.evaluate(async id => chrome.runtime.sendMessage({ type: 'ENTER_PICK', purpose: 'task', tabId: id, frameId: 0 }), tabId)
  assert.equal(enter.ok, true, JSON.stringify(enter))
  await source.bringToFront()
  await source.waitForSelector('[data-af-done]', { visible: true })

  // 滑鼠只用來停在表格上（指出目標）；其餘全部用鍵盤
  const box = await (await source.$('#a1')).boundingBox()
  await source.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await source.keyboard.press('2')
  const active = await source.$eval('[data-af-tool][data-af-active]', el => el.getAttribute('data-af-tool'))
  assert.equal(active, 'col', '數字鍵 2 切到整欄')
  await source.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await source.waitForFunction(() => document.querySelectorAll('[data-af-chip]').length > 0)

  // Tab 走到「完成」：最多按 40 下，每下確認焦點有在移動（沒被攔下）
  let reached = false
  let moved = 0
  let last = null
  for (let i = 0; i < 40; i++) {
    await source.keyboard.press('Tab')
    const now = await source.evaluate(() => {
      const el = document.activeElement
      return el ? (el.getAttribute('data-af-done') !== null ? 'DONE' : `${el.tagName}#${el.id}:${el.textContent?.slice(0, 12)}`) : null
    })
    if (now !== last) moved++
    last = now
    if (now === 'DONE') { reached = true; break }
  }
  assert.ok(moved > 0, 'Tab 有移動焦點')
  assert.ok(reached, `用 Tab 走得到「完成」，最後焦點在 ${last}`)
  await source.keyboard.press('Enter')
  // 送出後選取 overlay 收掉、面板 ctx 收到這次的選取
  await source.waitForFunction(() => !document.querySelector('[data-af-done]'), { timeout: 5000 })
  const ctx = await control.evaluate(async id => (await chrome.storage.session.get(`panel:${id}`))[`panel:${id}`], tabId)
  const picked = ctx?.ctx
  assert.equal(picked?.blockInfo?.axis, 'col', `面板要收到整欄的選取結果：${JSON.stringify(ctx)?.slice(0, 200)}`)
  assert.equal(picked?.locator?.css, '#t')
  console.log({ status: 'PASS', tabPresses: moved, mode: active })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.closeAllConnections?.()
  if (server.listening) await new Promise(r => server.close(r))
  rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
}
