// AF-21 批次 4-B：Picker 守門接到批次與欄位、存檔後立刻抓第一筆、排程預設只留一份、固定列兩層與五項小修。
// 契約在 tests/zd1_save_guard.test.js（Claude 寫）；本檔補規格驗收 2 列的其餘項目。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const api = (c, name) => c.__calls.filter(x => x.api === name)
const runtimeMsgs = (c) => api(c, 'runtime.sendMessage').map(x => x.args[0])
const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]' }
const URL_ = 'https://rate.test/p'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

// 真正的面板：走正式接線（網址帶 tabId 的退路入口），面板知道自己服務哪個分頁、session 一寫就照 ctx 重畫。
// chrome.runtime.id 只在匯入那一刻存在（正式接線只在載入時判斷），之後拿掉，免得污染同檔其他測試
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
  return { c, st, pk, doc, win: jd.window }
}

// 帳本（runs）與紀錄（rec）鍵：存檔後的第一筆是手動性質，picker 端不得寫任何一筆
async function ledgerKeys() {
  const all = await chrome.storage.local.get(null)
  return Object.keys(all).filter(k => /^(runs|rec)/.test(k))
}

// ---------------- 守門：批次指名哪一組 ----------------

test('批次 3 組其中第 2 組沒有目標：原因指名第 2 組、零寫入、儲存鈕不 disabled', async () => {
  const { st, pk, doc } = await fresh()
  const items = [
    { key: 'b1', locator: { css: '#a' }, url: URL_, tabId: 9, nameHint: '甲', picks: [{ locator: { css: '#a' } }] },
    { key: 'b2', url: URL_, tabId: 9, nameHint: '乙', picks: [] },
    { key: 'b3', locator: { css: '#c' }, url: URL_, tabId: 9, nameHint: '丙', picks: [{ locator: { css: '#c' } }] }
  ]
  await pk.renderFromPanelCtx({ kind: 'batch', items })
  const before = JSON.stringify(await chrome.storage.local.get(null))
  await pk.handleSave()
  assert.deepEqual(await st.getTasks(), [], '有一組沒有目標就一個都不得存（不得存出前一組再停下）')
  assert.equal(JSON.stringify(await chrome.storage.local.get(null)), before, '零寫入')
  const box = doc.getElementById('errors')
  assert.equal(box.hidden, false)
  const reasons = [...box.querySelectorAll('button')].map(b => b.textContent)
  assert.equal(reasons.length, 1, `只有第 2 組有問題，實得 ${JSON.stringify(reasons)}`)
  assert.match(reasons[0], /第 2 組/)
  assert.match(reasons[0], /還沒選要抓的內容/)
  assert.ok(box.contains(doc.activeElement), '焦點要在原因上')
  assert.equal(doc.getElementById('save').hasAttribute('disabled'), false)
  assert.match(doc.getElementById('save-missing').textContent, /還差 1 項/)
})

// ---------------- 守門：欄位離開焦點就地驗證 ----------------

test('名稱欄 blur 時就地驗證：錯誤字在名稱欄下方、aria-describedby 對得上；補好後清掉', async () => {
  const { pk, doc, win } = await fresh()
  pk.render({ locator: LOCATOR, url: URL_ })
  const nameEl = doc.getElementById('name')
  nameEl.value = '  '
  nameEl.dispatchEvent(new win.FocusEvent('blur'))
  const describedBy = nameEl.getAttribute('aria-describedby')
  assert.ok(describedBy, '要有 aria-describedby')
  const errEl = doc.getElementById(describedBy)
  assert.ok(errEl, 'aria-describedby 要指到存在的元素')
  assert.equal(errEl.hidden, false)
  assert.match(errEl.textContent, /名稱/)
  assert.equal(nameEl.nextElementSibling, errEl, '錯誤字就在名稱欄正下方')
  assert.equal(nameEl.getAttribute('aria-invalid'), 'true')
  assert.equal(doc.getElementById('errors').hidden, true, '還沒按儲存，不必把原因區打開')

  nameEl.value = '好了'
  nameEl.dispatchEvent(new win.FocusEvent('blur'))
  assert.equal(errEl.hidden, true)
  assert.equal(nameEl.getAttribute('aria-invalid'), null)
  assert.equal(nameEl.getAttribute('aria-describedby'), null)
})

