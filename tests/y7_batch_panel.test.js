// AF-18 批次 G-2／G-3b：右鍵入口、PICKED.batch 轉 ctx、面板批次畫面與全部儲存。
// 對照 docs/AF-18-PLAN.md 批次 G 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const api = (c, name) => c.__calls.filter(x => x.api === name)
const sessionOf = async (tabId) => (await chrome.storage.session.get(`panel:${tabId}`))[`panel:${tabId}`]
const runtimeMsgs = (c) => api(c, 'runtime.sendMessage').map(x => x.args[0])

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}
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
const payloadT = {
  locator: { css: '#t', path: '', anchor: null, xpath: '' }, url: URL_, tabId: 9, nameHint: '匯率',
  preview: '31.2（共 2 個值）', blockInfo: { kind: 'table', rows: 3, cols: 3, headers: ['幣別', '買入', '賣出'] },
  picks: [
    { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
    { cell: { row: { index: 1, header: '日圓' }, col: { index: 1, header: '買入' } } }
  ]
}
const payloadT2 = {
  locator: { css: '#t2', path: '', anchor: null, xpath: '' }, url: URL_, tabId: 9, nameHint: '匯率',
  preview: '「數量」整欄 2 格', blockInfo: { kind: 'table', rows: 2, cols: 2, headers: ['品項', '數量'] },
  picks: [{ block: { axis: 'col', index: 1, headerText: '數量' } }]
}
const payloadP = {
  locator: { css: '#plain', path: '', anchor: null, xpath: '' }, url: URL_, tabId: 9, nameHint: '匯率',
  preview: '今日總量 1,234', previewValue: 1234, blockInfo: { kind: 'number' }, picks: [{ locator: { css: '#plain' } }]
}
const batchCtx = (items) => ({ kind: 'batch', items: items.map((p, i) => ({ key: `b${i + 1}`, ...p })) })
const rows = (doc) => [...doc.querySelectorAll('#batch-section [data-batch-item]')]
const nameOf = (row) => row.querySelector('input[data-batch-name]')

// ---------- 入口與訊息（background） ----------

test('G2-1 右鍵多一項「一次建立多個任務」，排在「選取要抓的內容」下面', async () => {
  const { c, bg } = await freshBg()
  await bg.setupContextMenus()
  const ids = api(c, 'contextMenus.create').map(x => x.args[0])
  const pickAt = ids.findIndex(x => x.id === 'af-pick')
  assert.equal(ids[pickAt + 1]?.id, 'af-pick-batch')
  assert.equal(ids[pickAt + 1].title, '一次建立多個任務')
  assert.equal(ids[pickAt + 1].parentId, 'af-root')
})

test('G2-2 批次入口：先開面板、寫等待態（帶 batch）、ENTER_PICK 帶 batch 且指名 frameId', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: URL_ })
  await bg.handleContextMenu({ menuItemId: 'af-pick-batch', frameId: 0 }, tab)
  assert.equal(api(c, 'sidePanel.open').length, 1)
  const entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'waiting')
  assert.equal(entry.batch, true)
  const enter = api(c, 'tabs.sendMessage').find(x => x.args[1]?.type === 'ENTER_PICK')
  assert.equal(enter?.args[1].batch, true)
  assert.equal(enter.args[2]?.frameId, 0)
})

test('G2-3 面板有填到一半的表單時按批次入口：不動 ctx 與草稿、不進選取模式，留一句說明；反方向同理', async () => {
  const { c, st, bg } = await freshBg()
  const tab = await c.tabs.create({ url: URL_ })
  await st.setPanelCtx(tab.id, { kind: 'new', ctx: payloadT, draft: { name: '填到一半' } })
  await bg.handleContextMenu({ menuItemId: 'af-pick-batch', frameId: 0 }, tab)
  let entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'new')
  assert.equal(entry.draft?.name, '填到一半')
  assert.match(String(entry.notice || ''), /有一個任務設定到一半，請先儲存或取消，再開始多任務/)
  assert.equal(api(c, 'tabs.sendMessage').filter(x => x.args[1]?.type === 'ENTER_PICK').length, 0)

  await st.setPanelCtx(tab.id, batchCtx([payloadT, payloadT2]))
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'batch')
  assert.match(String(entry.notice || ''), /多任務設定到一半，請先全部儲存或取消，再選單一任務/)
  assert.equal(api(c, 'tabs.sendMessage').filter(x => x.args[1]?.type === 'ENTER_PICK').length, 0)
})

