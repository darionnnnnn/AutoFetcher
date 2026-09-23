import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function fixture(t, draftValues = []) {
  resetChromeMock()
  const chrome = installChromeMock()
  const dom = new JSDOM('<!doctype html><body><table id="a"><tbody><tr><td>A1</td><td>A2</td><td>A3</td></tr></tbody></table><table id="b"><tbody><tr><td>B1</td><td>B2</td><td>B3</td></tr></tbody></table></body>', { url: 'https://a.test/prices' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.location = dom.window.location
  const sent = []
  const values = structuredClone(draftValues)
  chrome.__setRuntimeResponder(async message => {
    if (message.type === 'PICKED') {
      sent.push(structuredClone(message))
      for (const pick of message.picks || []) {
        const spec = structuredClone(pick)
        if (spec.block) Object.assign(spec.block, { skip: { head: 1, blank: true }, pos: 'last-1', inner: [{ tag: 'span', index: 1 }] })
        const value = { key: `d2-${values.length}`, mode: pick.block ? 'block' : 'number',
          source: { locator: structuredClone(message.locator || {}) }, locator: structuredClone(message.locator || {}),
          spec }
        values.push(value)
      }
      for (const pick of message.removePicks || []) {
        const i = values.findIndex(value => JSON.stringify(value.spec) === JSON.stringify(pick))
        if (i >= 0) values.splice(i, 1)
      }
      for (const item of message.replacePicks || []) {
        const i = values.findIndex(value => value.source.locator && JSON.stringify(value.source.locator) === JSON.stringify(message.locator || {}))
        if (i >= 0) values[i] = { ...values[i], spec: structuredClone(item.pick) }
      }
      return { ok: true, revision: sent.length, draft: { groups: [{ key: 'g1', values: structuredClone(values) }] } }
    }
    return undefined
  })
  const picker = await import('../src/content/picker-mode.js?d2=' + Math.random())
  picker.enterPickMode({ purpose: 'task', sessionId: 'd2-session', groupKey: 'g1', pickStage: 'selecting',
    documentGeneration: 'doc-1', routeIdentity: { url: 'https://a.test/prices' }, draftValues })
  t.after(() => { picker.exitPickMode(); dom.window.close(); resetChromeMock() })
  const move = el => el.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true, cancelable: true }))
  const click = (el, extra = {}) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...extra }))
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  return { dom, picker, sent, move, click, flush }
}

test('D2 99+3 Shift range and Ctrl+A fail atomically without crossing group cap', async t => {
  const existing = Array.from({ length: 99 }, (_, i) => ({
    source: { locator: { css: `#old-${i}` } },
    spec: { cell: { row: { index: i }, col: { index: 8 } } }
  }))
  const f = await fixture(t, existing)
  const cells = [...document.querySelectorAll('#a td')]
  f.move(cells[0]); f.click(cells[0]); await f.flush()
  const before = f.sent.length
  f.click(cells[2], { shiftKey: true })
  await f.flush()
  assert.equal(f.sent.length, before, '99 existing + 3 range cells must enqueue no partial additions')
  const key = new f.dom.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
  document.dispatchEvent(key)
  await f.flush()
  assert.equal(f.sent.length, before, 'Ctrl+A must also preflight the full selection before sending')
})

test('D2 Shift range anchor never carries indices across tables', async t => {
  const f = await fixture(t)
  const a = document.querySelector('#a td:first-child')
  const b = document.querySelector('#b td:last-child')
  f.move(a); f.click(a); await f.flush()
  f.move(b); f.click(b, { shiftKey: true }); await f.flush()
  const picks = f.sent.flatMap(message => message.picks || [])
  assert.equal(picks.length, 2, 'different-table Shift starts a fresh single-cell selection instead of forming a cross-table rectangle')
  assert.ok(picks.every(pick => pick.cell), 'both selections remain concrete cell locators')
  assert.notDeepEqual(picks[0].cell, picks[1].cell)
})

