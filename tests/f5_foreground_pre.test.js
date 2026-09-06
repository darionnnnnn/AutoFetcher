// AF-3 批次 F:前景抓取(D9)、任務級額外等待(D11)、前置動作(SPEC §4)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extractTimeoutMs: 200 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  return { c, st, fe }
}

const task = (over = {}) => ({
  id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const sentTypes = (c) => c.__calls
  .filter(x => x.api === 'tabs.sendMessage')
  .map(x => x.args[1]?.type)

// ---- 前景抓取(D9:過去 suggestForeground 有寫沒讀,foreground 也沒人尊重) ----

test('預設仍是背景分頁', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-06T09:00', extraDelayMs: 0, ...FAST })
  assert.equal(c.__calls.find(x => x.api === 'tabs.create').args[0].active, false)
})

test('foreground 為真時開前景分頁,抓完把焦點還給原本的分頁', async () => {
  const { c, st, fe } = await fresh()
  const original = await c.tabs.create({ url: 'https://other.test/', active: true })
  const t = task({ foreground: true })
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-06T09:00', extraDelayMs: 0, ...FAST })

  const created = c.__calls.filter(x => x.api === 'tabs.create')
  assert.equal(created[created.length - 1].args[0].active, true, '要切到前景,lazy-load 的頁面才會動')
  const restored = c.__calls.filter(x => x.api === 'tabs.update')
    .filter(x => x.args[1]?.active === true)
  assert.ok(restored.length > 0, '抓完要把焦點還回去,不能停在別人的頁面上')
  assert.equal(restored[restored.length - 1].args[0], original.id)
})

test('連續兩次找不到元素後建議改用前景,成功一次就把建議清掉', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  c.__setTabResponder(() => ({ ok: false, error: 'not_found', snippet: 'x' }))
  await fe.runTask(task(), { slot: '2026-09-06T09:00', attempt: 3, extraDelayMs: 0, ...FAST })
  await fe.runTask(task(), { slot: '2026-09-06T10:00', attempt: 3, extraDelayMs: 0, ...FAST })
  assert.equal((await st.getTask('t1')).suggestForeground, true)

  c.__setTabResponder(() => ({ ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }))
  await fe.runTask(task(), { slot: '2026-09-06T11:00', extraDelayMs: 0, ...FAST })
  const after = await st.getTask('t1')
  assert.ok(!after.suggestForeground, '問題解決了就不該一直提示')
})

test('任務頁看得到建議,按一下就切成前景抓取', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'https://x/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ts = await import('../src/ui/report/tasks.js?t=' + Math.random())

  await st.saveTask(task({ suggestForeground: true }))
  ts.renderTasks([task({ suggestForeground: true })], {}, [])
  const row = jd.window.document.querySelector('[data-task-id="t1"]')
  assert.ok(/前景/.test(row.textContent), `要提示改用前景抓取,實得:${row.textContent}`)
  const btn = row.querySelector('[data-action="use-foreground"]')
  assert.ok(btn, '要有一鍵切換的按鈕')
  btn.click()
  await new Promise(r => setTimeout(r, 40))
  assert.equal((await st.getTask('t1')).foreground, true)
})

// ---- 額外等待(D11:偏好存了沒人讀) ----

test('沒有指定時採用全域偏好的額外等待秒數', async () => {
  const { c, st, fe } = await fresh()
  await st.saveSettings({ extraDelaySec: 0 })
  await st.saveTask(task())
  const started = Date.now()
  await fe.runTask(task(), { slot: '2026-09-06T09:00', ...FAST })
  assert.ok(Date.now() - started < 1500, '偏好設 0 秒就不該還等 3 秒(過去這個偏好沒人讀)')
})

test('任務層級的設定蓋過全域偏好', async () => {
  const { st, fe } = await fresh()
  await st.saveSettings({ extraDelaySec: 30 })
  const t = task({ extraDelaySec: 0 })
  await st.saveTask(t)
  const started = Date.now()
  await fe.runTask(t, { slot: '2026-09-06T09:00', ...FAST })
  assert.ok(Date.now() - started < 1500, '任務自己設 0 就是 0')
})

test('呼叫端明確給了 extraDelayMs 時最優先(測試與預檢要能加速)', async () => {
  const { st, fe } = await fresh()
  await st.saveSettings({ extraDelaySec: 30 })
  const t = task({ extraDelaySec: 30 })
  await st.saveTask(t)
  const started = Date.now()
  await fe.runTask(t, { slot: '2026-09-06T09:00', extraDelayMs: 0, ...FAST })
  assert.ok(Date.now() - started < 1500)
})

