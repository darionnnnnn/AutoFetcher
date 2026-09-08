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

test('D-2 ui.css 的字級不得小於 12px', () => {
  const px = [...UI_CSS.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]))
  for (const v of px) {
    assert.ok(v >= 12, `字級 ${v}px 太小`)
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
  assert.ok(!/outline:\s*(none|0)\s*;/.test(UI_CSS.replace(/:focus-visible[^{]*\{[^}]*\}/g, '')),
    '不得整體關掉外框')
  assert.match(UI_CSS, /:focus-visible/, '要有可見的鍵盤焦點樣式')
})

test('D-4 可點元素要有 cursor: pointer', () => {
  assert.match(UI_CSS, /cursor:\s*pointer/)
})
