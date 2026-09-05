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

async function fresh(tasks = [task('t1', '電費'), task('t2', '水費')]) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  for (const t of tasks) await st.saveTask(t)
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const grid = jd.window.document.getElementById('dashboard-grid')
  if (grid) grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 })
  Object.defineProperty(jd.window, 'innerWidth', { value: 1400, configurable: true })
  const tp = await import('../src/ui/report/templates.js?t=' + Math.random())
  const db = await import('../src/ui/report/dashboard.js?t=' + Math.random())
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  return { c, st, ls, tp, db, rp, doc: jd.window.document, win: jd.window }
}

const overlapIn = cards => {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return [i, j]
    }
  }
  return null
}

const TASKS = [
  { id: 't1', name: '電費', mode: 'number' },
  { id: 't2', name: '水費', mode: 'number' }
]

// ---- 範本（純函式） ----

test('總覽範本：上排數字卡片、下排折線', () => {
  return fresh().then(({ tp }) => {
    const cards = tp.buildTemplate('overview', TASKS)
    const numbers = cards.filter(c => c.type === 'number')
    const lines = cards.filter(c => c.type === 'line')
    assert.equal(numbers.length, 2, '每個任務一張數字卡片')
    assert.ok(lines.length >= 1)
    assert.ok(Math.max(...numbers.map(c => c.y)) <= Math.min(...lines.map(c => c.y)),
      '數字卡片要在折線之上')
  })
})

test('單一指標深入範本：一張大折線 + 儀表 + 表格', async () => {
  const { tp } = await fresh()
  const cards = tp.buildTemplate('deepDive', TASKS)
  const types = cards.map(c => c.type).sort()
  assert.deepEqual(types, ['gauge', 'line', 'table'])
  assert.ok(cards.find(c => c.type === 'line').w >= 6, '折線要夠寬')
})

test('多任務比較範本：一張多序列折線 + 樞紐表', async () => {
  const { tp } = await fresh()
  const cards = tp.buildTemplate('compare', TASKS)
  const line = cards.find(c => c.type === 'line')
  assert.equal(line.source.length, 2, '折線要含全部任務')
  const table = cards.find(c => c.type === 'table')
  assert.equal(table.options.mode, 'pivot')
})

test('三種範本的卡片都不重疊也不超出 12 欄', async () => {
  const { tp } = await fresh()
  for (const kind of ['overview', 'deepDive', 'compare']) {
    const cards = tp.buildTemplate(kind, TASKS)
    assert.equal(overlapIn(cards), null, `${kind} 有重疊`)
    for (const c of cards) assert.ok(c.x + c.w <= 12, `${kind} 的卡片超出邊界`)
  }
})

test('文字模式任務只會進表格類卡片，不會進數值圖表', async () => {
  const { tp } = await fresh()
  const tasks = [{ id: 't1', name: '電費', mode: 'number' }, { id: 't3', name: '公告', mode: 'text' }]
  for (const kind of ['overview', 'deepDive', 'compare']) {
    for (const c of tp.buildTemplate(kind, tasks)) {
      if (['number', 'line', 'bar', 'gauge'].includes(c.type)) {
        assert.ok(!c.source.some(s => s.taskId === 't3'), `${kind} 的 ${c.type} 不該用文字任務`)
      }
    }
  }
})

test('沒有任務時範本回空陣列而不是壞掉的卡片', async () => {
  const { tp } = await fresh([])
  for (const kind of ['overview', 'deepDive', 'compare']) {
    assert.deepEqual(tp.buildTemplate(kind, []), [])
  }
})

test('未知範本名稱回空陣列', async () => {
  const { tp } = await fresh()
  assert.deepEqual(tp.buildTemplate('亂寫', TASKS), [])
})

// ---- 套用範本 ----

test('套用範本會取代目前儀表板的卡片', async () => {
  const { ls, tp, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'text', x: 0, y: 0, w: 3, h: 2, source: [], options: {} })
  await db.renderDashboard(did)
  await tp.applyTemplate(did, 'overview')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.ok(cards.length >= 2)
  assert.equal(cards.filter(c => c.type === 'text').length, 0, '舊卡片要被取代')
  void doc
})

test('套用範本後每張卡片都有 id 且不重疊', async () => {
  const { ls, tp } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await tp.applyTemplate(did, 'compare')
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.ok(cards.every(c => typeof c.id === 'string' && c.id.length > 0))
  assert.equal(overlapIn(cards), null)
})

// ---- 自動排列 ----

test('自動排列按鈕重排卡片且不重疊', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  for (const t of ['number', 'line', 'table', 'number']) {
    await ls.addCard(did, { type: t, x: 0, y: 0, w: 2, h: 2, source: [{ taskId: 't1' }], options: {} })
  }
  await db.renderDashboard(did)
  doc.getElementById('auto-arrange').click()
  await new Promise(r => setTimeout(r, 40))
  const cards = (await ls.getLayout()).dashboards[0].cards
  assert.equal(overlapIn(cards), null)
  assert.equal(cards.find(c => c.type === 'table').w, 12, '表格自動排列後應占滿寬度')
})

