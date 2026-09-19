// AF-21 段 8-B：Report 與 popup 的版面層級、圖示 SVG 化、鍵盤可達
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const popupHtml = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
const SRC_UI = fileURLToPath(new URL('../src/ui/', import.meta.url))

async function freshReport() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(reportHtml, { url: 'https://x.test/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  return { c, st, rp, doc: jd.window.document, win: jd.window }
}

async function freshPopup() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(popupHtml)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  return { c, st, pp, doc: jd.window.document }
}

const flush = () => new Promise(r => setTimeout(r, 20))
const key = (win, el, k) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

// 只有圖示的按鈕（沒有可見文字）一律要有 aria-label
function assertIconButtonsLabelled(root, where) {
  const buttons = [...root.querySelectorAll('button')]
  const iconOnly = buttons.filter(b => b.textContent.trim() === '' && b.querySelector('svg'))
  for (const b of iconOnly) {
    assert.ok((b.getAttribute('aria-label') || '').trim(), `${where}：只有圖示的按鈕要有 aria-label（${b.outerHTML.slice(0, 80)}）`)
  }
  return iconOnly.length
}

// ---------- 頁籤 ----------

test('頁籤：tablist／tab／aria-controls 指向存在的 tabpanel', async () => {
  const { doc } = await freshReport()
  const list = doc.querySelector('[role="tablist"]')
  assert.ok(list, '要有 role=tablist')
  const tabs = [...list.querySelectorAll('[role="tab"]')]
  assert.deepEqual(tabs.map(t => t.id), ['tab-dashboard', 'tab-history', 'tab-tasks', 'tab-settings'])
  for (const t of tabs) {
    const panel = doc.getElementById(t.getAttribute('aria-controls'))
    assert.ok(panel, `${t.id} 的 aria-controls 要指向存在的面板`)
    assert.equal(panel.getAttribute('role'), 'tabpanel')
    assert.equal(panel.getAttribute('aria-labelledby'), t.id)
  }
})

test('頁籤：showTab 後只有目前那一頁 aria-selected=true，且只有它 tabIndex=0', async () => {
  const { rp, doc } = await freshReport()
  rp.showTab('history')
  const sel = [...doc.querySelectorAll('[role="tab"]')].map(t => [t.id, t.getAttribute('aria-selected'), t.tabIndex])
  assert.deepEqual(sel, [
    ['tab-dashboard', 'false', -1], ['tab-history', 'true', 0], ['tab-tasks', 'false', -1], ['tab-settings', 'false', -1]
  ])
  rp.showTab('dashboard')
  assert.equal(doc.getElementById('tab-dashboard').getAttribute('aria-selected'), 'true')
  assert.equal(doc.getElementById('tab-history').getAttribute('aria-selected'), 'false')
  assert.equal(doc.getElementById('panel-history').hidden, true)
})

test('頁籤：← → 方向鍵在頁籤間移動（切頁、移焦點、兩端繞回），滑鼠點擊照舊', async () => {
  const { rp, doc, win } = await freshReport()
  rp.setupTabs()
  rp.showTab('dashboard')
  key(win, doc.getElementById('tab-dashboard'), 'ArrowRight')
  assert.equal(rp.getState().view, 'history')
  assert.equal(doc.getElementById('tab-history').getAttribute('aria-selected'), 'true')
  assert.equal(doc.activeElement?.id, 'tab-history', '焦點跟著移到新頁籤')
  assert.equal(doc.getElementById('panel-history').hidden, false)
  key(win, doc.getElementById('tab-history'), 'ArrowLeft')
  assert.equal(rp.getState().view, 'dashboard')
  assert.equal(doc.activeElement?.id, 'tab-dashboard')
  // 最左邊再往左繞到最後一頁
  key(win, doc.getElementById('tab-dashboard'), 'ArrowLeft')
  assert.equal(rp.getState().view, 'settings')
  assert.equal(doc.getElementById('tab-settings').getAttribute('aria-selected'), 'true')
  await flush()
  // 其他按鍵不動
  key(win, doc.getElementById('tab-settings'), 'a')
  assert.equal(rp.getState().view, 'settings')
  doc.getElementById('tab-history').click()
  assert.equal(rp.getState().view, 'history')
  assert.equal(doc.getElementById('tab-history').getAttribute('aria-selected'), 'true')
  assert.match(win.location.hash, /view=history/)
})

