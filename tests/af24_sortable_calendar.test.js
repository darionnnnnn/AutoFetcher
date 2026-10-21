// AF-24 E2：清單拖曳排序（取消不寫回、要超過門檻、只理會同一根手指）與月曆拉範圍的收尾
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

function listDom() {
  const dom = new JSDOM('<!doctype html><ul id="list"><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const d = dom.window.document
  // 每列 20px 高，依目前 DOM 順序算位置
  for (const li of d.querySelectorAll('li')) {
    li.getBoundingClientRect = () => {
      const i = [...d.querySelectorAll('li')].indexOf(li)
      return { top: i * 20, bottom: i * 20 + 20, height: 20, left: 0, right: 100, width: 100 }
    }
  }
  const ev = (el, type, init) => {
    const e = new dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, { clientX: 0, pointerId: 1, button: 0, ...init })
    el.dispatchEvent(e)
  }
  const order = () => [...d.querySelectorAll('li')].map(li => li.id).join('')
  return { d, ev, order }
}

async function sortableOn(d) {
  const { makeSortable } = await import('../src/ui/report/sortable.js?t=' + Math.random())
  const commits = []
  for (const li of d.querySelectorAll('li')) {
    makeSortable(li, { container: () => d.getElementById('list'), items: box => [...box.querySelectorAll('li')], onCommit: o => commits.push(o.map(el => el.id).join('')) })
  }
  return commits
}

test('拖到最後放開：寫入一次新順序', async () => {
  const { d, ev, order } = listDom()
  const commits = await sortableOn(d)
  ev(d.getElementById('a'), 'pointerdown', { clientY: 5 })
  ev(d, 'pointermove', { clientY: 55 })
  ev(d, 'pointerup', { clientY: 55 })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(order(), 'bca')
  assert.deepEqual(commits, ['bca'])
})

test('拖到一半 pointercancel：DOM 回到原順序、不寫入', async () => {
  const { d, ev, order } = listDom()
  const commits = await sortableOn(d)
  ev(d.getElementById('a'), 'pointerdown', { clientY: 5 })
  ev(d, 'pointermove', { clientY: 55 })
  assert.equal(order(), 'bca', '前置：拖曳中已即時換位')
  ev(d, 'pointercancel', {})
  await new Promise(r => setTimeout(r, 0))
  assert.equal(order(), 'abc')
  assert.deepEqual(commits, [])
})

test('只點一下（沒超過門檻）不寫入；別根手指的放開不算', async () => {
  const { d, ev } = listDom()
  const commits = await sortableOn(d)
  ev(d.getElementById('a'), 'pointerdown', { clientY: 5 })
  ev(d, 'pointerup', { clientY: 6 })
  ev(d.getElementById('a'), 'pointerdown', { clientY: 5 })
  ev(d, 'pointermove', { clientY: 55 })
  ev(d, 'pointerup', { clientY: 55, pointerId: 2 })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(commits, [], '另一根手指放開不得結束這次拖曳')
  ev(d, 'pointerup', { clientY: 55, pointerId: 1 })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(commits, ['bca'])
})

test('報表的任務列與欄位設定都用 sortable，不再自寫 pointer 排序、也不用 elementFromPoint', () => {
  const tasks = readFileSync(new URL('../src/ui/report/tasks.js', import.meta.url), 'utf8')
  const report = readFileSync(new URL('../src/ui/report/report.js', import.meta.url), 'utf8')
  assert.ok(tasks.includes('makeSortable(row'))
  assert.ok(report.includes('makeSortable(label'))
  assert.equal(/elementFromPoint/.test(report), false)
  assert.equal(/row\.addEventListener\('pointercancel'/.test(tasks), false)
})

const html = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
async function calendar() {
  resetChromeMock()
  installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html, { url: 'https://x.test/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  rp.initFromHash('#view=history&from=2026-09-10&to=2026-09-10')
  rp.renderCalendar(2026, 9, {})
  const d = jd.window.document
  const td = date => d.querySelector(`#calendar [data-date="${date}"]`)
  const ev = (el, type, init = {}) => {
    const e = new jd.window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, { button: 0, pointerId: 1, ...init })
    el.dispatchEvent(e)
  }
  return { rp, d, td, ev }
}

test('月曆從 3 號拉到 5 號、在月曆外放開：範圍是 3～5', async () => {
  const { rp, d, td, ev } = await calendar()
  ev(td('2026-09-03'), 'pointerdown')
  ev(td('2026-09-04'), 'pointerover')
  ev(td('2026-09-05'), 'pointerover')
  ev(d.body, 'pointerup')
  assert.equal(rp.getState().from, '2026-09-03')
  assert.equal(rp.getState().to, '2026-09-05')
})

test('月曆拉到一半 pointercancel：範圍不變，之後再按下放開同一格也不會用舊起點', async () => {
  const { rp, d, td, ev } = await calendar()
  ev(td('2026-09-03'), 'pointerdown')
  ev(td('2026-09-05'), 'pointerover')
  ev(d, 'pointercancel')
  assert.equal(rp.getState().from, '2026-09-10')
  ev(td('2026-09-07'), 'pointerdown')
  ev(td('2026-09-07'), 'pointerup')
  assert.equal(rp.getState().from, '2026-09-10', '按下放開同一格交給 click，不在 pointerup 算範圍')
  td('2026-09-07').click()
  assert.equal(rp.getState().from, '2026-09-07')
  assert.equal(rp.getState().to, '2026-09-07')
})
