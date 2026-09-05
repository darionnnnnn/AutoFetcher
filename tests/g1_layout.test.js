import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as L from '../src/ui/report/layout.js'

const card = (id, x, y, w = 3, h = 2, type = 'number') => ({ id, x, y, w, h, type })
const boxes = list => list.map(c => [c.id, c.x, c.y, c.w, c.h])
const byId = (list, id) => list.find(c => c.id === id)

function anyOverlap(list) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return [a.id, b.id]
    }
  }
  return null
}

// ---- 常數與純度 ----

test('模組是純函式：不碰 DOM 也不碰 chrome', () => {
  const src = readFileSync(new URL('../src/ui/report/layout.js', import.meta.url), 'utf8')
  assert.equal((src.match(/\bdocument\b/g) || []).length, 0)
  assert.equal((src.match(/\bchrome\./g) || []).length, 0)
})

test('欄數 12、卡片最大高度 6', () => {
  assert.equal(L.COLS, 12)
  assert.equal(L.MAX_H, 6)
})

// ---- clampCard ----

test('clampCard 夾住過寬與過高', () => {
  assert.deepEqual(
    (({ x, y, w, h }) => ({ x, y, w, h }))(L.clampCard({ x: 0, y: 0, w: 99, h: 99 })),
    { x: 0, y: 0, w: 12, h: 6 }
  )
})

test('clampCard 夾住過小的寬高', () => {
  const c = L.clampCard({ x: 0, y: 0, w: 0, h: 0 })
  assert.equal(c.w, 1)
  assert.equal(c.h, 1)
})

test('clampCard 負座標歸零', () => {
  const c = L.clampCard({ x: -5, y: -3, w: 3, h: 2 })
  assert.equal(c.x, 0)
  assert.equal(c.y, 0)
})

test('clampCard 讓卡片不超出右邊界：優先往左移，仍放不下才縮寬', () => {
  const a = L.clampCard({ x: 10, y: 0, w: 6, h: 2 })
  assert.equal(a.x + a.w <= 12, true)
  assert.equal(a.w, 6, '寬度放得下就只移動不縮')
  assert.equal(a.x, 6)
})

test('clampCard 不改動輸入物件', () => {
  const input = { x: 99, y: 0, w: 99, h: 99 }
  L.clampCard(input)
  assert.deepEqual(input, { x: 99, y: 0, w: 99, h: 99 })
})

test('clampCard 保留 id、type 等其他欄位', () => {
  const c = L.clampCard({ id: 'a', type: 'line', x: 0, y: 0, w: 3, h: 2, options: { period: 7 } })
  assert.equal(c.id, 'a')
  assert.equal(c.type, 'line')
  assert.deepEqual(c.options, { period: 7 })
})

// ---- collides ----

test('collides 對重疊回 true、相鄰回 false', () => {
  assert.equal(L.collides(card('a', 0, 0, 3, 2), card('b', 2, 1, 3, 2)), true)
  assert.equal(L.collides(card('a', 0, 0, 3, 2), card('b', 3, 0, 3, 2)), false, '左右相鄰不算碰撞')
  assert.equal(L.collides(card('a', 0, 0, 3, 2), card('b', 0, 2, 3, 2)), false, '上下相鄰不算碰撞')
})

test('collides 完全包覆與同一位置都算碰撞', () => {
  assert.equal(L.collides(card('a', 0, 0, 12, 6), card('b', 3, 2, 2, 1)), true)
  assert.equal(L.collides(card('a', 1, 1, 2, 2), card('b', 1, 1, 2, 2)), true)
})

test('collides 對同一張卡片（id 相同）回 false', () => {
  assert.equal(L.collides(card('a', 0, 0, 3, 2), card('a', 0, 0, 3, 2)), false)
})

// ---- compact ----

test('compact 把懸空的卡片往上推到頂', () => {
  const out = L.compact([card('a', 0, 5, 3, 2)])
  assert.equal(byId(out, 'a').y, 0)
})

test('compact 保持相對上下關係，不會互相穿越', () => {
  const out = L.compact([card('a', 0, 0, 3, 2), card('b', 0, 4, 3, 2)])
  assert.equal(byId(out, 'a').y, 0)
   assert.equal(byId(out, 'b').y, 2)
})

