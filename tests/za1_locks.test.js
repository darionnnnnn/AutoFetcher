// AF-21 批次 1：storage 讀-改-寫一律在同一把鎖內（跨環境鎖 shared/lock.js）
//
// 守門方式：不用壓力測試。把 chrome.storage 替身包一層——
//   1. 每次 set/remove 某鍵時，那個鍵的鎖（lockNameOf）必須正被持有；
//   2. 同一次操作內若先讀過那個鍵，讀的當下必須是「同一次持有」（同一個 holdId），
//      也就是讀跟寫在同一把鎖的同一段時間內——讀在鎖外、寫在鎖內一樣會被抓到；
//   3. 寫的當下只持有一把鎖（鎖不巢狀；同名再取一次就是死結）。
// 任何漏鎖的讀-改-寫會當場炸在犯案那一行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'
import { withLock, lockNameOf, heldLocks } from '../src/shared/lock.js'

// 這幾個 session 鍵有自己的寫入佇列、只有 background 寫（AF-20），不在本守門範圍
const EXEMPT = new Set(['session:fetchTabs'])

let reads = new Map() // lockName+key -> holdId|null
let violations = []

function guardArea(area, ns) {
  const orig = { get: area.get.bind(area), set: area.set.bind(area), remove: area.remove.bind(area) }
  const note = (key, what) => {
    const name = lockNameOf(key, ns)
    if (EXEMPT.has(name)) return null
    return name
  }
  area.get = async (keys) => {
    const list = keys === null || keys === undefined ? ['*'] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
    const held = heldLocks()
    for (const k of list) {
      if (k === '*') { reads.set(ns + ':*', null); continue }
      const name = note(k)
      if (!name) continue
      reads.set(ns + ':' + k, held.has(name) ? held.get(name) : null)
    }
    return orig.get(keys)
  }
  const checkWrite = (k, op) => {
    const name = note(k)
    if (!name) return
    const held = heldLocks()
    if (!held.has(name)) { violations.push(`${op} ${ns}:${k} 時沒有持有鎖 ${name}`); return }
    if (held.size !== 1) violations.push(`${op} ${ns}:${k} 時同時持有 ${held.size} 把鎖：${[...held.keys()].join(',')}`)
    const r = reads.has(ns + ':' + k) ? reads.get(ns + ':' + k) : (reads.has(ns + ':*') ? reads.get(ns + ':*') : undefined)
    if (r !== undefined && r !== held.get(name)) violations.push(`${op} ${ns}:${k}：先前讀取不在同一次持有內（讀在鎖外，或跨兩次持有）`)
  }
  area.set = async (items) => {
    for (const k of Object.keys(items || {})) checkWrite(k, 'set')
    return orig.set(items)
  }
  area.remove = async (keys) => {
    for (const k of (Array.isArray(keys) ? keys : [keys])) checkWrite(k, 'remove')
    return orig.remove(keys)
  }
}

async function fresh() {
  resetChromeMock()
  const chrome = installChromeMock()
  guardArea(chrome.storage.local, 'local')
  guardArea(chrome.storage.session, 'session')
  const storage = await import('../src/shared/storage.js?t=' + Math.random())
  return { chrome, storage }
}

// 每個操作前清掉讀取紀錄與違規，操作後斷言零違規
async function op(label, fn) {
  reads = new Map()
  violations = []
  await fn()
  assert.deepEqual(violations, [], `${label} 違反鎖規則`)
}

const task = (id, over = {}) => ({
  id, name: '任務' + id, url: 'https://a.test/p', mode: 'number',
  locator: { css: '#v', path: '', anchor: '', xpath: '' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] },
  enabled: true, ...over
})
const rec = (over = {}) => ({
  taskId: 't1', slot: '2026-09-05T09:00', capturedAt: '2026-09-05T01:00:12.000Z', value: 12, raw: '12', status: 'ok', ...over
})

test('lockNameOf：一般鍵用本名、同一天的紀錄鍵共用一把、session 加前綴', () => {
  assert.equal(lockNameOf('tasks'), 'tasks')
  assert.equal(lockNameOf('health', 'local'), 'health')
  assert.equal(lockNameOf('rec:2026-09-05'), 'rec@2026-09-05')
  assert.equal(lockNameOf('panel:12', 'session'), 'session:panel:12')
})

