// AF-9 作業 A：設定視窗的摘要卡、多值列（位置與逐值結果）、一鍵命名、儲存回饋、視窗寬度
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const SITE_HTML = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
const MAIN_JS = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, ls, pk, doc: jd.window.document, win: jd.window }
}

const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]' }
const CELL_PICK = { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } }
const TABLE_INFO = { kind: 'table', rows: 3, cols: 3, headers: ['幣別', '買入', '賣出'] }
const summary = (doc, id) => doc.getElementById(id).textContent

test('A1-1 摘要卡：抓什麼那一行說出主機名與那一格', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x?q=1', blockInfo: TABLE_INFO, picks: [CELL_PICK] })
  pk.updateSetupSummary()

  assert.match(summary(doc, 'summary-target'), /rate\.test/)
  assert.match(summary(doc, 'summary-target'), /美金 · 買入/)
})

test('A1-2 摘要卡：排程那一行跟著欄位即時變', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('times').value = '09:30'
  pk.updateSetupSummary()
  assert.match(summary(doc, 'summary-schedule'), /每日 09:30/)

  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new doc.defaultView.Event('change'))
  doc.getElementById('every-minutes').value = '10'
  pk.updateSetupSummary()
  assert.match(summary(doc, 'summary-schedule'), /每 10 分鐘/)
})

test('A1-3 摘要卡：放哪裡那一行說出儀表板與卡片型別', async () => {
  const { pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  pk.updateSetupSummary()
  const text = summary(doc, 'summary-dashboard')
  assert.match(text, /加入/)
  assert.match(text, /數字/)

  doc.getElementById('dashboard-select').value = 'none'
  pk.updateSetupSummary()
  assert.equal(summary(doc, 'summary-dashboard'), '不加入儀表板')
})

test('A1-4 摘要卡：改了排程欄位不必手動呼叫也會更新', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new doc.defaultView.Event('change'))
  const em = doc.getElementById('every-minutes')
  em.value = '45'
  em.dispatchEvent(new doc.defaultView.Event('input'))

  assert.match(summary(doc, 'summary-schedule'), /每 45 分鐘/)
})

test('A2-1 多值：每一列都顯示它在表格的位置', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    url: 'https://a.test/p',
    blockInfo: TABLE_INFO,
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
      { block: { axis: 'col', index: 2, headerText: '賣出' } }
    ]
  })
  const where = [...doc.querySelectorAll('#field-list [data-field-where]')].map(e => e.textContent)
  assert.deepEqual(where, ['美金 · 買入', '賣出 整欄'])
})

test('A2-2 多值：立即測試的逐值結果就地顯示，失敗那列是 — 且原因在 title', async () => {
  const { c, pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    url: 'https://a.test/p',
    blockInfo: TABLE_INFO,
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
      { cell: { row: { index: 0, header: '美金' }, col: { index: 2, header: '賣出' } } }
    ]
  })
  doc.getElementById('name').value = '匯率'
  const keys = [...doc.querySelectorAll('#field-list [data-field-row]')].map(r => r.dataset.fieldKey)
  c.__setRuntimeResponder((msg) => {
    if (msg.type !== 'TEST_TASK') return { ok: true }
    return {
      ok: true,
      fields: {
        [keys[0]]: { ok: true, value: 31.2 },
        [keys[1]]: { ok: false, message: '標題「賣出」找不到' }
      }
    }
  })
  await pk.handleTestNow()

  const cells = [...doc.querySelectorAll('#field-list [data-field-result]')]
  assert.equal(cells[0].textContent, '31.2')
  assert.equal(cells[0].dataset.state, 'ok')
  assert.equal(cells[1].textContent, '—', '缺值不補 0、不留空')
  assert.equal(cells[1].dataset.state, 'error')
  assert.match(cells[1].title, /找不到/)
})

test('A3 一鍵命名只改沒被手動改過的列', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    locator: LOCATOR,
    url: 'https://a.test/p',
    blockInfo: TABLE_INFO,
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
      { cell: { row: { index: 1, header: '日圓' }, col: { index: 1, header: '買入' } } }
    ]
  })
  const inputs = [...doc.querySelectorAll('#field-list input[data-field-name]')]
  inputs[1].value = '我自己取的名字'

  doc.getElementById('rename-cell').click()
  assert.equal(inputs[0].value, '美金 · 買入')
  assert.equal(inputs[1].value, '我自己取的名字', '手動改過的名稱不得被蓋掉')

  doc.getElementById('rename-col').click()
  assert.equal(inputs[0].value, '買入')
})

test('A4-1 儲存回饋：說出下次抓取時間並提供開啟報表', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  // 刻意讓 alarm 的實際時刻（14:05）與排程句（09:30）不同：
  // 兩者一樣的話，就算實作完全不看 nextRunMs 也照樣會出現 09:30
  const at = new Date(2026, 8, 8, 14, 5, 0).getTime()
  await pk.showSavedFeedback({ id: 't1', schedule: { type: 'daily', times: ['09:30'], weekdays: [1] } }, { nextRunMs: at, closeDelayMs: 5 })

  const box = doc.getElementById('saved-feedback')
  assert.ok(box, '儲存後不能無聲關窗')
  assert.match(box.textContent, /已儲存。下次抓取：14:05/)
  assert.doesNotMatch(box.textContent, /09:30/, '有實際 alarm 時間就不該再退回排程句')
  assert.ok(doc.getElementById('saved-open-report'), '要有去看結果的路')
  globalThis.window.close = () => {}
  await new Promise(r => setTimeout(r, 15))
})

