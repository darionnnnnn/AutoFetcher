process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const ORIGIN = 'https://preview.test'
const locator = (css) => ({ css, path: '', anchor: null, xpath: '' })
const FAST = { pollMs: 1, loadTimeoutMs: 200, checkTimeoutMs: 30, fillTimeoutMs: 30, extractTimeoutMs: 200 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const storage = await import('../src/shared/storage.js?af23-c=' + Math.random())
  await storage.init()
  const crypto = await import('../src/shared/crypto.js?af23-c=' + Math.random())
  const bg = await import('../src/background/main.js?af23-c=' + Math.random())
  return { c, storage, crypto, bg }
}

function singleTask(over = {}) {
  return {
    id: '__preview', name: '試抓值', url: `${ORIGIN}/value`, mode: 'number', enabled: true,
    locator: locator('#value'), spec: { strategy: 'auto' }, ...over
  }
}

function multiTask(over = {}) {
  const fields = [
    { key: 'a', name: '甲', mode: 'number', source: { locator: locator('#a') }, spec: { strategy: 'auto' } },
    { key: 'b', name: '乙', mode: 'number', source: { locator: locator('#b') }, spec: { strategy: 'auto' } }
  ]
  return {
    id: '__preview', name: '多值試抓', url: `${ORIGIN}/multi`, mode: 'multi', enabled: true,
    spec: { mode: 'multi', fields: structuredClone(fields) },
    fields: fields.map(({ key, name }) => ({ key, name })), ...over
  }
}

test('AC-C2 F11:互動試抓登入失敗不改站台失敗計數或啟用狀態', async () => {
  const { c, storage, crypto, bg } = await fresh()
  const site = {
    loginUrl: `${ORIGIN}/login`,
    selectors: {
      user: locator('#user'), pass: locator('#pass'), submit: locator('#submit')
    },
    loginCheck: { type: 'urlPrefix', value: `${ORIGIN}/login` },
    successCheck: { type: 'urlPrefix', value: `${ORIGIN}/home` },
    username: 'preview-user', passwordEnc: await crypto.encryptSecret('preview-secret'),
    enabled: true, failStreak: 2
  }
  await storage.saveSite(ORIGIN, site)
  const existing = singleTask({ id: 'formal-task', name: '正式任務' })
  await storage.saveTask(existing)
  const date = new Date().toISOString().slice(0, 10)
  await storage.appendRecord(date, { taskId: existing.id, name: existing.name, value: 501, status: 'ok', capturedAt: Date.now() - 1000 })
  await storage.setRunStatus(existing.id, `${date}T09:00`, { status: 'ok', value: 501 })
  await storage.setLastValue(existing.id, { value: 501, status: 'ok', capturedAt: Date.now() - 1000 })
  await storage.updateHealthMap(current => ({ ...current, [existing.id]: { status: 'ok', marker: 'health-formal' } }))
  await storage.updateAlertLog(current => ({ ...current, [existing.id]: { marker: 'alert-formal' } }))
  await storage.updateNotifyLog(current => ({ ...current, [ORIGIN]: { marker: 'notify-formal' } }))
  await c.alarms.create(`task:${existing.id}`, { when: Date.now() + 60000 })
  const formalSnapshot = async () => ({
    local: await c.storage.local.get(null),
    alarms: await c.alarms.getAll()
  })
  const before = await formalSnapshot()
  c.__onTabCreated = (tab) => c.__setTabState(tab.id, { url: `${ORIGIN}/login`, status: 'complete' })
  c.__setTabResponder((tabId, message) => {
    if (message.type === 'FILL_LOGIN') {
      return { ok: false, missing: 'pass' }
    }
    return { ok: false, error: 'not_found' }
  })

  let result
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await bg.handleMessage({ type: 'TEST_TASK', task: singleTask() }, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }, FAST)
  }
  assert.equal(result.ok, false)
  assert.equal((await storage.getSite(ORIGIN)).failStreak, 2, '連續互動試抓失敗不能觸發正式停用門檻')
  assert.equal((await storage.getSite(ORIGIN)).enabled, true)
  const notices = c.__calls.filter(call => call.api === 'notifications.create')
  assert.equal(notices.length, 0)
  assert.deepEqual(await formalSnapshot(), before,
    '互動登入失敗不得更動 tasks/sites/records/runs/health/lastValues/alerts/通知紀錄或 alarms')
  assert.equal((await storage.getTasks()).length, 1)
  assert.equal((await storage.getRecordsByDate(date)).length, 1)
  assert.ok(!JSON.stringify(await c.storage.local.get(null)).includes('preview-secret'))
})

