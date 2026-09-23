// AF-22 R15 same-site queue-delay acceptance probe (Node/chrome-mock, no browser).
// Run with: node tests/smoke/af22_r15_queue_delay.mjs
import assert from 'node:assert/strict'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { installChromeMock, resetChromeMock } from '../chrome-mock.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const timed = (start, end) => +(end - start).toFixed(2)

resetChromeMock()
const chromeMock = installChromeMock()
const suffix = `${Date.now()}-${Math.random()}`
const storage = await import(`../../src/shared/storage.js?r15queue=${suffix}`)
await storage.init()
await storage.saveSettings({ fetchTabMode: 'window' })
const fetchTabs = await import(`../../src/background/fetch-tab.js?r15queue=${suffix}`)

const origin = 'https://r15-queue.fixture.test'
const url = `${origin}/fixture`
const aGate = deferred()
const aEntered = deferred()
const aReady = deferred()
const events = {}
let active = 0
let maxActive = 0
const job = (name, gate = null) => {
  events[`${name}Arrival`] = performance.now()
  return fetchTabs.enqueueForOrigin(origin, async holder => {
    events[`${name}Start`] = performance.now()
    active++
    maxActive = Math.max(maxActive, active)
    try {
      await fetchTabs.acquireFetchTab(holder, url, { pollMs: 1, loadTimeoutMs: 100 })
      if (name === 'A') {
        aEntered.resolve()
        aReady.resolve()
      }
      if (gate) await gate
      else await wait(15)
      events[`${name}Complete`] = performance.now()
      return name
    } finally {
      active--
    }
  })
}

let resultA, resultB
try {
  const a = job('A', aGate.promise)
  await Promise.race([aEntered.promise, wait(5000).then(() => { throw new Error('task A did not start') })])
  await aReady.promise
  const b = job('B')
  // Ensure B has arrived while A is deliberately held inside its work phase.
  await wait(30)
  assert.equal(events.BStart, undefined, 'second task must wait while first is held')
  aGate.resolve()
  ;[resultA, resultB] = await Promise.race([
    Promise.all([a, b]),
    wait(5000).then(() => { throw new Error('same-site queue did not drain within 5s') })
  ])

  assert.deepEqual([resultA, resultB], ['A', 'B'])
  assert.ok(events.BStart >= events.AComplete, 'B must start only after A completes')
  assert.equal(maxActive, 1, 'same-site tasks must never overlap')
  assert.ok(events.BStart - events.BArrival < 5000, 'B must not starve')
  assert.equal(active, 0, 'all job bodies must finish')
  const registry = (await chromeMock.storage.session.get('fetchTabs')).fetchTabs || []
  assert.deepEqual(registry, [], 'queue cleanup must release and unregister its fetch tab')
  assert.equal(chromeMock.__calls.filter(call => call.api === 'windows.remove').length, 1,
    'queue cleanup must close the one owned fetch window')

  const evidence = {
    status: 'PASS',
    runtime: { node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, logicalCpus: os.cpus().length },
    environment: 'Node chrome-mock; no real browser/network or pre-AF22 baseline',
    tasks: ['A', 'B'].map(name => ({
      name,
      arrivalToStartMs: timed(events[`${name}Arrival`], events[`${name}Start`]),
      executionMs: timed(events[`${name}Start`], events[`${name}Complete`]),
      arrivalToCompletionMs: timed(events[`${name}Arrival`], events[`${name}Complete`])
    })),
    ordering: { secondStartsAfterFirstCompletes: true, maxConcurrent: maxActive },
    cleanup: { registryEntries: registry.length, ownedWindowsClosed: 1 }
  }
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  aGate.resolve()
}
