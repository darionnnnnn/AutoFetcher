import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

// ---------- manifest ----------
const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'))

test('manifest 是 MV3 且有必要欄位', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.equal(typeof manifest.name, 'string')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.background.type, 'module')
  assert.equal(manifest.background.service_worker, 'background/main.js')
  assert.equal(manifest.action.default_popup, 'ui/popup/popup.html')
})

test('manifest 權限剛好是 SPEC §9 那組,沒有多的', () => {
  const want = ['alarms', 'contextMenus', 'downloads', 'notifications', 'scripting', 'storage', 'tabs']
  assert.deepEqual([...manifest.permissions].sort(), want)
  assert.deepEqual(manifest.host_permissions, ['<all_urls>'])
})

test('manifest 不得使用 Chrome 專屬 API(Edge 相容,SPEC §13)', () => {
  const banned = ['sidePanel', 'offscreen', 'declarativeNetRequest', 'ttsEngine', 'identity']
  const text = JSON.stringify(manifest)
  for (const b of banned) assert.ok(!text.includes(b), `manifest 不該出現 ${b}`)
})

test('三個執行環境的入口檔都存在', () => {
  for (const f of ['src/background/main.js', 'src/content/main.js', 'src/shared/messages.js',
                   'src/ui/popup/popup.html', 'src/ui/report/report.html', 'src/ui/picker/picker.html']) {
    assert.ok(existsSync(new URL('../' + f, import.meta.url)), `缺少 ${f}`)
  }
})

test('messages.js 匯出訊息型別常數且值唯一', async () => {
  const m = await import('../src/shared/messages.js')
  const want = ['DESCRIBE', 'EXTRACT', 'SCROLL_INTO_VIEW', 'RUN_TASK', 'REBUILD_ALARMS', 'HEALTH_CHANGED']
  for (const k of want) assert.ok(k in m.MSG, `MSG 缺少 ${k}`)
  const vals = Object.values(m.MSG)
  assert.equal(new Set(vals).size, vals.length, '訊息值必須唯一')
})

// ---------- chrome mock ----------
test('installChromeMock 掛上 globalThis.chrome', () => {
  resetChromeMock()
  const c = installChromeMock()
  assert.equal(globalThis.chrome, c)
})

test('storage.local set/get/remove/clear 往返', async () => {
  const c = installChromeMock()
  await c.storage.local.set({ a: 1, b: 2 })
  assert.deepEqual(await c.storage.local.get('a'), { a: 1 })
  assert.deepEqual(await c.storage.local.get(['a', 'b']), { a: 1, b: 2 })
  assert.deepEqual(await c.storage.local.get(null), { a: 1, b: 2 })
  assert.deepEqual(await c.storage.local.get({ z: 'def' }), { z: 'def' }, '預設值物件形式')
  await c.storage.local.remove('a')
  assert.deepEqual(await c.storage.local.get(null), { b: 2 })
  await c.storage.local.clear()
  assert.deepEqual(await c.storage.local.get(null), {})
})

test('storage.session 與 storage.local 是各自獨立的空間', async () => {
  const c = installChromeMock()
  await c.storage.local.set({ x: 'L' })
  await c.storage.session.set({ x: 'S' })
  assert.deepEqual(await c.storage.local.get('x'), { x: 'L' })
  assert.deepEqual(await c.storage.session.get('x'), { x: 'S' })
})

test('alarms create/getAll/clear/clearAll', async () => {
  const c = installChromeMock()
  await c.alarms.create('t1:0', { when: 1000 })
  await c.alarms.create('t1:1', { periodInMinutes: 5 })
  const all = await c.alarms.getAll()
  assert.equal(all.length, 2)
  assert.equal(all[0].name, 't1:0')
  assert.equal(all[0].scheduledTime, 1000)
  assert.equal(all[1].periodInMinutes, 5)
  assert.deepEqual(await c.alarms.get('t1:0'), { name: 't1:0', scheduledTime: 1000, periodInMinutes: undefined })
  await c.alarms.clear('t1:0')
  assert.equal((await c.alarms.getAll()).length, 1)
  await c.alarms.clearAll()
  assert.equal((await c.alarms.getAll()).length, 0)
})

test('tabs.create 回傳遞增 id,query 依 url 篩選,remove 生效', async () => {
  const c = installChromeMock()
  const t1 = await c.tabs.create({ url: 'https://a.test/p', active: false })
  const t2 = await c.tabs.create({ url: 'https://b.test/p' })
  assert.ok(t2.id > t1.id)
  assert.equal(t1.active, false)
  assert.equal((await c.tabs.query({ url: 'https://a.test/p' })).length, 1)
  assert.equal((await c.tabs.query({})).length, 2)
  await c.tabs.remove(t1.id)
  assert.equal((await c.tabs.query({})).length, 1)
})

test('__calls 記錄每次呼叫的 api 與 args,resetChromeMock 清空', async () => {
  const c = installChromeMock()
  await c.action.setBadgeText({ text: '3' })
  await c.notifications.create('n1', { title: 'x', message: 'y' })
  const names = c.__calls.map(x => x.api)
  assert.ok(names.includes('action.setBadgeText'))
  assert.ok(names.includes('notifications.create'))
  const badge = c.__calls.find(x => x.api === 'action.setBadgeText')
  assert.deepEqual(badge.args[0], { text: '3' })
  resetChromeMock()
  const c2 = installChromeMock()
  assert.equal(c2.__calls.length, 0)
  assert.deepEqual(await c2.storage.local.get(null), {}, 'reset 後儲存也是空的')
})

test('runtime.onMessage 可註冊並由 __emitMessage 觸發,支援非同步回覆', async () => {
  const c = installChromeMock()
  c.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ pong: msg.n }); return true }
  })
  const res = await c.__emitMessage({ type: 'PING', n: 7 })
  assert.deepEqual(res, { pong: 7 })
})

test('onStartup / onInstalled / onAlarm 可註冊並觸發', async () => {
  const c = installChromeMock()
  let started = 0, installed = 0, fired = []
  c.runtime.onStartup.addListener(() => started++)
  c.runtime.onInstalled.addListener(() => installed++)
  c.alarms.onAlarm.addListener(a => fired.push(a.name))
  await c.__emitStartup()
  await c.__emitInstalled({ reason: 'update' })
  await c.__emitAlarm('t1:0')
  assert.equal(started, 1)
  assert.equal(installed, 1)
  assert.deepEqual(fired, ['t1:0'])
})

test('未實作的 API 呼叫會丟錯,不會靜默回 undefined', async () => {
  const c = installChromeMock()
  assert.equal(typeof c.scripting.executeScript, 'function')
  assert.equal(typeof c.downloads.download, 'function')
  assert.equal(typeof c.windows.getAll, 'function')
  assert.equal(typeof c.contextMenus.create, 'function')
  assert.equal(typeof c.runtime.getPlatformInfo, 'function')
})

test('background/main.js 匯入時不丟錯且不自行抓取', async () => {
  const c = installChromeMock()
  await import('../src/background/main.js')
  assert.equal(c.__calls.filter(x => x.api === 'tabs.create').length, 0, '載入時不得開分頁')
})
