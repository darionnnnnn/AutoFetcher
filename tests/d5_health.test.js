import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const he = await import('../src/background/health.js?t=' + Math.random())
  return { c, st, he }
}

const task = (id, over = {}) => ({
  id, name: id, url: 'https://a.test/p', mode: 'number', enabled: true,
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }, ...over
})

test('沒有任務時是停用燈號', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([], {}, [])
  assert.equal(s.level, 'off')
})

test('全部任務停用時是停用燈號', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([task('t1', { enabled: false })], {}, [])
  assert.equal(s.level, 'off')
})

test('一切正常是綠燈', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([task('t1')], { t1: { status: 'ok' } }, [])
  assert.equal(s.level, 'green')
  assert.equal(s.redCount, 0)
  assert.equal(s.yellowCount, 0)
})

test('沒有任何健康紀錄的新任務算綠燈,不算異常', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([task('t1')], {}, [])
  assert.equal(s.level, 'green')
})

test('預檢失敗是紅燈,理由帶進摘要', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([task('t1', { name: '總量' })], { t1: { status: 'login_failed' } }, [])
  assert.equal(s.level, 'red')
  assert.equal(s.redCount, 1)
  assert.match(s.summary, /總量/)
  assert.match(s.summary, /登入/)
})

test('選擇器失效、解析失敗、抓取失敗都是紅燈', async () => {
  const { he } = await fresh()
  for (const st of ['selector_lost', 'parse_error', 'failed']) {
    const s = he.computeHealth([task('t1')], { t1: { status: st } }, [])
    assert.equal(s.level, 'red', `${st} 應為紅燈`)
  }
})

test('備援、遲到、部分抓取是黃燈', async () => {
  const { he } = await fresh()
  for (const st of ['fallback', 'late', 'partial']) {
    const s = he.computeHealth([task('t1')], { t1: { status: st } }, [])
    assert.equal(s.level, 'yellow', `${st} 應為黃燈`)
  }
})

test('有錯過清單時至少是黃燈', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([task('t1')], { t1: { status: 'ok' } }, [{ taskId: 't1', slot: 'x' }])
  assert.equal(s.level, 'yellow')
  assert.equal(s.yellowCount, 1)
})

test('紅燈壓過黃燈', async () => {
  const { he } = await fresh()
  const s = he.computeHealth(
    [task('t1'), task('t2')],
    { t1: { status: 'fallback' }, t2: { status: 'login_failed' } },
    [{ taskId: 't1', slot: 'x' }]
  )
  assert.equal(s.level, 'red')
  assert.equal(s.redCount, 1)
})

test('已讀的項目不計入燈號數字,但燈號等級不變', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([task('t1')], { t1: { status: 'login_failed', read: true } }, [])
  assert.equal(s.redCount, 0)
  assert.equal(s.level, 'green', '已讀且沒有其他問題時回綠')
})

test('applyBadge:紅燈設紅底與數字', async () => {
  const { c, he } = await fresh()
  await he.applyBadge({ level: 'red', redCount: 2, yellowCount: 0, summary: '2 個任務異常' })
  const text = c.__calls.find(x => x.api === 'action.setBadgeText')
  const color = c.__calls.find(x => x.api === 'action.setBadgeBackgroundColor')
  const title = c.__calls.find(x => x.api === 'action.setTitle')
  assert.equal(text.args[0].text, '2')
  assert.match(String(color.args[0].color).toUpperCase(), /^#(F|D|C|E)/, '紅色系')
  assert.match(title.args[0].title, /2 個任務異常/)
})

test('applyBadge:綠燈不顯示任何數字', async () => {
  const { c, he } = await fresh()
  await he.applyBadge({ level: 'green', redCount: 0, yellowCount: 0, summary: '正常' })
  assert.equal(c.__calls.find(x => x.api === 'action.setBadgeText').args[0].text, '')
})

test('applyBadge:停用顯示暫停符號', async () => {
  const { c, he } = await fresh()
  await he.applyBadge({ level: 'off', redCount: 0, yellowCount: 0, summary: '已暫停' })
  assert.equal(c.__calls.find(x => x.api === 'action.setBadgeText').args[0].text, 'II')
})

test('setTaskHealth 寫入並帶時間,refreshBadge 會更新燈號', async () => {
  const { c, st, he } = await fresh()
  await st.saveTask(task('t1'))
  await he.setTaskHealth('t1', { status: 'selector_lost', reason: '找不到元素' })
  const h = await he.getHealth()
  assert.equal(h.t1.status, 'selector_lost')
  assert.equal(typeof h.t1.at, 'number')
  assert.equal(h.t1.read, false, '新問題預設未讀')
  await he.refreshBadge()
  assert.equal(c.__calls.filter(x => x.api === 'action.setBadgeText').pop().args[0].text, '1')
})

test('markRead 讓數字減少,問題本身還在', async () => {
  const { st, he } = await fresh()
  await st.saveTask(task('t1'))
  await he.setTaskHealth('t1', { status: 'selector_lost' })
  await he.markRead('t1')
  const h = await he.getHealth()
  assert.equal(h.t1.read, true)
  assert.equal(h.t1.status, 'selector_lost', '已讀不等於已解決')
})

test('狀態變好時已讀標記重置,下次出問題還會提醒', async () => {
  const { st, he } = await fresh()
  await st.saveTask(task('t1'))
  await he.setTaskHealth('t1', { status: 'selector_lost' })
  await he.markRead('t1')
  await he.setTaskHealth('t1', { status: 'ok' })
  await he.setTaskHealth('t1', { status: 'selector_lost' })
  assert.equal((await he.getHealth()).t1.read, false)
})

test('任務被刪除後其健康紀錄不再影響燈號', async () => {
  const { he } = await fresh()
  const s = he.computeHealth([], { gone: { status: 'login_failed' } }, [])
  assert.equal(s.level, 'off')
  assert.equal(s.redCount, 0)
})