test('頁籤的 active 外觀只看 aria-selected（不再用 body:has 各自推）', () => {
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
  assert.ok(/\.tab-btn\[aria-selected="true"\]/.test(css))
  assert.ok(!/body:has\(#panel-/.test(css))
})

// ---------- 日曆格 ----------

test('日曆格：格內是可聚焦的 button，點它（Enter／空白鍵的原生行為）選到那一天；有 aria-label 說日期與狀態', async () => {
  const { rp, doc, win } = await freshReport()
  rp.renderCalendar(2026, 9, { '2026-09-05': { count: 3, hasFail: true }, '2026-09-06': { count: 1 } })
  const cells = [...doc.querySelectorAll('#calendar td[data-date]')]
  assert.ok(cells.length >= 28, '要掃到日曆格')
  for (const td of cells) {
    const btn = td.querySelector('button.cal-day')
    assert.ok(btn, `${td.dataset.date} 格內要有按鈕`)
    assert.equal(btn.type, 'button')
    assert.ok(!btn.disabled)
    assert.ok(btn.getAttribute('aria-label').startsWith(td.dataset.date))
  }
  const d5 = doc.querySelector('#calendar td[data-date="2026-09-05"] button')
  assert.match(d5.getAttribute('aria-label'), /有失敗/)
  assert.match(doc.querySelector('#calendar td[data-date="2026-09-06"] button').getAttribute('aria-label'), /有紀錄/)
  d5.focus()
  assert.equal(doc.activeElement, d5, '日曆格要可聚焦')
  d5.click()
  assert.equal(rp.getState().from, '2026-09-05')
  assert.equal(rp.getState().to, '2026-09-05')
  assert.match(win.location.hash, /2026-09-05/)
  // 月份導覽是圖示按鈕，要有名稱
  assert.equal(doc.getElementById('cal-prev-month').getAttribute('aria-label'), '上個月')
  assert.equal(doc.getElementById('cal-next-month').getAttribute('aria-label'), '下個月')
})

// ---------- 紀錄列的展開 ----------

const COLS = [
  { key: 'slot', label: '時間', visible: true },
  { key: 'taskName', label: '任務', visible: true },
  { key: 'value', label: '值', visible: true },
  { key: 'status', label: '狀態', visible: true }
]
const rec = (over = {}) => ({
  date: '2026-09-05', taskId: 't1', taskName: '總量', slot: '2026-09-05T09:00',
  capturedAt: '2026-09-05T09:00:05+08:00', value: 10, raw: '10', status: 'ok', ...over
})

test('紀錄列：列內一顆展開鈕，aria-expanded 隨展開收合切換、aria-controls 指向明細列；點整列照舊展開', async () => {
  const { rp, doc } = await freshReport()
  rp.renderTable([rec(), rec({ slot: '2026-09-05T10:00', capturedAt: '2026-09-05T10:00:03+08:00', value: 12 })], COLS)
  const rows = [...doc.querySelectorAll('#record-table tbody tr:not(.detail)')]
  assert.equal(rows.length, 2)
  const btn = rows[0].querySelector('button[aria-expanded]')
  assert.ok(btn, '列內要有展開鈕')
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  assert.ok(btn.getAttribute('aria-label'))
  btn.focus()
  assert.equal(doc.activeElement, btn, '展開鈕要可聚焦')
  // Enter／空白鍵在原生 button 上就是 click
  btn.click()
  assert.equal(btn.getAttribute('aria-expanded'), 'true')
  const detail = rows[0].nextElementSibling
  assert.ok(detail.classList.contains('detail'))
  assert.equal(detail.id, btn.getAttribute('aria-controls'), 'aria-controls 指向明細列')
  btn.click()
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  assert.equal(doc.querySelectorAll('#record-table tr.detail').length, 0)
  // 滑鼠點整列（不是按鈕）一樣展開，按鈕狀態同步
  rows[1].querySelector('td:nth-child(3)').click()
  const btn2 = rows[1].querySelector('button[aria-expanded]')
  assert.equal(btn2.getAttribute('aria-expanded'), 'true')
  assert.equal(rows[1].nextElementSibling.id, btn2.getAttribute('aria-controls'))
  // 兩列的明細 id 不同
  assert.notEqual(btn.getAttribute('aria-controls'), btn2.getAttribute('aria-controls'))
  // 展開鈕不改變儲存格文字（排序、複製、既有斷言讀的都是文字）
  assert.equal(btn.textContent, '')
})

test('紀錄列：告警改用警示圖示（有 aria-label），不再接 emoji', async () => {
  const { rp, doc } = await freshReport()
  rp.renderTable([rec({ alert: true, alertHits: ['>= 5'] })], COLS)
  const row = doc.querySelector('#record-table tbody tr:not(.detail)')
  assert.ok(row.classList.contains('has-alert'))
  const mark = row.querySelector('.alert-mark')
  assert.ok(mark && mark.querySelector('svg'), '狀態欄要有警示圖示')
  assert.equal(mark.getAttribute('aria-label'), '告警')
  assert.ok(!/\u{1F514}/u.test(row.textContent))
})

// ---------- 符號字元歸零、圖示按鈕有名稱 ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|html)$/.test(name)) out.push(p)
  }
  return out
}

