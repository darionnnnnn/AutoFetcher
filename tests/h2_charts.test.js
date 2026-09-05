import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const jd = new JSDOM('<!doctype html><body></body>')
globalThis.window = jd.window
globalThis.document = jd.window.document

const C = await import('../src/ui/report/charts.js')

const pts = arr => arr.map(([t, v]) => ({ t, v }))
const s1 = { taskId: 't1', points: pts([['2026-09-01', 1], ['2026-09-02', 3], ['2026-09-03', 2]]) }
const withGap = { taskId: 't1', points: pts([['2026-09-01', 1], ['2026-09-02', null], ['2026-09-03', 2]]) }

const paths = svg => [...svg.querySelectorAll('path')]
const dOf = svg => paths(svg).map(p => p.getAttribute('d')).join(' ')
const countM = svg => (dOf(svg).match(/M/g) || []).length

// ---- 共通 ----

test('模組內不寫死任何色碼，顏色一律用 CSS 變數', () => {
  const src = readFileSync(new URL('../src/ui/report/charts.js', import.meta.url), 'utf8')
  assert.equal((src.match(/#[0-9a-fA-F]{3,6}\b/g) || []).length, 0)
  assert.equal((src.match(/rgba?\(/g) || []).length, 0)
  assert.ok(src.includes('--chart-'), '要引用 --chart-n 變數')
})

test('四個圖表函式都回傳 svg 元素', () => {
  for (const svg of [
    C.lineChart([s1], {}), C.barChart([s1], {}),
    C.gauge({ value: 5, min: 0, max: 10 }), C.sparkline(s1.points, {})
  ]) {
    assert.equal(svg.tagName.toLowerCase(), 'svg')
    assert.ok(svg.getAttribute('viewBox'), '要有 viewBox 才能縮放')
  }
})

// ---- lineChart ----

test('單序列畫出一條路徑', () => {
  const svg = C.lineChart([s1], {})
  assert.equal(paths(svg).length >= 1, true)
  assert.equal(countM(svg), 1, '沒有缺值時只有一個 M 指令')
})

test('缺值處斷開路徑：兩段就有兩個 M', () => {
  const svg = C.lineChart([withGap], {})
  assert.equal(countM(svg), 2, `斷線處要重新 M，實得 d=${dOf(svg)}`)
})

test('連續三段缺值切成四段', () => {
  const s = { taskId: 't1', points: pts([
    ['a', 1], ['b', null], ['c', 2], ['d', null], ['e', 3], ['f', null], ['g', 4]
  ]) }
  assert.equal(countM(C.lineChart([s], {})), 4)
})

test('缺值不可被當成 0 畫進路徑', () => {
  const svg = C.lineChart([{ taskId: 't1', points: pts([['a', 100], ['b', null], ['c', 100]]) }], {})
  const d = dOf(svg)
  const ys = [...d.matchAll(/[ML]\s*[\d.]+[ ,]([\d.]+)/g)].map(m => Number(m[1]))
  assert.equal(new Set(ys.map(y => y.toFixed(2))).size, 1, `所有點應同高，實得 ${JSON.stringify(ys)}`)
})

test('多序列各自一條路徑，顏色用不同的 chart 變數', () => {
  const s2 = { taskId: 't2', points: pts([['2026-09-01', 5], ['2026-09-02', 6], ['2026-09-03', 7]]) }
  const svg = C.lineChart([s1, s2], {})
  const ps = paths(svg).filter(p => p.getAttribute('d'))
  assert.ok(ps.length >= 2)
  const strokes = ps.map(p => p.getAttribute('stroke'))
  assert.ok(strokes[0].includes('--chart-'), `顏色要用變數，實得 ${strokes[0]}`)
  assert.notEqual(strokes[0], strokes[1], '兩條序列顏色要不同')
})

test('超過八條序列時顏色循環使用', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    taskId: 't' + i, points: pts([['a', i + 1], ['b', i + 2]])
  }))
  const svg = C.lineChart(many, {})
  const strokes = paths(svg).filter(p => p.getAttribute('d')).map(p => p.getAttribute('stroke'))
  assert.equal(strokes[0], strokes[8], '第九條要回到第一個顏色')
})

test('單點資料不丟錯且畫得出來', () => {
  const svg = C.lineChart([{ taskId: 't1', points: pts([['a', 5]]) }], {})
  assert.equal(svg.tagName.toLowerCase(), 'svg')
})

test('全部是 null 時顯示沒有資料', () => {
  const svg = C.lineChart([{ taskId: 't1', points: pts([['a', null], ['b', null]]) }], {})
  assert.ok(svg.textContent.includes('沒有資料'))
  assert.equal(paths(svg).filter(p => p.getAttribute('d')).length, 0)
})

test('空序列清單顯示沒有資料', () => {
  assert.ok(C.lineChart([], {}).textContent.includes('沒有資料'))
})

