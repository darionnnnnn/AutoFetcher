// AF-5 完整比對後的第二輪缺漏
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
      { key: 'k1', cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '買入' } } },
      { key: 'k2', cell: { row: { index: 0, header: '美金' }, col: { index: 4, header: '賣出' } } }
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

function sendTo(c, msg, sender = {}) {
  const listener = [...c.runtime.onMessage._listeners][0]
  return new Promise((resolve, reject) => {
    const ret = listener(msg, sender, resolve)
    if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
  })
}

// ---- 重選的真實路徑（任務頁不帶 tabId）----

test('從任務頁重選時，新開的分頁也要帶定位資訊與既有的值', async () => {
  const { c, st } = await freshBg()
  await st.saveTask(multi())
  // 任務頁送出的就是這個形狀：沒有 tabId
  await sendTo(c, { type: 'ENTER_PICK', purpose: 'repick', taskId: 'bank' })
  const sent = c.__calls.filter(x => x.api === 'tabs.sendMessage').map(x => x.args[1]).pop()
  assert.ok(sent, '要送訊息進新分頁')
  assert.ok(sent.locator, '新分頁沒有「上次右鍵的元素」，不帶 locator 就沒有預選對象')
  assert.equal(sent.preselect?.length, 2, '既有的兩個值要勾回去')
})

// ---- 抽屜不得靜默改掉按天分列 ----

test('時間容差要選得到「每天一格」', () => {
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const block = html.slice(html.indexOf('id="drawer-bucket"'), html.indexOf('id="drawer-bucket"') + 600)
  assert.ok(/value="1440"/.test(block), '多值任務預設就是按天分列，下拉選不到等於沒得選')
})

test('開抽屜改個標題不會把按天分列改掉', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(multi())
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
    source: [{ taskId: 'bank#k1' }, { taskId: 'bank#k2' }],
    options: { mode: 'pivot', bucketMinutes: 1440, showDelta: true }
  })
  await db.renderDashboard(did)
  await dw.openDrawer(did, card.id)
  const title = jd.window.document.getElementById('drawer-title')
  title.value = '匯率'
  title.dispatchEvent(new jd.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const after = (await ls.getLayout()).dashboards[0].cards.find(c => c.id === card.id)
  assert.equal(after.options.bucketMinutes, 1440, '看一眼設定就把按天分列弄丟了')
  assert.equal(after.options.showDelta, true)
})

// ---- 立即抓取的逐值回饋 ----

test('多值任務按立即抓取要看得到每個值', async () => {
  const { c, st } = await freshBg()
  await st.saveTask(multi())
  c.__setTabResponder(() => ({
    ok: true,
    fields: {
      k1: { ok: true, value: 31.2, raw: '31.2', status: 'ok' },
      k2: { ok: false, error: 'not_found' }
    }
  }))
  const res = await sendTo(c, { type: 'RUN_TASK', taskId: 'bank', __testOpts: FAST })
  assert.ok(Array.isArray(res.values), '多值任務要回傳每個值的結果')
  assert.equal(res.values.length, 2)
  const buy = res.values.find(v => v.name === '美金買入')
  assert.equal(buy.value, 31.2)
  const sell = res.values.find(v => v.name === '美金賣出')
  assert.equal(sell.ok, false)
})

test('單值任務的回傳形狀不變', async () => {
  const { c, st } = await freshBg()
  await st.saveTask({
    id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: { css: '#v' }, spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:30'] }
  })
  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok' }))
  const res = await sendTo(c, { type: 'RUN_TASK', taskId: 't1', __testOpts: FAST })
  assert.equal(res.value, 12)
  assert.equal(res.values, undefined)
})

// ---- 計量卡也要看得懂燈號 ----

test('計量卡在紅燈時顯示破折號並帶原因', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const el = CR.renderCard(
    { id: 'g', type: 'gauge', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 'bank#k1' }], options: { min: 0, max: 100 } },
    {
      records: [{ taskId: 'bank#k1', slot: '2026-09-06T09:30', capturedAt: 'x', value: null, status: 'not_found' }],
      tasksById: { 'bank#k1': { id: 'bank#k1', name: '臺銀 · 美金買入', shortName: '美金買入', parentId: 'bank' } },
      parentTasksById: { bank: { id: 'bank', name: '臺銀' } },
      health: { bank: { status: 'selector_lost', reason: '找不到元素' } },
      nextRuns: {}, missed: [], range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06'
    }
  )
  assert.ok(el.textContent.includes('—'), `抓不到就不該畫出一個指針：${el.textContent}`)
  assert.ok(el.innerHTML.includes('找不到元素') || el.querySelector('[title]'), '要說得出原因')
})

// ---- 多值寫入的成本 ----

test('多個值的最後值只寫一次，不是每個值各讀寫一遍', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(multi())
  c.__setTabResponder(() => ({
    ok: true,
    fields: {
      k1: { ok: true, value: 31.2, raw: '31.2', status: 'ok' },
      k2: { ok: true, value: 31.3, raw: '31.3', status: 'ok' }
    }
  }))
  const before = c.__calls.length
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const writes = c.__calls.slice(before).filter(x => x.api === 'storage.local.set' && x.args[0]?.lastValues)
  assert.equal(writes.length, 1, `十個值就是十次整包讀寫，實得 ${writes.length} 次`)
})

// ---- 診斷看得到多值的結果 ----

test('抓完留下一筆診斷，說得出哪些值失敗', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(multi())
  c.__setTabResponder(() => ({
    ok: true,
    fields: {
      k1: { ok: true, value: 31.2, raw: '31.2', status: 'ok' },
      k2: { ok: false, error: 'not_found' }
    }
  }))
  await fe.runTask(multi(), { slot: '2026-09-06T09:30', ...FAST })
  const diag = await st.getDiagList()
  const entry = diag.find(d => JSON.stringify(d).includes('bank'))
  assert.ok(entry, '設定頁的診斷看不到多值抓取發生過什麼事')
  assert.ok(JSON.stringify(entry).includes('k2') || JSON.stringify(entry).includes('美金賣出'),
    '要說得出是哪個值失敗')
})
