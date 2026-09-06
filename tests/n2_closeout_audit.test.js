// AF-5 體檢輪:獨立程式碼稽核抓到的問題
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

const multi = () => ({
  id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
  locator: { css: '#rate' },
  spec: {
    strategy: 'auto', mode: 'block',
    fields: [
      { key: 'k1', cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
      { key: 'k2', cell: { row: { index: 0, header: '美金' }, col: { index: 2, header: '賣出' } } }
    ]
  },
  fields: [{ key: 'k1', name: '美金買入' }, { key: 'k2', name: '美金賣出' }],
  schedule: { type: 'daily', times: ['09:30'] }
})

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  return { c, st }
}
const sendTo = (c, msg, sender = {}) => new Promise((resolve, reject) => {
  const ret = [...c.runtime.onMessage._listeners][0](msg, sender, resolve)
  if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
})

// ---- 1. 重選後選好的值要寫回任務 ----

test('重選時加了一個值、拿掉一個值，任務要跟著變', async () => {
  const { c, st } = await freshBg()
  await st.saveTask(multi())
  await sendTo(c, {
    type: 'PICKED', purpose: 'repick', taskId: 'bank', locator: { css: '#rate2' },
    blockInfo: { kind: 'table' },
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },   // 原本的 k1
      { cell: { row: { index: 1, header: '日圓' }, col: { index: 1, header: '買入' } } }    // 新的
    ]
  }, { tab: { id: 3, url: 'https://bank.test/rate' } })
  const t = await st.getTask('bank')
  assert.equal(t.locator.css, '#rate2', '定位要更新')
  assert.equal(t.fields.length, 2)
  assert.equal(t.fields[0].key, 'k1', '沒動的值要保留原本的 key（紀錄靠它）')
  assert.equal(t.fields[0].name, '美金買入', '沒動的值名稱也要保留')
  assert.ok(t.fields[1].key && t.fields[1].key !== 'k2', '新值要有新的 key')
  assert.ok(t.fields[1].name.includes('日圓'), `新值要有預設名稱：${t.fields[1].name}`)
  assert.deepEqual(t.spec.fields.map(f => f.key), t.fields.map(f => f.key), '規格與清單要對得起來')
  assert.equal(t.spec.block, undefined)
})

test('單值任務重選另一欄，規格要跟著換', async () => {
  const { c, st } = await freshBg()
  await st.saveTask({
    id: 't1', name: '用電', url: 'https://x.test/a', mode: 'block', enabled: true,
    locator: { css: '#t' },
    spec: { strategy: 'auto', mode: 'block', block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'avg' } },
    schedule: { type: 'daily', times: ['09:30'] }
  })
  await sendTo(c, {
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    blockInfo: { kind: 'table' },
    picks: [{ block: { axis: 'col', index: 2, headerText: '金額' } }]
  }, { tab: { id: 3 } })
  const t = await st.getTask('t1')
  assert.equal(t.spec.block.headerText, '金額')
  assert.equal(t.spec.block.aggregate, 'avg', '聚合方式沿用原本的')
  assert.equal(t.fields, undefined)
})

// ---- 3. Picker 開場的順序 ----

test('Picker 初始化要先建好儀表板下拉再套記住的預設值，且不得被預設卡片型別蓋掉', () => {
  const src = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  const boot = src.slice(src.indexOf("params.has('ctx')"))
  const iDash = boot.indexOf('renderDashboardSection(')
  const iDef = boot.indexOf('applyPickerDefaults(')
  assert.ok(iDash > -1 && iDef > -1)
  assert.ok(iDash < iDef, '下拉還沒建好就套 dashboardId，記住的儀表板會靜默不還原')
  assert.ok(/await renderDashboardSection\(/.test(boot), '兩個 promise 並行會互踩，要等前一個做完')
})

// ---- 4. 抽屜不得重排使用者調過的欄序 ----

test('欄序被使用者調成跨任務交錯後，改任何設定都不能把它排回去', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(multi())
  await st.saveTask({ id: 'p', name: '用電', url: 'https://x.test/p', mode: 'number', enabled: true, spec: {}, schedule: { type: 'daily', times: ['09:30'] } })
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  const card = await ls.addCard(did, {
    type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 'bank#k1' }, { taskId: 'p' }, { taskId: 'bank#k2' }], options: { mode: 'pivot' }
  })
  await db.renderDashboard(did)
  await dw.openDrawer(did, card.id)
  const title = jd.window.document.getElementById('drawer-title')
  title.value = '改個標題'
  title.dispatchEvent(new jd.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const after = (await ls.getLayout()).dashboards[0].cards.find(c => c.id === card.id)
  assert.deepEqual(after.source.map(s => s.taskId), ['bank#k1', 'p', 'bank#k2'],
    '來源清單是依任務分組畫的，用它的 DOM 順序重建就把使用者的欄序洗掉了')
})

// ---- 5/7. 側欄收合與搜尋、拖曳互不干擾 ----

