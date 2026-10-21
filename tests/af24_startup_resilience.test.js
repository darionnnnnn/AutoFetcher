// AF-24 C4：啟動流程某一步丟例外，看門狗仍要建起來並留診斷
// （「重試後不更新徽章」經查不成立：fetcher 每次寫 health 都會 refreshBadge）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

for (const entry of ['handleStartup', 'handleInstalled']) {
  test(`${entry}：重建排程丟例外時看門狗照樣建、診斷有紀錄`, async () => {
    const { c, bg } = await fresh()
    c.alarms.getAll = async () => { throw new Error('alarms broken') }
    await bg[entry]({ reason: 'update' })
    const watchdog = await c.alarms.get('__watchdog')
    assert.ok(watchdog, '看門狗不得因為前一步失敗被跳過')
    const diag = (await chrome.storage.local.get('diag')).diag || []
    assert.ok(diag.some(d => JSON.stringify(d).includes('rebuild_alarms')), JSON.stringify(diag))
  })
}