test('D2 drag range stays in its source table even when pointer leaves for another table', async t => {
  const f = await fixture(t)
  const a = [...document.querySelectorAll('#a td')]
  const b = document.querySelector('#b td:last-child')
  f.move(a[0])
  a[0].dispatchEvent(new f.dom.window.MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true, cancelable: true }))
  f.move(a[0])
  a[2].dispatchEvent(new f.dom.window.MouseEvent('mousemove', { buttons: 1, bubbles: true, cancelable: true }))
  a[2].dispatchEvent(new f.dom.window.MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }))
  await f.flush()
  const within = f.sent.flatMap(message => message.picks || [])
  assert.equal(within.length, 3, 'same-table drag selects its complete rectangle')
  assert.ok(within.every(pick => pick.cell?.row && pick.cell?.col))

  // Start from A again and release over B. The ending coordinates are ignored
  // because B is not a descendant of the captured source table.
  f.sent.length = 0
  f.move(a[0])
  a[0].dispatchEvent(new f.dom.window.MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true, cancelable: true }))
  f.move(a[0])
  b.dispatchEvent(new f.dom.window.MouseEvent('mousemove', { buttons: 1, bubbles: true, cancelable: true }))
  b.dispatchEvent(new f.dom.window.MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }))
  await f.flush()
  const across = f.sent.flatMap(message => message.picks || [])
  assert.ok(across.every(pick => pick.cell?.row?.index === 0 && pick.cell?.col?.index === 0),
    'cross-table pointer movement cannot inject the second table index into the first table range')
})

test('D2 context-menu exclude then include replaces the existing grouped block in place', async t => {
  const f = await fixture(t)
  const cell = document.querySelector('#a td:nth-child(2)')
  f.move(cell)
  document.querySelector('[data-af-tool="col"]').click()
  f.click(cell)
  await f.flush()
  const context = () => {
    cell.dispatchEvent(new f.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    return document.querySelector('[data-af-menu-item="exclude"], [data-af-menu-item="include"]')
  }
  let action = context()
  assert.equal(action?.getAttribute('data-af-menu-item'), 'exclude')
  action.click()
  await f.flush()
  let replacements = f.sent.filter(message => message.replacePicks)
  assert.equal(replacements.length, 1)
  assert.deepEqual(replacements[0].replacePicks[0].pick.block.exclude.map(item => item.index), [0])
  assert.deepEqual(replacements[0].replacePicks[0].pick.block.skip, { head: 1, blank: true })
  assert.equal(replacements[0].replacePicks[0].pick.block.pos, 'last-1')
  assert.deepEqual(replacements[0].replacePicks[0].pick.block.inner, [{ tag: 'span', index: 1 }])
  action = context()
  assert.equal(action?.getAttribute('data-af-menu-item'), 'include')
  action.click()
  await f.flush()
  replacements = f.sent.filter(message => message.replacePicks)
  assert.equal(replacements.length, 2)
  assert.equal(replacements[1].replacePicks[0].pick.block.exclude, undefined)
  assert.deepEqual(replacements[1].replacePicks[0].pick.block.skip, { head: 1, blank: true })
  assert.equal(replacements[1].replacePicks[0].pick.block.pos, 'last-1')
  assert.deepEqual(replacements[1].replacePicks[0].pick.block.inner, [{ tag: 'span', index: 1 }])
})

test('D2 pause then re-enter releases page clicks and hydrates the current group once', async t => {
  const f = await fixture(t)
  const firstCell = document.querySelector('#a td:first-child')
  let pageClicks = 0
  firstCell.addEventListener('click', () => { pageClicks++ })
  f.move(firstCell)
  f.click(firstCell)
  await f.flush()
  assert.equal(f.sent.length, 1)
  f.picker.exitPickMode()
  firstCell.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(pageClicks, 1, 'paused picker must release page interactions')

  const hydrated = [{ key: 'rehydrated-value', source: { locator: f.sent[0].locator },
    spec: { cell: f.sent[0].picks[0].cell, block: undefined, pos: 'first', skip: { blank: true } } }]
  f.picker.enterPickMode({ purpose: 'task', sessionId: 'd2-session', groupKey: 'g1', pickStage: 'selecting',
    documentGeneration: 'doc-1', routeIdentity: { url: 'https://a.test/prices' }, draftValues: hydrated })
  f.move(firstCell)
  f.click(firstCell)
  await f.flush()
  assert.equal(f.sent.length, 2, 'the resumed gesture has one fresh ACKed removal, without stale previous listeners')
  assert.ok(f.sent[1].removePicks?.length === 1)
  assert.equal(f.sent[1].sessionId, 'd2-session')
  assert.equal(f.sent[1].groupKey, 'g1')
  assert.equal(f.sent[1].documentGeneration, 'doc-1')
})