test('G2-4 PICKED.batch 轉成 kind:batch，每項有穩定鍵並補上分頁與框架身分', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: URL_ })
  await bg.handleContextMenu({ menuItemId: 'af-pick-batch', frameId: 0 }, tab)
  const strip = ({ tabId, url, ...rest }) => rest
  await bg.handleMessage({ type: 'PICKED', purpose: 'task', batch: [strip(payloadT), strip(payloadT2)] },
    { tab: { id: tab.id, url: URL_ }, frameId: 3, url: 'https://f.test/in' })
  const entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'batch')
  assert.equal(entry.items.length, 2)
  assert.equal(new Set(entry.items.map(i => i.key)).size, 2, '每項一個不重複的鍵')
  for (const it of entry.items) {
    assert.equal(it.tabId, tab.id)
    assert.equal(it.url, URL_)
    assert.equal(it.frameUrl, 'https://f.test/in')
  }
  assert.deepEqual(entry.items[1].picks, payloadT2.picks)
})

// ---------- 面板批次畫面 ----------

test('G3-1 批次畫面：N 列＋共用排程與去處；單任務的抓什麼／試抓／進階區不顯示；鈕改成全部試抓／全部儲存', async () => {
  const { pk, doc } = await freshPanel()
  const r = await pk.renderFromPanelCtx(batchCtx([payloadT, payloadT2, payloadP]))
  assert.equal(r?.rendered, true)
  assert.equal(doc.getElementById('batch-section')?.hidden, false)
  assert.equal(rows(doc).length, 3)
  for (const row of rows(doc)) {
    assert.ok(row.querySelector('[data-batch-where]').textContent.trim(), '每列說得出抓什麼')
    assert.ok(row.querySelector('[data-batch-result]'))
    assert.ok(row.querySelector('button[data-batch-remove]'))
  }
  // AF-20:進階區在批次畫面只露出前置動作(共用),其餘逐任務進階設定仍不顯示(細節見 z7_batch_preactions)
  for (const id of ['block-section', 'preview-section', 'strategy', 'alert-section']) {
    const el = doc.getElementById(id)
    assert.equal(Boolean(el.hidden || el.closest('[hidden]')), true, `${id} 不顯示`)
  }
  for (const id of ['schedule-section', 'add-to-dashboard']) {
    assert.equal(doc.getElementById(id).hidden, false, `${id} 共用`)
  }
  assert.equal(doc.getElementById('save').textContent.trim(), '全部儲存')
  assert.equal(doc.getElementById('test-now').textContent.trim(), '全部試抓')
  assert.equal(doc.getElementById('repick-target').hidden, true)
  assert.match(doc.getElementById('batch-section').textContent, /要個別調整的，存完到任務頁按編輯/)
})

test('G3-2 同一批撞名依序加序號；使用者手動改過的名稱不被加序號', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx({ ...batchCtx([payloadT, payloadT2, payloadP]), draft: { batchNames: { b2: '庫存' } } })
  const names = rows(doc).map(r => nameOf(r).value)
  assert.equal(new Set(names).size, 3, `名稱不得重複：${JSON.stringify(names)}`)
  assert.equal(names[1], '庫存', '草稿裡使用者改過的名字原樣還原')
})

test('G3-3 移除中間一列：其餘各列的名稱不錯位（草稿以穩定鍵對應）；移除到 0 列＝取消', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT, payloadT2, payloadP]))
  nameOf(rows(doc)[2]).value = '總量'
  nameOf(rows(doc)[2]).dispatchEvent(new window.Event('input', { bubbles: true }))
  rows(doc)[1].querySelector('[data-batch-remove]').click()
  assert.equal(rows(doc).length, 2)
  assert.equal(nameOf(rows(doc)[1]).value, '總量')
  assert.equal(rows(doc)[1].getAttribute('data-batch-key'), 'b3')
  rows(doc)[0].querySelector('[data-batch-remove]').click()
  rows(doc)[0].querySelector('[data-batch-remove]').click()
  await sleep(10)
  assert.ok(runtimeMsgs(c).some(m => m?.type === 'CLOSE_PANEL' && m.tabId === 9), '清單清空＝取消，走同一條收尾')
})

