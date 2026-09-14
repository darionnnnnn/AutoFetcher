// AF-16 作業 C：Picker 的略過頭尾欄位、排除資訊的顯示、預覽與回填
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

const LOCATOR = { css: '#mon', path: 'body > table:nth-of-type(1)', anchor: null, xpath: '/html[1]/body[1]/table[1]' }
const TOTAL = { index: 3, header: '合計' }
const colPick = (over = {}) => ({ block: { axis: 'col', index: 1, headerText: '點金靈', ...over } })
const rowPick = (over = {}) => ({ block: { axis: 'row', index: 0, headerText: '10.0.0.1', ...over } })
const cellPick = { cell: { row: { index: 0, header: '10.0.0.1' }, col: { index: 1, header: '點金靈' } } }
const ctxFor = (picks, over = {}) => ({
  locator: LOCATOR, url: 'https://mon.test/p', nameHint: '監控',
  blockInfo: { kind: 'table', rows: 4, cols: 3, headers: ['主機', '點金靈', 'TSWEB'] },
  picks, ...over
})
const $ = (doc, id) => doc.getElementById(id)
const setNum = (doc, id, v) => {
  $(doc, id).value = String(v)
  $(doc, id).dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
  $(doc, id).dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
}
const setPos = (doc, id, v) => {
  $(doc, id).value = v
  $(doc, id).dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
}
const skipBox = (doc) => $(doc, 'skip-head').closest('[data-skip-row]') || $(doc, 'skip-head').closest('label')

// ---- 欄位存在與收集 ----

test('兩個數字欄位存在、預設 0、有看得見的標籤', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  for (const id of ['skip-head', 'skip-tail']) {
    const el = $(doc, id)
    assert.ok(el, `要有 #${id}`)
    assert.equal(el.type, 'number')
    assert.equal(el.value, '0')
    assert.equal(el.min, '0')
    const label = el.closest('label')
    assert.ok(label && label.textContent.trim().length > 0, '每個欄位都要有標籤')
  }
})

test('單值整欄：兩欄都是 0 時規格不帶 skip 鍵；填了就帶', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  assert.equal('skip' in pk.buildSpec(pk.getFormData()).block, false)
  setNum(doc, 'skip-tail', 1)
  assert.deepEqual(pk.buildSpec(pk.getFormData()).block.skip, { head: 0, tail: 1 })
})

test('單值整欄：pick 帶的 exclude 要進規格（單值那條路是逐欄重組的）', async () => {
  const { pk } = await fresh()
  pk.render(ctxFor([colPick({ exclude: [TOTAL] })]))
  assert.deepEqual(pk.buildSpec(pk.getFormData()).block.exclude, [TOTAL])
})

test('多值：skip 套到每個 block 值，儲存格值不帶；exclude 各自保留', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick({ exclude: [TOTAL] }), { block: { axis: 'col', index: 2, headerText: 'TSWEB' } }, cellPick]))
  setNum(doc, 'skip-head', 1)
  const spec = pk.buildSpec(pk.getFormData())
  assert.equal(spec.fields.length, 3)
  assert.deepEqual(spec.fields[0].block.skip, { head: 1, tail: 0 })
  assert.deepEqual(spec.fields[1].block.skip, { head: 1, tail: 0 })
  assert.equal('skip' in spec.fields[2].cell, false, '儲存格沒有頭尾可略過')
  assert.deepEqual(spec.fields[0].block.exclude, [TOTAL])
  assert.equal('exclude' in spec.fields[1].block, false)
})

test('非整數或負數輸入當 0，不會寫出壞規格', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  setNum(doc, 'skip-head', -3)
  setNum(doc, 'skip-tail', '1.5')
  assert.equal('skip' in pk.buildSpec(pk.getFormData()).block, false)
})

test('多值編輯：該軸改用位置定位（略過欄位藏起來）時，舊任務帶的 skip 不得偷偷留在規格裡', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    task: {
      id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block',
      fields: [{ key: 'g', name: '點金靈' }, { key: 'w', name: 'TSWEB' }],
      spec: {
        mode: 'block',
        fields: [
          { key: 'g', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: { head: 0, tail: 1 } } },
          { key: 'w', block: { axis: 'col', index: 2, headerText: 'TSWEB', aggregate: 'sum', skip: { head: 0, tail: 1 } } }
        ]
      },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [1, 2, 3, 4, 5] }
    }
  })
  setPos(doc, 'row-pos', 'last')
  assert.equal(skipBox(doc).hidden, true, '前提：有位置就是取那一格，略過欄位藏起來')
  const spec = pk.buildSpec(pk.getFormData())
  assert.equal(spec.fields.length, 2)
  for (const f of spec.fields) {
    assert.equal('skip' in f.block, false, `多值是整包展開舊 block 再組的，舊 skip 要先刪，實得 ${JSON.stringify(f.block)}`)
  }
})

test('換目標（render 再跑一次）：舊目標的排除清單與格內子路徑不得併進新的單值整欄', async () => {
  const { pk } = await fresh()
  pk.render(ctxFor([colPick({ exclude: [TOTAL], inner: [{ tag: 'span', index: 2 }] })]))
  assert.deepEqual(pk.buildSpec(pk.getFormData()).block.exclude, [TOTAL], '前提：第一次的 exclude 有進規格')
  pk.render(ctxFor([{ block: { axis: 'col', index: 2, headerText: 'TSWEB' } }]))
  const block = pk.buildSpec(pk.getFormData()).block
  assert.equal(block.headerText, 'TSWEB')
  assert.equal('exclude' in block, false, '舊表的排除列會套到新表錯誤的列上')
  assert.equal('inner' in block, false, '舊表的格內路徑會讓新目標抓不到')
})

