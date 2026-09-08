// AF-7 補完：批次 D 規劃中沒做到的四項版面（標題列、卡片分節、預覽狀態色、去除重複樣式）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const SITE_HTML = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
const UI_CSS = readFileSync(new URL('../src/ui/ui.css', import.meta.url), 'utf8')

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, pk, doc: jd.window.document }
}

// ---------- E-1 頂部標題列：任務名稱 + 目標主機 ----------

test('E-1 標題列有標題與目標主機兩個位置', () => {
  const doc = new JSDOM(PICKER_HTML).window.document
  const header = doc.querySelector('[data-picker-header]')
  assert.ok(header, '要有一個標題列容器')
  assert.ok(header.querySelector('#picker-title'), '標題列要有標題')
  assert.ok(header.querySelector('#target-host'), '標題列要有目標主機')
})

test('E-1 目標主機用次要文字色並且過長會截斷', () => {
  const style = PICKER_HTML
  assert.match(style, /#target-host\s*\{[^}]*color:\s*var\(--text-muted\)/,
    '主機名是次要資訊，不搶標題的視覺重量')
  assert.match(style, /#target-host\s*\{[^}]*text-overflow:\s*ellipsis/, '過長要截斷')
})

test('E-1 新增任務時標題是通用文字，主機取自目標網址', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ tabId: 1, locator: { css: '#v' }, url: 'https://rate.bank.example/foreign/today?x=1' })
  assert.equal(doc.getElementById('picker-title').textContent, '設定抓取任務')
  assert.equal(doc.getElementById('target-host').textContent, 'rate.bank.example')
})

test('E-1 編輯既有任務時標題顯示任務名稱', async () => {
  const { pk, doc } = await freshPicker()
  const task = {
    id: 't1', name: '客戶區連線數', url: 'https://mon.example/nexus', order: 1,
    mode: 'number', locator: { css: '#v' }, spec: { strategy: 'auto' }
  }
  pk.render({ task, locator: task.locator, url: task.url })
  assert.equal(doc.getElementById('picker-title').textContent, '客戶區連線數')
  assert.equal(doc.getElementById('target-host').textContent, 'mon.example')
})

test('E-1 網址不合法時不得讓標題列爆掉', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ tabId: 1, locator: { css: '#v' }, url: 'not a url' })
  assert.equal(doc.getElementById('target-host').textContent, '')
})

// ---------- E-2 卡片分節：目標與模式那一組也要有容器 ----------

test('E-2 任務名稱、目標網址、數值類型收在同一張卡片裡', () => {
  const doc = new JSDOM(PICKER_HTML).window.document
  const card = doc.getElementById('target-section')
  assert.ok(card, '要有「目標與模式」的分節容器')
  for (const id of ['name', 'url', 'mode']) {
    assert.ok(card.querySelector(`#${id}`), `#${id} 要在這張卡片裡`)
  }
  assert.ok(card.querySelector('legend'), '分節要有標題')
})

test('E-2 內容區的每個直接子節點都是分節容器，不得有裸欄位', () => {
  const doc = new JSDOM(PICKER_HTML).window.document
  const body = doc.querySelector('.settings-body')
  const bare = [...body.children].filter(el => el.tagName === 'LABEL')
  assert.deepEqual(bare.map(el => el.textContent.trim().slice(0, 10)), [],
    '裸欄位沒有卡片包著，視覺上會散掉')
})

// ---------- E-3 預覽的狀態色 ----------

test('E-3 立即測試成功時預覽標成成功色', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' }, url: 'https://a.test/p' })
  doc.getElementById('name').value = '總量'
  c.__setRuntimeResponder(() => ({ ok: true, value: 42, raw: '42' }))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('preview').dataset.state, 'ok')
})

test('E-3 立即測試失敗時預覽標成失敗色', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' }, url: 'https://a.test/p' })
  doc.getElementById('name').value = '總量'
  c.__setRuntimeResponder(() => ({ ok: false, error: 'not_found' }))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('preview').dataset.state, 'error')
})

test('E-3 還沒測過時沒有狀態', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' }, preview: '1,234', previewValue: 1234 })
  assert.equal(doc.getElementById('preview').dataset.state, undefined)
})

