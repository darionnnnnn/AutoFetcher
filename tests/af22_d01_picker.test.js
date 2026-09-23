import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'

const pickerHtml = readFileSync(new URL('../src/ui/picker/picker.html', import.meta.url), 'utf8')

async function picker() {
  const dom = new JSDOM(pickerHtml)
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const module = await import('../src/ui/picker/picker.js?d01-warning=' + Math.random())
  return { dom, module }
}

test('D01 warns for a blank state after page actions, while allowing the configuration to remain saved', async () => {
  const { dom, module } = await picker()
  const clickTab = [{ type: 'click', locator: { css: '#tab-b' } }]
  assert.equal(module.sourceStateTransitionWarningOf([
    { fields: [{ stateActions: clickTab }, { stateActions: structuredClone(clickTab) }, { stateActions: [] }] }
  ]), true)
  assert.equal(module.sourceStateTransitionWarningOf([
    { fields: [{ stateActions: [] }, { stateActions: clickTab }] }
  ]), false)
  assert.equal(module.sourceStateTransitionWarningOf([
    { fields: [{ stateActions: clickTab }] },
    { fields: [{ stateActions: [] }] }
  ]), false)
  const warning = document.getElementById('source-state-warning')
  assert.equal(warning.getAttribute('role'), 'status')
  assert.match(warning.textContent, /不會阻止儲存/)
  assert.equal(document.getElementById('save').disabled, false)
  dom.window.close()
})
