// AF-24 D-a：群組選取的鍵盤路徑與滑鼠一致（不偷改本地清單）、頁面 Ctrl/⌘＋Enter、Shift 起點只在加選時更新
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fixture(t) {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><body><table id="a"><tbody><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>4</td><td>5</td><td>6</td></tr></tbody></table></body>', { url: 'https://a.test/prices' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  const sent = []
  const values = []
  chrome.__setRuntimeResponder(async message => {
    sent.push(structuredClone(message))
    if (message.type === 'PICKED') {
      for (const pick of message.picks || []) values.push({ key: `k${values.length}`, source: { locator: structuredClone(message.locator || {}) }, spec: structuredClone(pick) })
      for (const pick of message.removePicks || []) {
        const i = values.findIndex(v => JSON.stringify(v.spec) === JSON.stringify(pick))
        if (i >= 0) values.splice(i, 1)
      }
      return { ok: true, revision: sent.length, draft: { groups: [{ key: 'g1', values: structuredClone(values) }] } }
    }
    return { ok: true }
  })
  const picker = await import('../src/content/picker-mode.js?k=' + Math.random())
  picker.enterPickMode({ purpose: 'task', sessionId: 'k-session', groupKey: 'g1', pickStage: 'selecting',
    documentGeneration: 'doc-1', routeIdentity: { url: 'https://a.test/prices' }, draftValues: [] })
  t.after(() => { picker.exitPickMode(); dom.window.close(); resetChromeMock() })
  const move = el => el.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, cancelable: true }))
  const click = (el, extra = {}) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...extra }))
  const key = (k, extra = {}) => {
    const ev = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })
    document.dispatchEvent(ev)
    return ev
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const panelText = () => document.querySelector('[data-af-panel-body]')?.textContent || document.body.textContent
  return { dom, sent, values, move, click, key, flush, panelText }
}

const picked = sent => sent.filter(m => m.type === 'PICKED')

test('群組模式按 Backspace／Ctrl+Z：不送移除、不改草稿，說明怎麼取消', async t => {
  const f = await fixture(t)
  const cells = [...document.querySelectorAll('#a td')]
  f.move(cells[0]); f.click(cells[0]); await f.flush()
  f.move(cells[1]); f.click(cells[1]); await f.flush()
  assert.equal(f.values.length, 2)
  const before = picked(f.sent).length
  const ev = f.key('Backspace')
  assert.equal(ev.defaultPrevented, true, '有值時要攔下，不讓頁面收到 Backspace')
  f.key('z', { ctrlKey: true })
  await f.flush()
  assert.equal(picked(f.sent).length, before, '不得送出移除')
  assert.equal(f.values.length, 2, '草稿不變')
  assert.match(f.panelText(), /再點它一次/)
})

test('群組模式沒有任何值時 Backspace 放給頁面', async t => {
  const f = await fixture(t)
  const ev = f.key('Backspace')
  assert.equal(ev.defaultPrevented, false)
})

test('群組模式 Shift+→：起點與新位置經草稿佇列加入', async t => {
  const f = await fixture(t)
  const cells = [...document.querySelectorAll('#a td')]
  f.move(cells[0])
  f.key('ArrowRight', { shiftKey: true })
  await f.flush()
  const cellsSent = picked(f.sent).flatMap(m => m.picks || []).map(p => `${p.cell.row.index},${p.cell.col.index}`)
  assert.deepEqual(cellsSent.sort(), ['0,0', '0,1'])
  assert.equal(f.values.length, 2)
})

test('群組模式頁面上 Ctrl/⌘＋Enter 送一次完成請求；普通 Enter 不送', async t => {
  const f = await fixture(t)
  const cells = [...document.querySelectorAll('#a td')]
  f.move(cells[0]); f.click(cells[0]); await f.flush()
  f.key('Enter')
  await f.flush()
  assert.equal(f.sent.filter(m => m.type === 'PICK_DRAFT_FINISH_REQUEST').length, 0)
  f.key('Enter', { ctrlKey: true })
  await f.flush()
  const req = f.sent.filter(m => m.type === 'PICK_DRAFT_FINISH_REQUEST')
  assert.equal(req.length, 1)
  assert.equal(req[0].sessionId, 'k-session')
  f.key('Enter', { metaKey: true })
  await f.flush()
  assert.equal(f.sent.filter(m => m.type === 'PICK_DRAFT_FINISH_REQUEST').length, 2, '⌘ 也算')
})

test('取消一格之後 Shift+點：範圍從最後一個已選格拉，不是剛取消的那格', async t => {
  const f = await fixture(t)
  const cells = [...document.querySelectorAll('#a td')] // 0..2 第一列，3..5 第二列
  f.move(cells[0]); f.click(cells[0]); await f.flush()          // 選 (0,0)
  f.move(cells[2]); f.click(cells[2]); await f.flush()          // 選 (0,2)
  f.move(cells[2]); f.click(cells[2]); await f.flush()          // 取消 (0,2)
  const before = picked(f.sent).length
  f.move(cells[4]); f.click(cells[4], { shiftKey: true }); await f.flush() // Shift 到 (1,1)
  const added = picked(f.sent).slice(before).flatMap(m => m.picks || []).map(p => `${p.cell.row.index},${p.cell.col.index}`).sort()
  assert.deepEqual(added, ['0,1', '1,0', '1,1'], `起點應是 (0,0)：矩形 (0,0)-(1,1) 扣掉已選的 (0,0)，實得 ${added}`)
})
