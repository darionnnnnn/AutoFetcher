// AF-21 段 8-A：設計 token 的對比（WCAG 2.x 相對亮度）
// 從 theme.css 解析四條軌，斷言文字／主要按鈕／狀態文字對底色皆 ≥ 4.5:1。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const THEME = readFileSync(new URL('../src/ui/theme.css', import.meta.url), 'utf8')

// ---------- 純函式 ----------

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}

export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a, b) {
  const la = relativeLuminance(hexToRgb(a))
  const lb = relativeLuminance(hexToRgb(b))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

function varsOf(block) {
  const out = {}
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

// 四條軌：第一個 :root、prefers-color-scheme: dark 內的 :root、[data-theme="dark"]、[data-theme="light"]
function parseTracks(css) {
  const first = css.match(/^\s*:root\s*\{([^}]*)\}/)
  const media = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)
  const dark = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)
  const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)
  return {
    'light(:root)': varsOf(first ? first[1] : ''),
    'dark(media)': varsOf(media ? media[1] : ''),
    'dark([data-theme])': varsOf(dark ? dark[1] : ''),
    'light([data-theme])': varsOf(light ? light[1] : '')
  }
}

const PAIRS = [
  ['--on-primary', '--primary-strong'],
  ['--text', '--surface'],
  ['--text', '--bg'],
  ['--text-muted', '--surface'],
  ['--ok-text', '--surface'],
  ['--warn-text', '--surface'],
  ['--danger-text', '--surface'],
  // 確認對話框的危險確認：實心紅底白字
  ['--on-primary', '--danger-strong']
]

const NEW_TOKENS = ['--on-primary', '--primary-strong', '--ok-text', '--warn-text', '--danger-text',
  '--danger-strong', '--text-subtle', '--radius-sm']

// ---------- 測試 ----------

test('8-A 純函式：黑白對比 21、同色對比 1、已知值', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 10) / 10, 21)
  assert.equal(contrast('#123456', '#123456'), 1)
  // 規格背景：#3b82f6 配白 ≈ 3.7、#d97706 配白 ≈ 3.2
  assert.ok(Math.abs(contrast('#3b82f6', '#ffffff') - 3.68) < 0.05)
  assert.ok(contrast('#d97706', '#ffffff') < 4.5)
})

test('8-A theme.css 四條軌都解析得到變數，且新 token 四條軌都有', () => {
  const tracks = parseTracks(THEME)
  for (const [name, vars] of Object.entries(tracks)) {
    assert.ok(Object.keys(vars).length > 20, `${name} 解析到的變數集合不得是空的（實得 ${Object.keys(vars).length}）`)
    for (const t of NEW_TOKENS) assert.ok(t in vars, `${name} 缺 ${t}`)
  }
})

test('8-A 亮色 [data-theme="light"] 與第一個 :root 同值、兩條暗色軌同值（新 token）', () => {
  const tr = parseTracks(THEME)
  for (const t of NEW_TOKENS) {
    assert.equal(tr['light([data-theme])'][t], tr['light(:root)'][t], `亮色軌 ${t} 不一致`)
    assert.equal(tr['dark([data-theme])'][t], tr['dark(media)'][t], `暗色軌 ${t} 不一致`)
  }
})

test('8-A 對比：主要按鈕、正文、次要文字、狀態文字對底色皆 ≥ 4.5:1（四條軌）', () => {
  const tracks = parseTracks(THEME)
  let checked = 0
  const fails = []
  for (const [name, vars] of Object.entries(tracks)) {
    for (const [fg, bg] of PAIRS) {
      assert.ok(hexToRgb(vars[fg] || ''), `${name} ${fg} 要是色碼（實得 ${vars[fg]}）`)
      assert.ok(hexToRgb(vars[bg] || ''), `${name} ${bg} 要是色碼（實得 ${vars[bg]}）`)
      const r = contrast(vars[fg], vars[bg])
      checked++
      if (r < 4.5) fails.push(`${name}: ${fg} ${vars[fg]} 對 ${bg} ${vars[bg]} = ${r.toFixed(2)}`)
    }
  }
  assert.equal(checked, PAIRS.length * 4)
  assert.deepEqual(fails, [])
})
