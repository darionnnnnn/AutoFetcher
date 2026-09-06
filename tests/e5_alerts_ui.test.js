// AF-3 批次 E:告警的設定介面與報表顯示
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const pickerHtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

async function picker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(pickerHtml)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

async function report() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(reportHtml, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return { c, st, doc: jd.window.document, win: jd.window }
}

// ---- Picker:設定告警條件 ----

test('Picker 有告警設定區,可以新增一條條件', async () => {
  const { pk, doc } = await picker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1,234', previewValue: 1234 })
  const section = doc.getElementById('alert-section')
  assert.ok(section, 'picker.html 必須有告警設定區')
  const addBtn = doc.getElementById('alert-add')
  assert.ok(addBtn, '必須有「新增條件」按鈕')
  addBtn.click()
  const rows = doc.querySelectorAll('[data-alert-row]')
  assert.equal(rows.length, 1)
  assert.ok(rows[0].querySelector('select'), '每條要能選型別')
  assert.ok(rows[0].querySelector('input'), '每條要能填數值')
})

test('五種告警型別都選得到', async () => {
  const { pk, doc } = await picker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1' })
  doc.getElementById('alert-add').click()
  const types = [...doc.querySelectorAll('[data-alert-row] select option')].map(o => o.value)
  for (const t of ['gt', 'lt', 'eq', 'deltaPct', 'failStreak']) {
    assert.ok(types.includes(t), `缺少型別 ${t},實得 ${types.join(',')}`)
  }
})

test('設定好的條件會存進 task.alerts,每條都有 id 與 enabled', async () => {
  const { pk, doc } = await picker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1' })
  doc.getElementById('alert-add').click()
  const row = doc.querySelector('[data-alert-row]')
  row.querySelector('select').value = 'gt'
  row.querySelector('input').value = '1000'
  doc.getElementById('name').value = '電費'

  const t = pk.buildTask(
    { name: '電費', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6],
      alerts: [{ id: 'x1', type: 'gt', value: 1000, enabled: true }] },
    { css: '#v' }
  )
  assert.equal(t.alerts.length, 1)
  assert.equal(t.alerts[0].type, 'gt')
  assert.equal(t.alerts[0].value, 1000)
  assert.equal(t.alerts[0].enabled, true)
  assert.ok(t.alerts[0].id, '每條要有自己的 id,去重帳本要用')
})

test('條件可以刪除', async () => {
  const { pk, doc } = await picker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1' })
  doc.getElementById('alert-add').click()
  doc.getElementById('alert-add').click()
  assert.equal(doc.querySelectorAll('[data-alert-row]').length, 2)
  doc.querySelector('[data-alert-row] [data-action="alert-remove"]').click()
  assert.equal(doc.querySelectorAll('[data-alert-row]').length, 1)
})

test('編輯既有任務時,原本的告警條件要顯示出來', async () => {
  const { pk, doc } = await picker()
  pk.render({
    locator: { css: '#v' }, url: 'https://a.test/p', preview: '1',
    task: {
      id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number',
      locator: { css: '#v' }, spec: { strategy: 'auto' },
      schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
      alerts: [
        { id: 'x1', type: 'gt', value: 1000, enabled: true },
        { id: 'x2', type: 'failStreak', value: 3, enabled: false }
      ]
    }
  })
  const rows = doc.querySelectorAll('[data-alert-row]')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].querySelector('select').value, 'gt')
  assert.equal(rows[0].querySelector('input').value, '1000')
  assert.equal(rows[1].querySelector('select').value, 'failStreak')
})

test('數值空白或非數字的條件不得存進去', async () => {
  const { pk } = await picker()
  const t = pk.buildTask(
    { name: '電費', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6],
      alerts: [
        { id: 'x1', type: 'gt', value: 1000, enabled: true },
        { id: 'x2', type: 'lt', value: NaN, enabled: true },
        { id: 'x3', type: 'gt', value: '', enabled: true }
      ] },
    { css: '#v' }
  )
  assert.equal(t.alerts.length, 1, `只有合法的那條該留下,實得 ${JSON.stringify(t.alerts)}`)
  assert.equal(t.alerts[0].id, 'x1')
})

