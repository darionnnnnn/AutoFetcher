// AF-7 批次 D:共用元件樣式 ui/ui.css 與設定視窗改版
// 對照 docs/AF-7-PLAN.md 批次 D 的驗收 D-1 ~ D-4。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

// 檔案還不存在時回空字串，讓每一條測試各自紅，而不是整個檔案掛掉
function readOrEmpty(rel) {
  try {
    return readFileSync(new URL(rel, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

const UI_CSS = readOrEmpty('../src/ui/ui.css')
const THEME_CSS = readFileSync(new URL('../src/ui/theme.css', import.meta.url), 'utf8')
const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const SITE_HTML = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
const PICKER_MODE = readFileSync(new URL('../src/content/picker-mode.js', import.meta.url), 'utf8')

const HEX = /#[0-9a-fA-F]{3,8}\b/g

// ---------- D-1 顏色只能來自 theme.css ----------

test('D-1 ui.css 不得出現色碼字面值（顏色一律走 theme.css 變數）', () => {
  assert.ok(UI_CSS.length > 0, 'src/ui/ui.css 要存在')
  const hits = UI_CSS.match(HEX) || []
  assert.deepEqual(hits, [], `實得 ${JSON.stringify(hits)}`)
})

test('D-1 選取模式的色碼全部集中在檔頭的常數區', () => {
  // 這個檔案注入在網頁上，拿不到 theme.css，是全專案唯一的色碼豁免；
  // 但色碼只能出現在檔頭那一個常數物件裡，其餘程式碼一律引用它。
  const start = PICKER_MODE.indexOf('const COLORS')
  assert.ok(start >= 0, '要有一個名為 COLORS 的常數物件集中管理顏色')
  const end = PICKER_MODE.indexOf('}', start)
  assert.ok(end > start, 'COLORS 常數要是一個物件')
  const outside = PICKER_MODE.slice(0, start) + PICKER_MODE.slice(end)
  const hits = outside.match(HEX) || []
  assert.deepEqual(hits, [], `常數區以外不得有色碼，實得 ${JSON.stringify(hits)}`)
})

test('D-1 COLORS 的值要對得上 theme.css 暗色軌', () => {
  const start = PICKER_MODE.indexOf('const COLORS')
  const block = PICKER_MODE.slice(start, PICKER_MODE.indexOf('}', start))
  const used = (block.match(HEX) || []).map(h => h.toLowerCase())
  assert.ok(used.length >= 4, `至少要有底色、文字、主色、警示，實得 ${used.length}`)
  const themeHex = new Set((THEME_CSS.match(HEX) || []).map(h => h.toLowerCase()))
  for (const h of used) {
    assert.ok(themeHex.has(h), `${h} 不在 theme.css 裡，兩邊會走鐘`)
  }
})

// ---------- D-2 共用樣式表被載入 ----------

test('D-2 設定視窗與站台視窗都載入 ui.css', () => {
  assert.match(PICKER_HTML, /<link[^>]+href=["']\.\.\/ui\.css["']/, 'picker.html 要載入共用樣式')
  assert.match(SITE_HTML, /<link[^>]+href=["']\.\.\/ui\.css["']/, 'site.html 要載入共用樣式')
})

test('D-2 兩個視窗仍然只載入 theme.css 與 ui.css，不引用外部資源', () => {
  for (const [name, html] of [['picker', PICKER_HTML], ['site', SITE_HTML]]) {
    assert.ok(!/src=["']https?:/.test(html), `${name} 不得引用外部 script`)
    assert.ok(!/href=["']https?:/.test(html), `${name} 不得引用外部樣式`)
  }
})

test('D-2 ui.css 有 [hidden] 的強制規則', () => {
  // 區塊自己的 display: flex/grid 會壓過 hidden 屬性，空殼會露出來
  assert.match(UI_CSS, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/)
})

test('D-2 ui.css 尊重 prefers-reduced-motion', () => {
  assert.match(UI_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
})

test('D-2 字級不得小於 12px（含 theme.css 的 --text-* token）', () => {
  const px = [...UI_CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]))
  for (const v of px) {
    assert.ok(v >= 12, `ui.css 字級 ${v}px 太小`)
  }
  // ui.css 一律用 var(--text-*)，真正決定大小的是 theme.css 的 token；
  // 只掃 ui.css 的話這條是對空集合跑迴圈，把 token 改成 8px 也不會紅
  const tokens = [...THEME_CSS.matchAll(/--text-(xs|sm|md|lg|xl):\s*([\d.]+)(px|rem)/g)]
  assert.ok(tokens.length >= 5, `theme.css 要定義 --text-* token，實得 ${tokens.length}`)
  for (const [, name, num, unit] of tokens) {
    const px2 = unit === 'rem' ? Number(num) * 16 : Number(num)
    assert.ok(px2 >= 12, `--text-${name} 換算後是 ${px2}px，小於 12px`)
  }
})

// ---------- D-3 設定視窗的結構沒被改壞 ----------

test('D-3 picker.html 必要的元素 id 一個都沒少', () => {
  const doc = new JSDOM(PICKER_HTML).window.document
  const ids = ['name', 'url', 'mode', 'strategy', 'schedule-type', 'times', 'weekdays',
    'every-minutes', 'preview', 'save', 'cancel', 'test-now', 'errors',
    'block-section', 'block-summary', 'block-aggregate', 'field-list', 'save-summary',
    'advanced-section', 'window-from', 'window-to']
  for (const id of ids) {
    assert.ok(doc.getElementById(id), `缺少 #${id}`)
  }
})

test('D-3 site.html 的選取按鈕都還在', () => {
  const doc = new JSDOM(SITE_HTML).window.document
  for (const action of ['pick-user', 'pick-pass', 'pick-submit']) {
    assert.ok(doc.querySelector(`[data-action="${action}"]`), `缺少 ${action}`)
  }
})

test('D-3 儲存與取消是可聚焦的按鈕', () => {
  const doc = new JSDOM(PICKER_HTML).window.document
  for (const id of ['save', 'cancel', 'test-now']) {
    assert.equal(doc.getElementById(id).tagName, 'BUTTON', `#${id} 要是 button 才有鍵盤操作`)
  }
})

// ---------- D-4 無障礙 ----------

test('D-4 焦點樣式存在且沒有被關掉', () => {
  const blocks = [...UI_CSS.matchAll(/:focus-visible[^{]*\{([^}]*)\}/g)].map(m => m[1])
  assert.ok(blocks.length > 0, '要有 :focus-visible 的鍵盤焦點樣式')
  // 焦點框本身要看得見：不能是 none/0，而且要指定顏色
  const visible = blocks.some(b => /outline:/.test(b) && !/outline:\s*(none|0)\b/.test(b))
  assert.ok(visible, `:focus-visible 要畫得出外框，實得 ${JSON.stringify(blocks)}`)
  // 其他地方也不得整體關掉外框
  const rest = UI_CSS.replace(/:focus-visible[^{]*\{[^}]*\}/g, '')
  assert.ok(!/outline:\s*(none|0)\s*;/.test(rest), '不得在別處整體關掉外框')
})

test('D-4 可點元素要有 cursor: pointer', () => {
  assert.match(UI_CSS, /cursor:\s*pointer/)
})

// ---------- D-5 樣式不得引用沒有人設定的屬性 ----------

test('D-5 content: attr() 引用的屬性必須真的有人寫進 DOM', () => {
  const styles = [PICKER_HTML, SITE_HTML, UI_CSS].join('\n')
  const used = [...styles.matchAll(/content:\s*attr\(([a-zA-Z0-9-]+)\)/g)].map(m => m[1])
  const sources = styles +
    readOrEmpty('../src/ui/picker/picker.js') +
    readOrEmpty('../src/ui/site/site.js') +
    readOrEmpty('../src/content/picker-mode.js')
  for (const attr of used) {
    const written = sources.includes(`setAttribute('${attr}'`) ||
      sources.includes(`setAttribute("${attr}"`) ||
      sources.includes(`${attr}=`)
    assert.ok(written, `${attr} 沒有任何地方設定，這條樣式永遠是空白的`)
  }
  // 正向斷言：值清單的序號要真的算得出來。少了這一條，上面的迴圈在
  // 「一個 attr() 都沒有」時是對空集合跑零圈，等於沒有守門
  assert.match(PICKER_HTML, /counter-reset:\s*field-row/, '值清單要有計數器起點')
  assert.match(PICKER_HTML, /counter-increment:\s*field-row/, '每一列要遞增')
  assert.match(PICKER_HTML, /content:\s*counter\(field-row\)/, '序號要印得出來')
})

// ---------- D-6 選取模式 overlay 實際套用的樣式 ----------

test('D-6 面板與工具列套用深色系與可點尺寸', async () => {
  const { installChromeMock, resetChromeMock } = await import('./chrome-mock.js')
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>
    <table id="t"><thead><tr><th>幣別</th><th>買入</th></tr></thead>
    <tbody><tr><td>美金</td><td id="a1">31.2</td></tr></tbody></table></body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })

  const panel = doc.querySelector('[data-af-panel]')
  const toolbar = doc.querySelector('[data-af-tool]')?.parentElement
  assert.ok(panel && toolbar, '面板與工具列都要在')

  const hexOf = (v) => (v || '').toLowerCase()
  assert.ok(/#1e293b|rgb\(30, 41, 59\)/.test(hexOf(panel.style.backgroundColor)),
    `面板要用深色面底，實得 ${panel.style.backgroundColor}`)
  assert.ok(/#334155|rgb\(51, 65, 85\)/.test(hexOf(panel.style.border)),
    `面板要有細邊框，實得 ${panel.style.border}`)

  // 工具列按鈕的可點高度
  for (const btn of doc.querySelectorAll('[data-af-tool]')) {
    const h = parseInt(btn.style.minHeight, 10)
    assert.ok(h >= 28, `工具列按鈕高度要 ≥28px，實得 ${btn.style.minHeight}`)
  }

  // chip 的可點高度與非 emoji 的移除鈕
  const cell = doc.getElementById('a1')
  cell.dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new jd.window.MouseEvent('click', { bubbles: true, shiftKey: true }))
  const chip = doc.querySelector('[data-af-chip]')
  assert.ok(chip, '要有 chip')
  assert.ok(parseInt(chip.style.minHeight, 10) >= 28, `chip 高度要 ≥28px，實得 ${chip.style.minHeight}`)
  const remove = chip.querySelector('[data-af-chip-remove]')
  assert.equal(remove.textContent, '×', '移除鈕用乘號字元，不得用 emoji')
  pm.exitPickMode()
})
