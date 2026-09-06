// AF-5 規劃逐條比對後補上的缺漏
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

function domReady() {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return jd
}

const rec = (taskId, slot, value) => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status: 'ok'
})

const SERIES = {
  'bank#k1': { id: 'bank#k1', name: '臺銀 · 美金買入', shortName: '美金買入', parentId: 'bank', mode: 'block' },
  'bank#k2': { id: 'bank#k2', name: '臺銀 · 美金賣出', shortName: '美金賣出', parentId: 'bank', mode: 'block' },
  'esun#k1': { id: 'esun#k1', name: '玉山 · 美金買入', shortName: '美金買入', parentId: 'esun', mode: 'block' }
}

const ctxOf = (over = {}) => ({
  records: [
    rec('bank#k1', '2026-09-06T09:30', 31.2),
    rec('bank#k2', '2026-09-06T09:30', 31.3),
    rec('esun#k1', '2026-09-06T09:30', 31.1)
  ],
  tasksById: SERIES,
  parentTasksById: { bank: { id: 'bank', name: '臺銀' }, esun: { id: 'esun', name: '玉山' } },
  health: {}, nextRuns: {}, missed: [], cards: [],
  range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06', ...over
})

const pivot = (sources, over = {}) => ({
  id: 'c1', type: 'table', x: 0, y: 0, w: 12, h: 4,
  source: sources.map(id => ({ taskId: id })),
  options: { mode: 'pivot', bucketMinutes: 1440 }, ...over
})

// ---- C-3：同一個任務的值用短名，混了別的任務才用完整名 ----

test('樞紐表的值全來自同一個任務時，欄標用短名', async () => {
  domReady()
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const el = CR.renderCard(pivot(['bank#k1', 'bank#k2']), ctxOf())
  const heads = [...el.querySelectorAll('thead th')].map(t => t.textContent.trim())
  assert.ok(heads.includes('美金買入'), `同一家銀行不必每欄都重複銀行名：${heads.join(' / ')}`)
  assert.ok(!heads.some(h => h.includes('臺銀 ·')))
})

test('混了不同任務時欄標用完整名，才分得出是哪一家', async () => {
  domReady()
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const el = CR.renderCard(pivot(['bank#k1', 'esun#k1']), ctxOf())
  const heads = [...el.querySelectorAll('thead th')].map(t => t.textContent.trim())
  assert.ok(heads.some(h => h.includes('臺銀')) && heads.some(h => h.includes('玉山')),
    `兩家的值都叫美金買入，短名會撞在一起：${heads.join(' / ')}`)
})

test('欄標的 title 一律是完整名', async () => {
  domReady()
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const el = CR.renderCard(pivot(['bank#k1', 'bank#k2']), ctxOf())
  const th = [...el.querySelectorAll('thead th')].find(t => t.textContent.includes('美金買入'))
  assert.equal(th.getAttribute('title'), '臺銀 · 美金買入')
})

test('折線圖例套用同一條短名規則', async () => {
  domReady()
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const same = CR.renderCard({
    id: 'l1', type: 'line', x: 0, y: 0, w: 12, h: 3,
    source: [{ taskId: 'bank#k1' }, { taskId: 'bank#k2' }], options: {}
  }, ctxOf())
  const labels = [...same.querySelectorAll('.chart-legend-item')].map(e => e.textContent.trim())
  assert.ok(labels.some(l => l === '美金買入'), `圖例：${labels.join(' / ')}`)
})

test('複製 TSV 用完整名（貼進試算表要看得懂）', async () => {
  domReady()
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const el = CR.renderCard(pivot(['bank#k1', 'bank#k2']), ctxOf())
  assert.ok((el.dataset.tsv || '').includes('臺銀 · 美金買入'))
})

// ---- B5-2：只用得到第一個值時要說 ----

