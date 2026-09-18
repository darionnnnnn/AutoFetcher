// AF-20 探針(不進 npm test、也不進 run_smoke.sh):windows.create 各種參數組合下,焦點、視窗狀態與頁面環境(可見性、viewport、計時器節流)的實測。
// 結論表在 docs/SPEC.md §4;想改專用視窗的建法之前先改這裡的變體重跑。會真的開出有畫面的瀏覽器視窗。
// **一定要拿掉 puppeteer 預設的三個關閉節流旗標**(見下方 ignoreDefaultArgs),否則背景頁面會被量成 visible、計時器照跑。
// 用法(在專案根):BROWSER_PATH=<chrome.exe> node tests/smoke/probe_fetch_window.mjs
import { createRequire } from 'node:module'
import http from 'node:http'
import { resolve } from 'node:path'
const require = createRequire(resolve(process.cwd(), 'package.json'))
const puppeteer = require('puppeteer-core')

const SRC = resolve(process.cwd(), 'src')
const exe = process.env.BROWSER_PATH
const name = exe.includes('msedge') ? 'Edge' : 'Chrome'

// 目標頁:記錄可見性、rAF、IntersectionObserver、延遲渲染
const PAGE = `<!doctype html><title>probe</title><body>
<div style="height:3000px">top</div><table id="tb"><tr><th>A</th><td>123</td></tr></table><div id="lazy">lazy</div>
<script>
window.__p = { vis0: document.visibilityState, raf: 0, io: false, timers: 0, late: null, t0: Date.now() }
const tick = () => { __p.raf++; requestAnimationFrame(tick) }; requestAnimationFrame(tick)
new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) __p.io = true }).observe(document.getElementById('lazy'))
setInterval(() => { __p.timers++ }, 100)
setTimeout(() => { __p.late = Date.now() - __p.t0 }, 1500)
</script>`
const server = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(PAGE) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${server.address().port}/`

let browser
try {
  browser = await puppeteer.launch({
    executablePath: exe, headless: false, defaultViewport: null,
    ignoreDefaultArgs: ['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
    args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
  })
  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background/main.js'), { timeout: 20000 })
  const extId = new URL(target.url()).host
  const ext = await browser.newPage()
  await ext.goto(`chrome-extension://${extId}/ui/help/help.html`, { waitUntil: 'domcontentloaded' })
  await ext.bringToFront()
  await new Promise(r => setTimeout(r, 1000))

  const out = await ext.evaluate(async (url) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const res = {}
    const me = await chrome.windows.getCurrent()
    const focusLog = []
    chrome.windows.onFocusChanged.addListener(id => focusLog.push({ t: Date.now(), id }))
    // 取樣本頁焦點:有沒有哪一瞬間被搶走
    let lost = 0, samples = 0
    const sampler = setInterval(() => { samples++; if (!document.hasFocus()) lost++ }, 25)

    const readPage = async (tabId) => {
      // 等載入
      for (let i = 0; i < 80; i++) { const t = await chrome.tabs.get(tabId); if (t.status === 'complete') break; await sleep(100) }
      await sleep(2500)
      const before = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => ({ ...window.__p, visNow: document.visibilityState, cellText: document.querySelector('#tb td').textContent, cellInner: document.querySelector('#tb td').innerText, mq: matchMedia('(max-width: 600px)').matches, hasFocus: document.hasFocus(), w: innerWidth, h: innerHeight }) }))[0].result
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => document.getElementById('lazy').scrollIntoView({ block: 'center' }) })
      await sleep(1500)
      const after = (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => ({ io: window.__p.io, raf: window.__p.raf, timers: window.__p.timers, scrollY: window.scrollY }) }))[0].result
      return { before, after }
    }
    const variant = async (label, createOpts) => {
      const r = { opts: createOpts }
      const f0 = focusLog.length, l0 = lost, s0 = samples
      try {
        const t0 = Date.now()
        const win = await chrome.windows.create({ url, ...createOpts })
        r.createMs = Date.now() - t0
        r.returned = { state: win.state, focused: win.focused, type: win.type }
        await sleep(600)
        const again = await chrome.windows.get(win.id)
        r.after600 = { state: again.state, focused: again.focused }
        r.meFocused = (await chrome.windows.get(me.id)).focused
        r.page = await readPage(win.tabs[0].id)
        // 同一個視窗再開第二個分頁(同站台佇列共用視窗)
        const t2 = await chrome.tabs.create({ windowId: win.id, url, active: false })
        await sleep(800)
        r.secondTab = { ok: true, winState: (await chrome.windows.get(win.id)).state, meFocused: (await chrome.windows.get(me.id)).focused }
        await chrome.tabs.remove(t2.id)
        await chrome.windows.remove(win.id)
        await sleep(500)
        r.afterRemove = { meFocused: (await chrome.windows.get(me.id)).focused, docHasFocus: document.hasFocus() }
      } catch (e) { r.error = String(e?.message || e) }
      r.focusEvents = focusLog.slice(f0).map(e => e.id === me.id ? 'me' : e.id === -1 ? 'NONE' : 'other')
      r.focusLostSamples = `${lost - l0}/${samples - s0}`
      res[label] = r
    }

    res.meFocusedAtStart = me.focused
    res.docHasFocusAtStart = document.hasFocus()
    // 對照組:同視窗背景分頁(現況)
    {
      const t = await chrome.tabs.create({ url, active: false })
      res.baseline_bgTab = await readPage(t.id)
      await chrome.tabs.remove(t.id)
    }
    await variant('minimized', { state: 'minimized' })
    await variant('minimized_focusedFalse', { state: 'minimized', focused: false })
    await variant('minimized_popup', { state: 'minimized', type: 'popup' })
    await variant('normal_focusedFalse', { focused: false, width: 800, height: 600 })
    await variant('offscreen_pos', { focused: false, left: -2000, top: 0, width: 800, height: 600 })
    // 採用的做法:先不聚焦帶尺寸建立、再最小化;之後導覽、以及在已最小化的視窗裡再開分頁
    {
      const r = {}
      const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 800 })
      await chrome.windows.update(win.id, { state: 'minimized' })
      await sleep(600)
      r.state = (await chrome.windows.get(win.id)).state
      r.meFocused = (await chrome.windows.get(me.id)).focused
      r.page = await readPage(win.tabs[0].id)
      await chrome.tabs.update(win.tabs[0].id, { url: url + '?nav=1' }); await sleep(300)
      r.page_navigated = await readPage(win.tabs[0].id)
      const t2 = await chrome.tabs.create({ windowId: win.id, url, active: false })
      r.page_newBgTabInMinimized = await readPage(t2.id)
      const t3 = await chrome.tabs.create({ windowId: win.id, url, active: true })
      r.page_newActiveTabInMinimized = await readPage(t3.id)
      const t4 = await chrome.tabs.create({ windowId: win.id, url, active: false })
      r.page_newBgTabAfterActive = await readPage(t4.id)
      r.page_firstTabAfterActive = await readPage(win.tabs[0].id)
      await chrome.windows.remove(win.id)
      res.create_then_minimize = r
    }
    // 直接最小化之後再改尺寸、重載、導覽:viewport 救不救得回來
    {
      const r = {}
      const f0 = focusLog.length, l0 = lost, s0 = samples
      const win = await chrome.windows.create({ url, state: 'minimized' })
      const tabId = win.tabs[0].id
      r.p1_directMin = await readPage(tabId)
      try {
        const u = await chrome.windows.update(win.id, { width: 1280, height: 800 })
        r.afterResize = { state: u.state, w: u.width, h: u.height, focused: u.focused }
      } catch (e) { r.resizeError = String(e?.message || e) }
      await sleep(500)
      r.stateAfterResize = (await chrome.windows.get(win.id)).state
      r.meFocusedAfterResize = (await chrome.windows.get(me.id)).focused
      r.p2_afterResize = await readPage(tabId)
      await chrome.tabs.reload(tabId); await sleep(300)
      r.p3_afterReload = await readPage(tabId)
      await chrome.tabs.update(tabId, { url: url + '?n=2' }); await sleep(300)
      r.p4_afterNavigate = await readPage(tabId)
      await chrome.windows.remove(win.id)
      await sleep(400)
      r.afterRemove = { meFocused: (await chrome.windows.get(me.id)).focused, docHasFocus: document.hasFocus() }
      r.focusEvents = focusLog.slice(f0).map(e => e.id === me.id ? 'me' : e.id === -1 ? 'NONE' : 'other')
      r.focusLostSamples = `${lost - l0}/${samples - s0}`
      res.directMin_then_resize = r
    }
    clearInterval(sampler)
    return res
  }, URL_)
  console.log(`=== ${name} ===`)
  console.log(JSON.stringify(out, null, 1))
} catch (e) {
  console.log(`${name} 探針失敗:`, e?.message || e)
} finally {
  try { await browser?.close() } catch {}
  server.close()
}
