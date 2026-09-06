// AF-5 終檢:段與段之間的接線（每一段自己都綠，斷點在中間）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  return { c, st }
}

function sendTo(c, msg, sender = {}) {
  const listener = [...c.runtime.onMessage._listeners][0]
  return new Promise((resolve, reject) => {
    const ret = listener(msg, sender, resolve)
    if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
  })
}

const PICKS = [
  { cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '即期 · 買入' } } },
  { cell: { row: { index: 0, header: '美金' }, col: { index: 4, header: '即期 · 賣出' } } }
]

// ---- content → background → Picker ----

test('選好的多個值要一路傳到 Picker，不能在 background 掉光', async () => {
  const { c } = await freshBg()
  await sendTo(c, {
    type: 'PICKED', purpose: 'task',
    locator: { css: '#rate' }, preview: '31.2', previewValue: 31.2,
    blockInfo: { kind: 'table', rows: 2, cols: 5 },
    nameHint: '臺銀牌告匯率',
    picks: PICKS
  }, { tab: { id: 7, url: 'https://bank.test/rate' } })
  const created = c.__calls.find(x => x.api === 'windows.create')
  assert.ok(created, '要開 Picker 視窗')
  const url = created.args[0].url
  const ctxRaw = decodeURIComponent(url.split('?ctx=')[1] || '')
  const ctx = JSON.parse(ctxRaw)
  assert.equal(ctx.picks?.length, 2, `選了兩個值卻只帶了 ${ctx.picks?.length ?? 0} 個`)
  assert.equal(ctx.picks[0].cell.col.index, 3)
  assert.equal(ctx.nameHint, '臺銀牌告匯率')
  assert.equal(ctx.tabId, 7)
})

test('單選時照樣帶得出一個值', async () => {
  const { c } = await freshBg()
  await sendTo(c, {
    type: 'PICKED', purpose: 'task', locator: { css: '#v' }, preview: '1234',
    picks: [{ cell: { row: { index: 0, header: '' }, col: { index: 0, header: '' } } }]
  }, { tab: { id: 3, url: 'https://x.test/a' } })
  const url = c.__calls.find(x => x.api === 'windows.create').args[0].url
  const ctx = JSON.parse(decodeURIComponent(url.split('?ctx=')[1]))
  assert.equal(ctx.picks.length, 1)
})

// ---- 重選:background → content ----

test('重選要把定位資訊與既有的值帶回選取模式', async () => {
  const { c, st } = await freshBg()
  await st.saveTask({
    id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
    locator: { css: '#rate' },
    spec: { strategy: 'auto', mode: 'block', fields: [
      { key: 'k1', cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '即期 · 買入' } } }
    ] },
    fields: [{ key: 'k1', name: '美金買入' }],
    schedule: { type: 'daily', times: ['09:30'] }
  })
  await sendTo(c, { type: 'ENTER_PICK', purpose: 'repick', taskId: 'bank', tabId: 11 })
  const sent = c.__calls.filter(x => x.api === 'tabs.sendMessage').map(x => x.args[1]).pop()
  assert.equal(sent.type, 'ENTER_PICK')
  assert.ok(sent.locator, '沒有定位資訊，新分頁裡沒有任何預選對象')
  assert.equal(sent.preselect?.length, 1, '既有的值要先勾回去')
  assert.equal(sent.preselect[0].cell.col.header, '即期 · 買入')
})

