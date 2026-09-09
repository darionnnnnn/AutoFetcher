// AF-10 作業 B：設定畫面改成 side panel，面板生命週期 ↔ 頁面標示。
// 對照 docs/AF-10-PLAN.md 作業 B 的驗收（框架事實見該檔的 B-0 探針結果）。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}
const api = (c, name) => c.__calls.filter(x => x.api === name)
const sessionOf = async (tabId) => (await chrome.storage.session.get(`panel:${tabId}`))[`panel:${tabId}`]

// ---------- B-1 四個入口都在自己的手勢裡開面板 ----------

test('B-1 右鍵「選取要抓的內容」先開面板顯示等待態，再讓頁面進選取模式', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)

  const opened = api(c, 'sidePanel.open')
  assert.equal(opened.length, 1, '要開面板')
  assert.equal(opened[0].args[0].tabId, tab.id, '面板要綁在目標分頁上')
  const setOpts = api(c, 'sidePanel.setOptions')
  assert.match(String(setOpts[0].args[0].path), /picker\.html/)
  assert.ok(!String(setOpts[0].args[0].path).includes('?'),
    '路徑不得帶查詢字串：面板重載時 Chrome 會用 default_path，參數會被丟掉')

  const entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'waiting', '選取還沒完成，面板要先顯示等待態')

  const enter = api(c, 'tabs.sendMessage').find(x => x.args[1]?.type === 'ENTER_PICK')
  assert.ok(enter, '還是要讓頁面進選取模式')
  assert.equal(enter.args[2]?.frameId, 0, '不指名 frameId 就是廣播（D13 規約）')
})

test('B-1 選好之後 ctx 進 session，面板從等待態換成表單', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: { css: '#v' }, preview: '1',
    picks: [{ cell: { row: { index: 0, header: '' }, col: { index: 1, header: '量' } } }],
    nameHint: '表'
  }, { tab: { id: tab.id, url: 'https://a.test/p' } })

  const entry = await sessionOf(tab.id)
  assert.equal(entry.kind, 'new')
  assert.equal(entry.ctx.picks.length, 1)
  assert.equal(entry.ctx.nameHint, '表')
})

test('B-1 面板已經有表單時再選一次＝換目標，不重置（要保住填到一半的設定）', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: { css: '#a' }, preview: '1', picks: []
  }, { tab: { id: tab.id, url: 'https://a.test/p' } })
  // 使用者在面板上填了名稱與排程
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.mergePanelCtx(tab.id, { draft: { name: '我的電費', 'schedule-type': 'interval' } })

  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: { css: '#b' }, preview: '2', picks: []
  }, { tab: { id: tab.id, url: 'https://a.test/p' } })

  const entry = await sessionOf(tab.id)
  assert.equal(entry.retarget, true, '要標記成換目標，面板才知道不能整張表單重畫')
  assert.equal(entry.ctx.locator.css, '#b', '目標要換成新的')
  assert.equal(entry.draft?.name, '我的電費',
    `右鍵重選一個目標不該把填到一半的表單洗掉，實得 ${JSON.stringify(entry.draft)}`)
})

// ---------- B-2 舊版瀏覽器與手勢失敗都要有退路 ----------

test('B-2 沒有 sidePanel API 時退回彈出視窗，而且留下診斷', async (t) => {
  resetChromeMock()
  const c = installChromeMock()
  // 這個 mock 是共用的：刪掉之後一定要還原，否則後面的案例會以為瀏覽器不支援面板
  const savedSidePanel = c.sidePanel
  delete c.sidePanel
  t.after(() => { c.sidePanel = savedSidePanel })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)

  assert.equal(api(c, 'windows.create').length, 1, '舊版瀏覽器要退回彈出視窗')
  const diag = await import('../src/shared/diag.js?t=' + Math.random())
  const entries = await diag.getAll()
  assert.ok(entries.some(e => e.kind === 'panel_fallback'),
    '退路走了要留痕跡：使用者看到的是「右鍵沒反應」，沒紀錄就查不出原因')
})

test('B-2 手勢不成立（open 拋錯）也退回彈出視窗', async () => {
  const { c, bg } = await freshBg()
  c.__setPanelOpenThrows(true)
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  assert.equal(api(c, 'windows.create').length, 1)
})

