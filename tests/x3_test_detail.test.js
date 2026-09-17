// AF-17 作業 B：立即測試的「看抓到的格子」明細表，以及 items／blank 只給預覽、不進紀錄
// 規格見 docs/AF-17-PLAN.md 作業 B。擷取端產出 items 的行為在 x1 驗；從擷取端一路到畫面的鏈結在 m2_chain。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

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

async function freshFetcher() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  return { c, st, fe }
}

const LOCATOR = { css: '#mon', path: 'body > table:nth-of-type(1)', anchor: null, xpath: '/html[1]/body[1]/table[1]' }
const colPick = { block: { axis: 'col', index: 1, headerText: '值' } }
const rowPick = { block: { axis: 'row', index: 0, headerText: 'r0' } }
const cellPick = { cell: { row: { index: 0, header: 'r0' }, col: { index: 1, header: '值' } } }
const ctxFor = (picks) => ({
  locator: LOCATOR, url: 'https://mon.test/p', nameHint: '監控', tabId: 5,
  blockInfo: { kind: 'table', rows: 9, cols: 2, headers: ['主機', '值'] },
  picks
})

// 八種處置各一列
const ITEMS8 = [
  { index: 0, header: 'r0', use: 'trimmed', raw: '' },
  { index: 1, header: 'r1', use: 'skipHead', raw: '標題' },
  { index: 2, header: 'r2', use: 'used', raw: '10', number: 10 },
  { index: 3, header: 'r3', use: 'nonnumeric', raw: '—' },
  { index: 4, header: 'r4', use: 'blank', raw: '' },
  { index: 5, header: 'r5', use: 'used', raw: '20', number: 20 },
  { index: 6, header: 'r6', use: 'excluded', raw: '999' },
  { index: 7, header: 'r7', use: 'skipTail', raw: '99' },
  { index: 8, header: 'r8', use: 'unresolved' }
]
const USE_TEXT = {
  used: '採用', nonnumeric: '非數字', blank: '空白', trimmed: '頭尾空白（已自動略過）',
  skipHead: '略過開頭', skipTail: '略過結尾', excluded: '排除', unresolved: '找不到子路徑'
}
const OK8 = { ok: true, value: 30, raw: '10, —, , 20', status: 'ok', strategyUsed: 'block', used: 2, skipped: 3, excluded: 3, blank: 1, items: ITEMS8 }

const $ = (doc, id) => doc.getElementById(id)
const sections = (doc) => [...doc.querySelectorAll('#test-detail [data-test-detail-body] [data-detail-field]')]
const heads = (section) => [...section.querySelectorAll('thead th')].map(th => th.textContent)
const rows = (section) => [...section.querySelectorAll('tbody tr')]
const texts = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent)

// ---- 結構 ----

test('明細表是預覽區裡一個預設藏起來、收合的 details', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  const d = $(doc, 'test-detail')
  assert.ok(d, '要有 #test-detail')
  assert.equal(d.tagName, 'DETAILS')
  assert.ok(d.closest('#preview-section'), '要在「先試抓看看」那一區裡')
  assert.equal(d.hidden, true, '還沒測試之前不顯示')
  assert.equal(d.open, false)
  assert.ok(d.querySelector('summary'), '要有 summary 讓人點開')
  assert.ok(d.querySelector('[data-test-detail-body]'))
})

// ---- 單值 ----

test('單值成功：一段表格、欄名依整欄、每一列帶處置與五格內容', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => OK8)
  await pk.handleTestNow()
  const d = $(doc, 'test-detail')
  assert.equal(d.hidden, false)
  assert.equal(d.open, true, '9 格 ≤30 自動展開（AF-18 批次C）')
  assert.ok(d.querySelector('summary').textContent.includes('9 格'), d.querySelector('summary').textContent)
  const ss = sections(doc)
  assert.equal(ss.length, 1)
  assert.equal(ss[0].querySelector('[data-detail-name]'), null, '單值不放值名稱')
  assert.deepEqual(heads(ss[0]), ['#', '列標題', '內容', '數字', '處置'])
  const trs = rows(ss[0])
  assert.equal(trs.length, 9)
  assert.deepEqual(trs.map(tr => tr.dataset.use), ITEMS8.map(it => it.use))
  assert.deepEqual(texts(trs[2]), ['3', 'r2', '10', '10', '採用'])
  assert.deepEqual(texts(trs[8]), ['9', 'r8', '', '', '找不到子路徑'], '找不到子路徑的格子沒有內容也沒有數字')
  trs.forEach((tr, i) => assert.equal(texts(tr)[4], USE_TEXT[ITEMS8[i].use], `第 ${i + 1} 列的處置文字`))
  assert.equal(trs[1].querySelectorAll('td')[2].title, '標題', '內容欄會被截斷，完整文字放 title')
})

