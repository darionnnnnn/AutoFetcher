// AF-24 C5：multi 判斷與 alarm 名稱解析各只有一份
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const SRC = new URL('../src/', import.meta.url).pathname
function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : [])
  })
}

test('「spec.mode 是 multi」的判斷只寫在 task-source.js（不論順序、寫法；describe.js 在 content 載入閉包內、pick-draft 判的是選取結果的 spec，例外）', () => {
  const files = walk(SRC)
  assert.ok(files.length > 20, '掃描集合不得是空的')
  // 任何讀 spec.mode／spec?.mode 再比 multi 的寫法（任務的 multi 判斷一定會讀 spec.mode）
  const hits = files.filter(f => /spec\??\.mode\s*===?\s*['"]multi['"]|['"]multi['"]\s*===?\s*[\w?.]*spec\??\.mode/.test(readFileSync(f, 'utf8')))
    .map(f => f.slice(SRC.length)).sort()
  assert.deepEqual(hits, ['shared/describe.js', 'shared/pick-draft.js', 'shared/task-source.js'])
})

test('popup 不自己解析 alarm 名稱：下次時間問 background', () => {
  const src = readFileSync(join(SRC, 'ui/popup/popup.js'), 'utf8')
  assert.equal(/alarms\.getAll/.test(src), false)
  assert.ok(/GET_NEXT_RUNS/.test(src))
})

test('popup 把 GET_NEXT_RUNS 的結果畫成下次時間', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const { JSDOM } = await import('jsdom')
  const html = readFileSync(join(SRC, 'ui/popup/popup.html'), 'utf8')
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask({ id: 'n1', name: 'n1', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: { css: '#v' }, spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:00'] } })
  const when = new Date(2030, 0, 2, 9, 0).getTime()
  c.__setRuntimeResponder(m => m.type === 'GET_NEXT_RUNS' ? { nextRuns: { n1: when } } : undefined)
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  await pp.init()
  const text = jd.window.document.getElementById('task-list').textContent
  assert.match(text, /下次 /)
  assert.ok(text.includes("下次 09:00"), `要顯示 background 給的時間：${text}`)
  assert.ok(c.__calls.some(x => x.api === 'runtime.sendMessage' && x.args[0]?.type === 'GET_NEXT_RUNS'))
})

test('重建排程時清掉很早期的 <id>:<n> alarm，重試與預檢不動', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const sc = await import('../src/background/scheduler.js?t=' + Math.random())
  await c.alarms.create('old1:0', { when: Date.now() + 1000 })
  await c.alarms.create('old1:retry:1@2026-10-20T09:00', { when: Date.now() + 1000 })
  await c.alarms.create('old1:pre:0', { when: Date.now() + 1000 })
  await c.alarms.create('__watchdog', { periodInMinutes: 15 })
  await sc.rebuildAlarms()
  const names = (await c.alarms.getAll()).map(a => a.name).sort()
  assert.deepEqual(names, ['__watchdog', 'old1:pre:0', 'old1:retry:1@2026-10-20T09:00'])
  assert.equal(sc.isLegacyTaskAlarm('a:b:12'), true)
  assert.equal(sc.isLegacyTaskAlarm('task:a:0'), false)
})
