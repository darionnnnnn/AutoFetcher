process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

let serial = 0

async function setup() {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.runtime.id = 'af23-b4-test'
  const storage = await import(`../src/shared/storage.js?af23-b4-${++serial}`)
  await storage.init()
  for (const id of ['live-a', 'live-b']) {
    await storage.saveTask({ id, name: id, url: 'https://fixture.invalid', mode: 'number', enabled: true, spec: { strategy: 'text' } })
  }
  const dom = new JSDOM('<!doctype html><div id="layout-toast" hidden></div>', {
    url: 'chrome-extension://af23-b4-test/ui/report/report.html'
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const layout = await import('../src/shared/layout-store.js')
  const dashboard = await import(`../src/ui/report/dashboard.js?af23-b4-${serial}`)
  const initial = await layout.getLayout()
  const dashId = initial.dashboards[0].id
  await dashboard.renderDashboard(dashId)
  const card = await layout.addCard(dashId, {
    type: 'line', title: 'test', source: [{ taskId: 'live-a' }, { taskId: 'live-b' }], options: { period: 7 }
  })
  return { chrome, storage, layout, dashboard, dom, dashId, cardId: card.id }
}

async function removeBFromHistory(f) {
  const before = (await f.layout.getLayout()).dashboards
  await f.dashboard.pushHistory(before)
  await f.layout.updateCard(f.dashId, f.cardId, latest => ({
    source: latest.source.filter(source => source.taskId !== 'live-b')
  }))
}

async function sourceIds(f) {
  const layout = await f.layout.getLayout()
  return layout.dashboards.find(dash => dash.id === f.dashId).cards.find(card => card.id === f.cardId)?.source.map(source => source.taskId) || []
}

test('B4 undo rechecks live sources under layout lock after task deletion and prune', async t => {
  const f = await setup()
  t.after(() => { f.dom.window.close(); resetChromeMock() })
  await removeBFromHistory(f)

  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  let captureSnapshot
  const captured = new Promise(resolve => { captureSnapshot = resolve })
  let releaseSnapshot
  const gate = new Promise(resolve => { releaseSnapshot = resolve })
  let holdFirstTasksRead = true
  f.chrome.storage.local.get = async (keys, ...rest) => {
    const result = await realGet(keys, ...rest)
    if (holdFirstTasksRead && keys === 'tasks') {
      holdFirstTasksRead = false
      captureSnapshot()
      await gate
    }
    return result
  }

  const undoing = f.dashboard.undo()
  await captured
  // Delete and prune while undo is waiting on its live-source snapshot.
  const deleting = f.storage.deleteTask('live-b')
  let deleted = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const tasks = (await realGet('tasks')).tasks || []
    if (!tasks.some(task => task.id === 'live-b')) { deleted = true; break }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(deleted, true, 'task deletion commits before it waits for the layout prune lock')
  releaseSnapshot()
  await Promise.all([undoing, deleting])

  assert.deepEqual(await sourceIds(f), ['live-a'], 'a source pruned before undo writes must stay absent')
  assert.equal(f.dashboard.historySize(), 0, 'the completed undo consumes exactly one step')
  await f.dashboard.redo()
  assert.deepEqual(await sourceIds(f), ['live-a'], 'redo also must not restore the deleted source')
})

test('B4 failed task read or layout write preserves the undo step for retry', async t => {
  const f = await setup()
  t.after(() => { f.dom.window.close(); resetChromeMock() })
  await removeBFromHistory(f)

  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  let failTaskRead = true
  const getWithControlledFailure = async (keys, ...rest) => {
    if (failTaskRead && keys === 'tasks') {
      failTaskRead = false
      throw new Error('controlled tasks read failure')
    }
    return realGet(keys, ...rest)
  }
  f.chrome.storage.local.get = getWithControlledFailure
  await f.dashboard.undo()
  assert.equal(f.dashboard.historySize(), 1, 'live-source read failure must not consume undo')
  assert.deepEqual(await sourceIds(f), ['live-a'])

  f.chrome.storage.local.get = realGet
  const realSet = f.chrome.storage.local.set.bind(f.chrome.storage.local)
  let failLayoutWrite = true
  f.chrome.storage.local.set = async values => {
    if (failLayoutWrite && values && Object.hasOwn(values, 'layout')) {
      failLayoutWrite = false
      throw new Error('controlled layout write failure')
    }
    return realSet(values)
  }
  await f.dashboard.undo()
  assert.equal(f.dashboard.historySize(), 1, 'layout write failure must not consume undo')
  assert.deepEqual(await sourceIds(f), ['live-a'])

  f.chrome.storage.local.set = realSet
  await f.dashboard.undo()
  assert.deepEqual(await sourceIds(f), ['live-a', 'live-b'], 'retry applies the undo once sources remain live')
  assert.equal(f.dashboard.historySize(), 0)

  failTaskRead = true
  f.chrome.storage.local.get = getWithControlledFailure
  await f.dashboard.redo()
  f.chrome.storage.local.get = realGet
  assert.deepEqual(await sourceIds(f), ['live-a', 'live-b'], 'failed redo leaves the layout unchanged')
  failTaskRead = false
  await f.dashboard.redo()
  assert.deepEqual(await sourceIds(f), ['live-a'], 'successful undo remains redoable')
  assert.equal(f.dashboard.historySize(), 1)
})

test('B4 repeated undo while a live-source check is pending cannot consume a second step', async t => {
  const f = await setup()
  t.after(() => { f.dom.window.close(); resetChromeMock() })
  await removeBFromHistory(f)
  // Add a second undo step so duplicate input would otherwise consume it too.
  const withBRemoved = (await f.layout.getLayout()).dashboards
  await f.dashboard.pushHistory(withBRemoved)
  await f.layout.updateCard(f.dashId, f.cardId, latest => ({ options: { ...latest.options, period: 14 } }))

  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  let reached
  const entered = new Promise(resolve => { reached = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let hold = true
  f.chrome.storage.local.get = async (keys, ...rest) => {
    const result = await realGet(keys, ...rest)
    if (hold && keys === 'tasks') {
      hold = false
      reached()
      await gate
    }
    return result
  }
  const first = f.dashboard.undo()
  await entered
  await f.dashboard.undo()
  assert.equal(f.dashboard.historySize(), 2, 'second undo is ignored while first is in flight')
  release()
  await first
  assert.equal(f.dashboard.historySize(), 1, 'one in-flight undo consumes only its own step')
  assert.equal((await f.layout.getLayout()).dashboards[0].cards.find(card => card.id === f.cardId).options.period, 7)
})

test('B4 an edit recorded during pending undo keeps its own step and does not expose stale redo', async t => {
  const f = await setup()
  t.after(() => { f.dom.window.close(); resetChromeMock() })
  await removeBFromHistory(f)

  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  let reached
  const entered = new Promise(resolve => { reached = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let hold = true
  f.chrome.storage.local.get = async (keys, ...rest) => {
    const result = await realGet(keys, ...rest)
    if (hold && keys === 'tasks') {
      hold = false
      reached()
      await gate
    }
    return result
  }

  const undoing = f.dashboard.undo()
  await entered
  const concurrentSnapshot = (await f.layout.getLayout()).dashboards
  await f.dashboard.pushHistory(concurrentSnapshot)
  assert.equal(f.dashboard.historySize(), 2, 'concurrent operation records its own pending step')
  release()
  await undoing

  assert.equal(f.dashboard.historySize(), 1, 'completion removes the selected step by identity, not the new top step')
  assert.deepEqual(await sourceIds(f), ['live-a', 'live-b'])
  await f.dashboard.redo()
  assert.deepEqual(await sourceIds(f), ['live-a', 'live-b'], 'history revision change suppresses stale redo')
})

test('B4 completing undo after switching dashboard never moves the old step into the new dashboard history', async t => {
  const f = await setup()
  t.after(() => { f.dom.window.close(); resetChromeMock() })
  await removeBFromHistory(f)
  const other = await f.layout.addDashboard('另一個儀表板')
  const otherCard = await f.layout.addCard(other.id, {
    type: 'number', title: '另一頁卡片', source: [{ taskId: 'live-a' }], options: {}
  })

  const realGet = f.chrome.storage.local.get.bind(f.chrome.storage.local)
  let reached
  const entered = new Promise(resolve => { reached = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let hold = true
  f.chrome.storage.local.get = async (keys, ...rest) => {
    const result = await realGet(keys, ...rest)
    if (hold && keys === 'tasks') {
      hold = false
      reached()
      await gate
    }
    return result
  }

  const undoing = f.dashboard.undo()
  await entered
  await f.dashboard.renderDashboard(other.id)
  assert.equal(f.dashboard.historySize(), 0, 'dashboard switch clears history owned by the previous dashboard')
  release()
  await undoing

  assert.equal(f.dashboard.historySize(), 0)
  await f.dashboard.redo()
  const current = (await f.layout.getLayout()).dashboards.find(dash => dash.id === other.id)
  assert.deepEqual(current.cards.find(card => card.id === otherCard.id), otherCard, 'old undo step cannot affect the visible dashboard')
  assert.deepEqual(await sourceIds(f), ['live-a', 'live-b'], 'old undo step is not queued for redo on the new dashboard')
})
