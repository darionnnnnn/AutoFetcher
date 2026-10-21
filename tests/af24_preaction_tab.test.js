// AF-24 B7 同型：Picker 前置動作的「在頁面上選取」只收自己分頁的結果
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function setup() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  const doc = jd.window.document
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', tabId: 3 })
  doc.getElementById('preaction-add')?.click()
  const row = doc.querySelector('[data-preaction-row]')
  row.querySelector('[data-action="preaction-pick"]')?.click()
  await new Promise(r => setTimeout(r, 5))
  const send = async (msg, sender = {}) => {
    for (const fn of c.runtime.onMessage._listeners) fn(msg, sender, () => {})
    await new Promise(r => setTimeout(r, 5))
  }
  return { row, send }
}

test('別的分頁轉發來的前置動作選取不寫進這個面板', async () => {
  const { row, send } = await setup()
  await send({ type: 'PICKED', purpose: 'preaction', locator: { css: '#other' }, sourceTabId: 99 })
  assert.equal(row._locator ?? null, null)
  await send({ type: 'PICKED', purpose: 'preaction', locator: { css: '#mine' }, sourceTabId: 3 })
  assert.deepEqual(row._locator, { css: '#mine' })
})
