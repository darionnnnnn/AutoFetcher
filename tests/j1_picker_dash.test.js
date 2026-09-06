process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

const existing = (id = 'old') => ({
  id, name: '既有任務', url: 'https://x.test/old', mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

async function fresh(url = 'chrome-extension://abc/ui/picker/picker.html') {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(phtml, { url })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, ls, pk, doc: jd.window.document, win: jd.window }
}

function fillForm(doc, { name = '新任務', url = 'https://x.test/a', mode = 'number' } = {}) {
  doc.getElementById('name').value = name
  doc.getElementById('url').value = url
  const m = doc.getElementById('mode')
  if (m) m.value = mode
  const times = doc.getElementById('times')
  if (times) times.value = '09:00'
}

// ---- 區塊出現時機 ----

test('新建任務時顯示加入儀表板區塊', async () => {
  const { pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  const sec = doc.getElementById('add-to-dashboard')
  assert.ok(sec && !sec.hidden)
})

test('編輯既有任務時不顯示加入儀表板區塊', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTask(existing())
  await pk.renderDashboardSection(existing())
  assert.ok(doc.getElementById('add-to-dashboard').hidden)
})

test('儀表板下拉列出所有儀表板並含不加入選項', async () => {
  const { ls, pk, doc } = await fresh()
  await ls.addDashboard('第二個')
  await pk.renderDashboardSection(null)
  const sel = doc.getElementById('dashboard-select')
  const values = [...sel.options].map(o => o.value)
  assert.equal(values.filter(v => v === 'none').length, 1, '要有不加入選項')
  assert.equal(values.length, 3, '兩個儀表板加上不加入')
})

// ---- 預設勾選 ----

test('number 模式預設只勾選數字（一個值不該同時長出兩張卡）', async () => {
  const { pk, doc, win } = await fresh()
  await pk.renderDashboardSection(null)
  doc.getElementById('mode').value = 'number'
  doc.getElementById('mode').dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  const checked = [...doc.querySelectorAll('#card-types input:checked')].map(i => i.value).sort()
  assert.deepEqual(checked, ['number'])
})

test('text 模式預設只勾選表格', async () => {
  const { pk, doc, win } = await fresh()
  await pk.renderDashboardSection(null)
  doc.getElementById('mode').value = 'text'
  doc.getElementById('mode').dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
  const checked = [...doc.querySelectorAll('#card-types input:checked')].map(i => i.value)
  assert.deepEqual(checked, ['table'])
})

// ---- 存檔後加入卡片 ----

test('存檔後在所選儀表板加入對應卡片', async () => {
  const { ls, pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  fillForm(doc)
  const did = (await ls.getLayout()).dashboards[0].id
  doc.getElementById('dashboard-select').value = did
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(cards.length, 1, `number 模式預設一張卡片，實得 ${cards.length}`)
  assert.deepEqual(cards.map(c => c.type), ['number'])
})

test('加入的卡片來源指向新任務', async () => {
  const { st, ls, pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  fillForm(doc, { name: '電費' })
  doc.getElementById('dashboard-select').value = (await ls.getLayout()).dashboards[0].id
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const tasks = await st.getTasks()
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.ok(cards.every(c => c.source[0].taskId === tasks[0].id))
})

test('選擇不加入時版面完全不變', async () => {
  const { ls, pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  fillForm(doc)
  doc.getElementById('dashboard-select').value = 'none'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})

test('取消所有卡片型別勾選時不加入任何卡片', async () => {
  const { ls, pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  fillForm(doc)
  doc.getElementById('dashboard-select').value = (await ls.getLayout()).dashboards[0].id
  for (const i of doc.querySelectorAll('#card-types input')) i.checked = false
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})

test('編輯既有任務存檔不會重複加入卡片（即使區塊已被填好）', async () => {
  const { st, ls, pk, doc } = await fresh()
  await st.saveTask(existing())
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 'old' }], options: {} })
  // 先以「新建」渲染，讓下拉與勾選都是有效值，再切換成編輯既有任務
  await pk.renderDashboardSection(null)
  doc.getElementById('dashboard-select').value = did
  for (const i of doc.querySelectorAll('#card-types input')) i.checked = true
  await pk.initFromQuery('?taskId=old')
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 1,
    '編輯既有任務不可再加卡片')
})

test('卡片加在版面末端不與既有卡片重疊', async () => {
  const { ls, pk, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 12, h: 2, source: [{ taskId: 'zzz' }], options: {} })
  await pk.renderDashboardSection(null)
  fillForm(doc)
  doc.getElementById('dashboard-select').value = did
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  const cards = (await ls.getLayout()).dashboards[0].cards
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j]
      const o = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      assert.equal(o, false, '新卡片不可與既有卡片重疊')
    }
  }
})

test('所選儀表板已不存在時退回第一個儀表板', async () => {
  const { ls, pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  fillForm(doc)
  doc.getElementById('dashboard-select').value = '不存在的id'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  assert.ok((await ls.getLayout()).dashboards[0].cards.length >= 1)
})

test('表單驗證失敗時不存任務也不加卡片', async () => {
  const { st, ls, pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  fillForm(doc, { name: '' })
  doc.getElementById('dashboard-select').value = (await ls.getLayout()).dashboards[0].id
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await st.getTasks()).length, 0)
  assert.equal((await ls.getLayout()).dashboards[0].cards.length, 0)
})
