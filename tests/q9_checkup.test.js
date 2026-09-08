// AF-8 體檢輪：換模型後的獨立審查抓到的問題，每條一個迴歸測試
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { extractValue } from '../src/shared/extract.js'

const PAGE = `
  <div id="wrap">
    <div id="plain">今日總量 1,234</div>
    <table id="t">
      <thead><tr><th id="h0">幣別</th><th id="h1">買入</th><th id="h2">賣出</th></tr></thead>
      <tbody>
        <tr><td id="r0">美金</td><td id="a1">31.2</td><td id="a2">31.8</td></tr>
        <tr><td id="r1">日圓</td><td id="b1">0.21</td><td id="b2">0.22</td></tr>
      </tbody>
    </table>
  </div>
  <table id="outer"><tbody>
    <tr><td id="oc1">15.122</td><td><table id="inner"><tbody><tr><td id="i1">25757</td><td id="i2">39806</td></tr></tbody></table></td></tr>
  </tbody></table>`

async function bootPick(opts = {}) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('t'), ...opts })
  return { c, doc, pm, win: jd.window }
}
const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
const click = (win, el, init = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ...init }))
const key = (doc, win, k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }))
const picked = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).filter(m => m?.type === 'PICKED' && !m.cancelled)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''

test('點過工具列按鈕之後，Enter 仍然能送出', async () => {
  const { c, doc, pm, win } = await bootPick()
  const col = doc.querySelector('[data-af-tool="col"]')
  col.focus()
  click(win, col)
  move(win, doc.getElementById('a1'))
  key(doc, win, 'Enter')
  assert.equal(picked(c).length, 1, '碰過工具列後 Enter 永久失效是鍵盤流程的死路')
  pm.exitPickMode()
})

test('鎖定了表格外的元素之後按 ↓ 回到表格，鎖要放掉（否則 hover 從此凍住）', async () => {
  const { doc, pm, win } = await bootPick()
  move(win, doc.getElementById('a1'))          // 表格模式
  key(doc, win, 'ArrowUp')                      // 到 #wrap（非表格）
  click(win, doc.getElementById('wrap'))        // 鎖定 #wrap
  assert.ok(/已鎖定/.test(panelText(doc)), '先確認鎖上了')
  key(doc, win, 'ArrowDown')                    // 回到表格
  move(win, doc.getElementById('b2'))
  assert.equal(doc.getElementById('b2').hasAttribute('data-af-cell'), true, '回到表格後 hover 標示要能動')
  pm.exitPickMode()
})

test('內層表格已選一格之後，Ctrl 點外層格子不得混進另一張表的索引', async () => {
  const { c, doc, pm, win } = await bootPick({ initialTarget: null })
  move(win, doc.getElementById('i1'))
  click(win, doc.getElementById('i1'))
  assert.equal(pm.selectedCount(), 1)
  move(win, doc.getElementById('oc1'))
  click(win, doc.getElementById('oc1'), { ctrlKey: true })
  assert.equal(pm.selectedCount(), 1, '外層那一格屬於另一張表，不能加進內層表的清單')
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg.picks.length, 1)
  assert.equal(msg.preview, '25757', '送出的仍是內層那一格')
  pm.exitPickMode()
})

test('滑鼠停在表頭上按 Enter，送出的是整欄而不是上一格殘留的索引', async () => {
  const { c, doc, pm, win } = await bootPick()
  move(win, doc.getElementById('b2'))
  move(win, doc.getElementById('h1'))
  key(doc, win, 'Enter')
  const p = picked(c)[0].picks[0]
  assert.ok(p.block, `畫面標的是整欄，送出的卻是別的東西：${JSON.stringify(p)}`)
  assert.equal(p.block.axis, 'col')
  assert.equal(p.block.headerText, '買入')
  pm.exitPickMode()
})

