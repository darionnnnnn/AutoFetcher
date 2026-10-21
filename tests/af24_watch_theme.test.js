// AF-24 F4：常駐面板跟著主題設定即時切換，監聽只掛一次
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

test('設定改成深色：已開著的頁面 data-theme 立刻變；重複呼叫 watchTheme 不累加監聽', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM('<!doctype html><html><body></body></html>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ta = await import('../src/ui/theme-apply.js?t=' + Math.random())
  const before = c.storage.onChanged._listeners?.size ?? [...(c.storage.onChanged._listeners || [])].length
  for (let i = 0; i < 100; i++) ta.watchTheme()
  const after = c.storage.onChanged._listeners?.size ?? [...(c.storage.onChanged._listeners || [])].length
  assert.equal(after - before, 1, '監聽只掛一次')
  await st.saveSettings({ theme: 'dark' })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(jd.window.document.documentElement.getAttribute('data-theme'), 'dark')
  await st.saveSettings({ theme: 'system' })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(jd.window.document.documentElement.hasAttribute('data-theme'), false)
})
