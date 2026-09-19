// AF-21 段 5-B：任務頁狀態四態／空狀態／手動結果跨重畫保留／依網址定位；歷史篩選拆兩條；主要按鈕分配與日期列
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')

const task = (id, over = {}) => ({
  id, name: `任務${id}`, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }, ...over
})

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/report/report.html' })
  jd.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  jd.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  const lg = await import('../src/ui/report/logic.js?t=' + Math.random())
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  return { c, st, ts, lg, rp, doc: jd.window.document, win: jd.window }
}

const rowOf = (doc, id) => [...doc.querySelectorAll('#task-list [data-task-id]')].find(r => r.dataset.taskId === id)

// ---------- 驗收 1：狀態四態、原因行、下一步 ----------

test('1 selector_lost → failed＋原因在內文＋「重選目標」排在動作區最前面；fallback → warn；停用 → paused；正常無 class', async () => {
  const { ts, doc } = await fresh()
  ts.renderTasks(
    [task('a'), task('b'), task('c', { enabled: false }), task('d')],
    {
      a: { status: 'selector_lost', reason: '頁面改版，找不到那一格', at: 1 },
      b: { status: 'fallback', reason: '用備援方式抓到', at: 1 },
      d: { status: 'ok', at: 1 }
    },
    []
  )
  const a = rowOf(doc, 'a')
  assert.ok(a.classList.contains('failed'))
  const reason = a.querySelector('.task-reason')
  assert.ok(reason, '要有原因行')
  assert.equal(reason.textContent, '頁面改版，找不到那一格', '原因要在 DOM 內文，不是只在 title')
  assert.equal(a.querySelector('.task-status').getAttribute('title'), '頁面改版，找不到那一格', 'title 保留完整內容')
  const first = a.querySelector('.task-actions').firstElementChild
  assert.equal(first.textContent, '重選目標')

  const b = rowOf(doc, 'b')
  assert.ok(b.classList.contains('warn') && !b.classList.contains('failed'))
  assert.ok(b.querySelector('.task-reason'))
  assert.ok(![...b.querySelectorAll('button')].some(x => x.textContent === '重選目標'), '黃燈不給重選目標')

  assert.ok(rowOf(doc, 'c').classList.contains('paused'))
  const d = rowOf(doc, 'd')
  for (const cls of ['failed', 'warn', 'paused']) assert.ok(!d.classList.contains(cls), `正常列不得有 ${cls}`)
  assert.equal(d.querySelector('.task-reason'), null)
})

test('1 「重選目標」走既有重選流程（ENTER_PICK purpose:repick）', async () => {
  const { c, ts, doc } = await fresh()
  ts.renderTasks([task('a')], { a: { status: 'parse_error', reason: '抓不到數值', at: 1 } }, [])
  const btn = [...rowOf(doc, 'a').querySelectorAll('button')].find(x => x.textContent === '重選目標')
  btn.click()
  await tick()
  const msg = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0]).pop()
  assert.equal(msg.type, 'ENTER_PICK')
  assert.equal(msg.purpose, 'repick')
  assert.equal(msg.taskId, 'a')
})

test('1 login_failed → 「前往登入頁」（有站台 loginUrl 就開它）；其他紅燈 → 立即抓取加強調', async () => {
  const { c, st, ts, doc } = await fresh()
  await st.saveSite('https://x.test', { username: 'u', enabled: true, loginUrl: 'https://x.test/login' })
  ts.renderTasks([task('a'), task('b')], {
    a: { status: 'login_failed', reason: '無法登入', at: 1 },
    b: { status: 'failed', reason: '抓取失敗', at: 1 }
  }, [])
  const a = rowOf(doc, 'a')
  const go = a.querySelector('.task-actions').firstElementChild
  assert.equal(go.textContent, '前往登入頁')
  go.click()
  await tick()
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').pop().args[0].url, 'https://x.test/login')

  const b = rowOf(doc, 'b')
  const run = b.querySelector('[data-action="run"]')
  assert.ok(run.classList.contains('task-next-step'), '其他紅燈：立即抓取加強調')
  assert.equal(b.querySelector('.task-actions').firstElementChild, run)
  assert.ok(!run.classList.contains('btn-primary'), '有任務時任務頁不設主要按鈕')
})