const normalize = (task) => {
  const keys = (task.fields || []).map(f => f.key)
  let s = JSON.stringify({ url: task.url, mode: task.mode, locator: task.locator, spec: task.spec, schedule: task.schedule, frame: task.frame })
  keys.forEach((k, i) => { s = s.split(k).join(`K${i}`) })
  return s
}
async function setInterval30(doc) {
  const type = doc.getElementById('schedule-type')
  type.value = 'interval'
  type.dispatchEvent(new window.Event('change', { bubbles: true }))
  doc.getElementById('every-minutes').value = '30'
  doc.getElementById('every-minutes').dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('G3-4 全部儲存：每個任務的規格＝同一份選取結果走單任務儲存的規格；共用排程是畫面上改過的值；整批只重建排程與寫預設值一次', async () => {
  // 單任務儲存（對照組）
  const single = []
  for (const p of [payloadT, payloadT2, payloadP]) {
    const s = await freshPanel()
    await s.pk.renderFromPanelCtx({ kind: 'new', ctx: p })
    await setInterval30(s.doc)
    await s.pk.handleSave()
    const [t] = await s.st.getTasks()
    single.push(normalize(t))
    globalThis.window.close = () => {}
  }

  const { c, st, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT, payloadT2, payloadP]))
  await setInterval30(doc)
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 3, JSON.stringify(tasks.map(t => t.name)))
  assert.deepEqual(tasks.map(normalize), single, '批次與單任務存出來的規格逐欄相同（共用儲存核心）')
  for (const t of tasks) assert.equal(t.schedule.everyMinutes, 30, '共用排程是畫面上改過的值，不是預設')
  assert.equal(runtimeMsgs(c).filter(m => m?.type === 'REBUILD_ALARMS').length, 1)
  assert.equal((await st.getSettings()).pickerDefaults?.last?.everyMinutes, 30)
  assert.match(doc.getElementById('saved-feedback')?.textContent || '', /已儲存 3 個任務/)
  globalThis.window.close = () => {}
})

test('G3-4b 批次畫面改過的共用合成方式，每個任務都要照畫面上的值存（逐一 render 不得把它洗回預設）', async () => {
  const { st, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadT]))
  const agg = doc.getElementById('batch-aggregate')
  assert.ok(agg && !agg.hidden, '有整欄值時顯示共用的合成方式')
  agg.value = 'max'
  agg.dispatchEvent(new window.Event('change', { bubbles: true }))
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 2)
  const col = tasks.find(t => t.locator?.css === '#t2')
  assert.match(JSON.stringify(col.spec), /"aggregate":"max"/, `整欄值要照畫面上的合成方式：${JSON.stringify(col.spec)}`)
  globalThis.window.close = () => {}
})

test('G3-11 全部儲存進行中按鈕顯示「儲存中 k／N…」且不可連按（與全部試抓同一套回饋）', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  const seen = []
  const realSet = chrome.storage.local.set.bind(chrome.storage.local)
  chrome.storage.local.set = async (obj) => {
    if (obj && 'tasks' in obj) {
      const btn = doc.getElementById('save')
      seen.push({ text: btn.textContent, disabled: btn.disabled })
    }
    return realSet(obj)
  }
  await pk.handleSave()
  chrome.storage.local.set = realSet
  assert.deepEqual(seen.map(x => x.text), ['儲存中 1／2…', '儲存中 2／2…'], `實得 ${JSON.stringify(seen)}`)
  assert.ok(seen.every(x => x.disabled), '進行中不可連按')
  // 全部成功時表單已換成回饋區，按鈕本來就不在了；還在的話就得是可按的
  const after = doc.getElementById('save')
  assert.ok(!after || after.disabled === false, '結束後按鈕還回來')
  globalThis.window.close = () => {}
})

