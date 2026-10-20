process.env.TZ = 'Asia/Taipei'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const qaSrc = resolve(process.env.AF23_QA_SRC || new URL('../src', import.meta.url).pathname)
const reportHtml = readFileSync(join(qaSrc, 'ui/report/report.html'), 'utf8')
const taipei = local => Date.parse(`${local}+08:00`)

async function mountReport() {
  resetChromeMock()
  const chrome = installChromeMock()
  // Avoid the module's automatic page startup; this test calls the same
  // route initializer with an explicitly controlled clock.
  chrome.runtime.id = undefined
  const dom = new JSDOM(reportHtml, { url: 'chrome-extension://af23-test/ui/report/report.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const reportUrl = `${pathToFileURL(join(qaSrc, 'ui/report/report.js')).href}?af23-midnight=${Math.random()}`
  const report = await import(reportUrl)
  return { dom, report }
}

test('AC-D3:新開無日期報表在台北跨午夜後預設今天；明確絕對日期不跳日', async t => {
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  const { dom, report } = await mountReport()
  t.after(() => dom.window.close())

  Date.now = () => taipei('2026-10-20T23:59:50')
  report.initFromHash('')
  assert.equal(report.getState().from, '2026-10-20')
  assert.equal(report.getState().to, '2026-10-20')

  // A newly opened report after midnight must derive a fresh default.
  Date.now = () => taipei('2026-10-21T00:00:10')
  report.initFromHash('')
  assert.equal(report.getState().from, '2026-10-21')
  assert.equal(report.getState().to, '2026-10-21')

  // Explicit URL dates represent a fixed user selection, even when the
  // clock advances and route state is initialized again.
  report.initFromHash('#view=history&from=2026-10-20&to=2026-10-20')
  Date.now = () => taipei('2026-10-22T12:00:00')
  report.initFromHash('#view=history&from=2026-10-20&to=2026-10-20')
  assert.equal(report.getState().from, '2026-10-20')
  assert.equal(report.getState().to, '2026-10-20')
  assert.equal(dom.window.document.getElementById('range-from').value, '2026-10-20')
  assert.equal(dom.window.document.getElementById('range-to').value, '2026-10-20')
})
