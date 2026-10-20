process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

async function mount(hash = '#view=settings&from=2026-10-20&to=2026-10-20') {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.runtime.id = 'af23-test'
  const storage = await import('../src/shared/storage.js')
  await storage.init()
  await storage.saveTask({ id: 't1', name: '任務一', url: 'https://x.test', mode: 'number', enabled: true, spec: { strategy: 'text' } })
  const page = new JSDOM(html, { url: `chrome-extension://af23-test/ui/report/report.html${hash}` })
  globalThis.window = page.window
  globalThis.document = page.window.document
  const report = await import('../src/ui/report/report.js')
  await delay(60)
  return { chrome, storage, report, doc: page.window.document, win: page.window }
}

function recordReadCount(chrome) {
  return chrome.__calls.filter(call => call.api === 'storage.local.get' && Array.isArray(call.args[0])
    && call.args[0].length >= 25 && call.args[0].some(key => /^rec2?:/.test(key))).length
}

function anyRecordBatchReadCount(chrome) {
  return chrome.__calls.filter(call => call.api === 'storage.local.get' && Array.isArray(call.args[0])
    && call.args[0].some(key => /^rec2?:/.test(key))).length
}

function taskStorageReadCount(chrome) {
  return chrome.__calls.filter(call => call.api === 'storage.local.get' && call.args[0] === 'tasks').length
}

test('設定頁啟動不讀歷史、不渲染隱藏表格或月曆', async () => {
  const { chrome, doc, win, storage, report } = await mount()
  assert.equal(anyRecordBatchReadCount(chrome), 0, JSON.stringify(chrome.__calls.filter(call => call.api === 'storage.local.get')))
  assert.equal(doc.querySelectorAll('#record-table tbody tr').length, 0)
  assert.equal(doc.querySelectorAll('#calendar table').length, 0)

  await storage.appendRecord('2026-10-20', { taskId: 't1', capturedAt: '2026-10-20T08:00:00.000Z', slot: '2026-10-20 08:00', value: 'A-only', status: 'success' })
  await storage.appendRecord('2026-10-21', { taskId: 't1', capturedAt: '2026-10-21T08:00:00.000Z', slot: '2026-10-21 08:00', value: 'B-only', status: 'success' })
  await delay(140) // 先讓 storage 訂閱防抖通知在設定頁消化，再開始計數
  chrome.__calls.length = 0

  const realGet = chrome.storage.local.get.bind(chrome.storage.local)
  let firstHeld = false
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  chrome.storage.local.get = async (keys, ...rest) => {
    const result = await realGet(keys, ...rest)
    if (!firstHeld && Array.isArray(keys) && keys.length >= 25 && keys.some(key => /^rec2?:/.test(key))) {
      firstHeld = true
      entered()
      await gate
    }
    return result
  }

  win.location.hash = '#view=history&from=2026-10-20&to=2026-10-20'
  const olderLoad = report.loadAndRenderPage(win.location.hash, { force: true })
  await enteredPromise
  win.location.hash = '#view=history&from=2026-10-21&to=2026-10-21'
  const latestLoad = report.loadAndRenderPage(win.location.hash, { force: true })
  await latestLoad
  await delay(240)
  const countAfterLatest = recordReadCount(chrome)
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /B-only/)
  release()
  await olderLoad
  await delay(80)
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /B-only/)
  assert.doesNotMatch(doc.querySelector('#record-table tbody')?.textContent || '', /A-only/)

  const keyword = doc.getElementById('filter-keyword')
  keyword.value = 'does-not-match'
  chrome.__calls.length = 0
  keyword.dispatchEvent(new win.Event('change', { bubbles: true }))
  await delay(240)
  assert.equal(recordReadCount(chrome), 0, `只改關鍵字沿用已載入的同範圍 raw records（先前範圍讀取 ${countAfterLatest} 次）`)
  assert.equal(taskStorageReadCount(chrome), 2, 'hashchange 對同一次篩選只執行一份 history loader 與一份狀態列讀取')

  const freshKeyword = doc.getElementById('filter-keyword')
  freshKeyword.value = ''
  freshKeyword.dispatchEvent(new win.Event('change', { bubbles: true }))
  await delay(80)
  await storage.appendRecord('2026-10-21', { taskId: 't1', capturedAt: '2026-10-21T09:00:00.000Z', slot: '2026-10-21 09:00', value: 'B2-only', status: 'success' })
  await delay(100)
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /B2-only/, '新增紀錄使範圍與月曆快取失效')
  const task = (await storage.getTasks()).find(item => item.id === 't1')
  await storage.saveTask({ ...task, name: '更新後任務名' })
  await delay(100)
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /更新後任務名/, '任務改名後重用紀錄並更新名稱')

  chrome.__calls.length = 0
  win.location.hash = '#view=settings&from=2026-10-21&to=2026-10-21'
  await delay(80)
  assert.equal(anyRecordBatchReadCount(chrome), 0, '切回設定不再載入歷史或容量統計')
})

