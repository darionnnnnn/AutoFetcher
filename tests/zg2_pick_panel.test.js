// AF-21 段 7-B：選取模式——面板與工具列不擋不溢出、頁面重繪後不送出失效的選取、隱藏操作的提示
// 1. 面板直向彈性版面：動作列不在可捲動內容區裡，組數多時三顆鈕仍在內容區之後
// 2. 工具列比照面板閃避（同一份判定、同樣的遲滯）
// 3. 已選的表整個被換掉（SPA 重繪）→ 完成／雙擊／Enter 都不送、提示、清空；之後在新表上照常送出
// 4. describe 對脫離文件的節點不產生 path／xpath
// 5. 範圍／全選提示、網頁元件說明、中鍵攔截、完成鈕雙擊只送一次
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { describe as describeEl, resolve } from '../src/shared/selector.js'

const tableHtml = (id, rows = 3, tag = '') => `
  <table id="${id}">
    <thead><tr><th>名稱</th><th>買入</th><th>賣出</th></tr></thead>
    <tbody>${Array.from({ length: rows }, (_, r) =>
      `<tr><th scope="row">${tag}列${r}</th><td id="${id}-${r}-1">${r * 10 + 1}</td><td id="${id}-${r}-2">${r * 10 + 2}</td></tr>`).join('')}</tbody>
  </table>`

const PAGE = `<p id="para">說明文字</p>${tableHtml('t')}<a id="link" href="https://example.test/next">下一頁</a><div id="host"></div>`

async function boot(html, opts = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>測試頁</title></head><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body, ...opts })
  return { c, doc, pm, win: jd.window }
}
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
const pick = (win, el) => { fire(win, el, 'mousemove'); fire(win, el, 'click') }
const key = (doc, win, k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const picked = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  .filter(m => m?.type === 'PICKED' && !m.cancelled)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })

// ================= 1. 面板結構 =================

test('7B-1 批次 5 組各 10 個值：動作列不是內容區的子孫、位於內容區之後，內容區可捲且縮得下去', async () => {
  const html = [1, 2, 3, 4, 5].map(k => tableHtml(`g${k}`, 5, `T${k}`)).join('')
  const { doc, pm, win } = await boot(html, { batch: true })
  for (const k of [1, 2, 3, 4, 5]) {
    for (let r = 0; r < 5; r++) {
      pick(win, doc.getElementById(`g${k}-${r}-1`))
      pick(win, doc.getElementById(`g${k}-${r}-2`))
    }
  }
  assert.equal(doc.querySelectorAll('[data-af-group]').length, 5, '前提：5 組')
  assert.equal(pm.selectedCount(), 50, '前提：各 10 個值')

  const panel = doc.querySelector('[data-af-panel]')
  const body = doc.querySelector('[data-af-panel-body]')
  const done = doc.querySelector('[data-af-done]')
  const actions = done.parentElement
  assert.equal(body.contains(actions), false, '動作列在可捲區裡就會跟著內容被捲走／推出視窗')
  assert.equal(actions.parentElement, panel)
  assert.equal(panel.style.display, 'flex')
  assert.equal(panel.style.flexDirection, 'column')
  assert.match(body.style.minHeight, /^0(px)?$/, 'flex 子項沒有 min-height:0 就縮不下去，overflow 形同虛設')
  assert.equal(body.style.overflowY, 'auto')
  assert.match(actions.style.flex, /^0 0 auto$/, '動作列不得被壓縮')
  for (const sel of ['[data-af-done]', '[data-af-cancel]', '[data-af-undo]']) {
    const btn = panel.querySelector(sel)
    assert.ok(btn, `${sel} 要在 DOM 裡`)
    assert.ok(body.compareDocumentPosition(btn) & win.Node.DOCUMENT_POSITION_FOLLOWING, `${sel} 要排在內容區之後`)
  }
  const lists = [...doc.querySelectorAll('[data-af-chip-list]')]
  assert.equal(lists.length, 5)
  for (const l of lists) assert.equal(l.style.maxHeight, '', '每組不再各自 40vh，由內容區統一捲動')
  pm.exitPickMode()
})

// ================= 2. 工具列閃避 =================

test('7B-2 游標移到工具列所在角落 → 換到左側；原地再動不彈回；移開後也不亂跳', async () => {
  const { doc, pm, win } = await boot(PAGE)
  const toolbar = doc.querySelector('[data-af-toolbar]')
  toolbar.getBoundingClientRect = () => rect(900, 16, 280, 30)
  const cell = doc.getElementById('t-0-1')
  assert.equal(toolbar.style.right, '16px')

  fire(win, cell, 'mousemove', { clientX: 1000, clientY: 30 })
  assert.equal(toolbar.style.left, '16px', '游標壓在工具列的位置上要讓開')
  assert.equal(toolbar.style.right, '')

  fire(win, cell, 'mousemove', { clientX: 1002, clientY: 31 })
  assert.equal(toolbar.style.left, '16px', '只再動一次：換角後游標還在原處不得翻回去')

  fire(win, cell, 'mousemove', { clientX: 300, clientY: 400 })
  assert.equal(toolbar.style.left, '16px', '移開之後不亂跳')
  assert.equal(toolbar.style.right, '')
  pm.exitPickMode()
})

