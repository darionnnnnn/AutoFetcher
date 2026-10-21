// 體檢輪：本機維護的任務欄位只有一份清單；匯入檔沒帶就沿用本機（含 precheckLeadMinutes）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { LOCAL_TASK_FIELDS } from '../src/shared/task-source.js'

test('清單只有 task-source 一份，Picker 與 settings-io 都引用它', () => {
  assert.deepEqual([...LOCAL_TASK_FIELDS], ['enabled', 'foreground', 'suggestForeground', 'notFoundStreak', 'precheckLeadMinutes'])
  const picker = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  const io = readFileSync(new URL('../src/shared/settings-io.js', import.meta.url), 'utf8')
  assert.ok(picker.includes('const RUNTIME_FIELDS = LOCAL_TASK_FIELDS'))
  assert.ok(io.includes('[...LOCAL_TASK_FIELDS, '))
  assert.equal(/\['enabled', 'foreground', 'suggestForeground'/.test(picker + io), false, '不得再各抄一張')
})

test('匯入檔沒帶 precheckLeadMinutes／notFoundStreak 時沿用本機；帶了就以檔案為準', async () => {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const io = await import('../src/shared/settings-io.js?t=' + Math.random())
  const base = { id: 'imp-1', name: '原', url: 'https://a.test/p', mode: 'number', locator: { css: '#v' }, spec: { strategy: 'auto' },
    schedule: { type: 'daily', times: ['09:00'] } }
  await st.saveTask({ ...base, enabled: false, precheckLeadMinutes: 7, notFoundStreak: 2 })
  const file = JSON.stringify({ kind: 'autofetcher-settings', version: 1, exportedAt: 'x',
    data: { schemaVersion: st.SCHEMA_VERSION, tasks: [{ ...base, name: '匯入改名', foreground: true }], sites: {}, settings: {} } })
  const { plan } = await io.previewSettingsImport(file)
  await io.applySettingsImport(plan)
  const t = await st.getTask('imp-1')
  assert.equal(t.name, '匯入改名')
  assert.equal(t.foreground, true, '檔案有帶就以檔案為準')
  assert.equal(t.precheckLeadMinutes, 7, '檔案沒帶就沿用本機（以前這一欄被洗掉）')
  assert.equal(t.notFoundStreak, 2)
  assert.equal(t.enabled, false)
})