test('指定 Y 軸範圍時生效：同資料不同範圍畫出不同座標', () => {
  const a = dOf(C.lineChart([s1], { yMin: 0, yMax: 10 }))
  const b = dOf(C.lineChart([s1], { yMin: 0, yMax: 100 }))
  assert.notEqual(a, b, '指定的 Y 範圍必須影響座標')
})

test('每個資料點都有 title 顯示時間與值', () => {
  const svg = C.lineChart([s1], {})
  const titles = [...svg.querySelectorAll('title')].map(t => t.textContent)
  assert.ok(titles.length >= 3, `每點都要有 title，實得 ${titles.length}`)
  assert.ok(titles.some(t => t.includes('2026-09-02') && t.includes('3')))
})

test('資料點帶 data-t 供點擊下鑽，缺值點不帶', () => {
  const svg = C.lineChart([withGap], {})
  const marks = [...svg.querySelectorAll('[data-t]')]
  assert.equal(marks.length, 2, '只有非缺值的點可點擊')
  assert.ok(marks.every(m => m.getAttribute('data-task-id') === 't1'))
})

test('數值全相同時不會除以零，仍畫得出來', () => {
  const svg = C.lineChart([{ taskId: 't1', points: pts([['a', 7], ['b', 7]]) }], {})
  assert.ok(!dOf(svg).includes('NaN'), `座標不可出現 NaN：${dOf(svg)}`)
})

// ---- barChart ----

test('長條圖每個非缺值點一根長條', () => {
  const svg = C.barChart([withGap], {})
  const rects = [...svg.querySelectorAll('rect[data-t]')]
  assert.equal(rects.length, 2, '缺值不畫長條')
})

test('長條圖高度隨值變化且不出現 NaN', () => {
  const svg = C.barChart([s1], {})
  const hs = [...svg.querySelectorAll('rect[data-t]')].map(r => Number(r.getAttribute('height')))
  assert.ok(hs.every(h => Number.isFinite(h) && h >= 0))
  assert.ok(new Set(hs).size > 1, '不同的值要有不同的高度')
})

test('長條圖全 null 顯示沒有資料', () => {
  assert.ok(C.barChart([{ taskId: 't1', points: pts([['a', null]]) }], {}).textContent.includes('沒有資料'))
})

// ---- gauge ----

test('儀表顯示目前值與範圍', () => {
  const svg = C.gauge({ value: 30, min: 0, max: 100 })
  assert.ok(svg.textContent.includes('30'))
})

test('超過警戒線時加上 over-warn 類別', () => {
  const over = C.gauge({ value: 90, min: 0, max: 100, warn: 80 })
  const under = C.gauge({ value: 50, min: 0, max: 100, warn: 80 })
  assert.ok(over.querySelector('.over-warn') || over.classList.contains('over-warn'))
  assert.ok(!(under.querySelector('.over-warn') || under.classList.contains('over-warn')))
})

test('有警戒線時畫出警戒標記', () => {
  const svg = C.gauge({ value: 50, min: 0, max: 100, warn: 80 })
  assert.ok(svg.querySelector('[data-warn]'), '要有警戒線元素')
})

test('值為 null 時顯示破折號而不是 0', () => {
  const svg = C.gauge({ value: null, min: 0, max: 100 })
  assert.ok(svg.textContent.includes('—'))
  assert.ok(!svg.textContent.includes('0%'))
})

test('值超出上下限時夾住不畫到外面', () => {
  const svg = C.gauge({ value: 500, min: 0, max: 100 })
  assert.ok(!svg.outerHTML.includes('NaN'))
})

// ---- sparkline ----

test('迷你走勢圖沒有座標軸與文字標籤', () => {
  const svg = C.sparkline(s1.points, {})
  assert.equal(svg.querySelectorAll('text').length, 0)
  assert.ok(svg.querySelector('path'))
})

test('迷你走勢圖同樣在缺值處斷開', () => {
  assert.equal(countM(C.sparkline(withGap.points, {})), 2)
})

test('迷你走勢圖空資料不丟錯', () => {
  const svg = C.sparkline([], {})
  assert.equal(svg.tagName.toLowerCase(), 'svg')
})

// ---- 安全 ----

test('圖表不使用 innerHTML', () => {
  const src = readFileSync(new URL('../src/ui/report/charts.js', import.meta.url), 'utf8')
  assert.equal((src.match(/innerHTML/g) || []).length, 0)
})

test('序列名稱中的 HTML 不會被解譯', () => {
  const svg = C.lineChart([{ taskId: '<script>x</script>', name: '<b>粗</b>', points: pts([['a', 1], ['b', 2]]) }], {})
  assert.equal(svg.querySelectorAll('script').length, 0)
  assert.equal(svg.querySelectorAll('b').length, 0)
})