test('AC-C1 F12:無頂層 locator 的一值 multi 走 TEST_TASK 並保留 field key 結果', async () => {
  const { c, bg } = await fresh()
  const extracted = []
  c.__setTabResponder((_tabId, message) => {
    if (message.type === 'EXTRACT') {
      extracted.push(message)
      return { ok: true, value: message.locator?.css === '#a' ? 17 : 29, raw: message.locator?.css === '#a' ? '17' : '29', status: 'ok', strategyUsed: 'auto', layer: 'css' }
    }
    return { ok: true }
  })
  const task = multiTask({ spec: { mode: 'multi', fields: [multiTask().spec.fields[0]] }, fields: [{ key: 'a', name: '甲' }] })
  const result = await bg.handleMessage({ type: 'TEST_TASK', task }, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }, FAST)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.fields.a.value, 17)
  assert.deepEqual(extracted.map(message => message.locator.css), ['#a'])

  const multi = multiTask()
  const multiResult = await bg.handleMessage({ type: 'TEST_TASK', task: multi }, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }, FAST)
  assert.equal(multiResult.ok, true, JSON.stringify(multiResult))
  assert.deepEqual(Object.keys(multiResult.fields).sort(), ['a', 'b'])
  assert.deepEqual(extracted.map(message => message.locator.css), ['#a', '#a', '#b'])

  const tabsBeforeInvalid = c.__calls.filter(call => call.api === 'tabs.create').length
  const emptyMulti = multiTask({ spec: { mode: 'multi', fields: [] }, fields: [] })
  const missingLocator = multiTask({ spec: { mode: 'multi', fields: [{ ...multiTask().spec.fields[0], source: {} }] }, fields: [{ key: 'a', name: '甲' }] })
  const oversizedFields = Array.from({ length: 101 }, (_, index) => ({
    key: `field-${index}`, mode: 'number', source: { locator: locator(`#field-${index}`) }, spec: { strategy: 'auto' }
  }))
  const oversized = multiTask({
    spec: { mode: 'multi', fields: oversizedFields },
    fields: oversizedFields.map(field => ({ key: field.key, name: field.key }))
  })
  for (const invalidTask of [emptyMulti, missingLocator, oversized]) {
    const invalid = await bg.handleMessage({ type: 'TEST_TASK', task: invalidTask }, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }, FAST)
    assert.equal(invalid.ok, false)
  }
  assert.equal(c.__calls.filter(call => call.api === 'tabs.create').length, tabsBeforeInvalid,
    '空 multi、缺 locator、超額 payload 都必須在建立抓取分頁前拒絕')
})

test('AC-C2:成功、離線與部分成功試抓不改正式資料或排程', async () => {
  const { c, storage, bg } = await fresh()
  const date = new Date().toISOString().slice(0, 10)
  const formal = singleTask({ id: 'formal-task', name: '正式任務' })
  await storage.saveTask(formal)
  await storage.appendRecord(date, { taskId: formal.id, name: formal.name, value: 9, status: 'ok', capturedAt: Date.now() - 1000 })
  await storage.setRunStatus(formal.id, `${date}T09:00`, { status: 'ok', value: 9 })
  await storage.setLastValue(formal.id, { value: 9, status: 'ok', capturedAt: Date.now() - 1000 })
  await storage.updateHealthMap(current => ({ ...current, [formal.id]: { status: 'ok' } }))
  await storage.updateAlertLog(current => ({ ...current, [formal.id]: { notifiedAt: 123 } }))
  await storage.updateNotifyLog(current => ({ ...current, [`${ORIGIN}#formal`]: { status: 'error', at: 123 } }))
  await c.alarms.create(`task:${formal.id}`, { when: Date.now() + 60000 })
  const snapshot = async () => ({ local: await c.storage.local.get(null), alarms: await c.alarms.getAll() })
  const before = await snapshot()
  c.__setTabResponder((_tabId, message) => message.type === 'EXTRACT'
    ? { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
    : { ok: true })

  const success = await bg.handleMessage({ type: 'TEST_TASK', task: singleTask() }, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }, FAST)
  assert.equal(success.ok, true, JSON.stringify(success))
  assert.deepEqual(await snapshot(), before, '成功試抓只回傳預覽，不得發布正式資料')

  globalThis.navigator.onLine = false
  const offline = await bg.handleMessage({ type: 'TEST_TASK', task: singleTask() }, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }, FAST)
  assert.equal(offline.ok, false)
  globalThis.navigator.onLine = true
  assert.deepEqual(await snapshot(), before, '離線失敗不得寫入正式資料')

  const partialTask = multiTask()
  c.__setTabResponder((_tabId, message) => message.type === 'EXTRACT'
    ? message.locator.css === '#a'
      ? { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }
      : { ok: false, error: 'not_found', message: '第二值找不到' }
    : { ok: true })
  const partial = await bg.handleMessage({ type: 'TEST_TASK', task: partialTask }, { url: 'chrome-extension://autofetcher-test/ui/picker/picker.html' }, FAST)
  assert.equal(partial.ok, true)
  assert.equal(partial.fields.a.ok, true)
  assert.equal(partial.fields.b.ok, false)
  assert.deepEqual(await snapshot(), before, 'partial 試抓同樣不得發布正式資料或調整 alarms')
})
