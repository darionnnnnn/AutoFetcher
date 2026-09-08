// AF-8：位置定位的 label 要真的進紀錄、也要真的顯示在歷史頁
// （只驗到 extractValue 的回傳等於沒驗，中間任何一段掉了都不會紅）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

const task = (over = {}) => ({
  id: 't1', name: '成交金額', url: 'https://a.test/p', mode: 'block', enabled: true,
  locator: { css: '#t', path: '', anchor: null, xpath: '' },
  spec: { mode: 'block', block: { cell: { row: { pos: 'last' }, col: { index: 2, header: '成交金額' } } } },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

test('單值任務：位置定位的 label 要寫進紀錄', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder(() => ({
    ok: true, value: 997944, raw: '997944', status: 'ok', strategyUsed: 'cell', label: '115/09/07'
  }))
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.label, '115/09/07',
    '紀錄沒有 label 的話，使用者分不出「網站還沒更新」與「抓錯列」')
})

test('多值任務：每個值各自的 label 都要寫進紀錄', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const multi = task({
    fields: [{ key: 'amt', name: '成交金額' }, { key: 'vol', name: '成交股數' }],
    spec: {
      mode: 'block',
      fields: [
        { key: 'amt', cell: { row: { pos: 'last' }, col: { index: 2, header: '成交金額' } } },
        { key: 'vol', cell: { row: { pos: 'last' }, col: { index: 1, header: '成交股數' } } }
      ]
    }
  })
  c.__setTabResponder(() => ({
    ok: true,
    fields: {
      amt: { ok: true, value: 997944, raw: '997944', status: 'ok', label: '115/09/07' },
      vol: { ok: true, value: 11024, raw: '11024', status: 'ok', label: '115/09/07' }
    }
  }))
  await st.saveTask(multi)
  await fe.runTask(multi, { slot: '2026-09-05T09:00', ...FAST })
  const all = await st.getRecordsInRange('2026-09-05', '2026-09-05')
  const labels = all.filter(r => r.value !== undefined).map(r => r.label)
  assert.equal(labels.length, 2, `兩個值各一筆，實得 ${labels.length}`)
  assert.deepEqual(labels, ['115/09/07', '115/09/07'])
})

test('表頭找不到時，可行動的訊息要寫進紀錄的 error', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder(() => ({
    ok: false, error: 'not_found', message: '標題「日圓」找不到；若這張表每天新增一列，請改用位置定位'
  }))
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', attempt: 3, ...FAST })
  assert.equal(rec.status, 'not_found')
  assert.ok(/位置定位/.test(rec.error || ''),
    `只寫 not_found 等於告訴使用者壞了卻不說能怎麼辦，實得 ${JSON.stringify(rec.error)}`)
})

test('歷史頁要把來源列顯示出來', async () => {
  resetChromeMock()
  installChromeMock()
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  const records = [{
    taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z',
    value: 997944, raw: '997944', status: 'ok', label: '115/09/07'
  }]
  rp.renderTable(records)
  const rows = jd.window.document.querySelectorAll('#record-table tbody tr')
  assert.ok(rows.length > 0, '沒有列的話下面的斷言會真空成立')
  assert.ok(/115\/09\/07/.test(rows[0].getAttribute('title') || ''),
    `來源列要看得到，實得 ${JSON.stringify(rows[0].getAttribute('title'))}`)
})
