// AF-24 B3：編輯存檔時，表單管不到的欄位以「儲存當下」storage 內的最新值為準
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]/div[1]' }

function stored(over = {}) {
  return {
    id: 'edit-1', name: '原名', url: 'https://a.test/p', mode: 'number', locator: LOCATOR,
    spec: { mode: 'number', strategy: 'auto' }, enabled: true, order: 0,
    schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5] }, ...over
  }
}

async function setup(task) {
  resetChromeMock()
  const c = installChromeMock()
  c.__setRuntimeResponder((m) => {
    if (m.type === 'REBUILD_ALARMS') return { ok: true }
    if (m.type === 'GET_NEXT_RUNS') return { ok: true, nextRuns: {} }
    return undefined
  })
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task)
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  pk.render({ task: await st.getTask(task.id), url: task.url, locator: LOCATOR })
  return { st, pk, doc: jd.window.document }
}

test('面板開著時別處停用任務、寫入 notFoundStreak、改排序：改名存檔後保留最新值', async () => {
  const { st, pk, doc } = await setup(stored())
  // 面板開著期間：popup 停用、fetcher 記失敗、Report 拖曳排序
  await st.updateTasks(['edit-1'], t => ({ ...t, enabled: false, notFoundStreak: 2, suggestForeground: true, order: 7 }))
  doc.getElementById('name').value = '新名字'
  await pk.handleSave()
  const t = await st.getTask('edit-1')
  assert.equal(t.name, '新名字', doc.getElementById('errors')?.textContent || '')
  assert.equal(t.enabled, false, '停用中的任務不得因編輯存檔而復活')
  assert.equal(t.notFoundStreak, 2)
  assert.equal(t.suggestForeground, true)
  assert.equal(t.order, 7)
})

test('開面板時有、存檔前被別處清掉的 runtime 欄位不得從快照長回來', async () => {
  const { st, pk, doc } = await setup(stored({ notFoundStreak: 3, suggestForeground: true }))
  await st.updateTasks(['edit-1'], t => { const n = { ...t }; delete n.notFoundStreak; delete n.suggestForeground; return n })
  doc.getElementById('name').value = '改名'
  await pk.handleSave()
  const t = await st.getTask('edit-1')
  assert.equal(t.name, '改名')
  assert.equal('notFoundStreak' in t, false)
  assert.equal('suggestForeground' in t, false)
})

test('編輯中的任務已被刪除：不得重新建立，畫面說明原因', async () => {
  const { st, pk, doc } = await setup(stored())
  await st.deleteTasks(['edit-1'])
  doc.getElementById('name').value = '改名'
  await pk.handleSave()
  assert.equal(await st.getTask('edit-1'), null, '已刪除的任務不得被編輯面板復活')
  assert.match(doc.getElementById('errors')?.textContent || doc.body.textContent, /已被刪除/)
})

test('批次路徑（沒有 ctx.task、帶 taskId）存到已存在的任務：runtime 欄位同樣取最新值；任務不存在就照常新建', async () => {
  const { st, pk } = await setup(stored({ id: 'batch-1', enabled: false, notFoundStreak: 4, order: 9 }))
  const values = { ...pk.getFormData(), name: '批次改名' }
  const saved = await pk.saveTaskFromForm(values, { url: 'https://a.test/p', locator: LOCATOR }, { taskId: 'batch-1' })
  const t = await st.getTask('batch-1')
  assert.equal(saved.id, 'batch-1')
  assert.equal(t.name, '批次改名')
  assert.equal(t.enabled, false, '批次路徑也不得把停用的任務改回啟用')
  assert.equal(t.notFoundStreak, 4)
  assert.equal(t.order, 9)
  await pk.saveTaskFromForm({ ...values, name: '全新' }, { url: 'https://a.test/p', locator: LOCATOR }, { taskId: 'batch-new' })
  const n = await st.getTask('batch-new')
  assert.equal(n.name, '全新')
  assert.equal(n.enabled, true)
})

test('體檢：storage 的「任務被改過」錯誤帶 code，Picker 靠 code 重試一次而不是比對英文訊息', async () => {
  const { st } = await setup(stored())
  await assert.rejects(
    () => st.updateTasks(['edit-1'], async t => { await st.saveTask({ ...t, name: '別人改的' }); return { ...t, name: '我的' } }),
    err => err.code === st.TASK_CHANGED_ERROR
  )
  const src = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  assert.equal(/changed while updating/.test(src), false, 'UI 不得比對 storage 的錯誤訊息文字')
  assert.ok(src.includes('TASK_CHANGED_ERROR'))
})
