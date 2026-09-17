// AF-18 批次 G-1：選取模式的「組」（右鍵「一次建立多個任務」）。一組＝一個定位目標＝將來的一個任務。
// 對照 docs/AF-18-PLAN.md 批次 G 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { resolve } from '../src/shared/selector.js'

const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
const PAGE = `
  <h2>匯率</h2>
  <table id="t">
    <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
    <tbody>
      <tr><th scope="row">美金</th><td id="a1">31.2</td><td id="a2">31.8</td></tr>
      <tr><th scope="row">日圓</th><td id="b1">0.21</td><td id="b2">0.22</td></tr>
      <tr><th scope="row">歐元</th><td id="c1">33.5</td><td id="c2">34.1</td></tr>
    </tbody>
  </table>
  <h2>庫存</h2>
  <table id="t2"><thead><tr><th>品項</th><th>數量</th></tr></thead>
    <tbody><tr><td>甲</td><td id="y1">7</td></tr><tr><td>乙</td><td id="y2">8</td></tr></tbody></table>
  <div id="plain">今日總量 1,234</div>`

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
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const pick = (win, el, init) => { fire(win, el, 'mousemove'); fire(win, el, 'click', init) }
const key = (doc, win, k, init = {}) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
const msgs = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const picked = (c) => msgs(c).filter(m => m?.type === 'PICKED' && !m.cancelled)
const panelText = (doc) => doc.querySelector('[data-af-panel]')?.textContent || ''
const cellKeys = (picks) => picks.map(p => `${p.cell.row.index},${p.cell.col.index}`)
const BATCH = { batch: true }

test('G1-1 批次模式：甲表兩格＋乙表一格＝兩組；甲表藍框仍在；送出 PICKED.batch 各帶各的 locator 與 picks', async () => {
  const { c, doc, pm, win } = await boot(PAGE, BATCH)
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  pick(win, doc.getElementById('y1'))
  for (const id of ['a1', 'b1', 'y1']) {
    assert.equal(doc.getElementById(id).hasAttribute('data-af-picked'), true, `${id} 要有藍框（每一組都要標）`)
  }
  assert.match(panelText(doc), /已選 2 個任務、共 3 個值/)
  assert.equal(doc.querySelectorAll('[data-af-group]').length, 2, 'chip 依組分段')
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg?.batch?.length, 2, JSON.stringify(msg))
  assert.equal(resolve(doc, msg.batch[0].locator).el, doc.getElementById('t'))
  assert.equal(resolve(doc, msg.batch[1].locator).el, doc.getElementById('t2'))
  assert.deepEqual(cellKeys(msg.batch[0].picks), ['0,1', '1,1'])
  assert.deepEqual(cellKeys(msg.batch[1].picks), ['0,1'])
  assert.equal(msg.batch[1].nameHint, '庫存', '每組各自算名稱提示')
  assert.equal(msg.picks, undefined, '批次的訊息不再放頂層 picks')
})

test('G1-2 回頭點甲表＝回到甲組繼續加；點非表格元素＝加成一組，再點＝移除', async () => {
  const { c, doc, pm, win } = await boot(PAGE, BATCH)
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('y1'))
  pick(win, doc.getElementById('c1'))
  pick(win, doc.getElementById('plain'))
  assert.match(panelText(doc), /已選 3 個任務/)
  pick(win, doc.getElementById('plain'))
  assert.match(panelText(doc), /已選 2 個任務/, '再點非表格元素＝移除那一組')
  pick(win, doc.getElementById('plain'))
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg.batch.length, 3)
  assert.deepEqual(cellKeys(msg.batch[0].picks), ['0,1', '2,1'], '甲組 2 個值')
  assert.equal(resolve(doc, msg.batch[2].locator).el, doc.getElementById('plain'))
  assert.equal(msg.batch[2].previewValue, 1234)
})

test('G1-3 值被移光的組自動消失；只剩一組時送單任務形狀，而且與非批次模式逐欄相同', async () => {
  const a = await boot(PAGE, BATCH)
  pick(a.win, a.doc.getElementById('a1'))
  pick(a.win, a.doc.getElementById('b1'))
  pick(a.win, a.doc.getElementById('y1'))
  pick(a.win, a.doc.getElementById('y1'))
  assert.match(panelText(a.doc), /已選 1 個任務/, '乙組被移光就消失')
  key(a.doc, a.win, 'Enter')
  const viaBatch = picked(a.c)[0]
  assert.equal(viaBatch.batch, undefined)

  const b = await boot(PAGE)
  pick(b.win, b.doc.getElementById('a1'))
  pick(b.win, b.doc.getElementById('b1'))
  key(b.doc, b.win, 'Enter')
  assert.deepEqual(viaBatch, picked(b.c)[0], '組裝 payload 只有一份')
})

test('G1-4 復原涵蓋整批：整組移除之後 Ctrl+Z，兩組都回來', async () => {
  const { doc, pm, win } = await boot(PAGE, BATCH)
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('b1'))
  pick(win, doc.getElementById('y1'))
  fire(win, doc.querySelector('[data-af-group="0"] [data-af-group-remove]'), 'click')
  assert.match(panelText(doc), /已選 1 個任務/, '前置：甲組整組移除')
  assert.equal(doc.getElementById('a1').hasAttribute('data-af-picked'), false)
  key(doc, win, 'z', { ctrlKey: true })
  assert.match(panelText(doc), /已選 2 個任務、共 3 個值/)
  assert.equal(doc.getElementById('a1').hasAttribute('data-af-picked'), true)
})