async function palette() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(multi())
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  await db.renderDashboard((await ls.getLayout()).dashboards[0].id)
  jd.window.document.getElementById('edit-layout').click()
  await new Promise(r => setTimeout(r, 30))
  return { doc: jd.window.document, win: jd.window }
}

test('收合後搜尋再清空，仍維持收合', async () => {
  const { doc, win } = await palette()
  doc.querySelector('[data-palette-toggle]').click()
  assert.equal(doc.querySelector('[data-palette-series]').hidden, true)
  const search = doc.getElementById('palette-search')
  search.value = '美金'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  search.value = ''
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  assert.equal(doc.querySelector('[data-palette-series]').hidden, true, '搜尋清空不該把收合的展開')
  doc.querySelector('[data-palette-toggle]').click()
  assert.equal(doc.querySelector('[data-palette-series]').hidden, false, '再點一次要真的展開')
})

test('收合把手不是拖曳的起點', async () => {
  const { doc, win } = await palette()
  const toggle = doc.querySelector('[data-palette-toggle]')
  const ev = new win.Event('pointerdown', { bubbles: true, cancelable: true })
  let reachedParent = false
  toggle.closest('[data-palette-task]').addEventListener('pointerdown', () => { reachedParent = true })
  toggle.dispatchEvent(ev)
  assert.equal(reachedParent, false, '按在把手上的 pointerdown 一旦冒泡到父列，拖曳會把 click 吃掉')
})

// ---- 6. 診斷看得懂 ----

test('多值抓取的診斷是一行看得懂的字，而且沒失敗就不寫', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(multi())
  c.__setTabResponder(() => ({ ok: true, fields: { k1: { ok: true, value: 1, raw: '1', status: 'ok' }, k2: { ok: true, value: 2, raw: '2', status: 'ok' } } }))
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  assert.equal((await st.getDiagList()).filter(d => d.kind === 'fetch_fields').length, 0, '全成功不該占環形緩衝（500 筆會把看門狗擠掉）')
  c.__setTabResponder(() => ({ ok: true, fields: { k1: { ok: true, value: 1, raw: '1', status: 'ok' }, k2: { ok: false, error: 'not_found' } } }))
  await fe.runTask(multi(), { slot: '2026-09-06T09:31', ...FAST })
  const entry = (await st.getDiagList()).find(d => d.kind === 'fetch_fields')
  assert.ok(entry)
  assert.equal(typeof entry.detail, 'string', '設定頁用字串串接，物件會印成 [object Object]')
  assert.ok(entry.detail.includes('美金賣出'))
})

// ---- 9. 移除值之後要重算 ----

test('拿掉唯一的整欄值後，聚合下拉要跟著消失', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render({
    url: 'https://bank.test/rate', locator: { css: '#rate' }, blockInfo: { kind: 'table', rows: 2, cols: 5 },
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
      { cell: { row: { index: 0, header: '美金' }, col: { index: 2, header: '賣出' } } },
      { block: { axis: 'col', index: 1, headerText: '買入' } }
    ]
  })
  const doc = jd.window.document
  const aggRow = doc.getElementById('block-aggregate').closest('label')
  assert.equal(aggRow.hidden, false)
  const rows = [...doc.querySelectorAll('[data-field-row]')]
  rows[2].querySelector('[data-field-remove]').click()
  assert.equal(aggRow.hidden, true, '沒有整欄的值了就沒東西要聚合')
})

// ---- 13. 巢狀表格 ----

test('在內層表格選了值，滑鼠移到外層表格不清空', async () => {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(`<!doctype html><body>
    <table id="outer"><tbody><tr><td id="o0">外</td><td>
      <table id="inner"><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td id="i0">1</td><td id="i1">2</td></tr></tbody></table>
    </td></tr></tbody></table></body>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('inner') })
  doc.getElementById('i1').dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  doc.getElementById('i1').dispatchEvent(new jd.window.MouseEvent('click', { bubbles: true, shiftKey: true }))
  assert.equal(pm.selectedCount(), 1)
  doc.getElementById('o0').dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  assert.equal(pm.selectedCount(), 1, '外層包著內層，不是換到另一張表')
  pm.exitPickMode()
})

// ---- 10/11/12. 死碼與重複 ----

test('沒有無人引用的匯出與三份一樣的範本提示', () => {
  const rs = readFileSync(new URL('../src/shared/record-status.js', import.meta.url), 'utf8')
  assert.ok(!/export const SUCCESS_STATUSES/.test(rs), '沒人 import 的匯出')
  const db = readFileSync(new URL('../src/ui/report/dashboard.js', import.meta.url), 'utf8')
  assert.ok((db.match(/tplRes\.applied === false/g) || []).length <= 1, '同一段提示貼三次')
  const se = readFileSync(new URL('../src/ui/report/series.js', import.meta.url), 'utf8')
  const body = se.slice(se.indexOf('export function withDelta'))
  assert.ok(!/raw\.value/.test(body), 'pivot 的值只會是數字，物件分支是死碼')
})
