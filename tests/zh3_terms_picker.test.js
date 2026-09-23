// AF-21 段 8-C：詞彙統一、Picker 前置動作提到主區、「固定為預設值」搬到存檔回饋、8-B 收尾（圖示、任務頁、儀表板）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { TERMS } from '../src/shared/describe.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const REPORT_HTML = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]' }
const URL_ = 'https://rate.test/p'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|html)$/.test(name)) out.push(p)
  }
  return out
}
const rel = (p) => p.slice(SRC.length).replace(/\\/g, '/')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

// 真正的面板（正式接線、網址帶 tabId 的退路入口）：session 一寫就照 ctx 重畫
async function freshPanel(tabId, ctx) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.setPanelCtx(tabId, ctx)
  const jd = new JSDOM(PICKER_HTML, { url: `chrome-extension://abc/ui/picker/picker.html?tabId=${tabId}`, pretendToBeVisual: true })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  c.runtime.id = 'af-test'
  let pk
  try {
    pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  } finally {
    delete c.runtime.id
  }
  const doc = jd.window.document
  for (let i = 0; i < 50 && !doc.getElementById('name').value; i++) await sleep(10)
  await sleep(20)
  return { c, st, pk, doc }
}

async function tasksPage() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(REPORT_HTML, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())
  return { c, st, ts, doc: jd.window.document }
}

