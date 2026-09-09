// AF-11：iframe 代理層不得擋住疊在它上面的頁面元素
//
// 代理層原本貼在 z-index 拉到最高的 overlay 底下、蓋滿整個 iframe，
// 站台那種「滑鼠移過去才展開、疊在內容 iframe 上」的下拉選單因此指不到：
// 滑鼠一移進選單，命中的是代理層，選單收到 mouseout 就收合，藍框還跳去框整個 iframe。
//
// 真實瀏覽器實測（B-0 探針）：指標從頁面內容移進跨網域 iframe 時，
// 父文件收不到任何事件（mouseover / mouseout / pointerout 都沒有），
// 所以「踏上 iframe 才打開代理層」這種事件式做法根本做不到——
// 唯一能讓頁面元素勝出的方式是堆疊順序，讓路只是沒有 z-index 時的最後防線。
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function setup(body) {
  resetChromeMock()
  const c = installChromeMock()
  const jd = new JSDOM(`<!doctype html><html><body>${body}</body></html>`)
  globalThis.window = jd.window
  globalThis.document = jd.window.document
  globalThis.Event = jd.window.Event
  globalThis.MouseEvent = jd.window.MouseEvent
  globalThis.KeyboardEvent = jd.window.KeyboardEvent
  const pm = await import('../src/content/picker-mode.js?t=' + Math.random())
  return { c, doc: jd.window.document, win: jd.window, pm }
}

// 選單疊在 iframe 上：這就是使用者回報的版面
const OVERLAP = `
  <div id="bar">投資先生</div>
  <div id="menu" style="position:absolute;z-index:10"><a id="item" href="#">Intelligent</a></div>
  <iframe id="fr" src="https://b.example/inner.html"></iframe>`

const proxyOf = (doc, frameId) => {
  const frame = doc.getElementById(frameId)
  return [...doc.querySelectorAll('[data-af-frame-proxy]')].find(p => p.__afFrame === frame) || null
}

const runtimeMsgs = (c) => c.__calls.filter((x) => x.api === 'runtime.sendMessage').map((x) => x.args[0])

// 真實瀏覽器的命中測試：代理層開著的時候它就是命中結果（它蓋在 iframe 上），
// 關掉才輪到底下的元素。替身照這個規則走，程式碼沒有「先關再問」就會答錯。
function installHitTest(doc, proxy, under) {
  doc.elementFromPoint = () => (proxy.style.pointerEvents === 'none' ? under : proxy)
}

test('代理層貼在 body 底下，不得放進 z-index 最高的 overlay 裡', async () => {
  const { doc, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  assert.ok(proxy, 'iframe 上沒有代理層的話，使用者永遠選不到它')
  const overlay = doc.querySelector('[data-af-overlay]')
  assert.equal(overlay.contains(proxy), false,
    'overlay 的 z-index 是 2147483647、自成堆疊脈絡，放進去就一定蓋過頁面的下拉選單')
  assert.equal(proxy.parentElement, doc.body)
  pm.exitPickMode()
})

// 代理層貼在 body 底下，跟它比高低的是 iframe 在 body 層級的堆疊祖先。
// 替身依元素 id 回 z-index，才驗得出「取哪一個」。
function stubZ(win, table) {
  win.getComputedStyle = (el) => ({ zIndex: table[el?.id] ?? 'auto' })
}

const WRAPPED = `
  <div id="bar">投資先生</div>
  <div id="menu" style="position:absolute;z-index:10"><a id="item" href="#">Intelligent</a></div>
  <div id="outer"><div id="inner"><iframe id="fr" src="https://b.example/inner.html"></iframe></div></div>`

test('iframe 包在有 z-index 的容器裡：代理層要拿容器那個值，否則被容器蓋住、iframe 選不到', async () => {
  const { doc, win, pm } = await setup(WRAPPED)
  stubZ(win, { outer: '2' })
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  assert.equal(proxy.style.zIndex, '2',
    `只看 iframe 自己會拿到 0，整個容器就蓋在代理層上面；實得 ${proxy.style.zIndex}`)
  assert.ok(Number(proxy.style.zIndex) < 10, '仍必須輸給 z-index 10 的下拉選單')
  pm.exitPickMode()
})

test('巢狀容器都有 z-index 時取最外層那個（那才是在 body 層級比高低的值）', async () => {
  const { doc, win, pm } = await setup(WRAPPED)
  stubZ(win, { outer: '1', inner: '999', fr: '5' })
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  assert.equal(proxyOf(doc, 'fr').style.zIndex, '1',
    '拿內層的 999 會讓代理層蓋過頁面所有 z-index < 999 的選單')
  pm.exitPickMode()
})

test('整條鏈都沒有 z-index 時代理層用 0（仍蓋得住 iframe，但輸給任何疊上來的東西）', async () => {
  const { doc, win, pm } = await setup(WRAPPED)
  stubZ(win, {})
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  assert.equal(proxyOf(doc, 'fr').style.zIndex, '0')
  pm.exitPickMode()
})

test('負的 z-index 不照抄（代理層跑到頁面底下就永遠指不到）', async () => {
  const { doc, win, pm } = await setup(WRAPPED)
  stubZ(win, { outer: '-1' })
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  assert.equal(proxyOf(doc, 'fr').style.zIndex, '0')
  pm.exitPickMode()
})

test('沒有 z-index 的選單疊上來時要讓路，目標換成選單', async () => {
  const { doc, win, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  const item = doc.getElementById('item')
  installHitTest(doc, proxy, item)
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 30 }))
  assert.equal(proxy.style.pointerEvents, 'none', '讓路之後要退出來，指標才真的落在選單上')
  const panel = doc.querySelector('[data-af-panel]')
  assert.doesNotMatch(panel?.textContent || '', /框架/,
    '底下明明是選單項目卻還說是框架，使用者按下去就被帶進 iframe')
  pm.exitPickMode()
})