test('其他頁面期間新增紀錄會失效歷史快取，返回歷史時讀到新資料', async () => {
  const { chrome, storage, win, doc, report } = await mount('#view=history&from=2026-10-13&to=2026-10-13')
  await storage.appendRecord('2026-10-13', { taskId: 't1', capturedAt: '2026-10-13T08:00:00.000Z', slot: '2026-10-13T08:00:00', value: 'before-switch', raw: 'before-switch', status: 'ok' })
  await delay(180)
  await report.loadAndRenderPage(win.location.hash, { force: true })
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /before-switch/)

  win.location.hash = '#view=settings&from=2026-10-13&to=2026-10-13'
  await report.loadAndRenderPage(win.location.hash, { force: true })
  await storage.appendRecord('2026-10-13', { taskId: 't1', capturedAt: '2026-10-13T09:00:00.000Z', slot: '2026-10-13T09:00:00', value: 'while-hidden', raw: 'while-hidden', status: 'ok' })
  await report.refreshCurrentView({ keys: new Set(['rec2:2026-10-13:09']), dates: new Set(['2026-10-13']) })
  assert.equal(doc.querySelector('#panel-history')?.hidden, true)

  win.location.hash = '#view=history&from=2026-10-13&to=2026-10-13'
  await report.loadAndRenderPage(win.location.hash, { force: true })
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /while-hidden/)
  assert.ok(recordReadCount(chrome) > 0, '返回時必須重讀失效範圍')
})

test('較新的歷史查詢完成後，較舊查詢的晚到錯誤不得覆寫畫面', async () => {
  // Keep these ranges distinct from earlier tests: report.js keeps a module-level
  // range cache, and mount() intentionally exercises the same module instance.
  const dateA = '2026-11-02'
  const dateB = '2026-11-03'
  const { chrome, storage, win, doc, report } = await mount()
  await storage.appendRecord(dateA, { taskId: 't1', capturedAt: `${dateA}T08:00:00.000Z`, slot: `${dateA}T08:00:00`, value: 'A-only', raw: 'A-only', status: 'ok' })
  await storage.appendRecord(dateB, { taskId: 't1', capturedAt: `${dateB}T08:00:00.000Z`, slot: `${dateB}T08:00:00`, value: 'B-only', raw: 'B-only', status: 'ok' })
  await delay(140)

  const realGet = chrome.storage.local.get.bind(chrome.storage.local)
  let held = false
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  chrome.storage.local.get = async (keys, ...rest) => {
    if (!held && Array.isArray(keys) && keys.includes(`rec2:${dateA}:00`)) {
      held = true
      entered()
      await gate
      throw new Error('late query A failure')
    }
    return realGet(keys, ...rest)
  }

  win.location.hash = `#view=history&from=${dateA}&to=${dateA}`
  const oldLoad = report.loadAndRenderPage(win.location.hash, { force: true })
  await enteredPromise
  win.location.hash = `#view=history&from=${dateB}&to=${dateB}`
  await report.loadAndRenderPage(win.location.hash, { force: true })
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /B-only/)
  const latestSummary = doc.querySelector('#summary tbody')?.textContent || ''
  assert.ok(latestSummary, 'latest query has a rendered summary')

  release()
  await oldLoad
  await delay(80)
  assert.match(doc.querySelector('#record-table tbody')?.textContent || '', /B-only/)
  assert.equal(doc.querySelector('#summary tbody')?.textContent || '', latestSummary, '舊請求不可改寫最新摘要')
  assert.doesNotMatch(doc.querySelector('#record-table tbody')?.textContent || '', /A-only/)
  assert.equal(doc.getElementById('history-load-error'), null, '舊請求的錯誤不可蓋掉最新查詢狀態')
})

