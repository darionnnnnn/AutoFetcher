// AF-15 批次 C：命名與描述鏈接格內標籤、重選保留 inner、規格不帶顯示欄位、診斷包的 innerProbe
// 對照 docs/AF-15-PLAN.md 批次 C 的驗收。本檔由 Claude 先寫，是實作的契約。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { describeTarget } from '../src/shared/describe.js'
import { extractValue } from '../src/shared/extract.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const MONITOR = readFileSync(new URL('./fixtures/nested-monitor.html', import.meta.url), 'utf8')
const SMALL_TABLE_2ND = [
  { tag: 'table', index: 1 }, { tag: 'tbody', index: 1 }, { tag: 'tr', index: 1 }, { tag: 'td', index: 2 }
]
const LABEL = '小表第 1 列第 2 格'
const LOCATOR = { css: 'body > table', path: 'body > table', anchor: null, xpath: '/html[1]/body[1]/table[1]' }
// 有欄標題的版本：六個入口裡有的取欄、有的取列，兩邊都要有字才分得出來
const INNER_CELL = { row: { index: 2, header: '10.231.1.31' }, col: { index: 2, header: 'PORT:443' }, inner: SMALL_TABLE_2ND }
const WHOLE_CELL = { row: { index: 2, header: '10.231.1.31' }, col: { index: 2, header: 'PORT:443' } }

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}
const sender = { tab: { id: 3, url: 'https://mon.test/p' }, frameId: 0 }

