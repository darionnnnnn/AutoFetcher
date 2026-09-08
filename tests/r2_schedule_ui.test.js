// AF-9 作業 B：排程區介面（時刻 chip、時段開關、觸發預覽）
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
const fire = (doc, el, type) => el.dispatchEvent(new doc.defaultView.Event(type))
const chipTimes = (doc) =>
  Array.from(doc.querySelectorAll('#time-chips [data-time-chip]')).map(c => c.getAttribute('data-time-chip'))

test('B5-1 加入時刻：去重、排序，chip 與 #times 同步', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('times').value = ''
  pk.renderTimeChips()

  const input = doc.getElementById('time-input')
  const add = doc.getElementById('time-add')
  for (const t of ['15:00', '09:30', '09:30']) {
    input.value = t
    add.click()
  }
  assert.deepEqual(chipTimes(doc), ['09:30', '15:00'], '重複的時刻只留一個且要排序')
  assert.deepEqual(pk.getFormData().times, ['09:30', '15:00'], '#times 是事實來源，要跟著同步')
})

test('B5-2 移除 chip 之後 buildTask 的 times 也少一個', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('times').value = '09:30, 15:00'
  pk.renderTimeChips()
  doc.querySelector('#time-chips [data-time-remove="09:30"]').click()

  assert.deepEqual(chipTimes(doc), ['15:00'])
  const task = pk.buildTask(pk.getFormData(), LOCATOR)
  assert.deepEqual(task.schedule.times, ['15:00'])
})

test('B5-3 不合法的時刻不加入', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('times').value = ''
  pk.renderTimeChips()
  doc.getElementById('time-input').value = '25:99'
  doc.getElementById('time-add').click()
  assert.deepEqual(chipTimes(doc), [])
})

test('B6-1 沒勾時段開關就不寫 schedule.window', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  fire(doc, doc.getElementById('schedule-type'), 'change')
  doc.getElementById('every-minutes').value = '10'

  const task = pk.buildTask(pk.getFormData(), LOCATOR)
  assert.equal(task.schedule.window, undefined)
})

test('B6-2 勾了時段並填起訖，buildSchedule 才寫 window', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  fire(doc, doc.getElementById('schedule-type'), 'change')
  doc.getElementById('every-minutes').value = '10'
  const cb = doc.getElementById('window-enabled')
  cb.checked = true
  fire(doc, cb, 'change')
  doc.getElementById('window-from').value = '08:30'
  doc.getElementById('window-to').value = '09:20'

  const schedule = pk.buildSchedule(pk.getFormData())
  assert.deepEqual(schedule.window, { from: '08:30', to: '09:20' })
})

test('B6-3 取消勾選要把殘值清掉（否則會排出使用者沒要求的時段）', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  fire(doc, doc.getElementById('schedule-type'), 'change')
  const cb = doc.getElementById('window-enabled')
  cb.checked = true
  fire(doc, cb, 'change')
  doc.getElementById('window-from').value = '08:30'
  doc.getElementById('window-to').value = '09:20'

  cb.checked = false
  fire(doc, cb, 'change')
  assert.equal(doc.getElementById('window-from').value, '')
  assert.equal(pk.buildSchedule(pk.getFormData()).window, undefined)
})

test('B6-4 編輯既有含時段的任務，開關要是勾的、欄位要顯示', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    url: 'https://a.test/p',
    task: {
      id: 't1',
      name: '舊任務',
      url: 'https://a.test/p',
      mode: 'number',
      spec: {},
      schedule: {
        type: 'interval',
        everyMinutes: 10,
        weekdays: [1, 2, 3, 4, 5],
        window: { from: '08:30', to: '09:20' }
      }
    }
  })
  assert.equal(doc.getElementById('window-enabled').checked, true)
  assert.equal(doc.getElementById('window-fields').hidden, false)
  assert.equal(doc.getElementById('window-from').value, '08:30')
})

test('B7-1 觸發預覽：白話句 + 今天實際會跑的時刻與次數', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  fire(doc, doc.getElementById('schedule-type'), 'change')
  doc.getElementById('every-minutes').value = '10'
  const cb = doc.getElementById('window-enabled')
  cb.checked = true
  fire(doc, cb, 'change')
  doc.getElementById('window-from').value = '08:30'
  doc.getElementById('window-to').value = '09:20'
  // 2026-09-07 是星期一，預設星期一到五都勾
  pk.updateSchedulePreview(new Date(2026, 8, 7, 7, 0, 0).getTime())

  const text = doc.getElementById('schedule-preview').textContent
  assert.match(text, /08:30～09:20 之間每 10 分鐘/)
  assert.match(text, /08:30、08:40/)
  assert.match(text, /09:20/)
  assert.match(text, /共 6 次/)
})

test('B7-2 觸發預覽：星期不符時說今天不會執行', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  fire(doc, doc.getElementById('schedule-type'), 'change')
  doc.getElementById('every-minutes').value = '30'
  doc.querySelectorAll('#weekdays input[type="checkbox"]').forEach(c => { c.checked = c.value === '3' })
  // 2026-09-07 星期一，只勾星期三
  pk.updateSchedulePreview(new Date(2026, 8, 7, 7, 0, 0).getTime())

  assert.match(doc.getElementById('schedule-preview').textContent, /今天不會執行/)
})

test('B7-3 觸發預覽：daily 顯示白話句，不列間隔時刻', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('times').value = '09:30, 15:00'
  pk.updateSchedulePreview(new Date(2026, 8, 7, 7, 0, 0).getTime())

  const text = doc.getElementById('schedule-preview').textContent
  assert.match(text, /每日 09:30、15:00/)
  assert.doesNotMatch(text, /今天會跑/)
})

test('B8 任務頁的排程文字與 Picker 走同一份描述（含時段）', async () => {
  const { describeSchedule } = await import('../src/shared/describe.js')
  const src = readFileSync(new URL('../src/ui/report/tasks.js', import.meta.url), 'utf8')
  assert.match(src, /describeSchedule/, '任務頁必須用共用描述，不得自己拼字串')
  assert.doesNotMatch(src, /每 \$\{t\.schedule\.everyMinutes/, '舊的自拼字串要移除')
  assert.equal(
    describeSchedule({ type: 'interval', everyMinutes: 10, window: { from: '08:30', to: '09:20' }, weekdays: [1, 2, 3, 4, 5] }),
    '08:30～09:20 之間每 10 分鐘，週一～五'
  )
})
