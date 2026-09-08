// AF-7 體檢輪：兩份獨立終檢抓到的缺陷（實測確認成立後才寫成測試）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { parseTable } from '../src/shared/table.js'
import { detectKind } from '../src/shared/block-detect.js'

const TWO_TABLES = `
  <table id="t1"><thead><tr><th>幣別</th><th>買入</th></tr></thead>
  <tbody><tr><td>美金</td><td id="a1">31.2</td></tr></tbody></table>
  <table id="t2"><thead><tr><th>幣別</th><th>賣出</th></tr></thead>
  <tbody><tr><td>日圓</td><td id="b1">0.22</td></tr></tbody></table>`

async function pickerOn(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, pm, doc: jd.window.document, win: jd.window }
}

const fire = (win, el, t, i = {}) => el.dispatchEvent(new win.MouseEvent(t, { bubbles: true, ...i }))
const key = (doc, win, k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }))
const picked = (c) => c.__calls
  .filter(x => x.api === 'runtime.sendMessage')
  .map(x => x.args[0])
  .filter(m => m?.type === 'PICKED' && !m.cancelled)

// ---------- B1：離開選取模式要把「已選屬於哪張表」一起清掉 ----------

test('B1 同一頁連續選兩次，第二次不得沿用上一次那張表的定位', async () => {
  const { c, pm, doc, win } = await pickerOn(TWO_TABLES)

  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t1') })
  fire(win, doc.getElementById('a1'), 'mousemove')
  fire(win, doc.getElementById('a1'), 'click')
  assert.equal(picked(c)[0].locator.css, '#t1')

  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t2') })
  fire(win, doc.getElementById('b1'), 'mousemove')
  fire(win, doc.getElementById('b1'), 'click', { shiftKey: true })
  key(doc, win, 'Enter')

  const second = picked(c)[1]
  assert.ok(second, '第二次要送出')
  assert.equal(second.locator.css, '#t2',
    '第二個任務會被存成「第一張表的 locator + 第二張表的列欄索引」，抓到的永遠是錯的值')
  assert.equal(second.preview, '0.22')
  pm.exitPickMode()
})

test('B1 exitPickMode 之後再進來，滑鼠移動不得把剛選的值清掉', async () => {
  const { pm, doc, win } = await pickerOn(TWO_TABLES)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t1') })
  fire(win, doc.getElementById('a1'), 'mousemove')
  fire(win, doc.getElementById('a1'), 'click')

  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t2') })
  fire(win, doc.getElementById('b1'), 'mousemove')
  fire(win, doc.getElementById('b1'), 'click', { shiftKey: true })
  assert.equal(pm.selectedCount(), 1)
  // 移出去再移回來（漂出表格不該清空）
  fire(win, doc.body, 'mousemove')
  fire(win, doc.getElementById('b1'), 'mousemove')
  assert.equal(pm.selectedCount(), 1, '上一輪殘留的「已選表格」會讓這裡誤判成換表而清空')
  pm.exitPickMode()
})

// ---------- B2：達上限後點格子不得靜靜送出 ----------

test('B2 已達選取上限時再點一格，不得丟掉那一格就送出', async () => {
  const { c, pm, doc, win } = await pickerOn(`
    <table id="t"><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead>
    <tbody><tr><td id="x1">1</td><td id="x2">2</td><td id="x3">3</td></tr></tbody></table>`)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t'), maxPicks: 2 })
  for (const id of ['x1', 'x2']) {
    fire(win, doc.getElementById(id), 'mousemove')
    fire(win, doc.getElementById(id), 'click', { shiftKey: true })
  }
  assert.equal(pm.selectedCount(), 2)
  fire(win, doc.getElementById('x3'), 'mousemove')
  fire(win, doc.getElementById('x3'), 'click')
  assert.equal(picked(c).length, 0, '加不進去就不該送出，否則使用者點的那一格被無聲丟掉')
  const panel = doc.querySelector('[data-af-panel]')
  assert.ok(/上限/.test(panel.textContent), '要說出已達上限')
  pm.exitPickMode()
})

// ---------- B3：滑鼠移到格子以外時，單格標示不得留在舊位置 ----------

test('B3 滑鼠離開儲存格後切換模式，不得把標示畫回舊的那一格', async () => {
  const { pm, doc, win } = await pickerOn(`
    <table id="t"><thead><tr><th>a</th><th>b</th></tr></thead>
    <tbody><tr><td id="x1">1</td><td id="x2">2</td></tr></tbody></table>`)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  fire(win, doc.getElementById('x1'), 'mousemove')
  assert.equal(doc.querySelectorAll('[data-af-cell]').length, 1)
  // 移到表格本身（格子之間的縫隙）
  fire(win, doc.getElementById('t'), 'mousemove')
  key(doc, win, 'Tab')
  key(doc, win, 'Tab')
  key(doc, win, 'Tab')
  const marked = [...doc.querySelectorAll('[data-af-cell]')].map(el => el.id)
  assert.deepEqual(marked, [], `滑鼠已經不在任何一格上，實得標示在 ${JSON.stringify(marked)}`)
  pm.exitPickMode()
})

