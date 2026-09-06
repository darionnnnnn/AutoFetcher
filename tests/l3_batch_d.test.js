// AF-5 批次 D：Picker 精簡與預設值
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const phtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh(url = 'chrome-extension://abc/ui/picker/picker.html') {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(phtml, { url })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

const readWeekdays = (doc) =>
  [...doc.querySelectorAll('#weekdays input[type="checkbox"]:checked')].map(cb => Number(cb.value)).sort()

// ---- 內建預設 ----

test('新建任務的內建預設是每天 09:30', async () => {
  const { pk, doc } = await fresh()
  await pk.applyPickerDefaults(null)
  assert.equal(doc.getElementById('times').value.trim(), '09:30',
    '銀行牌告多在九點後才更新，09:00 會抓到前一天')
  assert.deepEqual(readWeekdays(doc), [0, 1, 2, 3, 4, 5, 6], '預設每天')
  assert.equal(doc.getElementById('schedule-type').value, 'daily')
})

test('內建預設不寫進 DEFAULT_SETTINGS（舊使用者沒有這個鍵）', async () => {
  const { st } = await fresh()
  const s = await st.getSettings()
  assert.equal(s.pickerDefaults, undefined, '設定檔不該預先塞這個鍵')
})

// ---- last / pinned 優先序 ----

test('上次設定會被記住並套用', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveSettings({ pickerDefaults: { last: { scheduleType: 'daily', times: ['13:00'], weekdays: [1, 3] } } })
  await pk.applyPickerDefaults(null)
  assert.equal(doc.getElementById('times').value.trim(), '13:00')
  assert.deepEqual(readWeekdays(doc), [1, 3])
})

test('固定的預設值優先於上次設定', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveSettings({
    pickerDefaults: {
      last: { scheduleType: 'daily', times: ['13:00'], weekdays: [1, 3] },
      pinned: { scheduleType: 'daily', times: ['07:45'], weekdays: [5] }
    }
  })
  await pk.applyPickerDefaults(null)
  assert.equal(doc.getElementById('times').value.trim(), '07:45')
  assert.deepEqual(readWeekdays(doc), [5])
})

test('清掉固定值之後回到上次設定', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveSettings({
    pickerDefaults: {
      last: { scheduleType: 'daily', times: ['13:00'], weekdays: [1, 3] },
      pinned: null
    }
  })
  await pk.applyPickerDefaults(null)
  assert.equal(doc.getElementById('times').value.trim(), '13:00')
})

test('編輯既有任務不套用預設值', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveSettings({ pickerDefaults: { pinned: { scheduleType: 'daily', times: ['07:45'], weekdays: [5] } } })
  const task = {
    id: 'old', name: '既有', url: 'https://x.test/o', mode: 'number', enabled: true,
    spec: { strategy: 'auto' }, schedule: { type: 'daily', times: ['21:00'], weekdays: [2] }
  }
  pk.render({ task, locator: {}, url: task.url })
  await pk.applyPickerDefaults(task)
  assert.equal(doc.getElementById('times').value.trim(), '21:00', '既有任務的設定不可被預設值蓋掉')
})

// ---- 儲存時更新 last / pinned ----

test('儲存後記住這次的設定當作下次預設', async () => {
  const { st, pk, doc } = await fresh()
  doc.getElementById('name').value = '電費'
  doc.getElementById('url').value = 'https://x.test/a'
  doc.getElementById('times').value = '11:20'
  doc.getElementById('dashboard-select').innerHTML = '<option value="none">不加入</option>'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 30))
  const s = await st.getSettings()
  assert.deepEqual(s.pickerDefaults.last.times, ['11:20'])
  assert.equal(s.pickerDefaults.pinned, undefined, '沒勾選就不該固定')
})

test('勾了「固定為預設值」才寫 pinned，且不動到 last', async () => {
  const { st, pk, doc } = await fresh()
  doc.getElementById('name').value = '電費'
  doc.getElementById('url').value = 'https://x.test/a'
  doc.getElementById('times').value = '11:20'
  const pin = doc.getElementById('pin-defaults')
  assert.ok(pin, '表單要有「將此次設定固定為預設值」的勾選框')
  pin.checked = true
  doc.getElementById('dashboard-select').innerHTML = '<option value="none">不加入</option>'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 30))
  const s = await st.getSettings()
  assert.deepEqual(s.pickerDefaults.pinned.times, ['11:20'])
  assert.deepEqual(s.pickerDefaults.last.times, ['11:20'])
})

test('寫 last 不會把既有的 pinned 洗掉', async () => {
  const { st, pk, doc } = await fresh()
  await st.saveSettings({ pickerDefaults: { pinned: { scheduleType: 'daily', times: ['07:45'], weekdays: [5] } } })
  doc.getElementById('name').value = '電費'
  doc.getElementById('url').value = 'https://x.test/a'
  doc.getElementById('times').value = '11:20'
  doc.getElementById('dashboard-select').innerHTML = '<option value="none">不加入</option>'
  await pk.handleSave()
  await new Promise(r => setTimeout(r, 30))
  const s = await st.getSettings()
  assert.deepEqual(s.pickerDefaults.pinned.times, ['07:45'], '巢狀物件要 read-modify-write')
  assert.deepEqual(s.pickerDefaults.last.times, ['11:20'])
})