// ---------- B-3 面板關閉的三條通道，冪等清場 ----------

test('B-3 sidePanel.onClosed 觸發時清掉頁面標示與暫存', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  assert.ok(await sessionOf(tab.id), '前置：要先有暫存')

  await bg.closePanelFor(tab.id)
  const exits = api(c, 'tabs.sendMessage').filter(x => x.args[1]?.type === 'EXIT_PICK')
  assert.ok(exits.length >= 1, '面板關了，頁面上保留的標示要清掉')
  assert.ok(exits.every(x => x.args[2]?.frameId !== undefined), '每一則都要指名 frameId')
  assert.equal(await sessionOf(tab.id), undefined, '暫存也要清掉')
})

test('B-3 三條通道重複觸發是常態，第二次之後不得再對頁面送訊息', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)

  await bg.closePanelFor(tab.id)
  const afterFirst = api(c, 'tabs.sendMessage').filter(x => x.args[1]?.type === 'EXIT_PICK').length
  assert.ok(afterFirst >= 1, '第一次要真的清場')

  await bg.handleMessage({ type: 'PANEL_CLOSING', tabId: tab.id }, {})
  await bg.closePanelFor(tab.id)
  const afterRest = api(c, 'tabs.sendMessage').filter(x => x.args[1]?.type === 'EXIT_PICK').length
  assert.equal(afterRest, afterFirst,
    `清過就沒有東西要清了，重複送只是白花訊息，實得 ${afterRest} 則（第一次 ${afterFirst} 則）`)
  assert.equal(await sessionOf(tab.id), undefined)
})

test('B-3 分頁被關掉時只清暫存，不再對那個分頁送訊息', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  const before = api(c, 'tabs.sendMessage').length
  await bg.closePanelFor(tab.id, { keepMarks: true })
  assert.equal(api(c, 'tabs.sendMessage').length, before, '分頁都關了，節點也沒了')
  assert.equal(await sessionOf(tab.id), undefined)
})

// ---------- B-4 面板要問得到自己屬於哪個分頁 ----------

test('B-4 RESOLVE_PANEL_TAB 以 windowId 回答目前的作用分頁', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p', active: true })
  const res = await bg.handleMessage({ type: 'RESOLVE_PANEL_TAB', windowId: tab.windowId }, {})
  assert.equal(res.ok, true)
  assert.equal(res.tabId, tab.id,
    '面板的 sender.tab 永遠是 null、網址參數重載後會被丟掉，只剩這條路')
})

// ---------- B-5 取消的轉發順序 ----------

test('B-5 前置動作按取消時，面板要收得到（不能在轉發之前就 return）', async () => {
  const { c, bg } = await freshBg()
  await bg.handleMessage({ type: 'PICKED', purpose: 'preaction', cancelled: true }, { tab: { id: 5 } })
  const forwarded = api(c, 'runtime.sendMessage').map(x => x.args[0])
  assert.ok(forwarded.some(m => m?.purpose === 'preaction' && m?.cancelled === true),
    '不轉發的話，「在頁面上選取」那顆按鈕會一直卡在等待狀態')
})

// ---------- B-6 重選收尾 ----------

test('B-6 重選存檔後要重建排程、更新燈號，並收掉自己開的分頁', async () => {
  const { c, st, bg } = await freshBg()
  await st.saveTask({
    id: 't1', name: '電費', url: 'https://a.test/p', mode: 'number', enabled: true,
    locator: { css: '#old', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
  })
  await bg.handleMessage({ type: 'ENTER_PICK', purpose: 'repick', taskId: 't1' }, {})
  const created = api(c, 'tabs.create').pop()
  assert.ok(created, '前置：重選會自己開一個分頁')

  const before = api(c, 'alarms.create').length
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1',
    locator: { css: '#new', path: '', anchor: null, xpath: '' }, picks: []
  }, { tab: { id: 99 } })

  assert.ok(api(c, 'alarms.create').length > before, '定位換了要重建排程')
  assert.ok(api(c, 'tabs.remove').length >= 1, '為了重選開的分頁要收掉，不然每次留一個')
})

// ---------- B-7 送出後保留標示，面板關閉才清 ----------

