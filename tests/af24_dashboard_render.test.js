// AF-24 E1／E3：快速切儀表板時晚到的繪製不得蓋掉新的；讀取失敗要說出來並可重試；首頁預設可見
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

async function setup() {
  resetChromeMock()
  const c = installChromeMock()
  const storage = await import('../src/shared/storage.js?e1=' + Math.random())
  await storage.init()
  const ls = await import('../src/shared/layout-store.js?e1=' + Math.random())
  const first = (await ls.getLayout()).dashboards[0]
  const second = await ls.addDashboard('乙')
  const cardA = await ls.addCard(first.id, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 'a', aggregation: 'raw' }], options: {} })
  const cardB = await ls.addCard(second.id, { type: 'number', x: 0, y: 0, w: 3, h: 2, source: [{ taskId: 'b', aggregation: 'raw' }], options: {} })
  const dom = new JSDOM(reportHtml, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true })
  const dashboard = await import('../src/ui/report/dashboard.js?e1=' + Math.random())
  return { c, dom, dashboard, first, second, cardA, cardB }
}

test('A 的繪製卡在讀取、B 先畫完：A 晚到不得把格線換回 A', async () => {
  const { c, dom, dashboard, first, second, cardA, cardB } = await setup()
  const realGet = c.storage.local.get.bind(c.storage.local)
  let release
  const gate = new Promise(r => { release = r })
  let gated = false
  c.storage.local.get = async (keys) => {
    const wantsLayout = keys === 'layout' || (Array.isArray(keys) && keys.includes('layout'))
    if (wantsLayout && !gated) { gated = true; await gate }
    return realGet(keys)
  }
  const runA = dashboard.renderDashboard(first.id)
  await dashboard.renderDashboard(second.id)
  release()
  await runA
  c.storage.local.get = realGet
  const ids = [...dom.window.document.querySelectorAll('#dashboard-grid [data-card-id]')].map(el => el.dataset.cardId)
  assert.deepEqual(ids, [cardB.id], `格線要是 B 的卡片（A=${cardA.id}）`)
})

test('儀表板讀取失敗：顯示橫幅與重試，重試成功後橫幅消失', async () => {
  const { c, dom, dashboard, first } = await setup()
  const realGet = c.storage.local.get.bind(c.storage.local)
  c.storage.local.get = async () => { throw new Error('storage 壞了') }
  await dashboard.renderDashboard(first.id).catch(dashboard.showDashboardLoadError)
  const banner = dom.window.document.getElementById('dashboard-load-error')
  assert.ok(banner, '要有錯誤橫幅')
  assert.match(banner.textContent, /儀表板載入失敗：storage 壞了/)
  c.storage.local.get = realGet
  banner.querySelector('button').click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(dom.window.document.getElementById('dashboard-load-error'), null)
})

test('首頁是儀表板：HTML 預設儀表板可見、歷史隱藏；新增鈕用圖示不用「+」字元', () => {
  const dom = new JSDOM(reportHtml)
  const d = dom.window.document
  assert.equal(d.getElementById('panel-dashboard').hidden, false)
  assert.equal(d.getElementById('panel-history').hidden, true)
  assert.equal(d.getElementById('dashboard-add').textContent.trim(), '')
  assert.ok(readFileSync(new URL('../src/ui/report/dashboard.js', import.meta.url), 'utf8').includes("setIcon(addBtn, 'plus'"))
})

test('E5 頁籤是 tablist：目前那個可 Tab 到；→ 切到下一個並把焦點留在新頁籤', async () => {
  const { dom, dashboard, first, second, cardB } = await setup()
  await dashboard.renderDashboard(first.id)
  const d = dom.window.document
  assert.equal(d.getElementById('dashboard-tabs').getAttribute('role'), 'tablist')
  const tabs = () => [...d.querySelectorAll('#dashboard-tabs [role="tab"]')]
  assert.deepEqual(tabs().map(t => t.tabIndex), [0, -1])
  assert.deepEqual(tabs().map(t => t.getAttribute('aria-selected')), ['true', 'false'])
  tabs()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(tabs().map(t => t.getAttribute('aria-selected')), ['false', 'true'])
  assert.equal(d.activeElement?.dataset?.dashId, second.id, '焦點跟著到新頁籤')
  const ids = [...d.querySelectorAll('#dashboard-grid [data-card-id]')].map(el => el.dataset.cardId)
  assert.deepEqual(ids, [cardB.id])
})

test('E5 在名稱輸入框裡按方向鍵不切頁籤', async () => {
  const { dom, dashboard, first } = await setup()
  await dashboard.renderDashboard(first.id)
  const d = dom.window.document
  const input = d.querySelector('#dashboard-tabs [role="tab"] input')
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  await new Promise(r => setTimeout(r, 30))
  assert.equal(d.querySelector('#dashboard-tabs [aria-selected="true"]').dataset.dashId, first.id)
})

test('體檢：過期的繪製（A）讀取失敗時，不得在已畫好的 B 上掛失敗橫幅', async () => {
  const { c, dom, dashboard, first, second, cardB } = await setup()
  const realGet = c.storage.local.get.bind(c.storage.local)
  let rejectA
  const gate = new Promise((_, reject) => { rejectA = reject })
  let gated = false
  c.storage.local.get = async (keys) => {
    const wantsLayout = keys === 'layout' || (Array.isArray(keys) && keys.includes('layout'))
    if (wantsLayout && !gated) { gated = true; await gate }
    return realGet(keys)
  }
  const runA = dashboard.renderDashboard(first.id).catch(dashboard.showDashboardLoadError)
  await dashboard.renderDashboard(second.id)
  rejectA(new Error('A 慢速失敗'))
  await runA
  c.storage.local.get = realGet
  assert.equal(dom.window.document.getElementById('dashboard-load-error'), null, '過期的失敗不得影響新畫面')
  const ids = [...dom.window.document.querySelectorAll('#dashboard-grid [data-card-id]')].map(el => el.dataset.cardId)
  assert.deepEqual(ids, [cardB.id])
})
