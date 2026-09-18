// AF-20 作業 A:抓取分頁的唯一入口 background/fetch-tab.js
// 建視窗的參數組合來自真實瀏覽器探針(docs/SPEC.md §4 的探針事實表),替身逐鍵驗參數:
// 測試替身不驗參數曾讓「tabs.create 帶 autoDiscardable 整個呼叫被擋」藏了十幾輪(AF-13)。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 50 }
const URL_A = 'https://a.test/p?x=1'

async function fresh(settings) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  if (settings) await st.saveSettings(settings)
  const ft = await import('../src/background/fetch-tab.js?t=' + Math.random())
  return { c, st, ft }
}

const callsOf = (c, api) => c.__calls.filter(x => x.api === api)
const registry = async (c) => (await c.storage.session.get('fetchTabs')).fetchTabs || []

// ---- 專用視窗(預設) ----

test('預設在專用視窗抓:先不聚焦帶尺寸建立,再最小化', async () => {
  const { c, ft } = await fresh()
  const holder = {}
  const tabId = await ft.acquireFetchTab(holder, URL_A, FAST)

  const creates = callsOf(c, 'windows.create')
  assert.equal(creates.length, 1)
  const args = creates[0].args[0]
  assert.equal(args.url, URL_A)
  assert.equal(args.focused, false, '不聚焦,否則會搶走使用者的焦點')
  assert.equal(args.width, 1280)
  assert.equal(args.height, 800)
  assert.equal('state' in args, false, 'state:minimized 與 focused:false 同時給會靜默變成一般視窗;直接最小化則頁面 viewport 是 0×0')
  assert.equal('type' in args, false, 'popup 型視窗會搶焦點')

  const win = creates[0]
  const minimize = callsOf(c, 'windows.update').find(x => x.args[1]?.state === 'minimized')
  assert.ok(minimize, '建立後要最小化')
  assert.equal(c.__calls.indexOf(minimize) > c.__calls.indexOf(win), true)

  const tab = await c.tabs.get(tabId)
  assert.equal(tab.windowId, minimize.args[0], '回傳的是專用視窗裡那個分頁')
  assert.equal(callsOf(c, 'tabs.create').length, 0, '不在使用者的視窗開分頁')
  assert.ok(callsOf(c, 'tabs.update').some(x => x.args[0] === tabId && x.args[1]?.autoDiscardable === false),
    '省電模式會卸載背景頁面,要用 tabs.update 關掉自動卸載')
})

test('視窗 id 在最小化之前就登記(service worker 在兩步之間被回收,孤兒清理才收得到)', async () => {
  const { c, ft } = await fresh()
  await ft.acquireFetchTab({}, URL_A, FAST)
  const minimizeIdx = c.__calls.findIndex(x => x.api === 'windows.update' && x.args[1]?.state === 'minimized')
  const winId = c.__calls[minimizeIdx].args[0]
  const regIdx = c.__calls.findIndex(x => x.api === 'storage.session.set'
    && Array.isArray(x.args[0]?.fetchTabs) && x.args[0].fetchTabs.some(e => e.windowId === winId))
  assert.ok(regIdx >= 0, '要登記進 storage.session 的 fetchTabs')
  assert.ok(regIdx < minimizeIdx, '登記要早於最小化')
})

test('使用者開著同網址的分頁也不拿來用', async () => {
  const { c, ft } = await fresh()
  const mine = await c.tabs.create({ url: URL_A, active: true })
  const tabId = await ft.acquireFetchTab({}, URL_A, FAST)
  assert.notEqual(tabId, mine.id)
  assert.equal(callsOf(c, 'tabs.query').length, 0, '不再用網址去找使用者的分頁')
})