test('storage 每個寫入函式都在鎖內讀-改-寫（逐一呼叫）', async () => {
  const { storage: s } = await fresh()
  await op('init', () => s.init())
  await op('saveSettings', () => s.saveSettings({ retentionDays: 30 }))
  await op('saveTasks', () => s.saveTasks([task('t1'), task('t2')]))
  await op('saveTask', () => s.saveTask(task('t3')))
  await op('updateTasks', () => s.updateTasks(['t1', 't2'], t => ({ ...t, enabled: false })))
  await op('saveSite', () => s.saveSite('https://a.test', { enabled: true }))
  await op('appendRecords', () => s.appendRecords('2026-09-05', [rec(), rec({ taskId: 't2' })]))
  await op('appendRecord', () => s.appendRecord('2026-09-06', rec({ slot: '2026-09-06T09:00', capturedAt: '2026-09-06T01:00:00.000Z' })))
  await op('deleteRecord', () => s.deleteRecord('2026-09-05', 't2', '2026-09-05T01:00:12.000Z'))
  await op('setLastValues', () => s.setLastValues({ t1: { value: 1, capturedAt: 'x' }, t2: { value: 2, capturedAt: 'x' } }))
  await op('deleteLastValues', () => s.deleteLastValues(['t2']))
  await op('updateAlertLog', () => s.updateAlertLog(log => ({ ...log, t1: Date.now() })))
  await op('setRunStatus', () => s.setRunStatus('t1', '2026-09-05T09:00', 'ok'))
  await op('updateHealthMap', () => s.updateHealthMap(h => ({ ...h, t1: { status: 'ok' } })))
  await op('deleteHealthEntry', () => s.deleteHealthEntry('t1'))
  await op('updateMissedList', () => s.updateMissedList(list => [...list, { taskId: 't1', slot: '2026-09-05T09:00' }]))
  await op('setLastSeenAt', () => s.setLastSeenAt(Date.now()))
  await op('setLastTimezone', () => s.setLastTimezone('Asia/Taipei'))
  await op('updateRunState', () => s.updateRunState(m => ({ ...m, 't1@2026-09-05T09:00': { state: 'running', at: Date.now() } })))
  await op('updateRepickTabs', () => s.updateRepickTabs(m => ({ ...m, t1: 5 })))
  await op('setPanelCtx', () => s.setPanelCtx(7, { kind: 'new' }))
  await op('mergePanelCtx', () => s.mergePanelCtx(7, { name: 'x' }))
  await op('clearPanelCtx', () => s.clearPanelCtx(7))
  await op('updateLayout', () => s.updateLayout(l => ({ ...l, dashboards: [] })))
  await op('importRecords', () => s.importRecords({ days: [{ date: '2026-09-07', tasks: { t1: { records: [rec({ slot: '2026-09-07T09:00', capturedAt: '2026-09-07T01:00:00.000Z' })] } } }] }))
  await op('trimOldRecords', () => s.trimOldRecords('2026-10-30'))
  await op('saveSites', () => s.saveSites({ 'https://b.test': { enabled: true }, 'https://c.test': { enabled: true } }))
  await op('updateSite', () => s.updateSite('https://b.test', site => ({ ...site, failStreak: 1 })))
  await op('updateNotifyLog', () => s.updateNotifyLog(log => ({ ...log, t1: { status: 'error', at: Date.now() } })))
  await op('trimOldRuns', () => s.trimOldRuns('2026-10-30'))
  await op('runOncePerDay', () => s.runOncePerDay('lastOrphanPruneDate', '2026-10-30', async () => {}))
  await op('pruneOrphanEntries', () => s.pruneOrphanEntries())
  await op('deleteSite', () => s.deleteSite('https://a.test'))
  await op('deleteTasks', () => s.deleteTasks(['t1']))
})

test('background／其他 shared 模組的寫入也經鎖（health、missed、diag、crypto、layout-store）', async () => {
  const { storage: s } = await fresh()
  await s.init()
  await s.saveTasks([task('t1')])
  const health = await import('../src/background/health.js?t=' + Math.random())
  const missed = await import('../src/background/missed.js?t=' + Math.random())
  const diag = await import('../src/shared/diag.js?t=' + Math.random())
  const crypto = await import('../src/shared/crypto.js?t=' + Math.random())
  const layout = await import('../src/shared/layout-store.js?t=' + Math.random())
  await op('setTaskHealth', () => health.setTaskHealth('t1', { status: 'not_found' }))
  await op('markRead', () => health.markRead('t1'))
  await op('refreshMissed', () => missed.refreshMissed(Date.now(), Date.now() - 3 * 86400000))
  await op('diag.log', () => diag.log('probe', 'x'))
  await op('diag.clear', () => diag.clear())
  await op('encryptSecret', () => crypto.encryptSecret('secret'))
  let dash
  await op('addDashboard', async () => { dash = await layout.addDashboard('A') })
  await op('renameDashboard', () => layout.renameDashboard(dash.id, 'B'))
  await op('addCard', () => layout.addCard(dash.id, { type: 'number', source: ['t1'] }))
  await op('pruneCardsForTask', () => layout.pruneCardsForTask('t1'))
  await op('deleteDashboard', () => layout.deleteDashboard(dash.id))
})