test('G3-5 第 2 個儲存失敗：說出存了幾個、誰失敗；已存的從清單移除，再按一次不重複建立；畫面仍是批次清單', async () => {
  const { c, st, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT, payloadT2, payloadP]))
  nameOf(rows(doc)[1]).value = '庫存'
  const realSet = chrome.storage.local.set.bind(chrome.storage.local)
  let taskWrites = 0
  chrome.storage.local.set = async (obj) => {
    if (obj && 'tasks' in obj && ++taskWrites === 2) throw new Error('QUOTA_BYTES quota exceeded')
    return realSet(obj)
  }
  await pk.handleSave()
  assert.match(doc.getElementById('errors').textContent, /已儲存 1 個；第 2 個「庫存」失敗：QUOTA_BYTES/)
  assert.equal(rows(doc).length, 2, '已存的那一個從清單移除')
  assert.equal(doc.getElementById('batch-section').hidden, false, '仍是批次清單，不得露出單任務表單')
  assert.equal(doc.getElementById('block-section').hidden, true)
  chrome.storage.local.set = realSet
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 3, `不得重複建立（實得 ${tasks.map(t => t.name).join('、')}）`)
  globalThis.window.close = () => {}
})

test('G3-6 全部試抓：逐一跑 TEST_TASK，結果回到各自那一列；失敗寫原因；進行中不可連按', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  let during = null
  c.__setRuntimeResponder((msg) => {
    if (msg?.type !== 'TEST_TASK') return undefined
    during = during ?? { disabled: doc.getElementById('test-now').disabled, text: doc.getElementById('test-now').textContent }
    if (msg.task.locator.css === '#plain') return { ok: false, error: 'not_found', message: '找不到這個元素' }
    return { ok: true, value: 15, raw: '15', status: 'ok', used: 2, skipped: 0, excluded: 0 }
  })
  await pk.handleTestNow()
  assert.equal(api(c, 'runtime.sendMessage').filter(x => x.args[0]?.type === 'TEST_TASK').length, 2)
  assert.equal(during?.disabled, true)
  assert.match(during?.text || '', /試抓中 1／2…/)
  assert.match(rows(doc)[0].querySelector('[data-batch-result]').textContent, /15（用了 2 格/)
  assert.match(rows(doc)[1].querySelector('[data-batch-result]').textContent, /失敗：找不到這個元素/)
  assert.equal(doc.getElementById('test-now').disabled, false, '結束後按鈕還回來')
})

test('G3-7 面板顯示 background 留下的說明（入口被擋時）；等待態說得出是多任務', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx({ kind: 'new', ctx: payloadT, notice: '有一個任務設定到一半，請先儲存或取消，再開始多任務' })
  assert.match(doc.getElementById('panel-notice')?.textContent || '', /設定到一半/)
  const p2 = await freshPanel()
  await p2.pk.renderFromPanelCtx({ kind: 'waiting', purpose: 'task', batch: true })
  assert.match(p2.doc.getElementById('panel-waiting').textContent, /一次建立多個任務/)
})

test('G3-8 單任務儲存回饋多一行提示多任務入口；批次儲存回饋沒有', async () => {
  const { pk, doc } = await freshPanel()
  await pk.showSavedFeedback({ id: 't1', schedule: { type: 'daily', times: ['09:30'] } }, { closeDelayMs: 5, tabId: 9, hint: true })
  assert.match(doc.getElementById('saved-feedback').textContent, /同一頁還要抓別的？下次在右鍵選「一次建立多個任務」/)
  // 體檢：session 一寫成 saved 面板就會照 ctx 重畫回饋區——提示要跟著 ctx 走才留得住
  const entry = (await chrome.storage.session.get('panel:9'))['panel:9']
  assert.equal(entry.hint, true)
  await pk.renderFromPanelCtx({ ...entry, retarget: 'force-redraw' })
  assert.match(doc.getElementById('saved-feedback').textContent, /同一頁還要抓別的/, '重畫之後提示還在')
  globalThis.window.close = () => {}
  await sleep(15)
})

// ---------- AF-18 終檢補 ----------