async function contentWith(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://mon.test/p' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  delete globalThis.__afContentLoaded
  await import('../src/content/main.js?t=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  return { c, listener, doc: jd.window.document }
}
const send = (listener, msg) => new Promise((resolve) => {
  const ret = listener(msg, {}, resolve)
  if (ret !== true) resolve(undefined)
})

// ---------- 七個命名／描述入口都接同一段格內標籤 ----------

test('C 七個命名與描述入口對同一個帶 inner 的值，都帶「小表第 1 列第 2 格」', async () => {
  const seen = {}

  // 1. describeTarget（摘要卡、任務頁、popup 的白話句）
  seen.describeTarget = describeTarget({ url: 'https://mon.test/p', mode: 'block', cell: INNER_CELL })

  // 2. singleCellName（單值任務名）
  {
    const { pk, doc } = await freshPicker()
    pk.render({ locator: LOCATOR, url: 'https://mon.test/p', picks: [{ cell: INNER_CELL }] })
    seen.singleCellName = doc.getElementById('name').value
  }

  // 3. defaultPickName（多值清單的預設值名）、4. fieldWhereText（位置說明）、
  // 5. fieldNameText（一鍵命名「列 · 欄」）、6. 一鍵命名「用欄標題」
  {
    const { pk, doc } = await freshPicker()
    pk.render({ locator: LOCATOR, url: 'https://mon.test/p', picks: [{ cell: INNER_CELL }, { cell: WHOLE_CELL }] })
    const names = () => Array.from(doc.querySelectorAll('#field-list input[data-field-name]')).map(i => i.value)
    seen.defaultPickName = names()[0]
    seen.fieldWhereText = doc.querySelector('#field-list [data-field-where]').textContent
    for (const input of doc.querySelectorAll('#field-list input[data-field-name]')) input.value = input._afAutoName
    pk.renameFields('cell')
    seen.fieldNameText = names()[0]
    pk.renameFields('col')
    seen.renameCol = names()[0]
  }

  // 7. defaultFieldName（重選新增的值名，background）
  {
    const { st, bg } = await freshBg()
    await st.saveTask({
      id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block', enabled: true, locator: LOCATOR,
      fields: [{ key: 'whole', name: '整格' }, { key: 'other', name: '別的' }],
      spec: { mode: 'block', fields: [{ key: 'whole', cell: WHOLE_CELL }, { key: 'other', cell: { row: { index: 3, header: '10.231.1.32' }, col: { index: 2, header: 'PORT:443' } } }] },
      schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
    })
    await bg.handleMessage({
      type: 'PICKED', purpose: 'repick', taskId: 't1', locator: LOCATOR,
      picks: [{ cell: WHOLE_CELL }, { cell: INNER_CELL }]
    }, sender)
    seen.defaultFieldName = (await st.getTask('t1')).fields[1].name
  }

  const entries = Object.entries(seen)
  assert.equal(entries.length, 7, '入口數要是 7（對空集合跑迴圈一定通過）')
  for (const [where, text] of entries) {
    assert.ok(String(text).includes(LABEL), `${where} 沒有帶格內標籤，實得 ${JSON.stringify(text)}`)
  }
  // 組法：既有名稱與標籤以「 · 」接起來
  assert.equal(seen.defaultPickName, `10.231.1.31 · PORT:443 · ${LABEL}`)
  assert.equal(seen.fieldWhereText, `10.231.1.31 · PORT:443 · ${LABEL}`)
  assert.equal(seen.singleCellName, `PORT:443 · ${LABEL}`)
  assert.equal(seen.renameCol, `PORT:443 · ${LABEL}`)
  assert.equal(seen.defaultFieldName, `10.231.1.31 · PORT:443 · ${LABEL}`)
  assert.equal(seen.describeTarget, `抓 mon.test 的表格，取「10.231.1.31 · PORT:443 · ${LABEL}」這一格`)
})

test('C 沒有既有名稱可用時（標題都空的），名稱就是格內標籤，不退回「值 N」', async () => {
  const bare = { row: { index: 2, header: '' }, col: { index: 2, header: '' }, inner: SMALL_TABLE_2ND }
  const { pk, doc } = await freshPicker()
  pk.render({ locator: LOCATOR, url: 'https://mon.test/p', picks: [{ cell: bare }, { block: { axis: 'col', index: 2, headerText: '', inner: SMALL_TABLE_2ND } }] })
  const names = Array.from(doc.querySelectorAll('#field-list input[data-field-name]')).map(i => i.value)
  assert.equal(names[0], LABEL, `實得 ${JSON.stringify(names)}`)
  assert.equal(names[1], LABEL === names[0] ? `${LABEL} 2` : LABEL, '同名自動加序號（既有規則）')
})

test('C 整欄聚合的白話句也帶格內標籤', () => {
  const text = describeTarget({
    url: 'https://mon.test/p', mode: 'block',
    block: { axis: 'col', index: 2, headerText: 'PORT:443', aggregate: 'max', inner: SMALL_TABLE_2ND }
  })
  assert.ok(text.includes(`「PORT:443 · ${LABEL}」整欄`), text)
})

test('C 守門：沒有 inner 的值，七個入口的輸出與改動前相同（抽樣 describeTarget 與清單名稱）', async () => {
  assert.equal(describeTarget({ url: 'https://mon.test/p', mode: 'block', cell: WHOLE_CELL }),
    '抓 mon.test 的表格，取「10.231.1.31 · PORT:443」這一格')
  const { pk, doc } = await freshPicker()
  pk.render({ locator: LOCATOR, url: 'https://mon.test/p', picks: [{ cell: WHOLE_CELL }, { block: { axis: 'col', index: 2, headerText: 'PORT:443' } }] })
  const names = Array.from(doc.querySelectorAll('#field-list input[data-field-name]')).map(i => i.value)
  assert.deepEqual(names, ['10.231.1.31 · PORT:443', 'PORT:443'])
})

// ---------- 規格：只存路徑，不存顯示欄位 ----------

test('C Picker 存檔：規格帶 inner、不帶任何顯示用的標籤；擷取端拿這份規格抓得到值（鏈結）', async () => {
  const { st, pk, doc } = await freshPicker()
  // 存檔後要拿去真的擷取，欄標題用監控頁的實況（外層表沒有欄標題）；命名入口用的 PORT:443 是為了分出列與欄而編的
  const real = { row: { index: 2, header: '10.231.1.31' }, col: { index: 2, header: '' }, inner: SMALL_TABLE_2ND }
  pk.render({ locator: LOCATOR, url: 'https://mon.test/p', picks: [{ cell: real }] })
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const task = (await st.getTasks())[0]
  assert.ok(task, '要存出任務')
  assert.deepEqual(task.spec.block.cell.inner, SMALL_TABLE_2ND)
  assert.ok(!/innerLabel|小表第/.test(JSON.stringify(task.spec)), `規格不得帶顯示字串（sameSpec 是全等比對）：${JSON.stringify(task.spec)}`)
  const table = new JSDOM(`<!doctype html><body>${MONITOR}</body>`).window.document.querySelector('table')
  const res = extractValue(table, task.spec)
  assert.equal(res.value, 462, `Picker 存下的規格要讓擷取端抓到小表第 2 格，實得 ${JSON.stringify(res)}`)
})

test('C 多值存檔：每個值各自帶 inner', async () => {
  const { st, pk, doc } = await freshPicker()
  // 多值要有任務名稱才存得出來（nameHint 是它的預設值）
  pk.render({ locator: LOCATOR, url: 'https://mon.test/p', nameHint: '監控', picks: [{ cell: INNER_CELL }, { cell: WHOLE_CELL }] })
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const task = (await st.getTasks())[0]
  assert.deepEqual(task.spec.fields[0].cell.inner, SMALL_TABLE_2ND)
  assert.equal('inner' in task.spec.fields[1].cell, false)
})

test('C 單值整欄存檔也帶 block.inner（單值整欄走另一條只挑三個欄位的組裝路徑）', async () => {
  const { st, pk, doc } = await freshPicker()
  pk.render({
    locator: LOCATOR, url: 'https://mon.test/p', nameHint: '監控',
    picks: [{ block: { axis: 'col', index: 2, headerText: '', inner: SMALL_TABLE_2ND } }]
  })
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const task = (await st.getTasks())[0]
  assert.ok(task, '要存出任務')
  assert.deepEqual(task.spec.block.inner, SMALL_TABLE_2ND, `實得 ${JSON.stringify(task.spec)}`)
  const table = new JSDOM(`<!doctype html><body>${MONITOR}</body>`).window.document.querySelector('table')
  const res = extractValue(table, { ...task.spec, block: { ...task.spec.block, aggregate: 'min' } })
  assert.equal(res.value, 460, `整欄子路徑取 min，實得 ${JSON.stringify(res)}`)
})

// ---------- 重選（background）----------

test('C 單值任務重選：pickSpecOf 逐欄挑也要挑到 inner；其他多帶的鍵照樣擋掉', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask({
    id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block', enabled: true, locator: LOCATOR,
    spec: { mode: 'block', block: { cell: WHOLE_CELL } },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  })
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: LOCATOR,
    picks: [{ cell: { ...INNER_CELL, innerLabel: LABEL, junk: 1 } }]
  }, sender)
  const back = await st.getTask('t1')
  assert.deepEqual(back.spec.block.cell.inner, SMALL_TABLE_2ND, '重選把 inner 丟掉的話，任務會默默改回抓整格串接')
  assert.equal('innerLabel' in back.spec.block.cell, false)
  assert.equal('junk' in back.spec.block.cell, false)
})

