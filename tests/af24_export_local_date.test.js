// AF-24 B5：匯出預設日期取本地的今天（台灣早上 8 點前 UTC 還是昨天）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
// 2026-10-21 23:30 UTC = 2026-10-22 07:30 台北
const FIXED = Date.parse('2026-10-21T23:30:00Z')

test('設定頁開啟時，匯出起訖預設為本地今天', async (t) => {
  t.mock.method(Date, 'now', () => FIXED)
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  // 歷史頁的範圍欄位留空，才會落到「今天」
  for (const id of ['range-from', 'range-to']) { const el = jd.window.document.getElementById(id); if (el) el.value = '' }
  await se.renderSettings()
  assert.equal(jd.window.document.getElementById('export-from').value, '2026-10-22')
  assert.equal(jd.window.document.getElementById('export-to').value, '2026-10-22')
})

test('export.js 的 HTML 報表「今天」退路也是本地日期', async (t) => {
  t.mock.method(Date, 'now', () => FIXED)
  const src = readFileSync(new URL('../src/shared/export.js', import.meta.url), 'utf8')
  assert.equal(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(src), false)
  const set = readFileSync(new URL('../src/ui/report/settings.js', import.meta.url), 'utf8')
  assert.equal(/toISOString\(\)\.slice\(0, 10\)/.test(set), false)
})