test('G2-5 popup（ENTER_PICK 訊息）在多任務清單未存時被擋：不得靜默，說明要留在面板；多任務旗標遇到填一半的表單同樣擋', async () => {
  const { c, st, bg } = await freshBg()
  const tab = await c.tabs.create({ url: URL_ })
  await st.setPanelCtx(tab.id, batchCtx([payloadT, payloadT2]))
  const r = await bg.handleMessage({ type: 'ENTER_PICK', purpose: 'task', tabId: tab.id, frameId: 0 }, {})
  assert.equal(r?.ok, false)
  let entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'batch')
  assert.match(String(entry.notice || ''), /多任務設定到一半/)
  assert.equal(api(c, 'tabs.sendMessage').filter(x => x.args[1]?.type === 'ENTER_PICK').length, 0)

  await st.setPanelCtx(tab.id, { kind: 'new', ctx: payloadT, draft: { name: '填到一半' } })
  const r2 = await bg.handleMessage({ type: 'ENTER_PICK', purpose: 'task', batch: true, tabId: tab.id, frameId: 0 }, {})
  assert.equal(r2?.ok, false)
  entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'new')
  assert.equal(entry.draft?.name, '填到一半')
  assert.match(String(entry.notice || ''), /有一個任務設定到一半/)

  await st.setPanelCtx(tab.id, batchCtx([payloadT]))
  await bg.handleContextMenu({ menuItemId: 'af-pick-batch', frameId: 0 }, tab)
  assert.match(String((await sessionOf(tab.id)).notice || ''), /多任務清單還沒存/, '清單未存時再按多任務入口，說明句要對到實際狀況')
})

test('G2-6 被擋留下的說明不得殘留到之後的新表單；等待態的多任務旗標也不得跟過去', async () => {
  const { c, st, bg } = await freshBg()
  const tab = await c.tabs.create({ url: URL_ })
  await st.setPanelCtx(tab.id, { kind: 'new', ctx: payloadT })
  await bg.handleContextMenu({ menuItemId: 'af-pick-batch', frameId: 0 }, tab)
  assert.ok((await sessionOf(tab.id)).notice, '前置：被擋留下說明')
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  await bg.handleMessage({ type: 'PICKED', purpose: 'task', ...payloadT2 }, { tab: { id: tab.id, url: URL_ } })
  const entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'new')
  assert.ok(!entry.notice, `說明殘留：${entry.notice}`)
  assert.ok(!entry.batch)
})

test('G3-9 全部存好之後排程重建才失敗：不得把清單當失敗清空關面板；回饋區要說出來而且不自動關', async () => {
  const { c, st, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  c.__setRuntimeResponder((msg) => {
    if (msg?.type === 'REBUILD_ALARMS') throw new Error('service worker 沒有回應')
    return undefined
  })
  await pk.handleSave()
  assert.equal((await st.getTasks()).length, 2, '任務都存好了')
  const box = doc.getElementById('saved-feedback')
  assert.ok(box, '要有回饋區（不是錯誤清單）')
  assert.match(box.textContent, /已儲存 2 個任務/)
  assert.match(box.querySelector('[data-saved-warning]')?.textContent || '', /排程重建沒有完成：service worker 沒有回應/)
  await sleep(1700)
  assert.equal(runtimeMsgs(c).filter(m => m?.type === 'CLOSE_PANEL').length, 0, '有警告時不自動關面板')
})

test('G3-10 側邊面板裡按回饋區的「開啟報表」：開報表分頁並走關面板的收尾（面板沒有 window.close）', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.showSavedFeedback({ id: 't1', schedule: { type: 'daily', times: ['09:30'] } }, { closeDelayMs: null, tabId: 9 })
  const panelTabUnknown = !runtimeMsgs(c).some(m => m?.type === 'CLOSE_PANEL')
  assert.ok(panelTabUnknown, '前置：還沒關')
  let closed = 0
  globalThis.window.close = () => { closed++ }
  doc.getElementById('saved-open-report').click()
  await sleep(10)
  assert.equal(api(c, 'tabs.create').length, 1, '開報表分頁')
  assert.equal(closed, 0, '側邊面板不得走 window.close')
})

// ---------- 換模型體檢補 ----------

test('體檢-1 編輯既有任務／批次的回饋不提示多任務入口', async () => {
  const { pk, doc } = await freshPanel()
  await pk.showSavedFeedback({ id: 't1', schedule: { type: 'daily', times: ['09:30'] } }, { closeDelayMs: 5, tabId: 9 })
  assert.doesNotMatch(doc.getElementById('saved-feedback').textContent, /同一頁還要抓別的/)
  globalThis.window.close = () => {}
  await sleep(15)
})

