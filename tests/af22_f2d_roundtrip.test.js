process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = css => ({ css, path: '', anchor: null, xpath: '' })

const multiTask = (over = {}) => ({
  id: 'roundtrip',
  name: '跨來源報價',
  url: 'https://a.test/quote',
  mode: 'multi',
  enabled: true,
  fields: [
    { key: 'price', name: '價格' },
    { key: 'label', name: '標籤' }
  ],
  spec: {
    mode: 'multi',
    fields: [
      {
        key: 'price',
        mode: 'number',
        source: { locator: locator('#price'), frame: { url: 'https://a.test/frame' } },
        spec: { strategy: 'auto' }
      },
      {
        key: 'label',
        mode: 'text',
        source: { locator: locator('#label'), frame: { url: 'https://b.test/embed' } },
        spec: { mode: 'text' }
      }
    ]
  },
  alerts: [
    { id: 'label-code', field: 'label', type: 'eq', value: '001', enabled: true }
  ],
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const storage = await import('../src/shared/storage.js?f2d=' + Math.random())
  await storage.init()
  const settings = await import('../src/shared/settings-io.js?f2d=' + Math.random())
  const layout = await import('../src/shared/layout-store.js?f2d=' + Math.random())
  return { storage, settings, layout }
}

test('F2d 設定匯出入實際 storage 往返保留 multi 每值 source/spec/key/文字告警', async () => {
  const { storage, settings, layout } = await fresh()
  const task = await storage.saveTask(multiTask())
  const dashId = (await layout.getLayout()).dashboards[0].id
  await layout.addCard(dashId, {
    type: 'table', x: 0, y: 0, w: 12, h: 4,
    source: [{ taskId: 'roundtrip#price' }, { taskId: 'roundtrip#label' }],
    options: { mode: 'pivot' }
  })
  await chrome.storage.session.set({ draft: { operationId: 'draft-only' }, operationId: 'runtime-only' })

  const json = await settings.exportSettings()
  const exported = JSON.parse(json)
  assert.equal(exported.data.schemaVersion, 4)
  assert.equal(exported.data.tasks[0].spec.fields[1].key, 'label')
  assert.equal(exported.data.tasks[0].spec.fields[1].source.frame.url, 'https://b.test/embed')
  assert.equal(exported.data.tasks[0].alerts[0].value, '001')
  assert.doesNotMatch(json, /operationId|draft-only|frameId/)

  resetChromeMock()
  installChromeMock()
  const storage2 = await import('../src/shared/storage.js?f2d=' + Math.random())
  await storage2.init()
  const settings2 = await import('../src/shared/settings-io.js?f2d=' + Math.random())
  await settings2.importSettings(json)
  const imported = await storage2.getTask('roundtrip')
  assert.deepEqual(imported.fields, task.fields)
  assert.deepEqual(imported.spec, task.spec)
  assert.deepEqual(imported.alerts, task.alerts)
  const layout2 = await import('../src/shared/layout-store.js?f2d=' + Math.random())
  const importedCards = (await layout2.getLayout()).dashboards[0].cards
  assert.deepEqual(importedCards[0].source.map(source => source.taskId), ['roundtrip#price', 'roundtrip#label'])
})

test('F2d 非法 multi 匯入整份原子拒絕，不寫入前面的合法任務', async () => {
  const { storage, settings } = await fresh()
  const existing = await storage.saveTask({
    id: 'existing', name: '既有', url: 'https://a.test/existing', mode: 'number', enabled: true,
    schedule: { type: 'daily', times: ['08:00'] }
  })
  const before = await chrome.storage.local.get(null)
  const incoming = multiTask({ name: '應被拒絕的合法前項' })
  const invalid = multiTask({ id: 'bad-multi', spec: { ...multiTask().spec, fields: [{
    ...multiTask().spec.fields[0], mode: 'unsupported'
  }, multiTask().spec.fields[1]] } })
  const payload = JSON.stringify({
    kind: 'autofetcher-settings',
    version: 1,
    data: { schemaVersion: 4, tasks: [incoming, invalid] }
  })

  await assert.rejects(() => settings.importSettings(payload), /multi|格式|mode/i)
  assert.deepEqual(await chrome.storage.local.get(null), before)
  assert.equal((await storage.getTask(existing.id)).name, '既有')
})

test('F2d JSON/CSV/HTML 報表保留前導零文字與子序列來源名稱', async () => {
  const { storage } = await fresh()
  await storage.saveTask(multiTask())
  await storage.appendRecord('2026-09-22', {
    taskId: 'roundtrip#price', slot: '2026-09-22T09:00', capturedAt: '2026-09-22T01:00:00.000Z',
    value: 12, raw: '12', status: 'ok'
  })
  await storage.appendRecord('2026-09-22', {
    taskId: 'roundtrip#label', slot: '2026-09-22T09:00', capturedAt: '2026-09-22T01:00:00.000Z',
    value: '001', raw: '001', status: 'ok'
  })
  const dom = new JSDOM('<!doctype html><body></body>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const ex = await import('../src/shared/export.js?f2d=' + Math.random())

  const json = await ex.buildExport({ from: '2026-09-22', to: '2026-09-22', format: 'json' })
  const day = JSON.parse(json.content)
  assert.equal(day.tasks['roundtrip#label'].name, '跨來源報價 · 標籤')
  assert.equal(day.tasks['roundtrip#label'].records[0].value, '001')

  const csv = await ex.buildExport({ from: '2026-09-22', to: '2026-09-22', format: 'csv' })
  assert.match(csv.content, /roundtrip#label,跨來源報價 · 標籤,001,001,ok/)

  const html = await ex.buildExport({ from: '2026-09-22', to: '2026-09-22', format: 'html' })
  const report = new JSDOM(html.content)
  assert.match(report.window.document.body.textContent, /跨來源報價 · 標籤/)
  assert.match(report.window.document.body.textContent, /001/)
  assert.doesNotMatch(html.content, /frameId|operationId|\bmulti\b/)
})