test('同一個佇列的下一個任務沿用同一個分頁:同一頁不重載,換頁用導覽', async () => {
  const { c, ft } = await fresh()
  const holder = {}
  const first = await ft.acquireFetchTab(holder, URL_A, FAST)

  // 同 origin+path、query 不同 = 同一頁(sameOriginPath)
  const second = await ft.acquireFetchTab(holder, 'https://a.test/p?x=2', FAST)
  assert.equal(second, first)
  assert.equal(callsOf(c, 'windows.create').length, 1)
  assert.equal(callsOf(c, 'tabs.reload').length, 0)
  assert.equal(callsOf(c, 'tabs.update').filter(x => typeof x.args[1]?.url === 'string').length, 0, '同一頁不導覽')

  const third = await ft.acquireFetchTab(holder, 'https://a.test/q', FAST)
  assert.equal(third, first, '不另開分頁:已最小化的視窗裡新開的分頁 viewport 是 0×0')
  assert.equal(callsOf(c, 'tabs.create').length, 0)
  const nav = callsOf(c, 'tabs.update').filter(x => typeof x.args[1]?.url === 'string')
  assert.equal(nav.length, 1)
  assert.deepEqual(nav[0].args, [first, { url: 'https://a.test/q' }])
})

test('freshLoad:網址完全相同用 reload,否則導覽到任務網址', async () => {
  const { c, ft } = await fresh()
  const holder = {}
  const tabId = await ft.acquireFetchTab(holder, URL_A, FAST)
  await ft.acquireFetchTab(holder, URL_A, { ...FAST, freshLoad: true })
  assert.deepEqual(callsOf(c, 'tabs.reload').map(x => x.args[0]), [tabId])

  await ft.acquireFetchTab(holder, 'https://a.test/p?x=9', { ...FAST, freshLoad: true })
  const nav = callsOf(c, 'tabs.update').filter(x => typeof x.args[1]?.url === 'string')
  assert.deepEqual(nav.map(x => x.args), [[tabId, { url: 'https://a.test/p?x=9' }]])
})

test('沿用的分頁已經被關掉(使用者手動關了專用視窗)時重新建立', async () => {
  const { c, ft } = await fresh()
  const holder = {}
  const first = await ft.acquireFetchTab(holder, URL_A, FAST)
  await c.tabs.remove(first)
  const again = await ft.acquireFetchTab(holder, URL_A, FAST)
  assert.notEqual(again, first)
  assert.equal(callsOf(c, 'windows.create').length, 2)
})

test('沿用的分頁被卸載(discarded)時先 reload', async () => {
  const { c, ft } = await fresh()
  const holder = {}
  const tabId = await ft.acquireFetchTab(holder, URL_A, FAST)
  c.__setTabState(tabId, { discarded: true })
  await ft.acquireFetchTab(holder, URL_A, FAST)
  assert.deepEqual(callsOf(c, 'tabs.reload').map(x => x.args[0]), [tabId])
})

test('頁面一直沒載完也不丟例外(逾時照樣往下走,由擷取自己判定)', async () => {
  const { c, ft } = await fresh()
  c.__setDefaultTabStatus('loading')
  const tabId = await ft.acquireFetchTab({}, URL_A, FAST)
  assert.equal(typeof tabId, 'number')
})

test('釋放:關掉整個專用視窗、取消登記,不動使用者的視窗', async () => {
  const { c, ft } = await fresh()
  const holder = {}
  await ft.acquireFetchTab(holder, URL_A, FAST)
  const winId = callsOf(c, 'windows.update').find(x => x.args[1]?.state === 'minimized').args[0]
  await ft.releaseFetchTab(holder)
  assert.deepEqual(callsOf(c, 'windows.remove').map(x => x.args[0]), [winId])
  assert.equal(callsOf(c, 'tabs.remove').length, 0)
  assert.deepEqual(await registry(c), [])
  // 釋放後同一個 holder 再要一次 = 新建
  await ft.acquireFetchTab(holder, URL_A, FAST)
  assert.equal(callsOf(c, 'windows.create').length, 2)
})

test('什麼都沒拿過就釋放:零呼叫', async () => {
  const { c, ft } = await fresh()
  await ft.releaseFetchTab({})
  assert.equal(callsOf(c, 'windows.remove').length + callsOf(c, 'tabs.remove').length, 0)
})

