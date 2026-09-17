// AF-18 批次 C：看得到抓了什麼（P3）——明細入口像一顆按鈕、少量格數自動展開、測完捲到結果、整欄描述帶前幾格的文字。
// 對照 docs/AF-18-PLAN.md 批次 C 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}
const LOCATOR = { css: '#mon', path: 'body > table:nth-of-type(1)', anchor: null, xpath: '' }
const colPick = { block: { axis: 'col', index: 1, headerText: '值' } }
const ctxFor = (picks, extra = {}) => ({
  locator: LOCATOR, url: 'https://mon.test/p', nameHint: '', tabId: 5,
  blockInfo: { kind: 'table', rows: 9, cols: 2, headers: ['主機', '值'] }, picks, ...extra
})
const itemsN = (n) => Array.from({ length: n }, (_, i) => ({ index: i, header: `r${i}`, use: 'used', raw: String(i), number: i }))
const okWith = (n) => ({ ok: true, value: 1, raw: '1', status: 'ok', used: n, skipped: 0, excluded: 0, items: itemsN(n) })
const $ = (doc, id) => doc.getElementById(id)

test('C-1 總格數 ≤30：測完自動展開；summary 文字是「查看抓到的 N 格」', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => okWith(9))
  await pk.handleTestNow()
  const d = $(doc, 'test-detail')
  assert.equal(d.hidden, false)
  assert.equal(d.open, true, '少量格數直接攤開，使用者不必知道要去點')
  assert.equal(d.querySelector('summary').textContent.trim(), '查看抓到的 9 格')
})

test('C-2 總格數 31：維持收合（整欄很長時不把面板撐爆）；多值以各值格數加總判斷', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => okWith(31))
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').open, false)

  const { c: c2, pk: pk2, doc: doc2 } = await fresh()
  const picks = [colPick, { block: { axis: 'col', index: 0, headerText: '主機' } }]
  pk2.render(ctxFor(picks))
  c2.__setRuntimeResponder((msg) => {
    const keys = (msg.task?.fields || []).map(f => f.key)
    return { ok: true, fields: Object.fromEntries(keys.map(k => [k, okWith(16)])) }
  })
  await pk2.handleTestNow()
  assert.equal($(doc2, 'test-detail').hidden, false, '前置：多值明細有畫')
  assert.equal($(doc2, 'test-detail').open, false, '16＋16＝32 格，超過門檻')
})

test('C-3 測完（成功或失敗）把「先試抓看看」區捲進可視範圍；沒有 scrollIntoView 時不拋錯', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  let calls = 0
  $(doc, 'preview-section').scrollIntoView = () => { calls++ }
  c.__setRuntimeResponder(() => okWith(3))
  await pk.handleTestNow()
  assert.equal(calls, 1, '成功')
  c.__setRuntimeResponder(() => ({ ok: false, error: 'not_found' }))
  await pk.handleTestNow()
  assert.equal(calls, 2, '失敗也要捲過去，錯誤訊息在那一區')

  const f = await fresh()
  f.pk.render(ctxFor([colPick]))
  f.doc.getElementById('preview-section').scrollIntoView = undefined
  f.c.__setRuntimeResponder(() => okWith(3))
  await f.pk.handleTestNow()
  assert.match(f.doc.getElementById('preview').textContent, /用了 3 格/, '沒有 scrollIntoView 時照常完成')
})

test('C-4 樣式：summary 像一顆按鈕——不再是次要文字色的小字，要有邊框', () => {
  const style = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  const rules = [...style.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
  const summaryRules = rules.filter(r => /#test-detail\s+summary/.test(r.sel))
  assert.ok(summaryRules.length > 0, '要掃得到 summary 的樣式規則')
  const body = summaryRules.map(r => r.body).join(';')
  assert.doesNotMatch(body, /--text-muted/)
  assert.doesNotMatch(body, /--text-xs/)
  assert.match(body, /border\s*:/)
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, '只用主題變數')
})

// ---------- 整欄描述帶前幾格（previewSamples） ----------

async function bootPick(page) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><head><title>監控</title></head><body>${page}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, pm, win: jd.window }
}
const fire = (win, el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, ...init }))
const key = (doc, win, k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }))
const pickedMsg = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).find(m => m?.type === 'PICKED' && !m.cancelled)

const PLAIN = `<table id="t"><thead><tr><th id="h0">日期</th><th id="h1">數量</th></tr></thead>
<tbody><tr><td>09-01</td><td id="q1">10</td></tr><tr><td>09-02</td><td>32</td></tr></tbody></table>`

test('C-5 整欄值送出：previewSamples 是前 3 格的文字（超過 3 格加「…」、不足不加），preview 本身不變、不帶 previewValue', async () => {
  const { c, doc, pm, win } = await bootPick(MONITOR)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  const cell42 = doc.getElementById('his_31').closest('tr').children[0]
  fire(win, cell42, 'mousemove')
  fire(win, doc.querySelector('[data-af-tool="col"]'), 'click')
  fire(win, cell42, 'mousemove')
  fire(win, cell42, 'click')
  key(doc, win, 'Enter')
  const msg = pickedMsg(c)
  assert.ok(msg, '有送出')
  assert.equal(msg.previewSamples, '42、43、41…', '帶路徑時取的是子單位的文字（不是 42MAX:462）')
  assert.doesNotMatch(String(msg.preview), /42、43/, 'preview 字串本身不併入取樣（它是任務名稱的最後退路）')
  assert.equal(msg.previewValue, undefined)
  pm.exitPickMode()

  const p = await bootPick(PLAIN)
  p.pm.enterPickMode({ purpose: 'task', initialTarget: p.doc.body })
  fire(p.win, p.doc.getElementById('h1'), 'mousemove')
  fire(p.win, p.doc.getElementById('h1'), 'click')
  key(p.doc, p.win, 'Enter')
  assert.equal(pickedMsg(p.c)?.previewSamples, '10、32', '只有 2 格時不加「…」')
  p.pm.exitPickMode()
})

test('C-6 鏈結：background 把 previewSamples 帶進 ctx，面板預覽顯示它；預設任務名稱不含取樣值', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: 'https://mon.test/p' })
  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: LOCATOR, preview: '「」整欄 6 格', previewSamples: '42、43、41…',
    picks: [{ block: { axis: 'col', index: 2, headerText: '' } }], blockInfo: { kind: 'table', rows: 9, cols: 4 }
  }, { tab: { id: tab.id, url: 'https://mon.test/p' } })
  const entry = (await chrome.storage.session.get(`panel:${tab.id}`))[`panel:${tab.id}`]
  assert.equal(entry?.ctx?.previewSamples, '42、43、41…')

  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render(entry.ctx)
  const doc = jd.window.document
  assert.match(doc.getElementById('preview').textContent, /42、43、41…/)
  assert.doesNotMatch(doc.getElementById('name').value, /43/, '每天會變的值不得進任務名稱')
})
