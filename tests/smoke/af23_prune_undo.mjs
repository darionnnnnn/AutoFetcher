// AF-23 T05: real report UI flow for prune + undo/redo across report pages.
// Seed only the initial fixtures; all meaningful changes use visible controls.
// Run with AF23_EXTENSION_PATH=/path/to/qa/src BROWSER_PATH=/path/to/CfT.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const ROOT = resolve(import.meta.dirname, '../..')
const EXTENSION_PATH = resolve(process.env.AF23_EXTENSION_PATH || process.env.AF23_QA_SRC || join(ROOT, 'src'))
const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  join(os.homedir(), 'Downloads', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join(os.tmpdir(), 'af22-cft', 'chrome', 'mac-arm64', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join(os.tmpdir(), 'af22-cft', 'chrome', 'win64-154.0.8037.57', 'chrome-win64', 'chrome.exe')
].filter(Boolean)
const BROWSER_PATH = BROWSER_CANDIDATES.find(existsSync)
const OUTPUT = resolve(process.env.AF23_T05_OUTPUT || join(ROOT, 'work', 'af23-prune-undo.json'))
const DASH_ID = '00000000-0000-4000-8000-000000000001'
const FIRST_CARD = 'af23-prune-target'
const OTHER_CARD = 'af23-prune-other'
const TASK_IDS = ['af23-prune-keep', 'af23-prune-drop', 'af23-prune-other-task']
const ROUTE = `chrome-extension://${process.env.AF23_EXTENSION_ID || 'EXTENSION_ID'}/ui/report/report.html#view=dashboard`

const task = (id, name, mode = 'number') => ({
  id, name, url: 'https://fixture.invalid/', mode, enabled: true, order: TASK_IDS.indexOf(id),
  locator: { css: '#value' }, spec: { strategy: 'text' },
  schedule: { type: 'daily', times: ['09:00'], weekdays: [0, 1, 2, 3, 4, 5, 6] }
})
const waitFor = (page, fn, label, timeout = 15000) => page.waitForFunction(fn, { polling: 100, timeout }).catch(err => {
  throw new Error(`${label}: ${err.message}`)
})
const waitForSnapshot = async (page, predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await snapshot(page)
    if (predicate(state)) return state
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`${label}: timed out`)
}
const click = async (page, selector) => {
  const element = await page.$(selector)
  assert.ok(element, `missing control ${selector}`)
  await element.evaluate(el => el.scrollIntoView({ block: 'center' }))
  const box = await element.boundingBox()
  assert.ok(box && box.width > 0 && box.height > 0, `control not visible ${selector}`)
  const hit = await page.evaluate(s => {
    const el = document.querySelector(s)
    const rect = el?.getBoundingClientRect()
    if (!el || !rect || el.disabled || el.hidden || el.closest('[hidden]')) return false
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return target === el || el.contains(target)
  }, selector)
  assert.ok(hit, `control is obscured or not hit-testable ${selector}`)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}
const snapshot = page => page.evaluate(async ids => {
  const storage = await import(chrome.runtime.getURL('shared/storage.js'))
  const dashboardApi = await import(chrome.runtime.getURL('ui/report/dashboard.js'))
  const layout = await storage.getRawLayout()
  const dashboard = layout.dashboards.find(item => item.id === '00000000-0000-4000-8000-000000000001')
  const cards = Object.fromEntries(ids.map(id => [id, dashboard.cards.find(card => card.id === id) || null]))
  const tasks = await storage.getTasks()
  return { cards, liveTaskIds: tasks.map(item => item.id), undoDepth: dashboardApi.historySize() }
}, [FIRST_CARD, OTHER_CARD])

let browser
let profile
let extensionId
const actions = []
const startedAt = Date.now()