test('比較日資料變更會刷新比較表，清除比較日會清掉舊列', async () => {
  const { storage, win, doc, report } = await mount('#view=history&from=2026-10-13&to=2026-10-13&compareTo=2026-10-12')
  await storage.appendRecord('2026-10-13', { taskId: 't1', capturedAt: '2026-10-13T08:00:00.000Z', slot: '2026-10-13T08:00:00', value: 'primary-value', raw: 'primary-value', status: 'ok' })
  await storage.appendRecord('2026-10-12', { taskId: 't1', capturedAt: '2026-10-12T08:00:00.000Z', slot: '2026-10-12T08:00:00', value: 'compare-before', raw: 'compare-before', status: 'ok' })
  await delay(120)
  await report.loadAndRenderPage(win.location.hash, { force: true })
  assert.match(doc.querySelector('#compare-table tbody')?.textContent || '', /compare-before/)

  await storage.appendRecord('2026-10-12', { taskId: 't1', capturedAt: '2026-10-12T09:00:00.000Z', slot: '2026-10-12T09:00:00', value: 'compare-after', raw: 'compare-after', status: 'ok' })
  await report.refreshCurrentView({ keys: new Set(['rec2:2026-10-12:09']), dates: new Set(['2026-10-12']) })
  assert.match(doc.querySelector('#compare-table tbody')?.textContent || '', /compare-after/)

  win.location.hash = '#view=history&from=2026-10-13&to=2026-10-13'
  await report.loadAndRenderPage(win.location.hash, { force: true })
  assert.equal(doc.querySelector('#compare-table tbody')?.textContent || '', '')
})

test('比較資料載入錯誤顯示重試，重試成功後更新畫面', async () => {
  const { chrome, win, doc, report } = await mount()
  const realGet = chrome.storage.local.get.bind(chrome.storage.local)
  let shouldFail = true
  chrome.storage.local.get = async (keys, ...rest) => {
    if (shouldFail && Array.isArray(keys) && keys.some(key => /^rec2?:/.test(key))) {
      shouldFail = false
      throw new Error('controlled read failure')
    }
    return realGet(keys, ...rest)
  }

  win.location.hash = '#view=history&from=2026-10-20&to=2026-10-20&compareTo=2026-10-19'
  await report.loadAndRenderPage(win.location.hash, { force: true })
  assert.match(doc.getElementById('history-load-error')?.textContent || '', /controlled read failure/)
  const retry = doc.querySelector('#history-load-error button')
  assert.ok(retry)
  retry.click()
  await delay(100)
  assert.equal(doc.getElementById('history-load-error'), null)
})

async function prepareUncachedSummaryChart(date) {
  const hash = `#view=history&from=${date}&to=${date}`
  const { chrome, storage, win, doc, report } = await mount(hash)
  await storage.appendRecord(date, {
    taskId: 't1', capturedAt: `${date}T08:00:00.000Z`, slot: `${date}T08:00:00`,
    value: 42, raw: '42', status: 'ok'
  })
  await delay(120)
  await report.loadAndRenderPage(hash, { force: true })
  assert.ok(doc.querySelector('#summary .task-link'))

  // Invalidate the successful range while the route is hidden, then restore the
  // route state without loading so the summary button starts a real storage read.
  report.initFromHash(`#view=settings&from=${date}&to=${date}`)
  await report.refreshCurrentView({ keys: new Set([`rec2:${date}:08`]), dates: new Set([date]) })
  report.initFromHash(hash)

  return { chrome, storage, win, doc, report, hash, date }
}

