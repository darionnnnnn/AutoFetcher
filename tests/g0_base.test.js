process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const url = p => new URL('../src/' + p, import.meta.url)
const html = readFileSync(url('ui/report/report.html'), 'utf8')

async function fresh(settings) {
  resetChromeMock()
  const c = installChromeMock()
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  if (settings) await st.saveSettings(settings)
  const jd = new JSDOM(html, { url: 'https://x.test/report.html' })
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  const rp = await import('../src/ui/report/report.js?t=' + Math.random())
  const lg = await import('../src/ui/report/logic.js?t=' + Math.random())
  return { c, st, rp, lg, doc: jd.window.document, win: jd.window }
}

// ---- theme.css 抽出 ----

test('theme.css 存在且定義 8 色圖表調色盤（亮暗各一組）', () => {
  assert.ok(existsSync(url('ui/theme.css')), 'src/ui/theme.css 必須存在')
  const css = readFileSync(url('ui/theme.css'), 'utf8')
  for (let i = 1; i <= 8; i++) {
    const n = (css.match(new RegExp(`--chart-${i}\\s*:`, 'g')) || []).length
    assert.ok(n >= 2, `--chart-${i} 要在亮色與暗色各定義一次，實得 ${n}`)
  }
  assert.ok(/--ok\s*:/.test(css) && /--warn\s*:/.test(css), 'theme.css 要有 --ok 與 --warn')
})

