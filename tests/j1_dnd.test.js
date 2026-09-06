// AF-4 C1:共用拖曳協定(Pointer Events,以已註冊目標的矩形做命中判定)
process.env.TZ = 'Asia/Taipei'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const jd = new JSDOM('<!doctype html><body></body>')
globalThis.window = jd.window
globalThis.document = jd.window.document

const DND = await import('../src/ui/report/dnd.js')

// 每個測試自己的乾淨畫布
function setup() {
  document.body.textContent = ''
  DND.resetDnd()
  const src = document.createElement('div')
  src.id = 'src'
  document.body.appendChild(src)
  return src
}

function makeTarget(id, rect) {
  const el = document.createElement('div')
  el.id = id
  el.getBoundingClientRect = () => ({
    left: rect[0], top: rect[1], right: rect[2], bottom: rect[3],
    width: rect[2] - rect[0], height: rect[3] - rect[1], x: rect[0], y: rect[1]
  })
  document.body.appendChild(el)
  return el
}

// jsdom 沒有 PointerEvent,用 Event 補上需要的欄位(真實瀏覽器是 PointerEvent)
function pointer(type, x, y, over = {}) {
  const e = new jd.window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0, ...over })
  return e
}
const down = (el, x, y) => el.dispatchEvent(pointer('pointerdown', x, y))
const move = (x, y) => document.dispatchEvent(pointer('pointermove', x, y))
const up = (x, y) => document.dispatchEvent(pointer('pointerup', x, y))

test('移動未達門檻不算開始拖曳(才不會把點擊變成拖曳)', () => {
  const src = setup()
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  down(src, 100, 100)
  move(102, 101)
  assert.equal(DND.isDragging(), false)
  move(110, 100)
  assert.equal(DND.isDragging(), true, '超過 4px 才開始')
  up(110, 100)
})

test('拖曳開始後會產生跟著指標走的幽靈元素,結束即移除', () => {
  const src = setup()
  DND.createDragSource(src, () => ({ taskId: 't1', label: '電費' }))
  down(src, 0, 0)
  move(50, 50)
  const ghost = document.querySelector('[data-dnd-ghost]')
  assert.ok(ghost, '要有幽靈元素')
  assert.ok(ghost.textContent.includes('電費'), '幽靈要顯示標籤,使用者才知道拖的是什麼')
  up(50, 50)
  assert.equal(document.querySelector('[data-dnd-ghost]'), null, '結束要清乾淨')
})

test('放開在接受的目標上會呼叫 onDrop,並帶 payload 與座標', () => {
  const src = setup()
  const tgt = makeTarget('t', [200, 200, 300, 300])
  const calls = []
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  DND.registerDropTarget(tgt, {
    accepts: () => true,
    onDrop: (payload, pos) => calls.push({ payload, pos })
  })
  down(src, 0, 0)
  move(250, 250)
  up(250, 250)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].payload, { taskId: 't1' })
  assert.equal(calls[0].pos.x, 250)
  assert.equal(calls[0].pos.y, 250)
})

test('拖過目標時呼叫 onDragOver 並標記,離開時呼叫 onLeave 並清掉標記', () => {
  const src = setup()
  const tgt = makeTarget('t', [200, 200, 300, 300])
  let overs = 0, leaves = 0
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  DND.registerDropTarget(tgt, { accepts: () => true, onDragOver: () => overs++, onLeave: () => leaves++ })
  down(src, 0, 0)
  move(250, 250)
  assert.ok(overs >= 1)
  assert.equal(tgt.hasAttribute('data-drop-active'), true, '合法目標要看得出來')
  move(10, 10)
  assert.equal(leaves, 1)
  assert.equal(tgt.hasAttribute('data-drop-active'), false)
  up(10, 10)
})