// ---- 前置動作 ----

test('前置動作在擷取之前執行', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'wait', ms: 1 }] })
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-06T09:00', extraDelayMs: 0, ...FAST })
  const types = sentTypes(c)
  const pre = types.indexOf('RUN_PRE_ACTIONS')
  const scroll = types.indexOf('SCROLL_INTO_VIEW')
  assert.ok(pre >= 0, `必須送出前置動作,實得 ${types.join(',')}`)
  assert.ok(pre < scroll, '前置動作要在捲動與擷取之前(彈窗沒關掉就找不到元素)')
})

test('沒有前置動作的任務不送這則訊息', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-06T09:00', extraDelayMs: 0, ...FAST })
  assert.ok(!sentTypes(c).includes('RUN_PRE_ACTIONS'))
})

test('前置動作失敗時寫錯誤紀錄,不當成抓到值', async () => {
  const { c, st, fe } = await fresh()
  const t = task({ preActions: [{ type: 'waitFor', locator: { css: '#nope' }, timeoutMs: 5 }] })
  await st.saveTask(t)
  c.__setTabResponder((tabId, msg) => {
    if (msg.type === 'RUN_PRE_ACTIONS') return { ok: false, error: 'preaction_timeout' }
    return { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
  })
  const rec = await fe.runTask(t, { slot: '2026-09-06T09:00', attempt: 3, extraDelayMs: 0, ...FAST })
  assert.equal(rec.status, 'error')
  assert.equal(rec.value, undefined)
  assert.ok(String(rec.error).includes('preaction') || String(rec.error).includes('前置'),
    `錯誤要說明是前置動作失敗,實得:${rec.error}`)
})

// ---- content 端的前置動作 ----

async function contentSetup(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  globalThis.MutationObserver = jd.window.MutationObserver
  globalThis.__afContentLoaded = false
  await import('../src/content/main.js?t=' + Math.random())
  const listener = [...c.runtime.onMessage._listeners][0]
  const send = (msg) => new Promise((resolve) => listener(msg, {}, resolve))
  return { c, doc: jd.window.document, send }
}

test('wait:等指定毫秒後回成功', async () => {
  const { send } = await contentSetup('<div id="v">1</div>')
  const res = await send({ type: 'RUN_PRE_ACTIONS', actions: [{ type: 'wait', ms: 5 }] })
  assert.equal(res.ok, true)
})

test('click:真的點到那個元素', async () => {
  const { doc, send } = await contentSetup('<button id="close">關閉</button><div id="v">1</div>')
  let clicked = false
  doc.getElementById('close').addEventListener('click', () => { clicked = true })
  const res = await send({ type: 'RUN_PRE_ACTIONS', actions: [{ type: 'click', locator: { css: '#close' } }] })
  assert.equal(res.ok, true)
  assert.equal(clicked, true)
})

test('click:元素不存在時回失敗,不要默默跳過', async () => {
  const { send } = await contentSetup('<div id="v">1</div>')
  const res = await send({ type: 'RUN_PRE_ACTIONS', actions: [{ type: 'click', locator: { css: '#nope' } }] })
  assert.equal(res.ok, false)
})

test('waitFor:元素已經在了就立刻成功', async () => {
  const { send } = await contentSetup('<div id="late">來了</div>')
  const res = await send({ type: 'RUN_PRE_ACTIONS', actions: [{ type: 'waitFor', locator: { css: '#late' }, timeoutMs: 50 }] })
  assert.equal(res.ok, true)
})

test('waitFor:元素稍後才出現也等得到(不是只看當下)', async () => {
  const { doc, send } = await contentSetup('<div id="v">1</div>')
  setTimeout(() => {
    const el = doc.createElement('div')
    el.id = 'late'
    doc.body.appendChild(el)
  }, 20)
  const res = await send({ type: 'RUN_PRE_ACTIONS', actions: [{ type: 'waitFor', locator: { css: '#late' }, timeoutMs: 400 }] })
  assert.equal(res.ok, true)
})

test('waitFor:逾時回 preaction_timeout', async () => {
  const { send } = await contentSetup('<div id="v">1</div>')
  const res = await send({ type: 'RUN_PRE_ACTIONS', actions: [{ type: 'waitFor', locator: { css: '#nope' }, timeoutMs: 20 }] })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'preaction_timeout')
})