test('建專用視窗失敗:退回背景分頁,並寫診斷(不讓整次抓取失敗)', async () => {
  const { c, ft } = await fresh()
  c.__windowCreateHook = () => { throw new Error('boom') }
  const holder = {}
  const tabId = await ft.acquireFetchTab(holder, URL_A, FAST)
  const tc = callsOf(c, 'tabs.create')
  assert.equal(tc.length, 1)
  assert.equal(tc[0].args[0].url, URL_A)
  assert.equal(tc[0].args[0].active, false)
  assert.equal(tc[0].args[0].autoDiscardable, undefined, 'tabs.create 不吃 autoDiscardable')
  const diagList = (await c.storage.local.get('diag')).diag || []
  assert.ok(diagList.some(e => e.kind === 'fetch_window_fallback'), '要留診斷,使用者才知道為什麼跑到分頁列上')
  assert.ok((await registry(c)).some(e => e.tabId === tabId && e.windowId === null))
  await ft.releaseFetchTab(holder)
  assert.deepEqual(callsOf(c, 'tabs.remove').map(x => x.args[0]), [tabId])
  assert.equal(callsOf(c, 'windows.remove').length, 0)
})

// ---- 設定:開在目前視窗的背景分頁 ----

test('fetchTabMode=tab:在目前視窗開背景分頁,不建視窗', async () => {
  const { c, ft } = await fresh({ fetchTabMode: 'tab' })
  const holder = {}
  const tabId = await ft.acquireFetchTab(holder, URL_A, FAST)
  assert.equal(callsOf(c, 'windows.create').length, 0)
  const tc = callsOf(c, 'tabs.create')
  assert.equal(tc.length, 1)
  assert.equal(tc[0].args[0].active, false)
  assert.ok(callsOf(c, 'tabs.update').some(x => x.args[0] === tabId && x.args[1]?.autoDiscardable === false))
  await ft.releaseFetchTab(holder)
  assert.deepEqual(callsOf(c, 'tabs.remove').map(x => x.args[0]), [tabId])
})

test('fetchTabMode=tab 但一個視窗都沒有(macOS 可無視窗執行):改走專用視窗', async () => {
  const { c, ft } = await fresh({ fetchTabMode: 'tab' })
  c.__setWindows([])
  await ft.acquireFetchTab({}, URL_A, FAST)
  assert.equal(callsOf(c, 'windows.create').length, 1)
  assert.equal(callsOf(c, 'tabs.create').length, 0)
})

test('fetchTabMode 不認得的值一律當預設(專用視窗)', async () => {
  const { c, ft } = await fresh({ fetchTabMode: 'bogus' })
  await ft.acquireFetchTab({}, URL_A, FAST)
  assert.equal(callsOf(c, 'windows.create').length, 1)
})

test('設定預設值含 fetchTabMode=window(設定頁要顯示得出來)', async () => {
  const { st } = await fresh()
  assert.equal((await st.getSettings()).fetchTabMode, 'window')
})

// ---- 前景抓取 ----

test('前景:在最後聚焦的一般視窗開作用中的新分頁,結束後還原原本的分頁並關掉自己的', async () => {
  const { c, ft } = await fresh()
  c.__setWindows([{ id: 7, type: 'normal', focused: true, state: 'normal' }])
  c.__setLastFocusedWindow(7)
  const original = await c.tabs.create({ url: 'https://other.test/', active: true, windowId: 7 })
  const mine = await c.tabs.create({ url: URL_A, active: false, windowId: 7 })
  const before = callsOf(c, 'tabs.create').length

  const fg = await ft.openForegroundTab(URL_A, FAST)
  assert.notEqual(fg.tabId, mine.id, '前景也不沿用使用者的分頁')
  const tc = callsOf(c, 'tabs.create').slice(before)
  assert.equal(tc.length, 1)
  assert.deepEqual({ url: tc[0].args[0].url, active: tc[0].args[0].active, windowId: tc[0].args[0].windowId },
    { url: URL_A, active: true, windowId: 7 })
  assert.ok(callsOf(c, 'windows.getLastFocused').length > 0)
  assert.ok((await registry(c)).some(e => e.tabId === fg.tabId))

  await fg.restore()
  const act = callsOf(c, 'tabs.update').filter(x => x.args[1]?.active === true)
  assert.equal(act[act.length - 1].args[0], original.id, '焦點還給原本那個分頁')
  assert.ok(callsOf(c, 'tabs.remove').some(x => x.args[0] === fg.tabId), '自己開的前景分頁要關')
  assert.ok(!callsOf(c, 'tabs.remove').some(x => x.args[0] === mine.id || x.args[0] === original.id))
  assert.deepEqual(await registry(c), [])
})

