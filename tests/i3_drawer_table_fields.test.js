// AF-4 B2b:抽屜的表格卡片欄位(列軸標頭、容差)與來源欄序調整
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, name, mode = 'number') => ({
  id, name, url: `https://x.test/${id}`, mode, enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task('t1', '電費'))
  await st.saveTask(task('t2', '水費'))
  await st.saveTask(task('t3', '瓦斯'))
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const dw = await import('../src/ui/report/drawer.js?t=' + Math.random())
  return { st, ls, db, dw, doc: jd.window.document, win: jd.window }
}

async function seedTable(ls, over = {}) {
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  const c = await ls.addCard(did, {
    type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 't1', aggregation: 'raw' }, { taskId: 't2', aggregation: 'raw' }],
    options: { mode: 'pivot' }, ...over
  })
  return { did, cardId: c.id }
}

const fire = (win, el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }))
const settle = () => new Promise(r => setTimeout(r, 20))
const findCard = async (ls, did, cardId) => (await ls.getLayout()).dashboards.find(d => d.id === did).cards.find(c => c.id === cardId)

test('表格卡片的抽屜有列軸標頭與容差欄位', async () => {
  const { ls, dw, doc } = await fresh()
  const { did, cardId } = await seedTable(ls)
  await dw.openDrawer(did, cardId)
  assert.ok(doc.getElementById('drawer-row-header'), '要有列軸標頭欄位')
  assert.ok(doc.getElementById('drawer-bucket'), '要有時間容差欄位')
})

test('非表格卡片不顯示這兩個欄位', async () => {
  const { ls, dw, doc } = await fresh()
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  const c = await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1' }], options: {} })
  await dw.openDrawer(did, c.id)
  const box = doc.getElementById('drawer-field-table')
  assert.ok(box.hidden, '數值卡片不該看到表格專用欄位')
})

test('改列軸標頭會寫進卡片設定', async () => {
  const { ls, dw, doc, win } = await fresh()
  const { did, cardId } = await seedTable(ls)
  await dw.openDrawer(did, cardId)
  const el = doc.getElementById('drawer-row-header')
  el.value = '抓取時刻'
  fire(win, el, 'change')
  await settle()
  assert.equal((await findCard(ls, did, cardId)).options.rowHeader, '抓取時刻')
})

test('改容差會寫進卡片設定,而且是數字', async () => {
  const { ls, dw, doc, win } = await fresh()
  const { did, cardId } = await seedTable(ls)
  await dw.openDrawer(did, cardId)
  const el = doc.getElementById('drawer-bucket')
  el.value = '5'
  fire(win, el, 'change')
  await settle()
  const saved = await findCard(ls, did, cardId)
  assert.equal(saved.options.bucketMinutes, 5)
  assert.equal(typeof saved.options.bucketMinutes, 'number', '存成字串會讓 pivot 的整數判斷失效')
})

test('容差選「不合併」時存 0', async () => {
  const { ls, dw, doc, win } = await fresh()
  const { did, cardId } = await seedTable(ls, { options: { mode: 'pivot', bucketMinutes: 10 } })
  await dw.openDrawer(did, cardId)
  const el = doc.getElementById('drawer-bucket')
  el.value = '0'
  fire(win, el, 'change')
  await settle()
  assert.equal((await findCard(ls, did, cardId)).options.bucketMinutes, 0)
})

test('開啟抽屜時回填目前的列軸標頭與容差', async () => {
  const { ls, dw, doc } = await fresh()
  const { did, cardId } = await seedTable(ls, { options: { mode: 'pivot', rowHeader: '時刻', bucketMinutes: 15 } })
  await dw.openDrawer(did, cardId)
  assert.equal(doc.getElementById('drawer-row-header').value, '時刻')
  assert.equal(doc.getElementById('drawer-bucket').value, '15')
})

// ---- 來源欄序 ----

