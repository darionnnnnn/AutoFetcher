// AF-20 作業 A2/B1:fetcher 改經抓取分頁入口;同站台沿用分頁前依前置動作重載
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 50, extraDelayMs: 0, extractTimeoutMs: 200 }
const OK = { ok: true, value: 12, raw: '12', status: 'ok', strategyUsed: 'auto', layer: 'css' }

async function fresh(settings) {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  if (settings) await st.saveSettings(settings)
  const fe = await import('../src/background/fetcher.js?t=' + Math.random())
  c.__setTabResponder((tabId, msg) => (msg.type === 'RUN_PRE_ACTIONS' ? { ok: true } : OK))
  return { c, st, fe }
}

const task = (over = {}) => ({
  id: 't1', name: '總量', url: 'https://a.test/p', mode: 'number', enabled: true,
  locator: { css: '#v', path: '', anchor: null, xpath: '' },
  spec: { strategy: 'auto' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  ...over
})

const callsOf = (c, api) => c.__calls.filter(x => x.api === api)
// 「對這個分頁做了事」的全部呼叫:送訊息、注入、捲動都算
const touched = (c) => new Set([
  ...callsOf(c, 'tabs.sendMessage').map(x => x.args[0]),
  ...callsOf(c, 'scripting.executeScript').map(x => x.args[0]?.target?.tabId)
])

// ---- 排程不碰使用者的分頁 ----

test('使用者開著同網址的分頁:排程完全不碰它,在專用視窗抓完關掉', async () => {
  const { c, st, fe } = await fresh()
  const mine = await c.tabs.create({ url: 'https://a.test/p', active: true })
  await st.saveTask(task())
  const rec = await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.equal(touched(c).has(mine.id), false, '不得對使用者的分頁送訊息或注入')
  assert.equal(callsOf(c, 'windows.create').length, 1)
  assert.equal(callsOf(c, 'windows.remove').length, 1, '抓完關掉專用視窗')
  assert.ok(!callsOf(c, 'tabs.remove').some(x => x.args[0] === mine.id))
  assert.ok(!callsOf(c, 'tabs.update').some(x => x.args[0] === mine.id), '也不得切換或改動使用者的分頁')
})

test('抓取路徑不再用網址查分頁(tabs.query 帶 url)', async () => {
  const { c, st, fe } = await fresh()
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(callsOf(c, 'tabs.query').filter(x => 'url' in (x.args[0] || {})).length, 0)
})

test('同站台兩個任務網址 query 不同:同一個專用視窗、同一頁不導覽', async () => {
  const { c, st, fe } = await fresh()
  const t1 = task({ id: 't1', url: 'https://a.test/p?tok=1' })
  const t2 = task({ id: 't2', url: 'https://a.test/p?tok=2' })
  await st.saveTask(t1)
  await st.saveTask(t2)
  await Promise.all([
    fe.runTask(t1, { slot: '2026-09-05T09:00', ...FAST }),
    fe.runTask(t2, { slot: '2026-09-05T09:00', ...FAST })
  ])
  assert.equal(callsOf(c, 'windows.create').length, 1)
  assert.equal(callsOf(c, 'tabs.update').filter(x => typeof x.args[1]?.url === 'string').length, 0)
  assert.equal(callsOf(c, 'tabs.reload').length, 0, '兩個都沒有前置動作,不重載')
  assert.equal(callsOf(c, 'windows.remove').length, 1)
  assert.equal((await st.getRecordsByDate('2026-09-05')).length, 2)
})

test('設定成 tab 模式:在目前視窗開背景分頁,一樣不碰使用者的分頁', async () => {
  const { c, st, fe } = await fresh({ fetchTabMode: 'tab' })
  const mine = await c.tabs.create({ url: 'https://a.test/p', active: true })
  await st.saveTask(task())
  await fe.runTask(task(), { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(callsOf(c, 'windows.create').length, 0)
  const created = callsOf(c, 'tabs.create').filter(x => x.args[0]?.url === 'https://a.test/p' && x.args[0]?.active === false)
  assert.equal(created.length, 1)
  assert.equal(touched(c).has(mine.id), false)
})

// ---- 立即測試(帶 tabId)維持用使用者眼前的分頁 ----

test('立即測試帶 tabId 且是同一頁:就用那個分頁,不開也不關任何東西', async () => {
  const { c, st, fe } = await fresh()
  const mine = await c.tabs.create({ url: 'https://a.test/p?x=1', active: true })
  await st.saveTask(task())
  const res = await fe.runTask(task(), { dryRun: true, reason: 'manual', tabId: mine.id, ...FAST })
  assert.equal(res.ok, true)
  assert.deepEqual([...touched(c)].filter(x => x !== undefined), [mine.id])
  assert.equal(callsOf(c, 'windows.create').length, 0)
  assert.equal(callsOf(c, 'tabs.create').length, 1, '只有測試自己建的那一個')
  assert.equal(callsOf(c, 'windows.remove').length + callsOf(c, 'tabs.remove').length, 0)
})

test('立即測試帶 tabId 但使用者已經換到別的網站:改走專用視窗', async () => {
  const { c, st, fe } = await fresh()
  const mine = await c.tabs.create({ url: 'https://other.test/', active: true })
  await st.saveTask(task())
  await fe.runTask(task(), { dryRun: true, reason: 'manual', tabId: mine.id, ...FAST })
  assert.equal(touched(c).has(mine.id), false)
  assert.equal(callsOf(c, 'windows.create').length, 1)
  assert.equal(callsOf(c, 'windows.remove').length, 1)
})

// ---- 前景抓取 ----

test('前景:在最後聚焦的視窗開新分頁,不建專用視窗;抓完還原並關掉', async () => {
  const { c, st, fe } = await fresh()
  const original = await c.tabs.create({ url: 'https://other.test/', active: true })
  const mine = await c.tabs.create({ url: 'https://a.test/p', active: false })
  const t = task({ foreground: true })
  await st.saveTask(t)
  const rec = await fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })
  assert.equal(rec.status, 'ok')
  assert.equal(callsOf(c, 'windows.create').length, 0)
  assert.equal(touched(c).has(mine.id), false, '前景也不沿用使用者的分頁')
  const fgCreate = callsOf(c, 'tabs.create').find(x => x.args[0]?.active === true && x.args[0]?.url === 'https://a.test/p')
  assert.ok(fgCreate)
  const act = callsOf(c, 'tabs.update').filter(x => x.args[1]?.active === true)
  assert.equal(act[act.length - 1].args[0], original.id)
  const removed = callsOf(c, 'tabs.remove').map(x => x.args[0])
  assert.equal(removed.length, 1)
  assert.ok(![original.id, mine.id].includes(removed[0]))
})

test('前景抓取失敗(擷取丟例外)也要還原並關掉自己的分頁', async () => {
  const { c, st, fe } = await fresh()
  const original = await c.tabs.create({ url: 'https://other.test/', active: true })
  c.__setTabResponder(() => { throw new Error('boom') })
  const t = task({ foreground: true })
  await st.saveTask(t)
  await fe.runTask(t, { slot: '2026-09-05T09:00', attempt: 3, reviveDelaysMs: [], ...FAST })
  const act = callsOf(c, 'tabs.update').filter(x => x.args[1]?.active === true)
  assert.equal(act[act.length - 1].args[0], original.id)
  assert.equal(callsOf(c, 'tabs.remove').length, 1)
})

// ---- B1:沿用分頁前依前置動作重載 ----

// 依序跑兩個同站台任務(同一頁),回傳事件序列:
// 't1'/'t2' = 對分頁送出的訊息屬於哪個任務;'R' = 對共用分頁的重載或導覽
async function runPair(pre1, pre2) {
  const { c, st, fe } = await fresh()
  const mk = (id, n, pre) => task({
    id,
    locator: { css: `#v${n}`, path: '', anchor: null, xpath: '' },
    ...(pre ? { preActions: [{ type: 'click', locator: { css: `#b${n}` } }] } : {})
  })
  const t1 = mk('t1', 1, pre1)
  const t2 = mk('t2', 2, pre2)
  await st.saveTask(t1)
  await st.saveTask(t2)
  await Promise.all([
    fe.runTask(t1, { slot: '2026-09-05T09:00', ...FAST }),
    fe.runTask(t2, { slot: '2026-09-05T09:00', ...FAST })
  ])
  const seq = []
  for (const x of c.__calls) {
    if (x.api === 'tabs.sendMessage') {
      const m = x.args[1]
      const css = m?.locator?.css || m?.actions?.[0]?.locator?.css || ''
      const who = css.endsWith('1') ? 't1' : css.endsWith('2') ? 't2' : '?'
      if (seq[seq.length - 1] !== who) seq.push(who)
    } else if (x.api === 'tabs.reload' || (x.api === 'tabs.update' && typeof x.args[1]?.url === 'string')) {
      seq.push('R')
    }
  }
  return { c, seq }
}

test('前置動作(有,有):第二個任務開始前重載', async () => {
  const { seq } = await runPair(true, true)
  assert.deepEqual(seq, ['t1', 'R', 't2'])
})

test('前置動作(有,無):上一個任務按過東西,頁面已經不是原樣,也要重載', async () => {
  const { seq } = await runPair(true, false)
  assert.deepEqual(seq, ['t1', 'R', 't2'])
})

test('前置動作(無,有):這個任務要按東西,從乾淨的頁面開始', async () => {
  const { seq } = await runPair(false, true)
  assert.deepEqual(seq, ['t1', 'R', 't2'])
})

test('前置動作(無,無):同一頁直接沿用,不重載', async () => {
  const { c, seq } = await runPair(false, false)
  assert.deepEqual(seq, ['t1', 't2'])
  assert.equal(callsOf(c, 'windows.create').length, 1)
})

test('重載之後頁面是乾淨的:(有,無,無)只在第二個任務前重載一次', async () => {
  const { c, st, fe } = await fresh()
  const ts = [
    task({ id: 't1', preActions: [{ type: 'click', locator: { css: '#b1' } }] }),
    task({ id: 't2' }),
    task({ id: 't3' })
  ]
  for (const t of ts) await st.saveTask(t)
  await Promise.all(ts.map(t => fe.runTask(t, { slot: '2026-09-05T09:00', ...FAST })))
  const reloads = callsOf(c, 'tabs.reload').length
    + callsOf(c, 'tabs.update').filter(x => typeof x.args[1]?.url === 'string').length
  assert.equal(reloads, 1)
})

test('前置動作中途失敗也算按過(頁面可能已經被改動):下一個任務前重載', async () => {
  const { c, st, fe } = await fresh()
  c.__setTabResponder((tabId, msg) => (msg.type === 'RUN_PRE_ACTIONS' ? { ok: false, error: 'not_found' } : OK))
  const t1 = task({ id: 't1', preActions: [{ type: 'click', locator: { css: '#b1' } }] })
  const t2 = task({ id: 't2' })
  await st.saveTask(t1)
  await st.saveTask(t2)
  await Promise.all([
    fe.runTask(t1, { slot: '2026-09-05T09:00', attempt: 3, ...FAST }),
    fe.runTask(t2, { slot: '2026-09-05T09:00', ...FAST })
  ])
  const reloads = callsOf(c, 'tabs.reload').length
    + callsOf(c, 'tabs.update').filter(x => typeof x.args[1]?.url === 'string').length
  assert.equal(reloads, 1)
})
