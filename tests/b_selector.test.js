import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { describe as describeEl, resolve, isUnstableToken } from '../src/shared/selector.js'

const dom = html => new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document

// ---------- 不穩定 token 判定 ----------
test('isUnstableToken 依固定規則判定', () => {
  for (const t of ['css-1x2y3z', 'sc-bdVaJa', 'item-12345', 'a1b2C3d4', 'emotion-abc'])
    assert.equal(isUnstableToken(t), true, `${t} 應判為不穩定`)
  for (const t of ['daily-total', 'value', 'col-2', 'main-content', 'v1'])
    assert.equal(isUnstableToken(t), false, `${t} 應判為穩定`)
})

// ---------- 第 1 層 css ----------
test('describe:有穩定 id 時 css 用 id', () => {
  const d = dom('<div id="daily-total">12</div>')
  const loc = describeEl(d.getElementById('daily-total'))
  assert.equal(loc.css, '#daily-total')
})

test('describe:id 不穩定時改用 data-* 屬性', () => {
  const d = dom('<div id="css-1x2y3z" data-testid="total">12</div>')
  const loc = describeEl(d.querySelector('[data-testid]'))
  assert.equal(loc.css, '[data-testid="total"]')
})

test('describe:沒有穩定屬性時 css 為空字串', () => {
  const d = dom('<div class="sc-bdVaJa"><span>12</span></div>')
  const loc = describeEl(d.querySelector('span'))
  assert.equal(loc.css, '')
})

// ---------- 第 2 層 path ----------
test('describe:path 是 nth-of-type 結構路徑,可唯一命中', () => {
  const d = dom('<div><p>a</p><p>b</p><p>c</p></div>')
  const target = d.querySelectorAll('p')[1]
  const loc = describeEl(target)
  assert.match(loc.path, /p:nth-of-type\(2\)/)
  assert.equal(d.querySelectorAll(loc.path).length, 1)
  assert.equal(d.querySelector(loc.path).textContent, 'b')
})

// ---------- 第 3 層 anchor ----------
test('describe:anchor 取前一個有文字的兄弟節點', () => {
  const d = dom('<table><tr><td>今日總量</td><td>1,234</td></tr></table>')
  const target = d.querySelectorAll('td')[1]
  const loc = describeEl(target)
  assert.equal(loc.anchor.text, '今日總量')
  assert.equal(loc.anchor.hops, 1)
})

test('describe:沒有可用錨點時 anchor 為 null', () => {
  const d = dom('<div><span>12</span></div>')
  assert.equal(describeEl(d.querySelector('span')).anchor, null)
})

// ---------- 第 4 層 xpath ----------
test('describe:xpath 是含索引的絕對路徑', () => {
  const d = dom('<div><p>a</p><p>b</p></div>')
  const loc = describeEl(d.querySelectorAll('p')[1])
  assert.equal(loc.xpath, '/html[1]/body[1]/div[1]/p[2]')
})

// ---------- resolve 逐層 ----------
test('resolve:第 1 層命中時 layer 為 css', () => {
  const d = dom('<div id="daily-total">12</div>')
  const r = resolve(d, describeEl(d.getElementById('daily-total')))
  assert.equal(r.layer, 'css')
  assert.equal(r.el.textContent, '12')
})

test('resolve:css 失效時退到 path', () => {
  const d = dom('<div id="daily-total"><p>a</p><p>12</p></div>')
  const loc = describeEl(d.querySelectorAll('p')[1])
  const broken = { ...loc, css: '#gone' }
  const r = resolve(d, broken)
  assert.equal(r.layer, 'path')
  assert.equal(r.el.textContent, '12')
})

test('resolve:path 也失效時退到 anchor', () => {
  const d = dom('<table><tr><td>今日總量</td><td>1,234</td></tr></table>')
  const loc = describeEl(d.querySelectorAll('td')[1])
  const broken = { ...loc, css: '', path: 'nav > b:nth-of-type(9)' }
  const r = resolve(d, broken)
  assert.equal(r.layer, 'anchor')
  assert.equal(r.el.textContent, '1,234')
})

test('resolve:前三層失效時退到 xpath', () => {
  const d = dom('<div><p>a</p><p>12</p></div>')
  const loc = describeEl(d.querySelectorAll('p')[1])
  const broken = { ...loc, css: '', path: 'nav b', anchor: null }
  const r = resolve(d, broken)
  assert.equal(r.layer, 'xpath')
  assert.equal(r.el.textContent, '12')
})

test('resolve:某層命中多個視為該層失敗,退到下一層', () => {
  const d = dom('<div><p class="v">a</p><p class="v">12</p></div>')
  const loc = describeEl(d.querySelectorAll('p')[1])
  const ambiguous = { ...loc, css: '.v' }
  const r = resolve(d, ambiguous)
  assert.notEqual(r.layer, 'css', '命中兩個不算命中')
  assert.equal(r.el.textContent, '12')
})

test('resolve:全部失效回 not_found 與 500 字內的 snippet', () => {
  const d = dom('<div>' + 'x'.repeat(3000) + '</div>')
  const r = resolve(d, { css: '#a', path: 'nav b', anchor: null, xpath: '/html[1]/body[1]/table[9]' })
  assert.equal(r.error, 'not_found')
  assert.equal(r.el, undefined)
  assert.ok(r.snippet.length <= 500, 'snippet 需截到 500 字以內')
  assert.ok(r.snippet.length > 0)
})

test('describe → resolve 往返:五種 fixture 都能第 1 或第 2 層命中', () => {
  const fixtures = [
    '<div id="total">99</div>',
    '<div class="sc-bdVaJa"><span class="css-1x2y3z">99</span></div>',
    '<table><thead><tr><th>項目</th><th>值</th></tr></thead><tbody><tr><td>A</td><td>99</td></tr></tbody></table>',
    '<ul><li>A 1</li><li>B 99</li></ul>',
    '<main><section><article><div><b>99</b></div></article></section></main>'
  ]
  const targets = ['#total', 'span', 'tbody td:nth-of-type(2)', 'li:nth-of-type(2)', 'b']
  for (let i = 0; i < fixtures.length; i++) {
    const d = dom(fixtures[i])
    const el = d.querySelector(targets[i])
    const r = resolve(d, describeEl(el))
    assert.ok(['css', 'path'].includes(r.layer), `fixture ${i} 應在前兩層命中,實際 ${r.layer ?? r.error}`)
    assert.equal(r.el.textContent, el.textContent)
  }
})

test('describe 不修改 DOM', () => {
  const d = dom('<div id="a">1</div>')
  const before = d.body.innerHTML
  describeEl(d.getElementById('a'))
  assert.equal(d.body.innerHTML, before)
})
