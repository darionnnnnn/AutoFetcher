process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const fields = [
  { key: 'price', name: '價格', mode: 'number', source: { locator: { css: '#price' } }, spec: { strategy: 'auto' } },
  { key: 'label', name: '代碼', mode: 'text', source: { locator: { css: '#label' } }, spec: { mode: 'text' } }
]

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?r12=' + Math.random())
  return { picker, dom }
}

function multiTask(alerts) {
  return {
    id: 'r12-task', name: '文字與數字', url: 'https://a.test/data', mode: 'multi', enabled: true,
    fields: fields.map(({ key, name }) => ({ key, name })),
    spec: { mode: 'multi', fields },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    alerts
  }
}

test('R12 編輯文字等於保留 001，buildTask、匯出入與執行全鏈保留字串', async () => {
  const { picker } = await fresh()
  const original = multiTask([{ id: 'code-eq', field: 'label', type: 'eq', value: '001', enabled: true }])
  picker.render({ task: original, url: original.url })
  const alertRow = document.querySelector('[data-alert-row]')
  const valueInput = alertRow.querySelector('.alert-value')
  assert.equal(valueInput.type, 'text')
  assert.equal(valueInput.value, '001')
  const form = picker.getFormData()
  assert.equal(form.alerts[0].value, '001')
  assert.equal(picker.validateForm(form).ok, true)
  const built = picker.buildTask(form, undefined, original)
  assert.equal(built.alerts[0].value, '001')

  const storage = await import('../src/shared/storage.js?r12=' + Math.random())
  await storage.init()
  await storage.saveTask(built)
  const settings = await import('../src/shared/settings-io.js?r12=' + Math.random())
  const exported = await settings.exportSettings()
  assert.equal(JSON.parse(exported).data.tasks[0].alerts[0].value, '001')
  resetChromeMock()
  installChromeMock()
  const storage2 = await import('../src/shared/storage.js?r12=' + Math.random())
  await storage2.init()
  const settings2 = await import('../src/shared/settings-io.js?r12=' + Math.random())
  await settings2.importSettings(exported)
  const imported = await storage2.getTask('r12-task')
  assert.equal(imported.alerts[0].value, '001')
  const { evaluateAlerts } = await import('../src/shared/alerts.js')
  const result = evaluateAlerts(imported, {
    taskId: 'r12-task#label', status: 'ok', value: '001', capturedAt: '2026-09-23T09:30:00+08:00'
  }, [])
  assert.deepEqual(result.hits.map(hit => hit.alertId), ['code-eq'])
})

test('R12 文字欄位的大於條件在列內顯示錯誤並阻止儲存，數字門檻保持數值', async () => {
  const { picker } = await fresh()
  const task = multiTask([
    { id: 'bad-text-gt', field: 'label', type: 'gt', value: 5, enabled: true },
    { id: 'price-gt', field: 'price', type: 'gt', value: 5, enabled: true },
    { id: 'text-fail', field: 'label', type: 'failStreak', value: 3, enabled: true }
  ])
  picker.render({ task, url: task.url })
  const rows = [...document.querySelectorAll('[data-alert-row]')]
  assert.equal(rows[0].querySelector('[data-alert-error]').hidden, false)
  assert.match(rows[0].querySelector('[data-alert-error]').textContent, /文字值不支援/)
  assert.equal(rows[1].querySelector('[data-alert-error]').hidden, true)
  assert.equal(rows[2].querySelector('.alert-value').type, 'number')
  const form = picker.getFormData()
  assert.equal(form.alerts[1].value, 5)
  assert.equal(form.alerts[2].value, 3)
  assert.match(picker.validateForm(form).errors.alerts, /文字值只能使用/)
  const built = picker.buildTask(form, undefined, task)
  assert.deepEqual(built.alerts.map(alert => [alert.type, alert.value]), [['gt', 5], ['gt', 5], ['failStreak', 3]])
})
