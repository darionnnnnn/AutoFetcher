// AF-24 C3：被看門狗判定卡住並接管後，原本那個 runTask 跑完不得再寫第二筆
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 100, extraDelayMs: 0, extractTimeoutMs: 5000, frameTimeoutMs: 20 }
const t1 = {
  id: 'own1', name: 'own1', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
}

test('擷取卡住 → 接管寫 interrupted → 原抓取跑完：該槽只有一筆 interrupted、帳本與 health 不被成功覆蓋', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  await st.saveTask(t1)

  let release
  const gate = new Promise(r => { release = r })
  let extracting = false
  c.__setTabResponder(async (_tabId, msg) => {
    if (msg?.type === 'EXTRACT') {
      extracting = true
      await gate
      return { ok: true, value: 7, raw: '7', status: 'ok', strategyUsed: 'auto', layer: 'css' }
    }
    return { ok: true }
  })
  const slot = '2026-10-20T09:00'
  const run = fe.runTask(t1, { slot, attempt: 1, ...FAST })
  for (let i = 0; i < 200 && !extracting; i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(extracting, '前置：擷取要卡在 gate 上')

  // 模擬看門狗：把開始跑的時刻往回推到超過 STUCK_RUNNING_MS，再跑復原
  await st.updateRunState(cur => {
    for (const k of Object.keys(cur)) cur[k] = { ...cur[k], runningAt: Date.now() - 60 * 60 * 1000 }
    return cur
  })
  await fe.recoverRunState()
  // 接管之後同一格又被別的執行重新登記（例如補抓）：舊執行收尾時不得把它刪掉
  const key = `${t1.id}@${slot}`
  await st.updateRunState(cur => ({ ...cur, [key]: { state: 'queued', at: 1, boot: 'someone-else', attempt: 1, reason: 'late' } }))
  release()
  assert.equal(await run, null, '被接管的執行回 null')

  const recs = (await st.getRecordsByDate('2026-10-20')).filter(r => r.slot === slot)
  assert.deepEqual(recs.map(r => r.status), ['interrupted'])
  assert.equal(await st.getRunStatus(t1.id, slot), undefined, 'interrupted 不寫帳本，成功也不得補寫')
  assert.equal((await st.getRunState())[key]?.at, 1, '新登記要還在')
  const diag = (await chrome.storage.local.get('diag')).diag || []
  assert.ok(diag.some(d => JSON.stringify(d).includes('run_taken_over')))
})
