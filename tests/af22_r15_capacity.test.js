import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const locator = (i) => ({ css: `#value-${i}`, path: '', anchor: null, xpath: '' })

function multiTask(count) {
  const fields = Array.from({ length: count }, (_, i) => ({
    key: `value-${i}`, name: `欄位 ${i}`,
    mode: 'number', source: { locator: locator(i) }, spec: { strategy: 'auto' }
  }))
  return {
    id: 'bounded-multi', name: '容量測試', url: 'https://example.test/data',
    mode: 'multi', enabled: true,
    fields: fields.map(({ key, name }) => ({ key, name })),
    spec: { mode: 'multi', fields }
  }
}

test('R15 任務儲存／設定匯入共用 multi 欄數、字串與 payload 界限', async () => {
  resetChromeMock()
  installChromeMock()
  const storage = await import('../src/shared/storage.js?r15=' + Math.random())
  await storage.init()
  const settings = await import('../src/shared/settings-io.js?r15=' + Math.random())
  const caps = await import('../src/shared/task-source.js?r15=' + Math.random())

  storage.validateTask(multiTask(caps.MAX_MULTI_FIELDS))
  assert.throws(() => storage.validateTask(multiTask(caps.MAX_MULTI_FIELDS + 1)), /最多|100/)
  const oversizedString = multiTask(1)
  oversizedString.spec.fields[0].source.locator.css = 'x'.repeat(caps.MAX_MULTI_STRING_LENGTH + 1)
  assert.throws(() => storage.validateTask(oversizedString), /字串|上限/)
  const oversized = multiTask(1)
  oversized.spec.fields[0].spec.payload = 'x'.repeat(caps.MAX_MULTI_TASK_BYTES)
  assert.throws(() => storage.validateTask(oversized), /大小|bytes|上限/)

  const invalidImport = {
    kind: 'autofetcher-settings', version: 1,
    data: { schemaVersion: storage.SCHEMA_VERSION, tasks: [multiTask(caps.MAX_MULTI_FIELDS + 1)] }
  }
  await assert.rejects(() => settings.previewSettingsImport(JSON.stringify(invalidImport)), /multi|最多|100/)
})

test('R15 20×100 草稿可存，100 次 group switch 各寫一筆且回報 byte／延遲量測', async () => {
  resetChromeMock()
  const mock = installChromeMock()
  const draftApi = await import('../src/shared/pick-draft.js?r15=' + Math.random())
  const groups = Array.from({ length: draftApi.MAX_PICK_DRAFT_GROUPS }, (_, g) => ({
    key: `g-${g}`, name: `組 ${g}`,
    values: Array.from({ length: draftApi.MAX_PICK_DRAFT_VALUES }, (_, v) => ({
      key: `g-${g}-v-${v}`, name: `值 ${v}`,
      source: { locator: { css: `#g${g}-v${v}`, path: '', anchor: null, xpath: '' } },
      spec: { strategy: 'auto' }
    }))
  }))
  const base = {
    sessionId: 'r15-capacity', version: draftApi.PICK_DRAFT_VERSION, revision: 0,
    tabId: 91, documentGeneration: 1, routeIdentity: '/capacity', groups,
    activeGroupKey: groups[0].key, stage: 'selecting'
  }
  const started = performance.now()
  await draftApi.savePickDraft(base.tabId, base)
  const updateLatencies = []
  for (let i = 0; i < 100; i++) {
    const updateStarted = performance.now()
    await draftApi.updatePickDraft(base.tabId, current => ({
      ...current, activeGroupKey: groups[(i + 1) % groups.length].key
    }), { sessionId: base.sessionId, revision: i })
    updateLatencies.push(performance.now() - updateStarted)
  }
  const elapsedMs = performance.now() - started
  const writes = mock.__calls.filter(call => call.api === 'storage.session.set')
  const lastWrite = writes.at(-1)
  const stored = lastWrite.args[0][`pickDraft:${base.tabId}`]
  const encodedBytes = new TextEncoder().encode(JSON.stringify(stored)).byteLength
  const report = {
    groups: groups.length, valuesPerGroup: groups[0].values.length,
    switchUpdates: 100, sessionSetCalls: writes.length, finalSnapshotBytes: encodedBytes,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    feedbackLatencyMs: {
      mean: Number((updateLatencies.reduce((sum, n) => sum + n, 0) / updateLatencies.length).toFixed(1)),
      max: Number(Math.max(...updateLatencies).toFixed(1))
    }, node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model || 'unavailable', lastWriteCall: Boolean(lastWrite)
  }
  assert.equal(writes.length, 101, 'one initial save plus one write for each logical group switch')
  assert.ok(encodedBytes < draftApi.MAX_PICK_DRAFT_BYTES)
  assert.equal((await draftApi.getPickDraft(base.tabId)).activeGroupKey, groups[0].key)
  console.log(`R15_MEASUREMENT ${JSON.stringify(report)}`)
})