// 當圖示用的符號字元。基準（段 8-B 開工前，report／popup）：⚙ 1、× 3、▾ 2、▸ 2、⧉ 1、🔔 2、« 1、» 1、‹ 3、› 3、✕ 1，
// 加上抽屜上下移的 ↑／↓ 按鈕各 2——一律歸零。
// ↑／↓ 另有數值卡的漲跌文字（資料，不是圖示）所以不列進字元集，改用「按鈕文字只有箭頭」的寫法擋。
const ICON_CHARS = /[⚙✕✖×☰⋮⧉▾▸▴◂«»‹›\u{1F514}\u{1F5D1}⚙️]/u
// 段 8-C：掃描範圍擴大到整個 src/ui/（picker、site、help 等也不得用符號字元當圖示）
const SCOPES = ['']

test('report／popup 的 JS／HTML 不再用符號字元當圖示（基準數量歸零）', () => {
  const files = SCOPES.flatMap(s => walk(join(SRC_UI, s)))
  files.push(join(SRC_UI, 'icons.js'))
  assert.ok(files.length >= 10, `要掃到 report／popup 的檔案，實得 ${files.length}`)
  const hits = []
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (ICON_CHARS.test(line) && !f.endsWith('icons.js')) hits.push(`${f}:${i + 1}: ${line.trim()}`)
      if (/textContent\s*=\s*['"`][↑↓←→]['"`]/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(hits, [])
})

test('icons.js：以 createElementNS 建立內嵌 SVG（currentColor、16px），至少八種圖示', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ic = await import('../src/ui/icons.js?t=' + Math.random())
  const required = ['settings', 'close', 'grip', 'remove', 'refresh', 'external', 'alert', 'check']
  for (const name of required) {
    assert.ok(ic.ICON_NAMES.includes(name), `缺少 ${name}`)
    const svg = ic.icon(name)
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg')
    assert.equal(svg.getAttribute('stroke'), 'currentColor')
    assert.equal(svg.getAttribute('width'), '16')
    assert.equal(svg.getAttribute('height'), '16')
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24')
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    assert.ok(svg.childNodes.length > 0, `${name} 要有形狀`)
    assert.equal(svg.textContent, '', '圖示不帶文字（按鈕名稱由 aria-label 或可見文字負責）')
  }
  // 匯出的獨立 HTML 用 outerHTML 帶出：靜態標記、沒有 script
  const html = ic.icon('settings').outerHTML
  assert.match(html, /^<svg[^>]*viewBox="0 0 24 24"/)
  assert.ok(!/<script/i.test(html))
  // setIcon：只有圖示 → aria-label＋title；帶文字 → 圖示＋可見文字
  const b = document.createElement('button')
  ic.setIcon(b, 'close', { label: '關閉' })
  assert.equal(b.getAttribute('aria-label'), '關閉')
  assert.equal(b.textContent, '')
  const t = document.createElement('button')
  ic.setIcon(t, 'refresh', { text: '立即重試' })
  assert.equal(t.textContent, '立即重試')
  assert.ok(t.querySelector('svg'))
  assert.throws(() => ic.icon('no-such-icon'))
  const src = readFileSync(join(SRC_UI, 'icons.js'), 'utf8')
  assert.ok(!/innerHTML/.test(src))
})

test('靜態 HTML：沒有可見文字的按鈕都有 aria-label（report.html、popup.html）', () => {
  for (const [name, html] of [['report.html', reportHtml], ['popup.html', popupHtml]]) {
    const doc = new JSDOM(html).window.document
    const empty = [...doc.querySelectorAll('button')].filter(b => b.textContent.trim() === '')
    for (const b of empty) {
      assert.ok((b.getAttribute('aria-label') || '').trim(), `${name}：#${b.id} 沒有文字也沒有 aria-label`)
    }
  }
})

test('動態產生的圖示按鈕都有 aria-label：卡片設定、移除來源、日期範圍、日曆、紀錄展開', async () => {
  const { rp, doc } = await freshReport()
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const TB = { t1: { id: 't1', name: '電費', mode: 'number' }, t2: { id: 't2', name: '水費', mode: 'number' } }
  const ctx = {
    records: [], tasksById: TB, parentTasksById: TB, health: {}, nextRuns: {}, missed: [],
    range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06', editing: true
  }
  const host = doc.createElement('div')
  for (const type of ['number', 'line', 'table', 'status']) {
    host.appendChild(CR.renderCard({ id: `c-${type}`, type, x: 0, y: 0, w: 6, h: 3, source: [{ taskId: 't1' }, { taskId: 't2' }], options: { taskIds: ['t1', 't2'] } }, ctx))
  }
  doc.body.appendChild(host)
  const config = host.querySelector('[data-action="config"]')
  assert.ok(config.querySelector('svg[data-icon="settings"]'), '齒輪改成 SVG')
  assert.equal(config.getAttribute('aria-label'), '卡片設定')
  const removes = host.querySelectorAll('[data-remove-source]')
  assert.ok(removes.length > 0, '編輯模式要有移除把手')
  for (const r of removes) assert.match(r.getAttribute('aria-label'), /移除/)
  rp.renderRangeBar()
  rp.renderCalendar(2026, 9, {})
  rp.renderTable([rec()], COLS)
  const n = assertIconButtonsLabelled(doc, 'Report')
  assert.ok(n >= 10, `要掃到圖示按鈕，實得 ${n}`)
  for (const id of ['range-prev-week', 'range-prev-day', 'range-next-day', 'range-next-week']) {
    assert.ok(doc.getElementById(id).querySelector('svg'), `${id} 用 SVG 圖示`)
  }
})

// ---------- 8-A 留下的五件事 ----------

test('狀態清單卡：chip 顏色跟著 health（紅 is-bad／黃 is-warn／正常 is-ok／沒紀錄 is-off）', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const TB = {
    a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' }, c: { id: 'c', name: 'C' }, d: { id: 'd', name: 'D' }
  }
  const el = CR.renderCard({ id: 's', type: 'status', x: 0, y: 0, w: 6, h: 3, source: [], options: { taskIds: ['a', 'b', 'c', 'd'] } }, {
    records: [], tasksById: TB, parentTasksById: TB, nextRuns: {}, missed: [],
    health: { a: { status: 'selector_lost' }, b: { status: 'fallback' }, c: { status: 'ok' } },
    range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06'
  })
  const cls = id => el.querySelector(`.status-item[data-task-id="${id}"] .status-state`).className
  assert.match(cls('a'), /\bchip\b.*\bis-bad\b/)
  assert.match(cls('b'), /\bis-warn\b/)
  assert.match(cls('c'), /\bis-ok\b/)
  assert.match(cls('d'), /\bis-off\b/)
  assert.ok(!/\bis-ok\b/.test(cls('a')), '失敗不得是綠色')
})

