process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const date = '2026-09-22'
const originalTask = {
  id: 'r16-base', name: '升級前任務', url: 'https://r16.test/value', mode: 'number', enabled: true,
  locator: { css: '#value', path: '', anchor: null, xpath: '' }, spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
}
const oldRecord = {
  taskId: originalTask.id, slot: `${date}T09:00`, capturedAt: `${date}T01:00:00.000Z`,
  value: 12, raw: '12', status: 'ok'
}

async function clean(init = true) {
  resetChromeMock()
  const c = installChromeMock()
  const storage = await import('../src/shared/storage.js?r16=' + Math.random())
  if (init) await storage.init()
  const settings = await import('../src/shared/settings-io.js?r16=' + Math.random())
  const exporter = await import('../src/shared/export.js?r16=' + Math.random())
  return { c, storage, settings, exporter }
}

test('R16 schema 3 / AutoFetcher 0.20 資料初始化至 schema 4，任務、設定、舊紀錄與帳本可讀', async () => {
  const { c, storage } = await clean(false)
  await c.storage.local.set({
    schemaVersion: 3,
    tasks: [originalTask],
    sites: {},
    settings: { retentionDays: 90, notifications: false },
    layout: { dashboards: [] },
    [`rec:${date}`]: [oldRecord],
    runs: { [originalTask.id]: { [`${date}T09:00`]: 'ok' } }
  })
  await storage.init()
  assert.equal(storage.SCHEMA_VERSION, 4)
  assert.equal(await storage.getSchemaVersion(), 4)
  assert.equal((await storage.getTask(originalTask.id)).name, originalTask.name)
  assert.equal((await storage.getSettings()).retentionDays, 90)
  assert.deepEqual(await storage.getRecordsByDate(date), [oldRecord])
  assert.equal(await storage.getRunStatus(originalTask.id, `${date}T09:00`), 'ok')
  const raw = await c.storage.local.get(null)
  assert.ok(Array.isArray(raw[`rec:${date}`]), '舊日紀錄仍保留並可讀')
  assert.equal(raw.runs, undefined)
  assert.equal(raw[`runs:${date}`][originalTask.id][`${date}T09:00`], 'ok')
})

test('R16 新版設定備份可回匯；恢復覆蓋同 id 設定但不刪新增任務或回滾歷史', async () => {
  const { c, storage, settings, exporter } = await clean()
  await storage.saveTask(originalTask)
  await storage.appendRecord(date, oldRecord)
  await storage.saveSettings({ retentionDays: 90, notifications: false })
  const settingsBackup = await settings.exportSettings()
  const historyBackup = await exporter.buildExport({ from: date, to: date, format: 'json' })
  const parsed = JSON.parse(settingsBackup)
  assert.equal(parsed.data.schemaVersion, 4)
  assert.equal(parsed.data.tasks[0].name, originalTask.name)
  assert.doesNotMatch(settingsBackup, /capturedAt/)
  assert.deepEqual(JSON.parse(historyBackup.content).tasks[originalTask.id].records, [oldRecord])
  if (process.env.AF22_R16_BACKUP_DIR) {
    await mkdir(process.env.AF22_R16_BACKUP_DIR, { recursive: true })
    await writeFile(`${process.env.AF22_R16_BACKUP_DIR}/af22-r16-settings-fixture.json`, settingsBackup, 'utf8')
    await writeFile(`${process.env.AF22_R16_BACKUP_DIR}/af22-r16-history-fixture.json`, historyBackup.content, 'utf8')
  }

  await storage.saveTask({ ...originalTask, name: '備份後修改' })
  await storage.saveTask({ ...originalTask, id: 'r16-new', name: '備份後新增' })
  await storage.appendRecord(date, { ...oldRecord, capturedAt: `${date}T02:00:00.000Z`, value: 13, raw: '13' })
  await storage.saveSettings({ retentionDays: 30, notifications: true })
  await settings.importSettings(settingsBackup)

  assert.equal((await storage.getTask(originalTask.id)).name, originalTask.name, '同 id 後續修改由備份覆蓋')
  assert.equal((await storage.getTask('r16-new')).name, '備份後新增', '匯入是合併，不刪除備份後新增任務')
  assert.equal((await storage.getSettings()).retentionDays, 90)
  assert.equal((await storage.getRecordsByDate(date)).length, 2, '設定備份不含歷史，匯入不回滾歷史')

  resetChromeMock()
  installChromeMock()
  const target = await import('../src/shared/storage.js?r16-restore=' + Math.random())
  await target.init()
  const io = await import('../src/shared/settings-io.js?r16-restore=' + Math.random())
  await io.importSettings(settingsBackup)
  assert.equal((await target.getTask(originalTask.id)).name, originalTask.name)
})

test('R16 匯出標示目前 schema；現行 importer 對更新版檔案零寫入拒收', async () => {
  const { c, storage, settings } = await clean()
  await storage.saveTask(originalTask)
  const backup = JSON.parse(await settings.exportSettings())
  assert.equal(backup.data.schemaVersion, storage.SCHEMA_VERSION)
  const before = await c.storage.local.get(null)
  backup.data.schemaVersion = storage.SCHEMA_VERSION + 1
  await assert.rejects(() => settings.importSettings(JSON.stringify(backup)), /較新的版本/)
  assert.deepEqual(await c.storage.local.get(null), before)
})
