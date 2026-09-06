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
