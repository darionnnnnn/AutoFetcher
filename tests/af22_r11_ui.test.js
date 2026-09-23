process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const popupHtml = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
const partial = { ok: true, outcome: 'partial', values: [
  { name: '價格', ok: true, value: 12 }, { name: '標籤', ok: false, error: '抓不到數值' }
] }

test('R11 任務頁明確顯示部分失敗與失敗值名', async () => {
  resetChromeMock()
  const c = installChromeMock()
  c.__setRuntimeResponder(() => partial)
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(reportHtml, { url: 'chrome-extension://abc/ui/report/report.html' })
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const tasks = await import('../src/ui/report/tasks.js?t=' + Math.random())
  const task = { id: 'r11', name: '多值', url: 'https://a.test/p', mode: 'multi', enabled: true,
    fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }],
    schedule: { type: 'daily', times: ['09:00'] } }
  tasks.renderTasks([task], {}, [])
  document.querySelector('[data-task-id="r11"] [data-action="run"]').click()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.match(document.querySelector('[data-task-id="r11"] .task-run-result').textContent, /部分失敗.*標籤/)
})

test('R11 popup 明確顯示部分失敗與失敗值名', async () => {
  resetChromeMock()
  const c = installChromeMock()
  c.__setRuntimeResponder(() => partial)
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(popupHtml)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const popup = await import('../src/ui/popup/popup.js?t=' + Math.random())
  const task = { id: 'r11', name: '多值', url: 'https://a.test/p', mode: 'multi', enabled: true,
    schedule: { type: 'daily', times: ['09:00'] } }
  popup.render({ health: { level: 'red', redCount: 1, yellowCount: 0, summary: '' }, tasks: [task],
    lastValues: {}, nextRuns: {}, healthMap: { r11: { status: 'failed' } } })
  document.querySelector('#task-list .retry').click()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.match(document.querySelector('#task-list .task-run-result').textContent, /部分失敗.*標籤/)
})
