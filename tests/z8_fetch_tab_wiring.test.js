// AF-20 作業 A4:看門狗清孤兒、設定頁「抓取頁面開在哪裡」、慣例守門
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const callsOf = (c, api) => c.__calls.filter(x => x.api === api)

// ---- 看門狗 ----

test('看門狗每輪清一次上一個 service worker 留下的抓取視窗', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  c.__setWindows([{ id: 1, state: 'normal' }, { id: 50, state: 'minimized' }])
  await c.storage.session.set({ fetchTabs: [{ windowId: 50, tabId: 51, boot: 'old-boot' }] })
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  await wd.runWatchdog()
  assert.deepEqual(callsOf(c, 'windows.remove').map(x => x.args[0]), [50])
  assert.deepEqual((await c.storage.session.get('fetchTabs')).fetchTabs, [])
})

test('看門狗:孤兒清理丟例外不影響其餘巡檢項目', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const origGet = c.storage.session.get
  c.storage.session.get = async (k) => {
    if (k === 'fetchTabs') throw new Error('boom')
    return origGet(k)
  }
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  try {
    await wd.runWatchdog()
  } finally {
    c.storage.session.get = origGet
  }
  const diagList = (await c.storage.local.get('diag')).diag || []
  assert.ok(diagList.some(e => e.kind === 'watchdog'), '巡檢完成的紀錄照樣要寫')
})

// ---- 設定頁 ----

async function freshSettings(settings) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  if (settings) await st.saveSettings(settings)
  const jd = new JSDOM(reportHtml, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  return { c, st, se, doc: jd.window.document, win: jd.window }
}

test('設定頁有「抓取頁面開在哪裡」:兩個選項,預設顯示專用視窗', async () => {
  const { se, doc } = await freshSettings()
  await se.renderSettings()
  const el = doc.getElementById('pref-fetch-tab-mode')
  assert.ok(el, '要有 #pref-fetch-tab-mode')
  assert.deepEqual([...el.options].map(o => o.value), ['window', 'tab'])
  assert.equal(el.value, 'window')
  const label = doc.querySelector('label[for="pref-fetch-tab-mode"]')
  assert.ok(label && label.textContent.trim().length > 0, '要有標籤')
})

test('設定頁回填既有值,改了立即寫入', async () => {
  const { se, st, doc, win } = await freshSettings({ fetchTabMode: 'tab' })
  await se.renderSettings()
  const el = doc.getElementById('pref-fetch-tab-mode')
  assert.equal(el.value, 'tab')
  el.value = 'window'
  el.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await st.getSettings()).fetchTabMode, 'window')
})

test('連續 render 兩次不重複綁定(改一次只寫一次)', async () => {
  const { c, se, doc, win } = await freshSettings()
  await se.renderSettings()
  await se.renderSettings()
  const before = callsOf(c, 'storage.local.set').length
  const el = doc.getElementById('pref-fetch-tab-mode')
  el.value = 'tab'
  el.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  const writes = callsOf(c, 'storage.local.set').slice(before).filter(x => x.args[0]?.settings?.fetchTabMode === 'tab')
  assert.equal(writes.length, 1)
})

// ---- 慣例守門 ----

const stripComments = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
const bgDir = new URL('../src/background/', import.meta.url)
const bgFiles = readdirSync(bgDir).filter(f => f.endsWith('.js'))

test('D15 守門:background 只有 fetch-tab.js 建視窗(抓取頁面的唯一入口)', () => {
  assert.ok(bgFiles.length > 5, '前提:有掃到檔案')
  const hits = bgFiles.filter(f => /chrome\.windows\.create\s*\(/.test(stripComments(readFileSync(new URL(f, bgDir), 'utf8'))))
  assert.deepEqual(hits, ['fetch-tab.js'])
})

test('D15 守門:抓取路徑(fetcher／sitecheck／precheck／missed／login)不自己開分頁、不用網址找分頁', () => {
  const targets = ['fetcher.js', 'sitecheck.js', 'precheck.js', 'missed.js', 'login.js']
  for (const f of targets) assert.ok(bgFiles.includes(f), `前提:${f} 存在`)
  for (const f of targets) {
    const src = stripComments(readFileSync(new URL(f, bgDir), 'utf8'))
    assert.equal(/chrome\.tabs\.create\s*\(/.test(src), false, `${f} 不得 tabs.create`)
    assert.equal(/chrome\.tabs\.query\s*\(\s*\{\s*url/.test(src), false, `${f} 不得用網址查分頁`)
  }
})