test('1 站台 login_failed 列有 failed，正常站台沒有', async () => {
  const { st, doc } = await fresh()
  const se = await import('../src/ui/report/settings.js?t=' + Math.random())
  await st.saveSite('https://s.test', { username: 'u', enabled: true })
  await st.saveSite('https://ok.test', { username: 'u', enabled: true })
  await st.updateHealthMap(h => ({
    ...h,
    'site:https://s.test': { status: 'login_failed', reason: '無法登入', at: 1 },
    'site:https://ok.test': { status: 'ok', at: 1 }
  }))
  await se.renderSettings()
  const rows = [...doc.querySelectorAll('#sites-list .site-row')]
  assert.equal(rows.length, 2)
  const bad = rows.find(r => r.textContent.includes('https://s.test'))
  const good = rows.find(r => r.textContent.includes('https://ok.test'))
  assert.ok(bad.classList.contains('failed'))
  assert.ok(!good.classList.contains('failed'))
})

// ---------- 驗收 2：空狀態 ----------

test('2 零任務 → 「還沒有任何任務」＋三步引導（共用來源）＋使用教學（唯一的主要按鈕）', async () => {
  const { ts, doc } = await fresh()
  const { EMPTY_GUIDE } = await import('../src/shared/describe.js')
  ts.renderTasks([], {}, [])
  const box = doc.querySelector('#task-list .task-empty')
  assert.ok(box)
  assert.match(box.textContent, /還沒有任何任務/)
  const steps = [...box.querySelectorAll('ol li')].map(li => li.textContent)
  assert.deepEqual(steps, [...EMPTY_GUIDE.steps])
  const help = box.querySelector('[data-action="open-help"]')
  assert.equal(help.textContent, '使用教學')
  assert.match(help.getAttribute('href'), /help\/help\.html$/)
  assert.ok(help.classList.contains('btn-primary'))
})

test('2 有任務但搜尋不到 → 「沒有符合條件的任務」＋清除篩選，按了恢復清單', async () => {
  const { ts, doc, win } = await fresh()
  ts.renderTasks([task('a'), task('b', { name: '水費' })], { a: { status: 'ok' } }, [])
  const search = doc.getElementById('task-search')
  const failed = doc.getElementById('task-failed-only')
  search.value = '不存在的字'
  failed.checked = true
  search.dispatchEvent(new win.Event('input'))
  assert.equal(doc.querySelectorAll('#task-list [data-task-id]').length, 0)
  const box = doc.querySelector('#task-list .task-empty')
  assert.match(box.textContent, /沒有符合條件的任務/)
  assert.doesNotMatch(box.textContent, /還沒有任何任務/)
  box.querySelector('[data-action="clear-filter"]').click()
  assert.equal(search.value, '')
  assert.equal(failed.checked, false)
  assert.equal(doc.querySelectorAll('#task-list [data-task-id]').length, 2)
  assert.equal(doc.querySelector('#task-list .task-empty'), null)
})

test('2 引導文字只有一份：src/ui 底下沒有任何檔案自己寫那三步與開頭句', async () => {
  const { EMPTY_GUIDE } = await import('../src/shared/describe.js')
  const texts = [EMPTY_GUIDE.lead, ...EMPTY_GUIDE.steps]
  assert.equal(texts.length, 4)
  const root = new URL('../src/ui/', import.meta.url)
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = new URL(name, dir)
      if (statSync(p).isDirectory()) walk(new URL(name + '/', dir))
      else if (/\.(js|html)$/.test(name)) files.push(p)
    }
  }
  walk(root)
  assert.ok(files.length > 10, `前置：掃得到檔案（${files.length}）`)
  // 開頭句與第一步是整句比對；後兩步太短（教學頁的說明文字本來就會寫「按「儲存」」），只比字串字面值
  const [lead, step1, ...shortSteps] = texts
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const t of [lead, step1]) assert.ok(!src.includes(t), `${f.pathname} 自己寫了「${t}」`)
    for (const t of shortSteps) {
      for (const q of [`'${t}'`, `"${t}"`, '`' + t + '`']) assert.ok(!src.includes(q), `${f.pathname} 自己寫了 ${q}`)
    }
  }
  const shared = readFileSync(new URL('../src/shared/describe.js', import.meta.url), 'utf8')
  for (const t of texts) assert.ok(shared.includes(t))
  for (const f of ['../src/ui/popup/popup.js', '../src/ui/report/tasks.js']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /EMPTY_GUIDE/, `${f} 要用共用引導`)
  }
})

// ---------- 驗收 3：手動抓取結果跨重畫保留 ----------