test('A4-2 儲存回饋：問不到 alarm 時退回白話排程句', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  await pk.showSavedFeedback(
    { id: 't1', schedule: { type: 'interval', everyMinutes: 10, weekdays: [] } },
    { nextRunMs: null, closeDelayMs: 5 }
  )
  assert.match(doc.getElementById('saved-feedback').textContent, /每 10 分鐘/)
  globalThis.window.close = () => {}
  await new Promise(r => setTimeout(r, 15))
})

test('A4-3 儲存回饋：延遲關窗只關自己那個視窗', async () => {
  const { pk } = await fresh()
  const mine = globalThis.window
  let closed = 0
  mine.close = () => { closed++ }
  await pk.showSavedFeedback({ id: 't1', schedule: { type: 'daily', times: ['09:30'] } }, { closeDelayMs: 5 })
  // 關窗前全域視窗換了人（另一個測試接手）：不得關掉別人的視窗
  globalThis.window = { close: () => { throw new Error('不可以關到別人的視窗') } }
  await new Promise(r => setTimeout(r, 30))
  assert.equal(closed, 0)
  globalThis.window = mine
})

test('A5 視窗寬度：彈出視窗的頁面一律不寫死 body 寬度', () => {
  // 掃的是「body 有沒有寫死寬度」，不是某個被刪掉的字面值——
  // 比對舊值的話，改成別的固定寬度一樣會綠
  for (const [name, html] of [['picker', PICKER_HTML], ['site', SITE_HTML]]) {
    const bodyRule = html.match(/body\s*\{[^}]*\}/)
    assert.ok(bodyRule, `${name}.html 要有 body 樣式`)
    assert.doesNotMatch(bodyRule[0], /width:\s*\d+px/,
      `${name}.html 的 body 寫死寬度會讓右邊空一條、捲軸卡在畫面中間`)
  }
  // AF-10：設定畫面改成 side panel（寬度由瀏覽器決定，實測 360px），
  // 只有舊版瀏覽器的退路才開彈出視窗——那一份寬度定義在 shared/panel.js
  const PANEL_JS = readFileSync(new URL('../src/shared/panel.js', import.meta.url), 'utf8')
  const widths = [...PANEL_JS.matchAll(/width:\s*(\d+)/g)].map(m => Number(m[1]))
  assert.ok(widths.length >= 1, '退路的彈出視窗要有寬度設定')
  for (const w of widths) assert.ok(w >= 560, `彈出視窗至少 560 寬，實得 ${w}`)
})

test('A1-5 摘要卡跟著「列定位」與數值類型變（不是只跟排程變）', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p', blockInfo: TABLE_INFO, picks: [CELL_PICK] })
  const rowPos = doc.getElementById('row-pos')
  rowPos.value = 'last'
  rowPos.dispatchEvent(new doc.defaultView.Event('change'))

  assert.match(summary(doc, 'summary-target'), /列取最後一筆/, '改了定位，摘要不能還在講舊事實')
})

test('A6-1 排程預覽會說出欄位錯誤，不會對著不會執行的排程說「每天」', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  // 星期全部取消：nextDailyRun 會回 null，這個任務永遠不會執行
  doc.querySelectorAll('#weekdays input[type="checkbox"]').forEach(cb => { cb.checked = false })
  pk.updateSchedulePreview(new Date(2026, 8, 7, 7, 0, 0).getTime())

  const text = doc.getElementById('schedule-preview').textContent
  assert.match(text, /星期/, '要說出真正的問題（沒有選任何星期）')
})

test('A6-2 間隔沒填分鐘時，預覽講的是欄位沒填，不是星期或時段不符', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new doc.defaultView.Event('change'))
  doc.getElementById('every-minutes').value = ''
  pk.updateSchedulePreview(new Date(2026, 8, 7, 7, 0, 0).getTime())

  const text = doc.getElementById('schedule-preview').textContent
  assert.doesNotMatch(text, /今天不會執行/, '理由錯的話使用者會去改星期，白改一輪')
  assert.match(text, /間隔|分鐘/)
})

test('A7-1 使用者改過卡片型別之後，移除一個值不得把他的勾選改回預設', async () => {
  const { pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  pk.render({
    locator: LOCATOR,
    url: 'https://a.test/p',
    blockInfo: TABLE_INFO,
    picks: [
      { cell: { row: { index: 0, header: '美金' }, col: { index: 1, header: '買入' } } },
      { cell: { row: { index: 1, header: '日圓' }, col: { index: 1, header: '買入' } } },
      { cell: { row: { index: 2, header: '歐元' }, col: { index: 1, header: '買入' } } }
    ]
  })
  const boxes = [...doc.querySelectorAll('#card-types input[type="checkbox"]')]
  for (const cb of boxes) {
    cb.checked = (cb.value === 'table')
    cb.dispatchEvent(new doc.defaultView.Event('change'))
  }
  // 移除一列會走 updateFieldListState → applyDefaultCardTypes
  doc.querySelector('#field-list [data-field-row] [data-field-remove]')?.click()

  const after = boxes.filter(cb => cb.checked).map(cb => cb.value)
  assert.deepEqual(after, ['table'], '使用者選過的卡片型別不得被無聲改掉')
})

test('A7-2 新任務預設就選好儀表板（不是「不加入」）', async () => {
  const { pk, doc } = await fresh()
  await pk.renderDashboardSection(null)
  const sel = doc.getElementById('dashboard-select')
  assert.notEqual(sel.value, 'none', '存完卻沒地方看，使用者會以為沒作用')
  assert.ok(sel.value)
})
