process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  return { c, st, pp, doc: jd.window.document }
}

const task = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

test('popup.html 有燈號摘要、任務清單與底部按鈕', async () => {
  const { doc } = await fresh()
  for (const id of ['status-summary', 'status-dot', 'task-list', 'toggle-all', 'open-report']) {
    assert.ok(doc.getElementById(id), `缺少 #${id}`)
  }
})

test('popup.html 不引用外部資源', async () => {
  assert.ok(!/(src|href)=["']https?:/.test(html))
})

test('render:每個任務一列,顯示名稱、最後值、下次執行', async () => {
  const { pp, doc } = await fresh()
  pp.render({
    health: { level: 'green', redCount: 0, yellowCount: 0, summary: '一切正常' },
    tasks: [task('t1', { name: '總量' }), task('t2', { name: '匯率' })],
    lastValues: { t1: { value: 1234, status: 'ok', at: Date.now() } },
    nextRuns: { t1: new Date(2026, 8, 8, 9, 0).getTime() },
    healthMap: {}
  })
  const rows = doc.querySelectorAll('#task-list .task-row')
  assert.equal(rows.length, 2)
  assert.match(rows[0].textContent, /總量/)
  assert.match(rows[0].textContent, /1,?234/)
  assert.match(rows[0].textContent, /09:00/)
})

test('render:沒有任務時顯示引導文字,不顯示空表格', async () => {
  const { pp, doc } = await fresh()
  pp.render({ health: { level: 'off', redCount: 0, yellowCount: 0, summary: '' }, tasks: [], lastValues: {}, nextRuns: {}, healthMap: {} })
  assert.equal(doc.querySelectorAll('#task-list .task-row').length, 0)
  assert.ok(doc.getElementById('task-list').textContent.trim().length > 0, '要告訴使用者怎麼開始')
})

test('render:燈號摘要文字與顏色類別跟著等級走', async () => {
  const { pp, doc } = await fresh()
  for (const [level, cls] of [['green', 'ok'], ['yellow', 'warn'], ['red', 'bad'], ['off', 'off']]) {
    pp.render({ health: { level, redCount: 1, yellowCount: 1, summary: '摘要' + level }, tasks: [], lastValues: {}, nextRuns: {}, healthMap: {} })
    assert.match(doc.getElementById('status-summary').textContent, new RegExp('摘要' + level))
    assert.ok(doc.getElementById('status-dot').className.includes(cls), `${level} 應有 ${cls} 類別`)
  }
})

test('render:異常任務才顯示「立即重試」與「開啟頁面」', async () => {
  const { pp, doc } = await fresh()
  pp.render({
    health: { level: 'red', redCount: 1, yellowCount: 0, summary: 'x' },
    tasks: [task('t1'), task('t2')],
    lastValues: {}, nextRuns: {},
    healthMap: { t1: { status: 'login_failed', reason: '無法登入' } }
  })
  const rows = doc.querySelectorAll('#task-list .task-row')
  assert.ok(rows[0].querySelector('.retry'), '異常任務要有重試鈕')
  assert.ok(rows[0].querySelector('.open-page'), '異常任務要有開啟頁面鈕')
  assert.match(rows[0].textContent, /無法登入/, '要說出原因')
  assert.equal(rows[1].querySelector('.retry'), null, '正常任務不需要重試鈕')
})

test('render:暫停中的任務標示出來', async () => {
  const { pp, doc } = await fresh()
  pp.render({
    health: { level: 'off', redCount: 0, yellowCount: 0, summary: '' },
    tasks: [task('t1', { enabled: false })], lastValues: {}, nextRuns: {}, healthMap: {}
  })
  assert.match(doc.querySelector('#task-list .task-row').textContent, /暫停/)
})

test('點立即重試:送 RUN_TASK 給 background', async () => {
  const { c, pp, doc } = await fresh()
  pp.render({
    health: { level: 'red', redCount: 1, yellowCount: 0, summary: 'x' },
    tasks: [task('t1')], lastValues: {}, nextRuns: {},
    healthMap: { t1: { status: 'selector_lost' } }
  })
  doc.querySelector('#task-list .task-row .retry').click()
  const msg = c.__calls.find(x => x.api === 'runtime.sendMessage')
  assert.ok(msg)
  assert.equal(msg.args[0].type, 'RUN_TASK')
  assert.equal(msg.args[0].taskId, 't1')
})

test('點開啟頁面:用 tabs.create 開目標網址讓使用者自己處理', async () => {
  const { c, pp, doc } = await fresh()
  pp.render({
    health: { level: 'red', redCount: 1, yellowCount: 0, summary: 'x' },
    tasks: [task('t1', { url: 'https://a.test/login' })], lastValues: {}, nextRuns: {},
    healthMap: { t1: { status: 'login_failed' } }
  })
  doc.querySelector('#task-list .task-row .open-page').click()
  const call = c.__calls.find(x => x.api === 'tabs.create')
  assert.equal(call.args[0].url, 'https://a.test/login')
  assert.notEqual(call.args[0].active, false, '要跳到前景讓使用者操作')
})

test('全部暫停:把所有任務 enabled 設為 false 並請求重建排程', async () => {
  const { c, st, pp, doc } = await fresh()
  await st.saveTask(task('t1'))
  await st.saveTask(task('t2'))
  pp.render({ health: { level: 'green', redCount: 0, yellowCount: 0, summary: '' }, tasks: [task('t1'), task('t2')], lastValues: {}, nextRuns: {}, healthMap: {} })
  await pp.handleToggleAll()
  assert.ok((await st.getTasks()).every(t => t.enabled === false))
  assert.ok(c.__calls.some(x => x.api === 'runtime.sendMessage' && x.args[0].type === 'REBUILD_ALARMS'))
})

test('全部暫停後再按一次會全部恢復', async () => {
  const { st, pp } = await fresh()
  await st.saveTask(task('t1', { enabled: false }))
  await st.saveTask(task('t2', { enabled: false }))
  pp.render({ health: { level: 'off', redCount: 0, yellowCount: 0, summary: '' }, tasks: await st.getTasks(), lastValues: {}, nextRuns: {}, healthMap: {} })
  await pp.handleToggleAll()
  assert.ok((await st.getTasks()).every(t => t.enabled === true))
})

test('開啟報表:用 tabs.create 開 report.html', async () => {
  const { c, pp, doc } = await fresh()
  pp.render({ health: { level: 'green', redCount: 0, yellowCount: 0, summary: '' }, tasks: [], lastValues: {}, nextRuns: {}, healthMap: {} })
  doc.getElementById('open-report').click()
  const call = c.__calls.find(x => x.api === 'tabs.create')
  assert.match(String(call.args[0].url), /report\.html/)
})

test('打開 popup 會把異常標記為已讀', async () => {
  const { c, pp } = await fresh()
  await pp.markAllSeen(['t1', 't2'])
  const msgs = c.__calls.filter(x => x.api === 'runtime.sendMessage')
  assert.ok(msgs.some(m => m.args[0].type === 'MARK_READ'))
})