async function bootPicker(html) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, pm, win: jd.window }
}
const TABLE = `<table id="t"><thead><tr><th>日期</th><th>量</th></tr></thead>
  <tbody><tr><td>1</td><td id="v">42</td></tr></tbody></table>
  <a id="link" href="https://x.test/">連結</a>`
const move = (win, el) => el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const key = (doc, win, k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }))

test('B-7 送出後藍框留著，但工具列與事件攔截全部拆掉', async () => {
  const { doc, pm, win } = await bootPicker(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('v'))
  click(win, doc.getElementById('v'))
  key(doc, win, 'Enter')

  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 1,
    '設定面板就開在旁邊，使用者要看得到自己剛剛選的是哪一格')
  assert.equal(doc.querySelectorAll('[data-af-overlay]').length, 0, '工具列與面板要拆掉')
  assert.equal(doc.body.style.userSelect, '', '文字選取要還原')
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true })
  doc.getElementById('link').dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, false, '頁面要能正常操作，點擊不得再被攔截')
  pm.exitPickMode()
})

test('B-7 收到 EXIT_PICK（面板關閉）才把保留的標示清乾淨', async () => {
  const { doc, pm, win } = await bootPicker(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('v'))
  click(win, doc.getElementById('v'))
  key(doc, win, 'Enter')
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 1)
  pm.exitPickMode()
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 0)
})

test('B-7 前置動作選到一半按 Esc，不得抹掉任務目標的標示', async () => {
  const { doc, pm, win } = await bootPicker(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('v'))
  click(win, doc.getElementById('v'))
  key(doc, win, 'Enter')
  assert.equal(doc.querySelectorAll('[data-af-held="task"]').length, 1, '前置：任務目標的標示要留著')

  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.body })
  key(doc, win, 'Escape')
  assert.equal(doc.querySelectorAll('[data-af-held="task"]').length, 1,
    '別的用途取消，不該把任務目標的藍框一起抹掉')
  pm.exitPickMode()
})

test('B-7 repick 送出後不留標示（存檔就結束，沒有面板要看）', async () => {
  const { doc, pm, win } = await bootPicker(TABLE)
  pm.enterPickMode({ purpose: 'repick', initialTarget: doc.body })
  move(win, doc.getElementById('v'))
  click(win, doc.getElementById('v'))
  key(doc, win, 'Enter')
  assert.equal(doc.querySelectorAll('[data-af-picked]').length, 0)
  pm.exitPickMode()
})

// ---------- B-8 規約：不得再用網址參數傳面板參數 ----------

test('B-8 正式碼不得用網址參數傳面板參數，也只剩退路會開彈出視窗', () => {
  const files = ['src/background/main.js', 'src/ui/report/tasks.js', 'src/ui/popup/popup.js']
  for (const f of files) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    assert.ok(!/picker\.html\?/.test(src), `${f} 不得用 picker.html?… 傳參數（面板重載會丟掉）`)
    assert.ok(!/site\.html\?/.test(src), `${f} 不得用 site.html?… 傳參數`)
    assert.ok(!/windows\.create/.test(src),
      `${f} 不該自己開彈出視窗：那是 shared/panel.js 的退路`)
  }
})

// ---------- B-9 鏈結：session ctx 一路走到面板端渲染 ----------
// 只驗 background 寫了什麼是不夠的——面板端渲染崩掉（例如呼叫不存在的函式）完全逃得掉。

test('B-9 面板端能用 background 寫的 ctx 渲染，換目標時不會炸也不清掉已填的設定', async () => {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())

  // 第一個目標 + 使用者改了名稱與排程
  await pk.renderFromPanelCtx({
    kind: 'new',
    ctx: { locator: { css: '#a' }, url: 'https://a.test/p', preview: '1', picks: [] }
  })
  jd.window.document.getElementById('name').value = '我的電費'
  const schedule = jd.window.document.getElementById('schedule-type')
  if (schedule) schedule.value = 'interval'

  // 右鍵選了新目標：background 標成 retarget
  await pk.renderFromPanelCtx({
    kind: 'new',
    retarget: true,
    ctx: { locator: { css: '#b' }, url: 'https://a.test/p', preview: '2', picks: [] }
  })

  assert.equal(jd.window.document.getElementById('name').value, '我的電費',
    '換目標不該把使用者打的名稱洗掉')
  if (schedule) {
    assert.equal(jd.window.document.getElementById('schedule-type').value, 'interval',
      '排程也要留著')
  }
  const note = jd.window.document.getElementById('retarget-note')
  assert.equal(note?.hidden, false, '要告訴使用者目標換了')
})