test('G1-5 組數上限 20：第 21 組被拒絕並說明，不得靜默丟掉', async () => {
  const tables = Array.from({ length: 21 }, (_, i) =>
    `<table id="x${i}"><tbody><tr><td id="v${i}">${i}</td><td>0</td></tr><tr><td>1</td><td>2</td></tr></tbody></table><p>間隔</p>`).join('')
  const { doc, pm, win } = await boot(tables, BATCH)
  for (let i = 0; i < 21; i++) pick(win, doc.getElementById(`v${i}`))
  assert.match(panelText(doc), /已選 20 個任務/)
  assert.match(panelText(doc), /一次最多建立 20 個任務/)
  assert.equal(doc.getElementById('v20').hasAttribute('data-af-picked'), false)
})

const WITH_FRAME = `<table id="t"><tbody><tr><td id="a1">1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>
  <iframe id="fr" src="https://b.example/w.html"></iframe>`

test('G1-6 框架：已經有組時不得鑽進 iframe（會丟掉這一批）；還沒有組時可以鑽，旗標帶下去', async () => {
  const a = await boot(WITH_FRAME, BATCH)
  pick(a.win, a.doc.getElementById('a1'))
  const proxy = a.doc.querySelector('[data-af-frame-proxy]')
  assert.ok(proxy, '前置：有代理層')
  pick(a.win, proxy)
  assert.equal(msgs(a.c).filter(m => m?.type === 'DESCEND_FRAME').length, 0)
  assert.match(panelText(a.doc), /先完成這一批/)

  const b = await boot(WITH_FRAME, BATCH)
  const proxy2 = b.doc.querySelector('[data-af-frame-proxy]')
  fire(b.win, proxy2, 'mousemove')
  key(b.doc, b.win, 'Enter')
  const d = msgs(b.c).find(m => m?.type === 'DESCEND_FRAME')
  assert.ok(d, '沒有組時照常下鑽')
  assert.equal(d.batch, true)
})

test('G1-7 連續兩輪：第二輪不帶第一輪的組；沒有組時指令句說明多任務怎麼選', async () => {
  const { c, doc, pm, win } = await boot(PAGE, BATCH)
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('y1'))
  key(doc, win, 'Enter')
  assert.equal(picked(c)[0].batch.length, 2, '前置')
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body, batch: true })
  assert.equal(pm.selectedCount(), 0)
  assert.match(panelText(doc), /不同的表格或元素會各自成為一個任務/)
  pm.exitPickMode()
})

test('G1-8 非批次模式點另一張表仍是換表（不退化）', async () => {
  const { doc, pm, win } = await boot(PAGE)
  pick(win, doc.getElementById('a1'))
  pick(win, doc.getElementById('y1'))
  assert.equal(pm.selectedCount(), 1)
  assert.equal(doc.getElementById('a1').hasAttribute('data-af-picked'), false)
  pm.exitPickMode()
})

test('G1-9 監控頁批次模式：別列的小表先升到外層、併進同一組（不是六個任務）', async () => {
  const { c, doc, pm, win } = await boot(MONITOR, BATCH)
  const small1 = (id) => doc.getElementById(id).closest('tr').children[0]
  pick(win, small1('his_31'))
  pick(win, small1('his_33'))
  assert.match(panelText(doc), /已選 1 個任務、共 2 個值/)
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg.batch, undefined, '只有一組')
  assert.equal(msg.picks.length, 2)
  assert.ok(msg.picks.every(p => p.cell.inner?.length === 4))
})

test('G1-10 同一張外層表只能是一組：外層已有一組時，小表那組升上去要併進同一組（不得建出兩個定位相同的任務）', async () => {
  const OTHER = '<table id="ot"><tbody><tr><td id="ot1">1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>'
  const { c, doc, pm, win } = await boot(MONITOR + OTHER, BATCH)
  const small1 = (id) => doc.getElementById(id).closest('tr').children[0]
  const timeTd = (id) => doc.getElementById(id).closest('table').closest('td').parentElement.children[3]
  pick(win, timeTd('his_31'))
  pick(win, doc.getElementById('ot1'))
  pick(win, small1('his_31'))
  assert.match(panelText(doc), /已選 3 個任務/, '前置：外層、另一張表、小表各一組')
  pick(win, small1('his_33'))
  assert.match(panelText(doc), /已選 2 個任務、共 4 個值/, `小表那組升到外層後併進外層那組：${panelText(doc).slice(0, 160)}`)
  key(doc, win, 'Enter')
  const msg = picked(c)[0]
  assert.equal(msg.batch?.length, 2)
  const locs = msg.batch.map(b => resolve(doc, b.locator).el)
  assert.equal(new Set(locs).size, 2, '兩組的定位不同')
  const outer = msg.batch.find(b => resolve(doc, b.locator).el === doc.querySelector('table'))
  assert.equal(outer?.picks.length, 3)
})

test('G1-11 批次模式點在頁面空白處（body）：不得把整個頁面加成一組，要說明', async () => {
  const { doc, pm, win } = await boot(PAGE, BATCH)
  pick(win, doc.getElementById('a1'))
  fire(win, doc.body, 'mousemove')
  fire(win, doc.body, 'click')
  assert.match(panelText(doc), /已選 1 個任務、共 1 個值/)
  assert.match(panelText(doc), /點在頁面空白處/)
})