test('單值整列：第二欄叫欄標題', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([rowPick]))
  c.__setRuntimeResponder(() => ({ ...OK8, items: ITEMS8.slice(0, 3) }))
  await pk.handleTestNow()
  assert.deepEqual(heads(sections(doc)[0]), ['#', '欄標題', '內容', '數字', '處置'])
})

test('單值失敗但帶 items（略過太多）：明細表照樣出現，錯誤訊息照舊', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  const items = [0, 1, 2, 3].map(i => ({ index: i, header: `r${i}`, use: 'skipHead', raw: String(i) }))
  c.__setRuntimeResponder(() => ({ ok: false, error: 'not_found', message: '略過開頭 4 列、結尾 0 列後沒有剩下的格子（這一欄只有 4 列）', items }))
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, false, '失敗時正是最需要看表的時候')
  assert.equal(rows(sections(doc)[0]).length, 4)
  assert.ok($(doc, 'errors').textContent.includes('沒有剩下的格子'))
})

test('沒有 items 的結果（儲存格）：明細表維持藏起來', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([cellPick]))
  c.__setRuntimeResponder(() => ({ ok: true, value: 53, raw: '53', status: 'ok' }))
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, true)
})

test('items 是空陣列：當成沒有，維持藏起來', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => ({ ...OK8, items: [] }))
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, true)
})

// ---- 多值 ----

test('多值：每個帶 items 的值一段、段首是值名稱、依值清單順序；儲存格值不出現', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick, rowPick, cellPick]))
  const fields = pk.getFormData().fields
  assert.equal(fields.length, 3, '前提：三個值')
  c.__setRuntimeResponder(() => ({
    ok: true,
    fields: {
      [fields[0].key]: { ok: true, value: 30, raw: '10, 20', status: 'ok', used: 2, skipped: 0, items: ITEMS8.slice(2, 4) },
      [fields[1].key]: { ok: false, error: 'not_found', message: '略過太多', items: ITEMS8.slice(0, 3) },
      [fields[2].key]: { ok: true, value: 53, raw: '53', status: 'ok' }
    }
  }))
  await pk.handleTestNow()
  const ss = sections(doc)
  assert.equal(ss.length, 2)
  assert.deepEqual(ss.map(s => s.querySelector('[data-detail-name]')?.textContent), [fields[0].name, fields[1].name])
  assert.equal(heads(ss[0])[1], '列標題')
  assert.equal(heads(ss[1])[1], '欄標題', '每一段依自己那個值的軸')
  assert.equal(rows(ss[0]).length, 2)
  assert.equal(rows(ss[1]).length, 3, '失敗的值也要看得到')
  assert.ok($(doc, 'test-detail').querySelector('summary').textContent.includes('5 格'))
})

test('多值整包失敗（表格本身解析不出來，沒有逐值結果）：明細表藏起來、不丟例外，錯誤照舊顯示（文件終檢補）', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick, rowPick]))
  assert.equal(pk.getFormData().fields.length, 2, '前提：多值')
  c.__setRuntimeResponder(() => OK8)
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, true, '前提：OK8 是單值形狀，多值找不到逐值 items')
  // 先讓明細表出現，再換成整包失敗，確認失敗那條路會把它收掉
  const fields = pk.getFormData().fields
  c.__setRuntimeResponder(() => ({ ok: true, fields: { [fields[0].key]: { ok: true, value: 1, raw: '1', status: 'ok', used: 1, skipped: 0, items: ITEMS8.slice(2, 3) } } }))
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, false, '前提：多值成功時有顯示')
  c.__setRuntimeResponder(() => ({ ok: false, error: 'not_found', message: '找不到表格' }))
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, true)
  assert.equal(sections(doc).length, 0)
  assert.ok($(doc, 'errors').textContent.includes('找不到表格'))
})

// ---- 清空 ----

test('下一次測試開始就清空：換成沒有 items 的結果時藏起來、內容清掉', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => OK8)
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, false, '前提：第一次有顯示')
  c.__setRuntimeResponder(() => ({ ok: true, value: 1, raw: '1', status: 'ok' }))
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, true)
  assert.equal($(doc, 'test-detail').querySelector('[data-test-detail-body]').children.length, 0, '舊表不得殘留')
})

test('下一次測試開始就收合：使用者上次展開過，新結果回來仍是收合、不重複疊加', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => OK8)
  await pk.handleTestNow()
  $(doc, 'test-detail').open = true
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').open, true, '9 格 ≤30：新結果依門檻重新決定展開（AF-18 批次C）')
  assert.equal(sections(doc).length, 1, '第二次不得把表疊在第一次後面')
})