test('compact 只往上推，不改變 x 與寬高', () => {
  const out = L.compact([card('a', 5, 3, 4, 2)])
  const a = byId(out, 'a')
  assert.equal(a.x, 5)
  assert.equal(a.w, 4)
  assert.equal(a.h, 2)
})

test('compact 是冪等的（跑兩次結果相同）', () => {
  const input = [card('a', 0, 3, 6, 2), card('b', 6, 1, 6, 2), card('c', 0, 9, 12, 1)]
  const once = L.compact(input)
  const twice = L.compact(once)
  assert.deepEqual(boxes(twice), boxes(once))
})

test('compact 後沒有任何重疊', () => {
  const input = [card('a', 0, 4, 6, 2), card('b', 3, 6, 6, 2), card('c', 0, 8, 4, 3)]
  const out = L.compact(input)
  assert.equal(anyOverlap(out), null)
})

test('compact 不改動輸入陣列與其中的物件', () => {
  const input = [card('a', 0, 5, 3, 2)]
  const snapshot = JSON.stringify(input)
  L.compact(input)
  assert.equal(JSON.stringify(input), snapshot)
})

test('compact 空清單回空陣列', () => {
  assert.deepEqual(L.compact([]), [])
})

// ---- placeCard ----

test('placeCard 放到空版面就留在原位', () => {
  const out = L.placeCard([], card('a', 3, 2, 3, 2))
  assert.equal(byId(out, 'a').x, 3)
})

test('placeCard 把被壓到的卡片往下擠', () => {
  const existing = [card('b', 0, 0, 6, 2)]
  const out = L.placeCard(existing, card('a', 0, 0, 6, 2))
  assert.equal(byId(out, 'a').y, 0, '新卡片留在放置位置')
  assert.ok(byId(out, 'b').y >= 2, '被壓到的往下移')
  assert.equal(anyOverlap(out), null)
})

test('placeCard 連鎖擠壓三層都不重疊', () => {
  const existing = [card('b', 0, 0, 12, 2), card('c', 0, 2, 12, 2), card('d', 0, 4, 12, 2)]
  const out = L.placeCard(existing, card('a', 0, 0, 12, 2))
  assert.equal(anyOverlap(out), null)
  assert.equal(out.length, 4)
  assert.ok(byId(out, 'd').y >= 6, `連鎖沒推到底：${JSON.stringify(boxes(out))}`)
})

test('placeCard 不影響沒被壓到的卡片', () => {
  const existing = [card('b', 0, 0, 3, 2), card('c', 9, 0, 3, 2)]
  const out = L.placeCard(existing, card('a', 0, 0, 3, 2))
  assert.deepEqual([byId(out, 'c').x, byId(out, 'c').y], [9, 0])
})

test('placeCard 會先夾住越界的新卡片', () => {
  const out = L.placeCard([], { id: 'a', type: 'number', x: 11, y: -2, w: 6, h: 9 })
  const a = byId(out, 'a')
  assert.ok(a.x + a.w <= 12)
  assert.ok(a.y >= 0)
  assert.ok(a.h <= 6)
})

test('placeCard 同 id 視為移動而非新增', () => {
  const existing = [card('a', 0, 0, 3, 2), card('b', 3, 0, 3, 2)]
  const out = L.placeCard(existing, card('a', 6, 0, 3, 2))
  assert.equal(out.length, 2)
  assert.deepEqual([byId(out, 'a').x, byId(out, 'a').y], [6, 0])
  assert.deepEqual([byId(out, 'b').x, byId(out, 'b').y], [3, 0], '不相干的卡片不動')
})

// ---- findFreeSlot ----

test('findFreeSlot 空版面回左上角', () => {
  assert.deepEqual(L.findFreeSlot([], 3, 2), { x: 0, y: 0 })
})

test('findFreeSlot 找同一列右邊的空位', () => {
  const s = L.findFreeSlot([card('a', 0, 0, 6, 2)], 6, 2)
  assert.deepEqual(s, { x: 6, y: 0 })
})

