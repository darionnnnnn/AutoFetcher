process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const popupHtml = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
const task = (id, over = {}) => ({
  id, name: '手動同名', url: `https://bank.test/rates?credential=${id}`,
  mode: 'number', enabled: true, locator: { css: '#rate' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})
const tasks = [task('left-abcdef'), task('right-abcdef')]

function setupDom(html, url = 'chrome-extension://af/ui/report/report.html') {
  const jd = new JSDOM(html, { url })
  if (jd.window.HTMLDialogElement) {
    jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  return jd
}

async function setupStorage() {
  resetChromeMock()
  const c = installChromeMock()
  const storage = await import('../src/shared/storage.js?r19=' + Math.random())
  await storage.init()
  return { c, storage }
}

test('R19 identity labels preserve names, normalize source URLs, and lengthen colliding id suffixes', async () => {
  const { describeTaskIdentities } = await import('../src/shared/describe.js?r19=' + Math.random())
  const identities = describeTaskIdentities(tasks)
  assert.equal(identities.get(tasks[0].id).name, '手動同名')
  assert.equal(identities.get(tasks[0].id).source, 'bank.test/rates')
  assert.notEqual(identities.get(tasks[0].id).shortId, identities.get(tasks[1].id).shortId)
  assert.ok(identities.get(tasks[0].id).shortId.length > 6, '相同末六碼必須延長到不衝突')
  const reversed = describeTaskIdentities([...tasks].reverse())
  for (const item of tasks) assert.deepEqual(reversed.get(item.id), identities.get(item.id))
  const separate = describeTaskIdentities([tasks[0], task('other-id', { url: 'https://bank.test/archive' })])
  assert.equal(separate.get('other-id').shortId, '', '來源不同時不需任務 id 後綴')
})

test('R19 任務頁、刪除確認與歷史篩選在排序後仍能辨識同名同來源任務', async () => {
  const { c, storage } = await setupStorage()
  await storage.saveTasks(tasks)
  const jd = setupDom(reportHtml)
  const taskUi = await import('../src/ui/report/tasks.js?r19=' + Math.random())
  taskUi.renderTasks(tasks, {}, [])
  const urls = new Map([...document.querySelectorAll('#task-list .task-row')].map(row => [
    row.dataset.taskId, row.querySelector('.task-url').textContent
  ]))
  assert.match(document.querySelector('[data-task-id="left-abcdef"] .task-name').textContent, /^手動同名$/)
  assert.match(urls.get('left-abcdef'), /^#.+ · bank\.test\/rates$/)
  taskUi.renderTasks([...tasks].reverse(), {}, [])
  for (const [id, label] of urls) assert.equal(document.querySelector(`[data-task-id="${id}"] .task-url`).textContent, label)
  document.querySelector('[data-task-id="right-abcdef"] [data-action="repick"]').click()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(c.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'ENTER_PICK' && call.args[0]?.taskId === 'right-abcdef'))
  c.__setCurrentTab({ id: 42, url: 'chrome-extension://af/ui/report/report.html' })
  document.querySelector('[data-task-id="left-abcdef"] [data-action="edit"]').click()
  await new Promise(resolve => setTimeout(resolve, 10))
  const session = await chrome.storage.session.get(null)
  assert.ok(Object.values(session).some(value => value?.kind === 'edit' && value.taskId === 'left-abcdef'))

  document.querySelector('[data-task-id="left-abcdef"] [data-action="delete"]').click()
  await new Promise(resolve => setTimeout(resolve, 10))
  const dialog = document.querySelector('dialog')
  assert.match(dialog.textContent, /手動同名/)
  assert.match(dialog.textContent, /bank\.test\/rates/)
  assert.match(dialog.textContent, /#.+確定|#.+此操作/)
  dialog.querySelector('[data-action="cancel"]').click()

  const report = await import('../src/ui/report/report.js?r19=' + Math.random())
  await report.renderFilters()
  const labels = [...document.querySelectorAll('#filter-tasks label')].map(label => label.textContent)
  const parents = labels.filter(label => label.includes('bank.test/rates') && label.includes('手動同名'))
  assert.equal(parents.length, 2)
  assert.notEqual(parents[0], parents[1])
  assert.ok(parents.every(label => /#[a-z0-9-]+/i.test(label)))

  const layout = await import('../src/shared/layout-store.js?r19=' + Math.random())
  const dashId = (await layout.getLayout()).dashboards[0].id
  const card = await layout.addCard(dashId, { type: 'line', x: 0, y: 0, w: 4, h: 2, source: [], options: {} })
  const drawer = await import('../src/ui/report/drawer.js?r19=' + Math.random())
  await drawer.openDrawer(dashId, card.id)
  const drawerLabels = [...document.querySelectorAll('#drawer-sources [data-source-checkbox]')]
    .map(input => input.closest('label')?.textContent || input.parentElement.textContent)
    .filter(label => label.includes('bank.test/rates'))
  assert.equal(drawerLabels.length, 2)
  assert.notEqual(drawerLabels[0], drawerLabels[1])
  assert.ok(drawerLabels.every(label => /#[a-z0-9-]+/i.test(label)))
  drawer.closeDrawer?.()
  jd.window.close()
})

test('R19 popup keeps original names and stable source/id identities after reorder', async () => {
  const { storage } = await setupStorage()
  await storage.saveTasks(tasks)
  setupDom(popupHtml, 'chrome-extension://af/ui/popup/popup.html')
  const popup = await import('../src/ui/popup/popup.js?r19=' + Math.random())
  const render = list => popup.render({ health: { level: 'green', summary: '' }, tasks: list,
    lastValues: {}, nextRuns: {}, healthMap: {} })
  render(tasks)
  const before = new Map([...document.querySelectorAll('#task-list .task-row')].map(row => [
    row.dataset.taskId, row.querySelector('.task-source').textContent
  ]))
  assert.match(document.querySelector('[data-task-id="left-abcdef"] .task-name').textContent, /^手動同名$/)
  assert.notEqual(before.get('left-abcdef'), before.get('right-abcdef'))
  render([...tasks].reverse())
  for (const [id, label] of before) assert.equal(document.querySelector(`[data-task-id="${id}"] .task-source`).textContent, label)
})

test('R19 readable exports identify duplicate tasks while preserving machine task ids and settings round-trip', async () => {
  const { storage } = await setupStorage()
  await storage.saveTasks(tasks)
  await storage.appendRecord('2026-09-22', {
    taskId: tasks[0].id, slot: '2026-09-22T09:00', capturedAt: '2026-09-22T01:00:00.000Z', value: 12, raw: '12', status: 'ok'
  })
  await storage.appendRecord('2026-09-22', {
    taskId: tasks[1].id, slot: '2026-09-22T09:00', capturedAt: '2026-09-22T01:00:00.000Z', value: 13, raw: '13', status: 'ok'
  })
  const settings = await import('../src/shared/settings-io.js?r19=' + Math.random())
  const machineJson = await settings.exportSettings()
  resetChromeMock()
  installChromeMock()
  const storage2 = await import('../src/shared/storage.js?r19-import=' + Math.random())
  await storage2.init()
  const settings2 = await import('../src/shared/settings-io.js?r19-import=' + Math.random())
  await settings2.importSettings(machineJson)
  assert.deepEqual((await storage2.getTasks()).map(item => item.id).sort(), tasks.map(item => item.id).sort())

  await storage2.appendRecord('2026-09-22', {
    taskId: tasks[0].id, slot: '2026-09-22T09:00', capturedAt: '2026-09-22T01:00:00.000Z', value: 12, raw: '12', status: 'ok'
  })
  await storage2.appendRecord('2026-09-22', {
    taskId: tasks[1].id, slot: '2026-09-22T09:00', capturedAt: '2026-09-22T01:00:00.000Z', value: 13, raw: '13', status: 'ok'
  })
  setupDom('<!doctype html><body></body>')
  const exporter = await import('../src/shared/export.js?r19=' + Math.random())
  const csv = await exporter.buildExport({ from: '2026-09-22', to: '2026-09-22', format: 'csv' })
  assert.match(csv.content, /left-abcdef,手動同名 · #.+ · bank\.test\/rates,12/)
  assert.match(csv.content, /right-abcdef,手動同名 · #.+ · bank\.test\/rates,13/)
  assert.doesNotMatch(csv.content, /credential=/)
  const json = JSON.parse((await exporter.buildExport({ from: '2026-09-22', to: '2026-09-22', format: 'json' })).content)
  assert.ok(json.tasks['left-abcdef'])
  assert.ok(json.tasks['right-abcdef'])
  assert.match(json.tasks['left-abcdef'].name, /bank\.test\/rates/)
  const html = await exporter.buildExport({ from: '2026-09-22', to: '2026-09-22', format: 'html' })
  assert.match(html.content, /手動同名 · #.+ · bank\.test\/rates/)
  const htmlDoc = new JSDOM(html.content)
  const readableRows = [...htmlDoc.window.document.querySelectorAll('.report-table tbody tr')].map(row => row.children[1].textContent)
  assert.equal(new Set(readableRows).size, 2)
})

test('R19 OS failure notification distinguishes same-name same-source tasks and omits URL secrets', async () => {
  const { c, storage } = await setupStorage()
  await storage.saveTasks(tasks)
  const notify = await import('../src/background/notify.js?r19=' + Math.random())
  await notify.notifySiteFailure('https://bank.test', tasks[0], 'not_found', { nowMs: Date.now() })
  await notify.notifySiteFailure('https://bank.test', tasks[1], 'not_found', { nowMs: Date.now() + 1 })
  const call = c.__calls.filter(item => item.api === 'notifications.create').at(-1)
  const options = typeof call.args[0] === 'string' ? call.args[1] : call.args[0]
  assert.match(options.message, /手動同名 · #[a-z0-9-]+ · bank\.test\/rates/)
  assert.equal((options.message.match(/手動同名 · #[a-z0-9-]+ · bank\.test\/rates/g) || []).length, 2)
  assert.doesNotMatch(options.message, /credential=/)
  assert.equal(call.args[0], 'fail:https://bank.test', 'OS notification id semantics stay unchanged')
})