test('多個動作照順序執行,前一個失敗就不做後面的', async () => {
  const { doc, send } = await contentSetup('<button id="b">x</button><div id="v">1</div>')
  let clicked = false
  doc.getElementById('b').addEventListener('click', () => { clicked = true })
  const res = await send({
    type: 'RUN_PRE_ACTIONS',
    actions: [
      { type: 'waitFor', locator: { css: '#nope' }, timeoutMs: 10 },
      { type: 'click', locator: { css: '#b' } }
    ]
  })
  assert.equal(res.ok, false)
  assert.equal(clicked, false, '前面已經失敗就不該再往下做')
})

// ---- Picker:前置動作的設定介面 ----

async function picker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

test('Picker 有前置動作區,可以新增一條', async () => {
  const { pk, doc } = await picker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1' })
  assert.ok(doc.getElementById('preaction-section'), '必須有前置動作區')
  const add = doc.getElementById('preaction-add')
  assert.ok(add, '要有新增按鈕')
  add.click()
  const rows = doc.querySelectorAll('[data-preaction-row]')
  assert.equal(rows.length, 1)
  const types = [...rows[0].querySelectorAll('select option')].map(o => o.value)
  for (const t of ['waitFor', 'click', 'wait']) {
    assert.ok(types.includes(t), `缺少動作型別 ${t},實得 ${types.join(',')}`)
  }
})

test('前置動作存進 task.preActions,順序照畫面上的順序', async () => {
  const { pk } = await picker()
  const t = pk.buildTask(
    { name: '電費', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6],
      preActions: [
        { type: 'click', locator: { css: '#close' } },
        { type: 'wait', ms: 2000 }
      ] },
    { css: '#v' }
  )
  assert.equal(t.preActions.length, 2)
  assert.equal(t.preActions[0].type, 'click')
  assert.equal(t.preActions[1].ms, 2000)
})

test('沒有前置動作時任務上不得多出這個鍵', async () => {
  const { pk } = await picker()
  const t = pk.buildTask(
    { name: '電費', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6], preActions: [] },
    { css: '#v' }
  )
  assert.equal(t.preActions, undefined)
})

test('需要點元素的動作沒指定元素時不得存進去', async () => {
  const { pk } = await picker()
  const t = pk.buildTask(
    { name: '電費', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6],
      preActions: [
        { type: 'click', locator: null },
        { type: 'waitFor', locator: { css: '#ok' }, timeoutMs: 20000 }
      ] },
    { css: '#v' }
  )
  assert.equal(t.preActions.length, 1, `沒選元素的動作留著只會在抓取時失敗,實得 ${JSON.stringify(t.preActions)}`)
  assert.equal(t.preActions[0].type, 'waitFor')
})

test('等待秒數沒填數字的動作也不得存進去', async () => {
  const { pk } = await picker()
  const t = pk.buildTask(
    { name: '電費', url: 'https://a.test/p', mode: 'number', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6],
      preActions: [
        { type: 'wait', ms: '' },
        { type: 'wait', ms: 'abc' },
        { type: 'wait', ms: 1500 }
      ] },
    { css: '#v' }
  )
  assert.equal(t.preActions.length, 1, `空白或非數字的等待沒有意義,實得 ${JSON.stringify(t.preActions)}`)
  assert.equal(t.preActions[0].ms, 1500)
})

test('編輯既有任務時前置動作要顯示出來', async () => {
  const { pk, doc } = await picker()
  pk.render({
    locator: { css: '#v' }, url: 'https://a.test/p', preview: '1',
    task: {
      id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number',
      locator: { css: '#v' }, spec: { strategy: 'auto' },
      schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
      preActions: [{ type: 'click', locator: { css: '#close' } }, { type: 'wait', ms: 1500 }]
    }
  })
  const rows = doc.querySelectorAll('[data-preaction-row]')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].querySelector('select').value, 'click')
  assert.equal(rows[1].querySelector('select').value, 'wait')
})

test('按「在頁面上選取」會請 background 到目標分頁啟動選取模式', async () => {
  const { c, pk, doc } = await picker()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1', tabId: 9 })
  doc.getElementById('preaction-add').click()
  const row = doc.querySelector('[data-preaction-row]')
  row.querySelector('select').value = 'click'
  row.querySelector('select').dispatchEvent(new globalThis.window.Event('change'))
  const btn = row.querySelector('[data-action="preaction-pick"]')
  assert.ok(btn, '需要點元素的動作要有「在頁面上選取」按鈕')
  btn.click()
  await new Promise(r => setTimeout(r, 30))
  const msgs = c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
  const enter = msgs.find(m => m?.type === 'ENTER_PICK')
  assert.ok(enter, `要送 ENTER_PICK,實得 ${JSON.stringify(msgs)}`)
  assert.equal(enter.purpose, 'preaction')
  assert.equal(enter.tabId, 9, '要指定原本那個目標分頁')
})
