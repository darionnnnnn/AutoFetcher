// AF-18 批次 E：使用教學頁的「看得懂」契約（可機器檢查的寫法規則）與入口、主題。
// 對照 docs/AF-18-PLAN.md 批次 E 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const SRC = new URL('../src/', import.meta.url)
const HELP_HTML = readFileSync(new URL('ui/help/help.html', SRC), 'utf8')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const helpDoc = () => new JSDOM(HELP_HTML).window.document
const len = (s) => [...s.replace(/\s+/g, '')].length

// 主畫面不得出現的內部名詞（摺疊區「遇到這些狀況」裡可以）
const BANNED = ['locator', 'inner', 'block', 'spec', 'preselect', 'frame', 'iframe', '聚合', '定位器', '子路徑', '規格']

// ---------- 寫法契約 ----------

test('E-1 每一節：一句目的（≤40 字）、1～5 步（每步 ≤40 字）、恰一張示意圖、一個預設收合的「遇到這些狀況」', () => {
  const doc = helpDoc()
  const sections = [...doc.querySelectorAll('[data-help-section]')]
  assert.ok(sections.length >= 11, `章節數 ${sections.length}`)
  for (const s of sections) {
    const id = s.id
    assert.ok(id, '每一節要有 id（目錄與錨點）')
    const purposes = s.querySelectorAll('[data-help-purpose]')
    assert.equal(purposes.length, 1, `${id} 目的句`)
    assert.ok(len(purposes[0].textContent) <= 40, `${id} 目的句太長：${purposes[0].textContent}`)
    const steps = [...s.querySelectorAll('[data-help-steps] > li')]
    assert.ok(steps.length >= 1 && steps.length <= 5, `${id} 步驟數 ${steps.length}`)
    for (const li of steps) assert.ok(len(li.textContent) <= 40, `${id} 步驟太長（${len(li.textContent)} 字）：${li.textContent.trim()}`)
    assert.equal(s.querySelectorAll('[data-help-figure]').length, 1, `${id} 示意圖`)
    const more = s.querySelectorAll('details[data-help-more]')
    assert.equal(more.length, 1, `${id} 摺疊區`)
    assert.equal(more[0].open, false, `${id} 摺疊區預設收合`)
  }
})

test('E-2 主畫面（摺疊區以外）不出現內部名詞', () => {
  const doc = helpDoc()
  for (const d of doc.querySelectorAll('details[data-help-more]')) d.remove()
  for (const el of doc.querySelectorAll('style, script')) el.remove()
  const text = doc.body.textContent
  assert.ok(text.length > 500, '前置：掃得到內容')
  for (const w of BANNED) assert.ok(!text.includes(w), `主畫面出現「${w}」`)
})

test('E-3 教學提到的按鈕與選單名稱，文字必須與程式裡的實際字串一致', () => {
  const doc = helpDoc()
  const labels = [...doc.querySelectorAll('[data-ui-label]')]
  assert.ok(labels.length >= 20, `前置：掃得到標籤（${labels.length}）`)
  for (const el of labels) {
    const file = el.getAttribute('data-ui-label')
    const path = new URL(file, SRC)
    assert.ok(existsSync(path), `標籤指到不存在的檔案：${file}`)
    const text = el.textContent.trim()
    assert.ok(readFileSync(path, 'utf8').includes(text), `「${text}」不在 ${file} 裡（介面改名時要同步教學頁）`)
  }
})

test('E-4 首屏三步開始、這一版改了什麼；目錄每個連結都對得到章節', () => {
  const doc = helpDoc()
  assert.equal(doc.querySelectorAll('[data-help-quick] > li').length, 3)
  assert.match(doc.body.textContent, /這一版改了什麼/)
  const ids = new Set([...doc.querySelectorAll('[data-help-section]')].map(s => s.id))
  const links = [...doc.querySelectorAll('[data-help-toc] a')]
  assert.ok(links.length >= 11)
  for (const a of links) assert.ok(ids.has(a.getAttribute('href').slice(1)), `目錄連結對不到章節：${a.getAttribute('href')}`)
  for (const id of ids) assert.ok(links.some(a => a.getAttribute('href') === `#${id}`), `章節 ${id} 不在目錄`)
})

test('E-5 頁面規矩：沒有行內 script、沒有外部資源、零色碼、有 [hidden] 規則、載入主題', () => {
  const doc = helpDoc()
  for (const s of doc.querySelectorAll('script')) {
    assert.ok(s.getAttribute('src'), 'MV3 擴充功能頁不得有行內 script')
    assert.ok(!/^https?:/.test(s.getAttribute('src')))
  }
  for (const l of doc.querySelectorAll('link[href]')) assert.ok(!/^https?:/.test(l.getAttribute('href')), '不得載外部資源')
  const style = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
  assert.ok(style.length > 200, '前置：掃得到樣式')
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/, '顏色一律走 theme.css 變數')
  assert.doesNotMatch(style, /rgba?\(/)
  assert.match(style, /\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  assert.ok(existsSync(new URL('ui/help/help.js', SRC)), '要有 help.js')
  assert.match(readFileSync(new URL('ui/help/help.js', SRC), 'utf8'), /applySavedTheme/)
})

// ---------- 右鍵入口與設定開關 ----------

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}
// 最後一次 removeAll 之後建的選單項目
const menuIds = (c) => {
  const calls = c.__calls
  let last = -1
  calls.forEach((x, i) => { if (x.api === 'contextMenus.removeAll') last = i })
  return calls.slice(last + 1).filter(x => x.api === 'contextMenus.create').map(x => x.args[0].id)
}

