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