// ---------- B-10 終檢補件：存檔收尾與「回頁面重選目標」 ----------

test('B-10 CLOSE_PANEL 會關掉面板並把草稿一起清掉', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.setPanelCtx(tab.id, { kind: 'new', ctx: {}, draft: { name: '上一個任務' } })

  await bg.handleMessage({ type: 'CLOSE_PANEL', tabId: tab.id }, {})

  assert.ok(api(c, 'sidePanel.close').length >= 1, '存檔後要把面板關掉')
  assert.equal(await sessionOf(tab.id), undefined,
    '草稿沒清的話，下一個新任務會被上一個的名稱與排程灌進去')
})

test('B-10 面板有「回頁面重選目標」的入口，而且帶著目前已選回去', () => {
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  assert.match(html, /id="repick-target"/, '面板要有回頁面重選目標的鈕')
  const js = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  const idx = js.indexOf("repick-target")
  assert.ok(idx > 0, 'picker.js 要接上那顆鈕')
  const seg = js.slice(idx, idx + 600)
  assert.match(seg, /ENTER_PICK/, '要讓頁面重新進選取模式')
  assert.match(seg, /preselect/, '要把目前已選帶回去勾，不然使用者得從頭選一次')
})

test('B-11 前置動作「送出成功」之後，任務目標的標示仍屬於 task 群', async () => {
  const { doc, pm, win } = await bootPicker(TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('v'))
  click(win, doc.getElementById('v'))
  key(doc, win, 'Enter')
  assert.equal(doc.querySelectorAll('[data-af-held="task"]').length, 1, '前置：任務目標已保留')

  // 前置動作選一個元素並送出（一次只選一個，點一下就送）
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.body })
  move(win, doc.getElementById('link'))
  click(win, doc.getElementById('link'))
  key(doc, win, 'Enter')

  assert.equal(doc.querySelectorAll('[data-af-held="task"]').length, 1,
    '前置動作送出不得把任務目標那一格改成 preaction 群（改群之後下一次 Esc 會連它一起抹掉）')

  // 再進一輪前置動作並取消：任務目標要活下來
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.body })
  key(doc, win, 'Escape')
  assert.equal(doc.querySelectorAll('[data-af-held="task"]').length, 1,
    '別的用途取消，不該把任務目標的藍框一起抹掉')
  pm.exitPickMode()
})

// ---------- B-12 規劃定案的其餘三條 ----------

// 契約測試：摘要卡（「這個任務在做什麼」的三句話）必須跟著新目標走。
// 目前是 render() 內部重算的，這條測試不在乎由誰做，只在乎結果不能停在舊目標。
test('B-12 換目標之後摘要卡要跟著重算（不能停在舊目標）', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())

  await pk.renderFromPanelCtx({
    kind: 'new',
    ctx: { locator: { css: '#a' }, url: 'https://a.test/p', preview: '1', picks: [] }
  })
  const before = jd.window.document.getElementById('summary-target')?.textContent

  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: { locator: { css: '#b' }, url: 'https://b.test/q', preview: '2', picks: [] }
  })
  const after = jd.window.document.getElementById('summary-target')?.textContent
  assert.notEqual(after, before,
    `摘要卡是「這個任務在做什麼」的那三句話，換了目標不重算就會說謊，前後都是 ${JSON.stringify(after)}`)
})

test('B-12 面板已關卻仍收到 PICKED 時要留診斷（使用者看到的是「選完沒反應」）', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  // 面板沒開（session 沒有暫存），頁面卻送來選取結果
  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: { css: '#v' }, preview: '1', picks: []
  }, { tab: { id: tab.id, url: 'https://a.test/p' } })

  const diag = await import('../src/shared/diag.js?t=' + Math.random())
  const entries = await diag.getAll()
  assert.ok(entries.some(e => e.kind === 'panel_missing_on_pick'),
    `沒有這一筆就查不出「選完什麼都沒發生」的原因，實得 ${JSON.stringify(entries.map(e => e.kind))}`)
})

