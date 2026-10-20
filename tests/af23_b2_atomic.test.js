import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const storage = await import('../src/shared/storage.js')
  await storage.init()
  const layout = await import('../src/shared/layout-store.js')
  const dash = (await layout.getLayout()).dashboards[0]
  return { storage, layout, dashId: dash.id }
}

test('卡片拖入以鎖內最新來源計算，prune 後不會由舊畫面復活來源', async () => {
  const { layout, dashId } = await fresh()
  const card = await layout.addCard(dashId, {
    type: 'line', source: [{ taskId: 'a' }, { taskId: 'b' }], options: { aggregation: 'raw' }
  })
  // 舊畫面曾先以 [a,b] 算出 patch；在該 patch 寫入前背景已修剪 b。
  await layout.pruneSeries(['b'])
  await layout.updateCard(dashId, card.id, latest => ({
    source: [...latest.source, { taskId: 'c', aggregation: 'raw' }]
  }))
  const actual = (await layout.getLayout()).dashboards[0].cards[0]
  assert.deepEqual(actual.source.map(s => s.taskId), ['a', 'c'])
})

test('狀態卡拖入以最新 options.taskIds 更新，保留 prune 並行結果與其他選項', async () => {
  const { layout, dashId } = await fresh()
  const card = await layout.addCard(dashId, {
    type: 'status', source: [], options: { taskIds: ['a', 'b'], showDisabled: true }
  })
  await layout.pruneSeries(['b'])
  await layout.updateCard(dashId, card.id, latest => ({
    options: { ...latest.options, taskIds: [...latest.options.taskIds, 'c'] }
  }))
  const actual = (await layout.getLayout()).dashboards[0].cards[0]
  assert.deepEqual(actual.options.taskIds, ['a', 'c'])
  assert.equal(actual.options.showDisabled, true)
})

test('復原只套用本步 options 子欄位並保留其他頁的新設定', async () => {
  const { layout, dashId } = await fresh()
  const card = await layout.addCard(dashId, {
    type: 'status', source: [], options: { taskIds: ['a', 'b'], title: '原標題', showDisabled: false }
  })
  const before = (await layout.getLayout()).dashboards
  await layout.updateCard(dashId, card.id, { options: { taskIds: ['a'], title: '本頁標題', showDisabled: false } })
  const after = (await layout.getLayout()).dashboards
  await layout.updateCard(dashId, card.id, latest => ({
    options: { ...latest.options, title: '另一頁新標題' }
  }))
  await layout.applyLayoutStep(after, before, id => id !== 'b')
  const actual = (await layout.getLayout()).dashboards[0].cards[0]
  assert.deepEqual(actual.options.taskIds, ['a'])
  assert.equal(actual.options.title, '另一頁新標題')
  assert.equal(actual.options.showDisabled, false)
})
