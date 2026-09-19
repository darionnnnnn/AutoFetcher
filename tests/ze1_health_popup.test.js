// AF-21 段 5-A：燈號語意（紅燈修好才綠、黃燈可知悉）、圖示變體、popup 的下一步
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')

async function freshHealth() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const he = await import('../src/background/health.js?t=' + Math.random())
  return { c, st, he }
}

async function freshPopup() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pp = await import('../src/ui/popup/popup.js?t=' + Math.random())
  const he = await import('../src/background/health.js?t=' + Math.random())
  return { c, st, pp, he, doc: jd.window.document }
}

const task = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

const flush = () => new Promise(r => setTimeout(r, 20))
const sent = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const lastCreate = (c) => c.__calls.filter(x => x.api === 'tabs.create').pop()?.args[0]

// ---------- 驗收 1：燈號語意 ----------

test('1 紅項已讀 → 等級仍 red、badge 數字不含它；摘要把已讀的也算進去並標（已知悉）', async () => {
  const { c, he } = await freshHealth()
  const s = he.computeHealth(
    [task('t1', { name: '電費' }), task('t2', { name: '水費' })],
    { t1: { status: 'login_failed', read: true }, t2: { status: 'selector_lost' } },
    []
  )
  assert.equal(s.level, 'red')
  assert.equal(s.redCount, 1, 'badge 數字只算未讀的紅')
  assert.equal(s.knownRedCount, 1)
  assert.match(s.summary, /^2 個任務異常/)
  assert.ok(s.summary.includes('電費 無法登入（已知悉）'), s.summary)
  assert.ok(!s.summary.includes('水費 找不到元素（已知悉）') && s.summary.includes('水費'), s.summary)
  await he.applyBadge(s)
  assert.equal(c.__calls.find(x => x.api === 'action.setBadgeText').args[0].text, '1')
})

test('1 全部紅項已讀 → 等級 red、badge 為提示字（不是空字串也不是 0）', async () => {
  const { c, he } = await freshHealth()
  const s = he.computeHealth([task('t1')], { t1: { status: 'interrupted', read: true } }, [])
  assert.equal(s.level, 'red')
  assert.equal(s.redCount, 0)
  await he.applyBadge(s)
  const text = c.__calls.find(x => x.api === 'action.setBadgeText').args[0].text
  assert.equal(text, he.KNOWN_RED_BADGE)
  assert.notEqual(text, '')
  assert.notEqual(text, '0')
})

test('1 站台紅項已讀也維持紅燈', async () => {
  const { he } = await freshHealth()
  const s = he.computeHealth([task('t1')], { t1: { status: 'ok' }, 'site:https://a.test': { status: 'login_failed', read: true } }, [])
  assert.equal(s.level, 'red')
  assert.equal(s.redCount, 0)
})

test('1 黃項已讀 → 回 green；錯過清單（含 gap）照舊進黃燈', async () => {
  const { he } = await freshHealth()
  for (const st of ['fallback', 'late', 'partial']) {
    const s = he.computeHealth([task('t1')], { t1: { status: st, read: true } }, [])
    assert.equal(s.level, 'green', st)
  }
  const g = he.computeHealth([task('t1')], { t1: { status: 'fallback', read: true } }, [{ taskId: 't1', kind: 'gap', slot: 'x', count: 3 }])
  assert.equal(g.level, 'yellow')
})

test('1 黃項由 fallback 變 late → 重新 yellow（read 重設的既有邏輯）', async () => {
  const { st, he } = await freshHealth()
  await st.saveTask(task('t1'))
  await he.setTaskHealth('t1', { status: 'fallback' })
  await he.markRead('t1')
  assert.equal(he.computeHealth([task('t1')], await he.getHealth(), []).level, 'green')
  await he.setTaskHealth('t1', { status: 'late' })
  const s = he.computeHealth([task('t1')], await he.getHealth(), [])
  assert.equal(s.level, 'yellow')
  assert.equal(s.yellowCount, 1)
})

test('1 任務停用 → 紅項不計', async () => {
  const { he } = await freshHealth()
  const s = he.computeHealth(
    [task('t1', { enabled: false }), task('t2')],
    { t1: { status: 'login_failed', read: true }, t2: { status: 'ok' } },
    []
  )
  assert.equal(s.level, 'green')
  assert.equal(s.redCount, 0)
})

