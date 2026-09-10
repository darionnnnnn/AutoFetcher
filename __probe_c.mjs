// AF-13：跑過「目標在 iframe 內」的任務之後，下一個任務會不會卡住？
import puppeteer from 'puppeteer-core'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), 'src')

const inner = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  r.end(q.url.startsWith('/b') ? '<!doctype html><div id="iv">7777</div>' : '<!doctype html><div id="iv">5678</div>')
}).listen(48724)
const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  if (q.url.startsWith('/plain')) return r.end('<!doctype html><body><div id="v">1111</div>')
  r.end(`<!doctype html><body>
<a id="navchild" href="#">c</a>
<iframe id="fr" src="http://localhost:48724/inner" style="width:300px;height:100px"></iframe>
<script>document.getElementById('navchild').onclick=()=>{document.getElementById('fr').src='http://localhost:48724/b'}</script>`)
}).listen(48723)

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH, headless: 'new', protocolTimeout: 300000,
  args: [`--disable-extensions-except=${SRC}`, `--load-extension=${SRC}`, '--no-first-run', '--no-default-browser-check']
})
const t = await browser.waitForTarget(x => x.type() === 'service_worker' && x.url().includes('background/main.js'), { timeout: 20000 })
const ext = await browser.newPage()
await ext.goto(`chrome-extension://${new URL(t.url()).host}/ui/report/report.html`, { waitUntil: 'domcontentloaded' })

const run = (task, label) => ext.evaluate(async (t, lb) => {
  await chrome.storage.local.set({ tasks: [t] })
  const t0 = Date.now()
  let res, err = null
  try {
    res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'RUN_TASK', taskId: t.id }),
      new Promise((_, rj) => setTimeout(() => rj(new Error('30 秒沒回')), 30000))
    ])
  } catch (e) { err = String(e.message || e) }
  const tabs = (await chrome.tabs.query({})).map(x => `${x.id}:${x.status}:${String(x.url).slice(-20)}`)
  return { lb, res, err, ms: Date.now() - t0, tabs }
}, task, label)

const base = { mode: 'number', enabled: true, spec: { strategy: 'auto' }, extraDelaySec: 0,
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] } }
const plain = { ...base, id: 'p1', name: 'plain', url: 'http://127.0.0.1:48723/plain',
  locator: { css: '#v', path: '', anchor: null, xpath: '' } }
const child = { ...base, id: 'c1', name: 'child', url: 'http://127.0.0.1:48723/navchild',
  locator: { css: '#iv', path: '', anchor: null, xpath: '' },
  frame: { url: 'http://localhost:48724/b' },
  preActions: [{ type: 'click', locator: { css: '#navchild' } }] }

console.log('1 PLAIN', JSON.stringify(await run(plain, 'p')))
console.log('2 CHILD', JSON.stringify(await run(child, 'c')))
console.log('3 PLAIN', JSON.stringify(await run(plain, 'p')))
await browser.close(); srv.close(); inner.close()