test('換目標（render 再跑一次）：上一個目標的明細表要收掉，不能配著新目標的預覽留在畫面上（體檢補）', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => OK8)
  await pk.handleTestNow()
  $(doc, 'test-detail').open = true
  assert.equal($(doc, 'test-detail').hidden, false, '前提：第一個目標測過、明細表展開著')
  pk.render(ctxFor([rowPick]))
  assert.equal($(doc, 'test-detail').hidden, true, '換了目標，舊表就是別張表的明細')
  assert.equal($(doc, 'test-detail').open, false)
  assert.equal(sections(doc).length, 0)
})

test('立即測試丟例外（連 background 都問不到）：上一次的明細表要在開始時就收掉，不能配著新錯誤留著（體檢補）', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => OK8)
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, false, '前提：第一次有顯示')
  c.__setRuntimeResponder(() => { throw new Error('Extension context invalidated') })
  await pk.handleTestNow()
  assert.equal($(doc, 'test-detail').hidden, true)
  assert.equal(sections(doc).length, 0)
  assert.ok($(doc, 'errors').textContent.includes('Extension context invalidated'))
})

// ---- 安全 ----

test('格子文字是網頁上的任意字串：一律當文字，不得變成元素', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick]))
  c.__setRuntimeResponder(() => ({ ...OK8, items: [{ index: 0, header: '<i>h</i>', use: 'nonnumeric', raw: '<b>x</b>' }] }))
  await pk.handleTestNow()
  const tr = rows(sections(doc)[0])[0]
  assert.deepEqual(texts(tr).slice(1, 3), ['<i>h</i>', '<b>x</b>'])
  assert.equal(tr.querySelector('b, i'), null)
})

// ---- 樣式：只用主題變數 ----

test('樣式：內容區可捲動、非採用列淡化、排除列警告色，只用主題變數', () => {
  const style = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  const rules = [...style.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
  const bodyRules = rules.filter(r => r.sel.includes('data-test-detail-body'))
  assert.ok(bodyRules.length > 0, '要有明細內容區的樣式')
  assert.ok(bodyRules.some(r => /max-height/.test(r.body) && /overflow/.test(r.body)), '列很多時要能捲動，不能把整個面板撐長')
  assert.ok(rules.some(r => r.sel.includes('data-use') && r.body.includes('var(--text-muted)')), '非採用列要淡化')
  assert.ok(rules.some(r => r.sel.includes('data-use="excluded"') && r.body.includes('var(--warn)')), '排除列要用警告色')
})

// ---- 不進紀錄 ----

const baseTask = () => ({
  id: 't1', name: '監控', url: 'https://a.test/p', mode: 'block', enabled: true,
  locator: { css: '#t', path: '', anchor: null, xpath: '' },
  spec: { mode: 'block', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum', skip: { head: 0, tail: 0, blank: true } } },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
})

test('單值紀錄：items 與 blank 只給預覽，不寫進紀錄', async () => {
  const { c, st, fe } = await freshFetcher()
  c.__setTabResponder(() => OK8)
  await st.saveTask(baseTask())
  const rec = await fe.runTask(baseTask(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.value, 30, '前提：真的寫了一筆成功紀錄')
  assert.equal(rec.used, 2)
  assert.equal('items' in rec, false, '每筆紀錄夾帶整欄明細，storage 會長到 MB 級')
  assert.equal('blank' in rec, false)
})

test('多值紀錄：每個值的 items 與 blank 都不寫進紀錄', async () => {
  const { c, st, fe } = await freshFetcher()
  const t = {
    ...baseTask(),
    fields: [{ key: 'a', name: '甲' }, { key: 'b', name: '乙' }],
    spec: {
      mode: 'block',
      fields: [
        { key: 'a', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum' } },
        { key: 'b', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'max' } }
      ]
    }
  }
  c.__setTabResponder(() => ({
    ok: true,
    fields: {
      a: { ok: true, value: 30, raw: '10, 20', status: 'ok', used: 2, skipped: 0, blank: 1, items: ITEMS8.slice(2, 6) },
      b: { ok: true, value: 20, raw: '10, 20', status: 'ok', used: 2, skipped: 0, blank: 1, items: ITEMS8.slice(2, 6) }
    }
  }))
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  const all = (await st.getRecordsInRange('2026-09-05', '2026-09-05')).filter(r => r.value !== undefined)
  assert.equal(all.length, 2, '沒有紀錄的話下面的斷言會真空成立')
  for (const r of all) {
    assert.equal('items' in r, false, r.taskId)
    assert.equal('blank' in r, false, r.taskId)
  }
})