// ---------- B5：沒有已選時 Backspace 要放給頁面 ----------

test('B5 沒有已選時 Backspace 不得攔截（頁面上可能有輸入框）', async () => {
  const { pm, doc, win } = await pickerOn('<input id="i" type="text">')
  pm.enterPickMode({ purpose: 'login-user', initialTarget: doc.getElementById('i') })
  const ev = new win.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
  doc.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, false, '沒有東西可移除就不該攔下這個按鍵')
  pm.exitPickMode()
})

test('B5 有已選時 Backspace 要攔下並移除最後一項', async () => {
  const { pm, doc, win } = await pickerOn(`
    <table id="t"><thead><tr><th>a</th><th>b</th></tr></thead>
    <tbody><tr><td id="x1">1</td><td id="x2">2</td></tr></tbody></table>`)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t') })
  fire(win, doc.getElementById('x1'), 'mousemove')
  fire(win, doc.getElementById('x1'), 'click', { shiftKey: true })
  const ev = new win.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
  doc.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, true)
  assert.equal(pm.selectedCount(), 0)
  pm.exitPickMode()
})

// ---------- 純包裝的反例：格內同時有文字與表格 ----------

test('純包裝反例：唯一那格同時有文字與內層表格，外層的文字不得被丟掉', () => {
  const jd = new JSDOM(`<!doctype html><body><table><tbody><tr><td>總計<table><tbody>
    <tr><td>7</td><td>8</td></tr></tbody></table></td></tr></tbody></table></body>`)
  const cells = parseTable(jd.window.document.querySelector('table')).cells
  const flat = JSON.stringify(cells)
  assert.ok(flat.includes('總計'), `外層那格的文字要留著，實得 ${flat}`)
})

// ---------- R2：role=table 包住真表格 ----------

test('R2 role="table" 包住真的 <table> 時要回報得出列數', () => {
  const jd = new JSDOM(`<!doctype html><body><div role="table"><table><tbody>
    <tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div></body>`)
  const info = detectKind(jd.window.document.querySelector('[role="table"]'))
  assert.equal(info.kind, 'table')
  assert.ok(info.rows >= 2, `列數不得歸零，實得 ${JSON.stringify(info)}`)
  assert.equal(info.cols, 2)
})

// ---------- B4：單格預覽不得把同一個值印兩次 ----------

test('B4 預覽是純數值時不得顯示成「42 (42)」', () => {
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return import('../src/ui/picker/picker.js?t=' + Math.random()).then(async (pk) => {
    resetChromeMock()
    installChromeMock()
    const st = await import('../src/shared/storage.js?t=' + Math.random())
    await st.init()
    pk.render({ tabId: 1, locator: { css: '#v' }, preview: '42', previewValue: 42 })
    assert.equal(jd.window.document.getElementById('preview').textContent, '42')
  })
})

test('B4 預覽是「文字 + 數值」時仍要兩個都顯示', () => {
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return import('../src/ui/picker/picker.js?t=' + Math.random()).then(async (pk) => {
    resetChromeMock()
    installChromeMock()
    const st = await import('../src/shared/storage.js?t=' + Math.random())
    await st.init()
    pk.render({ tabId: 1, locator: { css: '#v' }, preview: '42MAX:462', previewValue: 42 })
    const txt = jd.window.document.getElementById('preview').textContent
    assert.ok(txt.includes('42MAX:462') && txt.includes('(42)'), `實得 ${JSON.stringify(txt)}`)
  })
})

// ---------- 立即測試：指定的分頁已經跑到別的網站 ----------

test('指定的分頁已經導去別的網站時，不得在那一頁上測', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const { runTask } = await import('../src/background/fetcher.js?t=' + Math.random())
  const strayTab = await c.tabs.create({ url: 'https://other.example/somewhere' })
  c.__setTabResponder(() => ({ ok: true, value: 7, raw: '7', status: 'ok' }))
  await runTask({
    id: '__preview', name: 't', url: 'https://x.example/mon', order: 1, enabled: true,
    mode: 'number', locator: { css: '#v' }, spec: { strategy: 'auto' }
  }, { dryRun: true, reason: 'manual', tabId: strayTab.id, extraDelayMs: 0 })
  const used = c.__calls.filter(x => x.api === 'tabs.sendMessage').map(x => x.args[0])
  assert.ok(!used.includes(strayTab.id),
    '那個分頁已經不是任務的頁面了，要退回原本的找分頁流程')
})