// ---- 報表:告警的顯示 ----

test('月曆:告警日期帶得出 hasAlert(過去只看失敗)', async () => {
  const lg = await import('../src/ui/report/logic.js?t=' + Math.random())
  const weeks = lg.buildCalendar(2026, 9, {
    '2026-09-06': { count: 1, hasFail: false, hasAlert: true },
    '2026-09-07': { count: 1, hasFail: false, hasAlert: false }
  })
  const days = weeks.flat()
  assert.equal(days.find(d => d.date === '2026-09-06').hasAlert, true, '有告警的日期要標記')
  assert.equal(days.find(d => d.date === '2026-09-07').hasAlert, false)
  assert.equal(days.find(d => d.date === '2026-09-08').hasAlert, false, '沒有紀錄的日期不得是 undefined')
})

test('月曆統計:命中告警的日子要算進 hasAlert', async () => {
  const lg = await import('../src/ui/report/logic.js?t=' + Math.random())
  const { isSuccess } = await import('../src/shared/record-status.js?t=' + Math.random())
  const stats = lg.buildDateStats([
    { date: '2026-09-06', status: 'ok', value: 1234, alert: true },
    { date: '2026-09-06', status: 'ok', value: 5 },
    { date: '2026-09-07', status: 'ok', value: 5 },
    { date: '2026-09-08', status: 'not_found' }
  ], isSuccess)
  assert.equal(stats['2026-09-06'].hasAlert, true, '同一天只要有一筆告警就算')
  assert.equal(stats['2026-09-06'].count, 2)
  assert.equal(stats['2026-09-07'].hasAlert, false)
  assert.equal(stats['2026-09-08'].hasFail, true, '失敗的判定不能被改壞')
})

test('月曆格子:hasAlert 的日期要上得了色', async () => {
  const { doc } = await report()
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  rp.renderCalendar(2026, 9, { '2026-09-06': { count: 1, hasFail: false, hasAlert: true } })
  const cells = [...doc.querySelectorAll('#calendar td')]
  const target = cells.find(td => td.className.includes('has-alert'))
  assert.ok(target, '告警日期的格子要有 has-alert')
  const failCells = cells.filter(td => td.className.includes('has-fail'))
  assert.equal(failCells.length, 0, '沒有失敗就不該標成失敗')
})

test('歷史列:命中告警的紀錄看得出來,展開後看得到是哪一條', async () => {
  const { doc } = await report()
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  rp.renderTable([
    { taskId: 't1', slot: '2026-09-06T09:00', capturedAt: '2026-09-06T09:00:05+08:00',
      value: 1234, status: 'ok', alert: true, alertHits: ['a1'] }
  ])
  const row = doc.querySelector('#record-table tbody tr:not(.detail)')
  assert.ok(row, '要有一列')
  assert.ok(row.className.includes('has-alert') || row.textContent.includes('🔔'),
    `告警列要看得出來,實得 class=${row.className} 文字=${row.textContent}`)
  row.click()
  const detail = doc.querySelector('#record-table tbody tr.detail')
  assert.ok(detail && detail.textContent.includes('a1'), `展開要看得到命中的條件,實得:${detail?.textContent}`)
})

test('每一列告警條件都有自己的 id(去重帳本靠它分辨)', async () => {
  const { pk, st, doc } = await picker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1' })
  doc.getElementById('name').value = '電費'
  doc.getElementById('alert-add').click()
  doc.getElementById('alert-add').click()
  const rows = doc.querySelectorAll('[data-alert-row]')
  rows[0].querySelector('select').value = 'gt'
  rows[0].querySelector('input').value = '1000'
  rows[1].querySelector('select').value = 'lt'
  rows[1].querySelector('input').value = '10'
  await pk.handleSave()
  const saved = (await st.getTasks())[0]
  assert.ok(saved, '任務要存得起來')
  assert.equal(saved.alerts.length, 2)
  assert.ok(saved.alerts[0].id && saved.alerts[1].id, '兩條都要有 id')
  assert.notEqual(saved.alerts[0].id, saved.alerts[1].id, '兩條的 id 不能相同')
})
