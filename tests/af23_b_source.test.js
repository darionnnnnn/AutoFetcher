import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

async function pickCell(t, html, id, sessionId) {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.__setRuntimeResponder(message => message?.type === 'PICKED' ? { ok: true } : undefined)
  const dom = new JSDOM(html, { url: 'https://a.test/table' })
  const previous = Object.fromEntries(['window', 'document', 'location', 'Event', 'MouseEvent'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, location: dom.window.location,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent
  })
  const picker = await import('../src/content/picker-mode.js?af23-source=' + Math.random())
  const table = document.querySelector('[role="grid"], table, .css-grid')
  const cell = document.getElementById(id)
  const identity = { sessionId, documentGeneration: 'doc-1', routeIdentity: 'route-1' }
  picker.enterPickMode({ purpose: 'task', ...identity, groupKey: 'g1', pickStage: 'selecting', initialTarget: table })
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const message = chrome.__calls.map(call => call.args?.[0])
    .find(item => item?.type === 'PICKED' && item.sessionId === sessionId)
  assert.ok(message, 'selected cell reached the persisted draft boundary')
  const expected = [{ groupKey: 'g1', groupName: '第一組', groupIndex: 1,
    value: { source: { locator: message.locator }, spec: message.picks[0] } }]
  t.after(() => {
    picker.exitPickMode()
    dom.window.close()
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key]
      else globalThis[key] = previous[key]
    }
    resetChromeMock()
  })
  return { chrome, dom, picker, table, cell, identity, expected }
}

async function pickRepair(t, html, { id, sessionId, preselect } = {}) {
  resetChromeMock()
  const chrome = installChromeMock()
  chrome.__setRuntimeResponder(message => message?.type === 'PICKED' ? { ok: true } : undefined)
  const dom = new JSDOM(html, { url: 'https://a.test/table' })
  const previous = Object.fromEntries(['window', 'document', 'location', 'Event', 'MouseEvent'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, location: dom.window.location,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent
  })
  const picker = await import('../src/content/picker-mode.js?af23-repair-source=' + Math.random())
  const table = document.querySelector('[role="grid"], table, .css-grid')
  const identity = { purpose: 'repick', taskId: 'repair-task', repairSessionId: sessionId,
    repairFieldKey: 'f1', repairMode: 'repair', documentGeneration: 'doc-1', initialTarget: table, preselect }
  picker.enterPickMode(identity)
  if (id) {
    const cell = document.getElementById(id)
    cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  t.after(() => {
    picker.exitPickMode()
    dom.window.close()
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key]
      else globalThis[key] = previous[key]
    }
    resetChromeMock()
  })
  return { chrome, dom, picker, table, identity }
}

const numericRows = `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
  <tr><th>1</th><td id="selected">123</td></tr><tr><th>2</th><td>200</td></tr>
  </tbody></table>`

test('AC-B1 duplicate numeric row header insertion cannot silently move 123 source to 111', async t => {
  const f = await pickCell(t, numericRows, 'selected', 'b1-numeric-duplicate')
  const inserted = document.createElement('tr')
  inserted.innerHTML = '<th>1</th><td>111</td>'
  f.table.querySelector('tbody').insertBefore(inserted, f.table.querySelector('tbody').firstElementChild)
  const result = await f.picker.drainPickQueue({ ...f.identity, validateSources: true, expectedSources: f.expected })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'stale_source')
  assert.match(result.message, /第一組.*123/)
  assert.equal(f.expected.length, 1, 'rejecting this source leaves the saved draft value available')
})

test('AC-B2 same cell value refresh and unique row-header relocation remain valid', async t => {
  const updated = await pickCell(t, numericRows, 'selected', 'b2-refresh')
  updated.cell.textContent = '124'
  const refreshed = await updated.picker.drainPickQueue({ ...updated.identity, validateSources: true, expectedSources: updated.expected })
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.validatedSources, 1)

  const unique = await pickCell(t, `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
    <tr id="north"><th>北區</th><td id="moving">123</td></tr><tr id="south"><th>南區</th><td>200</td></tr>
    </tbody></table>`, 'moving', 'b2-unique-header')
  const body = unique.table.querySelector('tbody')
  body.append(body.querySelector('#north'))
  const moved = await unique.picker.drainPickQueue({ ...unique.identity, validateSources: true, expectedSources: unique.expected })
  assert.equal(moved.ok, true, 'the unique row header follows the same source node after reordering')
})

