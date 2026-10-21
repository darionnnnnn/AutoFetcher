// AF-24 F1–F3：popup 全部暫停後燈號重算、按鈕說出這一下會做什麼、正式碼不留測試替身路徑
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')
const task = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true, locator: { css: '#v' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  return { c, st, pp, doc: jd.window.document }
}

test('有啟用中的任務：按鈕寫「全部暫停」；按下後變「全部恢復」且燈號變成已暫停', async () => {
  const { st, pp, doc } = await fresh()
  await st.saveTasks([task('t1'), task('t2')])
  await pp.init()
  const btn = doc.getElementById('toggle-all')
  assert.equal(btn.textContent, '全部暫停')
  const summaryBefore = doc.getElementById('status-summary').textContent
  btn.click()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(doc.getElementById('toggle-all').textContent, '全部恢復')
  assert.ok((await st.getTasks()).every(t => t.enabled === false))
  const summaryAfter = doc.getElementById('status-summary').textContent
  assert.notEqual(summaryAfter, summaryBefore, `燈號摘要要重算（前：${summaryBefore}）`)
  assert.match(doc.body.textContent, /已暫停/)
})

test('沒有任務時不顯示全部暫停', async () => {
  const { pp, doc } = await fresh()
  await pp.init()
  assert.equal(doc.getElementById('toggle-all').hidden, true)
})

test('開啟報表走 openExtPage，正式碼沒有測試替身用的固定網址', async () => {
  const src = readFileSync(new URL('../src/ui/popup/popup.js', import.meta.url), 'utf8')
  assert.equal(src.includes('chrome-extension://autofetcher'), false)
  assert.equal(/url\.toString\s*=/.test(src), false)
})

test('體檢：全部暫停後各列不顯示舊的「下次」；全部恢復後重新問 background 拿新的下次', async () => {
  const { c, st, pp, doc } = await fresh()
  await st.saveTasks([task('n1')])
  let calls = 0
  c.__setRuntimeResponder(m => {
    if (m.type === 'GET_NEXT_RUNS') { calls++; return { nextRuns: { n1: new Date(2030, 0, 2, calls === 1 ? 8 : 10, 13).getTime() } } }
    if (m.type === 'REBUILD_ALARMS') return { ok: true }
    return undefined
  })
  await pp.init()
  assert.match(doc.getElementById('task-list').textContent, /下次 08:13/)
  doc.getElementById('toggle-all').click()
  await new Promise(r => setTimeout(r, 30))
  assert.match(doc.getElementById('task-list').textContent, /下次 —/, '停用中的任務不得顯示舊 alarm 的時刻')
  doc.getElementById('toggle-all').click()
  await new Promise(r => setTimeout(r, 30))
  assert.match(doc.getElementById('task-list').textContent, /下次 10:13/, '恢復後要拿到重建後的下次')
})
