// AF-16 作業 A 第 1 段：整欄／整列聚合的排除（skip 略過頭尾、exclude 點選排除）
// 規格見 docs/SPEC.md §7。四種表格結構（HTML 表、td 排的表頭、ARIA、CSS 假表格）與帶 inner 的複合格都要走同一份。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { extractValue } from '../src/shared/extract.js'
import { aggregateCells } from '../src/shared/aggregate.js'
import { putSkip, putExclude } from '../src/shared/table.js'

const el = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body.firstElementChild

// 監控頁的形狀：列標題是主機位址、最後一列是 tfoot 裡的合計
const MONITOR = `<table>
  <thead><tr><th>主機</th><th>點金靈</th><th>TSWEB</th></tr></thead>
  <tbody>
    <tr><td>10.0.0.1</td><td>53</td><td>MAX:423</td></tr>
    <tr><td>10.0.0.2</td><td>49</td><td>MAX:425</td></tr>
    <tr><td>10.0.0.3</td><td>48</td><td>MAX:427</td></tr>
  </tbody>
  <tfoot><tr><td>合計</td><td>150</td><td>1275</td></tr></tfoot>
</table>`

const col = (over = {}) => ({ mode: 'block', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', ...over } })

// ---- 舊規格一個位元都不變 ----

test('沒有 skip／exclude 的舊規格：合計照舊被加進去，結果不帶 excluded 鍵', () => {
  const r = extractValue(el(MONITOR), col())
  assert.equal(r.ok, true)
  assert.equal(r.value, 300)
  assert.equal(r.used, 4)
  assert.equal('excluded' in r, false, '0 筆排除不放鍵，舊紀錄的形狀不能變')
})

test('skip／exclude 為空值（0、空陣列、null）都算沒有', () => {
  for (const over of [{ skip: { head: 0, tail: 0 } }, { exclude: [] }, { skip: null, exclude: null }]) {
    const r = extractValue(el(MONITOR), col(over))
    assert.equal(r.value, 300, JSON.stringify(over))
    assert.equal('excluded' in r, false, JSON.stringify(over))
  }
})

// ---- skip：略過開頭／結尾 N 筆 ----

test('整欄 skip.tail=1：合計那一列不進加總', () => {
  const r = extractValue(el(MONITOR), col({ skip: { head: 0, tail: 1 } }))
  assert.equal(r.ok, true)
  assert.equal(r.value, 150)
  assert.equal(r.used, 3)
  assert.equal(r.excluded, 1)
  assert.equal(r.status, 'ok')
})

test('整欄 skip.head=1：用 td 排的表頭列（標題是 2025）不進加總', () => {
  const html = `<table><tr><td>年度</td><td>2025</td></tr><tr><td>a</td><td>10</td></tr><tr><td>b</td><td>20</td></tr></table>`
  const base = extractValue(el(html), { mode: 'block', block: { axis: 'col', index: 1, headerText: '', aggregate: 'sum' } })
  assert.equal(base.value, 2055, '前提：td 表頭列會被當成資料列')
  const r = extractValue(el(html), { mode: 'block', block: { axis: 'col', index: 1, headerText: '', aggregate: 'sum', skip: { head: 1, tail: 0 } } })
  assert.equal(r.value, 30)
  assert.equal(r.excluded, 1)
})

test('skip 計數不看解析得到與否：略過的是「列」，不是「數字」', () => {
  // 第一列是純文字，若略過的是「前 1 個數字」就會把 53 略掉
  const html = `<table><thead><tr><th>主機</th><th>值</th></tr></thead><tbody>
    <tr><td>x</td><td>—</td></tr><tr><td>y</td><td>53</td></tr><tr><td>z</td><td>49</td></tr></tbody></table>`
  const r = extractValue(el(html), { mode: 'block', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum', skip: { head: 1, tail: 0 } } })
  assert.equal(r.value, 102)
  assert.equal(r.skipped, 0, '「—」那一列被略過了，不能再計成解析不到')
  assert.equal(r.excluded, 1)
})

test('略過的筆數等於或超過全部 → not_found，訊息說出略過幾筆與這一欄有幾列', () => {
  for (const skip of [{ head: 2, tail: 2 }, { head: 4, tail: 0 }, { head: 3, tail: 5 }]) {
    const r = extractValue(el(MONITOR), col({ skip }))
    assert.equal(r.ok, false, JSON.stringify(skip))
    assert.equal(r.error, 'not_found')
    assert.match(r.message, /略過/)
    assert.match(r.message, /4/, '這一欄有 4 列')
  }
})

test('略過之後剩一列：照常聚合（邊界不得算成「沒有剩下」）', () => {
  const r = extractValue(el(MONITOR), col({ skip: { head: 2, tail: 1 } }))
  assert.equal(r.ok, true)
  assert.equal(r.value, 48)
  assert.equal(r.excluded, 3)
})

// ---- exclude：點選排除特定列 ----

const TOTAL = { index: 3, header: '合計' }

test('整欄 exclude 以列標題定位合計列', () => {
  const r = extractValue(el(MONITOR), col({ exclude: [TOTAL] }))
  assert.equal(r.value, 150)
  assert.equal(r.excluded, 1)
  assert.equal(r.status, 'ok')
})

test('表格前面插一列：排除項跟著列標題走，不是照索引排掉別人', () => {
  const inserted = MONITOR.replace('<tbody>', '<tbody><tr><td>10.0.0.9</td><td>7</td><td>MAX:1</td></tr>')
  const r = extractValue(el(inserted), col({ exclude: [TOTAL] }))
  assert.equal(r.value, 157, '索引 3 現在是 10.0.0.3（48），照索引排會得到 259')
  assert.equal(r.excluded, 1)
  assert.equal(r.status, 'ok', '排除項搬家不影響值的狀態')
})

test('排除項的標題在頁面上找不到：不排除任何列，但狀態降為 fallback 並說出找不到哪一個', () => {
  const noTotal = MONITOR.replace(/<tfoot>.*<\/tfoot>/s, '')
  const r = extractValue(el(noTotal), col({ exclude: [TOTAL] }))
  assert.equal(r.ok, true)
  assert.equal(r.value, 150)
  assert.equal(r.status, 'fallback', '靜默的話，合計列改名之後就會默默加兩次')
  assert.match(r.message, /找不到/)
  assert.match(r.message, /合計/)
  assert.equal('excluded' in r, false)
})

test('排除項標題是空字串、索引又越界：算找不到（fallback），不得當成找到而靜默不排除', () => {
  const r = extractValue(el(MONITOR), col({ exclude: [{ index: 99, header: '' }] }))
  assert.equal(r.ok, true)
  assert.equal(r.value, 300)
  assert.equal(r.status, 'fallback', '空標題的定位直接回原索引、不檢查範圍；越界要算找不到')
  assert.match(r.message, /第 100 列/)
})

test('整列帶 inner：排除項指到被 colspan 涵蓋的欄，定位成功卻濾不到任何格子——同樣算找不到', () => {
  const html = `<table><thead><tr><th>主機</th><th>甲</th><th>乙</th></tr></thead><tbody>
    <tr><td><span>h</span><span>1</span></td><td colspan="2"><span>x</span><span>2</span></td></tr></tbody></table>`
  const r = extractValue(el(html), { mode: 'block', block: { axis: 'row', index: 0, headerText: '', aggregate: 'sum', inner: [{ tag: 'span', index: 2 }], exclude: [{ index: 2, header: '乙' }] } })
  assert.equal(r.ok, true)
  assert.equal(r.value, 3, '前提：清單只有每格的網格起點（0 與 1），第 2 欄被 colspan 涵蓋')
  assert.equal(r.status, 'fallback')
  assert.match(r.message, /乙/)
})

test('skip 與 exclude 指到同一列只算一次', () => {
  const r = extractValue(el(MONITOR), col({ skip: { head: 0, tail: 1 }, exclude: [TOTAL] }))
  assert.equal(r.value, 150)
  assert.equal(r.excluded, 1)
  assert.equal(r.status, 'ok', '被 skip 拿掉的列仍然「找得到」，不能報找不到')
})

test('先套 skip 再套 exclude：skip 對著完整的表算頭尾', () => {
  // skip 先套：略過第一列（10.0.0.1）後，排除 10.0.0.1 已經不在清單裡 → 49 + 48 + 150
  // exclude 先套：先排掉 10.0.0.1，「開頭 1 列」變成 10.0.0.2 → 48 + 150
  const r = extractValue(el(MONITOR), col({ skip: { head: 1, tail: 0 }, exclude: [{ index: 0, header: '10.0.0.1' }] }))
  assert.equal(r.value, 247)
  assert.equal(r.excluded, 1)
})

test('全部被排除 → not_found，訊息與「本來就沒有格子」分得出來', () => {
  const html = `<table><thead><tr><th>主機</th><th>值</th></tr></thead><tbody>
    <tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>`
  const r = extractValue(el(html), { mode: 'block', block: { axis: 'col', index: 1, headerText: '值', aggregate: 'sum', exclude: [{ index: 0, header: 'a' }, { index: 1, header: 'b' }] } })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
  assert.match(r.message, /排除/)
})

// ---- 整列：以「格」為單位 ----

test('整列 skip.head=1 略過列標題那一格（主機位址 10.0.0.1 會被解析成 10）', () => {
  const row = { mode: 'block', block: { axis: 'row', index: 0, headerText: '10.0.0.1', aggregate: 'sum' } }
  assert.equal(extractValue(el(MONITOR), row).value, 486, '前提：10 + 53 + 423')
  const r = extractValue(el(MONITOR), { ...row, block: { ...row.block, skip: { head: 1, tail: 0 } } })
  assert.equal(r.value, 476)
  assert.equal(r.excluded, 1)
})

test('整列 exclude 以欄標題定位', () => {
  const r = extractValue(el(MONITOR), { mode: 'block', block: { axis: 'row', index: 0, headerText: '10.0.0.1', aggregate: 'sum', skip: { head: 1, tail: 0 }, exclude: [{ index: 2, header: 'TSWEB' }] } })
  assert.equal(r.value, 53)
  assert.equal(r.excluded, 2)
})

// ---- 與位置定位的關係 ----

test('有 pos 就是取那一格：skip／exclude 一律不看', () => {
  const r = extractValue(el(MONITOR), col({ pos: 'last', skip: { head: 0, tail: 1 }, exclude: [TOTAL] }))
  assert.equal(r.ok, true)
  assert.equal(r.value, 150, 'pos last 仍是 tfoot 那一格')
  assert.equal(r.used, 1)
  assert.equal('excluded' in r, false)
})

// ---- 各種結構 ----

test('複合格帶 inner：排除以列為單位', () => {
  const html = `<table><thead><tr><th>主機</th><th>狀態</th></tr></thead><tbody>
    <tr><td>10.0.0.1</td><td><span>53</span><span>MAX:423</span></td></tr>
    <tr><td>10.0.0.2</td><td><span>49</span><span>MAX:425</span></td></tr>
  </tbody><tfoot><tr><td>合計</td><td><span>102</span><span>848</span></td></tr></tfoot></table>`
  const spec = (over) => ({ mode: 'block', block: { axis: 'col', index: 1, headerText: '狀態', aggregate: 'sum', inner: [{ tag: 'span', index: 2 }], ...over } })
  assert.equal(extractValue(el(html), spec({})).value, 1696, '前提：423 + 425 + 848')
  assert.equal(extractValue(el(html), spec({ skip: { head: 0, tail: 1 } })).value, 848)
  const r = extractValue(el(html), spec({ exclude: [{ index: 2, header: '合計' }] }))
  assert.equal(r.value, 848)
  assert.equal(r.excluded, 1)
})

test('ARIA 表格：exclude 以列標題定位', () => {
  const html = `<div role="grid"><div role="row"><span role="columnheader">名稱</span><span role="columnheader">量</span></div>
    <div role="row"><span role="cell">甲</span><span role="cell">10</span></div>
    <div role="row"><span role="cell">乙</span><span role="cell">32</span></div>
    <div role="row"><span role="cell">合計</span><span role="cell">42</span></div></div>`
  const r = extractValue(el(html), { mode: 'block', block: { axis: 'col', index: 1, headerText: '量', aggregate: 'sum', exclude: [{ index: 2, header: '合計' }] } })
  assert.equal(r.value, 42)
  assert.equal(r.excluded, 1)
})

test('CSS 假表格：skip 與 exclude 都適用', () => {
  const html = `<div><div><span>09-01</span><span>10</span></div><div><span>09-02</span><span>32</span></div><div><span>合計</span><span>42</span></div></div>`
  const base = { mode: 'block', block: { axis: 'col', index: 1, headerText: '', aggregate: 'sum' } }
  assert.equal(extractValue(el(html), base).value, 84, '前提：合計被加進去')
  assert.equal(extractValue(el(html), { ...base, block: { ...base.block, skip: { head: 0, tail: 1 } } }).value, 42)
  assert.equal(extractValue(el(html), { ...base, block: { ...base.block, exclude: [{ index: 2, header: '合計' }] } }).value, 42)
})

// ---- 多值任務 ----

test('多值任務的 block 值也帶 excluded；0 筆時不放鍵', () => {
  const r = extractValue(el(MONITOR), {
    mode: 'block',
    fields: [
      { key: 'a', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', skip: { head: 0, tail: 1 } } },
      { key: 'b', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum' } }
    ]
  })
  assert.equal(r.fields.a.value, 150)
  assert.equal(r.fields.a.excluded, 1)
  assert.equal(r.fields.b.value, 300)
  assert.equal('excluded' in r.fields.b, false)
})

test('多值任務的排除項找不到：該值 fallback 並帶 message', () => {
  const noTotal = MONITOR.replace(/<tfoot>.*<\/tfoot>/s, '')
  const r = extractValue(el(noTotal), { mode: 'block', fields: [{ key: 'a', block: { axis: 'col', index: 1, headerText: '點金靈', aggregate: 'sum', exclude: [TOTAL] } }] })
  assert.equal(r.fields.a.status, 'fallback')
  assert.match(r.fields.a.message, /合計/)
})

// ---- 數字＋文字：既有行為釘住 ----

test('聚合只取數字：「MAX:427」取 427、純文字計入 skipped，五種聚合方式一致', () => {
  const vals = ['53', '合計', 'MAX:427']
  assert.equal(aggregateCells(vals, 'max').value, 427)
  assert.equal(aggregateCells(vals, 'min').value, 53)
  assert.equal(aggregateCells(vals, 'avg').value, 240, '平均只除以解析得到的 2 格')
  assert.equal(aggregateCells(vals, 'sum').value, 480)
  assert.equal(aggregateCells(vals, 'count').value, 2)
  assert.equal(aggregateCells(vals, 'max').skipped, 1)
})

// ---- 非空才放鍵：各只有一份 ----

test('putSkip：兩個都 0、負數、非整數、非物件都不放鍵；有一邊大於 0 就補齊另一邊為 0', () => {
  for (const bad of [{ head: 0, tail: 0 }, { head: -1, tail: 0 }, { head: 1.5 }, null, undefined, 'x', {}]) {
    const b = {}
    putSkip(b, bad)
    assert.equal('skip' in b, false, JSON.stringify(bad))
  }
  const b = {}
  putSkip(b, { head: 1 })
  assert.deepEqual(b.skip, { head: 1, tail: 0 })
  const c = {}
  putSkip(c, { head: '2', tail: 3 })
  assert.deepEqual(c.skip, { head: 0, tail: 3 }, '字串不是整數，當 0')
})

test('putExclude：空陣列與非陣列不放鍵；只留 index 是非負整數的項目，並只抄 index 與 header', () => {
  for (const bad of [[], null, undefined, 'x', [{ header: 'a' }], [{ index: -1, header: 'a' }]]) {
    const b = {}
    putExclude(b, bad)
    assert.equal('exclude' in b, false, JSON.stringify(bad))
  }
  const b = {}
  putExclude(b, [{ index: 3, header: '合計', extra: 1 }, { index: 1 }])
  assert.deepEqual(b.exclude, [{ index: 3, header: '合計' }, { index: 1, header: '' }],
    '多帶的欄位進規格會讓 sameSpec 永遠對不上')
})