test('已選的來源依 card.source 的順序列出,而不是任務清單順序', async () => {
  const { ls, dw, doc } = await fresh()
  const { did, cardId } = await seedTable(ls, {
    source: [{ taskId: 't2', aggregation: 'raw' }, { taskId: 't1', aggregation: 'raw' }]
  })
  await dw.openDrawer(did, cardId)
  const checked = [...doc.querySelectorAll('#drawer-sources input[type="checkbox"]')]
    .filter(cb => cb.checked).map(cb => cb.value)
  assert.deepEqual(checked, ['t2', 't1'], '已選來源要照欄序排在前面')
})

test('每個已選來源有上移與下移按鈕', async () => {
  const { ls, dw, doc } = await fresh()
  const { did, cardId } = await seedTable(ls)
  await dw.openDrawer(did, cardId)
  const rows = [...doc.querySelectorAll('#drawer-sources [data-source-row]')]
  assert.ok(rows.length >= 2, '要以列的形式呈現來源')
  assert.ok(rows[0].querySelector('[data-action="source-down"]'), '要有下移按鈕')
  assert.ok(rows[1].querySelector('[data-action="source-up"]'), '要有上移按鈕')
})

test('按下移會把該來源往後移一位並寫回卡片', async () => {
  const { ls, dw, doc } = await fresh()
  const { did, cardId } = await seedTable(ls)
  await dw.openDrawer(did, cardId)
  doc.querySelector('#drawer-sources [data-source-row][data-task-id="t1"] [data-action="source-down"]').click()
  await settle()
  assert.deepEqual((await findCard(ls, did, cardId)).source.map(s => s.taskId), ['t2', 't1'])
})

test('按上移會把該來源往前移一位', async () => {
  const { ls, dw, doc } = await fresh()
  const { did, cardId } = await seedTable(ls)
  await dw.openDrawer(did, cardId)
  doc.querySelector('#drawer-sources [data-source-row][data-task-id="t2"] [data-action="source-up"]').click()
  await settle()
  assert.deepEqual((await findCard(ls, did, cardId)).source.map(s => s.taskId), ['t2', 't1'])
})

test('第一列不能再上移,最後一列不能再下移', async () => {
  const { ls, dw, doc } = await fresh()
  const { did, cardId } = await seedTable(ls)
  await dw.openDrawer(did, cardId)
  const rows = [...doc.querySelectorAll('#drawer-sources [data-source-row]')]
  const firstUp = rows[0].querySelector('[data-action="source-up"]')
  const lastDown = rows[rows.length - 1].querySelector('[data-action="source-down"]')
  assert.ok(!firstUp || firstUp.disabled, '第一列的上移要停用或不存在')
  assert.ok(!lastDown || lastDown.disabled, '最後一列的下移要停用或不存在')
})

test('新勾選的來源排在最後,不打亂既有欄序', async () => {
  const { ls, dw, doc, win } = await fresh()
  const { did, cardId } = await seedTable(ls, {
    source: [{ taskId: 't2', aggregation: 'raw' }, { taskId: 't1', aggregation: 'raw' }]
  })
  await dw.openDrawer(did, cardId)
  const cb = doc.querySelector('#drawer-sources input[type="checkbox"][value="t3"]')
  cb.checked = true
  fire(win, cb, 'change')
  await settle()
  assert.deepEqual((await findCard(ls, did, cardId)).source.map(s => s.taskId), ['t2', 't1', 't3'])
})

test('取消勾選會移除該欄,其餘欄序不變', async () => {
  const { ls, dw, doc, win } = await fresh()
  const { did, cardId } = await seedTable(ls, {
    source: [{ taskId: 't2' }, { taskId: 't1' }, { taskId: 't3' }]
  })
  await dw.openDrawer(did, cardId)
  const cb = doc.querySelector('#drawer-sources input[type="checkbox"][value="t1"]')
  cb.checked = false
  fire(win, cb, 'change')
  await settle()
  assert.deepEqual((await findCard(ls, did, cardId)).source.map(s => s.taskId), ['t2', 't3'])
})
