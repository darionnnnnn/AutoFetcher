// AF-6 作業 B:抓取時重新找回目標所在的 frame
// frameId 每次載入都不同，任務只存得住網址，所以到點時必須重新定位；
// 取錯 frame 會靜默抓到別的值，比抓不到更糟——多重命中一律判失敗。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const FAST = { pollMs: 1, loadTimeoutMs: 200, extraDelayMs: 0, extractTimeoutMs: 200 }

async function fresh() {
  resetChromeMock()
  const c = installChromeMock()
  globalThis.navigator = { onLine: true }
  const st = await import('../src/shared/storage.js?t=' + Math.random())
  await st.init()
  const fr = await import('../src/background/frames.js?t=' + Math.random())
  return { c, st, fr }
}

// executeScript 回傳的真實形狀：每個 frame 一筆，帶 frameId 與 func 的回傳值
const framesAs = (list) => () => list.map(([frameId, url]) => ({ frameId, result: url }))

const sent = (c) => c.__calls.filter((x) => x.api === 'tabs.sendMessage').map((x) => x.args)

// ---------- 純函式：網址比對 ----------

test('matchFrameByUrl:網址完全相同優先', async () => {
  const { fr } = await fresh()
  const frames = [
    { frameId: 0, url: 'https://a.test/p' },
    { frameId: 7, url: 'https://b.example/w.html?token=abc' }
  ]
  assert.deepEqual(fr.matchFrameByUrl(frames, 'https://b.example/w.html?token=abc'), { frameId: 7, matchedBy: 'exact' })
})

test('matchFrameByUrl:query 變了仍以 origin + pathname 認得出來', async () => {
  const { fr } = await fresh()
  const frames = [
    { frameId: 0, url: 'https://a.test/p' },
    { frameId: 9, url: 'https://b.example/w.html?token=zzz&t=1700000000' }
  ]
  assert.deepEqual(fr.matchFrameByUrl(frames, 'https://b.example/w.html?token=abc'), { frameId: 9, matchedBy: 'path' })
})

test('matchFrameByUrl:兩個 frame 同 origin+pathname 時不得亂猜', async () => {
  const { fr } = await fresh()
  const frames = [
    { frameId: 7, url: 'https://b.example/w.html?id=1' },
    { frameId: 8, url: 'https://b.example/w.html?id=2' }
  ]
  const r = fr.matchFrameByUrl(frames, 'https://b.example/w.html?id=3')
  assert.equal(r.frameId, undefined, '有兩個候選就不能直接給答案')
  assert.deepEqual(r.ambiguous, [7, 8])
})

test('matchFrameByUrl:都對不上回 null；沒有 frame 也回 null', async () => {
  const { fr } = await fresh()
  assert.equal(fr.matchFrameByUrl([{ frameId: 0, url: 'https://a.test/p' }], 'https://b.example/w.html'), null)
  assert.equal(fr.matchFrameByUrl([], 'https://b.example/w.html'), null)
})

test('matchFrameByUrl:網址不合法不得整個炸掉', async () => {
  const { fr } = await fresh()
  assert.doesNotThrow(() => fr.matchFrameByUrl([{ frameId: 3, url: 'about:blank' }], 'about:srcdoc'))
})

// ---------- 定位 ----------

test('locateFrame:任務沒有 frame 就是最上層，連列 frame 都不必做', async () => {
  const { c, fr } = await fresh()
  const r = await fr.locateFrame(3, undefined, { css: '#v' }, FAST)
  assert.deepEqual(r, { frameId: 0, matchedBy: 'top', candidates: [] })
  assert.equal(c.__calls.some((x) => x.api === 'scripting.executeScript'), false, '舊任務不該多付列 frame 的成本')
})

test('locateFrame:iframe 晚一點才出現也要等得到', async () => {
  const { c, fr } = await fresh()
  let round = 0
  c.__setScriptResponder(() => {
    round++
    return round === 1
      ? [{ frameId: 0, result: 'https://a.test/p' }]
      : [{ frameId: 0, result: 'https://a.test/p' }, { frameId: 7, result: 'https://b.example/w.html' }]
  })
  const r = await fr.locateFrame(3, { url: 'https://b.example/w.html' }, { css: '#v' }, { pollMs: 1, timeoutMs: 500 })
  assert.equal(r.frameId, 7)
  assert.equal(r.matchedBy, 'exact')
  assert.ok(round >= 2, '第一次沒看到就放棄的話，先點按鈕才出現的 iframe 永遠抓不到')
})

