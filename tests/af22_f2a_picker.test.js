import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const fields = [
  { key: 'price', name: '現價', mode: 'number', source: { locator: { css: '#price' }, frame: { url: 'https://a.test/frame' } }, spec: { strategy: 'auto' } },
  { key: 'label', name: '代碼', mode: 'text', source: { locator: { css: '#label' }, frame: { url: 'https://b.test/embed' } }, spec: { mode: 'text', strategy: 'auto' } }
]

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f2a=' + Math.random())
  const storage = await import('../src/shared/storage.js?f2a=' + Math.random())
  return { picker, storage }
}

function existingTask() {
  return {
    id: 'f2a-task', name: '報價', url: 'https://a.test/quote', mode: 'multi', enabled: false,
    fields: fields.map(({ key, name }) => ({ key, name })),
    spec: { mode: 'multi', fields: structuredClone(fields) },
    schedule: { type: 'daily', times: ['09:30'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    alerts: [{ id: 'label-eq', field: 'label', type: 'eq', value: '001', enabled: true }],
    foreground: true
  }
}

test('F2a 編輯 multi 保留每值 key/name/source/spec/alert，移除只影響選定來源', async () => {
  const { picker } = await fresh()
  const task = existingTask()
  picker.render({ task, url: task.url })
  let form = picker.getFormData()
  assert.deepEqual(form.fields.map(({ key, name, mode, source, spec }) => ({ key, name, mode, source, spec })), fields)
  assert.deepEqual(form.alerts, task.alerts)
  const unchanged = picker.buildTask(form, undefined, task)
  assert.equal(unchanged.mode, 'multi')
  assert.deepEqual(unchanged.spec.fields, fields)
  assert.deepEqual(unchanged.alerts, task.alerts)

  document.querySelector('[data-field-row][data-field-key="price"] [data-field-remove]').click()
  form = picker.getFormData()
  const edited = picker.buildTask(form, undefined, task)
  assert.deepEqual(edited.fields, [{ key: 'label', name: '代碼' }])
  assert.deepEqual(edited.spec.fields, [fields[1]])
  assert.deepEqual(edited.alerts, task.alerts)
  assert.equal(edited.enabled, false)
  assert.equal(edited.foreground, true)
})

test('F2a 拆成每值任務時各 batch item 保留原 field key、source、frame、mode 與 spec', async () => {
  const { picker, storage } = await fresh()
  picker.render({ tabId: 17, url: 'https://a.test/quote', fields: structuredClone(fields), picks: fields.map(field => field.spec) })
  const split = document.getElementById('split-tasks')
  assert.equal(split.hidden, false)
  await split.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  const ctx = await storage.getPanelCtx(17)
  assert.equal(ctx.kind, 'batch')
  assert.equal(ctx.items.length, 2)
  const actual = ctx.items.map(item => item.fields[0])
  assert.deepEqual(actual.map(({ key, name, mode, source, spec }) => ({ key, name, mode, source, spec })), fields)
})