// ---------- 驗收 2：圖示變體 ----------

test('2 applyBadge 依等級換圖示（red／yellow／green／off→gray），路徑與 manifest 同寫法', async () => {
  const { c, he } = await freshHealth()
  const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'))
  assert.match(manifest.action.default_icon['16'], /^icons\//)
  const cases = [['red', 'red'], ['yellow', 'yellow'], ['green', 'green'], ['off', 'gray']]
  for (const [level, color] of cases) {
    const before = c.__calls.filter(x => x.api === 'action.setIcon').length
    await he.applyBadge({ level, redCount: 1, yellowCount: 1, summary: level })
    const calls = c.__calls.filter(x => x.api === 'action.setIcon')
    assert.equal(calls.length, before + 1, level)
    const path = calls.pop().args[0].path
    for (const size of [16, 32, 48]) {
      const p = path[size]
      assert.equal(p, `icons/icon-${color}-${size}.png`, `${level} ${size}`)
      assert.ok(statSync(new URL('../src/' + p, import.meta.url)).isFile(), `${p} 要真的存在`)
    }
  }
})

// ---------- 驗收 3：popup 不自動已讀、知道了、全部知道了、停用 ----------

async function seedAbnormal(st, he) {
  await st.saveTask(task('t1', { name: '電費' }))
  await st.saveTask(task('t2', { name: '水費' }))
  await st.saveTask(task('t3', { name: '匯率' }))
  await he.setTaskHealth('t1', { status: 'selector_lost' })
  await he.setTaskHealth('t2', { status: 'login_failed' })
  await he.setTaskHealth('t3', { status: 'fallback' })
  await he.setTaskHealth('site:https://a.test', { status: 'login_failed', reason: '帳密錯誤' })
}

test('3 popup 開啟（init）後 health 的 read 旗標零變動、也沒送 MARK_READ', async () => {
  const { c, st, pp, he } = await freshPopup()
  await seedAbnormal(st, he)
  const before = JSON.stringify(await st.getHealthMap())
  await pp.init()
  await flush()
  assert.equal(JSON.stringify(await st.getHealthMap()), before)
  assert.ok(!sent(c).some(m => m.type === 'MARK_READ'), '開啟 popup 不得標已讀')
  assert.ok(document.querySelectorAll('#task-list .task-row').length === 3)
})

test('3 「知道了」只標那一項；紅項知道了之後顯示「已知悉・尚未修復」與停用鈕', async () => {
  const { c, st, pp, he } = await freshPopup()
  await seedAbnormal(st, he)
  await pp.init()
  const row = () => [...document.querySelectorAll('#task-list .task-row')].find(r => r.textContent.includes('電費'))
  const ack = row().querySelector('[data-action="ack"]')
  assert.ok(ack && ack.textContent === '知道了')
  assert.equal(row().querySelector('[data-action="disable"]'), null, '還沒知道了之前不出停用鈕')
  ack.click()
  await flush()
  const marks = sent(c).filter(m => m.type === 'MARK_READ')
  assert.equal(marks.length, 1)
  assert.deepEqual(marks[0].taskIds, ['t1'])
  assert.ok(row().textContent.includes('已知悉・尚未修復'), row().textContent)
  assert.equal(row().querySelector('[data-action="ack"]'), null)
  assert.ok(row().querySelector('[data-action="disable"]'))
  assert.equal(document.getElementById('status-dot').className.includes('bad'), true, '紅燈仍是紅的')
  // 其他列不受影響
  const other = [...document.querySelectorAll('#task-list .task-row')].find(r => r.textContent.includes('水費'))
  assert.ok(other.querySelector('[data-action="ack"]'))
})

test('3 黃項知道了之後不顯示「已知悉・尚未修復」、燈號回綠（沒有其他問題時）', async () => {
  const { st, pp, he } = await freshPopup()
  await st.saveTask(task('t3', { name: '匯率' }))
  await he.setTaskHealth('t3', { status: 'fallback' })
  await pp.init()
  document.querySelector('#task-list .task-row [data-action="ack"]').click()
  await flush()
  const row = document.querySelector('#task-list .task-row')
  assert.ok(!row.textContent.includes('已知悉・尚未修復'))
  assert.ok(document.getElementById('status-dot').className.includes('ok'))
})

test('3 「全部知道了」標全部未讀異常（任務與站台），沒有異常時隱藏', async () => {
  const { c, st, pp, he } = await freshPopup()
  await seedAbnormal(st, he)
  await pp.init()
  const btn = document.getElementById('ack-all')
  assert.equal(btn.hidden, false)
  btn.click()
  await flush()
  const marks = sent(c).filter(m => m.type === 'MARK_READ')
  assert.equal(marks.length, 1)
  assert.deepEqual([...marks[0].taskIds].sort(), ['site:https://a.test', 't1', 't2', 't3'])
  assert.equal(document.getElementById('ack-all').hidden, true)

  const p2 = await freshPopup()
  await p2.st.saveTask(task('t1'))
  await p2.pp.init()
  assert.equal(p2.doc.getElementById('ack-all').hidden, true)
})

test('3 按「停用這個任務」→ 任務 enabled:false 且送 REBUILD_ALARMS', async () => {
  const { c, st, pp, he } = await freshPopup()
  await seedAbnormal(st, he)
  await pp.init()
  const row = () => [...document.querySelectorAll('#task-list .task-row')].find(r => r.textContent.includes('水費'))
  row().querySelector('[data-action="ack"]').click()
  await flush()
  row().querySelector('[data-action="disable"]').click()
  await flush()
  const tasks = await st.getTasks()
  assert.equal(tasks.find(t => t.id === 't2').enabled, false)
  assert.equal(tasks.find(t => t.id === 't1').enabled, true, '只停用那一個')
  assert.ok(sent(c).some(m => m.type === 'REBUILD_ALARMS'))
})

test('3 下一步依狀態：selector_lost／parse_error 重選目標開任務頁網址，logic.js 解析得動', async () => {
  const { c, pp } = await freshPopup()
  const { parseHash } = await import('../src/ui/report/logic.js')
  for (const status of ['selector_lost', 'parse_error']) {
    pp.render({
      health: { level: 'red', summary: 'x' },
      tasks: [task('t 1')], lastValues: {}, nextRuns: {},
      healthMap: { 't 1': { status } }
    })
    const btn = document.querySelector('#task-list .task-row [data-action="repick"]')
    assert.equal(btn.textContent, '重選目標')
    btn.click()
    await flush()
    const url = String(lastCreate(c).url)
    assert.match(url, /ui\/report\/report\.html#view=tasks&task=t%201$/)
    const parsed = parseHash(url.slice(url.indexOf('#')))
    assert.equal(parsed.view, 'tasks')
    assert.equal(new URLSearchParams(url.split('#')[1]).get('task'), 't 1')
  }
})

test('3 下一步依狀態：login_failed 前往登入頁（站台有 loginUrl 就用它）；其他失敗只有立即重試', async () => {
  const { c, pp } = await freshPopup()
  pp.render({
    health: { level: 'red', summary: 'x' },
    tasks: [task('t1', { url: 'https://a.test/report' }), task('t2')], lastValues: {}, nextRuns: {},
    healthMap: { t1: { status: 'login_failed' }, t2: { status: 'failed' } },
    sites: { 'https://a.test': { loginUrl: 'https://a.test/login' } }
  })
  const rows = document.querySelectorAll('#task-list .task-row')
  const go = rows[0].querySelector('[data-action="go-login"]')
  assert.equal(go.textContent, '前往登入頁')
  go.click()
  assert.equal(lastCreate(c).url, 'https://a.test/login')
  assert.equal(rows[1].querySelector('.next-step'), null)
  assert.ok(rows[1].querySelector('.retry'))
})

// ---------- 驗收 4：站台列、零任務、頁尾教學 ----------

test('4 站台紅燈時清單有站台列；前往登入頁開 loginUrl；有提示與知道了', async () => {
  const { c, pp } = await freshPopup()
  pp.render({
    health: { level: 'red', summary: 'x' },
    tasks: [task('t1')], lastValues: {}, nextRuns: {},
    healthMap: { t1: { status: 'ok' }, 'site:https://a.test': { status: 'login_failed', reason: '帳密錯誤' } },
    sites: { 'https://a.test': { loginUrl: 'https://a.test/signin' } }
  })
  const rows = document.querySelectorAll('#task-list .site-row')
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.ok(row.textContent.includes('https://a.test 無法登入'), row.textContent)
  assert.ok(row.textContent.includes('在登入頁按右鍵 → AutoFetcher → 設定此站台登入'))
  row.querySelector('[data-action="go-login"]').click()
  assert.equal(lastCreate(c).url, 'https://a.test/signin')
  row.querySelector('[data-action="ack"]').click()
  await flush()
  const marks = sent(c).filter(m => m.type === 'MARK_READ')
  assert.deepEqual(marks[0].taskIds, ['site:https://a.test'])
  const after = document.querySelector('#task-list .site-row')
  assert.ok(after.textContent.includes('已知悉・尚未修復'))
})

test('4 站台正常時沒有站台列', async () => {
  const { pp } = await freshPopup()
  pp.render({
    health: { level: 'green', summary: 'x' }, tasks: [task('t1')], lastValues: {}, nextRuns: {},
    healthMap: { 'site:https://a.test': { status: 'ok' } }
  })
  assert.equal(document.querySelectorAll('.site-row').length, 0)
})

test('4 零任務：三步引導＋主要按鈕「在這個頁面選取」＋使用教學連結', async () => {
  const { c, pp, doc } = await freshPopup()
  pp.render({ health: { level: 'off', summary: '' }, tasks: [], lastValues: {}, nextRuns: {}, healthMap: {} })
  const guide = doc.querySelector('#task-list .empty-guide')
  assert.ok(guide)
  const steps = [...guide.querySelectorAll('ol li')].map(li => li.textContent)
  assert.equal(steps.length, 3)
  assert.ok(steps[0].includes('在這個頁面選取'))
  assert.ok(steps[1].includes('點要抓的數字'))
  assert.ok(steps[2].includes('儲存'))
  const pick = doc.getElementById('pick-here')
  assert.ok(pick && !pick.hidden && pick.textContent === '在這個頁面選取')
  const help = guide.querySelector('[data-action="open-help"]')
  assert.equal(help.textContent, '使用教學')
  help.click()
  await flush()
  assert.match(String(lastCreate(c).url), /ui\/help\/help\.html$/)
})

test('4 頁尾有「使用教學」連結，開 ui/help/help.html', async () => {
  const { c, pp, doc } = await freshPopup()
  pp.render({ health: { level: 'green', summary: '' }, tasks: [task('t1')], lastValues: {}, nextRuns: {}, healthMap: {} })
  const link = doc.getElementById('open-help')
  assert.ok(link)
  assert.equal(link.textContent, '使用教學')
  link.click()
  await flush()
  assert.match(String(lastCreate(c).url), /ui\/help\/help\.html$/)
})

// ---------- 驗收 5：MARK_READ 全用常數 ----------

test('5 MARK_READ 收進 MSG，且不在 CONTENT_ALLOWED；src 除了 MSG 定義之外沒有字串字面值', async () => {
  const { MSG, CONTENT_ALLOWED } = await import('../src/shared/messages.js')
  assert.equal(MSG.MARK_READ, 'MARK_READ')
  assert.ok(!CONTENT_ALLOWED.has(MSG.MARK_READ))
  const root = new URL('../src/', import.meta.url)
  const hits = []
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const u = new URL(n, dir)
      if (statSync(u).isDirectory()) walk(new URL(n + '/', dir))
      else if (n.endsWith('.js')) {
        readFileSync(u, 'utf8').split('\n').forEach((line, i) => {
          if (line.includes("'MARK_READ'")) hits.push(`${u.pathname.split('/src/')[1]}:${i + 1}`)
        })
      }
    }
  }
  walk(root)
  assert.deepEqual(hits, ['shared/messages.js:' + (readFileSync(new URL('shared/messages.js', root), 'utf8').split('\n').findIndex(l => l.includes("MARK_READ: 'MARK_READ'")) + 1)])
})
