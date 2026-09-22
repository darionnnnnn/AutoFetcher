// AF-22 F1a：完成 snapshot 後進設定表單，並由表單建立 multi task。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

function draftBegin(tabId) {
  return {
    type: 'PICK_DRAFT_BEGIN',
    sessionId: 'f1a-session',
    tabId,
    documentGeneration: 'doc-f1a',
    routeIdentity: { path: '/prices', dataset: 'live' },
    groups: [{ key: 'g1', name: '跨來源價格', values: [] }],
    activeGroupKey: 'g1',
    stage: 'selecting',
    form: {}
  }
}

test('F1a 實際完成訊息把 snapshot 寫成設定 ctx，表單與 buildTask 保留兩來源及數字／文字型別', async () => {
  resetChromeMock()
  const chromeMock = installChromeMock()
  const tab = await chrome.tabs.create({ url: 'https://a.test/prices' })
  const bg = await import('../src/background/main.js?f1a=' + Math.random())
  const extensionSender = { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }
  const begin = await bg.handleMessage(draftBegin(tab.id), extensionSender)
  assert.equal(begin.ok, true)

  const values = [
    {
      key: 'price-key', name: '現價', mode: 'number',
      source: { locator: { css: '#price' } },
      spec: { strategy: 'auto' }
    },
    {
      key: 'label-key', name: '名稱', mode: 'text',
      source: { locator: { css: '#label' }, frame: { url: 'https://b.test/embed' } },
      spec: { mode: 'text', strategy: 'auto', attr: 'textContent' }
    }
  ]
  const added = await bg.handleMessage({
    type: 'PICK_DRAFT_OPERATION', sessionId: 'f1a-session', tabId: tab.id,
    operationId: 'f1a-add', expectedRevision: 0,
    operation: { type: 'add', groupKey: 'g1', value: values[0] }
  }, extensionSender)
  assert.equal(added.ok, true)
  const added2 = await bg.handleMessage({
    type: 'PICK_DRAFT_OPERATION', sessionId: 'f1a-session', tabId: tab.id,
    operationId: 'f1a-add-2', expectedRevision: 1,
    operation: { type: 'add', groupKey: 'g1', value: values[1] }
  }, extensionSender)
  assert.equal(added2.ok, true)

  const completed = await bg.handleMessage({
    type: 'PICK_DRAFT_COMPLETE', sessionId: 'f1a-session', tabId: tab.id,
    documentGeneration: 'doc-f1a', routeIdentity: { path: '/prices', dataset: 'live' },
    expectedRevision: 2
  }, extensionSender)
  assert.equal(completed.ok, true)
  assert.equal(completed.synchronized, true)
  assert.equal(completed.context.fields.length, 2)
  assert.deepEqual(completed.context.fields.map(field => ({
    key: field.key, name: field.name, mode: field.mode, source: field.source, spec: field.spec
  })), values)

  const savedCtx = await (await import('../src/shared/storage.js?f1a=' + Math.random())).getPanelCtx(tab.id)
  assert.equal(savedCtx.kind, 'new')
  assert.equal(savedCtx.ctx.fields[1].source.frame.url, 'https://b.test/embed')

  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f1a=' + Math.random())
  picker.render(completed.context)
  document.getElementById('name').value = '跨來源價格'
  const form = picker.getFormData()
  assert.equal(form.multi, true)
  assert.deepEqual(form.fields.map(field => ({ key: field.key, name: field.name, mode: field.mode, source: field.source })), values.map(({ spec, ...value }) => value))

  const task = picker.buildTask(form, completed.context.locator, null, completed.context.frame)
  assert.equal(task.mode, 'multi')
  assert.equal(task.spec.mode, 'multi')
  assert.deepEqual(task.fields, values.map(({ mode, source, spec, ...field }) => field))
  assert.deepEqual(task.spec.fields, values)
})

test('F1a buildTask 舊單值與舊同表多值仍維持原格式', async () => {
  resetChromeMock()
  installChromeMock()
  const picker = await import('../src/ui/picker/picker.js?f1a-legacy=' + Math.random())
  const single = picker.buildTask({
    name: '舊單值', url: 'https://a.test', mode: 'number', strategy: 'auto',
    scheduleType: 'daily', times: ['09:30'], weekdays: [1], alerts: [], preActions: []
  }, { css: '#value' })
  assert.equal(single.mode, 'number')
  assert.equal(single.spec.mode, undefined)

  const legacyBlock = picker.buildTask({
    name: '舊多值', url: 'https://a.test', mode: 'block', strategy: 'auto',
    scheduleType: 'daily', times: ['09:30'], weekdays: [1],
    fields: [{ key: 'v1', name: '欄一', block: { axis: 'col', index: 1 } }],
    alerts: [], preActions: []
  }, { css: '#table' })
  assert.equal(legacyBlock.mode, 'block')
  assert.equal(legacyBlock.spec.mode, 'block')
  assert.equal(legacyBlock.spec.fields[0].key, 'v1')
})

