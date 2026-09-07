// AF-7 批次 B:「立即測試」改走背景（與正式抓取同一條路徑，會重新定位 frame 並重新注入）
// 對照 docs/AF-7-PLAN.md 批次 B 的驗收 B-1 ~ B-4。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { MSG } from '../src/shared/messages.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function freshPicker() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, pk, doc: jd.window.document }
}

const runtimeMsgs = (c) => c.__calls.filter(x => x.api === 'runtime.sendMessage').map(x => x.args[0])
const tabMsgs = (c) => c.__calls.filter(x => x.api === 'tabs.sendMessage').map(x => x.args)

function fillForm(doc) {
  doc.getElementById('name').value = '客戶區連線數'
  doc.getElementById('url').value = 'https://x.example/mon'
}

// ---------- B-1 Picker 端 ----------

test('B-1 訊息型別 TEST_TASK 存在', () => {
  assert.equal(MSG.TEST_TASK, 'TEST_TASK')
})

test('B-1 立即測試改送 TEST_TASK 給背景，不再直接對頁面送 EXTRACT', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, frameId: 7, frameUrl: 'https://b.example/w.html', locator: { css: '#v' } })
  fillForm(doc)
  c.__setRuntimeResponder(() => ({ ok: true, value: 42, raw: '42' }))
  await pk.handleTestNow()
  assert.equal(tabMsgs(c).length, 0, '不得自己對頁面送訊息（content script 可能已經不在了）')
  const msg = runtimeMsgs(c).find(m => m?.type === 'TEST_TASK')
  assert.ok(msg, `要送 TEST_TASK，實得 ${JSON.stringify(runtimeMsgs(c))}`)
  assert.equal(msg.tabId, 3, '要告訴背景在哪個分頁上測')
  assert.deepEqual(msg.task.frame, { url: 'https://b.example/w.html' }, '目標在 iframe 內要帶著 frame')
  assert.deepEqual(msg.task.locator, { css: '#v' })
})

test('B-1 送出的規格與 buildSpec 一致（不得另組一份）', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' } })
  fillForm(doc)
  doc.getElementById('mode').value = 'text'
  c.__setRuntimeResponder(() => ({ ok: true, value: 1, raw: '1' }))
  await pk.handleTestNow()
  const msg = runtimeMsgs(c).find(m => m?.type === 'TEST_TASK')
  assert.deepEqual(msg.task.spec, pk.buildSpec(pk.getFormData()))
})

test('B-1 目標在最上層時不得帶 frame 欄位', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' } })
  fillForm(doc)
  c.__setRuntimeResponder(() => ({ ok: true, value: 1, raw: '1' }))
  await pk.handleTestNow()
  const msg = runtimeMsgs(c).find(m => m?.type === 'TEST_TASK')
  assert.equal('frame' in msg.task, false)
})

test('B-1 成功時預覽顯示值、錯誤區清空', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' } })
  fillForm(doc)
  c.__setRuntimeResponder(() => ({ ok: true, value: 42, raw: '42' }))
  await pk.handleTestNow()
  assert.equal(doc.getElementById('preview').textContent, '42')
  assert.equal(doc.getElementById('errors').textContent, '')
})

test('B-1 失敗時錯誤只顯示一次', async () => {
  const { c, pk, doc } = await freshPicker()
  pk.render({ tabId: 3, locator: { css: '#v' } })
  fillForm(doc)
  c.__setRuntimeResponder(() => ({ ok: false, error: '找不到目標所在的框架' }))
  await pk.handleTestNow()
  const body = doc.body.textContent
  const hits = body.split('找不到目標所在的框架').length - 1
  assert.equal(hits, 1, `錯誤訊息只能出現一次，實得 ${hits} 次`)
  assert.equal(doc.getElementById('errors').textContent, '找不到目標所在的框架')
  assert.equal(doc.getElementById('preview').textContent, '—')
})

test('B-1 多值任務逐值顯示', async () => {
  const { c, pk, doc } = await freshPicker()
  const CELL = (r, c2) => ({ row: { index: r, header: `列${r}` }, col: { index: c2, header: `欄${c2}` } })
  pk.render({
    tabId: 3, locator: { css: '#t' },
    picks: [{ cell: CELL(0, 0) }, { cell: CELL(0, 1) }]
  })
  fillForm(doc)
  c.__setRuntimeResponder(() => ({
    ok: true,
    fields: {}
  }))
  const keys = Array.from(doc.querySelectorAll('#field-list [data-field-row]')).map(r => r.dataset.fieldKey)
  c.__setRuntimeResponder(() => ({
    ok: true,
    fields: { [keys[0]]: { ok: true, value: 42 }, [keys[1]]: { ok: false, error: 'parse_error' } }
  }))
  await pk.handleTestNow()
  const text = doc.getElementById('preview').textContent
  assert.ok(text.includes('42'), `第一個值要顯示，實得 ${JSON.stringify(text)}`)
  assert.ok(text.includes('parse_error'), `失敗的值要說原因，實得 ${JSON.stringify(text)}`)
})

