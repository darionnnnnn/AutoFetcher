process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const task = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }, ...over
})

const card = (over = {}) => ({
  type: 'number', x: 0, y: 0, w: 3, h: 2,
  source: [{ taskId: 't1', aggregation: 'raw' }], options: {}, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  return { c, st, ls }
}

// ---- 讀取與版本 ----

test('沒有任何版面時自動建立一個預設儀表板', async () => {
  const { ls } = await fresh()
  const l = await ls.getLayout()
  assert.equal(l.version, 1)
  assert.equal(l.dashboards.length, 1)
  assert.ok(l.dashboards[0].id)
  assert.deepEqual(l.dashboards[0].cards, [])
})

test('讀取舊資料時補齊缺少的欄位，不丟棄既有卡片', async () => {
  const { c, ls } = await fresh()
  await c.storage.local.set({ layout: { dashboards: [{ id: 'd1', cards: [{ id: 'c1', type: 'number' }] }] } })
  const l = await ls.getLayout()
  assert.equal(l.version, 1)
  assert.equal(l.dashboards[0].name.length > 0, true, '缺少名稱要補預設')
  const cd = l.dashboards[0].cards[0]
  assert.equal(cd.id, 'c1')
  assert.equal(typeof cd.x, 'number')
  assert.equal(typeof cd.w, 'number')
  assert.ok(Array.isArray(cd.source))
  assert.ok(cd.options && typeof cd.options === 'object')
})

test('遇到更高版本照讀不丟棄，並標記 newerVersion', async () => {
  const { c, ls } = await fresh()
  await c.storage.local.set({ layout: { version: 99, dashboards: [{ id: 'd1', name: '未來', cards: [] }] } })
  const l = await ls.getLayout()
  assert.equal(l.newerVersion, true)
  assert.equal(l.dashboards[0].name, '未來')
})

test('目前版本讀取時 newerVersion 不為真', async () => {
  const { ls } = await fresh()
  const l = await ls.getLayout()
  assert.notEqual(l.newerVersion, true)
})

test('壞掉的 layout（不是物件或缺 dashboards）退回預設而不丟錯', async () => {
  const { c, ls } = await fresh()
  await c.storage.local.set({ layout: 'oops' })
  const l = await ls.getLayout()
  assert.equal(l.dashboards.length, 1)
})

test('layout-store 不直接碰 chrome.storage，一律經 storage.js', () => {
  const src = readFileSync(new URL('../src/shared/layout-store.js', import.meta.url), 'utf8')
  assert.equal((src.match(/chrome\.storage/g) || []).length, 0)
})

// ---- 儀表板 CRUD ----

test('addDashboard 新增並回新儀表板，名稱保留', async () => {
  const { ls } = await fresh()
  const d = await ls.addDashboard('第二個')
  assert.equal(d.name, '第二個')
  const l = await ls.getLayout()
  assert.equal(l.dashboards.length, 2)
  assert.equal(l.dashboards[1].name, '第二個')
})

test('renameDashboard 改名', async () => {
  const { ls } = await fresh()
  const l0 = await ls.getLayout()
  await ls.renameDashboard(l0.dashboards[0].id, '改過的')
  const l = await ls.getLayout()
  assert.equal(l.dashboards[0].name, '改過的')
})

test('deleteDashboard 刪掉指定的那一個', async () => {
  const { ls } = await fresh()
  const d = await ls.addDashboard('第二個')
  await ls.deleteDashboard(d.id)
  const l = await ls.getLayout()
  assert.equal(l.dashboards.length, 1)
  assert.notEqual(l.dashboards[0].id, d.id)
})

test('刪掉最後一個儀表板時自動留一個空的', async () => {
  const { ls } = await fresh()
  const l0 = await ls.getLayout()
  await ls.deleteDashboard(l0.dashboards[0].id)
  const l = await ls.getLayout()
  assert.equal(l.dashboards.length, 1)
  assert.deepEqual(l.dashboards[0].cards, [])
})

test('duplicateDashboard 複製卡片但 id 全新', async () => {
  const { ls } = await fresh()
  const l0 = await ls.getLayout()
  const did = l0.dashboards[0].id
  await ls.addCard(did, card())
  await ls.addCard(did, card({ type: 'line' }))
  const copy = await ls.duplicateDashboard(did)
  const l = await ls.getLayout()
  const orig = l.dashboards.find(d => d.id === did)
  const dup = l.dashboards.find(d => d.id === copy.id)
  assert.notEqual(dup.id, did)
  assert.equal(dup.cards.length, 2)
  const origIds = orig.cards.map(c => c.id)
  for (const c of dup.cards) assert.ok(!origIds.includes(c.id), '複製後卡片 id 必須全新')
  assert.deepEqual(dup.cards.map(c => c.type), orig.cards.map(c => c.type))
})

test('reorderDashboards 依給定 id 順序排列，未列到的留在後面', async () => {
  const { ls } = await fresh()
  const a = (await ls.getLayout()).dashboards[0]
  const b = await ls.addDashboard('B')
  const cD = await ls.addDashboard('C')
  await ls.reorderDashboards([cD.id, a.id])
  const l = await ls.getLayout()
  assert.deepEqual(l.dashboards.map(d => d.id), [cD.id, a.id, b.id])
})

test('setLastDashboard 記住最後開啟的儀表板', async () => {
  const { ls } = await fresh()
  const b = await ls.addDashboard('B')
  await ls.setLastDashboard(b.id)
  assert.equal((await ls.getLayout()).lastDashboardId, b.id)
})

// ---- 卡片 CRUD ----

test('addCard 自動配 id 與空位', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c1 = await ls.addCard(did, card())
  // 同型別同來源會被去重（AF-5 批次 C），這裡用不同型別驗證自動配位
  const c2 = await ls.addCard(did, card({ type: 'line' }))
  assert.ok(c1.id && c2.id && c1.id !== c2.id)
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 2)
  const [a, b] = cards
  const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert.equal(overlap, false, '自動配的位置不可重疊')
})