test('兩個交錯的 appendRecords（替身在讀與寫之間讓出）兩筆都留下', async () => {
  const { chrome, storage: s } = await fresh()
  await s.init()
  const origGet = chrome.storage.local.get
  chrome.storage.local.get = async (k) => { const r = await origGet(k); await new Promise(res => setTimeout(res, 5)); return r }
  await Promise.all([
    s.appendRecords('2026-09-05', [rec({ taskId: 'a' })]),
    s.appendRecords('2026-09-05', [rec({ taskId: 'b' })])
  ])
  const list = await s.getRecordsByDate('2026-09-05')
  assert.deepEqual(list.map(r => r.taskId).sort(), ['a', 'b'])
})

test('updateTasks 在鎖內讀最新的任務：別人剛寫的欄位不會被舊副本洗掉', async () => {
  const { storage: s } = await fresh()
  await s.init()
  await s.saveTasks([task('t1', { notFoundStreak: 0 })])
  // 另一個寫入者（fetcher）先改了 notFoundStreak
  await s.updateTasks(['t1'], t => ({ ...t, notFoundStreak: 3 }))
  // 任務頁整批停用：只改 enabled
  const saved = await s.updateTasks(['t1', 'nope'], t => ({ ...t, enabled: false }))
  assert.equal(saved.length, 1, '不存在的 id 略過')
  const t1 = await s.getTask('t1')
  assert.equal(t1.enabled, false)
  assert.equal(t1.notFoundStreak, 3)
  // mutator 回 null＝這個任務不改
  await s.updateTasks(['t1'], () => null)
  assert.equal((await s.getTask('t1')).enabled, false)
  // 驗證沿用 saveTasks：改壞就整批不寫
  await assert.rejects(() => s.updateTasks(['t1'], t => ({ ...t, name: '' })))
  assert.equal((await s.getTask('t1')).name, '任務t1')
})

test('取鎖逾時：照做並記一筆 lock_timeout 診斷，不會永遠卡住', async () => {
  const { storage: s } = await fresh()
  await s.init()
  let release
  const holder = withLock('probe-lock', () => new Promise(r => { release = r }))
  await new Promise(r => setTimeout(r, 5))
  let ran = false
  await withLock('probe-lock', async () => { ran = true }, { timeoutMs: 30 })
  assert.equal(ran, true)
  const diag = await import('../src/shared/diag.js?t=' + Math.random())
  const all = await diag.getAll()
  assert.ok(all.some(e => e.kind === 'lock_timeout' && String(e.detail).includes('probe-lock')), '要有 lock_timeout 紀錄')
  release()
  await holder
})

test('withLock 期間 heldLocks 看得到、結束（含丟例外）就放掉', async () => {
  await fresh()
  await withLock('a1', async () => { assert.ok(heldLocks().has('a1')) })
  assert.equal(heldLocks().has('a1'), false)
  await assert.rejects(() => withLock('a2', async () => { throw new Error('x') }))
  assert.equal(heldLocks().has('a2'), false)
  // 同名第二位要等第一位做完
  const order = []
  await Promise.all([
    withLock('a3', async () => { await new Promise(r => setTimeout(r, 10)); order.push(1) }),
    withLock('a3', async () => { order.push(2) })
  ])
  assert.deepEqual(order, [1, 2])
})

test('chrome.storage 只准出現在白名單檔案（唯一寫入口）', () => {
  const allow = new Set(['shared/storage.js', 'shared/diag.js', 'shared/crypto.js', 'background/fetch-tab.js'])
  const root = new URL('../src/', import.meta.url)
  const hits = []
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const r = rel ? rel + '/' + name : name
      if (statSync(full).isDirectory()) walk(full, r)
      else if (name.endsWith('.js') && /chrome\.storage\./.test(readFileSync(full, 'utf8'))) hits.push(r)
    }
  }
  walk(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  assert.ok(hits.length > 0, '掃描集合不得為空')
  assert.deepEqual(hits.filter(h => !allow.has(h)), [])
})