test('B-12 面板關閉清場也要留診斷', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  await bg.closePanelFor(tab.id)
  const diag = await import('../src/shared/diag.js?t=' + Math.random())
  const entries = await diag.getAll()
  assert.ok(entries.some(e => e.kind === 'panel_closed'),
    '使用者回報「藍框自己不見了」時要查得到是哪一次清場')
})

// ---------- 體檢輪（Fable 5.1）補件 ----------

test('體檢-1 非表格元素送出後也要保留高亮（最常見的單一數字就是這種）', async () => {
  const { doc, pm, win } = await bootPicker('<div id="price">1,234</div>' + TABLE)
  pm.enterPickMode({ purpose: 'task', initialTarget: doc.body })
  move(win, doc.getElementById('price'))
  click(win, doc.getElementById('price'))
  key(doc, win, 'Enter')
  const el = doc.getElementById('price')
  assert.equal(el.getAttribute('data-af-held'), 'task', '非表格的目標本身要進 held 群')
  assert.ok(el.style.outline, '要留一個看得見的框，面板旁邊才對得上「我剛剛選的是哪個」')
  pm.exitPickMode()
  assert.equal(el.hasAttribute('data-af-held'), false)
  assert.equal(el.style.outline, '', 'EXIT_PICK 之後外框要還原')
})

test('體檢-2 面板已有表單時再按右鍵重選，不得把 ctx 蓋成等待態（草稿會跟著沒了）', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: { css: '#a' }, preview: '1', picks: []
  }, { tab: { id: tab.id, url: 'https://a.test/p' } })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.mergePanelCtx(tab.id, { draft: { name: '我的電費' } })

  await bg.handleContextMenu({ menuItemId: 'af-pick', frameId: 0 }, tab)
  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: { css: '#b' }, preview: '2', picks: []
  }, { tab: { id: tab.id, url: 'https://a.test/p' } })

  const entry = await sessionOf(tab.id)
  assert.equal(entry.retarget, true, '右鍵重選是最常走的路，它也必須是「換目標」')
  assert.equal(entry.draft?.name, '我的電費', `草稿不得被等待態洗掉，實得 ${JSON.stringify(entry)}`)
})

async function freshPanelPage() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { pk, doc: jd.window.document }
}
const CTX_A = { locator: { css: '#a' }, url: 'https://a.test/p', preview: '1', picks: [] }

test('體檢-3 只有草稿變動時不得整張表單重畫（使用者正在打字，重畫會把焦點踢掉）', async () => {
  const { pk, doc } = await freshPanelPage()
  const first = await pk.renderFromPanelCtx({ kind: 'new', ctx: CTX_A })
  assert.equal(first?.rendered, true, '第一次要畫')
  doc.getElementById('name').value = '打到一'
  // 草稿寫回 session 會觸發 onChanged → 面板再收到同一份 ctx（只多了 draft）
  const again = await pk.renderFromPanelCtx({ kind: 'new', ctx: CTX_A, draft: { name: '打到一' } })
  assert.equal(again?.rendered, false, '同一份 ctx 不該重畫')
  assert.equal(doc.getElementById('name').value, '打到一')
})

test('體檢-4 換目標之後切分頁再回來（面板重載），草稿還要在', async () => {
  const { pk, doc } = await freshPanelPage()
  // 面板剛重載：文件是新的，session 裡是 retarget:true + 先前的草稿
  await pk.renderFromPanelCtx({
    kind: 'new', retarget: true,
    ctx: { locator: { css: '#b' }, url: 'https://b.test/q', preview: '2', picks: [] },
    draft: { name: '我的電費' }
  })
  assert.equal(doc.getElementById('name').value, '我的電費',
    '重載後走換目標分支會拿空白表單當「現有的值」，草稿就丟了')
})

test('體檢-5 popup 入口也要顯示等待態；面板已有表單時則不動它', async () => {
  const { c, bg } = await freshBg()
  const tab = await c.tabs.create({ url: 'https://a.test/p' })
  await bg.handleMessage({ type: 'ENTER_PICK', purpose: 'task', tabId: tab.id, frameId: 0 }, {})
  assert.equal((await sessionOf(tab.id))?.kind, 'waiting', '沒有表單時要先給等待態，不能是空白表單')

  await bg.handleMessage({
    type: 'PICKED', purpose: 'task', locator: { css: '#a' }, preview: '1', picks: []
  }, { tab: { id: tab.id, url: 'https://a.test/p' } })
  await bg.handleMessage({ type: 'ENTER_PICK', purpose: 'task', tabId: tab.id, frameId: 0 }, {})
  assert.equal((await sessionOf(tab.id))?.kind, 'new', '已有表單就不能蓋成等待態')
})

