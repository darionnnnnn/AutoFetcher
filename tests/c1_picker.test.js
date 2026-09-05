process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

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

const LOCATOR = { css: '#v', path: 'body > div:nth-of-type(1)', anchor: null, xpath: '/html[1]/body[1]/div[1]' }
const base = (over = {}) => ({
  name: '總量', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
  scheduleType: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5],
  everyMinutes: 15, ...over
})

// ---------- 表單驗證 ----------
test('validateForm:正常輸入通過', async () => {
  const { pk } = await fresh()
  assert.equal(pk.validateForm(base()).ok, true)
})

test('validateForm:名稱不可空白', async () => {
  const { pk } = await fresh()
  const r = pk.validateForm(base({ name: '   ' }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.name)
})

test('validateForm:時間格式錯誤要擋下', async () => {
  const { pk } = await fresh()
  for (const bad of ['25:00', '9:00', '09:60', 'abc', '', '09:0']) {
    const r = pk.validateForm(base({ times: [bad] }))
    assert.equal(r.ok, false, `${bad} 應被擋下`)
    assert.ok(r.errors.times)
  }
})

test('validateForm:每日模式至少要一個時間、一個星期', async () => {
  const { pk } = await fresh()
  assert.equal(pk.validateForm(base({ times: [] })).ok, false)
  assert.equal(pk.validateForm(base({ weekdays: [] })).ok, false)
})

test('validateForm:間隔模式的分鐘數必須是 1 以上的整數', async () => {
  const { pk } = await fresh()
  for (const bad of [0, -5, 0.5, NaN, 'abc']) {
    const r = pk.validateForm(base({ scheduleType: 'interval', everyMinutes: bad }))
    assert.equal(r.ok, false, `${bad} 應被擋下`)
    assert.ok(r.errors.everyMinutes)
  }
  assert.equal(pk.validateForm(base({ scheduleType: 'interval', everyMinutes: 1 })).ok, true)
})

test('validateForm:間隔模式不檢查 times', async () => {
  const { pk } = await fresh()
  assert.equal(pk.validateForm(base({ scheduleType: 'interval', times: [] })).ok, true)
})

test('validateForm:regex 策略必須給正則,且必須合法', async () => {
  const { pk } = await fresh()
  assert.equal(pk.validateForm(base({ strategy: 'regex' })).ok, false)
  assert.equal(pk.validateForm(base({ strategy: 'regex', regex: '([' })).ok, false)
  assert.equal(pk.validateForm(base({ strategy: 'regex', regex: '(\\d+)' })).ok, true)
})

test('validateForm:時段設定要兩個都給或都不給', async () => {
  const { pk } = await fresh()
  const t = base({ scheduleType: 'interval' })
  assert.equal(pk.validateForm({ ...t, windowFrom: '09:00' }).ok, false)
  assert.equal(pk.validateForm({ ...t, windowFrom: '09:00', windowTo: '18:00' }).ok, true)
})

// ---------- 建立任務物件 ----------
test('buildTask:產生的物件符合儲存層要求', async () => {
  const { pk } = await fresh()
  const t = pk.buildTask(base(), LOCATOR)
  assert.equal(typeof t.id, 'string')
  assert.ok(t.id.length > 0)
  assert.equal(t.name, '總量')
  assert.equal(t.url, 'https://a.test/p')
  assert.equal(t.enabled, true)
  assert.deepEqual(t.locator, LOCATOR)
  assert.equal(t.schedule.type, 'daily')
  assert.deepEqual(t.schedule.times, ['09:00'])
  assert.deepEqual(t.schedule.weekdays, [1, 2, 3, 4, 5])
  assert.equal(t.spec.strategy, 'auto')
  assert.equal(t.spec.mode, undefined, 'number 模式不必寫 mode')
})

test('buildTask:text 模式帶 mode text', async () => {
  const { pk } = await fresh()
  const t = pk.buildTask(base({ mode: 'text' }), LOCATOR)
  assert.equal(t.spec.mode, 'text')
})

test('buildTask:兩次呼叫產生不同 id', async () => {
  const { pk } = await fresh()
  assert.notEqual(pk.buildTask(base(), LOCATOR).id, pk.buildTask(base(), LOCATOR).id)
})

test('buildTask:編輯既有任務時沿用原 id 與 order', async () => {
  const { pk } = await fresh()
  const t = pk.buildTask(base(), LOCATOR, { id: 'old-id', order: 3 })
  assert.equal(t.id, 'old-id')
  assert.equal(t.order, 3)
})

test('buildTask:間隔模式帶 everyMinutes 與時段', async () => {
  const { pk } = await fresh()
  const t = pk.buildTask(base({ scheduleType: 'interval', windowFrom: '09:00', windowTo: '18:00' }), LOCATOR)
  assert.equal(t.schedule.type, 'interval')
  assert.equal(t.schedule.everyMinutes, 15)
  assert.deepEqual(t.schedule.window, { from: '09:00', to: '18:00' })
})

// ---------- 畫面 ----------
test('picker.html 有必要的表單元素', async () => {
  const { doc } = await fresh()
  for (const id of ['name', 'mode', 'strategy', 'schedule-type', 'times', 'weekdays',
                    'every-minutes', 'preview', 'save', 'cancel', 'test-now', 'errors']) {
    assert.ok(doc.getElementById(id), `缺少 #${id}`)
  }
})

test('picker.html 不引用任何外部資源(CSP 會擋)', async () => {
  assert.ok(!/src=["']https?:/.test(html), '不得引用外部 script')
  assert.ok(!/href=["']https?:/.test(html), '不得引用外部樣式')
})

test('render 帶入預覽值與網址', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, preview: '1,234', previewValue: 1234, url: 'https://a.test/p' })
  assert.match(doc.getElementById('preview').textContent, /1,234/)
  assert.equal(doc.getElementById('url').value ?? doc.getElementById('url').textContent, 'https://a.test/p')
})

test('儲存:驗證失敗時顯示錯誤且不寫入 storage', async () => {
  const { st, pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, preview: '1', previewValue: 1, url: 'https://a.test/p' })
  doc.getElementById('name').value = ''
  await pk.handleSave()
  assert.ok(doc.getElementById('errors').textContent.length > 0, '要把錯誤講出來')
  assert.equal((await st.getTasks()).length, 0)
})

test('儲存:成功時寫入 storage 並請 background 重建排程', async () => {
  const { c, st, pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, preview: '1', previewValue: 1, url: 'https://a.test/p' })
  doc.getElementById('name').value = '總量'
  doc.getElementById('times').value = '09:00,15:00'
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].name, '總量')
  assert.deepEqual(tasks[0].schedule.times, ['09:00', '15:00'])
  const msg = c.__calls.find(x => x.api === 'runtime.sendMessage')
  assert.ok(msg, '必須通知 background')
  assert.equal(msg.args[0].type, 'REBUILD_ALARMS')
})

