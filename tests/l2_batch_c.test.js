// AF-5 批次 C：儀表板去重與預設卡
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  return { st, ls }
}

const card = (over = {}) => ({
  type: 'number', x: 0, y: 0, w: 3, h: 2,
  source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over
})

// ---- addCard 去重 ----

test('同型別且來源集合相同的卡片不重複新增', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const a = await ls.addCard(did, card())
  const b = await ls.addCard(did, card())
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1, '同一張卡不該長兩次')
  assert.equal(b.id, a.id, '重複時要回傳既有那張，呼叫端才不會以為建了新的')
})

test('型別不同仍可並存', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card())
  await ls.addCard(did, card({ type: 'line' }))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 2)
})

test('來源集合相同但順序不同視為同一張', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ type: 'line', source: [{ taskId: 'a' }, { taskId: 'b' }] }))
  await ls.addCard(did, card({ type: 'line', source: [{ taskId: 'b' }, { taskId: 'a' }] }))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 1)
})

test('來源不同就是不同卡片', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ source: [{ taskId: 'a' }] }))
  await ls.addCard(did, card({ source: [{ taskId: 'b' }] }))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 2)
})

test('不同儀表板各自獨立，不互相去重', async () => {
  const { ls } = await fresh()
  const l0 = await ls.getLayout()
  const d1 = l0.dashboards[0].id
  const d2 = (await ls.addDashboard('第二個')).id
  await ls.addCard(d1, card())
  await ls.addCard(d2, card())
  const l = await ls.getLayout()
  assert.equal(l.dashboards.find(d => d.id === d1).cards.length, 1)
  assert.equal(l.dashboards.find(d => d.id === d2).cards.length, 1)
})

test('沒有來源的卡片（文字卡）不受去重影響', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ type: 'text', source: [], options: { content: '甲' } }))
  await ls.addCard(did, card({ type: 'text', source: [], options: { content: '乙' } }))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 2, '文字卡可以有很多張')
})

// ---- 卡片標題 ----

async function freshCards() {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return await import('../src/ui/report/cards.js?t=' + Math.random())
}

const ctxOf = (over = {}) => ({
  records: [], tasksById: { t1: { id: 't1', name: '電費', mode: 'number' } },
  health: {}, nextRuns: {}, missed: [],
  range: { from: '2026-09-01', to: '2026-09-06' }, today: '2026-09-06', ...over
})

test('同名不同型別的卡片，第二張起在標題附型別後綴', async () => {
  const CR = await freshCards()
  const ctx = ctxOf({
    cards: [
      { id: 'c1', type: 'number', source: [{ taskId: 't1' }], options: {} },
      { id: 'c2', type: 'line', source: [{ taskId: 't1' }], options: {} }
    ]
  })
  const first = CR.renderCard(ctx.cards[0], ctx)
  const second = CR.renderCard(ctx.cards[1], ctx)
  assert.equal(first.querySelector('.card-title').textContent, '電費')
  assert.equal(second.querySelector('.card-title').textContent, '電費 · 趨勢',
    '兩張都叫「電費」分不出誰是誰')
})

test('使用者自訂的標題不被加後綴', async () => {
  const CR = await freshCards()
  const ctx = ctxOf({
    cards: [
      { id: 'c1', type: 'number', source: [{ taskId: 't1' }], options: {} },
      { id: 'c2', type: 'line', title: '我的圖', source: [{ taskId: 't1' }], options: {} }
    ]
  })
  const second = CR.renderCard(ctx.cards[1], ctx)
  assert.equal(second.querySelector('.card-title').textContent, '我的圖')
})

test('沒有同名卡片時不加後綴', async () => {
  const CR = await freshCards()
  const ctx = ctxOf({
    tasksById: { t1: { id: 't1', name: '電費' }, t2: { id: 't2', name: '水費' } },
    cards: [
      { id: 'c1', type: 'number', source: [{ taskId: 't1' }], options: {} },
      { id: 'c2', type: 'line', source: [{ taskId: 't2' }], options: {} }
    ]
  })
  const second = CR.renderCard(ctx.cards[1], ctx)
  assert.equal(second.querySelector('.card-title').textContent, '水費')
})

test('ctx 沒帶 cards 時標題維持原樣（不得因此丟標題）', async () => {
  const CR = await freshCards()
  const el = CR.renderCard({ id: 'c1', type: 'line', source: [{ taskId: 't1' }], options: {} }, ctxOf())
  assert.equal(el.querySelector('.card-title').textContent, '電費')
})