const blockCtx = (over = {}) => ({
  tabId: 9, url: URL_, locator: LOCATOR,
  block: { axis: 'col', index: 1, headerText: '買入', rows: 4, cols: 3, aggregate: 'sum' },
  picks: [{ locator: LOCATOR, block: { axis: 'col', index: 1, headerText: '買入' } }],
  ...over
})
const task = (over = {}) => ({
  id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

// ---------- 1. 詞彙：舊詞基準歸零（保留處逐一列出） ----------

// 基準（段 8-C 開工前）：src/ 內「聚合方式／合成方式／立即測試／先試抓看看」共 39 處。
// 保留的只剩白名單外或「只換通知／錯誤文字」檔案裡的程式註解（歷史說明，不是使用者看得到的字）。
const OLD_TERMS = /聚合方式|合成方式|立即測試|先試抓看看/g
const KEPT = {
  'background/fetcher.js': 6, // 註解：失敗時保留立即測試軌跡的說明，其餘為既有診斷包與 raw 截斷層
  'background/frames.js': 1, // 註解：立即測試核對分頁網址走 sameOriginPath
  'background/main.js': 1, // 註解：重選時聚合方式沿用
  'shared/aggregate.js': 2, // 註解：純函式的參數說明（檔案不在本段白名單）
  'ui/save-guard.js': 1 // JSDoc：純文字那一條（檔案不在本段白名單）
}

test('舊詞在 src/ 的出現數＝保留清單（其餘為 0），而且保留處都只在註解裡', () => {
  const files = walk(SRC)
  assert.ok(files.length > 50, `前置：要掃到 src/ 的檔案，實得 ${files.length}`)
  const counts = {}
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const n = (text.match(OLD_TERMS) || []).length
    if (n > 0) counts[rel(f)] = n
    // 保留處只能是註解行（// 或 * 開頭）
    text.split('\n').forEach((line, i) => {
      if (OLD_TERMS.test(line)) {
        OLD_TERMS.lastIndex = 0
        assert.match(line.trim(), /^(\/\/|\*|\/\*)/, `${rel(f)}:${i + 1} 不是註解：${line.trim()}`)
      }
      OLD_TERMS.lastIndex = 0
    })
  }
  assert.deepEqual(counts, KEPT)
})

test('詞彙表：TERMS 是凍結的單一來源，含合計方式／試抓／全部試抓／試抓結果', () => {
  assert.ok(Object.isFrozen(TERMS))
  assert.equal(TERMS.aggregate, '合計方式')
  assert.equal(TERMS.test, '試抓')
  assert.equal(TERMS.testAll, '全部試抓')
  assert.equal(TERMS.testResult, '試抓結果')
  assert.deepEqual(TERMS.modes, { number: '數字', text: '文字', block: '表格／清單區塊' })
})

test('Picker 單任務與批次畫面的合計方式標籤文字相同，而且都來自 TERMS（HTML 本身不寫死）', async () => {
  const raw = new JSDOM(PICKER_HTML).window.document
  const rawSpans = [...raw.querySelectorAll('[data-term="aggregate"]')]
  assert.equal(rawSpans.length, 2, '單任務與批次各一個標籤')
  for (const s of rawSpans) assert.equal(s.textContent, '', 'HTML 裡不得寫死文字（寫死就不是從 TERMS 來）')

  const { pk, doc } = await fresh()
  pk.render(blockCtx())
  const single = doc.getElementById('block-aggregate').closest('label').querySelector('[data-term="aggregate"]')
  assert.equal(single.textContent, TERMS.aggregate)
  assert.equal(doc.getElementById('test-now').textContent, TERMS.test)
  assert.equal(doc.querySelector('#preview-section > legend').textContent, TERMS.testResult)

  await pk.renderFromPanelCtx({ kind: 'batch', items: [
    { key: 'b1', ...blockCtx() },
    { key: 'b2', tabId: 9, url: URL_, locator: { css: '#c' }, nameHint: '乙', picks: [{ locator: { css: '#c' } }] }
  ] })
  const batchLabel = doc.getElementById('batch-aggregate-label')
  assert.equal(batchLabel.hidden, false, '前置：有整欄值時批次顯示合計方式')
  assert.equal(batchLabel.querySelector('[data-term="aggregate"]').textContent, single.textContent)
  assert.equal(doc.getElementById('test-now').textContent, TERMS.testAll)
})

// ---------- 2. 前置動作提到主區 ----------

test('前置動作編輯器在 DOM 裡只有一份、位於「抓什麼」之後、不在進階設定裡；批次用同一份', async () => {
  const { pk, doc } = await fresh()
  pk.render(blockCtx())
  for (const id of ['preaction-section', 'preaction-list', 'preaction-add']) {
    assert.equal(doc.querySelectorAll(`#${id}`).length, 1, `#${id} 只能有一份`)
  }
  const section = doc.getElementById('preaction-section')
  const what = doc.getElementById('block-section')
  assert.ok(what.compareDocumentPosition(section) & 4, '要在「抓什麼」之後')
  assert.ok(section.compareDocumentPosition(doc.getElementById('schedule-section')) & 4, '要在「多久抓一次」之前')
  assert.equal(doc.getElementById('advanced-section').contains(section), false, '不得再收在進階設定裡')
  assert.match(section.querySelector('summary').textContent, /抓之前要先點什麼嗎？（例如關閉彈窗、切換頁籤）/)
  assert.equal(section.hasAttribute('open'), false, '新建、沒有前置動作時預設收合')

  await pk.renderFromPanelCtx({ kind: 'batch', items: [{ key: 'b1', ...blockCtx() }] })
  assert.equal(doc.querySelectorAll('#preaction-list').length, 1, '批次不得另建一份')
  assert.equal(doc.getElementById('preaction-section'), section, '批次用的是同一個元素')
  assert.equal(section.hidden, false)
  assert.equal(section.hasAttribute('open'), true, '批次共用前置動作：展開')
  assert.match(section.querySelector('summary').textContent, /套用到每一個任務/)
  assert.equal(doc.getElementById('advanced-section').hidden, true, '批次只露出前置動作，其餘進階欄位不出現')
})

test('已有前置動作的任務開啟時該列展開並顯示數量；增刪一列數量跟著變', async () => {
  const { pk, doc } = await fresh()
  pk.render({ task: task({ preActions: [{ type: 'click', locator: { css: '#tab' } }, { type: 'wait', sec: 2 }] }), locator: LOCATOR, url: 'https://a.test/p' })
  const section = doc.getElementById('preaction-section')
  assert.equal(section.hasAttribute('open'), true)
  const count = doc.getElementById('preaction-count')
  assert.equal(count.hidden, false)
  assert.match(count.textContent, /2/)
  doc.getElementById('preaction-add').click()
  assert.match(count.textContent, /3/)
  doc.querySelector('#preaction-list [data-action="preaction-remove"]').click()
  assert.match(count.textContent, /2/)

  // 接著換成沒有前置動作的任務：收合、數量藏起來（同一份面板文件的殘留）
  pk.render({ task: task({ id: 't2', preActions: [] }), locator: LOCATOR, url: 'https://a.test/p' })
  assert.equal(section.hasAttribute('open'), false)
  assert.equal(count.hidden, true)
})

test('試抓失敗且沒有前置動作：出現提示與跳轉鈕，按下去展開那一列；有前置動作時不出現；成功時不出現', async () => {
  const { c, pk, doc } = await fresh()
  pk.render(blockCtx())
  c.__setRuntimeResponder((msg) => msg?.type === 'TEST_TASK' ? { ok: false, error: 'not_found' } : undefined)
  await pk.handleTestNow()
  const hint = doc.getElementById('test-preaction-hint')
  assert.equal(hint.hidden, false, '沒有前置動作的失敗要給一條路')
  assert.match(hint.textContent, /如果要先點開什麼才看得到，可以在『抓之前要先點什麼嗎？』加一步/)
  assert.ok(doc.getElementById('preview-section').contains(hint), '提示在試抓結果區裡')
  const section = doc.getElementById('preaction-section')
  assert.equal(section.hasAttribute('open'), false, '前置：還收合著')
  doc.getElementById('test-preaction-goto').click()
  assert.equal(section.hasAttribute('open'), true, '跳轉鈕要把那一列展開')

  // 有前置動作時不出現
  doc.getElementById('preaction-add').click()
  await pk.handleTestNow()
  assert.equal(hint.hidden, true, '已經有前置動作了，不該再叫使用者加')

  // 成功時不出現
  doc.querySelector('#preaction-list [data-action="preaction-remove"]').click()
  c.__setRuntimeResponder((msg) => msg?.type === 'TEST_TASK' ? { ok: true, value: 3, raw: '3' } : undefined)
  await pk.handleTestNow()
  assert.equal(hint.hidden, true)
})

// ---------- 3. 「固定為預設值」搬家 ----------

test('#pin-defaults 不存在', () => {
  const doc = new JSDOM(PICKER_HTML).window.document
  assert.equal(doc.getElementById('pin-defaults'), null)
  assert.doesNotMatch(PICKER_HTML, /固定為預設值/)
})

test('新建存檔後回饋有「下次新任務沿用」鈕：按了寫 pickerDefaults.pinned（last 不動）；session 重畫後回饋仍在、已設定的狀態也在', async () => {
  const tabId = 7
  const { c, st, pk, doc } = await freshPanel(tabId, { kind: 'new', ctx: { locator: LOCATOR, url: URL_, tabId } })
  assert.ok(doc.getElementById('name').value, '前置：面板照 session 畫出新建表單')
  c.__setRuntimeResponder((msg) => msg?.type === 'RUN_TASK' ? { ok: true, outcome: 'done', status: 'ok', value: 1 } : undefined)
  doc.getElementById('times').value = '11:20'
  await pk.handleSave()
  await sleep(40)
  let btn = doc.getElementById('saved-pin-defaults')
  assert.ok(btn, '回饋區要有沿用鈕（session 重畫之後也在）')
  assert.equal(btn.textContent, TERMS.pinDefaults)
  assert.equal((await st.getSettings()).pickerDefaults?.pinned, undefined, '還沒按就不得固定')
  // 按之前另一個新任務改了 last（例如別的面板存了檔）：固定只寫 pinned，不得把 last 換回這一組
  const other = { scheduleType: 'interval', everyMinutes: 45, times: [], weekdays: [] }
  await st.saveSettings({ pickerDefaults: { ...(await st.getSettings()).pickerDefaults, last: other } })
  const lastBefore = (await st.getSettings()).pickerDefaults.last

  btn.click()
  await sleep(40)
  const s = await st.getSettings()
  assert.deepEqual(s.pickerDefaults.pinned.times, ['11:20'])
  assert.deepEqual(s.pickerDefaults.last, lastBefore, '固定不得動到 last')
  // 模擬 session 重畫：照目前 ctx 再畫一次（面板文件重載也是走這一條）
  const ctx = await st.getPanelCtx(tabId)
  assert.equal(ctx.kind, 'saved')
  assert.equal(ctx.pinned, true, '按過的狀態要進 ctx')
  await pk.renderFromPanelCtx(ctx)
  btn = doc.getElementById('saved-pin-defaults')
  assert.ok(btn, '重畫後回饋仍在')
  assert.equal(btn.textContent, TERMS.pinnedDone)
  assert.equal(btn.disabled, true)
})

test('編輯既有任務存檔：回饋不給「下次新任務沿用」', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTasks([task()])
  pk.render({ task: task(), locator: task().locator, url: 'https://a.test/p' })
  doc.getElementById('dashboard-select').innerHTML = '<option value="none">不加入</option>'
  await pk.handleSave()
  assert.ok(doc.getElementById('saved-feedback'), '前置：存好了')
  assert.equal(doc.getElementById('saved-pin-defaults'), null)
})