// ---- 儀表板頁籤 ----

test('頁籤列出所有儀表板，目前的標為 active', async () => {
  const { ls, db, doc } = await fresh()
  const l = await ls.getLayout()
  const did = l.dashboards[0].id
  await ls.addDashboard('第二個')
  await db.renderDashboard(did)
  const tabs = doc.querySelectorAll('#dashboard-tabs [data-dash-id]')
  assert.equal(tabs.length, 2)
  assert.ok(tabs[0].classList.contains('active'))
})

test('新增頁籤後 storage 多一個儀表板', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  doc.getElementById('dashboard-add').click()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await ls.getLayout()).dashboards.length, 2)
})

test('改名寫回 storage', async () => {
  const { ls, db, doc, win } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  const input = doc.querySelector(`#dashboard-tabs [data-dash-id="${did}"] input`)
  assert.ok(input, '頁籤要有可編輯名稱的輸入')
  input.value = '我的看板'
  input.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await ls.getLayout()).dashboards[0].name, '我的看板')
})

test('複製頁籤產生新儀表板且卡片 id 不同', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1' }], options: {} })
  await db.renderDashboard(did)
  doc.querySelector(`#dashboard-tabs [data-dash-id="${did}"] [data-action="duplicate"]`).click()
  await new Promise(r => setTimeout(r, 40))
  const l = await ls.getLayout()
  assert.equal(l.dashboards.length, 2)
  assert.notEqual(l.dashboards[0].cards[0].id, l.dashboards[1].cards[0].id)
})

test('刪除頁籤需確認，取消時不刪', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addDashboard('第二個')
  await db.renderDashboard(did)
  doc.querySelector(`#dashboard-tabs [data-dash-id="${did}"] [data-action="delete"]`).click()
  await new Promise(r => setTimeout(r, 30))
  const dlg = doc.getElementById('dashboard-delete-confirm')
  assert.ok(dlg && !dlg.hidden)
  dlg.querySelector('[data-action="cancel"]').click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal((await ls.getLayout()).dashboards.length, 2)
})

test('刪除頁籤確認後真的刪除', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addDashboard('第二個')
  await db.renderDashboard(did)
  doc.querySelector(`#dashboard-tabs [data-dash-id="${did}"] [data-action="delete"]`).click()
  await new Promise(r => setTimeout(r, 30))
  doc.querySelector('#dashboard-delete-confirm [data-action="confirm"]').click()
  await new Promise(r => setTimeout(r, 40))
  const l = await ls.getLayout()
  assert.equal(l.dashboards.length, 1)
  assert.notEqual(l.dashboards[0].id, did)
})

test('切換頁籤會記住最後開啟的儀表板', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const second = await ls.addDashboard('第二個')
  await db.renderDashboard(did)
  doc.querySelector(`#dashboard-tabs [data-dash-id="${second.id}"]`).click()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await ls.getLayout()).lastDashboardId, second.id)
})

// ---- 空狀態與預設頁籤 ----

test('沒有卡片時顯示空狀態，含兩個入口按鈕', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  const empty = doc.getElementById('dashboard-empty')
  assert.ok(empty && !empty.hidden)
  assert.ok(empty.querySelector('[data-action="apply-template"]'))
  assert.ok(empty.querySelector('[data-action="go-tasks"]'))
})

test('空狀態文字說明只有 Chrome 開著才會抓，錯過的在任務頁', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await db.renderDashboard(did)
  const txt = doc.getElementById('dashboard-empty').textContent
  assert.ok(txt.includes('Chrome'), `要提到 Chrome，實得：${txt}`)
  assert.ok(txt.includes('錯過'), '要提到錯過的排程在任務頁')
})

test('有卡片時空狀態隱藏', async () => {
  const { ls, db, doc } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 't1' }], options: {} })
  await db.renderDashboard(did)
  assert.ok(doc.getElementById('dashboard-empty').hidden)
})

test('沒有 hash 時預設開在儀表板頁籤', async () => {
  const { rp, doc } = await fresh()
  rp.initFromHash('')
  assert.equal(rp.getState().view, 'dashboard')
  rp.showTab('dashboard')
  assert.equal(doc.getElementById('panel-dashboard').hidden, false)
})

test('hash 指定歷史頁時仍以 hash 為準', async () => {
  const { rp } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-01')
  assert.equal(rp.getState().view, 'history')
})

test('hash 可帶儀表板 id', async () => {
  const { rp } = await fresh()
  rp.initFromHash('#view=dashboard&dash=abc123')
  assert.equal(rp.getState().dash, 'abc123')
})

test('templates.js 是純函式：不碰 DOM 也不碰 chrome', () => {
  const src = readFileSync(new URL('../src/ui/report/templates.js', import.meta.url), 'utf8')
  assert.equal((src.match(/\bdocument\b/g) || []).length, 0)
  assert.equal((src.match(/\bchrome\./g) || []).length, 0)
})
