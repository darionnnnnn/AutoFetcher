// AF-8 批次 F2：指標、焦點環、過渡與提示（讓選取模式看起來就知道能點什麼）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <table id="t">
    <thead><tr><th id="h0">幣別</th><th id="h1" title="點此排序">買入</th></tr></thead>
    <tbody>
      <tr><th id="r0" scope="row">美金</th><td id="a1">31.2</td></tr>
      <tr><th id="r1" scope="row">日圓</th><td id="b1">0.21</td></tr>
    </tbody>
  </table>
  <div id="plain">今日總量 1,234</div>`

async function boot(opts = {}, reduceMotion = false) {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  globalThis.FocusEvent = jd.window.FocusEvent
  jd.window.matchMedia = (q) => ({
    matches: reduceMotion && /prefers-reduced-motion/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}
  })
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t'), ...opts })
  return { doc, pm, win: jd.window }
}

const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))

test('F2-1 表格資料格上的指標是 cell，表頭是 pointer 並帶提示', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('a1'))
  assert.equal(doc.body.style.cursor, 'cell', `資料格要看得出可以點選，實得 ${JSON.stringify(doc.body.style.cursor)}`)
  move(win, doc.getElementById('h1'))
  assert.equal(doc.body.style.cursor, 'pointer')
  assert.equal(doc.getElementById('h1').getAttribute('title'), '選整欄')
  move(win, doc.getElementById('r1'))
  assert.equal(doc.getElementById('r1').getAttribute('title'), '選整列')
  pm.exitPickMode()
})

test('F2-1 非表格元素上的指標是 crosshair', async () => {
  const { doc, pm, win } = await boot({ initialTarget: null })
  move(win, doc.getElementById('plain'))
  assert.equal(doc.body.style.cursor, 'crosshair')
  pm.exitPickMode()
})

test('F2-1 網頁自己的 title 要原樣還回去，不能被我們覆蓋掉', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('h1'))
  assert.equal(doc.getElementById('h1').getAttribute('title'), '選整欄')
  pm.exitPickMode()
  assert.equal(doc.getElementById('h1').getAttribute('title'), '點此排序',
    '把人家網頁的提示永久改掉，重新整理才會回來')
})

test('F2-1 離開選取模式時指標與表頭提示都要還原', async () => {
  const { doc, pm, win } = await boot()
  doc.body.style.cursor = 'wait'
  pm.exitPickMode()
  const b = await boot()
  move(b.win, b.doc.getElementById('r1'))
  assert.equal(b.doc.getElementById('r1').getAttribute('title'), '選整列', '先確認提示真的加上去了')
  b.pm.exitPickMode()
  assert.equal(b.doc.body.style.cursor, '', `實得 ${JSON.stringify(b.doc.body.style.cursor)}`)
  assert.equal(b.doc.getElementById('r1').hasAttribute('title'), false, '提示是我們加的，要收乾淨')
  void doc; void win
})

test('F2-2 面板與工具列的按鈕聚焦時有看得見的焦點環', async () => {
  const { doc, pm } = await boot()
  const btn = doc.querySelector('[data-af-tool]')
  btn.dispatchEvent(new globalThis.FocusEvent('focus', { bubbles: true }))
  assert.notEqual(btn.style.outline, '', '鍵盤使用者要看得出焦點在哪')
  btn.dispatchEvent(new globalThis.FocusEvent('blur', { bubbles: true }))
  assert.equal(btn.style.outline, '')
  pm.exitPickMode()
})

test('F2-2 面板與工具列的按鈕點得到焦點（不然焦點環是死規則）', async () => {
  const { doc, pm, win } = await boot()
  for (const sel of ['[data-af-done]', '[data-af-cancel]', '[data-af-tool]']) {
    const el = doc.querySelector(sel)
    assert.equal(el.tagName, 'BUTTON', `${sel} 要是真的按鈕`)
    // 選取模式對頁面上的 mousedown 一律 preventDefault（避免頁面反應），
    // 但對自己的按鈕不能這樣做，否則瀏覽器不會把焦點給它
    const ev = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    el.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, false, `${sel} 的 mousedown 被擋掉就永遠拿不到焦點`)
  }
  // 頁面上的元素仍要擋（點到連結或按鈕會讓頁面跑掉）
  const pageEv = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
  doc.getElementById('a1').dispatchEvent(pageEv)
  assert.equal(pageEv.defaultPrevented, true, '頁面上的 mousedown 還是要擋')
  pm.exitPickMode()
})

test('F2-2 焦點停在取消鈕上時按 Enter 不得變成送出', async () => {
  const { doc, pm, win } = await boot()
  const cancel = doc.querySelector('[data-af-cancel]')
  cancel.focus()
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const msgs = globalThis.chrome.__calls
    .filter(x => x.api === 'runtime.sendMessage')
    .map(x => x.args[0])
    .filter(m => m?.type === 'PICKED' && !m.cancelled)
  assert.equal(msgs.length, 0, '焦點在取消上卻送出，是鍵盤使用者最容易踩到的陷阱')
  pm.exitPickMode()
})

test('F2-3 待選標示有過渡；使用者要求減少動態時不加', async () => {
  const { doc, pm, win } = await boot()
  move(win, doc.getElementById('a1'))
  assert.notEqual(doc.getElementById('a1').style.transition, '', '狀態切換要看得出來')
  pm.exitPickMode()

  const r = await boot({}, true)
  move(r.win, r.doc.getElementById('a1'))
  assert.equal(r.doc.getElementById('a1').style.transition, '', 'prefers-reduced-motion 要尊重')
  r.pm.exitPickMode()
})