test('多個值拖到數值卡時要說明只用了哪一個', async () => {
  const dr = await import('../src/ui/report/drop-rules.js?t=' + Math.random())
  const card = { type: 'number', source: [{ taskId: 'old' }], options: {} }
  const patch = dr.applyDropMany(card, ['bank#k1', 'bank#k2'], {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['bank#k1'])
  assert.ok(patch.notice, '只吃得下一個值卻不說，使用者會以為另一個掉了')
  const named = dr.applyDropMany(
    { type: 'number', source: [{ taskId: 'old' }], options: {} },
    ['bank#k1', 'bank#k2'],
    { nameOf: (id) => ({ 'bank#k1': '臺銀 · 美金買入' })[id] || id }
  )
  assert.ok(String(named.notice).includes('美金買入'), `提示要說得出是哪個值：${named.notice}`)
})

// ---- B5-4：範本產不出東西時要說 ----

test('範本產不出卡片時回報原因，不是靜悄悄什麼都沒發生', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const tp = await import('../src/ui/report/templates.js?t=' + Math.random())
  await st.saveTask({
    id: 't', name: '文字', url: 'https://x.test/a', mode: 'text', enabled: true,
    spec: { mode: 'text' }, schedule: { type: 'daily', times: ['09:30'] }
  })
  const did = (await ls.getLayout()).dashboards[0].id
  const res = await tp.applyTemplate(did, 'overview')
  assert.equal(res?.applied, false, '要回報有沒有套上')
  assert.ok(res?.reason, '要說得出為什麼')
})

test('範本有卡片可套時回報成功', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const tp = await import('../src/ui/report/templates.js?t=' + Math.random())
  await st.saveTask({
    id: 'n', name: '用電', url: 'https://x.test/a', mode: 'number', enabled: true,
    spec: {}, schedule: { type: 'daily', times: ['09:30'] }
  })
  const did = (await ls.getLayout()).dashboards[0].id
  const res = await tp.applyTemplate(did, 'overview')
  assert.equal(res?.applied, true)
})

// ---- B2-7：預檢說得出是哪些值失敗 ----

test('預檢失敗的說明用值的名稱，不是內部代號', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const he = await import('../src/background/health.js?t=' + Math.random())
  const pc = await import('../src/background/precheck.js?t=' + Math.random())
  c.__setTabResponder(() => ({
    ok: true,
    fields: { k1: { ok: false, error: 'not_found' }, k2: { ok: false, error: 'not_found' } }
  }))
  const task = {
    id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
    locator: { css: '#rate' },
    spec: { strategy: 'auto', mode: 'block', fields: [{ key: 'k1' }, { key: 'k2' }] },
    fields: [{ key: 'k1', name: '美金買入' }, { key: 'k2', name: '美金賣出' }],
    schedule: { type: 'daily', times: ['09:30'] }
  }
  await st.saveTask(task)
  await pc.runPrecheck(task, { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 })
  const h = (await he.getHealth()).bank
  assert.ok(String(h.detail).includes('美金買入'), `使用者看不懂內部代號：${h.detail}`)
})

// ---- B3-1：選整欄／整列時要能選「每格一值」 ----

const BANK = `
<table id="rate">
  <thead><tr><th>幣別</th><th>買入</th><th>賣出</th></tr></thead>
  <tbody>
    <tr id="r0"><td id="c0-0">美金</td><td id="c0-1">30.9</td><td id="c0-2">31.5</td></tr>
    <tr id="r1"><td id="c1-0">日圓</td><td id="c1-1">0.208</td><td id="c1-2">0.216</td></tr>
  </tbody>
</table>`

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

test('右鍵選單把「整欄」拆成每格一值與整欄一值兩種', async () => {
  const { pm, doc, win } = await pickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  const items = [...doc.querySelectorAll('[data-af-menu-item]')].map(el => el.dataset.afMenuItem)
  assert.deepEqual(items, ['cell', 'col-each', 'col', 'row-each', 'row', 'done', 'cancel'],
    '一整欄的每一格各是一個值（各幣別的買入），跟整欄加總是兩件事')
  pm.exitPickMode()
})

test('選「這一欄的每一格」會把整欄的資料格都加進來', async () => {
  const { c, pm, doc, win } = await pickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  doc.querySelector('[data-af-menu-item="col-each"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.equal(pm.selectedCount(), 2, '兩列資料就是兩個值')
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const picks = lastMsg(c).picks
  assert.ok(picks.every(p => p.cell), '每一個都是儲存格，不是聚合')
  assert.deepEqual(picks.map(p => p.cell.row.header), ['美金', '日圓'])
})

test('選「這一列的每一格」同理', async () => {
  const { c, pm, doc, win } = await pickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  doc.querySelector('[data-af-menu-item="row-each"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const picks = lastMsg(c).picks
  assert.ok(picks.length >= 2)
  assert.ok(picks.every(p => p.cell))
})

test('整欄聚合那一項仍然是聚合', async () => {
  const { c, pm, doc, win } = await pickMode()
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('rate') })
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  doc.getElementById('c0-1').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  doc.querySelector('[data-af-menu-item="col"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.ok(lastMsg(c).picks[0].block, '整欄一值是聚合型')
})