test('立即測試:送 EXTRACT 到目標分頁並顯示結果,不寫入 storage', async () => {
  const { c, st, pk, doc } = await fresh()
  c.__setTabResponder(() => ({ ok: true, value: 42, raw: '42', status: 'ok', strategyUsed: 'auto' }))
  pk.render({ locator: LOCATOR, preview: '1', previewValue: 1, url: 'https://a.test/p', tabId: 7 })
  doc.getElementById('name').value = '總量'
  await pk.handleTestNow()
  const sent = c.__calls.find(x => x.api === 'tabs.sendMessage')
  assert.ok(sent, '應向目標分頁要值')
  assert.equal(sent.args[0], 7)
  assert.equal(sent.args[1].type, 'EXTRACT')
  assert.match(doc.getElementById('preview').textContent, /42/)
  assert.equal((await st.getTasks()).length, 0, '測試不得建立任務')
})

test('立即測試:抓不到時顯示原因', async () => {
  const { c, pk, doc } = await fresh()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found' }))
  pk.render({ locator: LOCATOR, preview: '1', previewValue: 1, url: 'https://a.test/p', tabId: 7 })
  await pk.handleTestNow()
  assert.match(doc.getElementById('preview').textContent + doc.getElementById('errors').textContent, /not_found|找不到/)
})
