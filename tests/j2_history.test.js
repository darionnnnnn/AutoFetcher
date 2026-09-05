process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, name, order = 0) => ({
  id, name, url: `https://x.test/${id}`, mode: 'number', enabled: true, order,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

const rec = (taskId, slot, value, status = 'ok', over = {}) => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const lg = await import('../src/ui/report/logic.js?t=' + Math.random())
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  return { c, st, lg, rp, doc: jd.window.document, win: jd.window }
}

const fire = (win, el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }))

// ---- 篩選純函式 ----

test('值範圍篩選：大於等於', async () => {
  const { lg } = await fresh()
  const recs = [rec('t1', '2026-09-01T09:00', 5), rec('t1', '2026-09-01T10:00', 15)]
  assert.deepEqual(lg.filterRecords(recs, { valueMin: 10 }).map(r => r.value), [15])
})

test('值範圍篩選：小於等於，兩者可並用', async () => {
  const { lg } = await fresh()
  const recs = [rec('t1', 'a', 5), rec('t1', 'b', 15), rec('t1', 'c', 25)]
  assert.deepEqual(lg.filterRecords(recs, { valueMax: 20 }).map(r => r.value), [5, 15])
  assert.deepEqual(lg.filterRecords(recs, { valueMin: 10, valueMax: 20 }).map(r => r.value), [15])
})

test('值範圍篩選排除非數值的紀錄', async () => {
  const { lg } = await fresh()
  const recs = [rec('t1', 'a', '文字'), rec('t1', 'b', 15)]
  assert.deepEqual(lg.filterRecords(recs, { valueMin: 1 }).map(r => r.value), [15])
})

test('關鍵字篩選比對值與原文', async () => {
  const { lg } = await fresh()
  const recs = [rec('t1', 'a', '停電公告', 'ok', { raw: '停電公告' }), rec('t1', 'b', '正常', 'ok', { raw: '正常' })]
  assert.deepEqual(lg.filterRecords(recs, { keyword: '停電' }).map(r => r.value), ['停電公告'])
})

test('只看告警只留下失敗紀錄', async () => {
  const { lg } = await fresh()
  const recs = [rec('t1', 'a', 1, 'ok'), rec('t1', 'b', null, 'not_found'), rec('t1', 'c', 2, 'late')]
  assert.deepEqual(lg.filterRecords(recs, { alertsOnly: true }).map(r => r.status), ['not_found'])
})

test('沒有給任何篩選時原樣回傳', async () => {
  const { lg } = await fresh()
  const recs = [rec('t1', 'a', 1), rec('t1', 'b', 2)]
  assert.equal(lg.filterRecords(recs, {}).length, 2)
})

// ---- 分頁 ----

test('paginate 依每頁筆數切割', async () => {
  const { lg } = await fresh()
  const rows = Array.from({ length: 1500 }, (_, i) => i)
  const p = lg.paginate(rows, 1, 500)
  assert.equal(p.items.length, 500)
  assert.equal(p.totalPages, 3)
  assert.equal(p.items[0], 0)
})

test('paginate 最後一頁不足量也正確', async () => {
  const { lg } = await fresh()
  const rows = Array.from({ length: 1200 }, (_, i) => i)
  const p = lg.paginate(rows, 3, 500)
  assert.equal(p.items.length, 200)
  assert.equal(p.items[0], 1000)
})

test('paginate 頁碼越界時夾到合法範圍', async () => {
  const { lg } = await fresh()
  const rows = Array.from({ length: 10 }, (_, i) => i)
  assert.equal(lg.paginate(rows, 99, 5).page, 2)
  assert.equal(lg.paginate(rows, 0, 5).page, 1)
})

// ---- 比較兩天 ----

test('compareDays 並排兩天同時刻的值與差異', async () => {
  const { lg } = await fresh()
  const a = [rec('t1', '2026-09-01T09:00', 10)]
  const b = [rec('t1', '2026-09-02T09:00', 15)]
  const out = lg.compareDays(a, b, ['t1'])
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].time, '09:00')
  assert.equal(out.rows[0].values.t1.a, 10)
  assert.equal(out.rows[0].values.t1.b, 15)
  assert.equal(out.rows[0].values.t1.delta, 5)
})

