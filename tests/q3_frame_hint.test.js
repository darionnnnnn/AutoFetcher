// AF-8 批次 D：目標在 iframe 內時提示加入前置步驟
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

const $ = (doc, id) => doc.getElementById(id)
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])

const baseCtx = (over = {}) => ({
  url: 'https://a.test/p',
  locator: { css: '#v' },
  preview: '1234',
  ...over
})

// ---------- D-1 顯示條件 ----------

test('D-1 目標在框架內且還沒有前置動作時顯示提示，並把進階設定展開', async () => {
  const { pk, doc } = await fresh()
  pk.render(baseCtx({ frameUrl: 'https://widget.example/chart.html?token=abc' }))
  const hint = $(doc, 'frame-hint')
  assert.ok(hint, '要有提示區塊')
  assert.equal(hint.hidden, false)
  assert.equal(hint.getAttribute('role'), 'status')
  assert.ok(/widget\.example/.test(hint.textContent), `要說出是哪個框架，實得 ${JSON.stringify(hint.textContent)}`)
  assert.ok(/新分頁/.test(hint.textContent), '要說明排程是開新分頁，不會沿用現在的畫面')
  assert.equal($(doc, 'advanced-section').hasAttribute('open'), true, '藏在收合區裡等於沒提示')
})

test('D-1 目標不在框架內時不顯示', async () => {
  const { pk, doc } = await fresh()
  pk.render(baseCtx())
  assert.equal($(doc, 'frame-hint').hidden, true)
})

test('D-1 編輯既有任務不顯示（使用者已經決定過了）', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: { css: '#v' },
    frameUrl: 'https://widget.example/chart.html',
    task: {
      id: 't1', name: '值', url: 'https://a.test/p', mode: 'number',
      frame: { url: 'https://widget.example/chart.html' },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
    }
  })
  assert.equal($(doc, 'frame-hint').hidden, true)
})

test('D-1 已經有前置動作時不再提示', async () => {
  const { pk, doc } = await fresh()
  pk.render(baseCtx({
    frameUrl: 'https://widget.example/chart.html',
    task: {
      id: 't1', name: '值', url: 'https://a.test/p', mode: 'number',
      preActions: [{ type: 'click', locator: { css: '#tab' } }],
      schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
    }
  }))
  assert.equal($(doc, 'frame-hint').hidden, true)
})

// ---------- D-2 加入點擊步驟 ----------

test('D-2 按「加入點擊步驟」會新增一列 click 並開始在頁面上選取', async () => {
  const { c, pk, doc, win } = await fresh()
  pk.render(baseCtx({ frameUrl: 'https://widget.example/chart.html', tabId: 9 }))
  click(win, $(doc, 'frame-hint-add'))

  const rows = doc.querySelectorAll('#preaction-list [data-preaction-row]')
  assert.equal(rows.length, 1, '要新增一列前置動作')
  assert.equal(rows[0].querySelector('select').value, 'click')

  const enter = sent(c).filter(m => m?.type === 'ENTER_PICK').pop()
  assert.ok(enter, '要直接進入選取模式，不要讓使用者自己再找一次按鈕')
  assert.equal(enter.purpose, 'preaction')
  assert.equal(enter.frameId, 0, '要點的按鈕常在最上層，進到 iframe 就選不到了')
})

test('D-2 按「不需要」就收起提示，且不影響儲存', async () => {
  const { pk, doc, win } = await fresh()
  pk.render(baseCtx({ frameUrl: 'https://widget.example/chart.html' }))
  click(win, $(doc, 'frame-hint-dismiss'))
  assert.equal($(doc, 'frame-hint').hidden, true)
  assert.equal(doc.querySelectorAll('#preaction-list [data-preaction-row]').length, 0)
  const values = pk.getFormData()
  assert.equal(values.preActions.length, 0)
})

// ---------- D-3 送出中的回饋 ----------

test('D-3 按下立即測試會停用按鈕並顯示進行中，結果回來才還原', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(baseCtx({ tabId: 9 }))
  let sawDisabled = false
  let sawLabel = ''
  c.__setResponder?.('runtime.sendMessage', () => {})
  const btn = $(doc, 'test-now')
  const orig = globalThis.chrome.runtime.sendMessage
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'TEST_TASK') {
      sawDisabled = btn.disabled
      sawLabel = btn.textContent
      return { ok: true, value: 42 }
    }
    return orig(msg)
  }
  await pk.handleTestNow()
  assert.equal(sawDisabled, true, '送出中不得讓使用者連按')
  assert.ok(/測試中/.test(sawLabel), `按鈕要說出正在做事，實得 ${JSON.stringify(sawLabel)}`)
  assert.equal(btn.disabled, false, '結果回來要還原')
  assert.equal(btn.textContent, '立即測試')
})

test('D-3 目標在框架內且沒有前置動作時，測試成功要說明排程是開新分頁', async () => {
  const { pk, doc } = await fresh()
  pk.render(baseCtx({ frameUrl: 'https://widget.example/chart.html', tabId: 9 }))
  globalThis.chrome.runtime.sendMessage = async (msg) =>
    (msg?.type === 'TEST_TASK' ? { ok: true, value: 42 } : undefined)
  await pk.handleTestNow()
  assert.equal($(doc, 'preview').getAttribute('data-state'), 'ok')
  assert.ok(/新分頁/.test($(doc, 'test-note').textContent),
    `實得 ${JSON.stringify($(doc, 'test-note').textContent)}`)
  assert.equal($(doc, 'errors').textContent, '', '這是說明不是錯誤，不該染紅')
})
