// AF-21 批次 4：Picker 的「還不能儲存」守門——說出原因、原因就在儲存鈕旁邊、點原因就跳到那一欄
// 儲存鈕不 disabled：按下去若有原因，展開原因區並把焦點送到第一條（不得靜默無事）。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const PICKER_HTML = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(PICKER_HTML, { url: 'chrome-extension://abc/ui/picker/picker.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document, win: jd.window }
}

const LOCATOR = { css: '#v', path: 'body > div', anchor: null, xpath: '/html[1]/body[1]' }

test('原因區在捲動區外、緊貼在固定列上方，而且沒有原因時不佔版面', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  const box = doc.getElementById('errors')
  assert.ok(box, '#errors 存在')
  assert.equal(box.getAttribute('role'), 'alert')
  assert.equal(box.closest('.settings-body'), null, '不得在捲動區裡（在底部按儲存時看不到）')
  const footer = doc.querySelector('#picker-form > footer')
  let next = box.nextElementSibling
  while (next && next.hidden && next !== footer) next = next.nextElementSibling
  assert.equal(next, footer, '原因區與固定列之間不得夾著看得見的其他東西')
  assert.equal(box.hidden, true, '沒有原因時隱藏')
})

test('沒有目標：按儲存零寫入、說出原因、焦點移到原因上；儲存鈕從頭到尾不是 disabled', async () => {
  const { st, pk, doc } = await fresh()
  pk.render({ url: 'https://a.test/p' })
  doc.getElementById('name').value = '某任務'
  assert.equal(doc.getElementById('save').disabled, false)
  await pk.handleSave()
  assert.deepEqual(await st.getTasks(), [], '沒有目標不得存出一個永遠抓不到的任務')
  const box = doc.getElementById('errors')
  assert.equal(box.hidden, false)
  assert.match(box.textContent, /還沒選要抓的內容/)
  assert.ok(box.contains(doc.activeElement) && doc.activeElement !== box.ownerDocument.body, '焦點要在原因區裡')
  assert.equal(doc.getElementById('save').disabled, false, '儲存鈕不得變成 disabled')
})

test('名稱被清空：原因可點，點了跳到名稱欄並標記 aria-invalid', async () => {
  const { st, pk, doc, win } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('name').value = '   '
  await pk.handleSave()
  assert.deepEqual(await st.getTasks(), [])
  const box = doc.getElementById('errors')
  const item = [...box.querySelectorAll('button')].find(b => /名稱/.test(b.textContent))
  assert.ok(item, '名稱那條原因是一顆按鈕')
  item.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  const nameEl = doc.getElementById('name')
  assert.equal(doc.activeElement, nameEl)
  assert.equal(nameEl.getAttribute('aria-invalid'), 'true')
})

test('補好之後再按儲存：原因區清空隱藏、任務存進去', async () => {
  const { st, pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://a.test/p' })
  doc.getElementById('name').value = ''
  await pk.handleSave()
  assert.equal(doc.getElementById('errors').hidden, false)
  doc.getElementById('name').value = '補好了'
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].name, '補好了')
  assert.equal(doc.getElementById('name').getAttribute('aria-invalid'), null)
})

test('什麼都不改就能存：預設名稱推不出來時給保底名稱（含主機名）', async () => {
  const { st, pk, doc } = await fresh()
  pk.render({ locator: LOCATOR, url: 'https://rate.test/x' })
  const name = doc.getElementById('name').value
  assert.ok(name.trim() !== '', '名稱欄不得是空的')
  assert.match(name, /rate\.test/)
  await pk.handleSave()
  const tasks = await st.getTasks()
  assert.equal(tasks.length, 1, '新使用者什麼都不改直接按儲存要能存')
  assert.equal(tasks[0].name, name)
})