test('單值任務重選也要帶定位資訊', async () => {
  const { c, st } = await freshBg()
  await st.saveTask({
    id: 't1', name: '總量', url: 'https://x.test/a', mode: 'block', enabled: true,
    locator: { css: '#t' },
    spec: { strategy: 'auto', mode: 'block', block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum' } },
    schedule: { type: 'daily', times: ['09:30'] }
  })
  await sendTo(c, { type: 'ENTER_PICK', purpose: 'repick', taskId: 't1', tabId: 5 })
  const sent = c.__calls.filter(x => x.api === 'tabs.sendMessage').map(x => x.args[1]).pop()
  assert.ok(sent.locator)
  assert.equal(sent.preselect?.[0]?.block?.headerText, '數量')
})

// ---- content 端接得住 ----

test('選取模式收到 ENTER_PICK 時用 locator 找目標，不是靠上次右鍵的位置', () => {
  const src = readFileSync(new URL('../src/content/main.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('MSG.ENTER_PICK'))
  assert.ok(/msg\.locator/.test(body), 'content 要用訊息帶來的 locator 解析目標')
  assert.ok(/preselect/.test(body), 'preselect 要傳進選取模式')
})

// ---- Picker → 任務 → 抓取 ----

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

test('整欄聚合的值要把聚合方式一起存進去', async () => {
  const { st, pk, doc } = await freshPicker()
  pk.render({
    url: 'https://bank.test/rate', locator: { css: '#rate' }, nameHint: '臺銀',
    blockInfo: { kind: 'table', rows: 3, cols: 5 },
    picks: [
      { block: { axis: 'col', index: 3, headerText: '即期 · 買入' } },
      { block: { axis: 'col', index: 4, headerText: '即期 · 賣出' } }
    ]
  })
  doc.getElementById('block-aggregate').value = 'avg'
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const t = (await st.getTasks())[0]
  assert.equal(t.spec.fields[0].block.aggregate, 'avg',
    '聚合方式的下拉不能是裝飾品，抓取端沒收到就會默默用加總')
})

test('多值任務加入儀表板時，卡片來源要指到值不是指到任務', async () => {
  const { st, pk, doc } = await freshPicker()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  pk.render({
    url: 'https://bank.test/rate', locator: { css: '#rate' }, nameHint: '臺銀',
    blockInfo: { kind: 'table', rows: 3, cols: 5 }, picks: PICKS
  })
  await pk.renderDashboardSection(null)
  doc.getElementById('dashboard-select').value = did
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 60))
  const task = (await st.getTasks())[0]
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.ok(cards.length > 0, '要有卡片')
  const sources = cards.flatMap(c => c.source.map(s => s.taskId))
  assert.ok(!sources.includes(task.id),
    `卡片來源不能是父任務 id（紀錄一筆都不會用那個 id，卡片永遠顯示破折號）：${sources.join(',')}`)
  assert.ok(sources.some(s => s.startsWith(task.id + '#')), `來源應該是序列 id：${sources.join(',')}`)
})

// ---- popup ----

test('popup 顯示多值任務時要看得到值，不是一個破折號', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask({
    id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
    spec: { strategy: 'auto', mode: 'block', fields: [{ key: 'k1' }, { key: 'k2' }] },
    fields: [{ key: 'k1', name: '美金買入' }, { key: 'k2', name: '美金賣出' }],
    schedule: { type: 'daily', times: ['09:30'] }
  })
  await st.setLastValue('bank#k1', { value: 31.2, capturedAt: 'x' })
  await st.setLastValue('bank#k2', { value: 31.3, capturedAt: 'x' })
  const html = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/popup/popup.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  pp.render({
    health: { level: 'green', summary: '' },
    tasks: await st.getTasks(),
    lastValues: await st.getLastValues(),
    nextRuns: {}, healthMap: {}
  })
  await new Promise(r => setTimeout(r, 20))
  const text = jd.window.document.body.textContent
  assert.ok(text.includes('31.2'), `多值任務也要看得到值：${text}`)
})

// ---- 終檢抓到的其餘缺陷 ----

test('手動抓取在離線時不排重試，而且說得出原因', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: false }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const task = {
    id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: { css: '#v' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:30'] }
  }
  await st.saveTask(task)
  const rec = await fe.runTask(task, { slot: '2026-09-06T09:30', reason: 'manual', ...FAST })
  const retries = c.__calls.filter(x => x.api === 'alarms.create' && String(x.args[0]).includes(':retry:'))
  assert.equal(retries.length, 0, '手動抓取一律不重試')
  assert.ok(rec, '要留下一筆看得到的失敗紀錄')
  assert.equal(rec.status, 'error')
  globalThis.navigator = { onLine: true }
})

test('表頭對得上就好，沒帶索引也要找得到', async () => {
  const EX = await import('../src/shared/extract.js?t=' + Math.random())
  const jd = new JSDOM(`<!doctype html><body><table id="t">
    <thead><tr><th>幣別</th><th>買入</th></tr></thead>
    <tbody><tr><td>美金</td><td>31.2</td></tr></tbody></table></body>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const res = EX.extractValue(jd.window.document.getElementById('t'), {
    mode: 'block',
    block: { cell: { row: { header: '美金' }, col: { header: '買入' } } }
  })
  assert.equal(res.ok, true, '只給表頭沒給索引時也要定位得到')
  assert.equal(res.value, 31.2)
})

test('值清單是空的時候不得留下矛盾的帳本與燈號', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const he = await import('../src/background/health.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, fields: {} }))
  const task = {
    id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
    locator: { css: '#rate' }, spec: { strategy: 'auto', mode: 'block', fields: [] },
    schedule: { type: 'daily', times: ['09:30'] }
  }
  await st.saveTask(task)
  await fe.runTask(task, { slot: '2026-09-06T09:30', ...FAST })
  const runs = (await c.storage.local.get('runs')).runs || {}
  const health = await he.getHealth()
  const ledger = runs.bank?.['2026-09-06T09:30']
  assert.ok(!(ledger === 'error' && health.bank?.status === 'ok'),
    `帳本說失敗、燈號說正常，兩邊講不同的話：ledger=${ledger} health=${health.bank?.status}`)
})

test('換一張表格時已選的值要清掉', async () => {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(`<!doctype html><body>
    <table id="a"><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td id="a0">1</td><td id="a1">2</td></tr></tbody></table>
    <table id="b"><thead><tr><th>丙</th><th>丁</th></tr></thead><tbody><tr><td id="b0">3</td><td id="b1">4</td></tr></tbody></table>
    </body>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.getElementById('a') })
  const cell = doc.getElementById('a1')
  cell.dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new jd.window.MouseEvent('click', { bubbles: true, shiftKey: true }))
  assert.equal(pm.selectedCount(), 1)
  doc.getElementById('b').dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  assert.equal(pm.selectedCount(), 0, '換了表格，先前那張表的列欄索引就沒有意義了')
  pm.exitPickMode()
})

