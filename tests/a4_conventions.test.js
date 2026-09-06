// AF-3:專案慣例的機械化守門(靜態掃原始碼)
// 每一條都對應一個實際發生過、且測試抓不到的缺陷,之後每輪都留著。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname

function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, filter, out)
    else if (filter(name)) out.push(p)
  }
  return out
}

const rel = (p) => p.slice(SRC.length)
const jsFiles = () => walk(SRC, (n) => n.endsWith('.js'))
const read = (p) => readFileSync(p, 'utf8')

test('D1 守門:不得以 files 注入 content script(ES module 會在真實瀏覽器爆掉)', () => {
  const offenders = []
  for (const p of jsFiles()) {
    const src = read(p)
    // executeScript 的引數物件裡出現 files: [... 'content/...'] 就是舊的注入方式
    const re = /executeScript\s*\(([\s\S]{0,400}?)\)/g
    let m
    while ((m = re.exec(src))) {
      if (/files\s*:/.test(m[1]) && /content\//.test(m[1])) offenders.push(rel(p))
    }
  }
  assert.deepEqual(offenders, [], `這些檔案仍以 files 注入 content script:${offenders.join(', ')}`)
})

test('D2 守門:notifications.create 只准出現在 background/notify.js', () => {
  const offenders = jsFiles()
    .filter((p) => rel(p) !== 'background/notify.js')
    .filter((p) => /notifications\s*\.\s*create\s*\(/.test(read(p)))
    .map(rel)
  assert.deepEqual(offenders, [], `通知必須走 notify():${offenders.join(', ')}`)
})

test('D2 守門:notify.js 用的圖示檔案真的存在', () => {
  const src = read(join(SRC, 'background/notify.js'))
  const m = src.match(/['"](icons\/[^'"]+\.png)['"]/)
  assert.ok(m, 'notify.js 必須指定 icons/ 底下的圖示')
  assert.ok(
    /getURL\s*\(\s*ICON_PATH\s*\)/.test(src),
    'iconUrl 必須經 chrome.runtime.getURL 轉成絕對網址（相對路徑在 service worker 會 404）'
  )
  assert.ok(statSync(join(SRC, m[1])).isFile(), `圖示不存在:${m[1]}`)
})

test('D3 守門:manifest 宣告的每個圖示檔案都存在', () => {
  const mf = JSON.parse(read(join(SRC, 'manifest.json')))
  const paths = [
    ...Object.values(mf.icons || {}),
    ...Object.values(mf.action?.default_icon || {})
  ]
  assert.ok(paths.length >= 4, 'manifest 必須宣告 icons')
  for (const p of paths) {
    assert.ok(statSync(join(SRC, p)).isFile(), `manifest 指到不存在的圖示:${p}`)
  }
})

test('D4 守門:不得改寫內建原型', () => {
  const offenders = jsFiles()
    .filter((p) => /(String|Array|Object|Number|RegExp|Function|Promise)\s*\.\s*prototype\s*\.\s*\w+\s*=/.test(read(p)))
    .map(rel)
  assert.deepEqual(offenders, [], `不得猴補內建原型:${offenders.join(', ')}`)
})