test('體檢-2 加卡片失敗：任務已存、排程照樣重建（順序回到存→重建排程→卡片），回饋區說出來且不自動關', async () => {
  const { c, st, pk, doc } = await freshPanel()
  await st.saveLayout?.({ dashboards: [{ id: 'd1', name: '主', cards: [] }] })
  await pk.renderFromPanelCtx({ kind: 'new', ctx: payloadT2 })
  const sel = doc.getElementById('dashboard-select')
  if (![...sel.options].some(o => o.value !== 'none')) {
    const o = doc.createElement('option'); o.value = 'd1'; o.textContent = '主'; sel.prepend(o)
  }
  sel.value = [...sel.options].find(o => o.value !== 'none').value
  const box = doc.querySelector('#card-types input[type="checkbox"]')
  box.checked = true
  const realSet = chrome.storage.local.set.bind(chrome.storage.local)
  chrome.storage.local.set = async (obj) => {
    if (obj && 'layout' in obj) throw new Error('QUOTA_BYTES quota exceeded')
    return realSet(obj)
  }
  await pk.handleSave()
  chrome.storage.local.set = realSet
  assert.equal((await st.getTasks()).length, 1, '任務存好了')
  assert.equal(runtimeMsgs(c).filter(m => m?.type === 'REBUILD_ALARMS').length, 1, '卡片失敗不得讓排程不重建')
  assert.match(doc.querySelector('[data-saved-warning]')?.textContent || '', /沒有加進儀表板/)
  await sleep(1700)
  assert.equal(runtimeMsgs(c).filter(m => m?.type === 'CLOSE_PANEL').length, 0)
})

test('體檢-3 草稿要存到排程的實際欄位與勾選群組：批次畫面改的間隔與星期，面板重載後還在', async () => {
  const { pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx({
    ...batchCtx([payloadT2, payloadP]),
    draft: { 'schedule-type': 'interval', 'every-minutes': '30', weekdays: ['1', '3'], batchNames: { b1: '我改的' } }
  })
  assert.equal(doc.getElementById('schedule-type').value, 'interval')
  assert.equal(doc.getElementById('every-minutes').value, '30', '使用者填的間隔不得回到預設 15')
  const days = [...doc.querySelectorAll('#weekdays input[type="checkbox"]')].filter(cb => cb.checked).map(cb => cb.value)
  assert.deepEqual(days, ['1', '3'])
  assert.equal(nameOf(rows(doc)[0]).value, '我改的')
  // 寫回那一側：抄下來的草稿要含排程的實際欄位與勾選群組（以前清單裡是六個不存在的 id）
  const snap = pk.snapshotForm()
  assert.equal(snap['every-minutes'], '30')
  assert.deepEqual(snap.weekdays, ['1', '3'])
  assert.ok(Array.isArray(snap.cardTypes))
})

test('體檢-4 被擋時留下的說明：批次移除一列之後要收掉，不得一直掛著', async () => {
  const { st, pk, doc } = await freshPanel()
  const ctx = { ...batchCtx([payloadT, payloadT2, payloadP]), notice: '多任務設定到一半，請先全部儲存或取消，再選單一任務' }
  await st.setPanelCtx(9, ctx)
  await pk.renderFromPanelCtx(ctx)
  assert.equal(doc.getElementById('panel-notice').hidden, false, '前置：說明有顯示')
  rows(doc)[1].querySelector('[data-batch-remove]').click()
  await sleep(30)
  const entry = (await chrome.storage.session.get('panel:9'))['panel:9']
  assert.equal(entry.items.length, 2)
  assert.ok(!entry.notice, `說明殘留：${entry.notice}`)
})

test('體檢-5 全部試抓進行中「全部儲存」不可按，結束後還回來（兩條流程共用同一份表單）', async () => {
  const { c, pk, doc } = await freshPanel()
  await pk.renderFromPanelCtx(batchCtx([payloadT2, payloadP]))
  let saveDuring = null
  c.__setRuntimeResponder((msg) => {
    if (msg?.type !== 'TEST_TASK') return undefined
    saveDuring = saveDuring ?? doc.getElementById('save').disabled
    return { ok: true, value: 1, raw: '1', status: 'ok' }
  })
  await pk.handleTestNow()
  assert.equal(saveDuring, true)
  assert.equal(doc.getElementById('save').disabled, false)
})
