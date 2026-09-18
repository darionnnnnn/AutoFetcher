// AF-19 作業 F：多值表單「拆成每個值一個任務」
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

const sessionOf = async (tabId) => (await chrome.storage.session.get(`panel:${tabId}`))[`panel:${tabId}`]
const tick = () => new Promise(r => setTimeout(r, 20))
const LOCATOR = { css: '#t', path: 'body > table', anchor: null, xpath: '/html[1]/body[1]/table[1]' }
const cellPick = (r, c) => ({ cell: { row: { index: r, header: `列${r}` }, col: { index: c, header: `欄${c}` } } })

function ctxWith(picks, over = {}) {
  return {
    url: 'https://a.test/p', tabId: 9, locator: LOCATOR, nameHint: '匯率',
    preview: '31.2（共 3 個值）', previewValue: 31.2, previewSamples: 'x',
    blockInfo: { kind: 'table', rows: 5, cols: 4 },
    picks, ...over
  }
}

async function threeValues(pk) {
  await pk.renderFromPanelCtx({ kind: 'new', ctx: ctxWith([cellPick(0, 1), cellPick(1, 1), cellPick(2, 1)]) })
}

test('F 多值表單有「拆成每個值一個任務」', async () => {
  const { pk, doc } = await fresh()
  await threeValues(pk)
  const btn = doc.getElementById('split-tasks')
  assert.ok(btn)
  assert.equal(btn.hidden, false)
  assert.match(btn.textContent, /拆成每個值一個任務/)
})

test('F 只有一個值時不顯示（沒東西可拆）', async () => {
  const { pk, doc } = await fresh()
  await pk.renderFromPanelCtx({ kind: 'new', ctx: ctxWith([cellPick(0, 1)]) })
  assert.equal(doc.getElementById('split-tasks').hidden, true)
})

test('F 編輯既有任務時不顯示（拆了會變成新任務、原任務還在）', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveTask({
    id: 't1', name: '匯率', url: 'https://a.test/p', mode: 'block', enabled: true, locator: LOCATOR,
    fields: [{ key: 'k1', name: '一' }, { key: 'k2', name: '二' }],
    spec: { mode: 'block', fields: [{ key: 'k1', ...cellPick(0, 1) }, { key: 'k2', ...cellPick(1, 1) }] },
    schedule: { type: 'daily', times: ['09:00'] }
  })
  await pk.renderFromPanelCtx({ kind: 'edit', taskId: 't1' })
  assert.equal(doc.getElementById('split-tasks').hidden, true)
})

test('F 按下去把每個值變成一個任務的清單，名稱照使用者改過的', async () => {
  const { pk, doc } = await fresh()
  await threeValues(pk)
  const rows = doc.querySelectorAll('#field-list [data-field-row]')
  rows[1].querySelector('input[data-field-name]').value = '庫存'
  const names = Array.from(rows).map(r => r.querySelector('input[data-field-name]').value)
  doc.getElementById('split-tasks').click()
  await tick()

  const ctx = await sessionOf(9)
  assert.equal(ctx.kind, 'batch')
  assert.equal(ctx.items.length, 3)
  const specs = Array.from(rows).map(r => r._spec)
  ctx.items.forEach((it, i) => {
    assert.equal(it.picks.length, 1, '每個任務只帶一個值')
    assert.deepEqual(it.picks[0], specs[i], '帶的就是那一列的規格')
    assert.deepEqual(it.locator, LOCATOR, '共同欄位要帶過去，否則存出來的任務沒有定位')
    assert.equal(it.url, 'https://a.test/p')
    assert.equal(it.tabId, 9)
    assert.ok(!('preview' in it), '整批的預覽不屬於任何單一個值')
    assert.ok(!('previewValue' in it))
    assert.ok(!('previewSamples' in it))
  })
  assert.deepEqual(ctx.items.map(it => ctx.draft.batchNames[it.key]), names, '名稱要原樣帶過去')
})

test('F 拆完之後共用的排程要帶過去', async () => {
  const { pk, doc, win } = await fresh()
  await threeValues(pk)
  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new win.Event('change', { bubbles: true }))
  doc.getElementById('every-minutes').value = '20'
  doc.getElementById('split-tasks').click()
  await tick()
  const ctx = await sessionOf(9)
  assert.equal(ctx.draft['schedule-type'], 'interval')
  assert.equal(ctx.draft['every-minutes'], '20')
})

test('F 拆完的清單畫出來是三列、名稱正確、排程沒變', async () => {
  const { pk, doc, win } = await fresh()
  await threeValues(pk)
  doc.querySelectorAll('#field-list [data-field-row]')[0].querySelector('input[data-field-name]').value = '美金'
  doc.getElementById('schedule-type').value = 'interval'
  doc.getElementById('schedule-type').dispatchEvent(new win.Event('change', { bubbles: true }))
  doc.getElementById('split-tasks').click()
  await tick()
  await pk.renderFromPanelCtx(await sessionOf(9))

  const list = doc.querySelectorAll('#batch-list [data-batch-item]')
  assert.equal(list.length, 3)
  assert.equal(list[0].querySelector('input').value, '美金')
  assert.equal(doc.getElementById('schedule-type').value, 'interval')
})

test('F 拆完之後全部儲存，每個任務都有定位與各自那一個值', async () => {
  const { st, pk, doc } = await fresh()
  await threeValues(pk)
  doc.getElementById('split-tasks').click()
  await tick()
  await pk.renderFromPanelCtx(await sessionOf(9))
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 3, '三個值變成三個任務')
  for (const t of tasks) {
    assert.deepEqual(t.locator, LOCATOR, '拆出來的任務沒有 locator 就抓不到東西')
  }
})

test('F 超過 20 個值時不能拆，點了要說原因', async () => {
  const { pk, doc } = await fresh()
  const picks = Array.from({ length: 21 }, (_, i) => cellPick(i, 1))
  const ctx = { kind: 'new', ctx: ctxWith(picks, { blockInfo: { kind: 'table', rows: 30, cols: 4 } }) }
  // session 先放著這份表單：真的拆了就會被蓋成 batch，斷言才有意義
  await chrome.storage.session.set({ 'panel:9': ctx })
  await pk.renderFromPanelCtx(ctx)
  const btn = doc.getElementById('split-tasks')
  assert.equal(btn.getAttribute('aria-disabled'), 'true')
  btn.click()
  await tick()
  assert.equal((await sessionOf(9)).kind, 'new', '不得拆')
  assert.match(doc.getElementById('field-rename').textContent + doc.getElementById('errors').textContent, /一次最多 20 個任務/)
})
