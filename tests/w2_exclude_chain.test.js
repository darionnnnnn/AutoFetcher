// AF-16 作業 A 第 2 段：排除設定的規格比對、重選保留、紀錄欄位、歷史頁與白話描述
// （第 1 段只驗到 extractValue 的回傳；這一段從 PICKED 一路驗到紀錄與畫面）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { describeTarget } from '../src/shared/describe.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }
const sender = { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0 }
const TOTAL = { index: 3, header: '合計' }

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

async function freshFetcher() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, fe }
}

const colBlock = (over = {}) => ({ axis: 'col', index: 1, headerText: '點金靈', ...over })

const baseTask = (over = {}) => ({
  id: 't1', name: '監控', url: 'https://a.test/p', mode: 'block', enabled: true,
  locator: { css: '#t', path: '', anchor: null, xpath: '' },
  spec: { mode: 'block', block: { ...colBlock(), aggregate: 'max', skip: { head: 0, tail: 1 } } },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const multiTask = () => {
  const t = baseTask({
    fields: [{ key: 'gold', name: '點金靈' }, { key: 'web', name: 'TSWEB' }],
    spec: {
      mode: 'block',
      fields: [
        { key: 'gold', block: { ...colBlock(), aggregate: 'max', skip: { head: 0, tail: 1 } } },
        { key: 'web', block: { axis: 'col', index: 2, headerText: 'TSWEB', aggregate: 'max', skip: { head: 0, tail: 1 }, exclude: [TOTAL] } }
      ]
    }
  })
  return t
}

// ---- content → background → Picker ----

test('新任務：pick 帶 exclude 要原樣進到面板 ctx（background 不得逐欄重組丟掉它）', async () => {
  const { c } = await freshBg()
  const listener = [...c.runtime.onMessage._listeners][0]
  await new Promise((resolve) => listener({
    type: 'PICKED', purpose: 'task', locator: { css: '#t' }, preview: '', nameHint: '監控',
    blockInfo: { kind: 'table', rows: 4, cols: 3 },
    picks: [{ block: colBlock({ exclude: [TOTAL] }) }]
  }, { tab: { id: 7, url: 'https://a.test/p' } }, resolve))
  const ctx = (await chrome.storage.session.get('panel:7'))['panel:7']?.ctx
  assert.ok(ctx, '要把 ctx 寫進 session 給面板讀')
  assert.deepEqual(ctx.picks[0].block.exclude, [TOTAL])
})

test('重選一路貫穿：任務規格的 exclude 經 ENTER_PICK 的 preselect 送到選取模式，勾回後原樣送回（AF-15 inner 同型位置）', async () => {
  const { c, st } = await freshBg()
  await st.saveTask(baseTask({ spec: { mode: 'block', block: { ...colBlock(), aggregate: 'sum', exclude: [TOTAL] } } }))
  const listener = [...c.runtime.onMessage._listeners][0]
  await new Promise((resolve) => listener({ type: 'ENTER_PICK', purpose: 'repick', taskId: 't1', tabId: 11 }, {}, resolve))
  const sent = c.__calls.filter(x => x.api === 'tabs.sendMessage').map(x => x.args[1]).filter(m => m?.type === 'ENTER_PICK').pop()
  assert.ok(sent, '要送 ENTER_PICK 給分頁')
  assert.deepEqual(sent.preselect?.[0]?.block?.exclude, [TOTAL], 'background 由任務規格推 preselect 時不得逐欄挑掉 exclude')

  // content 端：同一份 preselect 勾回，送出時排除清單還在
  const jd = new JSDOM(`<!doctype html><body><table id="t">
    <thead><tr><th>主機</th><th>點金靈</th></tr></thead>
    <tbody><tr><td>10.0.0.1</td><td id="c0">53</td></tr><tr><td>10.0.0.2</td><td>49</td></tr><tr><td>10.0.0.3</td><td>48</td></tr></tbody>
    <tfoot><tr><td>合計</td><td>150</td></tr></tfoot></table></body>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  pm.enterPickMode({ purpose: 'repick', taskId: 't1', initialTarget: jd.window.document.getElementById('t'), preselect: sent.preselect })
  const cell = jd.window.document.getElementById('c0')
  cell.dispatchEvent(new jd.window.MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new jd.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  jd.window.document.querySelector('[data-af-menu-item="done"]').dispatchEvent(new jd.window.MouseEvent('click', { bubbles: true }))
  const picked = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).filter(m => m?.type === 'PICKED').pop()
  assert.ok(picked, '要送出 PICKED')
  assert.deepEqual(picked.picks[0].block.exclude, [TOTAL])
})

// ---- 重選：exclude 以新的為準、skip 從舊任務保回來、key 不變 ----

test('多值重選：排除清單改了仍是同一個值（key 與名稱不變），exclude 換成新的、skip 留著', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask(multiTask())
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [
      { block: colBlock({ exclude: [TOTAL, { index: 0, header: '10.0.0.1' }] }) },
      { block: { axis: 'col', index: 2, headerText: 'TSWEB' } }
    ]
  }, sender)
  const back = await st.getTask('t1')
  assert.deepEqual(back.fields.map(f => f.key), ['gold', 'web'], '排除清單不是值的身分，key 重生會切斷歷史序列')
  assert.deepEqual(back.fields.map(f => f.name), ['點金靈', 'TSWEB'])
  const [gold, web] = back.spec.fields
  assert.deepEqual(gold.block.exclude, [TOTAL, { index: 0, header: '10.0.0.1' }], '這次點的排除清單就是使用者要的')
  assert.equal('exclude' in web.block, false, '這次沒有排除任何列，舊的排除清單不得留著')
  for (const f of back.spec.fields) {
    assert.deepEqual(f.block.skip, { head: 0, tail: 1 }, '略過頭尾是任務層級設定，重選不得洗掉')
    assert.equal(f.block.aggregate, 'max')
  }
})

test('多值重選：新加進來的 block 值也套上任務層級的 skip', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask(multiTask())
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [
      { block: colBlock() },
      { block: { axis: 'col', index: 2, headerText: 'TSWEB' } },
      { block: { axis: 'col', index: 0, headerText: '主機' } }
    ]
  }, sender)
  const back = await st.getTask('t1')
  assert.equal(back.spec.fields.length, 3)
  assert.deepEqual(back.spec.fields[2].block.skip, { head: 0, tail: 1 })
})

test('單值重選：exclude 換成新的、skip 與聚合方式留著', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask(baseTask())
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [{ block: colBlock({ exclude: [TOTAL] }) }]
  }, sender)
  const back = await st.getTask('t1')
  assert.deepEqual(back.spec.block.exclude, [TOTAL])
  assert.deepEqual(back.spec.block.skip, { head: 0, tail: 1 })
  assert.equal(back.spec.block.aggregate, 'max')
})

test('重選：pick 的排除項多帶的欄位不得進 storage', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask(baseTask())
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [{ block: colBlock({ exclude: [{ index: 3, header: '合計', label: '顯示用', el: 'x' }] }) }]
  }, sender)
  const back = await st.getTask('t1')
  assert.deepEqual(back.spec.block.exclude, [TOTAL])
})

// ---- 紀錄 ----

test('單值紀錄：excluded 要寫進紀錄；排除項找不到的訊息寫進 error、狀態仍是 fallback', async () => {
  const { c, st, fe } = await freshFetcher()
  c.__setTabResponder(() => ({
    ok: true, value: 53, raw: '53, 49', status: 'fallback', strategyUsed: 'block', used: 2, skipped: 0,
    excluded: 1, message: '有 1 個排除項在目前的頁面找不到（合計）'
  }))
  await st.saveTask(baseTask())
  const rec = await fe.runTask(baseTask(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.excluded, 1)
  assert.equal(rec.status, 'fallback')
  assert.match(rec.error || '', /合計/, '合計列改名之後漏排除，使用者要在紀錄裡看得到原因')
})

test('單值紀錄：沒有排除時不放 excluded、不放 error', async () => {
  const { c, st, fe } = await freshFetcher()
  c.__setTabResponder(() => ({ ok: true, value: 53, raw: '53', status: 'ok', strategyUsed: 'block', used: 1, skipped: 0 }))
  await st.saveTask(baseTask())
  const rec = await fe.runTask(baseTask(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal('excluded' in rec, false)
  assert.equal('error' in rec, false)
})

test('多值紀錄：每個值各自的 excluded 與找不到訊息都要寫進紀錄', async () => {
  const { c, st, fe } = await freshFetcher()
  c.__setTabResponder(() => ({
    ok: true,
    fields: {
      gold: { ok: true, value: 53, raw: '53', status: 'ok', used: 3, skipped: 0, excluded: 1 },
      web: { ok: true, value: 427, raw: '427', status: 'fallback', used: 3, skipped: 0, message: '有 1 個排除項在目前的頁面找不到（合計）' }
    }
  }))
  const t = multiTask()
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  const all = (await st.getRecordsInRange('2026-09-05', '2026-09-05')).filter(r => r.value !== undefined)
  assert.equal(all.length, 2, '沒有紀錄的話下面的斷言會真空成立')
  const gold = all.find(r => r.taskId.endsWith('#gold'))
  const web = all.find(r => r.taskId.endsWith('#web'))
  assert.equal(gold.excluded, 1)
  assert.equal('error' in gold, false)
  assert.equal('excluded' in web, false)
  assert.equal(web.status, 'fallback')
  assert.match(web.error || '', /合計/)
})

// ---- 歷史頁 ----

test('歷史頁明細要顯示排除格數', async () => {
  resetChromeMock()
  installChromeMock()
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  rp.renderTable([{
    taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:00.000Z',
    value: 150, raw: '53, 49, 48', status: 'ok', strategyUsed: 'block', used: 3, skipped: 0, excluded: 1
  }])
  const row = jd.window.document.querySelector('#record-table tbody tr')
  assert.ok(row, '沒有列的話下面的斷言會真空成立')
  row.dispatchEvent(new jd.window.MouseEvent('click', { bubbles: true }))
  const detail = jd.window.document.querySelector('#record-table .detail-box')
  assert.ok(detail, '點列要展開明細')
  assert.match(detail.textContent, /排除格數/)
  assert.match(detail.textContent, /排除格數 \(excluded\)：?\s*1/)
})

// ---- 白話描述 ----

const single = (block, over = {}) => describeTarget({ url: 'https://mon.test/x', mode: 'block', block: { headerText: '點金靈', aggregate: 'sum', axis: 'col', ...block }, ...over })

test('描述句：沒有 skip／exclude（或都是空值）時與原本一字不差', () => {
  const plain = single({})
  assert.equal(single({ skip: { head: 0, tail: 0 }, exclude: [] }), plain)
  assert.doesNotMatch(plain, /略過|排除/)
})

test('描述句：整欄說「列」，整列說「格」；只有一邊時只說那一邊', () => {
  assert.match(single({ skip: { head: 0, tail: 1 } }), /略過結尾 1 列/)
  assert.doesNotMatch(single({ skip: { head: 0, tail: 1 } }), /開頭/)
  assert.match(single({ skip: { head: 2, tail: 1 } }), /略過開頭 2 列、結尾 1 列/)
  assert.match(single({ axis: 'row', skip: { head: 1, tail: 0 } }), /略過開頭 1 格/)
  assert.match(single({ exclude: [TOTAL] }), /排除 1 列/)
  assert.match(single({ axis: 'row', exclude: [TOTAL, { index: 0, header: '' }] }), /排除 2 格/)
})

test('描述句：該軸用位置定位時不說略過與排除（取的是那一格）', () => {
  const s = single({ skip: { head: 0, tail: 1 }, exclude: [TOTAL] }, { rowPos: 'last' })
  assert.doesNotMatch(s, /略過|排除/)
  // 整列看的是欄定位：列定位有值不影響整列
  assert.match(single({ axis: 'row', skip: { head: 1, tail: 0 } }, { rowPos: 'last' }), /略過開頭 1 格/)
})

test('描述句：多值任務說出任務層級的略過（單位用「筆」）', () => {
  const s = describeTarget({ url: 'https://mon.test/x', mode: 'block', fieldCount: 3, block: { axis: 'col', headerText: '點金靈', skip: { head: 0, tail: 1 } } })
  assert.match(s, /取 3 個值/)
  assert.match(s, /略過結尾 1 筆/)
})
