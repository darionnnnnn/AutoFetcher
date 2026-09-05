process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const task = (id, name) => ({
  id, name, url: `https://x.test/${id}`, mode: 'number', enabled: true,
  spec: { strategy: 'text' }, schedule: { type: 'daily', times: ['09:00'] }
})

const rec = (taskId, slot, value, status = 'ok') => ({
  taskId, slot, capturedAt: slot + ':00+08:00', value, raw: String(value), status
})

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  await st.saveTask(task('t1', '電費'))
  await st.appendRecord('2026-09-01', rec('t1', '2026-09-01T09:00', 10))
  await st.appendRecord('2026-09-02', rec('t1', '2026-09-02T09:00', 20))
  const ls = await import('../src/shared/layout-store.js?t=' + Math.random())
  const jd = new JSDOM('<!doctype html><body></body>')
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const ex = await import('../src/shared/export.js?t=' + Math.random())
  return { c, st, ls, ex }
}

async function seedCards(ls) {
  const did = (await ls.getLayout()).dashboards[0].id
  await ls.addCard(did, {
    type: 'number', x: 0, y: 0, w: 3, h: 2, title: '目前電費',
    source: [{ taskId: 't1', aggregation: 'raw' }], options: {}
  })
  await ls.addCard(did, {
    type: 'line', x: 0, y: 0, w: 6, h: 3,
    source: [{ taskId: 't1', aggregation: 'dailyLast' }], options: {}
  })
  return did
}

const build = (ex, opts) => ex.buildHtmlReport(opts)

test('產出是完整 HTML 文件', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  assert.ok(/^<!doctype html>/i.test(content.trim()))
  assert.ok(content.includes('</html>'))
})

test('檔名含日期範圍且是 .html', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { filename } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  assert.ok(filename.endsWith('.html'))
  assert.ok(filename.includes('2026-09-01') && filename.includes('2026-09-02'))
})

test('產出可被 jsdom 載入且有內容', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  const dom = new JSDOM(content)
  assert.ok(dom.window.document.body.textContent.trim().length > 20)
})

test('內含儀表板卡片標題與圖表', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  const dom = new JSDOM(content)
  const doc = dom.window.document
  assert.ok(doc.body.textContent.includes('目前電費'))
  assert.ok(doc.querySelector('svg'), '折線卡片要輸出 svg')
})

test('內含紀錄表格與實際數值', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  const dom = new JSDOM(content)
  const rows = dom.window.document.querySelectorAll('table tbody tr')
  assert.ok(rows.length >= 2, `要有兩筆紀錄，實得 ${rows.length}`)
  assert.ok(dom.window.document.body.textContent.includes('20'))
})

test('表格顯示任務名而不是任務 id', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  assert.ok(content.includes('電費'))
})

test('不含任何 script 標籤', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  assert.equal((content.match(/<script/gi) || []).length, 0)
})

test('不含 chrome API 呼叫與外部資源連結', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  assert.equal((content.match(/chrome\./g) || []).length, 0)
  assert.equal((content.match(/https?:\/\/(?!www\.w3\.org)/g) || []).length, 0,
    '不可有外部連結（w3.org 的 SVG 命名空間除外）')
  assert.equal((content.match(/<link\b/gi) || []).length, 0, '不可外連樣式表')
})

test('樣式內嵌，卡片顏色用實際色值而非未定義的變數', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  assert.ok(content.includes('<style'), '要內嵌樣式')
  const dom = new JSDOM(content)
  const styleText = [...dom.window.document.querySelectorAll('style')].map(s => s.textContent).join('\n')
  for (let i = 1; i <= 8; i++) {
    assert.ok(styleText.includes(`--chart-${i}`), `內嵌樣式要定義 --chart-${i}`)
  }
})

test('含列印樣式且卡片不跨頁截斷', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  assert.ok(content.includes('@media print'))
  assert.ok(/break-inside\s*:\s*avoid/.test(content), '卡片要避免跨頁截斷')
})

test('標題含日期範圍', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  const dom = new JSDOM(content)
  assert.ok(dom.window.document.title.includes('2026-09-01'))
})

test('儀表板沒有卡片時仍輸出紀錄表格', async () => {
  const { ex, ls } = await fresh()
  const did = (await ls.getLayout()).dashboards[0].id
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  const dom = new JSDOM(content)
  assert.ok(dom.window.document.querySelectorAll('table tbody tr').length >= 2)
})

test('範圍內沒有紀錄時不丟錯，顯示沒有資料', async () => {
  const { ex, ls } = await fresh()
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2020-01-01', to: '2020-01-02', dashId: did })
  assert.ok(content.includes('沒有') || content.includes('無'), '要有空狀態文字')
})

test('任務名中的 HTML 被跳脫，不會產生標籤', async () => {
  const { ex, st, ls } = await fresh()
  await st.saveTask({ ...task('t9', '<img src=x onerror=alert(1)>'), id: 't9' })
  await st.appendRecord('2026-09-01', rec('t9', '2026-09-01T10:00', 5))
  const did = await seedCards(ls)
  const { content } = await build(ex, { from: '2026-09-01', to: '2026-09-02', dashId: did })
  const dom = new JSDOM(content)
  assert.equal(dom.window.document.querySelectorAll('img').length, 0)
  assert.ok(dom.window.document.body.textContent.includes('<img'))
})

test('buildExport 支援 html 格式並走同一條產生器', async () => {
  const { ex, ls } = await fresh()
  await seedCards(ls)
  const out = await ex.buildExport({ from: '2026-09-01', to: '2026-09-02', format: 'html' })
  assert.ok(out.filename.endsWith('.html'))
  assert.ok(out.content.includes('<!doctype html>') || out.content.includes('<!DOCTYPE html>'))
})

test('不支援的格式仍然丟錯', async () => {
  const { ex } = await fresh()
  await assert.rejects(() => ex.buildExport({ from: '2026-09-01', to: '2026-09-02', format: 'xml' }))
})