test('7B-2b 滑鼠停著的那一格被工具列蓋住 → 工具列讓開；exitPickMode 後角落狀態重設', async () => {
  const { doc, pm, win } = await boot(PAGE)
  let toolbar = doc.querySelector('[data-af-toolbar]')
  toolbar.getBoundingClientRect = () => rect(900, 16, 280, 30)
  const cell = doc.getElementById('t-0-1')
  cell.getBoundingClientRect = () => rect(950, 20, 60, 20)
  fire(win, cell, 'mousemove', { clientX: 960, clientY: 60 })   // 游標不在工具列上，但格子被蓋住
  fire(win, cell, 'mousemove', { clientX: 961, clientY: 60 })
  assert.equal(toolbar.style.left, '16px', '要抓的那一格在工具列底下，工具列要讓開')

  pm.exitPickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  toolbar = doc.querySelector('[data-af-toolbar]')
  toolbar.getBoundingClientRect = () => rect(900, 16, 280, 30)
  assert.equal(toolbar.style.right, '16px')
  fire(win, doc.getElementById('para'), 'mousemove', { clientX: 1000, clientY: 30 })
  assert.equal(toolbar.style.left, '16px', '重進之後第一次靠近要往左閃（角落與鎖定狀態已重設）')
  pm.exitPickMode()
})

// ================= 3. 頁面重繪後不送出失效的選取 =================

async function pickTwoThenReplace() {
  const env = await boot(PAGE)
  const { doc, win, pm } = env
  pick(win, doc.getElementById('t-0-1'))
  pick(win, doc.getElementById('t-1-1'))
  assert.equal(pm.selectedCount(), 2, '前提：選了兩格')
  const holder = doc.createElement('div')
  holder.innerHTML = tableHtml('n')
  const fresh = holder.firstElementChild
  doc.getElementById('t').replaceWith(fresh)
  return { ...env, fresh }
}

function assertBlocked({ c, doc, pm }, how) {
  assert.equal(picked(c).length, 0, `${how}：表格已被換掉，不得送出`)
  assert.match(panelText(doc), /頁面剛剛更新過，請重新點選/, `${how}：要說出為什麼沒送出`)
  assert.equal(pm.selectedCount(), 0, `${how}：已失效的選取要清掉`)
  assert.equal(doc.querySelectorAll('[data-af-chip]').length, 0)
  assert.equal(pm.isActive(), true, `${how}：還在選取模式裡讓使用者重點`)
}

async function assertRepickWorks({ c, doc, win, pm, fresh }) {
  pick(win, doc.getElementById('n-2-2'))
  assert.equal(pm.selectedCount(), 1, '新表上照常加選（沒有殘留舊表的鎖／索引）')
  assert.doesNotMatch(panelText(doc), /頁面剛剛更新過/, '重點之後提示要收掉')
  fire(win, doc.querySelector('[data-af-done]'), 'click')
  const sent = picked(c)
  assert.equal(sent.length, 1)
  assert.equal(resolve(doc, sent[0].locator).el, fresh, 'locator 對應新表')
  assert.deepEqual(sent[0].picks.map(p => [p.cell.row.index, p.cell.col.index]), [[2, 2]], '只帶新表上點的那一格')
}

test('7B-3a 完成鈕：表格被 replaceWith 之後零 PICKED、提示、清空；之後在新表上正常送出', async () => {
  const env = await pickTwoThenReplace()
  fire(env.win, env.doc.querySelector('[data-af-done]'), 'click')
  assertBlocked(env, '完成鈕')
  await assertRepickWorks(env)
})

test('7B-3b 雙擊：表格被換掉之後零 PICKED、提示、清空；之後在新表上正常送出', async () => {
  const env = await pickTwoThenReplace()
  fire(env.win, env.fresh.querySelector('#n-0-1'), 'dblclick')
  assertBlocked(env, '雙擊')
  await assertRepickWorks(env)
})

test('7B-3c Enter：表格被換掉之後零 PICKED、提示、清空；之後在新表上正常送出', async () => {
  const env = await pickTwoThenReplace()
  key(env.doc, env.win, 'Enter')
  assertBlocked(env, 'Enter')
  await assertRepickWorks(env)
})