// ---- Picker ----
const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
async function freshPicker() {
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
const ctx2 = {
  locator: { css: '#t' }, url: 'https://twse.test/p', nameHint: '市場成交資訊',
  blockInfo: { kind: 'table', rows: 5, cols: 3 },
  picks: [
    { cell: { row: { index: 4, header: '115/09/07' }, col: { index: 2, header: '成交金額' } } },
    { cell: { row: { index: 4, header: '115/09/07' }, col: { index: 1, header: '成交股數' } } }
  ]
}

test('值上移之後改定位方式，名稱要跟著各自那一列的值重算，不會錯位', async () => {
  const { pk, doc, win } = await freshPicker()
  pk.render(ctx2)
  const rows = doc.querySelectorAll('#field-list [data-field-row]')
  rows[1].querySelector('[data-field-up]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  $(doc, 'row-pos').value = 'last'
  $(doc, 'row-pos').dispatchEvent(new win.Event('change', { bubbles: true }))
  const names = Array.from(doc.querySelectorAll('#field-list [data-field-row] input[data-field-name]')).map(i => i.value)
  assert.deepEqual(names, ['成交股數（最後一列）', '成交金額（最後一列）'], `實得 ${JSON.stringify(names)}`)
})

test('儲存途中失敗，按鈕要還回去且錯誤看得到', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1', tabId: 9 })
  $(doc, 'name').value = '總量'
  $(doc, 'times').value = '09:30'
  for (const cb of doc.querySelectorAll('#weekdays input[type="checkbox"]')) cb.checked = true
  globalThis.chrome.runtime.sendMessage = async () => { throw new Error('service worker 已被回收') }
  await pk.handleSave()
  assert.equal($(doc, 'save').disabled, false, '永遠的「儲存中…」')
  assert.ok(/儲存失敗/.test($(doc, 'errors').textContent), `實得 ${JSON.stringify($(doc, 'errors').textContent)}`)
})

test('單格＋整欄混合時，欄定位不得被停用', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ ...ctx2, picks: [ctx2.picks[0], { block: { axis: 'col', index: 1, headerText: '成交股數' } }] })
  assert.equal($(doc, 'col-pos').disabled, false, '儲存格的欄定位是有意義的')
})

test('停用的定位下拉，理由要出現在看得到的提示裡', async () => {
  const { pk, doc } = await freshPicker()
  pk.render({ ...ctx2, picks: [{ block: { axis: 'col', index: 2, headerText: '成交金額' } }] })
  assert.ok(/自己點的/.test($(doc, 'pos-hint').textContent), `實得 ${JSON.stringify($(doc, 'pos-hint').textContent)}`)
})

test('按過「不需要」之後再 render 一次，框架提示不再跳出', async () => {
  const { pk, doc, win } = await freshPicker()
  const ctx = { locator: { css: '#v' }, url: 'https://a.test/p', preview: '1', frameUrl: 'https://w.example/f.html' }
  pk.render(ctx)
  $(doc, 'frame-hint-dismiss').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  pk.render(ctx)
  assert.equal($(doc, 'frame-hint').hidden, true)
})

// ---- background ----
test('整欄改重選成整列時，掛在另一軸的位置不得照搬；儲存格改整欄時列的位置要搬過去', async () => {
  resetChromeMock(); installChromeMock(); globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const sender = { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0 }
  const base = { id: 't1', name: 'x', url: 'https://a.test/p', mode: 'block', enabled: true,
    locator: { css: '#t' }, schedule: { type: 'daily', times: ['09:30'], weekdays: [1] } }

  await st.saveTask({ ...base, spec: { mode: 'block', block: { axis: 'col', index: 2, headerText: '成交金額', pos: 'last', aggregate: 'sum' } } })
  await bg.handleMessage({ type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [{ block: { axis: 'row', index: 0, headerText: '115/09/01' } }] }, sender)
  let back = await st.getTask('t1')
  assert.equal(back.spec.block.pos, undefined, '「最後一列」搬到整列上會變成「最後一欄」')

  await st.saveTask({ ...base, spec: { mode: 'block', block: { cell: { row: { pos: 'last' }, col: { index: 2, header: '成交金額' } } } } })
  await bg.handleMessage({ type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [{ block: { axis: 'col', index: 2, headerText: '成交金額' } }] }, sender)
  back = await st.getTask('t1')
  assert.equal(back.spec.block.pos, 'last', '整欄要的正是列的位置')
})

test('整欄＋位置的擷取結果要帶 partial', () => {
  const dom = new JSDOM(`<!doctype html><body><table id="t">
    <thead><tr><th>日期</th><th>值</th></tr></thead>
    <tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table></body>`)
  const t = dom.window.document.getElementById('t')
  const res = extractValue(t, { mode: 'block', block: { axis: 'col', index: 1, headerText: '值', pos: 'last', aggregate: 'sum' } })
  assert.equal(res.ok, true)
  assert.equal(typeof res.partial, 'boolean', '正常聚合路徑帶 partial，這條不帶就少了標記')
})
