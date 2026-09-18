// AF-20 作業 B2:「一次建立多個任務」共用前置動作
// 以前批次畫面把整個進階區藏起來,拆出來的任務都沒有前置動作;目標要先點頁籤才出現時,排程一律失敗而且沒有任何提示。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function freshPanel() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

const URL_ = 'https://a.test/p'
const FRAME = 'https://f.test/inner'
const payloadT2 = {
  locator: { css: '#t2', path: '', anchor: null, xpath: '' }, url: URL_, tabId: 9, nameHint: '數量',
  preview: '「數量」整欄 2 格', blockInfo: { kind: 'table', rows: 2, cols: 2, headers: ['品項', '數量'] },
  picks: [{ block: { axis: 'col', index: 1, headerText: '數量' } }]
}
const payloadP = {
  locator: { css: '#plain', path: '', anchor: null, xpath: '' }, url: URL_, tabId: 9, nameHint: '總量',
  preview: '今日總量 1,234', previewValue: 1234, blockInfo: { kind: 'number' }, picks: [{ locator: { css: '#plain' } }]
}
const batchCtx = (items) => ({ kind: 'batch', items: items.map((p, i) => ({ key: `b${i + 1}`, ...p })) })

// 元素自己或任何祖先帶 hidden,或落在沒展開的 <details> 內容裡,都算看不到
function visible(el) {
  if (!el) return false
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden) return false
    const p = n.parentElement
    if (p && p.tagName === 'DETAILS' && !p.hasAttribute('open') && n.tagName !== 'SUMMARY') return false
  }
  return true
}

// 模擬使用者加一列「點元素」並在頁面上選好目標(選取結果由 background 回傳,寫在列的 _locator/_frame)
function addClickRow(doc, css, frameUrl) {
  doc.getElementById('preaction-add').click()
  const rows = doc.querySelectorAll('[data-preaction-row]')
  const row = rows[rows.length - 1]
  const sel = row.querySelector('select')
  sel.value = 'click'
  sel.dispatchEvent(new window.Event('change', { bubbles: true }))
  row._locator = { css, path: '', anchor: null, xpath: '' }
  row._frame = frameUrl ? { url: frameUrl } : null
  return row
}

test('批次畫面看得到前置動作區,其餘進階欄位(策略、正規表達式、告警、網址)維持看不到', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  assert.ok(visible(doc.getElementById('preaction-section')), '前置動作區要看得到')
  assert.ok(visible(doc.getElementById('preaction-add')))
  for (const id of ['strategy', 'regex', 'alert-section', 'url', 'mode']) {
    assert.equal(visible(doc.getElementById(id)), false, `${id} 在批次畫面不應出現(逐任務進階設定本輪不做)`)
  }
  globalThis.window.close = () => {}
})

test('離開批次畫面(回到單任務)後,進階區各欄位恢復原狀', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  await pk.renderFromPanelCtx({ kind: 'new', ctx: payloadP })
  doc.getElementById('advanced-section').setAttribute('open', '')
  for (const id of ['strategy', 'regex', 'alert-section', 'url', 'mode', 'preaction-section']) {
    assert.ok(visible(doc.getElementById(id)), `${id} 在單任務要看得到`)
  }
  globalThis.window.close = () => {}
})

test('全部儲存:共用的前置動作逐鍵複製到每一個任務(含框架)', async () => {
  const { st, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  addClickRow(doc, '#tab2', FRAME)
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 2)
  for (const t of tasks) {
    assert.deepEqual(t.preActions, [{ type: 'click', locator: { css: '#tab2', path: '', anchor: null, xpath: '' }, frame: { url: FRAME } }],
      `「${t.name}」的前置動作:${JSON.stringify(t.preActions)}`)
  }
  globalThis.window.close = () => {}
})

test('全部儲存後畫面上的前置動作列還在(收集時逐項 render 會清掉,要貼回去)', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  addClickRow(doc, '#tab2', null)
  // 讓驗證失敗、停在批次畫面(名稱清空)
  const nameInput = doc.querySelector('#batch-section input[data-batch-name]')
  nameInput.value = ''
  nameInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  await pk.handleSave()
  const rows = doc.querySelectorAll('#preaction-list [data-preaction-row]')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]._locator, { css: '#tab2', path: '', anchor: null, xpath: '' })
  globalThis.window.close = () => {}
})

test('沒有加前置動作:每個任務都沒有 preActions 鍵(與單任務一致,不寫空陣列)', async () => {
  const { st, pk } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 2)
  for (const t of tasks) assert.equal('preActions' in t, false, JSON.stringify(t.preActions))
  globalThis.window.close = () => {}
})