test('locateFrame:等到逾時仍然沒有就判失敗', async () => {
  const { c, fr } = await fresh()
  c.__setScriptResponder(framesAs([[0, 'https://a.test/p']]))
  const r = await fr.locateFrame(3, { url: 'https://b.example/w.html' }, { css: '#v' }, { pollMs: 1, timeoutMs: 30 })
  // 失敗回的是帶候選清單的物件（診斷用），判定看有沒有 frameId
  assert.equal(r.frameId, null)
  assert.equal(r.matchedBy, null)
  assert.equal(r.failed, true)
})

test('locateFrame:兩個候選時用 locator 問出唯一那個', async () => {
  const { c, fr } = await fresh()
  c.__setScriptResponder(framesAs([
    [0, 'https://a.test/p'], [7, 'https://b.example/w.html?id=1'], [8, 'https://b.example/w.html?id=2']
  ]))
  c.__setTabResponder((tabId, msg, options) => {
    if (msg.type !== 'RESOLVE_LOCATOR') return undefined
    return { ok: true, found: options.frameId === 8 }
  })
  const r = await fr.locateFrame(3, { url: 'https://b.example/w.html?id=9' }, { css: '#v' }, { pollMs: 1, timeoutMs: 50 })
  assert.equal(r.frameId, 8)
  assert.equal(r.matchedBy, 'locator')
  const asked = sent(c).filter((a) => a[1].type === 'RESOLVE_LOCATOR').map((a) => a[2].frameId)
  assert.deepEqual(asked.sort(), [7, 8], '兩個候選都要問過才知道是不是唯一')
})

test('locateFrame:兩個候選都找得到目標時寧可失敗，不得取第一個', async () => {
  const { c, fr } = await fresh()
  c.__setScriptResponder(framesAs([
    [0, 'https://a.test/p'], [7, 'https://b.example/w.html?id=1'], [8, 'https://b.example/w.html?id=2']
  ]))
  c.__setTabResponder((tabId, msg) => (msg.type === 'RESOLVE_LOCATOR' ? { ok: true, found: true } : undefined))
  const r = await fr.locateFrame(3, { url: 'https://b.example/w.html?id=9' }, { css: '#v' }, { pollMs: 1, timeoutMs: 50 })
  assert.equal(r.frameId, null, '抓到隔壁那張表的數字，比抓不到更糟')
  assert.equal(r.failed, true)
})

test('locateFrame:網址全都對不上時，改用 locator 問每個非最上層 frame', async () => {
  const { c, fr } = await fresh()
  c.__setScriptResponder(framesAs([
    [0, 'https://a.test/p'], [4, 'https://c.other/x'], [5, 'https://d.other/y']
  ]))
  c.__setTabResponder((tabId, msg, options) => {
    if (msg.type !== 'RESOLVE_LOCATOR') return undefined
    return { ok: true, found: options.frameId === 5 }
  })
  const r = await fr.locateFrame(3, { url: 'https://b.example/w.html' }, { css: '#v' }, { pollMs: 1, timeoutMs: 30 })
  assert.equal(r.frameId, 5)
  assert.equal(r.matchedBy, 'locator')
  const asked = sent(c).filter((a) => a[1].type === 'RESOLVE_LOCATOR').map((a) => a[2].frameId)
  assert.equal(asked.includes(0), false, '最上層本來就找不到，不必問')
})

test('locateFrame:候選 frame 要先注入 content script 才問得動', async () => {
  const { c, fr } = await fresh()
  c.__setScriptResponder((injection) => {
    // 注入 content script 的那次（帶 args）回空陣列，列 frame 的那次回 frame 清單
    if (Array.isArray(injection?.args)) return []
    return [{ frameId: 0, result: 'https://a.test/p' }, { frameId: 7, result: 'https://b.example/w.html?id=1' },
      { frameId: 8, result: 'https://b.example/w.html?id=2' }]
  })
  c.__setTabResponder((tabId, msg, options) => (msg.type === 'RESOLVE_LOCATOR' ? { ok: true, found: options.frameId === 7 } : undefined))
  await fr.locateFrame(3, { url: 'https://b.example/w.html?id=9' }, { css: '#v' }, { pollMs: 1, timeoutMs: 50 })
  const injectedFrames = c.__calls
    .filter((x) => x.api === 'scripting.executeScript' && Array.isArray(x.args[0]?.args))
    .flatMap((x) => x.args[0].target.frameIds || [])
  assert.ok(injectedFrames.includes(7) && injectedFrames.includes(8), '沒注入就送訊息會直接拋錯')
})