// ---- 名稱預設 ----

test('選到表格時名稱預設用表格的標題', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: {}, url: 'https://bank.test/rate', nameHint: '臺灣銀行牌告匯率', blockInfo: { kind: 'table', rows: 3, cols: 4 } })
  assert.equal(doc.getElementById('name').value, '臺灣銀行牌告匯率')
})

test('沒有提示時名稱預設用預覽文字', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: {}, url: 'https://x.test/a', preview: '今日總用電量 1234 度' })
  assert.equal(doc.getElementById('name').value, '今日總用電量 1234 度'.slice(0, 20))
})

test('編輯既有任務時名稱用任務自己的名稱', async () => {
  const { pk, doc } = await fresh()
  pk.render({ task: { id: 'o', name: '既有', url: 'u', mode: 'number', spec: {}, schedule: { type: 'daily', times: ['09:00'] } }, nameHint: '不該用這個' })
  assert.equal(doc.getElementById('name').value, '既有')
})

test('名稱仍然不可空白', async () => {
  const { pk } = await fresh()
  const r = pk.validateForm({ name: '  ', scheduleType: 'daily', times: ['09:00'], weekdays: [1], strategy: 'auto' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.name)
})

// ---- 立即測試與 buildTask 共用同一份 spec（X1）----

test('buildSpec 是唯一的規格組裝入口，區塊模式帶得出 block', async () => {
  const { pk } = await fresh()
  assert.equal(typeof pk.buildSpec, 'function', '要有可共用、可測的 buildSpec')
  const values = { mode: 'block', strategy: 'auto', block: { axis: 'col', index: 3, headerText: '買入', aggregate: 'sum' } }
  const spec = pk.buildSpec(values)
  assert.equal(spec.mode, 'block')
  assert.deepEqual(spec.block, values.block)
  const task = pk.buildTask({ ...values, name: 'x', url: 'u', scheduleType: 'daily', times: ['09:00'], weekdays: [1] }, {})
  assert.deepEqual(task.spec, spec, '任務用的規格必須跟立即測試送出的完全一樣')
})

test('handleTestNow 送出的規格與 buildSpec 相同（不得另組一份）', async () => {
  const src = readFileSync(new URL('../src/ui/picker/picker.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export async function handleTestNow'))
  assert.ok(/buildSpec\(/.test(body), 'handleTestNow 必須呼叫 buildSpec')
  assert.ok(!/const spec = \{ strategy/.test(body), '不得自己再組一份 spec')
})

// ---- 移除必定失敗的策略（X2）----

test('抓取策略下拉不再提供沒有參數欄位的三個策略', async () => {
  const { doc } = await fresh()
  const values = [...doc.querySelectorAll('#strategy option')].map(o => o.value)
  assert.deepEqual(values, ['auto', 'regex'], 'attr / child / label 選了必定失敗')
})

test('既有任務用到已移除的策略時，重新儲存不得把設定弄丟', async () => {
  const { pk } = await fresh()
  const old = {
    id: 'o', name: '既有', url: 'https://x.test/o', mode: 'number', enabled: true,
    spec: { strategy: 'attr', attr: 'data-value' },
    schedule: { type: 'daily', times: ['09:00'], weekdays: [1] }
  }
  const values = { name: '既有', url: old.url, mode: 'number', strategy: 'auto', scheduleType: 'daily', times: ['09:00'], weekdays: [1] }
  const task = pk.buildTask(values, {}, old)
  assert.equal(task.spec.strategy, 'attr', '表單沒有這個選項就保留原值')
  assert.equal(task.spec.attr, 'data-value')
})

// ---- 進階設定摺疊 ----

test('進階設定預設收合，但既有欄位一個都不能少', async () => {
  const { doc } = await fresh()
  const adv = doc.getElementById('advanced-section')
  assert.ok(adv, '要有進階設定區塊')
  assert.equal(adv.hasAttribute('open'), false, '預設收合')
  for (const id of ['strategy', 'regex', 'window-from', 'window-to', 'alert-list', 'preaction-list']) {
    assert.ok(doc.getElementById(id), `${id} 必須still在，只是收起來`)
  }
})

test('編輯既有任務且進階欄位有非預設值時自動展開', async () => {
  const { pk, doc } = await fresh()
  pk.render({
    task: {
      id: 'o', name: '既有', url: 'u', mode: 'number',
      spec: { strategy: 'regex', regex: '\\d+' },
      schedule: { type: 'daily', times: ['09:00'] }
    }
  })
  assert.equal(doc.getElementById('advanced-section').hasAttribute('open'), true)
})

// ---- 設定頁可清除固定值 ----

test('設定頁提供清除固定預設值的按鈕', () => {
  const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
  assert.ok(/id="clear-pinned-defaults"/.test(html), '固定值必須有地方可以清掉')
})
