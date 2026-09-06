// AF-5 體檢輪(換模型獨立審查)抓到的問題
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

const BANK = `
<h2 id="h">牌告</h2>
<table id="rate">
  <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
  <tbody>
    <tr><td id="c0-0">美金</td><td id="c0-1">30.9</td><td id="c0-2">31.5</td></tr>
    <tr><td id="c1-0">日圓</td><td id="c1-1">0.208</td><td id="c1-2">0.216</td></tr>
  </tbody>
</table>
<p id="note">說明文字</p>`

async function pickMode() {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>臺銀</title></head><body>${BANK}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, pm, doc: jd.window.document, win: jd.window }
}
const lastMsg = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).pop()
const mv = (doc, win, id) => doc.getElementById(id).dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))

test('滑鼠漂出表格再回來，已選的格子不能消失', async () => {
  const { pm, doc, win } = await pickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  mv(doc, win, 'c0-1')
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true }))
  assert.equal(pm.selectedCount(), 1)
  mv(doc, win, 'note')          // 漂到表格外的一段文字
  mv(doc, win, 'c1-1')          // 再回到表格
  assert.equal(pm.selectedCount(), 1, '只是經過一段文字就把十個值清掉，使用者會抓狂')
  pm.exitPickMode()
})

test('滑鼠停在表格外時按 Enter，送出的仍是那張表格與已選的值', async () => {
  const { c, pm, doc, win } = await pickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  mv(doc, win, 'c0-1')
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true }))
  mv(doc, win, 'note')
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const msg = lastMsg(c)
  assert.equal(msg.picks.length, 1)
  assert.ok(msg.blockInfo?.kind === 'table', `定位資訊要指向表格而不是那段文字：${JSON.stringify(msg.blockInfo)}`)
})

test('換到另一張表格才清空已選', async () => {
  const { pm, doc, win } = await pickMode()
  const t2 = doc.createElement('table')
  t2.id = 'other'
  t2.innerHTML = '<thead><tr><th>甲</th></tr></thead><tbody><tr><td id="o0">1</td></tr></tbody>'
  doc.body.appendChild(t2)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  mv(doc, win, 'c0-1')
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true }))
  mv(doc, win, 'o0')
  assert.equal(pm.selectedCount(), 0)
  pm.exitPickMode()
})

// ---- 舊策略的任務要能真的改回「自動」 ----

async function picker() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { st, pk, doc: jd.window.document }
}
const legacyTask = () => ({
  id: 'o', name: '既有', url: 'https://x.test/o', mode: 'number', enabled: true,
  spec: { strategy: 'attr', attr: 'data-value' },
  schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
})

test('編輯舊策略任務時，下拉要顯示得出它原本的策略', async () => {
  const { pk, doc } = await picker()
  pk.render({ task: legacyTask() })
  assert.equal(doc.getElementById('strategy').value, 'attr', '顯示成「自動」等於騙使用者')
})

test('不動下拉直接存，舊策略保留', async () => {
  const { pk } = await picker()
  const t = pk.buildTask(
    { name: '既有', url: 'u', mode: 'number', strategy: 'attr', scheduleType: 'daily', times: ['09:30'], weekdays: [1] },
    {}, legacyTask()
  )
  assert.equal(t.spec.strategy, 'attr')
  assert.equal(t.spec.attr, 'data-value')
})

test('明確改成「自動」就要真的變成自動', async () => {
  const { pk } = await picker()
  const t = pk.buildTask(
    { name: '既有', url: 'u', mode: 'number', strategy: 'auto', scheduleType: 'daily', times: ['09:30'], weekdays: [1] },
    {}, legacyTask()
  )
  assert.equal(t.spec.strategy, 'auto', '使用者選了自動卻被偷偷改回舊策略')
})

// ---- 立即抓取的逐值回報不能重複 ----

test('同一分鐘按兩次立即抓取，逐值回報每個值只出現一次', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  await st.saveTask({
    id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
    locator: { css: '#rate' },
    spec: { strategy: 'auto', mode: 'block', fields: [{ key: 'k1', cell: { row: { index: 0 }, col: { index: 1 } } }] },
    fields: [{ key: 'k1', name: '美金買入' }],
    schedule: { type: 'daily', times: ['09:30'] }
  })
  c.__setTabResponder(() => ({ ok: true, fields: { k1: { ok: true, value: 31.2, raw: '31.2', status: 'ok' } } }))
  const listener = [...c.runtime.onMessage._listeners][0]
  const send = () => new Promise(res => listener({ type: 'RUN_TASK', taskId: 'bank', __testOpts: FAST }, {}, res))
  await send()
  const second = await send()
  assert.equal(second.values.length, 1, `實得 ${second.values.length} 筆`)
})