test('C 重選時 inner 不合法（不是非空陣列）不抄進規格', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask({
    id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block', enabled: true, locator: LOCATOR,
    spec: { mode: 'block', block: { cell: WHOLE_CELL } },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  })
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: LOCATOR,
    picks: [{ cell: { ...WHOLE_CELL, inner: [] } }]
  }, sender)
  assert.equal('inner' in (await st.getTask('t1')).spec.block.cell, false)
})

test('C 多值重選：同列同欄、inner 不同是兩個值（sameSpec 要比 inner），整格那個 key 不變', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask({
    id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block', enabled: true, locator: LOCATOR,
    fields: [{ key: 'whole', name: '整格' }, { key: 'small', name: '小表' }],
    spec: { mode: 'block', fields: [{ key: 'whole', cell: WHOLE_CELL }, { key: 'small', cell: INNER_CELL }] },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  })
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: LOCATOR,
    picks: [{ cell: INNER_CELL }, { cell: WHOLE_CELL }]
  }, sender)
  const back = await st.getTask('t1')
  assert.deepEqual(back.fields.map(f => f.key), ['small', 'whole'], `順序跟著重選，key 各自沿用，實得 ${JSON.stringify(back.fields)}`)
  assert.deepEqual(back.fields.map(f => f.name), ['小表', '整格'], '使用者改過的名稱沿用')
  assert.deepEqual(back.spec.fields[0].cell.inner, SMALL_TABLE_2ND)
  assert.equal('inner' in back.spec.fields[1].cell, false)
})

