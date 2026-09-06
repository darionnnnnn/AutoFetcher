// AF-3 收尾核對:規劃列了但沒實作的四項
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

async function tasksPage() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(reportHtml, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  return { c, st, ts, doc: jd.window.document }
}

const task = (over = {}) => ({
  id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

// ---- 批次 C 改動 5:任務列要看得出區塊任務抓的是哪一欄、怎麼聚合 ----

test('區塊任務在任務列顯示取哪一欄與聚合方式', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task({
    mode: 'block',
    spec: { mode: 'block', block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum' } }
  })], {}, [])
  const text = doc.querySelector('[data-task-id="t1"] .task-mode').textContent
  assert.ok(text.includes('數量'), `要看得出抓的是哪一欄,實得:${text}`)
  assert.ok(/加總|sum/.test(text), `要看得出聚合方式,實得:${text}`)
})

test('沒有表頭文字時退而顯示第幾欄', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task({
    mode: 'block',
    spec: { mode: 'block', block: { axis: 'row', index: 2, headerText: '', aggregate: 'max' } }
  })], {}, [])
  const text = doc.querySelector('[data-task-id="t1"] .task-mode').textContent
  assert.ok(/第\s*3\s*列/.test(text), `列索引顯示給人看要 1 起算,實得:${text}`)
  assert.ok(/最大|max/.test(text), `實得:${text}`)
})

test('一般數值任務的顯示不受影響', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task()], {}, [])
  assert.equal(doc.querySelector('[data-task-id="t1"] .task-mode').textContent, 'number')
})

// ---- 批次 E 改動 5:任務列要看得出有設告警 ----

test('有設告警的任務看得出來,並顯示條件數', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task({
    alerts: [
      { id: 'a1', type: 'gt', value: 1000, enabled: true },
      { id: 'a2', type: 'failStreak', value: 3, enabled: true }
    ]
  })], {}, [])
  const row = doc.querySelector('[data-task-id="t1"]')
  const badge = row.querySelector('.task-alerts')
  assert.ok(badge, '要有告警標記')
  assert.ok(badge.textContent.includes('2'), `要看得出設了幾條,實得:${badge.textContent}`)
})

test('停用的告警條件不計入,全部停用時不顯示標記', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task({ alerts: [{ id: 'a1', type: 'gt', value: 1, enabled: false }] })], {}, [])
  assert.equal(doc.querySelector('[data-task-id="t1"] .task-alerts'), null)
})

test('沒設告警的任務不顯示標記', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task()], {}, [])
  assert.equal(doc.querySelector('[data-task-id="t1"] .task-alerts'), null)
})

// ---- 批次 F 改動 3:任務列要看得出有前置動作 ----

test('有前置動作的任務看得出來,並顯示動作數', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task({
    preActions: [
      { type: 'click', locator: { css: '#close' } },
      { type: 'wait', ms: 2000 }
    ]
  })], {}, [])
  const el = doc.querySelector('[data-task-id="t1"] .task-preactions')
  assert.ok(el, '要有前置動作標記')
  assert.ok(el.textContent.includes('2'), `要看得出有幾個動作,實得:${el.textContent}`)
})

test('沒有前置動作的任務不顯示標記', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task()], {}, [])
  assert.equal(doc.querySelector('[data-task-id="t1"] .task-preactions'), null)
})

test('標記用 textContent,不得用 innerHTML 塞內容', () => {
  const src = readFileSync(new URL('../src/ui/report/tasks.js', import.meta.url), 'utf8')
  assert.equal(/innerHTML/.test(src), false)
})

// ---- 批次 D 改動 5:看門狗要確認每日站台檢查的 alarm 還在 ----

test('看門狗會補建掉了的 __sitecheck alarm', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveSite('https://a.test', { loginUrl: 'https://a.test/login', enabled: true })
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())

  // 模擬 alarm 不見了（擴充功能更新、瀏覽器異常都可能）
  await chrome.alarms.clear('__sitecheck')
  assert.equal((await c.alarms.getAll()).some(a => a.name === '__sitecheck'), false)

  await wd.runWatchdog()
  const alarm = (await c.alarms.getAll()).find(a => a.name === '__sitecheck')
  assert.ok(alarm, '每日站台檢查的 alarm 掉了就再也不會檢查,看門狗要補回來')
  assert.equal(alarm.periodInMinutes, undefined, '每日排程一律用 when 重算')
})

test('__sitecheck 已存在時看門狗不重排(不要每 15 分鐘把時間往後推)', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const wd = await import('../src/background/watchdog.js?t=' + Math.random())
  const when = Date.now() + 3600000
  await chrome.alarms.create('__sitecheck', { when })
  await wd.runWatchdog()
  const alarm = (await c.alarms.getAll()).find(a => a.name === '__sitecheck')
  assert.equal(alarm.scheduledTime, when, '已經排好的不要動')
})
