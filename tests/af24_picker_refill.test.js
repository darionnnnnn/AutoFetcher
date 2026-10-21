// AF-24 B4：同一份面板文件 render 第二個任務時，每一欄都確定地寫，不殘留上一個任務的值
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]/div[1]' }

async function setup() {
  resetChromeMock()
  installChromeMock()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { pk, doc: jd.window.document }
}

const taskA = {
  id: 'a', name: 'A', url: 'https://a.test/p', mode: 'number', locator: LOCATOR,
  spec: { mode: 'number', strategy: 'css-number', regex: '(\\d+)' },
  schedule: { type: 'interval', everyMinutes: 5, times: ['07:15', '18:00'] }
}
const taskB = {
  id: 'b', name: 'B', url: 'https://b.test/p', mode: 'number', locator: LOCATOR,
  spec: { mode: 'number' },
  schedule: { type: 'interval' }
}
const blockA = {
  id: 'ba', name: 'BA', url: 'https://a.test/t', mode: 'block', locator: LOCATOR,
  spec: { mode: 'block', block: { axis: 'col', index: 1, aggregate: 'max' } },
  schedule: { type: 'daily', times: ['10:00'] }
}
const blockB = {
  id: 'bb', name: 'BB', url: 'https://a.test/t2', mode: 'block', locator: LOCATOR,
  spec: { mode: 'block', block: { axis: 'col', index: 2 } },
  schedule: { type: 'daily', times: ['11:00'] }
}

test('A（舊策略＋regex＋interval 5 分＋時刻）之後 render B（全缺）：表單回到 B 的定義與預設', async () => {
  const { pk, doc } = await setup()
  pk.render({ task: taskA, url: taskA.url, locator: LOCATOR })
  assert.equal(doc.getElementById('strategy').value, 'css-number')
  pk.render({ task: taskB, url: taskB.url, locator: LOCATOR })
  const sel = doc.getElementById('strategy')
  assert.equal(sel.value, 'auto')
  assert.equal([...sel.options].some(o => o.value === 'css-number'), false, 'A 的舊策略選項不得留在下拉')
  assert.equal(doc.getElementById('regex').value, '')
  assert.equal(doc.getElementById('every-minutes').value, '15')
  assert.equal(doc.getElementById('times').value, '09:30', '切回每日時不得看到 A 的時刻')
  const form = pk.getFormData()
  assert.equal(form.strategy, 'auto')
  assert.equal(form.regex ?? '', '')
})

test('block A（max）之後 render block B（沒寫合計方式）：合計方式回預設', async () => {
  const { pk, doc } = await setup()
  pk.render({ task: blockA, url: blockA.url, locator: LOCATOR })
  assert.equal(doc.getElementById('block-aggregate').value, 'max')
  pk.render({ task: blockB, url: blockB.url, locator: LOCATOR })
  assert.equal(doc.getElementById('block-aggregate').value, 'sum')
})

test('F6 換目標重畫時清掉上一個目標的試抓說明', async () => {
  const { pk, doc } = await setup()
  pk.render({ task: taskA, url: taskA.url, locator: LOCATOR })
  const note = doc.getElementById('test-note')
  note.textContent = '上一個目標的試抓說明'
  note.dataset.state = 'warn'
  pk.render({ task: taskB, url: taskB.url, locator: LOCATOR })
  assert.equal(doc.getElementById('test-note').textContent, '')
  assert.equal('state' in doc.getElementById('test-note').dataset, false)
})
