import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

test('AF-22 saved task Edit opens the picker in the click gesture and publishes its edit context', async () => {
  resetChromeMock()
  const c = installChromeMock()
  c.__setCurrentTab({ id: 42, url: 'chrome-extension://af/ui/report/report.html' })
  const dom = new JSDOM(reportHtml, { url: 'chrome-extension://af/ui/report/report.html' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const storage = await import('../src/shared/storage.js')
  await storage.init()
  const taskUi = await import('../src/ui/report/tasks.js?g1-edit-gesture=' + Math.random())

  taskUi.renderTasks([{
    id: 'saved-multi-task', name: 'Saved multi', url: 'https://a.test/prices', mode: 'multi',
    enabled: true, fields: [{ key: 'field-a', name: 'Price A' }, { key: 'field-b', name: 'Price B' }],
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  }], {}, [])
  c.__blockSetOptionsUntilOpen(true)
  const button = document.querySelector('[data-task-id="saved-multi-task"] [data-action="edit"]')
  assert.ok(button)
  button.click()
  assert.ok(c.__calls.some(call => call.api === 'sidePanel.open'), 'open is issued synchronously in the button gesture')
  await new Promise(resolve => setTimeout(resolve, 20))

  const calls = c.__calls
  const openIndex = calls.findIndex(call => call.api === 'sidePanel.open')
  assert.notEqual(openIndex, -1, 'Edit should open a side panel instead of a fallback popup')
  assert.equal(calls[openIndex].args[0].tabId, 42)
  assert.equal(c.__openPanels().includes(42), true)
  assert.deepEqual(await storage.getPanelCtx(42), { kind: 'edit', taskId: 'saved-multi-task' })
  assert.equal(calls.some(call => call.api === 'windows.create'), false)
  dom.window.close()
})