// ---------- B-2 背景端 ----------

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await import('../src/background/main.js?t=' + Math.random())
  return { c, st }
}

function sendTo(c, msg, sender = {}) {
  const listener = [...c.runtime.onMessage._listeners][0]
  return new Promise((resolve, reject) => {
    const ret = listener(msg, sender, resolve)
    if (ret !== true) reject(new Error('onMessage 必須回傳 true'))
  })
}

const TEST_TASK_MSG = {
  type: 'TEST_TASK',
  tabId: 3,
  task: {
    id: '__test', name: '測試', url: 'https://x.example/mon', order: 1, enabled: true,
    mode: 'block', locator: { css: '#v' },
    spec: { mode: 'block', strategy: 'self', block: { cell: { row: { index: 0, header: 'a' }, col: { index: 1, header: 'b' } } } }
  }
}

// 紀錄／任務／帳本三種鍵，診斷環形緩衝（diag）不算
async function dataSnapshot(c) {
  const all = await c.storage.local.get(null)
  const kept = {}
  for (const [k, v] of Object.entries(all)) {
    if (k === 'diag') continue
    kept[k] = v
  }
  return JSON.stringify(kept)
}

test('B-2 背景以 dryRun 執行，不寫任何紀錄或任務', async () => {
  const { c, st } = await freshBg()
  c.__setTabResponder(() => ({ ok: true, value: 42, raw: '42', status: 'ok' }))
  const before = await dataSnapshot(c)
  const res = await sendTo(c, TEST_TASK_MSG)
  assert.equal(res.ok, true, `應回傳結果，實得 ${JSON.stringify(res)}`)
  assert.equal(res.value, 42)
  const after = await dataSnapshot(c)
  assert.equal(after, before, '不得寫紀錄、不得存任務、不得進帳本')
  const tasks = await st.getTasks()
  assert.equal(tasks.find(t => t.id === '__test'), undefined, '測試用的暫時任務不得被存起來')
})

test('B-2 背景會重新注入 content script 再擷取', async () => {
  const { c } = await freshBg()
  c.__setTabResponder(() => ({ ok: true, value: 1, raw: '1', status: 'ok' }))
  await sendTo(c, TEST_TASK_MSG)
  const injected = c.__calls.filter(x => x.api === 'scripting.executeScript')
  assert.ok(injected.length > 0, '一定要重新注入，頁面可能已經重新整理過')
  const extract = c.__calls
    .filter(x => x.api === 'tabs.sendMessage')
    .map(x => x.args[1])
    .find(m => m?.type === 'EXTRACT')
  assert.ok(extract, '要送 EXTRACT')
})

test('B-2 擷取失敗時回傳錯誤而不是丟例外', async () => {
  const { c } = await freshBg()
  c.__setTabResponder(() => ({ ok: false, error: 'not_found' }))
  const res = await sendTo(c, TEST_TASK_MSG)
  assert.equal(res.ok, false)
  assert.ok(res.error, '要說出原因')
})

test('B-2 任務形狀不完整時直接回錯，不得開分頁', async () => {
  const { c } = await freshBg()
  const res = await sendTo(c, { type: 'TEST_TASK', tabId: 3, task: { name: '缺東缺西' } })
  assert.equal(res.ok, false)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0)
})

// ---------- B-3 fetcher 沿用指定分頁 ----------

test('B-3 有指定 tabId 時沿用那個分頁，不再用網址找', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const { runTask } = await import('../src/background/fetcher.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: 'https://x.example/mon' })
  c.__setTabResponder(() => ({ ok: true, value: 7, raw: '7', status: 'ok' }))
  const createdBefore = c.__calls.filter(x => x.api === 'tabs.create').length
  const res = await runTask({ ...TEST_TASK_MSG.task }, { dryRun: true, reason: 'manual', tabId: tab.id, extraDelayMs: 0 })
  assert.equal(res.ok, true, `應抓得到值，實得 ${JSON.stringify(res)}`)
  assert.equal(res.value, 7)
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, createdBefore, '不得另開分頁')
  const queries = c.__calls.filter(x => x.api === 'tabs.query' && x.args[0]?.url)
  assert.equal(queries.length, 0, '已經指名分頁就不必再用網址找')
})

test('B-3 指定的分頁已經不在時，退回原本的找分頁流程', async () => {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const { runTask } = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder(() => ({ ok: true, value: 7, raw: '7', status: 'ok' }))
  const res = await runTask({ ...TEST_TASK_MSG.task }, { dryRun: true, reason: 'manual', tabId: 999999, extraDelayMs: 0 })
  assert.equal(res.ok, true, `分頁不見了要自己開一個，實得 ${JSON.stringify(res)}`)
  assert.ok(c.__calls.some(x => x.api === 'tabs.create'), '要自己開分頁')
})
