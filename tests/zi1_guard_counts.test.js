// AF-21 批次 9：設定頁「排程健康」列出近 7 天的靜默保護次數（中斷、取鎖逾時、擋下的網頁訊息、背景錯誤）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

test('countGuardEvents：只算 7 天內、依 kind 分類（中斷也從 diag 數）', async () => {
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  resetChromeMock()
  installChromeMock()
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  const now = Date.UTC(2026, 8, 19)
  const old = now - 8 * 86400000
  const diag = [
    { at: now - 1000, kind: 'lock_timeout' }, { at: old, kind: 'lock_timeout' },
    { at: now - 1000, kind: 'forbidden' }, { at: now - 2000, kind: 'forbidden' },
    { at: now - 1000, kind: 'alarm_error' }, { at: now - 1000, kind: 'message_error' }, { at: now - 1000, kind: 'watchdog' },
    { at: now - 1000, kind: 'interrupted' }, { at: now - 2000, kind: 'interrupted' }, { at: old, kind: 'interrupted' }
  ]
  assert.deepEqual(se.countGuardEvents(diag, now), { interrupted: 2, lockTimeout: 1, forbidden: 2, errors: 2 })
  assert.deepEqual(se.countGuardEvents([], now), { interrupted: 0, lockTimeout: 0, forbidden: 0, errors: 0 })
})

test('設定頁畫出近 7 天的保護次數', async () => {
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  // 中斷改成從 diag 數（背景寫 interrupted 紀錄時同時寫一筆 kind:'interrupted' 的 diag）
  await c.storage.local.set({ diag: [
    { at: Date.now() - 1000, kind: 'forbidden', detail: 'x' },
    { at: Date.now() - 1000, kind: 'interrupted', detail: 't1' }
  ] })
  assert.ok(st)
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  await se.renderSettings()
  const text = jd.window.document.getElementById('health-guards').textContent
  assert.match(text, /被瀏覽器中斷 1 次/)
  assert.match(text, /擋下網頁送來的訊息 1 次/)
})