test('F1a multi 不改共用 controls 時逐值保留不同 block skip／exclude／inner／pos／aggregate', async () => {
  resetChromeMock()
  installChromeMock()
  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f1a-blocks=' + Math.random())
  const fields = [
    {
      key: 'table-a', name: 'A 合計', mode: 'block',
      source: { locator: { css: '#a' } },
      spec: {
        mode: 'block',
        block: {
          axis: 'col', index: 1, aggregate: 'sum', pos: 'first',
          skip: { head: 1, blank: true },
          exclude: [{ index: 4, header: '小計' }],
          inner: [{ tag: 'span', index: 1 }]
        }
      }
    },
    {
      key: 'table-b', name: 'B 平均', mode: 'block',
      source: { locator: { css: '#b' }, frame: { url: 'https://b.test/embed' } },
      spec: {
        mode: 'block',
        block: {
          axis: 'row', index: 2, aggregate: 'avg', pos: 'last-1',
          skip: { tail: 2 },
          exclude: [{ index: 8, header: '備註' }],
          inner: [{ tag: 'strong', index: 2 }]
        }
      }
    }
  ]
  const ctx = {
    tabId: 1, url: 'https://a.test/page',
    locator: fields[0].source.locator,
    picks: fields.map(field => field.spec),
    fields
  }
  picker.render(ctx)
  const form = picker.getFormData()
  const task = picker.buildTask({ ...form, name: '兩張表', url: ctx.url }, ctx.locator)
  assert.deepEqual(task.spec.fields, fields)

  // 一旦使用者真的改共用控制項，畫面明確把該值套用到所有適用 block。
  document.getElementById('block-aggregate').value = 'count'
  const changed = picker.buildTask(picker.getFormData(), ctx.locator)
  assert.equal(changed.spec.fields.every(field => field.spec.block.aggregate === 'count'), true)
  assert.deepEqual(changed.spec.fields.map(field => ({
    skip: field.spec.block.skip,
    exclude: field.spec.block.exclude,
    inner: field.spec.block.inner,
    pos: field.spec.block.pos
  })), fields.map(field => ({
    skip: field.spec.block.skip,
    exclude: field.spec.block.exclude,
    inner: field.spec.block.inner,
    pos: field.spec.block.pos
  })))
})

test('F1a 只改 aggregate 時混合 cell／block 不會把 cell spec 寫成 undefined', async () => {
  resetChromeMock()
  installChromeMock()
  const dom = new JSDOM(html)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  const picker = await import('../src/ui/picker/picker.js?f1a-cell-block=' + Math.random())
  const fields = [
    {
      key: 'cell-value', name: '單格', mode: 'block',
      source: { locator: { css: '#cell' } },
      spec: { mode: 'block', cell: { row: { index: 1 }, col: { index: 2, pos: 'last' }, inner: [{ tag: 'span', index: 1 }] } }
    },
    {
      key: 'block-value', name: '整欄', mode: 'block',
      source: { locator: { css: '#block' } },
      spec: { mode: 'block', block: { axis: 'col', index: 3, aggregate: 'avg', skip: { tail: 2 }, exclude: [{ index: 5, header: '小計' }] } }
    }
  ]
  const ctx = { tabId: 1, url: 'https://a.test/page', locator: fields[0].source.locator, picks: fields.map(field => field.spec), fields }
  picker.render(ctx)
  document.getElementById('block-aggregate').value = 'count'
  const task = picker.buildTask(picker.getFormData(), ctx.locator)
  assert.deepEqual(task.spec.fields[0], fields[0])
  assert.equal(task.spec.fields[1].spec.block.aggregate, 'count')
  assert.deepEqual(task.spec.fields[1].spec.block.skip, fields[1].spec.block.skip)
  assert.deepEqual(task.spec.fields[1].spec.block.exclude, fields[1].spec.block.exclude)
})