test('樞紐表的差值有顏色可以分辨漲跌', () => {
  const css = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  assert.ok(/\.delta-up\s*\{/.test(css), '漲要有樣式')
  assert.ok(/\.delta-down\s*\{/.test(css), '跌要有樣式')
})

test('大整數不得被寫成科學記號', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const el = CR.renderCard(
    { id: 'n', type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1' }], options: {} },
    {
      records: [{ taskId: 't1', slot: '2026-09-06T09:30', capturedAt: 'x', value: 123456789012345, status: 'ok' }],
      tasksById: { t1: { id: 't1', name: '大數' } }, health: {}, nextRuns: {}, missed: [],
      range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06'
    }
  )
  assert.ok(!el.textContent.includes('e+'), `實得：${el.textContent}`)
})

test('只有一個值的多值任務拖到空白處也要用序列 id', async () => {
  const dr = await import('../src/ui/report/drop-rules.js?t=' + Math.random())
  const t = { id: 'bank', name: '臺銀', mode: 'block', fields: [{ key: 'k1', name: '買入' }] }
  assert.equal(dr.cardTypeForTask(t), 'table', '有值清單的任務用表格呈現')
})

test('樞紐表與最近 N 筆是兩張不同的卡片，不該互相去重', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  const base = { type: 'table', x: 0, y: 0, w: 12, h: 3, source: [{ taskId: 'a' }] }
  await ls.addCard(did, { ...base, options: { mode: 'recent' } })
  await ls.addCard(did, { ...base, options: { mode: 'pivot' } })
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 2)
})

test('抽屜保留的來源要留在原本的位置，不能跳到第一欄', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  await st.saveTask({
    id: 'x', name: 'X', url: 'https://x.test/a', mode: 'number', enabled: true,
    spec: {}, schedule: { type: 'daily', times: ['09:30'] }
  })
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  // 中間那個來源已經不在任務清單裡（任務被刪或索引查不到）
  const card = await ls.addCard(did, {
    type: 'table', x: 0, y: 0, w: 12, h: 3,
    source: [{ taskId: 'x' }, { taskId: 'gone#k1' }], options: { mode: 'pivot' }
  })
  await db.renderDashboard(did)
  await dw.openDrawer(did, card.id)
  const title = jd.window.document.getElementById('drawer-title')
  title.value = '換個標題'
  title.dispatchEvent(new jd.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const after = (await ls.getLayout()).dashboards[0].cards.find(c => c.id === card.id)
  assert.deepEqual(after.source.map(s => s.taskId), ['x', 'gone#k1'],
    '欄序就是這個陣列的順序，保留的來源跳到最前面等於偷偷換了欄位')
})

test('儀表板重畫時要把殘留的趨勢浮層收掉', () => {
  const src = readFileSync(new URL('../src/ui/report/dashboard.js', import.meta.url), 'utf8')
  assert.ok(/closeTrendPopover/.test(src), '不關掉會留一個孤兒浮層跟兩個監聽在 body 上')
})

test('既有任務仍然可以把策略改回自動', async () => {
  const { pk } = await freshPicker()
  const old = {
    id: 'o', name: '既有', url: 'https://x.test/o', mode: 'number', enabled: true,
    spec: { strategy: 'attr', attr: 'data-value' },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  }
  const values = { name: '既有', url: old.url, mode: 'number', strategy: 'regex', regex: '\\d+', scheduleType: 'daily', times: ['09:30'], weekdays: [1] }
  const task = pk.buildTask(values, {}, old)
  assert.equal(task.spec.strategy, 'regex', '使用者在表單上選了新策略就該照做')
  assert.equal(task.spec.attr, 'data-value', '沒有對應控制項的舊參數仍然保留')
})

test('記住的目標儀表板與卡片型別下次要套回來', async () => {
  const { st, pk, doc } = await freshPicker()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  await st.saveSettings({
    pickerDefaults: { last: { scheduleType: 'daily', times: ['09:30'], weekdays: [1], dashboardId: did, cardTypes: ['line'] } }
  })
  await pk.renderDashboardSection(null)
  await pk.applyPickerDefaults(null)
  assert.equal(doc.getElementById('dashboard-select').value, did)
  const checked = [...doc.querySelectorAll('#card-types input:checked')].map(i => i.value)
  assert.deepEqual(checked, ['line'], '存了卻不還原，等於每次都要重選')
})