// ---- 顯示條件與標籤 ----

test('顯示條件與聚合下拉同一條：全是儲存格時藏起來', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([cellPick, { cell: { row: { index: 1, header: '10.0.0.2' }, col: { index: 1, header: '點金靈' } } }]))
  assert.equal(skipBox(doc).hidden, true)
})

test('該軸選了位置定位時藏起來，而且被藏起來時規格不寫 skip', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  setNum(doc, 'skip-tail', 1)
  assert.equal(skipBox(doc).hidden, false)
  setPos(doc, 'row-pos', 'last')
  assert.equal(skipBox(doc).hidden, true, '有位置就是取那一格')
  assert.equal('skip' in pk.buildSpec(pk.getFormData()).block, false, '藏起來的設定不得偷偷生效')
})

test('標籤單位跟著軸走：整欄「列」、整列「格」、混合「筆」', async () => {
  const labelText = (doc) => $(doc, 'skip-head').closest('label').textContent
  let { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  assert.match(labelText(doc), /列/)
  ;({ pk, doc } = await fresh())
  pk.render(ctxFor([rowPick()]))
  assert.match(labelText(doc), /格/)
  ;({ pk, doc } = await fresh())
  pk.render(ctxFor([colPick(), rowPick()]))
  assert.match(labelText(doc), /筆/)
})

// ---- 摘要卡、值清單、提示句 ----

test('摘要卡即時反映略過設定', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick()]))
  setNum(doc, 'skip-tail', 1)
  assert.match($(doc, 'summary-target').textContent, /略過結尾 1 列/)
})

test('值清單的位置說明帶出排除數', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick({ exclude: [TOTAL] }), { block: { axis: 'col', index: 2, headerText: 'TSWEB' } }]))
  const wheres = [...doc.querySelectorAll('#field-list [data-field-where]')].map(el => el.textContent)
  assert.match(wheres[0], /排除 1 列/)
  assert.doesNotMatch(wheres[1], /排除/)
})

test('位置定位下有排除清單：提示句說排除不生效', async () => {
  const { pk, doc } = await fresh()
  pk.render(ctxFor([colPick({ exclude: [TOTAL] })]))
  assert.doesNotMatch($(doc, 'pos-hint').textContent, /排除不生效/)
  setPos(doc, 'row-pos', 'last')
  assert.match($(doc, 'pos-hint').textContent, /排除不生效/)
})

// ---- 立即測試預覽 ----

test('單值預覽多一行用了、略過、排除幾格；fallback 的找不到訊息要看得到', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick({ exclude: [TOTAL] })], { tabId: 5 }))
  c.__setRuntimeResponder(() => ({ ok: true, value: 150, raw: '53, 49, 48', status: 'fallback', strategyUsed: 'block', used: 3, skipped: 1, excluded: 1, message: '有 1 個排除項在目前的頁面找不到（合計）' }))
  await pk.handleTestNow()
  const text = $(doc, 'preview').textContent + '\n' + $(doc, 'test-note').textContent + '\n' + $(doc, 'errors').textContent
  assert.match(text, /用了 3 格/)
  assert.match(text, /略過 1 格/)
  assert.match(text, /排除 1 格/)
  assert.match(text, /找不到（合計）/)
})

test('多值預覽：block 值那一行也帶排除資訊', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(ctxFor([colPick(), cellPick], { tabId: 5 }))
  const keys = [...doc.querySelectorAll('#field-list [data-field-row]')].map(r => r.dataset.fieldKey)
  c.__setRuntimeResponder(() => ({
    ok: true,
    fields: {
      [keys[0]]: { ok: true, value: 150, raw: '53, 49, 48', status: 'ok', used: 3, skipped: 0, excluded: 1 },
      [keys[1]]: { ok: true, value: 53, raw: '53', status: 'ok' }
    }
  }))
  await pk.handleTestNow()
  const lines = $(doc, 'preview').textContent.split('\n')
  assert.match(lines[0], /排除 1 格/)
  assert.doesNotMatch(lines[1], /排除/)
})

// ---- 編輯既有任務 ----

test('編輯既有單值任務：略過設定回填、重存保留排除清單', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    task: {
      id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block',
      spec: { mode: 'block', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'max', skip: { head: 1, tail: 2 }, exclude: [TOTAL] } },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [1, 2, 3, 4, 5] }
    }
  })
  assert.equal($(doc, 'skip-head').value, '1')
  assert.equal($(doc, 'skip-tail').value, '2')
  const block = pk.buildSpec(pk.getFormData()).block
  assert.deepEqual(block.skip, { head: 1, tail: 2 })
  assert.deepEqual(block.exclude, [TOTAL])
})

test('編輯既有多值任務：略過設定從第一個 block 值回填', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    task: {
      id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block',
      fields: [{ key: 'c1', name: '主機 A' }, { key: 'g', name: '點金靈' }],
      spec: {
        mode: 'block',
        fields: [
          { key: 'c1', cell: { row: { index: 0, header: '10.0.0.1' }, col: { index: 1, header: '點金靈' } } },
          { key: 'g', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: { head: 0, tail: 1 }, exclude: [TOTAL] } }
        ]
      },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [1, 2, 3, 4, 5] }
    }
  })
  assert.equal($(doc, 'skip-tail').value, '1')
  const spec = pk.buildSpec(pk.getFormData())
  assert.deepEqual(spec.fields[1].block.exclude, [TOTAL])
  assert.deepEqual(spec.fields[1].block.skip, { head: 0, tail: 1 })
})
