import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const ex = await import('../src/shared/export.js?t=' + Math.random())
  return { st, ex }
}

const task = (id, name) => ({ id, name, url: 'https://a.test/p', mode: 'number' })
const rec = (taskId, slot, value, over = {}) => ({
  taskId, slot, capturedAt: slot + ':05+08:00', value, raw: String(value), status: 'ok', ...over
})

test('buildExport json 單日:依 SPEC §5 schema', async () => {
  const { st, ex } = await fresh()
  await st.saveTask(task('t1', '總量'))
  await st.appendRecord('2026-09-05', rec('t1', '2026-09-05T09:00', 12))
  const out = await ex.buildExport({ from: '2026-09-05', to: '2026-09-05', format: 'json' })
  const data = JSON.parse(out.content)
  assert.equal(data.date, '2026-09-05')
  assert.equal(data.tasks.t1.name, '總量')
  assert.equal(data.tasks.t1.records.length, 1)
  assert.equal(data.tasks.t1.records[0].value, 12)
  assert.equal(data.days, undefined, '單日不得包成 days')
})

test('buildExport json 多日:包成 days 陣列', async () => {
  const { st, ex } = await fresh()
  await st.saveTask(task('t1', '總量'))
  await st.appendRecord('2026-09-04', rec('t1', '2026-09-04T09:00', 1))
  await st.appendRecord('2026-09-05', rec('t1', '2026-09-05T09:00', 2))
  const out = await ex.buildExport({ from: '2026-09-04', to: '2026-09-05', format: 'json' })
  const data = JSON.parse(out.content)
  assert.equal(data.days.length, 2)
  assert.deepEqual(data.days.map(d => d.date), ['2026-09-04', '2026-09-05'])
})

test('buildExport 檔名格式', async () => {
  const { st, ex } = await fresh()
  await st.appendRecord('2026-09-05', rec('t1', '2026-09-05T09:00', 1))
  const one = await ex.buildExport({ from: '2026-09-05', to: '2026-09-05', format: 'json' })
  assert.equal(one.filename, 'AutoFetcher/2026-09-05.json')
  const many = await ex.buildExport({ from: '2026-09-01', to: '2026-09-05', format: 'csv' })
  assert.equal(many.filename, 'AutoFetcher/2026-09-01_2026-09-05.csv')
})

test('buildExport csv:表頭與欄位順序固定', async () => {
  const { st, ex } = await fresh()
  await st.saveTask(task('t1', '總量'))
  await st.appendRecord('2026-09-05', rec('t1', '2026-09-05T09:00', 12))
  const out = await ex.buildExport({ from: '2026-09-05', to: '2026-09-05', format: 'csv' })
  const lines = out.content.trim().split('\n')
  assert.equal(lines[0], 'date,slot,capturedAt,taskId,taskName,value,raw,status')
  assert.equal(lines[1], '2026-09-05,2026-09-05T09:00,2026-09-05T09:00:05+08:00,t1,總量,12,12,ok')
})

test('buildExport csv:含逗號/引號/換行的值要跳脫', async () => {
  const { st, ex } = await fresh()
  await st.saveTask(task('t1', '名稱,含逗號'))
  await st.appendRecord('2026-09-05', rec('t1', '2026-09-05T09:00', 1, { raw: '他說"你好"\n換行' }))
  const out = await ex.buildExport({ from: '2026-09-05', to: '2026-09-05', format: 'csv' })
  assert.ok(out.content.includes('"名稱,含逗號"'), '含逗號要加引號')
  assert.ok(out.content.includes('"他說""你好""'), '引號要重複兩次跳脫')
})

test('buildExport 空範圍:仍產生合法檔案,不丟錯', async () => {
  const { ex } = await fresh()
  const out = await ex.buildExport({ from: '2020-01-01', to: '2020-01-02', format: 'json' })
  const data = JSON.parse(out.content)
  assert.equal(data.days.length, 2)
  assert.equal(data.days[0].tasks && Object.keys(data.days[0].tasks).length, 0)
})

test('buildExport 未知格式丟錯', async () => {
  const { ex } = await fresh()
  await assert.rejects(() => ex.buildExport({ from: '2026-09-05', to: '2026-09-05', format: 'xml' }))
})

test('download 呼叫 chrome.downloads 且 saveAs 為 true', async () => {
  const { ex } = await fresh()
  await ex.download({ filename: 'AutoFetcher/x.json', content: '{}' })
  const call = chrome.__calls.find(c => c.api === 'downloads.download')
  assert.ok(call, '應呼叫 downloads.download')
  assert.equal(call.args[0].filename, 'AutoFetcher/x.json')
  assert.equal(call.args[0].saveAs, true, '必須讓使用者選存檔位置')
  assert.ok(String(call.args[0].url).startsWith('data:'), '以 data URL 傳內容')
})

test('已刪除任務的舊紀錄仍會被匯出,任務名以 id 代替', async () => {
  const { st, ex } = await fresh()
  await st.appendRecord('2026-09-05', rec('gone', '2026-09-05T09:00', 5))
  const out = await ex.buildExport({ from: '2026-09-05', to: '2026-09-05', format: 'json' })
  const data = JSON.parse(out.content)
  assert.equal(data.tasks.gone.name, 'gone')
  assert.equal(data.tasks.gone.records.length, 1)
})