test('compareDays 某一天缺值時差異為 null', async () => {
  const { lg } = await fresh()
  const out = lg.compareDays([rec('t1', '2026-09-01T09:00', 10)], [], ['t1'])
  assert.equal(out.rows[0].values.t1.b, null)
  assert.equal(out.rows[0].values.t1.delta, null)
})

// ---- 樞紐表欄序 ----

test('樞紐表欄序沿用任務頁順序', async () => {
  const { st, rp, doc } = await fresh()
  await st.saveTask(task('t1', '電費', 5))
  await st.saveTask(task('t2', '水費', 1))
  rp.renderPivot([rec('t1', '2026-09-01T09:00', 1), rec('t2', '2026-09-01T09:00', 2)],
    [{ id: 't2', name: '水費', order: 1 }, { id: 't1', name: '電費', order: 5 }])
  const heads = [...doc.querySelectorAll('#record-table thead th')].map(th => th.textContent)
  assert.deepEqual(heads.slice(1), ['水費', '電費'], `實得 ${heads}`)
})

// ---- 篩選 UI ----

test('篩選區產生任務多選、狀態、只看告警、值範圍與關鍵字控制項', async () => {
  const { st, rp, doc } = await fresh()
  await st.saveTask(task('t1', '電費'))
  await rp.renderFilters()
  for (const id of ['filter-tasks', 'filter-statuses', 'filter-alerts-only',
                    'filter-value-min', 'filter-value-max', 'filter-keyword']) {
    assert.ok(doc.getElementById(id), `缺少 #${id}`)
  }
  assert.ok(doc.querySelector('#filter-tasks input[value="t1"]'))
})

test('篩選變更後寫進 hash', async () => {
  const { st, rp, doc, win } = await fresh()
  await st.saveTask(task('t1', '電費'))
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-01')
  await rp.renderFilters()
  const kw = doc.getElementById('filter-keyword')
  kw.value = '停電'
  fire(win, kw, 'change')
  await new Promise(r => setTimeout(r, 20))
  assert.ok(win.location.hash.includes('keyword'), `hash 應含 keyword，實得 ${win.location.hash}`)
  assert.equal(rp.getState().keyword, '停電')
})

test('hash 可還原值範圍與只看告警', async () => {
  const { rp } = await fresh()
  rp.initFromHash('#view=history&valueMin=5&valueMax=50&alertsOnly=1')
  const s = rp.getState()
  assert.equal(s.valueMin, 5)
  assert.equal(s.valueMax, 50)
  assert.equal(s.alertsOnly, true)
})

// ---- 月曆導覽 ----

test('月曆有上下月與跳年月的控制項', async () => {
  const { rp, doc } = await fresh()
  rp.renderCalendar(2026, 9, {})
  assert.ok(doc.getElementById('cal-prev-month'))
  assert.ok(doc.getElementById('cal-next-month'))
  assert.ok(doc.getElementById('cal-jump'))
})

test('點下個月會重畫成下一個月', async () => {
  const { rp, doc } = await fresh()
  rp.renderCalendar(2026, 12, {})
  doc.getElementById('cal-next-month').click()
  await new Promise(r => setTimeout(r, 20))
  const dates = [...doc.querySelectorAll('#calendar td[data-date]')].map(td => td.dataset.date)
  assert.ok(dates.some(d => d.startsWith('2027-01')), '跨年要正確')
})

test('月曆拖曳可選連續日期範圍', async () => {
  const { rp, doc, win } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-01')
  rp.renderCalendar(2026, 9, {})
  const start = doc.querySelector('[data-date="2026-09-03"]')
  const end = doc.querySelector('[data-date="2026-09-07"]')
  start.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }))
  end.dispatchEvent(new win.MouseEvent('pointerover', { bubbles: true }))
  end.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(rp.getState().from, '2026-09-03')
  assert.equal(rp.getState().to, '2026-09-07')
})

