// AF-21 批次 3：background 只接受 content script 送它該送的訊息（sender 守門）
// content script 的判定：有 sender.tab，而且 sender.url 不是本擴充功能的頁面。
// Report 開在分頁裡也有 sender.tab——所以不能只看 tab；既有測試傳空 sender，視為擴充功能頁。
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { MSG, CONTENT_ALLOWED } from '../src/shared/messages.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

const EXT = `chrome-extension://${'autofetcher'}/`
const CONTENT = { tab: { id: 5, url: 'https://evil.test/x' }, url: 'https://evil.test/x', frameId: 0 }
const REPORT_TAB = { tab: { id: 9, url: EXT + 'ui/report/report.html' }, url: EXT + 'ui/report/report.html' }
const task = {
  id: 't1', name: 't1', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }
}

test('content script 可送的型別只有 PICKED 與 DESCEND_FRAME', () => {
  assert.deepEqual([...CONTENT_ALLOWED].sort(), [MSG.DESCEND_FRAME, MSG.PICKED].sort())
})

test('來自網頁（content script）的 TEST_TASK 被拒：不開分頁、不回頁面內容、留診斷', async () => {
  const { c, bg } = await fresh()
  c.__setTabResponder(() => ({ ok: true, value: 1, raw: 'secret-page-content', status: 'ok' }))
  const res = await bg.handleMessage({ type: MSG.TEST_TASK, task }, CONTENT, { pollMs: 1, loadTimeoutMs: 50 })
  assert.deepEqual(res, { ok: false, error: 'forbidden' })
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create' || x.api === 'windows.create').length, 0)
  const diag = (await chrome.storage.local.get('diag')).diag || []
  assert.ok(diag.some(e => e.kind === 'forbidden' && String(e.detail).includes(MSG.TEST_TASK)))
})

test('清單外的每一種型別從 content script 送來都被拒（新增型別預設拒絕）', async () => {
  const { st, bg } = await fresh()
  await st.saveTask(task)
  const types = [...new Set([...Object.values(MSG), 'MARK_READ'])].filter(t => !CONTENT_ALLOWED.has(t))
  assert.ok(types.length > 5, '掃描集合不得為空')
  for (const type of types) {
    const res = await bg.handleMessage({ type, taskId: 't1', tabId: 5, taskIds: ['t1'] }, CONTENT)
    assert.deepEqual(res, { ok: false, error: 'forbidden' }, `${type} 不得接受 content script`)
  }
  assert.ok(await st.getTask('t1'), '任務沒被動到')
})

test('content script 送允許的型別照常處理', async () => {
  const { bg } = await fresh()
  const res = await bg.handleMessage({ type: MSG.PICKED, purpose: 'task', cancelled: true }, CONTENT)
  assert.deepEqual(res, { ok: true }, '允許的型別要真的被處理（PICKED 取消回 ok:true）')
})

test('Report 分頁（有 sender.tab，但網址是擴充功能頁）送 RUN_TASK 不被當成 content script', async () => {
  const { c, st, bg } = await fresh()
  await st.saveTask(task)
  c.__setTabResponder(() => ({ ok: true, value: 3, raw: '3', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  const res = await bg.handleMessage({ type: MSG.RUN_TASK, taskId: 't1' }, REPORT_TAB, { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 100 })
  assert.equal(res?.ok, true, `RUN_TASK 要照常處理：${JSON.stringify(res)}`); assert.equal(res.outcome, 'done', '抓取要真的跑完')
})

test('沒有 sender（side panel、popup 或既有測試）照常處理', async () => {
  const { bg } = await fresh()
  const res = await bg.handleMessage({ type: MSG.GET_NEXT_RUNS }, {})
  assert.ok(res && res.nextRuns !== undefined)
  const res2 = await bg.handleMessage({ type: MSG.GET_NEXT_RUNS }, undefined)
  assert.ok(res2 && res2.nextRuns !== undefined)
})