test('同一份面板從編輯有前置動作的任務切到批次:舊任務的前置動作不得殘留(否則會被套到每一個新任務)', async () => {
  const { st, pk, doc } = await freshPanel()
  pk.render({ ...payloadP, task: {
    id: 'old', name: '舊任務', url: URL_, mode: 'number', enabled: true,
    locator: payloadP.locator, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    preActions: [{ type: 'click', locator: { css: '#old', path: '', anchor: null, xpath: '' } }]
  } })
  assert.equal(doc.querySelectorAll('#preaction-list [data-preaction-row]').length, 1, '前提:編輯畫面有一列')
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  assert.equal(doc.querySelectorAll('#preaction-list [data-preaction-row]').length, 0)
  await pk.handleSave()
  for (const t of (await st.getTasks()).filter(t => t.id !== 'old')) {
    assert.equal('preActions' in t, false)
  }
  globalThis.window.close = () => {}
})

test('批次裡有目標在框架內、又還沒有前置動作:顯示框架提示;加了一列之後收起來', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, { ...payloadP, frameUrl: FRAME }]))
  const hint = doc.getElementById('frame-hint')
  assert.ok(visible(hint), '批次畫面也要看得到框架提示')
  assert.match(doc.getElementById('frame-hint-text').textContent, /f\.test/)
  doc.getElementById('preaction-add').click()
  assert.equal(visible(hint), false)
  globalThis.window.close = () => {}
})

test('批次裡沒有任何框架目標:不顯示框架提示', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  assert.equal(visible(doc.getElementById('frame-hint')), false)
  globalThis.window.close = () => {}
})

test('提示文字不再說「開新分頁」(AF-20 起排程在專用視窗抓)', () => {
  const picker = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  const help = readFileSync(new URL('../src/ui/help/help.html', import.meta.url), 'utf8')
  for (const [name, src] of [['picker.js', picker], ['help.html', help]]) {
    assert.equal(/開新分頁/.test(src), false, `${name} 還有「開新分頁」`)
  }
})

// ---- 體檢輪 ----

const enterPicks = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage' && x.args[0]?.type === 'ENTER_PICK').map(x => x.args[0])

test('批次畫面的「在頁面上選取」要帶得出 tabId(還沒試抓、沒有單一 ctx 時也一樣;不帶的話 background 靜默無事)', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  doc.getElementById('preaction-add').click()
  doc.querySelector('#preaction-list [data-action="preaction-pick"]').click()
  const msgs = enterPicks(c)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].purpose, 'preaction')
  assert.equal(msgs[0].tabId, 9)
  assert.equal(msgs[0].frameId, 0)
  globalThis.window.close = () => {}
})

test('批次的框架提示按「加入點擊步驟」:新增一列並直接進選取,同樣帶 tabId', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, { ...payloadP, frameUrl: FRAME }]))
  doc.getElementById('frame-hint-add').click()
  assert.equal(doc.querySelectorAll('#preaction-list [data-preaction-row]').length, 1)
  assert.equal(enterPicks(c)[0]?.tabId, 9)
  globalThis.window.close = () => {}
})

test('共用前置動作有一列沒設定好:整批擋下並說是哪一列(濾掉的話 N 個任務都沒有前置動作)', async () => {
  const { st, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  addClickRow(doc, '#tab2', null)
  const bad = addClickRow(doc, '#x', null)
  bad._locator = null
  await pk.handleSave()
  assert.equal((await st.getTasks()).length, 0)
  assert.match(doc.getElementById('errors').textContent, /前置動作第 2 列/)
  assert.equal(doc.getElementById('save').disabled, false, '擋下之後按鈕要能再按')
  globalThis.window.close = () => {}
})

test('正在頁面上替某一列選元素時按了全部試抓(列被整批重建):選取結果要落在重建後的同一列', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  addClickRow(doc, '#first', null)
  doc.getElementById('preaction-add').click()
  const rowsBefore = doc.querySelectorAll('#preaction-list [data-preaction-row]')
  const sel = rowsBefore[1].querySelector('select')
  sel.value = 'click'
  sel.dispatchEvent(new window.Event('change', { bubbles: true }))
  rowsBefore[1].querySelector('[data-action="preaction-pick"]').click()
  c.__setRuntimeResponder((m) => (m?.type === 'TEST_TASK' ? { ok: true, value: 1 } : undefined))
  await pk.handleTestNow()
  const listener = [...c.runtime.onMessage._listeners]
  for (const fn of listener) fn({ type: 'PICKED', purpose: 'preaction', locator: { css: '#picked' }, frameUrl: null }, {}, () => {})
  const rows = doc.querySelectorAll('#preaction-list [data-preaction-row]')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[1]._locator, { css: '#picked' })
  assert.deepEqual(rows[0]._locator?.css, '#first', '不得寫到別列')
  globalThis.window.close = () => {}
})

test('單任務也一樣:手動新增一列前置動作後框架提示收起來(判準與批次同一份)', async () => {
  const { pk, doc } = await freshPanel()
  pk.render({ ...payloadP, frameUrl: FRAME })
  assert.ok(visible(doc.getElementById('frame-hint')))
  doc.getElementById('preaction-add').click()
  assert.equal(visible(doc.getElementById('frame-hint')), false)
  globalThis.window.close = () => {}
})