// ---------- 5. 8-B 收尾 ----------

test('src/ui 下 JS／HTML 不用 ✓ ✗ 當圖示；Picker 移除鈕是 SVG 且有名稱', async () => {
  const files = walk(join(SRC, 'ui'))
  assert.ok(files.length >= 20)
  const hits = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/[✓✗✔✘]/.test(line)) hits.push(`${rel(f)}:${i + 1}`) })
  }
  assert.deepEqual(hits, [])

  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: URL_ })
  pk.addTime('10:15')
  const rm = doc.querySelector('[data-time-remove="10:15"]')
  assert.ok(rm.querySelector('svg'), '移除鈕用 SVG 圖示')
  assert.equal(rm.textContent.trim(), '')
  assert.match(rm.getAttribute('aria-label') || '', /移除/)
})

test('任務頁：停用中顯示「停用中」；失敗列有「重選目標」就不重複「重選」；模式欄是白話', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([
    task({ id: 'p', enabled: false }),
    task({ id: 'f' }),
    task({ id: 'n', mode: 'text' })
  ], {
    p: { status: 'ok', at: 1 },
    f: { status: 'selector_lost', reason: '找不到元素', at: 1 }
  }, [])
  const row = (id) => doc.querySelector(`[data-task-id="${id}"]`)
  assert.equal(row('p').querySelector('.task-status').textContent, '停用中')
  assert.ok(row('f').querySelector('[data-action="next-repick"]'), '前置：失敗列有重選目標')
  assert.equal(row('f').querySelector('[data-action="repick"]'), null, '同一件事不放兩顆')
  assert.ok(row('n').querySelector('[data-action="repick"]'), '一般列照舊有重選')
  assert.equal(row('p').querySelector('.task-mode').textContent, '數字')
  assert.equal(row('n').querySelector('.task-mode').textContent, '文字')
})

