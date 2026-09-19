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

// AF-21 批次 2 定案 6:沒有逾時的送訊息只要回應遺失就吊到 service worker 被回收。
// background 一律經 messaging.js 的 sendToFrame(帶逾時、會清計時器)。
test('D13b 守門:background 的 chrome.tabs.sendMessage( 只准出現在 messaging.js', () => {
  const files = jsFiles().filter(p => rel(p).startsWith('background/'))
  assert.ok(files.length > 0, '要先掃到 background 的檔案')
  const hits = files.filter(p => read(p).includes('chrome.tabs.sendMessage(')).map(rel).sort()
  assert.deepEqual(hits, ['background/messaging.js'], `這些檔案直接呼叫 chrome.tabs.sendMessage:${hits.join(', ')}`)
})

// AF-12:正式碼不得留測試用的後門。
// `src/background/main.js` 的 `RUN_TASK` 曾把 `msg.__testOpts` 展開進 `runTask`——
// 等於任何送得出 runtime 訊息的來源都能改抓取時序、把這次改成 dryRun、或改成 scheduled 去偷排程槽。
// 它從開案活到第 12 輪,因為這條規則以前只寫在 CLAUDE.md 靠人工 grep。
// 測試要縮短等待就走函式參數(`handleAlarm(alarm, testOpts)`、`handleMessage(msg, sender, runOpts)`),
// 正式接線不傳,那條路就不存在。
test('D14 守門:正式碼不得含測試後門(__test、__calls、測試檔名、Error().stack)', () => {
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
      // 測試替身的呼叫紀錄:正式碼往裡面塞假紀錄,等於讓測試斷言正式碼自己寫的東西(AF-20 在 fetcher 拔掉兩處)
      if (line.includes('__calls')) offenders.push(`${rel(p)}:${i + 1} 碰了測試替身的 __calls`)
      if (/Error\s*\(\s*\)\s*\.stack/.test(line)) offenders.push(`${rel(p)}:${i + 1} 讀呼叫堆疊`)
      for (const n of testNames) {
        if (line.includes(`${n}.test`)) offenders.push(`${rel(p)}:${i + 1} 提到測試檔 ${n}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    `正式碼裡有測試後門(測試要縮短等待請走函式參數,不要走訊息欄位):${NL}${offenders.join(NL)}`)
})

test('D16 守門:manifest 的 web_accessible_resources 恰好是 content 端的靜態 import 閉包', () => {
  // 注入是 background/inject.js 在頁面裡 import() content/main.js,被 import 的檔案都得在 WAR 裡;
  // 但 WAR 對 <all_urls> 開放,多列一個(例如 shared/crypto.js)任何網站都 fetch 得到(AF-21 批次 3 定案 4)
  const NL = String.fromCharCode(10)
  const posix = (p) => p.split(sep).join('/')
  const closure = new Set()
  const stack = ['content/main.js', 'content/picker-mode.js']
  const fromRe = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm
  const bareRe = /^\s*import\s*['"]([^'"]+)['"]/gm
  while (stack.length) {
    const f = stack.pop()
    if (closure.has(f)) continue
    closure.add(f)
    const src = read(join(SRC, f))
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
    for (const re of [fromRe, bareRe]) {
      for (const m of src.matchAll(re)) {
        const spec = m[1]
        assert.ok(spec.startsWith('.'), `${f} 匯入了非相對路徑 ${spec},網頁端解析不到`)
        const parts = dir ? dir.split('/') : []
        for (const seg of spec.split('/')) {
          if (seg === '..') parts.pop()
          else if (seg !== '.') parts.push(seg)
        }
        stack.push(posix(parts.join('/')))
      }
    }
  }
  assert.ok(closure.size > 2, `閉包只有入口,等於沒沿 import 走下去,實得 ${[...closure].join(', ')}`)
  // inject.js 用 getURL 取得的入口檔也必須在閉包內
  const inject = read(join(SRC, 'background', 'inject.js'))
  const entries = [...inject.matchAll(/getURL\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  assert.ok(entries.length > 0, 'inject.js 找不到 getURL 的入口檔')
  for (const e of entries) assert.ok(closure.has(e), `注入入口 ${e} 不在 content 閉包裡`)

  const manifest = JSON.parse(read(join(SRC, 'manifest.json')))
  const listed = (manifest.web_accessible_resources || []).flatMap(w => w.resources || [])
  assert.ok(listed.length > 0, 'manifest 沒有 web_accessible_resources')
  assert.deepEqual([...listed].sort(), [...closure].sort(),
    `WAR 清單要與 content 端 import 閉包完全相等(多列會外洩、漏列會注入失敗)${NL}清單:${listed.join(', ')}${NL}閉包:${[...closure].sort().join(', ')}`)
})