test('AC-B2 explicit first position is dynamic and ARIA grid uses the same source check', async t => {
  const positioned = await pickCell(t, numericRows, 'selected', 'b2-position')
  const value = positioned.expected[0].value
  value.spec.cell.row.pos = 'first'
  const inserted = document.createElement('tr')
  inserted.innerHTML = '<th>0</th><td>111</td>'
  positioned.table.querySelector('tbody').prepend(inserted)
  const first = await positioned.picker.drainPickQueue({ ...positioned.identity, validateSources: true, expectedSources: positioned.expected })
  assert.equal(first.ok, true, 'explicit first-position semantics are not mistaken for a stale fixed row')

  const aria = await pickCell(t, `<div role="grid">
    <div role="row"><span role="columnheader">項目</span><span role="columnheader">價格</span></div>
    <div role="row"><span role="rowheader">A</span><span role="gridcell" id="aria-selected">123</span></div>
    </div>`, 'aria-selected', 'b2-aria-grid')
  const ariaResult = await aria.picker.drainPickQueue({ ...aria.identity, validateSources: true, expectedSources: aria.expected })
  assert.equal(ariaResult.ok, true)
})

test('AC-B1 inserted column with positional fallback is rejected for HTML and CSS grids', async t => {
  const html = await pickCell(t, `<table><tbody>
    <tr><td id="selected">123</td><td>200</td></tr><tr><td>124</td><td>201</td></tr>
    </tbody></table>`, 'selected', 'b1-html-column')
  const row = html.table.querySelector('tbody tr')
  row.insertBefore(document.createElement('td'), row.firstElementChild).textContent = '111'
  const htmlResult = await html.picker.drainPickQueue({ ...html.identity, validateSources: true, expectedSources: html.expected })
  assert.equal(htmlResult.error, 'stale_source')

  const css = await pickCell(t, `<div class="css-grid">
    <div><span>A</span><span>B</span></div><div><span id="selected">123</span><span>200</span></div>
    <div><span>124</span><span>201</span></div>
    </div>`, 'selected', 'b1-css-column')
  const cssRow = document.createElement('div')
  cssRow.innerHTML = '<span>111</span><span>222</span>'
  css.table.insertBefore(cssRow, css.table.children[1])
  const cssResult = await css.picker.drainPickQueue({ ...css.identity, validateSources: true, expectedSources: css.expected })
  assert.equal(cssResult.error, 'stale_source')
})

test('AC-B1 removed selected row and replaced table are rejected even when replacement markup matches', async t => {
  const removed = await pickCell(t, numericRows, 'selected', 'b1-row-delete')
  removed.cell.closest('tr').remove()
  const rowResult = await removed.picker.drainPickQueue({ ...removed.identity, validateSources: true, expectedSources: removed.expected })
  assert.equal(rowResult.error, 'stale_source')

  const replaced = await pickCell(t, numericRows, 'selected', 'b1-table-replaced')
  const clone = replaced.table.cloneNode(true)
  replaced.table.replaceWith(clone)
  const tableResult = await replaced.picker.drainPickQueue({ ...replaced.identity, validateSources: true, expectedSources: replaced.expected })
  assert.equal(tableResult.error, 'stale_source')
})

test('AC-B1 repeated numeric column header insertion cannot bind the original pick to a neighbor', async t => {
  const f = await pickCell(t, `<table><thead><tr><th>項目</th><th>1</th><th>1</th></tr></thead><tbody>
    <tr><th>A</th><td>200</td><td id="selected">123</td></tr>
    </tbody></table>`, 'selected', 'b1-duplicate-column')
  const header = document.createElement('th')
  header.textContent = '1'
  f.table.querySelector('thead tr').insertBefore(header, f.table.querySelector('thead tr').children[1])
  const dataRow = f.table.querySelector('tbody tr')
  const neighbor = document.createElement('td')
  neighbor.textContent = '111'
  dataRow.insertBefore(neighbor, dataRow.children[1])
  const result = await f.picker.drainPickQueue({ ...f.identity, validateSources: true, expectedSources: f.expected })
  assert.equal(result.error, 'stale_source')
  assert.match(result.message, /第一組.*123/)
})

test('AC-B1 repeated numeric row headers use identical validation under an ARIA grid', async t => {
  const f = await pickCell(t, `<div role="grid">
    <div role="row"><span role="columnheader">項目</span><span role="columnheader">價格</span></div>
    <div role="row"><span role="rowheader">1</span><span role="gridcell" id="selected">123</span></div>
    <div role="row"><span role="rowheader">2</span><span role="gridcell">200</span></div>
    </div>`, 'selected', 'b1-aria-row')
  const inserted = document.createElement('div')
  inserted.setAttribute('role', 'row')
  inserted.innerHTML = '<span role="rowheader">1</span><span role="gridcell">111</span>'
  f.table.insertBefore(inserted, f.table.children[1])
  const result = await f.picker.drainPickQueue({ ...f.identity, validateSources: true, expectedSources: f.expected })
  assert.equal(result.error, 'stale_source')
})

