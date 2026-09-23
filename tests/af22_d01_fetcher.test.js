process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = css => ({ css, path: '', anchor: null, xpath: '' })
const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200, frameTimeoutMs: 30, reviveDelaysMs: [] }
const fixture = readFileSync(new URL('./fixtures/af22-d01.html', import.meta.url), 'utf8')

function task(over = {}) {
  return {
    id: 'd01', name: '互斥頁籤', url: 'https://a.test/page', mode: 'multi', enabled: true,
    fields: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }],
    spec: { mode: 'multi', fields: [
      { key: 'a', mode: 'text', source: { locator: locator('#value-a') }, spec: { mode: 'text' }, stateActions: [] },
      { key: 'b', mode: 'text', source: { locator: locator('#value-b') }, spec: { mode: 'text' }, stateActions: [{ type: 'click', locator: locator('#tab-b') }] }
    ] },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ...over
  }
}

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const storage = await import('../src/shared/storage.js?d01=' + Math.random())
  await storage.init()
  const fetcher = await import('../src/background/fetcher.js?d01=' + Math.random())
  return { c, storage, fetcher }
}

test('D01 representative tab fixture replays with existing click/waitFor action core', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const dom = new JSDOM(fixture, { runScripts: 'dangerously', url: 'https://a.test/page' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.PointerEvent = dom.window.PointerEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?d01=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  const run = actions => new Promise(resolve => listener({ type: 'RUN_PRE_ACTIONS', actions }, {}, resolve))

  const result = await run([
    { type: 'click', locator: locator('#tab-b') },
    { type: 'waitFor', locator: locator('#value-b'), timeoutMs: 20 }
  ])
  assert.equal(result.ok, true)
  assert.equal(document.getElementById('panel-a').hidden, true)
  assert.equal(document.getElementById('panel-b').hidden, false)
})

test('D01 virtual-list fixture scrolls its container before waiting for an unrendered row', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const dom = new JSDOM(fixture, { runScripts: 'dangerously', url: 'https://a.test/page' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.PointerEvent = dom.window.PointerEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?d01=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  const result = await new Promise(resolve => listener({ type: 'RUN_PRE_ACTIONS', actions: [
    { type: 'scroll', locator: locator('#virtual-list'), top: 400 },
    { type: 'waitFor', locator: locator('#virtual-row-4'), timeoutMs: 20 }
  ] }, {}, resolve))
  assert.equal(result.ok, true)
  assert.equal(document.getElementById('virtual-row-4')?.textContent, '第 4 列')
})

test('D01 scroll state action is valid only with a located container and bounded nonnegative position', async () => {
  const { validateMultiTask } = await import('../src/shared/task-source.js?d01=' + Math.random())
  const input = task()
  input.spec.fields[1].stateActions = [{ type: 'scroll', locator: locator('#virtual-list'), top: 400 }]
  assert.equal(validateMultiTask(input), undefined)
  input.spec.fields[1].stateActions[0].top = -1
  assert.throws(() => validateMultiTask(input), /scroll 必須有非負 top/)
})

test('D01 executes each source state action in selected order, then extracts that source', async () => {
  const { c, storage, fetcher } = await fresh()
  c.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/page' }])
  let active = 'a'
  const sequence = []
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RESOLVE_LOCATOR') return { ok: true, found: true }
    if (msg.type === 'RUN_PRE_ACTIONS') {
      sequence.push(`state:${msg.actions[0].locator.css}`)
      active = 'b'
      return { ok: true }
    }
    if (msg.type === 'EXTRACT') {
      sequence.push(`extract:${msg.locator.css}`)
      const key = msg.locator.css === '#value-a' ? 'a' : 'b'
      return { ok: true, value: `${key}-${active}`, raw: `${key}-${active}`, status: 'ok' }
    }
    return { ok: true }
  })
  const input = task()
  await storage.saveTask(input)
  const result = await fetcher.runTask(input, { slot: '2026-09-22T09:00', attempt: 3, ...FAST })
  assert.deepEqual(sequence, ['extract:#value-a', 'state:#tab-b', 'extract:#value-b'])
  assert.equal(result.taskId, 'd01#a')
})

test('D01 failed source state action marks that value failed and proceeds to later sources', async () => {
  const { c, storage, fetcher } = await fresh()
  c.__setScriptResponder(() => [{ frameId: 0, result: 'https://a.test/page' }])
  const seen = []
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RESOLVE_LOCATOR') return { ok: true, found: true }
    if (msg.type === 'RUN_PRE_ACTIONS') {
      seen.push('state-failed')
      return { ok: false, error: 'preaction_not_found' }
    }
    if (msg.type === 'EXTRACT') {
      seen.push(msg.locator.css)
      return { ok: true, value: 'ready', raw: 'ready', status: 'ok' }
    }
    return { ok: true }
  })
  const input = task({
    fields: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }, { key: 'c', name: 'C' }],
    spec: { mode: 'multi', fields: [
      { key: 'a', mode: 'text', source: { locator: locator('#value-a') }, spec: { mode: 'text' } },
      { key: 'b', mode: 'text', source: { locator: locator('#never') }, spec: { mode: 'text' }, stateActions: [{ type: 'click', locator: locator('#missing-tab') }] },
      { key: 'c', mode: 'text', source: { locator: locator('#value-c') }, spec: { mode: 'text' } }
    ] }
  })
  await storage.saveTask(input)
  const result = await fetcher.runTask(input, { slot: '2026-09-22T10:00', attempt: 3, ...FAST })
  const records = await storage.getRecordsByDate('2026-09-22')
  assert.deepEqual(seen, ['#value-a', 'state-failed', '#value-c'])
  assert.equal(records.length, 3)
  assert.equal(records.find(record => record.taskId === 'd01#b').status, 'error')
  assert.equal(records.find(record => record.taskId === 'd01#a').status, 'ok')
  assert.equal(records.find(record => record.taskId === 'd01#c').status, 'ok')
})

test('D01 state action duration and selected source order belong to execution identity', async () => {
  const { fetcher } = await fresh()
  const one = task()
  one.spec.fields[1].stateActions = [
    { type: 'wait', sec: 2 },
    { type: 'click', locator: locator('#tab-b') }
  ]
  assert.equal(fetcher.runBudgetMsOf(one, { baseMs: 100, maxMs: 100000 }), 22100)
  const reordered = structuredClone(one)
  reordered.spec.fields.reverse()
  reordered.fields.reverse()
  const { multiExecutionSnapshot, changedExecutionSeriesOf } = await import('../src/shared/task-source.js?d01=' + Math.random())
  assert.notEqual(multiExecutionSnapshot(one), multiExecutionSnapshot(reordered))
  assert.deepEqual(changedExecutionSeriesOf(one, reordered), ['a', 'b'])
  const changedAction = structuredClone(one)
  changedAction.spec.fields[1].stateActions[1].locator.css = '#tab-a'
  assert.deepEqual(changedExecutionSeriesOf(one, changedAction), ['b'])
  const scrollBudget = structuredClone(one)
  scrollBudget.spec.fields[1].stateActions = [{ type: 'scroll', locator: locator('#virtual-list'), top: 400 }]
  assert.equal(fetcher.runBudgetMsOf(scrollBudget, { baseMs: 100, maxMs: 100000 }), 20100)
})
