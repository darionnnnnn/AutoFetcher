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
  const tasks = await storage.getTasks()
  assert.equal(tasks.length, 0)
  assert.equal((await storage.getRecordsByDate(new Date().toISOString().slice(0, 10))).length, 0)
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
