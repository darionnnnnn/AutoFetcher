import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { extractValue } from '../src/shared/extract.js'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = '<table id="prices"><tbody><tr><td>1</td><td>123</td></tr><tr><td>2</td><td>456</td></tr></tbody></table>'
const cell = { row: { index: 0 }, col: { index: 1 } }
const block = { axis: 'col', index: 1, aggregate: 'sum' }

test('AC-B2/C1: canonical cell/block 與既有規格精確擷取，原規格不變', () => {
  const dom = new JSDOM(html)
  const table = dom.window.document.querySelector('table')
  for (const [spec, expected] of [
    [{ cell }, 123],
    [{ mode: 'block', cell }, 123],
    [{ block }, 579],
    [{ mode: 'block', block: { cell } }, 123],
    [{ mode: 'block', block }, 579],
    [{ cell, multiplier: 0.1, decimals: 1 }, 12.3]
  ]) {
    const before = structuredClone(spec)
    assert.equal(extractValue(table, spec).value, expected)
    assert.deepEqual(spec, before)
  }
  const legacy = extractValue(table, { mode: 'block', fields: [{ key: 'price', cell }] })
  assert.equal(legacy.fields.price.value, 123)
  assert.equal(extractValue(table, { mode: 'text', cell }).value, '11232456', '明確文字模式保持原語意')
  assert.equal(extractValue(table.querySelector('td'), { strategy: 'auto' }).value, 1)
  dom.window.close()
})

test('AC-C1/F1: 真實 TEST_TASK 與 RUN_TASK 將 canonical 規格送進 extractor 並保存精確值', async t => {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM(html, { url: 'https://contract.test/' })
  globalThis.navigator = { onLine: true }
  t.after(() => { dom.window.close(); resetChromeMock() })
  const storage = await import('../src/shared/storage.js')
  await storage.init()
  const bg = await import('../src/background/main.js')
  const fields = [
    { key: 'price', name: '價格', mode: 'number', source: { locator: { css: '#prices' } }, spec: { cell } },
    { key: 'sum', name: '合計', mode: 'number', source: { locator: { css: '#prices' } }, spec: { block } }
  ]
  const task = { id: 'canonical-contract', name: '表格', url: 'https://contract.test/', enabled: true,
    mode: 'multi', fields: fields.map(({ key, name, mode }) => ({ key, name, mode })),
    spec: { mode: 'multi', fields } }
  await storage.saveTask(task)
  chrome.__setTabResponder((_id, message) => message.type === 'EXTRACT'
    ? { ...extractValue(dom.window.document.querySelector(message.locator.css), message.spec), layer: 'css' }
    : { ok: true })
  const sender = { url: 'chrome-extension://autofetcher/ui/picker/picker.html' }
  const opts = { pollMs: 1, loadTimeoutMs: 200, extractTimeoutMs: 200, extraDelayMs: 0 }
  const preview = await bg.handleMessage({ type: 'TEST_TASK', task }, sender, opts)
  assert.equal(preview.fields.price.value, 123)
  assert.equal(preview.fields.sum.value, 579)
  assert.equal((await storage.listDates()).length, 0, '預覽沒有正式歷史')
  const run = await bg.handleMessage({ type: 'RUN_TASK', taskId: task.id }, sender, opts)
  assert.deepEqual(run.values.map(item => item.value), [123, 579])
  const records = (await Promise.all((await storage.listDates()).map(date => storage.getRecordsByDate(date)))).flat()
  assert.equal(records.find(record => record.taskId === task.id + '#price').value, 123)
  assert.equal(records.find(record => record.taskId === task.id + '#sum').value, 579)
})