test('popup：原因字依狀態上色（黃 is-warn、紅 is-bad），異常列掛狀態色條類別', async () => {
  const { pp, doc } = await freshPopup()
  const t = (id) => ({ id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true, schedule: { type: 'daily', times: ['09:00'] } })
  pp.render({
    health: { level: 'red', summary: '1 個任務異常' },
    tasks: [t('red'), t('yellow'), t('fine')],
    lastValues: {}, nextRuns: {},
    healthMap: { red: { status: 'selector_lost', reason: '找不到元素' }, yellow: { status: 'fallback', reason: '用備援方式抓到' }, fine: { status: 'ok' } }
  })
  const row = name => [...doc.querySelectorAll('#task-list .task-row')].find(r => r.querySelector('.task-name').textContent === name)
  assert.ok(row('red').querySelector('.task-reason').classList.contains('is-bad'))
  assert.ok(row('yellow').querySelector('.task-reason').classList.contains('is-warn'))
  assert.ok(!row('yellow').querySelector('.task-reason').classList.contains('is-bad'), '黃燈原因不是紅字')
  assert.ok(row('red').classList.contains('is-bad'))
  assert.ok(row('yellow').classList.contains('is-warn'))
  assert.ok(!row('fine').classList.contains('is-bad') && !row('fine').classList.contains('is-warn'))
  assert.equal(row('fine').querySelector('.task-reason'), null)
  // 兩行：名稱＋最後值／狀態 chip＋下次時間
  const sub = row('red').querySelector('.task-sub')
  assert.ok(sub.querySelector('.chip.is-bad'))
  assert.ok(sub.querySelector('.task-next'))
  const css = readFileSync(new URL('../src/ui/popup/popup.css', import.meta.url), 'utf8')
  assert.match(css, /\.task-reason\.is-warn\s*\{[^}]*var\(--warn-text\)/)
  assert.match(css, /\.task-reason\.is-bad\s*\{[^}]*var\(--danger-text\)/)
  // 頂部燈號是 chip，保留舊的等級類別
  const dot = doc.getElementById('status-dot')
  assert.ok(dot.classList.contains('chip') && dot.classList.contains('is-bad') && dot.classList.contains('bad'))
  assert.equal(dot.textContent, '異常')
})