test('C 整欄的重選也保留 block.inner', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask({
    id: 't1', name: '監控', url: 'https://mon.test/p', mode: 'block', enabled: true, locator: LOCATOR,
    spec: { mode: 'block', block: { axis: 'col', index: 2, headerText: '', aggregate: 'max' } },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  })
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: LOCATOR,
    picks: [{ block: { axis: 'col', index: 2, headerText: '', inner: SMALL_TABLE_2ND } }]
  }, sender)
  const back = await st.getTask('t1')
  assert.deepEqual(back.spec.block.inner, SMALL_TABLE_2ND)
  assert.equal(back.spec.block.aggregate, 'max', '聚合方式沿用（既有規則）')
})

// ---------- 診斷包 ----------

test('C 擷取失敗且規格帶 inner：診斷包 page.table.innerProbe 有每一列的解析結果', async () => {
  const { listener } = await contentWith(MONITOR)
  const spec = { mode: 'block', block: { cell: { row: { index: 1, header: '' }, col: { index: 2, header: '' }, inner: SMALL_TABLE_2ND } } }
  const res = await send(listener, { type: 'EXTRACT', locator: LOCATOR, spec })
  assert.equal(res.ok, false, '前置：欄名列那一格沒有小表，要失敗')
  const probe = res.debug?.page?.table?.innerProbe
  assert.ok(Array.isArray(probe) && probe.length === 1, `要有一份探測結果，實得 ${JSON.stringify(probe)}`)
  assert.deepEqual(probe[0].inner, SMALL_TABLE_2ND)
  assert.equal(probe[0].rows.length, 9, '監控頁 9 個資料列逐列探測')
  assert.equal(probe[0].rows.filter(r => r.resolved).length, 6, '5 台主機＋合計列解析得到')
  assert.equal(probe[0].rows[2].text, 'MAX:462')
  assert.equal(probe[0].rows[1].resolved, false)
})

test('C 多值任務：每個帶 inner 的值各一份探測，key 對得上', async () => {
  const { listener } = await contentWith(MONITOR)
  const spec = {
    mode: 'block',
    fields: [
      { key: 'bad', cell: { row: { index: 1, header: '' }, col: { index: 2, header: '' }, inner: SMALL_TABLE_2ND } },
      { key: 'plain', cell: { row: { index: 2, header: '' }, col: { index: 1, header: '' } } }
    ]
  }
  const res = await send(listener, { type: 'EXTRACT', locator: LOCATOR, spec })
  const probe = res.debug?.page?.table?.innerProbe
  assert.ok(Array.isArray(probe), `多值任務有值失敗時也要帶，實得 ${JSON.stringify(res.debug)}`)
  assert.deepEqual(probe.map(p => p.key), ['bad'], '沒有 inner 的值不探測')
})

test('C 守門：規格沒有 inner 時診斷包不帶 innerProbe 這個鍵', async () => {
  const { listener } = await contentWith(MONITOR)
  const spec = { mode: 'block', block: { cell: { row: { index: 0, header: '不存在的主機' }, col: { index: 2, header: '' } } } }
  const res = await send(listener, { type: 'EXTRACT', locator: LOCATOR, spec })
  assert.equal(res.ok, false)
  assert.ok(res.debug?.page?.table, '前置：失敗要附表格摘要')
  assert.equal('innerProbe' in res.debug.page.table, false)
})
