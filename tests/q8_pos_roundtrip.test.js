// AF-8：位置定位在「重選」這條路上的往返
// （keepPos 與 sameSpec 的 stripPos 都是實作了但原本沒有任何測試守門的機制）
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function freshBg() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const bg = await import('../src/background/main.js?t=' + Math.random())
  return { c, st, bg }
}

const sender = { tab: { id: 3, url: 'https://a.test/p' }, frameId: 0 }

const posTask = (over = {}) => ({
  id: 't1', name: '成交金額', url: 'https://a.test/p', mode: 'block', enabled: true,
  locator: { css: '#t', path: '', anchor: null, xpath: '' },
  spec: { mode: 'block', block: { cell: { row: { index: 4, header: '115/09/07', pos: 'last' }, col: { index: 2, header: '成交金額' } } } },
  schedule: { type: 'daily', times: ['09:30'], weekdays: [1] },
  ...over
})

test('單值任務重選之後，使用者選的定位方式要留著', async () => {
  const { st, bg } = await freshBg()
  await st.saveTask(posTask())
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [{ cell: { row: { index: 4, header: '115/09/08' }, col: { index: 2, header: '成交金額' } } }]
  }, sender)
  const back = await st.getTask('t1')
  assert.equal(back.spec.block.cell.row.pos, 'last',
    '重選只換位置與標題，定位方式被洗掉的話每天新增列的表格隔天就抓不到了')
})

test('多值任務重選之後，既有的值不得換 key（換了歷史紀錄的序列就斷了）', async () => {
  const { st, bg } = await freshBg()
  const multi = posTask({
    fields: [{ key: 'amt', name: '成交金額' }, { key: 'vol', name: '成交股數' }],
    spec: {
      mode: 'block',
      fields: [
        { key: 'amt', cell: { row: { index: 4, header: '115/09/07', pos: 'last' }, col: { index: 2, header: '成交金額' } } },
        { key: 'vol', cell: { row: { index: 4, header: '115/09/07', pos: 'last' }, col: { index: 1, header: '成交股數' } } }
      ]
    }
  })
  delete multi.spec.block
  await st.saveTask(multi)

  // 重選送回來的 picks 沒有 pos（選取模式不知道使用者設了什麼定位方式）
  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [
      { cell: { row: { index: 4, header: '115/09/07' }, col: { index: 2, header: '成交金額' } } },
      { cell: { row: { index: 4, header: '115/09/07' }, col: { index: 1, header: '成交股數' } } }
    ]
  }, sender)

  const back = await st.getTask('t1')
  assert.deepEqual(back.fields.map(f => f.key), ['amt', 'vol'],
    '帶著 pos 去比對會永遠不相等，key 重生就把歷史紀錄的序列切斷了')
  assert.deepEqual(back.fields.map(f => f.name), ['成交金額', '成交股數'], '名稱也要沿用')
  for (const f of back.spec.fields) {
    assert.equal(f.cell.row.pos, 'last', '每個值的定位方式都要留著')
  }
})

test('重選新增的值，用位置定位的軸不放會過期的標題', async () => {
  const { st, bg } = await freshBg()
  const multi = posTask({
    fields: [{ key: 'amt', name: '成交金額' }],
    spec: {
      mode: 'block',
      fields: [{ key: 'amt', cell: { row: { index: 4, header: '115/09/07', pos: 'last' }, col: { index: 2, header: '成交金額' } } }]
    }
  })
  delete multi.spec.block
  await st.saveTask(multi)

  await bg.handleMessage({
    type: 'PICKED', purpose: 'repick', taskId: 't1', locator: { css: '#t' },
    picks: [
      { cell: { row: { index: 4, header: '115/09/07' }, col: { index: 2, header: '成交金額' } } },
      { cell: { row: { index: 4, header: '115/09/07' }, col: { index: 1, header: '成交股數' } } }
    ]
  }, sender)

  const back = await st.getTask('t1')
  const added = back.fields.find(f => f.key !== 'amt')
  assert.ok(added, '要多一個值')
  assert.ok(!/115\/09\/07/.test(added.name),
    `會變的日期不該固定在名稱裡，實得 ${JSON.stringify(added.name)}`)
})

// ---- preselect：帶 pos 的任務開重選時，要勾在當下的那一列 ----

test('preselect 帶 pos 時，勾的是當下的最後一列（不是規格裡那個索引）', async () => {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>
    <table id="t">
      <thead><tr><th>日期</th><th>成交金額</th></tr></thead>
      <tbody>
        <tr><td>115/09/01</td><td id="d1">111</td></tr>
        <tr><td>115/09/02</td><td id="d2">222</td></tr>
        <tr><td>115/09/03</td><td id="d3">333</td></tr>
      </tbody>
    </table></body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  const doc = jd.window.document

  // 規格裡的索引是 0（建任務時表格只有一列），標題也早就過期了
  pm.enterPickMode({
    purpose: 'repick', taskId: 't1', initialTarget: doc.getElementById('t'),
    preselect: [{ cell: { row: { index: 0, header: '115/08/29', pos: 'last' }, col: { index: 1, header: '成交金額' } } }]
  })
  assert.equal(pm.selectedCount(), 1, '要勾得回來，不能因為標題找不到就略過')
  assert.equal(doc.getElementById('d3').hasAttribute('data-af-picked'), true,
    '勾的要是當下的最後一列')
  pm.exitPickMode()
})
