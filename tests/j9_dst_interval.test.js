// AF-4 終檢:日光節約時區下的 interval 對齊(台北沒有 DST,d14 測不到這個維度)
process.env.TZ = 'America/New_York'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function loadScheduler() {
  resetChromeMock()
  installChromeMock()
  return await import('../src/background/scheduler.js?t=' + Math.random())
}

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const label = (ms) => {
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const task = (everyMinutes, over = {}) => ({
  id: 't1', schedule: { type: 'interval', everyMinutes, weekdays: [0, 1, 2, 3, 4, 5, 6], ...over }
})

// 2026 年美東:3/8 春季前撥(02:00→03:00),11/1 秋季回撥(02:00→01:00)

test('春季前撥當天,不存在的 02:xx 不會讓排程卡住', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const next = nextIntervalRun(task(30), at(2026, 3, 8, 1, 45))
  assert.ok(next > at(2026, 3, 8, 1, 45), '要排在未來')
  assert.ok(next <= at(2026, 3, 8, 4, 0), `不該跳過大半天,實得 ${label(next)}`)
})

test('春季前撥當天的時段涵蓋消失的那一小時時,仍排得出下一次', async () => {
  const { nextIntervalRun } = await loadScheduler()
  const next = nextIntervalRun(task(15, { window: { from: '01:30', to: '03:30' } }), at(2026, 3, 8, 1, 40))
  assert.ok(next !== null, '不可回 null 讓任務靜默停擺')
  assert.ok(next > at(2026, 3, 8, 1, 40))
})

test('秋季回撥當天不會整段跳過,而且時刻仍嚴格遞增', async () => {
  const { nextIntervalRun } = await loadScheduler()
  let cursor = at(2026, 11, 1, 0, 30)
  const seen = []
  for (let i = 0; i < 8; i++) {
    const next = nextIntervalRun(task(30), cursor)
    assert.ok(next !== null, '不可回 null')
    assert.ok(next > cursor, `時刻必須嚴格遞增:${label(cursor)} → ${label(next)}`)
    seen.push(label(next))
    cursor = next
  }
  // 連續 8 次(每 30 分)不該橫跨超過一天,否則就是整段被跳過
  assert.ok(cursor < at(2026, 11, 2, 0, 0), `八格半小時不該跨到隔天:${seen.join(', ')}`)
})

test('回撥當天仍排得滿:整天不會少於 40 格(每 30 分,含重複的那一小時最少也有 46 格)', async () => {
  const { nextIntervalRun } = await loadScheduler()
  let cursor = at(2026, 11, 1, 0, 0) - 1
  let count = 0
  while (true) {
    const next = nextIntervalRun(task(30), cursor)
    if (next === null || next >= at(2026, 11, 2, 0, 0)) break
    count++
    cursor = next
    if (count > 100) break
  }
  assert.ok(count >= 40, `回撥當天應排滿一天,實得 ${count} 格`)
})