// ---------------- 存檔後立刻抓第一筆 ----------------

test('新建任務存檔：恰好送一次 RUN_TASK、帳本零寫入、回饋先「正在抓第一筆」再換成值、面板 ctx 的 saved 帶著結果', async () => {
  const tabId = 7
  const { c, st, pk, doc } = await freshPanel(tabId, { kind: 'new', ctx: { locator: LOCATOR, url: URL_, tabId } })
  assert.ok(doc.getElementById('name').value, '前置：面板照 session 畫出新建表單')
  let during = null
  c.__setRuntimeResponder((msg) => {
    if (msg?.type !== 'RUN_TASK') return undefined
    during = doc.getElementById('saved-feedback')?.textContent ?? ''
    return { ok: true, outcome: 'done', status: 'ok', value: 31.52 }
  })
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 1)
  const runs = runtimeMsgs(c).filter(m => m?.type === 'RUN_TASK')
  assert.equal(runs.length, 1, '恰好一次')
  assert.equal(runs[0].taskId, tasks[0].id, '抓的是剛存好的那一個')
  assert.deepEqual(await ledgerKeys(), [], '帳本與紀錄零寫入（手動性質交給 background）')
  assert.match(during || '', /已儲存，正在抓第一筆/, `送出 RUN_TASK 當下回饋區要先說正在抓，實得 ${JSON.stringify(during)}`)
  const line = doc.querySelector('#saved-feedback [data-saved-first]')
  assert.ok(line, '回饋區要有第一筆那一行')
  assert.equal(line.textContent, '第一筆：31.52')

  const saved = await st.getPanelCtx(tabId)
  assert.equal(saved.kind, 'saved')
  assert.equal(saved.first?.text, '第一筆：31.52', '結果要寫進 ctx，不能只 append 在 DOM 上')
  assert.equal(saved.first?.state, 'ok')

  // session 一寫面板就照 ctx 重畫：等訂閱觸發的重畫跑完，字還在
  await sleep(40)
  assert.equal(doc.querySelector('#saved-feedback [data-saved-first]')?.textContent, '第一筆：31.52', '重畫後文字仍在')
  // 面板文件被重載（新的一份文件照 session 畫）也要畫得回來
  const re = await fresh()
  await re.pk.renderFromPanelCtx(saved)
  assert.equal(re.doc.querySelector('#saved-feedback [data-saved-first]')?.textContent, '第一筆：31.52')
  assert.equal(api(c, 'runtime.sendMessage').some(x => x.args[0]?.type === 'CLOSE_PANEL'), false, '成功也要讓使用者看一眼（4 秒後才關）')
})

test('新建任務第一筆失敗：說原因與下一步、不自動關、ctx 帶著失敗', async () => {
  const tabId = 8
  const { c, st, pk, doc } = await freshPanel(tabId, { kind: 'new', ctx: { locator: LOCATOR, url: URL_, tabId } })
  c.__setRuntimeResponder((msg) => msg?.type === 'RUN_TASK'
    ? { ok: true, outcome: 'failed', status: 'error', error: '找不到這個元素' }
    : undefined)
  await pk.handleSave()
  const text = doc.querySelector('#saved-feedback [data-saved-first]')?.textContent || ''
  assert.match(text, /找不到這個元素/)
  assert.match(text, /開啟報表.*立即抓取/, '要給下一步')
  const saved = await st.getPanelCtx(tabId)
  assert.equal(saved.first?.state, 'error')
  assert.match(saved.first?.text || '', /找不到這個元素/)
})

test('編輯既有任務存檔不送 RUN_TASK', async () => {
  const { c, st, pk } = await fresh()
  const task = {
    id: 't-edit', name: '既有', url: URL_, mode: 'number', enabled: true, locator: LOCATOR,
    spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:30'], weekdays: [1, 2, 3] }
  }
  await st.saveTask(task)
  await pk.renderFromPanelCtx({ kind: 'edit', taskId: task.id })
  await pk.handleSave()
  assert.equal((await st.getTasks())[0].name, '既有', '前置：真的存了')
  assert.equal(runtimeMsgs(c).filter(m => m?.type === 'RUN_TASK').length, 0)
})

