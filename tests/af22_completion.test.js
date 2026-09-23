// AF-22 作業 A：完成操作的可見性、固定位置與手動移位
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PAGE = `
  <table id="t">
    <thead><tr><th>名稱</th><th>數值</th></tr></thead>
    <tbody><tr><th>列一</th><td id="value">42</td></tr></tbody>
  </table>`

const rect = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top
})

async function boot({ hostileButtons = false } = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head>${hostileButtons ? '<style>button { font-size: 0 !important; color: transparent !important; width: 8px !important; }</style>' : ''}</head><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  return { c, doc, pm, win: jd.window }
}

const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
const sentPicked = (c) => c.__calls
  .filter(x => x.api === 'runtime.sendMessage')
  .map(x => x.args[0])
  .filter(m => m?.type === 'PICKED' && !m.cancelled)

test('AF-22A-1 游標靠近面板與工具列不會自動換邊', async () => {
  const { doc, pm, win } = await boot()
  const panel = doc.querySelector('[data-af-panel]')
  const toolbar = doc.querySelector('[data-af-toolbar]')
  const value = doc.getElementById('value')
  panel.getBoundingClientRect = () => rect(700, 500, 240, 120)
  toolbar.getBoundingClientRect = () => rect(700, 16, 240, 32)

  fire(win, value, 'mousemove', { clientX: 710, clientY: 510 })
  fire(win, value, 'mousemove', { clientX: 710, clientY: 20 })
  assert.equal(panel.style.right, '16px')
  assert.equal(panel.style.left, '')
  assert.equal(toolbar.style.right, '16px')
  assert.equal(toolbar.style.left, '')
  pm.exitPickMode()
})

test('AF-22A-2 面板與工具列提供可聚焦的手動移位，移位後游標不會反跳', async () => {
  const { doc, pm, win } = await boot()
  const panel = doc.querySelector('[data-af-panel]')
  const toolbar = doc.querySelector('[data-af-toolbar]')
  const value = doc.getElementById('value')
  const panelMove = panel.querySelector('[data-af-panel-move]')
  const toolbarMove = toolbar.querySelector('[data-af-toolbar-move]')
  for (const [name, btn] of [['面板', panelMove], ['工具列', toolbarMove]]) {
    assert.ok(btn, `${name} 要有手動移位按鈕`)
    assert.equal(btn.tagName, 'BUTTON')
    assert.ok(btn.textContent.trim(), `${name} 移位按鈕要有可見文字`)
    assert.ok(btn.getAttribute('aria-label')?.trim(), `${name} 移位按鈕要有 aria-label`)
    assert.ok(btn.tabIndex >= 0, `${name} 移位按鈕要可聚焦`)
  }
  assert.equal(panel.style.right, '16px')
  assert.equal(toolbar.style.right, '16px')

  fire(win, panelMove, 'click')
  fire(win, toolbarMove, 'click')
  assert.equal(panel.style.left, '16px')
  assert.equal(panel.style.right, '')
  assert.equal(toolbar.style.left, '16px')
  assert.equal(toolbar.style.right, '')

  panel.getBoundingClientRect = () => rect(16, 500, 240, 120)
  toolbar.getBoundingClientRect = () => rect(16, 16, 240, 32)
  fire(win, value, 'mousemove', { clientX: 20, clientY: 510 })
  fire(win, value, 'mousemove', { clientX: 20, clientY: 20 })
  assert.equal(panel.style.left, '16px')
  assert.equal(toolbar.style.left, '16px')
  pm.exitPickMode()
})

test('AF-22A-3 完成／取消／復原按鈕持續存在，有文字、aria-label 與可點尺寸', async () => {
  const { doc, pm } = await boot()
  const panel = doc.querySelector('[data-af-panel]')
  for (const sel of ['[data-af-done]', '[data-af-cancel]', '[data-af-undo]']) {
    const btn = panel.querySelector(sel)
    assert.ok(btn, `${sel} 要存在`)
    assert.ok(btn.textContent.trim(), `${sel} 文字不可空白`)
    assert.ok(btn.getAttribute('aria-label')?.trim(), `${sel} aria-label 不可空白`)
    assert.ok(parseInt(btn.style.minWidth, 10) >= 44, `${sel} min-width 要足夠`)
    assert.ok(parseInt(btn.style.minHeight, 10) >= 28, `${sel} min-height 要足夠`)
  }
  pm.exitPickMode()
})

test('AF-22A-4 宿主 button 樣式不能把操作文字變成透明小方塊', async () => {
  const { doc, pm } = await boot({ hostileButtons: true })
  const buttons = [...doc.querySelectorAll('[data-af-done], [data-af-cancel], [data-af-undo]')]
  for (const btn of buttons) {
    const css = doc.defaultView.getComputedStyle(btn)
    assert.notEqual(css.fontSize, '0px', `${btn.getAttribute('aria-label')} 字級不可被宿主 CSS 清成 0`)
    assert.notEqual(css.color, 'transparent', `${btn.getAttribute('aria-label')} 文字不可透明`)
    assert.ok(parseInt(css.minWidth, 10) >= 44, `${btn.getAttribute('aria-label')} min-width 不可縮成 8px`)
  }
  pm.exitPickMode()
})

test('AF-22A-5 完成操作只送出一則 PICKED', async () => {
  const { c, doc, pm, win } = await boot()
  const value = doc.getElementById('value')
  fire(win, value, 'mousemove')
  fire(win, value, 'click')
  const done = doc.querySelector('[data-af-done]')
  fire(win, done, 'click', { detail: 1 })
  fire(win, done, 'click', { detail: 2 })
  fire(win, done, 'dblclick', { detail: 2 })
  assert.equal(sentPicked(c).length, 1)
  assert.equal(pm.isActive(), false)
})