test('findFreeSlot 同列放不下就換下一列', () => {
  const s = L.findFreeSlot([card('a', 0, 0, 12, 2)], 6, 2)
  assert.deepEqual(s, { x: 0, y: 2 })
})

test('findFreeSlot 回傳的位置放進去不會重疊', () => {
  const existing = [card('a', 0, 0, 4, 2), card('b', 4, 0, 4, 3), card('c', 0, 2, 3, 1)]
  const s = L.findFreeSlot(existing, 5, 2)
  const out = [...existing, { id: 'n', type: 'number', ...s, w: 5, h: 2 }]
  assert.equal(anyOverlap(out), null, `重疊：${JSON.stringify(boxes(out))}`)
})

// ---- autoArrange ----

test('autoArrange 依型別給寬度', () => {
  const out = L.autoArrange([
    { id: 'a', type: 'number', x: 9, y: 9, w: 1, h: 1 },
    { id: 'b', type: 'line', x: 0, y: 7, w: 1, h: 1 },
    { id: 'c', type: 'table', x: 3, y: 3, w: 1, h: 1 }
  ])
  assert.equal(byId(out, 'a').w, 3)
  assert.equal(byId(out, 'b').w, 6)
  assert.equal(byId(out, 'c').w, 12)
})

test('autoArrange 結果不重疊也不超出 12 欄', () => {
  const types = ['number', 'line', 'gauge', 'table', 'status', 'bar', 'text', 'number', 'number']
  const out = L.autoArrange(types.map((t, i) => ({ id: 'c' + i, type: t, x: 0, y: 0, w: 1, h: 1 })))
  assert.equal(anyOverlap(out), null, `重疊：${JSON.stringify(boxes(out))}`)
  for (const c of out) assert.ok(c.x + c.w <= 12, `${c.id} 超出右邊界`)
})

test('autoArrange 填滿空隙：兩張 3 欄卡片排在同一列', () => {
  const out = L.autoArrange([
    { id: 'a', type: 'number', x: 0, y: 0, w: 1, h: 1 },
    { id: 'b', type: 'number', x: 0, y: 5, w: 1, h: 1 }
  ])
  assert.equal(byId(out, 'a').y, byId(out, 'b').y, '同列')
  assert.notEqual(byId(out, 'a').x, byId(out, 'b').x)
})

test('autoArrange 保留卡片順序（先來的排在前面）', () => {
  const out = L.autoArrange([
    { id: 'a', type: 'table', x: 0, y: 0, w: 1, h: 1 },
    { id: 'b', type: 'table', x: 0, y: 0, w: 1, h: 1 }
  ])
  assert.ok(byId(out, 'a').y < byId(out, 'b').y)
})

test('autoArrange 可用自訂寬度表，未知型別有預設寬度', () => {
  const out = L.autoArrange([{ id: 'a', type: 'weird', x: 0, y: 0, w: 1, h: 1 }], { weird: 4 })
  assert.equal(byId(out, 'a').w, 4)
  const out2 = L.autoArrange([{ id: 'b', type: 'weird', x: 0, y: 0, w: 1, h: 1 }])
  assert.ok(out2[0].w >= 1 && out2[0].w <= 12)
})

test('autoArrange 空清單不丟錯', () => {
  assert.deepEqual(L.autoArrange([]), [])
})

// ---- resizeCard ----

test('resizeCard 改變寬高並夾住上限', () => {
  const out = L.resizeCard([card('a', 0, 0, 3, 2)], 'a', 99, 99)
  const a = byId(out, 'a')
  assert.equal(a.w, 12)
  assert.equal(a.h, 6)
})

test('resizeCard 放大後把被壓到的往下擠', () => {
  const existing = [card('a', 0, 0, 3, 2), card('b', 0, 2, 3, 2)]
  const out = L.resizeCard(existing, 'a', 3, 4)
  assert.equal(anyOverlap(out), null)
  assert.ok(byId(out, 'b').y >= 4)
})

test('resizeCard 對不存在的 id 原樣回傳', () => {
  const existing = [card('a', 0, 0, 3, 2)]
  assert.deepEqual(boxes(L.resizeCard(existing, 'zzz', 6, 3)), boxes(existing))
})