// ---- 欄序拖曳與設定保存 ----

test('欄位順序可調整並寫回設定', async () => {
  const { st, rp } = await fresh()
  await rp.applyColumnOrder(['value', 'slot', 'taskName'])
  await new Promise(r => setTimeout(r, 20))
  const s = await st.getSettings()
  assert.deepEqual(s.history.columns.map(c => c.key).slice(0, 3), ['value', 'slot', 'taskName'])
})

// ---- 刪除單筆 ----

test('deleteRecord 只刪指定那一筆', async () => {
  const { st } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T10:00', 2))
  await st.deleteRecord('2026-09-01', 't1', '2026-09-01T09:00:00+08:00')
  const left = await st.getRecordsByDate('2026-09-01')
  assert.equal(left.length, 1)
  assert.equal(left[0].value, 2)
})

test('deleteRecord 刪掉當天最後一筆時移除整個日期鍵', async () => {
  const { st } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  await st.deleteRecord('2026-09-01', 't1', '2026-09-01T09:00:00+08:00')
  assert.deepEqual(await st.listDates(), [])
})

test('deleteRecord 對不存在的紀錄不影響其他資料', async () => {
  const { st } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  await st.deleteRecord('2026-09-01', 't1', '不存在')
  assert.equal((await st.getRecordsByDate('2026-09-01')).length, 1)
})

test('展開的紀錄有刪除按鈕，需確認', async () => {
  const { st, rp, doc } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  const recs = await st.getRecordsInRange('2026-09-01', '2026-09-01')
  rp.renderTable(recs)
  doc.querySelector('#record-table tbody tr').click()
  await new Promise(r => setTimeout(r, 20))
  const btn = doc.querySelector('#record-table [data-action="delete-record"]')
  assert.ok(btn, '展開後要有刪除按鈕')
  btn.click()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(doc.getElementById('record-delete-confirm'), '要有確認框')
  doc.querySelector('#record-delete-confirm [data-action="cancel"]').click()
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await st.getRecordsByDate('2026-09-01')).length, 1)
})

// ---- 複製 TSV ----

test('紀錄表格有複製 TSV 按鈕', async () => {
  const { st, rp, doc } = await fresh()
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  rp.renderTable(await st.getRecordsInRange('2026-09-01', '2026-09-01'))
  assert.ok(doc.querySelector('[data-action="copy-records-tsv"]'))
})

// ---- 摘要點任務名跳折線 ----

test('摘要的任務名可點，點了顯示該任務折線', async () => {
  const { st, rp, doc } = await fresh()
  await st.saveTask(task('t1', '電費'))
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 1))
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T10:00', 3))
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-01')
  rp.renderSummary([{ taskId: 't1', taskName: '電費', count: 2, failCount: 0, min: 1, max: 3, avg: 2 }])
  const link = doc.querySelector('#summary [data-task-id="t1"]')
  assert.ok(link, '任務名要可點')
  link.click()
  await new Promise(r => setTimeout(r, 40))
  const box = doc.getElementById('summary-chart')
  assert.ok(box && !box.hidden && box.querySelector('svg'), '要在下方顯示折線')
})

// ---- 分頁 UI ----

test('超過 90 天時顯示分頁控制項，摘要仍算全範圍', async () => {
  const { rp, doc } = await fresh()
  const recs = Array.from({ length: 1200 }, (_, i) =>
    rec('t1', `2026-01-01T${String(i % 24).padStart(2, '0')}:00`, i))
  rp.renderTable(recs, undefined, { paginate: true, page: 1, pageSize: 500 })
  assert.equal(doc.querySelectorAll('#record-table tbody tr').length, 500)
  const pager = doc.getElementById('record-pager')
  assert.ok(pager && !pager.hidden)
  assert.ok(pager.textContent.includes('3'), '要顯示總頁數 3')
})