try {
  assert.ok(BROWSER_PATH, `Chrome for Testing unavailable; set BROWSER_PATH. Checked: ${BROWSER_CANDIDATES.join(', ')}`)
  assert.ok(existsSync(join(EXTENSION_PATH, 'manifest.json')), `extension source not found: ${EXTENSION_PATH}`)
  profile = mkdtempSync(join(os.tmpdir(), 'af23-prune-undo-'))
  browser = await puppeteer.launch({
    executablePath: BROWSER_PATH,
    headless: process.env.AF23_HEADLESS === '1',
    userDataDir: profile,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run', '--no-default-browser-check']
  })
  const worker = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().endsWith('/background/main.js'), { timeout: 20000 })
  extensionId = new URL(worker.url()).host
  const route = ROUTE.replace('EXTENSION_ID', extensionId)

  const seedPage = await browser.newPage()
  await seedPage.goto(`chrome-extension://${extensionId}/ui/report/report.html#view=settings`)
  await seedPage.waitForFunction(() => Boolean(chrome?.runtime?.id))
  await seedPage.evaluate(async ({ taskRows, dashId, firstCard, otherCard }) => {
    await chrome.storage.local.clear()
    await chrome.storage.local.set({
      schemaVersion: 4,
      tasks: taskRows,
      layout: { version: 1, lastDashboardId: dashId, dashboards: [{
        id: dashId, name: '預設', cards: [
          { id: firstCard, type: 'line', title: '原始折線', x: 0, y: 0, w: 6, h: 2,
            source: [{ taskId: 'af23-prune-keep', aggregation: 'raw' }], options: { period: 7 } },
          { id: otherCard, type: 'number', title: '不受影響卡片', x: 6, y: 0, w: 3, h: 2,
            source: [{ taskId: 'af23-prune-other-task', aggregation: 'raw' }], options: { period: 7 } }
        ]
      }] },
      settings: { theme: 'system', history: { tableMode: 'list' } }
    })
  }, {
    taskRows: [task(TASK_IDS[0], '保留任務'), task(TASK_IDS[1], '刪除任務'), task(TASK_IDS[2], '其他任務')],
    dashId: DASH_ID, firstCard: FIRST_CARD, otherCard: OTHER_CARD
  })
  await seedPage.close()

  const first = await browser.newPage()
  await first.goto(route)
  await waitFor(first, () => document.querySelector('#dashboard-grid [data-card-id="af23-prune-target"]'), 'first report dashboard')
  const before = await snapshot(first)
  assert.deepEqual(before.cards[FIRST_CARD].source.map(item => item.taskId), [TASK_IDS[0]])

  // Real palette -> card pointer drag records the undo step.
  await click(first, '#edit-layout')
  await waitFor(first, () => !document.getElementById('source-palette').hidden, 'edit palette visible')
  const source = await first.$(`[data-palette-task][data-task-id="${TASK_IDS[1]}"]`)
  const card = await first.$(`[data-card-id="${FIRST_CARD}"]`)
  assert.ok(source && card, 'drag source and target card exist')
  await source.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await card.evaluate(el => el.scrollIntoView({ block: 'center' }))
  const sourceBox = await source.boundingBox()
  const cardBox = await card.boundingBox()
  assert.ok(sourceBox?.width && cardBox?.width, 'drag endpoints visible')
  await first.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await first.mouse.down()
  await first.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + Math.min(70, cardBox.height / 2), { steps: 8 })
  await first.mouse.up()
  await waitForSnapshot(first, state => state.undoDepth === 1 && state.cards[FIRST_CARD]?.source.some(item => item.taskId === TASK_IDS[1]), 'drop added source')
  actions.push({ action: 'drag task into line card', kind: 'pointer-drag', status: 'PASS' })

  // Delete through the task tab's visible row action and actual confirmation dialog.
  await click(first, '#tab-tasks')
  await waitFor(first, () => !document.getElementById('panel-tasks').hidden, 'tasks panel shown')
  const deleteSelector = `#task-list [data-task-id="${TASK_IDS[1]}"] [data-action="delete"]`
  try {
    await first.waitForSelector(deleteSelector, { visible: true, timeout: 15000 })
  } catch (error) {
    const diagnostic = await first.evaluate(() => ({
      hash: location.hash,
      rows: [...document.querySelectorAll('#task-list [data-task-id]')].map(row => ({ id: row.dataset.taskId, actions: [...row.querySelectorAll('[data-action]')].map(button => button.dataset.action) })),
      taskListText: document.getElementById('task-list')?.innerText,
      taskNote: document.getElementById('task-note')?.textContent
    }))
    throw new Error(`${error.message}; diagnostic=${JSON.stringify(diagnostic)}`)
  }
  await click(first, deleteSelector)
  await waitFor(first, () => document.querySelector('dialog[open] [data-action="confirm"]'), 'task deletion confirmation')
  await click(first, 'dialog[open] [data-action="confirm"]')
  await waitForSnapshot(first, state => !state.liveTaskIds.includes(TASK_IDS[1]) && !state.cards[FIRST_CARD]?.source.some(item => item.taskId === TASK_IDS[1]), 'task deleted and source pruned')
  const afterPrune = await snapshot(first)
  assert.deepEqual(afterPrune.cards[FIRST_CARD].source.map(item => item.taskId), [TASK_IDS[0]])
  assert.deepEqual(afterPrune.cards[OTHER_CARD], before.cards[OTHER_CARD], 'unrelated card unchanged after prune')
  actions.push({ action: 'delete task and confirm prune', kind: 'visible-ui', status: 'PASS' })

  // A second report page changes a distinct property after prune. Undo/redo in
  // the first page must preserve this later edit while filtering the dead task.
  const second = await browser.newPage()
  await second.goto(route)
  await second.waitForSelector(`#dashboard-grid [data-card-id="${FIRST_CARD}"] [data-action="config"]`, { visible: true, timeout: 15000 })
  await click(second, '#edit-layout')
  await waitFor(second, () => document.querySelector('#dashboard-grid.editing'), 'second report enters edit mode')
  await click(second, `#dashboard-grid [data-card-id="${FIRST_CARD}"] [data-action="config"]`)
  await waitFor(second, () => !document.getElementById('card-drawer').hidden, 'card drawer open')
  await second.locator('#drawer-title').fill('另一頁更新的標題')
  await click(second, '#drawer-apply')
  await waitForSnapshot(second, state => state.cards[FIRST_CARD]?.title === '另一頁更新的標題', 'second page title persisted')
  actions.push({ action: 'edit card title from second report page', kind: 'visible-ui', status: 'PASS' })
  await second.close()

  await first.bringToFront()
  await click(first, '#tab-dashboard')
  await waitFor(first, () => !document.getElementById('panel-dashboard').hidden, 'return to first dashboard')
  await first.keyboard.down('Control')
  await first.keyboard.press('z')
  await first.keyboard.up('Control')
  await waitForSnapshot(first, state => state.undoDepth === 0 && state.cards[FIRST_CARD]?.title === '另一頁更新的標題' && !state.cards[FIRST_CARD]?.source.some(item => item.taskId === TASK_IDS[1]), 'undo keeps title and dead source absent')
  const afterUndo = await snapshot(first)
  assert.deepEqual(afterUndo.cards[FIRST_CARD].source.map(item => item.taskId), [TASK_IDS[0]])
  assert.deepEqual(afterUndo.cards[OTHER_CARD], before.cards[OTHER_CARD], 'unrelated card unchanged after undo')
  actions.push({ action: 'undo prior drop', kind: 'keyboard-shortcut', status: 'PASS' })

  await first.keyboard.down('Control')
  await first.keyboard.down('Shift')
  await first.keyboard.press('z')
  await first.keyboard.up('Shift')
  await first.keyboard.up('Control')
  await waitForSnapshot(first, state => state.undoDepth === 1 && state.cards[FIRST_CARD]?.title === '另一頁更新的標題' && Array.isArray(state.cards[FIRST_CARD]?.source), 'redo settled')
  const afterRedo = await snapshot(first)
  assert.deepEqual(afterRedo.cards[FIRST_CARD].source.map(item => item.taskId), [TASK_IDS[0]], 'redo must not restore deleted task source')
  assert.equal(afterRedo.cards[FIRST_CARD].title, '另一頁更新的標題', 'redo must preserve second-page title')
  assert.deepEqual(afterRedo.cards[OTHER_CARD], before.cards[OTHER_CARD], 'unrelated card unchanged after redo')
  actions.push({ action: 'redo prior drop', kind: 'keyboard-shortcut', status: 'PASS' })

  const evidence = {
    source: { path: EXTENSION_PATH, manifestVersion: JSON.parse((await import('node:fs')).readFileSync(join(EXTENSION_PATH, 'manifest.json'), 'utf8')).version },
    browser: BROWSER_PATH,
    headless: process.env.AF23_HEADLESS === '1',
    elapsedMs: Date.now() - startedAt,
    actions,
    invariants: {
      droppedTaskDeleted: !afterRedo.liveTaskIds.includes(TASK_IDS[1]),
      deletedSourceAbsentAfterUndo: !afterUndo.cards[FIRST_CARD].source.some(item => item.taskId === TASK_IDS[1]),
      deletedSourceAbsentAfterRedo: !afterRedo.cards[FIRST_CARD].source.some(item => item.taskId === TASK_IDS[1]),
      secondPageTitlePreserved: afterUndo.cards[FIRST_CARD].title === '另一頁更新的標題' && afterRedo.cards[FIRST_CARD].title === '另一頁更新的標題',
      unrelatedCardPreserved: JSON.stringify(afterRedo.cards[OTHER_CARD]) === JSON.stringify(before.cards[OTHER_CARD])
    },
    status: 'PASS'
  }
  assert.ok(Object.values(evidence.invariants).every(Boolean), 'all prune undo/redo invariants must pass')
  mkdirSync(resolve(OUTPUT, '..'), { recursive: true })
  writeFileSync(OUTPUT, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  const evidence = { browser: BROWSER_PATH || null, extensionPath: EXTENSION_PATH, actions, status: 'FAIL', error: String(error?.stack || error) }
  mkdirSync(resolve(OUTPUT, '..'), { recursive: true })
  writeFileSync(OUTPUT, JSON.stringify(evidence, null, 2) + '\n')
  console.error(JSON.stringify(evidence, null, 2))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
}
