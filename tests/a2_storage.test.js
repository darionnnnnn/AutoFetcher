import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const mod = await import('../src/shared/storage.js?t=' + Math.random())
  await mod.init()
  return mod
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number',
  locator: { css: '#v', path: '', anchor: '', xpath: '' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] },
  enabled: true, ...over
})

const rec = (over = {}) => ({
  taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T09:00:12+08:00',
  value: 12, raw: '12', status: 'ok', ...over
})

test('init 在空 storage 建立 schemaVersion 與預設 settings', async () => {
  const s = await fresh()
  assert.equal(await s.getSchemaVersion(), 2)
  const st = await s.getSettings()
  assert.equal(st.retentionDays, 365)
})

test('init 是冪等的,不會覆蓋既有設定', async () => {
  const s = await fresh()
  await s.saveSettings({ retentionDays: 30 })
  await s.init()
  assert.equal((await s.getSettings()).retentionDays, 30)
})

test('saveTask 新增與更新;getTasks 依 order 排序', async () => {
  const s = await fresh()
  await s.saveTask(task({ id: 'a', order: 2 }))
  await s.saveTask(task({ id: 'b', order: 1 }))
  assert.deepEqual((await s.getTasks()).map(t => t.id), ['b', 'a'])
  await s.saveTask(task({ id: 'a', order: 2, name: '改名' }))
  const all = await s.getTasks()
  assert.equal(all.length, 2, '同 id 應覆蓋不是新增')
  assert.equal(all.find(t => t.id === 'a').name, '改名')
})

test('saveTask 沒給 order 時排到最後', async () => {
  const s = await fresh()
  await s.saveTask(task({ id: 'a' }))
  await s.saveTask(task({ id: 'b' }))
  const [first, second] = await s.getTasks()
  assert.equal(first.id, 'a')
  assert.equal(second.id, 'b')
  assert.ok(second.order > first.order)
})

test('saveTask 缺必要欄位要丟錯,storage 不變', async () => {
  const s = await fresh()
  await assert.rejects(() => s.saveTask({ name: '沒有 id' }))
  await assert.rejects(() => s.saveTask(task({ url: '' })))
  assert.equal((await s.getTasks()).length, 0)
})

test('getTask 取單筆,不存在回 null', async () => {
  const s = await fresh()
  await s.saveTask(task())
  assert.equal((await s.getTask('t1')).name, '總量')
  assert.equal(await s.getTask('nope'), null)
})

test('deleteTask 一併刪除該任務的所有紀錄', async () => {
  const s = await fresh()
  await s.saveTask(task())
  await s.saveTask(task({ id: 't2' }))
  await s.appendRecord('2026-09-05', rec())
  await s.appendRecord('2026-09-05', rec({ taskId: 't2' }))
  await s.deleteTask('t1')
  assert.deepEqual((await s.getTasks()).map(t => t.id), ['t2'])
  const left = await s.getRecordsByDate('2026-09-05')
  assert.equal(left.length, 1)
  assert.equal(left[0].taskId, 't2')
})

test('appendRecord / getRecordsByDate / listDates', async () => {
  const s = await fresh()
  await s.appendRecord('2026-09-03', rec())
  await s.appendRecord('2026-09-05', rec({ slot: '2026-09-05T10:00' }))
  await s.appendRecord('2026-09-05', rec({ slot: '2026-09-05T11:00' }))
  assert.equal((await s.getRecordsByDate('2026-09-05')).length, 2)
  assert.deepEqual(await s.listDates(), ['2026-09-03', '2026-09-05'], '日期需由舊到新排序')
  assert.deepEqual(await s.getRecordsByDate('1999-01-01'), [], '沒資料回空陣列不是 undefined')
})

test('每個日期各自一個 storage 鍵,不是一個大物件', async () => {
  const s = await fresh()
  await s.appendRecord('2026-09-05', rec())
  const all = await chrome.storage.local.get(null)
  assert.ok('rec:2026-09-05' in all, '應以 rec:<date> 為鍵')
  assert.ok(!('records' in all), '不得把所有日期塞進單一 records 鍵')
})

test('getRecordsInRange 取範圍內所有紀錄,含頭尾', async () => {
  const s = await fresh()
  for (const d of ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07']) {
    await s.appendRecord(d, rec({ slot: d + 'T09:00' }))
  }
  const got = await s.getRecordsInRange('2026-09-03', '2026-09-05')
  assert.equal(got.length, 2)
  assert.deepEqual(got.map(r => r.date), ['2026-09-03', '2026-09-05'], '每筆需帶 date 欄位')
})

test('保留天數:超過 retentionDays 的最舊日期被刪除', async () => {
  const s = await fresh()
  await s.saveSettings({ retentionDays: 2 })
  await s.appendRecord('2026-09-01', rec())
  await s.appendRecord('2026-09-02', rec())
  await s.appendRecord('2026-09-03', rec())
  await s.trimOldRecords('2026-09-03')
  assert.deepEqual(await s.listDates(), ['2026-09-02', '2026-09-03'])
})

test('保留天數為 0 或負數時不刪任何東西', async () => {
  const s = await fresh()
  await s.saveSettings({ retentionDays: 0 })
  await s.appendRecord('2020-01-01', rec())
  await s.trimOldRecords('2026-09-03')
  assert.deepEqual(await s.listDates(), ['2020-01-01'])
})

test('sites 以 origin 為鍵存取', async () => {
  const s = await fresh()
  await s.saveSite('https://a.test', { loginUrl: 'https://a.test/login', userSel: '#u' })
  const sites = await s.getSites()
  assert.equal(sites['https://a.test'].userSel, '#u')
  assert.equal(await s.getSite('https://nope.test'), null)
})

test('saveSettings 是合併不是覆寫', async () => {
  const s = await fresh()
  await s.saveSettings({ retentionDays: 30 })
  await s.saveSettings({ notifications: false })
  const st = await s.getSettings()
  assert.equal(st.retentionDays, 30)
  assert.equal(st.notifications, false)
})

test('schemaVersion 缺少時 init 補成現行版本且保留既有資料', async () => {
  resetChromeMock()
  const c = installChromeMock()
  await c.storage.local.set({ tasks: [task()] })
  const s = await import('../src/shared/storage.js?t=' + Math.random())
  await s.init()
  assert.equal(await s.getSchemaVersion(), 2)
  assert.equal((await s.getTasks()).length, 1, '既有資料不得被清掉')
})

test('exportAll 含 tasks/sites/settings/layout,不含紀錄', async () => {
  const s = await fresh()
  await s.saveTask(task())
  await s.appendRecord('2026-09-05', rec())
  const dump = await s.exportAll()
  assert.deepEqual(Object.keys(dump).sort(), ['layout', 'schemaVersion', 'settings', 'sites', 'tasks'])
  assert.equal(JSON.stringify(dump).includes('capturedAt'), false, '匯出設定不得含紀錄')
})