test('3 立即抓取結果：subscribe 重畫後仍在；該任務下一筆紀錄寫入後的重畫就消失', async () => {
  const { c, st, rp, doc } = await fresh()
  await st.saveTask(task('m1'))
  await st.updateHealthMap(h => ({ ...h, m1: { status: 'ok', at: 1000 } }))
  c.__setRuntimeResponder(m => m.type === 'RUN_TASK' ? { ok: true, outcome: 'done', status: 'ok', value: 31.52 } : undefined)
  rp.initFromHash('#view=tasks')
  await rp.showTab('tasks')
  let renders = 0
  st.subscribe(async () => { await rp.refreshCurrentView(); renders++ })

  rowOf(doc, 'm1').querySelector('[data-action="run"]').click()
  await tick()
  const before = rowOf(doc, 'm1')
  assert.match(before.querySelector('.task-run-result').textContent, /31\.52/)

  // 別的東西寫入 → 整份重畫
  await st.setLastValues({ other: { value: 1 } })
  await tick(150)
  assert.equal(renders, 1, '要真的重畫過一次')
  const after = rowOf(doc, 'm1')
  assert.notEqual(after, before, '列節點已被換掉')
  const kept = after.querySelector('.task-run-result')
  assert.ok(kept, '重畫後結果還在')
  assert.match(kept.textContent, /31\.52/)

  // 該任務下一筆紀錄寫入（health 的 at 變了）→ 重畫後消失
  await st.updateHealthMap(h => ({ ...h, m1: { status: 'ok', at: 2000 } }))
  await tick(150)
  assert.equal(renders, 2)
  assert.equal(rowOf(doc, 'm1').querySelector('.task-run-result'), null)
})

// ---------- 驗收 4：依網址參數定位 ----------

test('4 #view=tasks&task=t2 → 任務頁顯示、t2 高亮、焦點在該列按鈕', async () => {
  const { st, rp, doc } = await fresh()
  await st.saveTasks([task('t1'), task('t2'), task('t3')])
  rp.initFromHash('#view=tasks&task=t2')
  assert.equal(rp.getState().view, 'tasks')
  await rp.showTab(rp.getState().view)
  assert.equal(doc.getElementById('panel-tasks').hidden, false)
  const row = rowOf(doc, 't2')
  assert.ok(row.classList.contains('task-highlight'))
  assert.ok(!rowOf(doc, 't1').classList.contains('task-highlight'))
  const active = doc.activeElement
  assert.equal(active.tagName, 'BUTTON')
  assert.ok(row.contains(active), '焦點要在 t2 那一列')
  assert.equal(active, row.querySelector('button'), '是那一列第一顆按鈕')
})

test('4 不存在的 id 只切頁、不報錯；logic 的解析帶出 task', async () => {
  const { st, rp, lg, doc } = await fresh()
  await st.saveTasks([task('t1')])
  assert.equal(lg.parseHash('#view=tasks&task=t2').task, 't2')
  rp.initFromHash('#view=tasks&task=nope')
  await rp.showTab(rp.getState().view)
  assert.equal(doc.getElementById('panel-tasks').hidden, false)
  assert.equal(doc.querySelectorAll('.task-highlight').length, 0)
})

// ---------- 驗收 5：歷史篩選拆兩條 ----------

test('5 只看告警只剩 alert 成功紀錄、只看失敗只剩失敗紀錄、兩者都勾為空', async () => {
  const { lg } = await fresh()
  const recs = [
    { taskId: 'a', slot: '2026-09-01T09:00', status: 'ok', value: 1, alert: true },
    { taskId: 'a', slot: '2026-09-01T10:00', status: 'not_found', value: null }
  ]
  assert.deepEqual(lg.filterRecords(recs, { alertOnly: true }).map(r => r.status), ['ok'])
  assert.deepEqual(lg.filterRecords(recs, { failedOnly: true }).map(r => r.status), ['not_found'])
  assert.deepEqual(lg.filterRecords(recs, { failedOnly: true, alertOnly: true }), [])
  assert.equal(lg.filterRecords(recs, {}).length, 2)
})