test('E-6 右鍵「使用教學」：設定缺省＝顯示，只有明確 false 才隱藏；排在最後', async () => {
  const { c, st, bg } = await freshBg()
  await bg.setupContextMenus()
  let ids = menuIds(c)
  assert.equal(ids[ids.length - 1], 'af-open-help', `缺省要顯示（舊使用者升級後不能消失）：${ids}`)
  const title = c.__calls.filter(x => x.api === 'contextMenus.create').map(x => x.args[0]).find(o => o.id === 'af-open-help')?.title
  assert.equal(title, '使用教學')
  await st.saveSettings({ showHelpMenu: false })
  await bg.setupContextMenus()
  assert.ok(!menuIds(c).includes('af-open-help'))
  await st.saveSettings({ showHelpMenu: true })
  await bg.setupContextMenus()
  assert.ok(menuIds(c).includes('af-open-help'))
})

test('E-7 點「使用教學」開新分頁到教學頁', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-open-help', frameId: 0 }, tab)
  const created = c.__calls.filter(x => x.api === 'tabs.create').map(x => x.args[0]).find(o => /ui\/help\/help\.html$/.test(o?.url || ''))
  assert.ok(created, '要開 ui/help/help.html')
})

test('E-8 任何途徑改到設定（設定頁、匯入），選單當場跟上；連續切換不重複、不缺項', async () => {
  const { c, st } = await freshBg()
  await st.saveSettings({ showHelpMenu: false })
  await sleep(150)
  assert.ok(!menuIds(c).includes('af-open-help'), '改設定後選單要重建（不必重新載入擴充功能）')
  await st.saveSettings({ showHelpMenu: true })
  await st.saveSettings({ showHelpMenu: false })
  await st.saveSettings({ showHelpMenu: true })
  await sleep(200)
  const ids = menuIds(c)
  assert.equal(ids.filter(x => x === 'af-open-help').length, 1, `連續切換後恰好一項：${ids}`)
  assert.equal(new Set(ids).size, ids.length, `不得有重複 id：${ids}`)
  assert.ok(ids.includes('af-pick') && ids.includes('af-pick-batch'), '其他項目不得缺')

  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  const exported = await io.exportSettings()
  const json = typeof exported === 'string' ? JSON.parse(exported) : exported
  // 匯出格式是 { kind, version, exportedAt, data }，設定在 data.settings（settings-io 只讀那裡）
  json.data.settings = { ...(json.data?.settings || {}), showHelpMenu: false }
  await io.importSettings(typeof exported === 'string' ? JSON.stringify(json) : json)
  await sleep(200)
  assert.ok(!menuIds(c).includes('af-open-help'), '匯入設定檔也要跟上')
})

test('E-9 設定頁：開關缺省是勾選；取消勾選寫入 false；旁邊固定有開啟教學的連結', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('ui/report/report.html', SRC), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  await se.renderSettings()
  const doc = jd.window.document
  const box = doc.getElementById('pref-help-menu')
  assert.ok(box, '要有開關')
  assert.equal(box.checked, true, '缺省＝顯示')
  box.checked = false
  box.dispatchEvent(new jd.window.Event('change', { bubbles: true }))
  await sleep(20)
  assert.equal((await st.getSettings()).showHelpMenu, false)
  const link = doc.getElementById('open-help')
  assert.ok(link, '關掉之後仍要找得到教學')
  assert.match(link.getAttribute('href') || '', /help\/help\.html$/)
  // 整個設定頁籤預設藏著、切到設定才打開：只要求連結不被「開關」這一列或更內層藏起來
  doc.getElementById('panel-settings').hidden = false
  assert.equal(link.closest('[hidden]'), null, '開關關掉時連結也不得藏起來')
})

// ---------- 主題設定四頁共用 ----------

test('E-10 applyTheme 全站只有一份；Picker、站台設定、popup、教學頁都套用使用者的主題設定', () => {
  const walk = (dir) => readdirSync(dir).flatMap(n => {
    const p = new URL(n + (statSync(new URL(n, dir)).isDirectory() ? '/' : ''), dir)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
  const js = walk(SRC).filter(p => p.pathname.endsWith('.js'))
  assert.ok(js.length > 30, '前置：掃得到原始碼')
  const defs = js.filter(p => /export (async )?function applyTheme\b|function applyTheme\b/.test(readFileSync(p, 'utf8')))
  assert.equal(defs.length, 1, `applyTheme 定義只能有一份：${defs.map(p => p.pathname.split('/src/')[1])}`)
  for (const f of ['ui/picker/picker.js', 'ui/site/site.js', 'ui/popup/popup.js', 'ui/help/help.js', 'ui/report/report.js']) {
    assert.match(readFileSync(new URL(f, SRC), 'utf8'), /applySavedTheme\(|applyTheme\(/, `${f} 要套用主題設定`)
  }
})

test('E-11 applySavedTheme：設定是 dark → <html data-theme="dark">；system → 不帶屬性；讀不到設定不拋錯', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM('<!doctype html><html><body></body></html>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const th = await import('../src/ui/theme-apply.js?t=' + Math.random())
  await st.saveSettings({ theme: 'dark' })
  await th.applySavedTheme()
  assert.equal(jd.window.document.documentElement.getAttribute('data-theme'), 'dark')
  await st.saveSettings({ theme: 'system' })
  await th.applySavedTheme()
  assert.equal(jd.window.document.documentElement.hasAttribute('data-theme'), false)
  const realGet = chrome.storage.local.get
  chrome.storage.local.get = async () => { throw new Error('boom') }
  await th.applySavedTheme()
  chrome.storage.local.get = realGet
})
