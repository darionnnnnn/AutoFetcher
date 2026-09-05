process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'https://x.test/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  return { c, st, rp, doc: jd.window.document, win: jd.window }
}

const rec = (over = {}) => ({
  date: '2026-09-05', taskId: 't1', taskName: '總量', slot: '2026-09-05T09:00',
  capturedAt: '2026-09-05T09:00:05+08:00', value: 10, raw: '10', status: 'ok', ...over
})

const COLS = [
  { key: 'slot', label: '時間', visible: true },
  { key: 'taskName', label: '任務', visible: true },
  { key: 'value', label: '值', visible: true },
  { key: 'status', label: '狀態', visible: true },
  { key: 'strategyUsed', label: '策略', visible: false }
]

test('report.html 有四個頁籤與歷史查詢的骨架', async () => {
  const { doc } = await fresh()
  for (const id of ['tab-dashboard', 'tab-history', 'tab-tasks', 'tab-settings',
                    'range-bar', 'calendar', 'record-table', 'summary', 'filters',
                    'column-config', 'empty-state']) {
    assert.ok(doc.getElementById(id), `缺少 #${id}`)
  }
})

test('report.html 不引用外部資源', async () => {
  assert.ok(!/(src|href)=["']https?:/.test(html))
})

test('report.html 的快捷範圍按鈕齊全', async () => {
  const { doc } = await fresh()
  const kinds = [...doc.querySelectorAll('#range-bar [data-range]')].map(b => b.dataset.range)
  for (const k of ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth'])
    assert.ok(kinds.includes(k), `缺少快捷 ${k}`)
})

test('renderTable:只畫出可見欄位,順序照設定', async () => {
  const { rp, doc } = await fresh()
  rp.renderTable([rec()], COLS)
  const heads = [...doc.querySelectorAll('#record-table thead th')].map(th => th.textContent.trim())
  assert.deepEqual(heads, ['時間', '任務', '值', '狀態'])
  const cells = [...doc.querySelectorAll('#record-table tbody tr:first-child td')].map(td => td.textContent.trim())
  assert.equal(cells.length, 4)
  assert.match(cells[1], /總量/)
})

test('renderTable:調換欄位順序後表頭跟著換', async () => {
  const { rp, doc } = await fresh()
  const swapped = [COLS[2], COLS[0], COLS[1], COLS[3], COLS[4]]
  rp.renderTable([rec()], swapped)
  const heads = [...doc.querySelectorAll('#record-table thead th')].map(th => th.textContent.trim())
  assert.deepEqual(heads, ['值', '時間', '任務', '狀態'])
})

test('renderTable:沒有紀錄時顯示空狀態,不畫空表格', async () => {
  const { rp, doc } = await fresh()
  rp.renderTable([], COLS)
  assert.equal(doc.querySelectorAll('#record-table tbody tr').length, 0)
  assert.notEqual(doc.getElementById('empty-state').hidden, true)
})

test('renderTable:有紀錄時空狀態隱藏', async () => {
  const { rp, doc } = await fresh()
  rp.renderTable([rec()], COLS)
  assert.equal(doc.getElementById('empty-state').hidden, true)
})

test('renderTable:失敗紀錄可展開看錯誤與 DOM 片段', async () => {
  const { rp, doc } = await fresh()
  rp.renderTable([rec({ status: 'not_found', value: undefined, snippet: '<div>片段</div>' })], COLS)
  const row = doc.querySelector('#record-table tbody tr')
  assert.ok(row.classList.contains('failed'), '失敗列要標出來')
  row.click()
  const detail = doc.querySelector('#record-table tbody tr.detail')
  assert.ok(detail, '點一下要展開細節')
  assert.match(detail.textContent, /片段/)
})

test('renderTable:失敗紀錄的值顯示為破折號,不顯示 0', async () => {
  const { rp, doc } = await fresh()
  rp.renderTable([rec({ status: 'parse_error', value: undefined, raw: '--' })], COLS)
  const cells = [...doc.querySelectorAll('#record-table tbody tr:first-child td')].map(td => td.textContent.trim())
  assert.ok(!cells.includes('0'), '絕對不可以把抓不到顯示成 0')
})

test('點表頭切換排序方向', async () => {
  const { rp, doc } = await fresh()
  rp.renderTable([rec({ value: 30 }), rec({ value: 10 })], COLS)
  const valueHead = [...doc.querySelectorAll('#record-table thead th')].find(th => th.textContent.trim() === '值')
  valueHead.click()
  let vals = [...doc.querySelectorAll('#record-table tbody tr:not(.detail) td:nth-child(3)')].map(td => td.textContent.trim())
  assert.deepEqual(vals, ['10', '30'])
  valueHead.click()
  vals = [...doc.querySelectorAll('#record-table tbody tr:not(.detail) td:nth-child(3)')].map(td => td.textContent.trim())
  assert.deepEqual(vals, ['30', '10'])
})

test('renderSummary:每任務一列,含筆數與統計', async () => {
  const { rp, doc } = await fresh()
  rp.renderSummary([{ taskId: 't1', taskName: '總量', count: 3, failCount: 1, min: 10, max: 30, avg: 20, first: 10, last: 30, delta: 20 }])
  const t = doc.getElementById('summary').textContent
  for (const s of ['總量', '3', '10', '30', '20']) assert.ok(t.includes(s), `摘要應含 ${s}`)
})

test('renderSummary:統計為 null 時顯示破折號', async () => {
  const { rp, doc } = await fresh()
  rp.renderSummary([{ taskId: 't1', taskName: '總量', count: 1, failCount: 1, min: null, max: null, avg: null, first: null, last: null, delta: null }])
  assert.ok(!/\b0\b/.test(doc.getElementById('summary').textContent), '沒有數值時不可顯示 0')
})

test('renderCalendar:有紀錄的日期打點,有失敗的標紅', async () => {
  const { rp, doc } = await fresh()
  rp.renderCalendar(2026, 9, { '2026-09-05': { count: 3, hasFail: true }, '2026-09-06': { count: 1, hasFail: false } })
  const d5 = doc.querySelector('#calendar [data-date="2026-09-05"]')
  const d6 = doc.querySelector('#calendar [data-date="2026-09-06"]')
  const d7 = doc.querySelector('#calendar [data-date="2026-09-07"]')
  assert.ok(d5.classList.contains('has-fail'))
  assert.ok(d6.classList.contains('has-records'))
  assert.ok(!d7.classList.contains('has-records'), '沒紀錄的日期不打點')
})

test('renderCalendar:不屬於本月的格子標出來', async () => {
  const { rp, doc } = await fresh()
  rp.renderCalendar(2026, 9, {})
  assert.ok(doc.querySelectorAll('#calendar .out-of-month').length > 0)
})

test('點月曆日期會更新狀態與網址 hash', async () => {
  const { rp, doc, win } = await fresh()
  rp.renderCalendar(2026, 9, { '2026-09-05': { count: 1, hasFail: false } })
  doc.querySelector('#calendar [data-date="2026-09-05"]').click()
  assert.equal(rp.getState().from, '2026-09-05')
  assert.equal(rp.getState().to, '2026-09-05')
  assert.match(win.location.hash, /2026-09-05/)
})

test('點快捷範圍會更新狀態', async () => {
  const { rp, doc } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-05&to=2026-09-05')
  doc.querySelector('#range-bar [data-range="last7"]').click()
  const s = rp.getState()
  assert.notEqual(s.from, s.to, '近七天不會是同一天')
})

test('initFromHash 還原上次在看的日期,重新整理不會跳回今天', async () => {
  const { rp } = await fresh()
  rp.initFromHash('#view=history&from=2026-01-02&to=2026-01-05')
  assert.equal(rp.getState().from, '2026-01-02')
  assert.equal(rp.getState().to, '2026-01-05')
})

test('initFromHash 收到壞掉的 hash 不會炸,退回預設', async () => {
  const { rp } = await fresh()
  assert.doesNotThrow(() => rp.initFromHash('#@@@garbage'))
  assert.ok(rp.getState().from, '仍要有一個可用的日期範圍')
})

test('切換頁籤只顯示對應面板', async () => {
  const { rp, doc } = await fresh()
  rp.showTab('tasks')
  assert.equal(doc.getElementById('panel-tasks').hidden, false)
  assert.equal(doc.getElementById('panel-history').hidden, true)
  rp.showTab('history')
  assert.equal(doc.getElementById('panel-history').hidden, false)
  assert.equal(doc.getElementById('panel-tasks').hidden, true)
})

test('欄位設定:取消勾選後該欄消失,設定被記住', async () => {
  const { st, rp, doc } = await fresh()
  rp.renderColumnConfig(COLS)
  const box = doc.querySelector('#column-config input[value="status"]')
  assert.ok(box, '每個欄位要有勾選框')
  box.checked = false
  box.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 5))
  const saved = (await st.getSettings()).history?.columns
  assert.ok(saved, '欄位設定要存起來')
  assert.equal(saved.find(c => c.key === 'status').visible, false)
})
