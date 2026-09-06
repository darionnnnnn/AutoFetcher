// AF-4 C2:把任務投放到各型別卡片的規則(純函式,無 DOM)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDrop, MAX_CHART_SERIES, cardTypeForTask } from '../src/ui/report/drop-rules.js'

const card = (type, source = [], options = {}) => ({
  id: 'c1', type, x: 0, y: 0, w: 6, h: 2, source, options
})
const src = (...ids) => ids.map(id => ({ taskId: id, aggregation: 'raw' }))

// ---- table:依落點插入欄位 ----

test('table:拖進來的任務插在指定位置', () => {
  const patch = applyDrop(card('table', src('t1', 't2')), 't3', { index: 1 })
  assert.deepEqual(patch.source.map(s => s.taskId), ['t1', 't3', 't2'])
})

test('table:index 省略時加在最後', () => {
  const patch = applyDrop(card('table', src('t1')), 't2', {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['t1', 't2'])
})

test('table:已存在的任務是搬移,不是變成兩欄', () => {
  const patch = applyDrop(card('table', src('t1', 't2', 't3')), 't3', { index: 0 })
  assert.deepEqual(patch.source.map(s => s.taskId), ['t3', 't1', 't2'])
})

test('table:搬到自己原本的位置時回 null(沒有變化就不要進 undo)', () => {
  assert.equal(applyDrop(card('table', src('t1', 't2')), 't1', { index: 0 }), null)
})

test('table:index 超出範圍時夾在合法區間', () => {
  const patch = applyDrop(card('table', src('t1')), 't2', { index: 99 })
  assert.deepEqual(patch.source.map(s => s.taskId), ['t1', 't2'])
})

// ---- line / bar:追加,有上限 ----

test('line:追加到最後並去重', () => {
  const patch = applyDrop(card('line', src('t1')), 't2', {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['t1', 't2'])
})

test('line:已經有的任務再拖一次不重複,回 null', () => {
  assert.equal(applyDrop(card('line', src('t1', 't2')), 't2', {}), null)
})

test('line:超過調色盤上限時拒絕,並說明原因', () => {
  const many = src(...Array.from({ length: MAX_CHART_SERIES }, (_, i) => `t${i}`))
  const out = applyDrop(card('line', many), 'tX', {})
  assert.equal(out?.rejected, true, '要明確表示被拒絕,而不是靜靜地不動作')
  assert.ok(out.reason && out.reason.length > 0, '要有可以顯示給使用者的理由')
  assert.equal(out.source, undefined, '拒絕時不可改動來源')
})

test('bar 與 line 規則相同', () => {
  const patch = applyDrop(card('bar', src('t1')), 't2', {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['t1', 't2'])
})

// ---- number / gauge:取代唯一來源 ----

test('number:取代原本的來源', () => {
  const patch = applyDrop(card('number', src('t1')), 't2', {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['t2'])
})

test('number:標題是舊任務名稱時跟著換成新任務名稱', () => {
  const c = { ...card('number', src('t1')), title: '電費' }
  const patch = applyDrop(c, 't2', { taskName: '水費', prevTaskName: '電費' })
  assert.equal(patch.title, '水費')
})

test('number:使用者自訂過的標題不可被覆蓋', () => {
  const c = { ...card('number', src('t1')), title: '我的重點指標' }
  const patch = applyDrop(c, 't2', { taskName: '水費', prevTaskName: '電費' })
  assert.equal(patch.title, undefined, '沒有要改標題時就不要放進 patch')
})

test('number:沒有標題時不硬塞標題', () => {
  const patch = applyDrop(card('number', src('t1')), 't2', { taskName: '水費', prevTaskName: '電費' })
  assert.equal(patch.title, undefined)
})

test('gauge 與 number 規則相同', () => {
  const patch = applyDrop(card('gauge', src('t1')), 't2', {})
  assert.deepEqual(patch.source.map(s => s.taskId), ['t2'])
})

test('number:拖進來的就是原本那個任務時回 null', () => {
  assert.equal(applyDrop(card('number', src('t1')), 't1', {}), null)
})

// ---- status:加入篩選清單 ----

test('status:加進 options.taskIds 並去重', () => {
  const patch = applyDrop(card('status', [], { taskIds: ['t1'] }), 't2', {})
  assert.deepEqual(patch.options.taskIds, ['t1', 't2'])
  assert.equal(applyDrop(card('status', [], { taskIds: ['t1'] }), 't1', {}), null)
})

test('status:原本沒有篩選清單時建一個', () => {
  const patch = applyDrop(card('status', []), 't1', {})
  assert.deepEqual(patch.options.taskIds, ['t1'])
})

// ---- text:不接受 ----

test('text:一律不接受', () => {
  assert.equal(applyDrop(card('text', []), 't1', {}), null)
})

test('未知型別不接受', () => {
  assert.equal(applyDrop(card('sparkline-3d', []), 't1', {}), null)
})

test('沒有 taskId 時不動作', () => {
  assert.equal(applyDrop(card('table', src('t1')), '', {}), null)
  assert.equal(applyDrop(card('table', src('t1')), null, {}), null)
})

// ---- 新卡片型別 ----

test('數值與區塊模式的任務拖到空白處建數值卡', () => {
  assert.equal(cardTypeForTask({ id: 't1', mode: 'number' }), 'number')
  assert.equal(cardTypeForTask({ id: 't1', mode: 'block' }), 'number')
})

test('文字模式的任務拖到空白處建表格卡', () => {
  assert.equal(cardTypeForTask({ id: 't1', mode: 'text' }), 'table')
})

test('沒有模式資訊時退回數值卡', () => {
  assert.equal(cardTypeForTask({ id: 't1' }), 'number')
  assert.equal(cardTypeForTask(null), 'number')
})

// ---- 共通 ----

test('新來源沿用卡片目前的聚合設定,沒有就用 raw', () => {
  const withAgg = applyDrop(card('line', src('t1'), { aggregation: 'dayMax' }), 't2', {})
  assert.equal(withAgg.source.find(s => s.taskId === 't2').aggregation, 'dayMax')
  const noAgg = applyDrop(card('line', src('t1')), 't2', {})
  assert.equal(noAgg.source.find(s => s.taskId === 't2').aggregation, 'raw')
})

test('搬移既有欄位時保留它原本的聚合設定', () => {
  const c = card('table', [{ taskId: 't1', aggregation: 'dayMax' }, { taskId: 't2', aggregation: 'raw' }])
  const patch = applyDrop(c, 't1', { index: 1 })
  assert.equal(patch.source.find(s => s.taskId === 't1').aggregation, 'dayMax')
})

test('回傳的 patch 不可就地改動原本的卡片物件', () => {
  const c = card('table', src('t1'))
  const before = JSON.stringify(c)
  applyDrop(c, 't2', {})
  assert.equal(JSON.stringify(c), before, '就地修改會讓 undo 失效')
})
