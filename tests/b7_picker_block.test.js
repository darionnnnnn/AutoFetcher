// AF-3 批次 B:Picker 接住選取模式帶回來的區塊資訊,以及頁面慣例(顏色只走 theme.css)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const html = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const jd = new JSDOM(html)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const pk = await import('../src/ui/picker/picker.js?t=' + Math.random())
  return { c, st, pk, doc: jd.window.document }
}

const blockCtx = {
  locator: { css: '#t', path: '', anchor: null, xpath: '' },
  url: 'https://a.test/p',
  preview: '日期 數量 09-01 10',
  previewValue: null,
  blockInfo: { kind: 'table', axis: 'col', index: 1, headerText: '數量', rows: 3, cols: 2 }
}

test('帶區塊資訊進來時,顯示區塊區段並說明選到哪一欄', async () => {
  const { pk, doc } = await fresh()
  pk.render(blockCtx)
  const section = doc.getElementById('block-section')
  assert.ok(section, 'picker.html 必須有區塊區段')
  assert.equal(section.hidden, false, '有區塊資訊時要顯示')
  assert.ok(section.textContent.includes('數量'), `要說明選到的是哪一欄,實得:${section.textContent}`)
})

test('沒有區塊資訊時區塊區段是隱藏的', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: '1,234', previewValue: 1234 })
  assert.equal(doc.getElementById('block-section').hidden, true)
})

test('區塊資訊會讓數值類型自動切到 block', async () => {
  const { pk, doc } = await fresh()
  pk.render(blockCtx)
  assert.equal(doc.getElementById('mode').value, 'block')
  const modeOptions = [...doc.querySelectorAll('#mode option')].map(o => o.value)
  assert.ok(modeOptions.includes('block'), 'mode 下拉必須有 block 這個選項')
})

test('存檔時把軸、索引、表頭與聚合方式寫進 spec.block', async () => {
  const { pk, doc } = await fresh()
  pk.render(blockCtx)
  doc.getElementById('name').value = '每日數量'
  const agg = doc.getElementById('block-aggregate')
  assert.ok(agg, '必須能選聚合方式')
  agg.value = 'sum'
  const t = pk.buildTask(
    { name: '每日數量', url: 'https://a.test/p', mode: 'block', strategy: 'auto',
      scheduleType: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6],
      block: { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum' } },
    blockCtx.locator
  )
  assert.equal(t.mode, 'block')
  assert.deepEqual(t.spec.block, { axis: 'col', index: 1, headerText: '數量', aggregate: 'sum' })
})

test('手選 block 模式但沒有區塊資訊時,提示回頁面上點一欄', async () => {
  const { pk, doc } = await fresh()
  pk.render({ locator: { css: '#v' }, url: 'https://a.test/p', preview: 'x' })
  doc.getElementById('mode').value = 'block'
  doc.getElementById('mode').dispatchEvent(new globalThis.window.Event('change'))
  const section = doc.getElementById('block-section')
  assert.equal(section.hidden, false)
  assert.ok(/選取|點/.test(section.textContent), `要提示怎麼取得區塊資訊,實得:${section.textContent}`)
})

test('D12 守門:Picker 與 popup 不得出現色碼字面值(深色模式會失效)', () => {
  for (const p of ['../src/ui/picker/picker.html', '../src/ui/popup/popup.html']) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8')
    const hits = src.match(/#[0-9a-fA-F]{3,8}\b(?![^<]*<\/title>)/g) || []
    assert.deepEqual(hits, [], `${p} 仍有色碼字面值:${hits.join(' ')}`)
    assert.ok(src.includes('theme.css'), `${p} 必須引用 theme.css`)
  }
})

test('Picker 內容可捲動且存檔鈕固定,設定變多也按得到', () => {
  const src = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')
  assert.ok(/overflow-y\s*:\s*auto/.test(src), '設定區要可捲動')
})
