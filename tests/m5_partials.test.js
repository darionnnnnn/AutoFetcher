// AF-5 逐條比對:剩下「部分實作」的項目
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// ---- B5-7：差值算在純函式層 ----

test('差值的計算是純函式，不綁 DOM', async () => {
  const S = await import('../src/ui/report/series.js?t=' + Math.random())
  assert.equal(typeof S.withDelta, 'function', '差值要能單獨算、單獨測')
  const rows = [
    { t: 'd1', values: { a: 10 } },
    { t: 'd2', values: { a: 12 } },
    { t: 'd3', values: { a: 9 } }
  ]
  const out = S.withDelta(rows, ['a'])
  assert.equal(out[0].deltas.a, undefined, '第一列沒有上一列可比')
  assert.equal(out[1].deltas.a.diff, 2)
  assert.equal(out[1].deltas.a.prev, 10)
  assert.equal(out[2].deltas.a.diff, -3)
})

test('缺值不補零也不內插', async () => {
  const S = await import('../src/ui/report/series.js?t=' + Math.random())
  const out = S.withDelta([
    { t: 'd1', values: { a: 10 } },
    { t: 'd2', values: {} },
    { t: 'd3', values: { a: 9 } }
  ], ['a'])
  assert.equal(out[1].deltas.a, undefined)
  assert.equal(out[2].deltas.a, undefined, '上一列沒有值就算不出差（不拿更早的值硬湊）')
})

test('不修改傳入的資料', async () => {
  const S = await import('../src/ui/report/series.js?t=' + Math.random())
  const rows = [{ t: 'd1', values: { a: 1 } }, { t: 'd2', values: { a: 3 } }]
  const snapshot = JSON.stringify(rows)
  S.withDelta(rows, ['a'])
  assert.equal(JSON.stringify(rows), snapshot)
})

test('樞紐表仍然顯示得出差值', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  const rec = (slot, v) => ({ taskId: 'a', slot, capturedAt: slot + ':00+08:00', value: v, raw: String(v), status: 'ok' })
  const el = CR.renderCard(
    { id: 'c', type: 'table', x: 0, y: 0, w: 12, h: 4, source: [{ taskId: 'a' }], options: { mode: 'pivot', bucketMinutes: 1440, showDelta: true } },
    {
      records: [rec('2026-09-05T09:30', 10), rec('2026-09-06T09:30', 12)],
      tasksById: { a: { id: 'a', name: '用電', shortName: '用電', parentId: 'a' } },
      parentTasksById: { a: { id: 'a', name: '用電' } },
      health: {}, nextRuns: {}, missed: [], range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06'
    }
  )
  const deltas = [...el.querySelectorAll('[data-delta]')].map(d => d.textContent.trim())
  assert.ok(deltas.some(d => d.includes('2')), `實得：${deltas.join(' / ')}`)
})

// ---- B5-1：側欄的值可以收起來 ----

test('側欄的多值任務可以收合，不然三家銀行十八列全攤開', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask({
    id: 'bank', name: '臺銀', url: 'https://bank.test/rate', mode: 'block', enabled: true,
    spec: { strategy: 'auto', mode: 'block', fields: [{ key: 'k1' }, { key: 'k2' }] },
    fields: [{ key: 'k1', name: '美金買入' }, { key: 'k2', name: '美金賣出' }],
    schedule: { type: 'daily', times: ['09:30'] }
  })
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  jd.window.document.getElementById('edit-layout').click()
  await new Promise(r => setTimeout(r, 30))
  const doc = jd.window.document
  const toggle = doc.querySelector('[data-palette-toggle]')
  assert.ok(toggle, '要有一個收合的把手')
  const child = doc.querySelector('[data-palette-series]')
  assert.equal(child.hidden, false, '預設展開')
  toggle.click()
  assert.equal(doc.querySelector('[data-palette-series]').hidden, true, '收合後子項要藏起來')
})

// ---- B4：值清單獨立捲動、聚合只對聚合型的值顯示 ----

test('值清單自己捲動，不把整張表單撐長', () => {
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const block = html.slice(html.indexOf('#field-list'), html.indexOf('#field-list') + 300)
  assert.ok(/overflow-y:\s*auto/.test(block), '十個值會把儲存按鈕擠出畫面')
  assert.ok(/max-height/.test(block))
})

test('全部都是儲存格的值時不顯示聚合方式', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render({
    url: 'https://bank.test/rate', locator: { css: '#rate' },
    blockInfo: { kind: 'table', rows: 2, cols: 5 },
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '買入' } } },
      { cell: { row: { index: 0, header: '美金' }, col: { index: 4, header: '賣出' } } }
    ]
  })
  const aggRow = jd.window.document.getElementById('block-aggregate').closest('label')
  assert.equal(aggRow.hidden, true, '一格就是一個值，沒有東西要聚合')
})

test('有聚合型的值時聚合方式要出現', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render({
    url: 'https://bank.test/rate', locator: { css: '#rate' },
    blockInfo: { kind: 'table', rows: 2, cols: 5 },
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 3, header: '買入' } } },
      { block: { axis: 'col', index: 4, headerText: '賣出' } }
    ]
  })
  assert.equal(jd.window.document.getElementById('block-aggregate').closest('label').hidden, false)
})

// ---- D-5：舊策略要看得到 ----

test('編輯用了已移除策略的舊任務時，畫面要說明', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(phtml, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render({
    task: {
      id: 'o', name: '既有', url: 'https://x.test/o', mode: 'number',
      spec: { strategy: 'attr', attr: 'data-value' },
      schedule: { type: 'daily', times: ['09:30'] }
    }
  })
  const note = jd.window.document.getElementById('legacy-strategy-note')
  assert.ok(note && !note.hidden, '下拉裡沒有這個策略，不說明使用者會以為設定不見了')
  assert.ok(note.textContent.includes('attr'))
})

// ---- B2-5：全失敗時取出現最多的錯誤 ----

test('全部值失敗時，燈號取出現最多的那個原因', async () => {
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  const r = (status) => ({ status })
  const h = fe.healthFromRecords([r('parse_error'), r('not_found'), r('not_found')], false)
  assert.equal(h.status, 'selector_lost', '三個值裡兩個是找不到元素，就該報找不到元素')
})