test('前景:原本的分頁在抓取途中被關掉,還原時不丟例外', async () => {
  const { c, ft } = await fresh()
  c.__setWindows([{ id: 7, type: 'normal', focused: true, state: 'normal' }])
  c.__setLastFocusedWindow(7)
  const original = await c.tabs.create({ url: 'https://other.test/', active: true, windowId: 7 })
  const fg = await ft.openForegroundTab(URL_A, FAST)
  await c.tabs.remove(original.id)
  await fg.restore()
  assert.ok(callsOf(c, 'tabs.remove').some(x => x.args[0] === fg.tabId))
})

// ---- 孤兒清理 ----

test('孤兒:上一次 service worker 留下的視窗與分頁要關掉並取消登記', async () => {
  const { c, ft } = await fresh()
  c.__setWindows([{ id: 1, state: 'normal' }, { id: 50, state: 'minimized' }])
  await c.storage.session.set({ fetchTabs: [
    { windowId: 50, tabId: 51, boot: 'old-boot' },
    { windowId: null, tabId: 60, boot: 'old-boot' }
  ] })
  await ft.cleanOrphanFetchTabs()
  assert.deepEqual(callsOf(c, 'windows.remove').map(x => x.args[0]), [50])
  assert.deepEqual(callsOf(c, 'tabs.remove').map(x => x.args[0]), [60])
  assert.deepEqual(await registry(c), [])
})

test('孤兒:這一次 service worker 自己還在用的不關(同站台兩個任務交接的空檔也一樣)', async () => {
  const { c, ft } = await fresh()
  const holder = {}
  await ft.acquireFetchTab(holder, URL_A, FAST)
  const regBefore = await registry(c)
  assert.equal(regBefore.length, 1)
  await ft.cleanOrphanFetchTabs()
  assert.equal(callsOf(c, 'windows.remove').length + callsOf(c, 'tabs.remove').length, 0)
  assert.deepEqual(await registry(c), regBefore)
})

test('孤兒:沒登記的視窗絕不關(不得用網址或標題猜)', async () => {
  const { c, ft } = await fresh()
  c.__setWindows([{ id: 1, state: 'normal' }, { id: 2, state: 'minimized' }])
  await c.tabs.create({ url: URL_A, windowId: 2 })
  await ft.cleanOrphanFetchTabs()
  assert.equal(callsOf(c, 'windows.remove').length + callsOf(c, 'tabs.remove').length, 0)
})

test('孤兒:要關的東西已經不在了(使用者自己關了)也照樣取消登記', async () => {
  const { c, ft } = await fresh()
  c.__setWindows([{ id: 1, state: 'normal' }])
  await c.storage.session.set({ fetchTabs: [{ windowId: 99, tabId: 98, boot: 'old-boot' }] })
  const origRemove = c.windows.remove
  c.windows.remove = async (id) => { await origRemove(id); throw new Error('No window with id: ' + id) }
  try {
    await ft.cleanOrphanFetchTabs()
  } finally {
    c.windows.remove = origRemove
  }
  assert.deepEqual(await registry(c), [])
})

test('兩個站台同時登記,登記表不互相覆蓋', async () => {
  const { c, ft } = await fresh()
  await Promise.all([
    ft.acquireFetchTab({}, 'https://a.test/p', FAST),
    ft.acquireFetchTab({}, 'https://b.test/p', FAST),
    ft.acquireFetchTab({}, 'https://c.test/p', FAST)
  ])
  assert.equal((await registry(c)).length, 3)
})