test('E-3 測過之後重新渲染要把狀態清掉', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' }, url: 'https://a.test/p' })
  doc.getElementById('name').value = '總量'
  c.__setRuntimeResponder(() => ({ ok: false, error: 'not_found' }))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('preview').dataset.state, 'error')
  pk.render({ tabId: 3, locator: { css: '#v2' }, url: 'https://a.test/p' })
  assert.equal(doc.getElementById('preview').dataset.state, undefined,
    '換了目標還留著上一次的紅框會誤導')
})

test('E-3 狀態色只用 theme.css 的語意變數', () => {
  const okRule = PICKER_HTML.match(/#preview\[data-state="ok"\]\s*\{([^}]*)\}/)
  const errRule = PICKER_HTML.match(/#preview\[data-state="error"\]\s*\{([^}]*)\}/)
  assert.ok(okRule && errRule, '兩種狀態都要有樣式')
  assert.match(okRule[1], /var\(--ok/)
  assert.match(errRule[1], /var\(--danger/)
})

// ---------- E-4 不得與共用樣式表重複 ----------

test('E-4 兩個視窗的儲存鈕都用共用樣式表的主要按鈕，不得自己再寫一份', () => {
  // 體檢抓到：picker 修了、site 沒修，同型只修一半
  for (const [name, html, id] of [['picker', PICKER_HTML, 'save'], ['site', SITE_HTML, 'site-save']]) {
    const doc = new JSDOM(html).window.document
    const save = doc.getElementById(id)
    assert.ok(save.className.split(/\s+/).includes('btn-primary'), `${name} 的儲存鈕要掛共用類別`)
    assert.ok(!new RegExp(`#${id}\\s*\\{[^}]*background:\\s*var\\(--primary\\)`).test(html),
      `${name}.html 不得再寫一份主色按鈕樣式`)
  }
})

test('E-4 兩個視窗的 HTML 都以換行結尾', () => {
  assert.ok(PICKER_HTML.endsWith('\n'), 'picker.html 檔尾要有換行')
  assert.ok(SITE_HTML.endsWith('\n'), 'site.html 檔尾要有換行')
})

test('E-4 共用樣式表裡不得有沒人使用的類別', () => {
  // 類別可能寫在選擇器清單的任何位置（`button.btn-primary, .foo {`），
  // 只抓行首會漏掉中段那些
  const noComments = UI_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...noComments.matchAll(/([^{}]+)\{/g)].map(m => m[1])
  const defined = selectors.flatMap(sel => [...sel.matchAll(/\.([a-z][a-z0-9-]*)/g)].map(m => m[1]))
  // 用「類別 token」精確比對：`class="btn-primary"` 不能讓 `.btn` 算成有人用
  const usedTokens = new Set()
  for (const m of (PICKER_HTML + SITE_HTML).matchAll(/class="([^"]*)"/g)) {
    for (const tok of m[1].split(/\s+/)) if (tok) usedTokens.add(tok)
  }
  const dead = [...new Set(defined)].filter(cls => !usedTokens.has(cls))
  assert.deepEqual(dead, [], `這些類別沒有任何頁面用到，是死規則：${JSON.stringify(dead)}`)
})

// ---------- E-5 同一個判定只留一份 ----------

test('E-5 「同一個目標頁」的判定只有 frames.js 那一份', async () => {
  const { sameOriginPath } = await import('../src/background/frames.js?t=' + Math.random())
  assert.equal(sameOriginPath('https://a.test/p?x=1#h', 'https://a.test/p?x=2'), true, 'query 與 hash 不算')
  assert.equal(sameOriginPath('https://a.test/p', 'https://a.test/q'), false)
  assert.equal(sameOriginPath('https://a.test/p', 'https://b.test/p'), false)
  assert.equal(sameOriginPath('not a url', 'https://a.test/p'), false, '不合法一律不相同')
  const fetcherSrc = readFileSync(new URL('../src/background/fetcher.js', import.meta.url), 'utf8')
  assert.ok(!/\.pathname/.test(fetcherSrc), 'fetcher.js 不得自己再比一次 pathname，要用 frames.js 的那一份')
  assert.ok(/sameOriginPath\(tab\.url, task\.url\)/.test(fetcherSrc), '立即測試核對分頁網址要走它')
})