test('theme.css 同時支援 prefers-color-scheme 與 data-theme 兩軌', () => {
  const css = readFileSync(url('ui/theme.css'), 'utf8')
  assert.ok(css.includes('prefers-color-scheme: dark'), '要有系統深色查詢')
  assert.ok(/\[data-theme=["']?dark["']?\]/.test(css), '要有 data-theme="dark" 選擇器')
  assert.ok(/\[data-theme=["']?light["']?\]/.test(css), '要有 data-theme="light" 選擇器（強制亮色需覆蓋系統深色）')
})

test('三個頁面都改用 theme.css，不再自己宣告色彩變數', () => {
  for (const p of ['ui/report/report.html', 'ui/popup/popup.html', 'ui/picker/picker.html']) {
    const src = readFileSync(url(p), 'utf8')
    assert.ok(src.includes('theme.css'), `${p} 要連結 theme.css`)
    const decls = src.match(/^\s*--[a-z][a-z0-9-]*\s*:/gm) || []
    assert.equal(decls.length, 0, `${p} 內不該再宣告色彩變數，實得 ${decls.length} 個`)
  }
})

test('報表載入時依 settings.theme 設定 data-theme', async () => {
  for (const [theme, want] of [['dark', 'dark'], ['light', 'light'], ['system', null]]) {
    const { rp, doc } = await fresh({ theme })
    assert.equal(typeof rp.applyTheme, 'function', 'report.js 要匯出 applyTheme')
    rp.applyTheme(theme)
    assert.equal(doc.documentElement.getAttribute('data-theme'), want, `theme=${theme}`)
  }
})

// ---- 日期範圍列 ----

test('shiftRange 逐日往前往後', async () => {
  const { lg } = await fresh()
  assert.deepEqual(lg.shiftRange('2026-09-06', '2026-09-06', -1), { from: '2026-09-05', to: '2026-09-05' })
  assert.deepEqual(lg.shiftRange('2026-09-06', '2026-09-06', 1), { from: '2026-09-07', to: '2026-09-07' })
})

test('shiftRange 保持範圍長度', async () => {
  const { lg } = await fresh()
  assert.deepEqual(lg.shiftRange('2026-09-01', '2026-09-07', -7), { from: '2026-08-25', to: '2026-08-31' })
  assert.deepEqual(lg.shiftRange('2026-09-01', '2026-09-07', 7), { from: '2026-09-08', to: '2026-09-14' })
})

test('shiftRange 跨月與跨年正確', async () => {
  const { lg } = await fresh()
  assert.deepEqual(lg.shiftRange('2026-03-01', '2026-03-01', -1), { from: '2026-02-28', to: '2026-02-28' })
  assert.deepEqual(lg.shiftRange('2026-01-01', '2026-01-01', -1), { from: '2025-12-31', to: '2025-12-31' })
  assert.deepEqual(lg.shiftRange('2024-02-28', '2024-02-28', 1), { from: '2024-02-29', to: '2024-02-29' }, '閏年')
})

test('shiftRange 位移 0 時原樣回傳，壞輸入回 null', async () => {
  const { lg } = await fresh()
  assert.deepEqual(lg.shiftRange('2026-09-06', '2026-09-07', 0), { from: '2026-09-06', to: '2026-09-07' })
  assert.equal(lg.shiftRange('', '2026-09-07', 1), null)
  assert.equal(lg.shiftRange('bad', 'bad', 1), null)
})

test('normalizeRange 在 from 晚於 to 時交換', async () => {
  const { lg } = await fresh()
  assert.deepEqual(lg.normalizeRange('2026-09-09', '2026-09-01'), { from: '2026-09-01', to: '2026-09-09' })
  assert.deepEqual(lg.normalizeRange('2026-09-01', '2026-09-09'), { from: '2026-09-01', to: '2026-09-09' })
})

test('日期範圍列已搬到共用位置，且不在歷史面板內', () => {
  const jd = new JSDOM(html)
  const bar = jd.window.document.getElementById('range-bar')
  assert.ok(bar, 'range-bar 要存在')
  assert.equal(bar.closest('#panel-history'), null, 'range-bar 不可再包在 #panel-history 內')
  assert.ok(jd.window.document.getElementById('range-prev-day'), '要有逐日往前按鈕')
  assert.ok(jd.window.document.getElementById('range-next-day'), '要有逐日往後按鈕')
  assert.ok(jd.window.document.getElementById('range-prev-week'), '要有逐週往前按鈕')
  assert.ok(jd.window.document.getElementById('range-next-week'), '要有逐週往後按鈕')
  assert.ok(jd.window.document.getElementById('range-from'), '要有自訂起日輸入')
  assert.ok(jd.window.document.getElementById('range-to'), '要有自訂訖日輸入')
})

test('按逐日往前後，state 的範圍往前一天', async () => {
  const { rp, doc } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-06&to=2026-09-06')
  doc.getElementById('range-prev-day').click()
  assert.equal(rp.getState().from, '2026-09-05')
  assert.equal(rp.getState().to, '2026-09-05')
})

test('按逐週往後，範圍加七天且長度不變', async () => {
  const { rp, doc } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-01&to=2026-09-07')
  doc.getElementById('range-next-week').click()
  assert.equal(rp.getState().from, '2026-09-08')
  assert.equal(rp.getState().to, '2026-09-14')
})

test('自訂日期輸入會套用並在顛倒時自動交換', async () => {
  const { rp, doc, win } = await fresh()
  rp.initFromHash('#view=history&from=2026-09-06&to=2026-09-06')
  const f = doc.getElementById('range-from'), t = doc.getElementById('range-to')
  f.value = '2026-09-20'
  t.value = '2026-09-10'
  f.dispatchEvent(new win.Event('change', { bubbles: true }))
  assert.equal(rp.getState().from, '2026-09-10')
  assert.equal(rp.getState().to, '2026-09-20')
})

// ---- 紀錄併入任務名（Claude 已實作，守門用） ----

test('joinTaskNames 併入任務名，已刪任務退回 taskId', async () => {
  const { rp } = await fresh()
  const out = rp.joinTaskNames(
    [{ taskId: 't1', value: 1 }, { taskId: 'gone', value: 2 }],
    [{ id: 't1', name: '總量' }]
  )
  assert.equal(out[0].taskName, '總量')
  assert.equal(out[1].taskName, 'gone')
})

test('joinTaskNames 不覆蓋紀錄裡已有的任務名，也不改動輸入', async () => {
  const { rp } = await fresh()
  const input = [{ taskId: 't1', taskName: '舊名' }]
  const out = rp.joinTaskNames(input, [{ id: 't1', name: '新名' }])
  assert.equal(out[0].taskName, '舊名')
  assert.equal(input[0].taskName, '舊名')
  assert.notEqual(out[0], input[0], '要回新物件不可就地改')
})
