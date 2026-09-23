process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { applyDrop, applyDropMany, cardTypeForTask } from '../src/ui/report/drop-rules.js'
import { buildSeriesIndex } from '../src/shared/series-index.js'
import { buildTemplate } from '../src/ui/report/templates.js'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const locator = css => ({ css })

const mixedTask = (id = 'mixed') => ({
  id,
  name: '跨來源',
  url: `https://a.test/${id}`,
  mode: 'multi',
  enabled: true,
  fields: [{ key: 'price', name: '價格' }, { key: 'label', name: '標籤' }],
  spec: {
    mode: 'multi',
    fields: [
      { key: 'price', mode: 'number', source: { locator: locator('#price') }, spec: { strategy: 'auto' } },
      { key: 'label', mode: 'text', source: { locator: locator('#label') }, spec: { mode: 'text' } }
    ]
  },
  schedule: { type: 'daily', times: ['09:00'] }
})

const card = (type, source = []) => ({ type, source, options: {} })

test('F2c drop rules: mixed multi 只把數字子序列放進數字圖表並提示', () => {
  const index = buildSeriesIndex([mixedTask()])
  const patch = applyDropMany(card('line'), ['mixed#price', 'mixed#label'], { seriesIndex: index })
  assert.deepEqual(patch.source.map(item => item.taskId), ['mixed#price'])
  assert.match(patch.notice, /略過 1 個文字值/)

  const numberPatch = applyDropMany(card('number'), ['mixed#price', 'mixed#label'], {
    seriesIndex: index,
    nameOf: id => id
  })
  assert.deepEqual(numberPatch.source.map(item => item.taskId), ['mixed#price'])
  assert.match(numberPatch.notice, /只用得到一個值/)
  assert.match(numberPatch.notice, /文字值/)
})

test('F2c drop rules: 全文字或文字子序列投放數字卡都拒絕，legacy 不變', () => {
  const index = buildSeriesIndex([mixedTask()])
  const rejectedMany = applyDropMany(card('line'), ['mixed#label'], { seriesIndex: index })
  assert.equal(rejectedMany.rejected, true)
  assert.match(rejectedMany.reason, /文字值/)
  const rejectedOne = applyDrop(card('number'), 'mixed#label', { seriesIndex: index })
  assert.equal(rejectedOne.rejected, true)
  const legacyPatch = applyDropMany(card('line'), ['legacy-1', 'legacy-2'])
  assert.deepEqual(legacyPatch.source.map(item => item.taskId), ['legacy-1', 'legacy-2'])
})

test('F2c 空白卡片型別依 multi 子序列決定，只有文字時回表格', () => {
  assert.equal(cardTypeForTask(mixedTask()), 'number')
  const allText = mixedTask('text-only')
  allText.spec.fields = allText.spec.fields.map(field => ({ ...field, mode: 'text' }))
  assert.equal(cardTypeForTask(allText), 'table')
})

test('F2c 範本的數字圖表只納 mixed 的數字子序列', () => {
  const cards = buildTemplate('compare', [mixedTask()])
  const chart = cards.find(item => item.type === 'line')
  assert.deepEqual(chart.source.map(item => item.taskId), ['mixed#price'])
  const table = cards.find(item => item.type === 'table')
  assert.deepEqual(table.source.map(item => item.taskId), ['mixed#price', 'mixed#label'])
})