test('addCard 夾住越界的寬高', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c = await ls.addCard(did, card({ w: 99, h: 99 }))
  assert.equal(c.w, 12)
  assert.equal(c.h, 6)
})

test('updateCard 只改給定欄位，其餘保留', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c = await ls.addCard(did, card({ title: '原標題' }))
  await ls.updateCard(did, c.id, { type: 'line' })
  const got = (await ls.getLayout()).dashboards[0].cards[0]
  assert.equal(got.type, 'line')
  assert.equal(got.title, '原標題')
  assert.equal(got.id, c.id)
})

test('removeCard 移除指定卡片', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const c1 = await ls.addCard(did, card())
  await ls.addCard(did, card())
  await ls.removeCard(did, c1.id)
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1)
  assert.notEqual(cards[0].id, c1.id)
})

test('對不存在的儀表板或卡片操作不丟錯也不改動資料', async () => {
  const { ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card())
  await ls.updateCard('nope', 'nope', { type: 'line' })
  await ls.removeCard(did, 'nope')
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 1)
})

// ---- 任務刪除連動 ----

test('刪任務時單一來源的卡片一併消失', async () => {
  const { ls, st } = await fresh()
  await st.saveTask(task('t1'))
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ source: [{ taskId: 't1', aggregation: 'raw' }] }))
  await st.deleteTask('t1')
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})

test('多來源卡片只移除該來源，卡片本身留著', async () => {
  const { ls, st } = await fresh()
  await st.saveTask(task('t1'))
  await st.saveTask(task('t2'))
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ type: 'line', source: [
    { taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }
  ] }))
  await st.deleteTask('t1')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].source.map(s => s.taskId), ['t2'])
})

test('刪任務不影響 text 卡片（本來就沒有來源）', async () => {
  const { ls, st } = await fresh()
  await st.saveTask(task('t1'))
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card({ type: 'text', source: [], options: { content: '說明' } }))
  await st.deleteTask('t1')
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 1)
})

test('刪任務會掃過所有儀表板', async () => {
  const { ls, st } = await fresh()
  await st.saveTask(task('t1'))
  const d1 = (await ls.getLayout()).dashboards[0].id
  const d2 = (await ls.addDashboard('B')).id
  await ls.addCard(d1, card())
  await ls.addCard(d2, card())
  await st.deleteTask('t1')
  const l = await ls.getLayout()
  assert.equal(l.dashboards[0].cards.length, 0)
  assert.equal(l.dashboards[1].cards.length, 0)
})

test('pruneCardsForTask 可單獨呼叫且對沒卡片的情況安全', async () => {
  const { ls } = await fresh()
  await ls.pruneCardsForTask('不存在')
  assert.equal((await ls.getLayout()).dashboards.length, 1)
})

test('storage.deleteTask 內部有呼叫版面清理', () => {
  const src = readFileSync(new URL('../src/shared/storage.js', import.meta.url), 'utf8')
  assert.ok(/pruneCardsForTask/.test(src), 'deleteTask 要連動清理卡片')
})

// ---- 與設定匯入匯出的接線 ----

test('exportAll 帶出的版面與 getLayout 一致', async () => {
  const { ls, st } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, card())
  const dump = await st.exportAll()
  assert.equal(dump.layout.dashboards[0].cards.length, 1)
})

test('匯入舊格式版面時會補齊欄位', async () => {
  const { ls } = await fresh()
  const sio = await import('../src/shared/settings-io.js?t=' + Math.random())
  const json = JSON.stringify({
    kind: 'autofetcher-settings', version: 1, exportedAt: 'x',
    data: {
      schemaVersion: 1, tasks: [], sites: {}, settings: {},
      layout: { dashboards: [{ id: 'd9', cards: [{ id: 'c9', type: 'line' }] }] }
    }
  })
  await sio.importSettings(json)
  const l = await ls.getLayout()
  assert.equal(l.version, 1)
  const cd = l.dashboards.find(d => d.id === 'd9').cards[0]
  assert.equal(typeof cd.w, 'number')
  assert.ok(Array.isArray(cd.source))
})

test('saveLayout 寫入後再讀回內容相同', async () => {
  const { ls } = await fresh()
  const l = await ls.getLayout()
  l.dashboards[0].name = '手動改的'
  await ls.saveLayout(l)
  assert.equal((await ls.getLayout()).dashboards[0].name, '手動改的')
})

test('saveLayout 不寫入 newerVersion 這種暫時性旗標', async () => {
  const { c, ls } = await fresh()
  const l = await ls.getLayout()
  l.newerVersion = true
  await ls.saveLayout(l)
  const raw = (await c.storage.local.get('layout')).layout
  assert.equal(raw.newerVersion, undefined)
})
