process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAlerts } from '../src/shared/alerts.js'

const locator = css => ({ css })

const mixedTask = (alerts) => ({
  id: 'mixed-alert',
  name: '混合告警',
  mode: 'multi',
  fields: [
    { key: 'price', name: '價格' },
    { key: 'label', name: '標籤' }
  ],
  spec: {
    mode: 'multi',
    fields: [
      { key: 'price', mode: 'number', source: { locator: locator('#price') }, spec: { strategy: 'auto' } },
      { key: 'label', mode: 'text', source: { locator: locator('#label') }, spec: { mode: 'text' } }
    ]
  },
  alerts
})

const record = (taskId, value, over = {}) => ({
  taskId,
  status: 'ok',
  value,
  capturedAt: '2026-09-22T09:00:00+08:00',
  ...over
})

const ids = result => result.hits.map(hit => hit.alertId)

test('F2b mixed multi 依 record 子 field.mode 評估，不把文字值當數字', () => {
  const task = mixedTask([
    { id: 'price-high', field: 'price', type: 'gt', value: 10, enabled: true },
    { id: 'label-high', field: 'label', type: 'gt', value: 0, enabled: true },
    { id: 'label-eq', field: 'label', type: 'eq', value: '001', enabled: true }
  ])

  assert.deepEqual(ids(evaluateAlerts(task, record('mixed-alert#price', 12), [])), ['price-high'])
  assert.deepEqual(ids(evaluateAlerts(task, record('mixed-alert#label', '001'), [])), ['label-eq'])
})

test('F2b 文字 eq 保留前導零與原字串', () => {
  const task = mixedTask([
    { id: 'code', field: 'label', type: 'eq', value: '001', enabled: true },
    { id: 'state', field: 'label', type: 'eq', value: '正常', enabled: true }
  ])

  assert.deepEqual(ids(evaluateAlerts(task, record('mixed-alert#label', '001'), [])), ['code'])
  assert.deepEqual(ids(evaluateAlerts(task, record('mixed-alert#label', '正常'), [])), ['state'])
  assert.deepEqual(ids(evaluateAlerts(task, record('mixed-alert#label', 1), [])), [])
})

test('F2b 文字拒絕 gt/lt/deltaPct，數字 field 仍支援門檻與歷史變動', () => {
  const task = mixedTask([
    { id: 'text-gt', field: 'label', type: 'gt', value: 0, enabled: true },
    { id: 'text-lt', field: 'label', type: 'lt', value: 999, enabled: true },
    { id: 'text-delta', field: 'label', type: 'deltaPct', value: 20, enabled: true },
    { id: 'price-delta', field: 'price', type: 'deltaPct', value: 20, enabled: true }
  ])

  assert.deepEqual(ids(evaluateAlerts(task, record('mixed-alert#label', '100'), [
    record('mixed-alert#label', '001')
  ])), [])
  assert.deepEqual(ids(evaluateAlerts(task, record('mixed-alert#price', 130), [
    record('mixed-alert#price', 100)
  ])), ['price-delta'])
})

test('F2b failStreak 仍適用文字 field，且只看非成功紀錄', () => {
  const task = mixedTask([
    { id: 'label-fail', field: 'label', type: 'failStreak', value: 2, enabled: true }
  ])
  const failed = record('mixed-alert#label', undefined, { status: 'parse_error' })
  assert.deepEqual(ids(evaluateAlerts(task, failed, [])), [])
  assert.deepEqual(ids(evaluateAlerts(task, failed, [failed])), ['label-fail'])
})

test('F2b legacy 單值告警行為維持', () => {
  const task = {
    id: 'legacy',
    mode: 'text',
    alerts: [
      { id: 'legacy-eq', type: 'eq', value: '正常', enabled: true },
      { id: 'legacy-gt', type: 'gt', value: 0, enabled: true }
    ]
  }
  assert.deepEqual(ids(evaluateAlerts(task, record('legacy', '正常'), [])), ['legacy-eq'])
  assert.deepEqual(ids(evaluateAlerts(task, record('legacy', '失敗'), [])), [])
})