test('底下真的就是那個 iframe 時不讓路', async () => {
  const { doc, win, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  installHitTest(doc, proxy, doc.getElementById('fr'))
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 200 }))
  assert.equal(proxy.style.pointerEvents, 'auto', '沒有東西疊上來就該維持可指到，不然 iframe 又選不到了')
  assert.match(doc.querySelector('[data-af-panel]')?.textContent || '', /框架/)
  pm.exitPickMode()
})

test('讓路之後點下選單項目，送出的是那個項目而不是下鑽', async () => {
  const { c, doc, win, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  const item = doc.getElementById('item')
  installHitTest(doc, proxy, item)
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 30 }))
  item.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  const last = runtimeMsgs(c).at(-1)
  assert.equal(last?.type, 'PICKED', `選單項目點下去要送 PICKED，實得 ${JSON.stringify(last?.type)}`)
  assert.notEqual(last?.type, 'DESCEND_FRAME')
})

test('指標離開讓路的元素（移到別的頁面內容）就把代理層裝回去', async () => {
  const { doc, win, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  installHitTest(doc, proxy, doc.getElementById('item'))
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 30 }))
  assert.equal(proxy.style.pointerEvents, 'none')
  doc.getElementById('bar').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }))
  assert.equal(proxy.style.pointerEvents, 'auto',
    '讓路是暫時的，指標離開選單之後不裝回去，iframe 從此選不到')
  pm.exitPickMode()
})

test('指標從選單移進裸露的 iframe 區域也要裝回去（父文件收不到任何事件，只剩選單的 mouseout）', async () => {
  const { doc, win, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  const item = doc.getElementById('item')
  installHitTest(doc, proxy, item)
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 30 }))
  assert.equal(proxy.style.pointerEvents, 'none')
  item.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
  assert.equal(proxy.style.pointerEvents, 'auto')
  pm.exitPickMode()
})

test('在讓路的元素內部移動不得把代理層裝回去（裝回去就馬上又搶走指標）', async () => {
  const { doc, win, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  const menu = doc.getElementById('menu')
  const item = doc.getElementById('item')
  installHitTest(doc, proxy, menu)
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 30 }))
  assert.equal(proxy.style.pointerEvents, 'none')
  // 在選單裡從外框移到項目上：仍在讓路的那個元素內
  item.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 22, clientY: 32 }))
  assert.equal(proxy.style.pointerEvents, 'none')
  item.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: menu }))
  assert.equal(proxy.style.pointerEvents, 'none', '在選單內部進出子元素不算離開')
  pm.exitPickMode()
})

test('滑鼠移動時代理層要跟上版面重排（lazy layout 會把 iframe 推走）', async () => {
  const { doc, win, pm } = await setup(OVERLAP)
  const frame = doc.getElementById('fr')
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50 })
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  assert.equal(proxy.style.width, '100px')
  frame.getBoundingClientRect = () => ({ left: 30, top: 120, width: 640, height: 480 })
  // 節流是以時間為準，測試把時鐘往前推
  const realNow = Date.now
  Date.now = () => realNow() + 5000
  try {
    doc.getElementById('bar').dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  } finally {
    Date.now = realNow
  }
  assert.equal(proxy.style.left, '30px')
  assert.equal(proxy.style.top, '120px')
  assert.equal(proxy.style.width, '640px')
  assert.equal(proxy.style.height, '480px')
  pm.exitPickMode()
})

test('拿不到命中測試（jsdom 這種環境）不得炸，行為同以往', async () => {
  const { doc, win, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  const proxy = proxyOf(doc, 'fr')
  assert.equal(typeof doc.elementFromPoint, 'undefined', '這個測試的前提是環境沒有 elementFromPoint')
  proxy.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }))
  assert.match(doc.querySelector('[data-af-panel]')?.textContent || '', /框架/,
    '問不出底下是什麼就維持原行為，不能整個選取模式停擺')
  pm.exitPickMode()
})

test('離開選取模式要把代理層清乾淨（它不在 overlay 底下，不會被順手拆掉）', async () => {
  const { doc, pm } = await setup(OVERLAP)
  pm.enterPickMode({ purpose: 'preaction', initialTarget: doc.getElementById('bar') })
  assert.equal(doc.querySelectorAll('[data-af-frame-proxy]').length, 1)
  pm.exitPickMode()
  assert.equal(doc.querySelectorAll('[data-af-frame-proxy]').length, 0,
    '留在頁面上會擋住使用者操作網頁')
  assert.equal(pm.isActive(), false)
})