test('7B-3d 批次模式：失效的那一組被清掉、不送出；還在的那一組保留', async () => {
  const { c, doc, pm, win } = await boot(PAGE + tableHtml('k'), { batch: true })
  pick(win, doc.getElementById('t-0-1'))
  pick(win, doc.getElementById('k-0-1'))
  pick(win, doc.getElementById('k-1-1'))
  assert.equal(doc.querySelectorAll('[data-af-group]').length, 2, '前提：兩組')
  const holder = doc.createElement('div')
  holder.innerHTML = tableHtml('n')
  doc.getElementById('t').replaceWith(holder.firstElementChild)
  key(doc, win, 'Enter')
  assert.equal(picked(c).length, 0)
  assert.match(panelText(doc), /頁面剛剛更新過/)
  assert.equal(pm.selectedCount(), 2, '還連在文件上的那一組不該被連坐清掉')
  key(doc, win, 'Enter')
  const sent = picked(c)
  assert.equal(sent.length, 1)
  assert.equal(resolve(doc, sent[0].locator).el, doc.getElementById('k'), '剩下的那一組照常送出')
})

// ================= 4. describe 守門 =================

test('7B-4 describe：脫離文件的節點 path／xpath 為空字串；連在文件上的照舊', () => {
  const doc = new JSDOM('<!doctype html><html><body><div><p>a</p><p id="x">b</p></div></body></html>').window.document
  const p = doc.querySelectorAll('p')[1]
  const live = describeEl(p)
  assert.equal(live.path, 'html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(2)')
  assert.equal(live.xpath, '/html[1]/body[1]/div[1]/p[2]')
  const div = doc.querySelector('div')
  div.remove()
  const gone = describeEl(p)
  assert.equal(gone.path, '')
  assert.equal(gone.xpath, '')
  assert.equal(gone.css, '#x', '其他層不受影響')
  const loose = doc.createElement('span')
  assert.deepEqual([describeEl(loose).path, describeEl(loose).xpath], ['', ''], '從沒接上文件的節點也一樣')
})

// ================= 5. 提示與防誤觸 =================

test('7B-5a 已選 1 格後提示區有 Shift／Ctrl+A 那一行（選之前沒有）', async () => {
  const { doc, pm, win } = await boot(PAGE)
  fire(win, doc.getElementById('t-0-1'), 'mousemove')
  assert.doesNotMatch(panelText(doc), /Shift＋點可以拉出範圍，Ctrl\+A 全選/)
  fire(win, doc.getElementById('t-0-1'), 'click')
  assert.match(panelText(doc), /Shift＋點可以拉出範圍，Ctrl\+A 全選/)
  pm.exitPickMode()
})

test('7B-5b 目標是網頁元件（shadow DOM）→ 面板說明只能整塊抓', async () => {
  const { doc, pm, win } = await boot(PAGE)
  const host = doc.getElementById('host')
  const root = host.attachShadow({ mode: 'open' })
  const inner = doc.createElement('span')
  inner.textContent = '42'
  root.appendChild(inner)
  fire(win, doc.getElementById('para'), 'mousemove')
  assert.doesNotMatch(panelText(doc), /網頁元件/)
  fire(win, host, 'mousemove')
  assert.match(panelText(doc), /這個區塊在網頁元件裡，只能整塊抓，選不到裡面的格子/)
  pm.exitPickMode()
})

test('7B-5c 頁面連結上的中鍵 auxclick 被擋；overlay 自己的元素不擋；離開後不再擋', async () => {
  const { doc, pm, win } = await boot(PAGE)
  const link = doc.getElementById('link')
  const e1 = new win.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  link.dispatchEvent(e1)
  assert.equal(e1.defaultPrevented, true, '中鍵點連結會開新分頁把使用者帶走')
  const e2 = new win.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  doc.querySelector('[data-af-done]').dispatchEvent(e2)
  assert.equal(e2.defaultPrevented, false, 'overlay 自己的按鈕不擋')
  pm.exitPickMode()
  const e3 = new win.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
  link.dispatchEvent(e3)
  assert.equal(e3.defaultPrevented, false, '離開選取模式後監聽要拆掉')
})

test('7B-5d 在完成鈕上雙擊（click、click、dblclick）只送出一次', async () => {
  const { c, doc, win } = await boot(PAGE)
  pick(win, doc.getElementById('t-0-1'))
  const done = doc.querySelector('[data-af-done]')
  fire(win, done, 'click', { detail: 1 })
  fire(win, done, 'click', { detail: 2 })
  fire(win, done, 'dblclick', { detail: 2 })
  assert.equal(picked(c).length, 1)
})

test('7B-5e 批次模式在面板上雙擊不送出（按鈕上的連按不是頁面雙擊）', async () => {
  const { c, doc, pm, win } = await boot(PAGE, { batch: true })
  pick(win, doc.getElementById('t-0-1'))
  fire(win, doc.querySelector('[data-af-panel-body]'), 'dblclick')
  fire(win, doc.querySelector('[data-af-cancel]'), 'dblclick')
  assert.equal(picked(c).length, 0)
  pm.exitPickMode()
})