test('不接受這個 payload 的目標不標記也不觸發 onDrop', () => {
  const src = setup()
  const tgt = makeTarget('t', [200, 200, 300, 300])
  let dropped = 0
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  DND.registerDropTarget(tgt, { accepts: () => false, onDrop: () => dropped++ })
  down(src, 0, 0)
  move(250, 250)
  assert.equal(tgt.hasAttribute('data-drop-active'), false)
  up(250, 250)
  assert.equal(dropped, 0)
})

test('放開在所有目標之外不觸發任何 onDrop', () => {
  const src = setup()
  const tgt = makeTarget('t', [200, 200, 300, 300])
  let dropped = 0
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  DND.registerDropTarget(tgt, { accepts: () => true, onDrop: () => dropped++ })
  down(src, 0, 0)
  move(500, 500)
  up(500, 500)
  assert.equal(dropped, 0)
  assert.equal(DND.isDragging(), false)
})

test('按 Esc 取消拖曳,放開時不算數', () => {
  const src = setup()
  const tgt = makeTarget('t', [200, 200, 300, 300])
  let dropped = 0
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  DND.registerDropTarget(tgt, { accepts: () => true, onDrop: () => dropped++ })
  down(src, 0, 0)
  move(250, 250)
  const esc = new jd.window.Event('keydown', { bubbles: true })
  Object.assign(esc, { key: 'Escape' })
  document.dispatchEvent(esc)
  assert.equal(DND.isDragging(), false)
  assert.equal(document.querySelector('[data-dnd-ghost]'), null)
  up(250, 250)
  assert.equal(dropped, 0)
})

test('多個目標時命中最上層(後註冊的)那一個', () => {
  const src = setup()
  const outer = makeTarget('outer', [0, 0, 400, 400])
  const inner = makeTarget('inner', [200, 200, 300, 300])
  const hit = []
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  DND.registerDropTarget(outer, { accepts: () => true, onDrop: () => hit.push('outer') })
  DND.registerDropTarget(inner, { accepts: () => true, onDrop: () => hit.push('inner') })
  down(src, 0, 0)
  move(250, 250)
  up(250, 250)
  assert.deepEqual(hit, ['inner'], '巢狀時該落在內層,不能兩個都觸發')
})

test('getPayload 回 null 時不啟動拖曳', () => {
  const src = setup()
  DND.createDragSource(src, () => null)
  down(src, 0, 0)
  move(50, 50)
  assert.equal(DND.isDragging(), false)
  assert.equal(document.querySelector('[data-dnd-ghost]'), null)
})

test('沒有 setPointerCapture 也不會炸(jsdom 就沒有)', () => {
  const src = setup()
  assert.equal(typeof src.setPointerCapture, 'undefined')
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  assert.doesNotThrow(() => { down(src, 0, 0); move(50, 50); up(50, 50) })
})

test('右鍵或中鍵按下不啟動拖曳', () => {
  const src = setup()
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  src.dispatchEvent(pointer('pointerdown', 0, 0, { button: 2 }))
  move(50, 50)
  assert.equal(DND.isDragging(), false)
})

test('unregisterDropTarget 之後該目標不再收 onDrop', () => {
  const src = setup()
  const tgt = makeTarget('t', [200, 200, 300, 300])
  let dropped = 0
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  const off = DND.registerDropTarget(tgt, { accepts: () => true, onDrop: () => dropped++ })
  off()
  down(src, 0, 0)
  move(250, 250)
  up(250, 250)
  assert.equal(dropped, 0)
})

test('同一個來源可以連續拖兩次', () => {
  const src = setup()
  const tgt = makeTarget('t', [200, 200, 300, 300])
  let dropped = 0
  DND.createDragSource(src, () => ({ taskId: 't1' }))
  DND.registerDropTarget(tgt, { accepts: () => true, onDrop: () => dropped++ })
  for (let i = 0; i < 2; i++) { down(src, 0, 0); move(250, 250); up(250, 250) }
  assert.equal(dropped, 2, '第一次拖完狀態沒清乾淨的話第二次會失效')
})