// ---------- 體檢輪：站台登入面板 ----------

async function freshSitePanel(resolveTab) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  c.__setRuntimeResponder((msg) => msg?.type === 'RESOLVE_PANEL_TAB'
    ? { ok: true, tabId: resolveTab() }
    : undefined)
  const html = readFileSync(new URL('../src/ui/site/site.html', import.meta.url), 'utf8')
  const jd = new JSDOM(html, { url: 'chrome-extension://abc/ui/site/site.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const sp = await import('../src/ui/site/site.js?t=' + Math.random())
  return { c, st, sp, doc: jd.window.document }
}

test('體檢-6 站台面板切到沒有站台設定的分頁時，不得沿用上一個分頁的 origin', async () => {
  let tab = 7
  const { c, st, sp, doc } = await freshSitePanel(() => tab)
  await st.setPanelCtx(7, { kind: 'site', origin: 'https://a.test', tabId: 7 })
  await sp.render()
  assert.equal(doc.getElementById('origin').textContent, 'https://a.test', '前置：A 站要顯示出來')

  tab = 99 // 切到一個沒有站台設定的分頁
  await sp.render()
  assert.equal(doc.getElementById('origin').textContent, '', 'B 分頁沒有站台設定，不能還顯示 A 站')
  assert.equal(doc.getElementById('site-save').disabled, true, '判斷不出分頁時不能讓人存')
  void c
})

test('體檢-7 判斷不出目前分頁時，存檔要被擋下（不得存出鍵為空字串的站台）', async () => {
  const { st, sp, doc } = await freshSitePanel(() => null)
  await sp.render()
  const before = JSON.stringify(await chrome.storage.local.get(null))
  await sp.handleSave({ closeDelayMs: 0 })
  const after = JSON.stringify(await chrome.storage.local.get(null))
  assert.equal(after, before, '空 origin 的站台永遠不會被任何網址命中，存了只是垃圾')
  assert.match(doc.getElementById('site-note').textContent, /無法判斷/)
  void st
})

test('體檢-8 站台面板存好之後要像任務面板一樣關掉（連同頁面標示）', async () => {
  const { c, st, sp, doc } = await freshSitePanel(() => 7)
  await st.setPanelCtx(7, { kind: 'site', origin: 'https://a.test', tabId: 7 })
  await sp.render()
  const listener = [...c.runtime.onMessage._listeners][0]
  for (const [purpose, css] of [['login-user', '#u'], ['login-pass', '#p'], ['login-submit', '#go']]) {
    listener({ type: 'PICKED', purpose, locator: { css } }, {}, () => {})
  }
  doc.getElementById('username').value = 'wayne'
  doc.getElementById('password').value = 'hunter2'
  doc.getElementById('login-url').value = 'https://a.test/login'
  doc.getElementById('success-value').value = 'https://a.test/home'
  await sp.handleSave({ closeDelayMs: 0 })
  await new Promise(r => setTimeout(r, 10))
  const closed = api(c, 'runtime.sendMessage').some(x => x.args[0]?.type === 'CLOSE_PANEL' && x.args[0]?.tabId === 7)
  assert.ok(closed, '存好了面板要關，不然頁面上的標示會一直留著')
})

test('體檢-9 退路的彈出視窗要被告知服務哪個分頁（popup 與右鍵兩個入口都要帶 tabId）', () => {
  const popup = readFileSync(new URL('../src/ui/popup/popup.js', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8')
  const picker = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  assert.match(popup, /openPanel\([^)]*`tabId=/, 'popup 退路沒帶 tabId，彈出視窗會是永遠空白的表單')
  assert.match(main, /openPanel\(tab\.id, 'picker', `tabId=/, '右鍵退路也要帶')
  assert.match(picker, /params\.has\('tabId'\)/, 'picker 要認得網址上的 tabId 並直接採用')
})