test('任務頁：DOM 順序就是畫面順序（選取、名稱、狀態、原因、下次時間、動作、啟用開關），CSS 不再用 order', async () => {
  const { ts, doc } = await tasksPage()
  ts.renderTasks([task({ id: 'f' })], { f: { status: 'selector_lost', reason: '找不到元素', at: 1 } }, [])
  const kids = [...doc.querySelector('[data-task-id="f"]').children]
  const idx = (sel) => kids.findIndex(k => k.matches(sel))
  const order = ['[data-action="select"]', '.task-name', '.task-status', '.task-reason', '.task-next', '.task-actions', '.task-toggle-label'].map(idx)
  assert.ok(order.every(i => i >= 0), `每一項都要在：${order}`)
  assert.deepEqual([...order].sort((a, b) => a - b), order, `順序不對：${order}`)
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
  const taskRowRules = css.split('}').filter(r => /\.task-row/.test(r) && /(^|[\s;{])order\s*:/.test(r))
  assert.deepEqual(taskRowRules, [], '任務列不得靠 order 排版')
})

test('儀表板表格卡：時間欄顯示 MM/DD HH:mm、TSV 維持原格式；數值欄靠右、文字欄靠左；狀態清單卡預設標題', async () => {
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const CR = await import('../src/ui/report/cards.js?t=' + Math.random())
  assert.equal(CR.shortTimeText('2026-09-19T15:00'), '09/19 15:00')
  assert.equal(CR.shortTimeText('2026-09-19'), '09/19')
  assert.equal(CR.shortTimeText('怪字串'), '怪字串')

  const base = { tasksById: { t1: { name: '電費' } }, health: {}, nextRuns: {}, missed: [], range: { from: '2026-09-01', to: '2026-09-30' }, today: '2026-09-19' }
  const records = [{ taskId: 't1', slot: '2026-09-19T15:00', value: 5, raw: '5', status: 'ok' }]
  const recent = CR.renderCard({ id: 'c1', type: 'table', x: 0, y: 0, w: 6, h: 3, source: [{ taskId: 't1' }], options: { mode: 'recent' } }, { ...base, records })
  const tds = [...recent.querySelectorAll('tbody tr td')]
  assert.equal(tds[0].textContent, '09/19 15:00')
  assert.match(recent.dataset.tsv, /2026-09-19T15:00/, '複製 TSV 維持原格式')
  const ths = [...recent.querySelectorAll('thead th')]
  assert.deepEqual(ths.map(t => t.classList.contains('num')), [false, false, true, false], '只有「值」是數值欄')
  assert.deepEqual(tds.map(t => t.classList.contains('num')), [false, false, true, false], '表頭與內容同一欄同一種對齊')

  const pivot = CR.renderCard({ id: 'c2', type: 'table', x: 0, y: 0, w: 6, h: 3, source: [{ taskId: 't1' }], options: { mode: 'pivot' } }, { ...base, records })
  const firstRow = pivot.querySelector('tbody tr')
  assert.equal(firstRow.children[0].textContent.startsWith('09/19'), true, `樞紐表時間欄：${firstRow.children[0].textContent}`)
  assert.equal(firstRow.children[1].classList.contains('num'), true)
  assert.equal(pivot.querySelectorAll('thead th')[1].classList.contains('num'), true)

  const status = CR.renderCard({ id: 'c3', type: 'status', x: 0, y: 0, w: 6, h: 3, source: [], options: { taskIds: ['t1'] } }, { ...base, records })
  assert.equal(status.querySelector('.card-title').textContent, '任務狀態')
  const named = CR.renderCard({ id: 'c4', type: 'status', title: '我的清單', x: 0, y: 0, w: 6, h: 3, source: [], options: {} }, { ...base, records })
  assert.equal(named.querySelector('.card-title').textContent, '我的清單', '自訂標題優先')
})

test('數值卡的迷你走勢圖不得超出卡片：內容區裁切、走勢圖可縮', () => {
  const css = readFileSync(new URL('../src/ui/report/report.css', import.meta.url), 'utf8')
  assert.match(css, /\.report-card\[data-card-type="number"\] \.card-body \{[^}]*overflow:\s*hidden/)
  assert.match(css, /\.report-card\[data-card-type="number"\] \.card-body > svg \{[^}]*min-height:\s*0/)
})