test('popup：同一畫面只有一顆實心主要按鈕（在這個頁面選取），開啟報表改成頁尾次要連結', async () => {
  const { pp, doc } = await freshPopup()
  pp.render({ health: { level: 'green', summary: '一切正常' }, tasks: [], lastValues: {}, nextRuns: {}, healthMap: {} })
  const primaries = [...doc.querySelectorAll('.btn-primary')]
  assert.deepEqual(primaries.map(b => b.id), ['pick-here'])
  const report = doc.getElementById('open-report')
  assert.ok(report.closest('footer'), '開啟報表在頁尾')
  assert.ok(!report.classList.contains('btn-primary'))
  const css = readFileSync(new URL('../src/ui/popup/popup.css', import.meta.url), 'utf8')
  assert.ok(!/#open-report[^{]*\{[^}]*--primary-strong/.test(css), 'popup.css 不得再把開啟報表畫成實心')
  const foot = doc.querySelector('footer')
  for (const id of ['open-report', 'open-help', 'toggle-all']) assert.ok(foot.querySelector(`#${id}`), `頁尾要有 #${id}`)
})

test('theme.css 四條軌都有 color-scheme（亮 light、暗 dark），原生控制項跟著換色', () => {
  const css = readFileSync(new URL('../src/ui/theme.css', import.meta.url), 'utf8')
  const block = (re) => {
    const m = css.match(re)
    assert.ok(m, `找不到區塊 ${re}`)
    return m[0]
  }
  assert.match(block(/^:root\s*\{[^}]*\}/m), /color-scheme:\s*light/)
  // 只看 :root { … } 本體：媒體查詢條件字串本身就含「color-scheme: dark」，不能算進去
  assert.match(block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*\}/).replace(/^[^{]*\{\s*:root\s*\{/, ''), /(^|[;\s])color-scheme:\s*dark/)
  assert.match(block(/:root\[data-theme="dark"\]\s*\{[^}]*\}/), /color-scheme:\s*dark/)
  assert.match(block(/:root\[data-theme="light"\]\s*\{[^}]*\}/), /color-scheme:\s*light/)
})