test('F2c 抽屜父列勾選 mixed multi 時只選數字子序列', async () => {
  resetChromeMock()
  installChromeMock()
  const storage = await import('../src/shared/storage.js?f2c=' + Math.random())
  await storage.init()
  await storage.saveTask(mixedTask())
  const layoutStore = await import('../src/shared/layout-store.js?f2c=' + Math.random())
  const layout = await layoutStore.getLayout()
  const dashId = layout.dashboards[0].id
  const added = await layoutStore.addCard(dashId, {
    type: 'number', x: 0, y: 0, w: 3, h: 2, source: [], options: {}
  })
  const dom = new JSDOM(reportHtml, { url: 'chrome-extension://abc/ui/report/report.html' })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const drawer = await import('../src/ui/report/drawer.js?f2c=' + Math.random())
  await drawer.openDrawer(dashId, added.id)

  const parent = dom.window.document.querySelector('input[data-action="toggle-all"][data-parent-id="mixed"]')
  const numberChild = dom.window.document.querySelector('input[data-source-checkbox][value="mixed#price"]')
  const textChild = dom.window.document.querySelector('input[data-source-checkbox][value="mixed#label"]')
  assert.equal(parent.disabled, false)
  assert.equal(numberChild.disabled, false)
  assert.equal(textChild.disabled, true)

  parent.checked = true
  parent.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(numberChild.checked, true)
  assert.equal(textChild.checked, false)
  dom.window.document.getElementById('drawer-apply').click()
  await new Promise(resolve => setTimeout(resolve, 30))
  const saved = (await layoutStore.getLayout()).dashboards[0].cards[0]
  assert.deepEqual(saved.source.map(item => item.taskId), ['mixed#price'])
})

test('F2c dashboard 父任務拖曳實際只納數字，全文字父任務拒絕並提示', async () => {
  resetChromeMock()
  installChromeMock()
  const storage = await import('../src/shared/storage.js?f2c-dnd=' + Math.random())
  await storage.init()
  await storage.saveTask(mixedTask())
  const textOnly = mixedTask('text-only')
  textOnly.spec.fields = textOnly.spec.fields.map(field => ({ ...field, mode: 'text' }))
  await storage.saveTask(textOnly)

  const layoutStore = await import('../src/shared/layout-store.js?f2c-dnd=' + Math.random())
  const layout = await layoutStore.getLayout()
  const dashId = layout.dashboards[0].id
  const numberCard = await layoutStore.addCard(dashId, {
    type: 'number', x: 0, y: 0, w: 3, h: 2,
    source: [{ taskId: 'old', aggregation: 'raw' }], options: {}
  })
  const lineCard = await layoutStore.addCard(dashId, {
    type: 'line', x: 4, y: 0, w: 6, h: 2,
    source: [], options: {}
  })
  const dom = new JSDOM(reportHtml, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const grid = dom.window.document.getElementById('dashboard-grid')
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 })
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true })
  const dashboard = await import('../src/ui/report/dashboard.js?f2c-dnd=' + Math.random())
  await dashboard.renderDashboard(dashId)
  dom.window.document.getElementById('edit-layout').click()
  await new Promise(resolve => setTimeout(resolve, 30))

  const rect = (el, left, right) => {
    el.getBoundingClientRect = () => ({ left, top: 0, right, bottom: 200, width: right - left, height: 200 })
  }
  rect(dom.window.document.querySelector(`[data-card-id="${numberCard.id}"]`), 0, 300)
  rect(dom.window.document.querySelector(`[data-card-id="${lineCard.id}"]`), 300, 900)
  const pointer = (type, x, y) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { clientX: x, clientY: y, pointerId: 1, button: 0 })
    return event
  }
  const drag = async (id, x, y) => {
    const item = dom.window.document.querySelector(`[data-palette-task][data-task-id="${id}"]`)
    assert.ok(item)
    item.dispatchEvent(pointer('pointerdown', 0, 0))
    dom.window.document.dispatchEvent(pointer('pointermove', x, y))
    dom.window.document.dispatchEvent(pointer('pointerup', x, y))
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  await drag('mixed', 150, 100)
  let saved = (await layoutStore.getLayout()).dashboards[0].cards.find(card => card.id === numberCard.id)
  assert.deepEqual(saved.source.map(item => item.taskId), ['mixed#price'])

  await drag('text-only', 600, 100)
  saved = (await layoutStore.getLayout()).dashboards[0].cards.find(card => card.id === lineCard.id)
  assert.deepEqual(saved.source, [])
  const toast = dom.window.document.getElementById('dnd-toast')
  assert.ok(toast && !toast.hidden && /文字值/.test(toast.textContent))
})
