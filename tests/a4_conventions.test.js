// AF-3:專案慣例的機械化守門(靜態掃原始碼)
// 每一條都對應一個實際發生過、且測試抓不到的缺陷,之後每輪都留著。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Windows 上 URL.pathname 會多一個前導斜線（/C:/…），一律用 fileURLToPath
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, filter, out)
    else if (filter(name)) out.push(p)
  }
  return out
}

// 豁免清單用 '/' 寫，Windows 的 join 會給反斜線，統一正規化
const rel = (p) => p.slice(SRC.length).split(sep).join('/')
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

test('D3b 守門:package.json 與 manifest 的版本號必須一致', () => {
  // AF-7 收尾才發現 manifest 停在 0.4.0(AF-5 升的)、package.json 還在開案的 0.1.0——
  // 兩處各自漂了好幾輪都沒人察覺,因為沒有任何地方比對過它們
  const mf = JSON.parse(read(join(SRC, 'manifest.json')))
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  assert.match(mf.version, /^\d+\.\d+\.\d+$/, `manifest 版本格式要是 x.y.z,實得 ${mf.version}`)
  assert.equal(pkg.version, mf.version,
    `package.json(${pkg.version})與 manifest(${mf.version})的版本號不一致`)
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

test('UI 不得直接讀寫 chrome.storage(一律經 shared/storage)', () => {
  const offenders = jsFiles()
    .filter((p) => rel(p).startsWith('ui/'))
    .filter((p) => /chrome\s*\.\s*storage\s*\./.test(read(p)))
    .map(rel)
  assert.deepEqual(offenders, [], `這些 UI 檔案直接碰了 chrome.storage:${offenders.join(', ')}`)
})

// 色碼字面值只有兩處豁免，兩處都是「拿不到 CSS 變數」的執行環境：
//   content/picker-mode.js —— 注入在網頁上，網頁沒有載入 ui/theme.css
//   background/health.js   —— chrome.action.setBadgeBackgroundColor 只吃色碼字串
const COLOR_EXEMPT = ['content/picker-mode.js', 'background/health.js']

test('D12 守門:色碼字面值只准出現在 theme.css 與兩處已記錄的豁免', () => {
  const offenders = []
  for (const p of [...jsFiles(), ...walk(SRC, (n) => n.endsWith('.html'))]) {
    if (COLOR_EXEMPT.includes(rel(p))) continue
    const hits = read(p).match(/#[0-9a-fA-F]{3,8}\b/g) || []
    if (hits.length > 0) offenders.push(`${rel(p)}(${hits.length})`)
  }
  assert.deepEqual(offenders, [], `顏色一律走 theme.css 變數:${offenders.join(', ')}`)
})

test('D13 守門:tabs.sendMessage 一律指名 frameId(否則會廣播給每個 frame)', () => {
  const offenders = []
  for (const p of jsFiles()) {
    const src = read(p)
    const target = 'chrome.tabs.sendMessage('
    let idx = 0
    while ((idx = src.indexOf(target, idx)) !== -1) {
      let i = idx + target.length
      let parenDepth = 0
      let braceDepth = 0
      let bracketDepth = 0
      let topCommas = 0
      let inString = null

      while (i < src.length) {
        const ch = src[i]
        const next = src[i + 1]

        if (inString) {
          if (ch === '\\') {
            i += 2
            continue
          }
          if (ch === inString) {
            inString = null
          }
          i++
          continue
        }

        if (ch === '/' && next === '/') {
          i += 2
          while (i < src.length && src[i] !== '\n') i++
          continue
        }

        if (ch === '/' && next === '*') {
          i += 2
          while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
          i += 2
          continue
        }

        if (ch === "'" || ch === '"' || ch === '`') {
          inString = ch
          i++
          continue
        }

        if (ch === '(') {
          parenDepth++
        } else if (ch === ')') {
          if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
            break
          }
          parenDepth--
        } else if (ch === '{') {
          braceDepth++
        } else if (ch === '}') {
          braceDepth--
        } else if (ch === '[') {
          bracketDepth++
        } else if (ch === ']') {
          bracketDepth--
        } else if (ch === ',') {
          if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
            topCommas++
          }
        }

        i++
      }

      if (topCommas < 2) {
        const line = src.slice(0, idx).split('\n').length
        offenders.push(`${rel(p)}:${line}`)
      }

      idx = i + 1
    }
  }
  assert.deepEqual(offenders, [], `tabs.sendMessage 必須帶第 3 個引數指定 frameId:${offenders.join(', ')}`)
})

// AF-12:正式碼不得留測試用的後門。
// `src/background/main.js` 的 `RUN_TASK` 曾把 `msg.__testOpts` 展開進 `runTask`——
// 等於任何送得出 runtime 訊息的來源都能改抓取時序、把這次改成 dryRun、或改成 scheduled 去偷排程槽。
// 它從開案活到第 12 輪,因為這條規則以前只寫在 CLAUDE.md 靠人工 grep。
// 測試要縮短等待就走函式參數(`handleAlarm(alarm, testOpts)`、`handleMessage(msg, sender, runOpts)`),
// 正式接線不傳,那條路就不存在。
test('D14 守門:正式碼不得含測試後門(__test、測試檔名、Error().stack)', () => {
  const files = jsFiles()
  assert.ok(files.length > 10, `掃不到 src 的 js 檔就等於這條規則沒生效,實得 ${files.length} 個`)
  // 測試檔名(不含副檔名)一律不該出現在 src/,否則就是「跑到某個測試就改行為」
  const TESTS = fileURLToPath(new URL('../tests/', import.meta.url))
  const testNames = readdirSync(TESTS).filter(n => n.endsWith('.test.js')).map(n => n.slice(0, -8))
  assert.ok(testNames.length > 10, `列不到測試檔就等於這半條規則沒生效,實得 ${testNames.length} 個`)
  const NL = String.fromCharCode(10)
  const offenders = []
  for (const p of files) {
    const src = read(p)
    const lines = src.split(String.fromCharCode(10))
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes('__test')) offenders.push(`${rel(p)}:${i + 1} 有 __test`)
      if (/Error\s*\(\s*\)\s*\.stack/.test(line)) offenders.push(`${rel(p)}:${i + 1} 讀呼叫堆疊`)
      for (const n of testNames) {
        if (line.includes(`${n}.test`)) offenders.push(`${rel(p)}:${i + 1} 提到測試檔 ${n}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    `正式碼裡有測試後門(測試要縮短等待請走函式參數,不要走訊息欄位):${NL}${offenders.join(NL)}`)
})