test('RUN_TASK 被拒絕（sendMessage 丟例外）或回 ok:false：回饋區都有字', async () => {
  for (const mode of ['throw', 'not-ok']) {
    const { c, pk, doc } = await fresh()
    pk.render({ locator: LOCATOR, url: URL_ })
    c.__setRuntimeResponder((msg) => {
      if (msg?.type !== 'RUN_TASK') return undefined
      if (mode === 'throw') throw new Error('Could not establish connection')
      return { ok: false, outcome: 'failed', error: '找不到任務' }
    })
    await pk.handleSave()
    const line = doc.querySelector('#saved-feedback [data-saved-first]')
    assert.equal(line?.textContent, '抓取被中斷，請再試一次', `${mode}：實得 ${JSON.stringify(line?.textContent)}`)
  }
})

// ---------------- 批次試抓中按儲存 ----------------

test('批次全部試抓進行中按儲存：零寫入、就地說明、儲存鈕沒有 disabled 屬性；試抓完恢復', async () => {
  const { c, st, pk, doc } = await fresh()
  const items = [
    { key: 'b1', locator: { css: '#a' }, url: URL_, tabId: 9, nameHint: '甲', picks: [{ locator: { css: '#a' } }] },
    { key: 'b2', locator: { css: '#b' }, url: URL_, tabId: 9, nameHint: '乙', picks: [{ locator: { css: '#b' } }] }
  ]
  await pk.renderFromPanelCtx({ kind: 'batch', items })
  let release
  const gate = new Promise(r => { release = r })
  c.__setRuntimeResponder(async (msg) => {
    if (msg?.type !== 'TEST_TASK') return undefined
    await gate
    return { ok: true, value: 1, raw: '1', status: 'ok' }
  })
  const testing = pk.handleTestNow()
  await sleep(10)
  const save = doc.getElementById('save')
  assert.equal(save.getAttribute('aria-disabled'), 'true', '前置：試抓中')
  const before = JSON.stringify(await chrome.storage.local.get(null))
  await pk.handleSave()
  assert.equal(JSON.stringify(await chrome.storage.local.get(null)), before, '零寫入')
  assert.deepEqual(await st.getTasks(), [])
  assert.match(doc.getElementById('errors').textContent, /試抓進行中，完成後才能儲存/)
  assert.equal(doc.getElementById('errors').hidden, false)
  assert.equal(save.hasAttribute('disabled'), false, '不得用原生 disabled（點了完全沒回饋）')
  release()
  await testing
  assert.equal(save.getAttribute('aria-disabled'), null, '試抓完恢復')
  assert.equal(doc.getElementById('errors').hidden, true, '試抓完那句說明就不成立了')
})

// ---------------- 排程預設只留一份 ----------------

test('新建任務的星期預設是每天（HTML 不寫死勾選；render 與面板入口都一樣）', async () => {
  assert.doesNotMatch(PICKER_HTML.match(/<div id="weekdays"[\s\S]*?<\/div>/)[0], /checked/, 'picker.html 的星期不得寫死勾選')
  const days = (doc) => [...doc.querySelectorAll('#weekdays input:checked')].map(cb => cb.value).sort()
  const a = await fresh()
  a.pk.render({ locator: LOCATOR, url: URL_ })
  assert.deepEqual(days(a.doc), ['0', '1', '2', '3', '4', '5', '6'])
  const b = await fresh()
  await b.pk.renderFromPanelCtx({ kind: 'new', ctx: { locator: LOCATOR, url: URL_, tabId: 3 } })
  assert.deepEqual(days(b.doc), ['0', '1', '2', '3', '4', '5', '6'])
  assert.deepEqual(b.pk.BUILTIN_DEFAULTS.weekdays, [0, 1, 2, 3, 4, 5, 6])
})

// ---------------- 小修 ----------------