test('5 網址：舊 alertsOnly=1 → 只看失敗勾選；新參數各自還原；buildHash 不再產生 alertsOnly', async () => {
  const { rp, lg, doc } = await fresh()
  rp.initFromHash('#view=history&alertsOnly=1')
  await rp.renderFilters()
  assert.equal(doc.getElementById('filter-failed-only').checked, true)
  assert.equal(doc.getElementById('filter-alert-only').checked, false)

  rp.initFromHash('#view=history&alertOnly=1')
  await rp.renderFilters()
  assert.equal(doc.getElementById('filter-failed-only').checked, false)
  assert.equal(doc.getElementById('filter-alert-only').checked, true)

  const p = lg.parseHash('#view=history&failedOnly=1&alertOnly=1')
  assert.equal(p.failedOnly, true)
  assert.equal(p.alertOnly, true)
  assert.equal('alertsOnly' in p, false)
  const h = lg.buildHash({ view: 'history', failedOnly: true, alertOnly: true })
  assert.match(h, /failedOnly=1/)
  assert.match(h, /alertOnly=1/)
  assert.doesNotMatch(h, /alertsOnly/)
})

test('5 勾「只看告警」＋「只看失敗」後寫進網址與狀態（兩個 checkbox 各自獨立）', async () => {
  const { rp, doc, win } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-01')
  await rp.renderFilters()
  const al = doc.getElementById('filter-alert-only')
  al.checked = true
  al.dispatchEvent(new win.Event('change', { bubbles: true }))
  await tick()
  assert.equal(rp.getState().alertOnly, true)
  assert.equal(rp.getState().failedOnly, false)
  assert.match(win.location.hash, /alertOnly=1/)
  const fa = doc.getElementById('filter-failed-only')
  fa.checked = true
  fa.dispatchEvent(new win.Event('change', { bubbles: true }))
  await tick()
  assert.equal(rp.getState().alertOnly, true)
  assert.equal(rp.getState().failedOnly, true)
})

// ---------- 驗收 6：主要按鈕分配、日期範圍列 ----------

const visible = (el) => { for (let n = el; n; n = n.parentElement) if (n.hidden) return false; return true }

test('6 四個分頁各自：可見按鈕非空、btn-primary ≤ 1；範圍列只在儀表板與歷史顯示；儀表板有全局區間說明', async () => {
  const { st, rp, doc } = await fresh()
  await st.saveTasks([task('t1')])
  const expectPrimary = { dashboard: '編輯版面', history: null, tasks: null, settings: null }
  for (const tab of ['dashboard', 'history', 'tasks', 'settings']) {
    await rp.showTab(tab)
    await tick()
    const scope = [doc.querySelector('.tab-nav'), doc.getElementById('range-bar'), doc.getElementById(`panel-${tab}`)]
    const buttons = scope.flatMap(s => [...s.querySelectorAll('button, a')]).filter(visible)
    assert.ok(buttons.length > 0, `${tab}：前置，掃得到按鈕`)
    const primaries = [...doc.querySelectorAll('.btn-primary')].filter(visible)
    assert.ok(primaries.length <= 1, `${tab} 有 ${primaries.length} 顆主要按鈕：${primaries.map(p => p.textContent).join('、')}`)
    if (expectPrimary[tab]) assert.equal(primaries[0]?.textContent, expectPrimary[tab])
    else assert.equal(primaries.length, 0, `${tab} 不設主要按鈕`)
    const bar = doc.getElementById('range-bar')
    assert.equal(bar.hidden, !(tab === 'dashboard' || tab === 'history'), `${tab} 的範圍列`)
  }
  await rp.showTab('dashboard')
  const note = doc.getElementById('panel-dashboard').textContent
  assert.match(note, /全局區間/)
  assert.match(note, /日期範圍/)
})

test('6 設定頁兩顆匯出鈕是次要；report.css 不再用 id／屬性選擇器把按鈕變主色', () => {
  const doc = new JSDOM(html).window.document
  for (const id of ['export-run', 'settings-export']) {
    assert.ok(!doc.getElementById(id).classList.contains('btn-primary'), id)
  }
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(css.length > 1000, '前置：讀得到樣式')
  for (const sel of ['#export-run', '#settings-export', 'button[data-action="confirm"]']) {
    assert.ok(!css.includes(sel), `report.css 還有 ${sel}`)
  }
  // 刪除類確認一律 danger，不當主要按鈕
  for (const id of ['dashboard-delete-confirm', 'drawer-delete-confirm']) {
    const b = doc.querySelector(`#${id} [data-action="confirm"]`)
    assert.ok(b.classList.contains('btn-danger') && !b.classList.contains('btn-primary'), id)
  }
})

test('6 任務頁四態樣式只用 theme 變數', () => {
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
  for (const sel of ['.task-row.warn .task-status', '.task-row.paused .task-status', '.task-row.failed .task-status', '.task-reason']) {
    assert.ok(css.includes(sel), `缺少 ${sel}`)
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b(?![\w-])\s*[;)]/, '不得有色碼')
})