test('同範圍刷新失敗保留已成功畫面，重試後更新資料', async () => {
  const date = '2026-12-04'
  const { chrome, storage, doc, report, hash } = await prepareUncachedSummaryChart(date)
  const table = doc.querySelector('#record-table tbody')
  const summary = doc.querySelector('#summary tbody')
  const calendar = doc.querySelector('#calendar')
  const previous = {
    table: table.innerHTML,
    summary: summary.innerHTML,
    calendar: calendar.innerHTML
  }
  assert.match(table.textContent, /42/)

  report.initFromHash(`#view=settings&from=${date}&to=${date}`)
  await storage.appendRecord(date, {
    taskId: 't1', capturedAt: `${date}T09:00:00.000Z`, slot: `${date}T09:00:00`,
    value: 43, raw: '43', status: 'ok'
  })
  await report.refreshCurrentView({ keys: new Set([`rec2:${date}:09`]), dates: new Set([date]) })
  report.initFromHash(hash)

  const realGet = chrome.storage.local.get.bind(chrome.storage.local)
  let failNextRead = true
  let retryLoaded
  const retryLoadedPromise = new Promise(resolve => { retryLoaded = resolve })
  chrome.storage.local.get = async (keys, ...rest) => {
    if (Array.isArray(keys) && keys.includes(`rec2:${date}:09`)) {
      if (failNextRead) {
        failNextRead = false
        throw new Error('controlled same-range refresh failure')
      }
      const result = await realGet(keys, ...rest)
      retryLoaded()
      return result
    }
    return realGet(keys, ...rest)
  }

  await report.loadAndRenderPage(hash, { force: true })
  assert.equal(table.innerHTML, previous.table)
  assert.equal(summary.innerHTML, previous.summary)
  assert.equal(calendar.innerHTML, previous.calendar)
  assert.match(doc.getElementById('history-load-error')?.textContent || '', /畫面保留上次資料/)
  assert.match(doc.getElementById('history-load-error')?.textContent || '', /controlled same-range refresh failure/)

  doc.querySelector('#history-load-error button').click()
  await retryLoadedPromise
  await delay(80)
  assert.equal(doc.getElementById('history-load-error'), null)
  assert.match(table.textContent, /43/)
})

test('摘要圖表的晚到歷史讀取不得覆寫新路由', async () => {
  const date = '2026-12-02'
  const { chrome, doc, report, hash } = await prepareUncachedSummaryChart(date)
  const realGet = chrome.storage.local.get.bind(chrome.storage.local)
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  chrome.storage.local.get = async (keys, ...rest) => {
    const result = await realGet(keys, ...rest)
    if (!held && Array.isArray(keys) && keys.includes(`rec2:${date}:08`)) {
      held = true
      entered()
      await gate
    }
    return result
  }

  doc.querySelector('#summary .task-link').click()
  await enteredPromise
  await report.loadAndRenderPage(`#view=settings&from=${date}&to=${date}`, { force: true })
  const chart = doc.getElementById('summary-chart')
  assert.equal(chart.hidden, true)
  release()
  await delay(80)
  assert.equal(chart.hidden, true, 'stale chart request cannot reveal chart on settings route')
  assert.equal(chart.children.length, 0)
  assert.equal(report.getState().view, 'settings')
})

test('摘要圖表的舊讀取拒絕會被處理且不寫入新路由', async t => {
  const date = '2026-12-03'
  const { chrome, doc, report } = await prepareUncachedSummaryChart(date)
  const realGet = chrome.storage.local.get.bind(chrome.storage.local)
  let entered
  const enteredPromise = new Promise(resolve => { entered = resolve })
  let release
  const gate = new Promise((resolve, reject) => { release = reject })
  let held = false
  chrome.storage.local.get = async (keys, ...rest) => {
    const result = await realGet(keys, ...rest)
    if (!held && Array.isArray(keys) && keys.includes(`rec2:${date}:08`)) {
      held = true
      entered()
      await gate
    }
    return result
  }

  let unhandled = false
  const onUnhandled = () => { unhandled = true }
  process.on('unhandledRejection', onUnhandled)
  const originalError = console.error
  let loggedStaleFailure = false
  console.error = (...args) => {
    if (String(args[0]).includes('繪製折線圖失敗')) loggedStaleFailure = true
    originalError(...args)
  }
  t.after(() => {
    process.off('unhandledRejection', onUnhandled)
    console.error = originalError
  })

  doc.querySelector('#summary .task-link').click()
  await enteredPromise
  await report.loadAndRenderPage(`#view=settings&from=${date}&to=${date}`, { force: true })
  const chart = doc.getElementById('summary-chart')
  release(new Error('late summary chart read failure'))
  await delay(80)
  assert.equal(unhandled, false, 'the async click handler must catch the rejected read')
  assert.equal(loggedStaleFailure, false, 'a stale error must not be surfaced on the new route')
  assert.equal(chart.hidden, true)
  assert.equal(chart.children.length, 0)
})