test('編輯既有任務時「抓完放哪裡」區塊可見，有一行說明與開報表的連結', async () => {
  const { c, st, pk, doc } = await fresh()
  const task = {
    id: 't-e2', name: '既有', url: URL_, mode: 'number', enabled: true, locator: LOCATOR,
    spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  }
  await st.saveTask(task)
  await pk.renderFromPanelCtx({ kind: 'edit', taskId: task.id })
  const sec = doc.getElementById('add-to-dashboard')
  assert.equal(sec.hidden, false)
  const note = doc.getElementById('dashboard-edit-note')
  assert.equal(note.hidden, false)
  assert.match(note.textContent, /要把這個任務加進儀表板，請到報表的儀表板用「＋」新增卡片/)
  const link = doc.getElementById('dashboard-edit-link')
  assert.ok(note.contains(link))
  link.click()
  // 替身的 runtime.getURL 是 async（真實的是同步），網址內容在這裡驗不到，只驗有開分頁、面板沒被關
  assert.equal(api(c, 'tabs.create').length, 1, '連結要開報表')
  assert.equal(runtimeMsgs(c).some(m => m?.type === 'CLOSE_PANEL'), false, '只是去看報表，不得順手關掉正在編輯的面板')
})

test('還沒試抓時預覽區有一句引導；按了立即測試就換成結果', async () => {
  const { c, pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: URL_ })
  const preview = doc.getElementById('preview')
  assert.equal(preview.textContent, '按下方「試抓」看看現在會抓到什麼')
  c.__setRuntimeResponder((msg) => msg?.type === 'TEST_TASK' ? { ok: true, value: 42, raw: '42' } : undefined)
  await pk.handleTestNow()
  assert.equal(preview.textContent, '42')
  assert.equal(preview.hasAttribute('data-empty'), false)
})

test('固定列兩層：上層只有儲存（＋還差 N 項／停用中），下層是立即測試、回頁面重選目標、取消', () => {
  const doc = new JSDOM(PICKER_HTML).window.document
  const footer = doc.querySelector('#picker-form > footer')
  const tiers = [...footer.children]
  assert.equal(tiers.length, 2)
  assert.deepEqual([...tiers[0].querySelectorAll('button')].map(b => b.id), ['save'])
  assert.deepEqual([...tiers[1].querySelectorAll('button')].map(b => b.id), ['test-now', 'repick-target', 'cancel'])
  const repick = doc.getElementById('repick-target')
  assert.equal(repick.getAttribute('title'), '回頁面重選目標', '縮成短字時完整文字要在 title')
})

test('停用中的任務：固定列上層在儲存鈕旁有「停用中」標記，頁首那句保留', async () => {
  const { st, pk, doc } = await fresh()
  const task = {
    id: 't-off', name: '停用的', url: URL_, mode: 'number', enabled: false, locator: LOCATOR,
    spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['09:30'], weekdays: [1] }
  }
  await st.saveTask(task)
  await pk.renderFromPanelCtx({ kind: 'edit', taskId: task.id })
  const badge = doc.getElementById('paused-badge')
  assert.equal(badge.hidden, false)
  assert.equal(badge.textContent, '停用中')
  assert.match(badge.getAttribute('title') || '', /不會排程/)
  assert.ok(badge.closest('footer'), '在固定列上')
  assert.equal(doc.getElementById('task-status-note').hidden, false, '頁首那句保留')
  // 啟用中的任務不顯示
  const b = await fresh()
  b.pk.render({ locator: LOCATOR, url: URL_ })
  assert.equal(b.doc.getElementById('paused-badge').hidden, true)
})

test('存檔失敗的例外訊息寫在固定列上方的原因區（純文字一條）', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: URL_ })
  const realSet = chrome.storage.local.set.bind(chrome.storage.local)
  chrome.storage.local.set = async (obj) => {
    if (obj && 'tasks' in obj) throw new Error('QUOTA_BYTES quota exceeded')
    return realSet(obj)
  }
  try {
    await pk.handleSave()
  } finally {
    chrome.storage.local.set = realSet
  }
  const box = doc.getElementById('errors')
  assert.equal(box.hidden, false)
  assert.equal(box.textContent, '儲存失敗：QUOTA_BYTES quota exceeded')
  assert.equal(box.querySelectorAll('button').length, 0, '例外訊息不需要跳轉')
  assert.equal(doc.getElementById('save').disabled, false, '失敗要把按鈕還回去')
})