test('匯出的獨立 HTML：狀態文字色用 --*-text，狀態清單的 chip 四態有樣式', () => {
  const src = readFileSync(new URL('../src/shared/export.js', import.meta.url), 'utf8')
  const style = src.slice(src.indexOf('<style>'), src.indexOf('</style>'))
  assert.ok(style.length > 1000, '要掃到內嵌樣式')
  assert.deepEqual(style.match(/(?<![-\w])color:\s*var\(--(ok|warn|danger)\)/g) || [], [], '文字色不得直接用 --ok／--warn／--danger')
  for (const k of ['ok', 'warn', 'bad', 'off']) assert.match(style, new RegExp(`\\.chip\\.is-${k}\\s*\\{`))
  assert.match(style, /svg\.icon\s*\{/)
})

// ---------- 版面 ----------

test('Report 版面：內容最大寬 1280px 置中、側邊留白 --space-5；900px 斷點單欄', () => {
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
  const body = css.match(/\nbody\s*\{[^}]*\}/)[0]
  assert.match(body, /max-width:\s*1280px/)
  assert.match(body, /margin:\s*0 auto/)
  assert.match(body, /var\(--space-5\)/)
  assert.match(css, /@media \(max-width: 900px\)\s*\{[^}]*\.history-layout\s*\{\s*grid-template-columns:\s*1fr/)
})

test('設定頁：五個分區卡片，每區標題＋一句說明；既有欄位 id 一個不少', async () => {
  const { doc } = await freshReport()
  const sections = [...doc.querySelectorAll('#panel-settings .settings-section')]
  assert.deepEqual(sections.map(s => s.querySelector('h2').textContent), ['排程與抓取', '通知與告警', '資料與備份', '站台', '診斷'])
  for (const s of sections) assert.ok(s.querySelector('.settings-head .settings-desc').textContent.trim().length > 5)
  for (const id of ['export-from', 'export-to', 'export-format', 'export-run', 'settings-include-passwords', 'settings-passphrase',
    'settings-export', 'settings-import-file', 'settings-import-result', 'records-import-file', 'records-import-result',
    'pref-retention', 'pref-notifications', 'pref-extra-delay', 'pref-fetch-tab-mode', 'pref-alert-cooldown',
    'pref-site-check-time', 'pref-theme', 'pref-help-menu', 'open-help', 'clear-pinned-defaults', 'clear-pinned-result',
    'health-selfcheck', 'health-watchdog', 'health-next-runs', 'health-diag', 'storage-stats', 'privacy-note', 'sites-list']) {
    assert.ok(doc.getElementById(id), `缺少 #${id}`)
  }
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
  assert.match(css, /\.settings-row > \.inline-status\s*\{\s*margin-left:\s*auto/, '「已儲存」固定在每列右側')
})

test('應用列：燈號 chip＋摘要句，與 popup 同一份燈號', async () => {
  const { rp, st, doc } = await freshReport()
  await st.saveTasks([{ id: 'x', name: '電費', url: 'https://a.test/', mode: 'number', enabled: true, schedule: { type: 'daily', times: ['09:00'] } }])
  await st.updateHealthMap(h => ({ ...h, x: { status: 'selector_lost', reason: '找不到元素', read: false } }))
  await rp.renderAppStatus()
  const chip = doc.getElementById('app-status-chip')
  assert.ok(chip.classList.contains('chip') && chip.classList.contains('is-bad'))
  assert.equal(chip.textContent, '異常')
  assert.match(doc.getElementById('app-status-summary').textContent, /電費/)
})