test('AC-B1 repair submission checks the selected DOM anchor before sending PICKED', async t => {
  const f = await pickRepair(t, `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
    <tr><th>1</th><td id="selected">123</td></tr><tr><th>2</th><td>200</td></tr>
    </tbody></table>`, { id: 'selected', sessionId: 'repair-stale-insert' })
  const inserted = document.createElement('tr')
  inserted.innerHTML = '<th>1</th><td>111</td>'
  f.table.querySelector('tbody').prepend(inserted)
  document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'), false,
    'no repair request is sent after the coordinate would silently bind to another 1 row')
  assert.match(document.querySelector('[data-af-panel]').textContent, /重新選取目前要抓的值/)
})

test('AC-B1 repeated Done cannot clear a stale repair anchor and bypass the guard', async t => {
  const f = await pickRepair(t, `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
    <tr><th>1</th><td id="selected">123</td></tr><tr><th>2</th><td id="current">200</td></tr>
    </tbody></table>`, { id: 'selected', sessionId: 'repair-stale-repeat' })
  const inserted = document.createElement('tr')
  inserted.innerHTML = '<th>1</th><td>111</td>'
  f.table.querySelector('tbody').prepend(inserted)
  const done = document.querySelector('[data-af-done]')
  const submit = async () => {
    done.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setImmediate(resolve))
  }
  await submit()
  await submit()
  assert.equal(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'), false,
    'repeating Done still refuses the stale original row')

  const current = document.getElementById('current')
  current.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  current.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await submit()
  assert.ok(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'),
    'a real new selection replaces the stale anchor and can be submitted')
})

test('AC-B1 repair Undo restores its source anchor with the restored selection', async t => {
  const f = await pickRepair(t, `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
    <tr><th>1</th><td id="selected">123</td></tr><tr><th>2</th><td>200</td></tr>
    </tbody></table>`, { id: 'selected', sessionId: 'repair-stale-undo' })
  document.getElementById('selected').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setImmediate(resolve))
  document.querySelector('[data-af-undo]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setImmediate(resolve))
  const inserted = document.createElement('tr')
  inserted.innerHTML = '<th>1</th><td>111</td>'
  f.table.querySelector('tbody').prepend(inserted)
  document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'), false,
    'Undo restores the original DOM anchor, so later source drift is still rejected')
})

test('AC-B2 repair accepts a live value refresh on the same selected node', async t => {
  const f = await pickRepair(t, `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
    <tr><th>A</th><td id="selected">123</td></tr>
    </tbody></table>`, { id: 'selected', sessionId: 'repair-live-refresh' })
  document.getElementById('selected').textContent = '124'
  document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'),
    'the live cell value can update while its source DOM node remains the same')
})

test('AC-B2 repair anchor honors dynamic first/last and unique-header table refresh', async t => {
  for (const [position, changed] of [
    ['first', body => { const row = document.createElement('tr'); row.innerHTML = '<th>0</th><td>111</td>'; body.prepend(row) }],
    ['last', body => { body.lastElementChild.remove() }]
  ]) {
    const f = await pickRepair(t, `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
      <tr><th>A</th><td>100</td></tr><tr><th>B</th><td>200</td></tr><tr><th>C</th><td>300</td></tr>
      </tbody></table>`, { sessionId: `repair-pos-${position}`, preselect: [{ cell: {
      row: { index: position === 'first' ? 0 : 2, header: position === 'first' ? 'A' : 'C', pos: position },
      col: { index: 1, header: '價格' }
    } }] })
    changed(f.table.querySelector('tbody'))
    document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'),
      `${position} position follows the current source after insert/delete`)
  }

  const unique = await pickRepair(t, `<table><thead><tr><th>項目</th><th>價格</th></tr></thead><tbody>
    <tr><th>A</th><td>100</td></tr><tr><th>B</th><td>200</td></tr>
    </tbody></table>`, { sessionId: 'repair-unique-column', preselect: [{ block: { axis: 'col', index: 1, headerText: '價格' } }] })
  const tbody = unique.table.querySelector('tbody')
  const replacement = document.createElement('tbody')
  replacement.innerHTML = '<tr><th>A</th><td>101</td></tr><tr><th>B</th><td>201</td></tr>'
  tbody.replaceWith(replacement)
  document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(unique.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'),
    'a unique header keeps its column identity when tbody is refreshed')
})

test('AC-B1 repair rejects same-index neighbor after a duplicate numeric column is fully rerendered', async t => {
  const f = await pickRepair(t, `<table><thead><tr><th>項目</th><th>1</th><th>1</th></tr></thead><tbody>
    <tr><th>A</th><td>200</td><td>123</td></tr>
    </tbody></table>`, { sessionId: 'repair-duplicate-column', preselect: [{ block: { axis: 'col', index: 2, headerText: '1' } }] })
  const oldBody = f.table.querySelector('tbody')
  const replacement = document.createElement('tbody')
  replacement.innerHTML = '<tr><th>A</th><td>111</td><td>222</td></tr>'
  oldBody.replaceWith(replacement)
  document.querySelector('[data-af-done]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.chrome.__calls.some(call => call.api === 'runtime.sendMessage' && call.args[0]?.type === 'PICKED'), false)
})
