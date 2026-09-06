// AF-4 A3:Picker 依排程型別只顯示相關欄位
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { pk, doc: jd.window.document }
}

const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]' }
// 只有 daily 用得到的欄位 / 只有 interval 用得到的欄位
const DAILY_ONLY = ['times']
const INTERVAL_ONLY = ['every-minutes', 'window-from', 'window-to']

const visible = (doc, id) => {
  const el = doc.getElementById(id)
  assert.ok(el, `找不到 #${id}`)
  const row = el.closest('label') || el.parentElement
  return !row.hidden && row.getAttribute('hidden') === null
}

test('選每日固定時間時,間隔與時段欄位隱藏,執行時間顯示', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'daily'
  doc.getElementById('schedule-type').dispatchEvent(new doc.defaultView.Event('change'))
  for (const id of DAILY_ONLY) assert.equal(visible(doc, id), true, `daily 應顯示 #${id}`)
  for (const id of INTERVAL_ONLY) assert.equal(visible(doc, id), false, `daily 應隱藏 #${id}`)
})

test('選固定間隔時,執行時間隱藏,間隔與時段顯示', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new doc.defaultView.Event('change'))
  for (const id of DAILY_ONLY) assert.equal(visible(doc, id), false, `interval 應隱藏 #${id}`)
  for (const id of INTERVAL_ONLY) assert.equal(visible(doc, id), true, `interval 應顯示 #${id}`)
})

test('星期在兩種型別都顯示', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  for (const type of ['daily', 'interval']) {
    doc.getElementById('schedule-type').value = type
    doc.getElementById('schedule-type').dispatchEvent(new doc.defaultView.Event('change'))
    const box = doc.getElementById('weekdays')
    assert.equal(box.hidden, false, `${type} 也要能選星期`)
  }
})

test('切換型別不清空已填的值', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('times').value = '08:00, 20:00'
  doc.getElementById('window-from').value = '08:30'
  const sel = doc.getElementById('schedule-type')
  for (const type of ['interval', 'daily', 'interval']) {
    sel.value = type
    sel.dispatchEvent(new doc.defaultView.Event('change'))
  }
  assert.equal(doc.getElementById('times').value, '08:00, 20:00', '切回來時間不可被清掉')
  assert.equal(doc.getElementById('window-from').value, '08:30')
})

test('編輯既有 interval 任務時,回填後顯示的是 interval 的欄位', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR, url: 'https://a.test/p',
    task: {
      id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number',
      schedule: { type: 'interval', everyMinutes: 10, weekdays: [1, 2, 3, 4, 5], window: { from: '08:30', to: '09:20' } }
    }
  })
  assert.equal(visible(doc, 'every-minutes'), true, '回填 interval 後要顯示間隔欄位')
  assert.equal(visible(doc, 'times'), false)
})

test('daily 時不驗證時段欄位(隱藏欄位的殘值不可擋住存檔)', async () => {
  const { pk } = await fresh()
  const r = pk.validateForm({
    name: '總量', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
    scheduleType: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5],
    everyMinutes: 15, windowFrom: '08:30', windowTo: ''
  })
  assert.equal(r.ok, true, `daily 不該因為時段殘值失敗,實得:${JSON.stringify(r.errors)}`)
})

test('interval 時仍照舊驗證時段起訖要成對', async () => {
  const { pk } = await fresh()
  const r = pk.validateForm({
    name: '總量', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
    scheduleType: 'interval', times: ['09:00'], weekdays: [1, 2, 3, 4, 5],
    everyMinutes: 10, windowFrom: '08:30', windowTo: ''
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.window, '時段只填一半要擋')
})
