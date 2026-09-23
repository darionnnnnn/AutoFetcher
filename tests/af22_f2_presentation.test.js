import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { installChromeMock, resetChromeMock } from './chrome-mock.js'

const reportHtml = readFileSync(new URL('../src/ui/report/report.html', import.meta.url), 'utf8')
const popupHtml = readFileSync(new URL('../src/ui/popup/popup.html', import.meta.url), 'utf8')

function mixedTask() {
  return {
    id: 'mixed-1',
    name: '跨來源價格',
    url: 'https://a.test/prices',
    mode: 'multi',
    enabled: true,
    fields: [
      { key: 'price', name: '現價' },
      { key: 'label', name: '名稱' }
    ],
    spec: {
      mode: 'multi',
      fields: [
        { key: 'price', name: '現價', mode: 'number', source: { locator: { css: '#price' } }, spec: { strategy: 'auto' } },
        { key: 'label', name: '名稱', mode: 'text', source: { locator: { css: '#label' }, frame: { url: 'https://b.test/embed' } }, spec: { mode: 'text' } }
      ]
    },
    schedule: { type: 'daily', times: ['09:00'] }
  }
}

test('F2 multi 白話描述顯示群組、數字／文字與來源，不露模式代碼', async () => {
  const { describeTarget, targetOfTask } = await import('../src/shared/describe.js?f2=' + Math.random())
  const text = describeTarget(targetOfTask(mixedTask()))
  assert.match(text, /群組「跨來源價格」/)
  assert.match(text, /現價（數字，頁面）/)
  assert.match(text, /名稱（文字，內嵌框架（b\.test））/)
  assert.doesNotMatch(text, /\bmulti\b/)
})

test('F2 任務頁與 popup 都顯示 multi 的群組與來源摘要', async () => {
  resetChromeMock()
  installChromeMock()
  const task = mixedTask()
  const values = {
    'mixed-1#price': { value: 1234 },
    'mixed-1#label': { value: '001' }
  }

  const report = new JSDOM(reportHtml, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = report.window
  globalThis.document = report.window.document
  const tasks = await import('../src/ui/report/tasks.js?f2=' + Math.random())
  tasks.renderTasks([task], {}, [], { lastValues: values })
  const reportText = report.window.document.querySelector('#task-list .task-row').textContent
  assert.match(reportText, /群組「跨來源價格」/)
  assert.match(reportText, /數字/)
  assert.match(reportText, /文字/)
  assert.match(reportText, /內嵌框架（b\.test）/)
  assert.doesNotMatch(reportText, /\bmulti\b/)

  const popup = new JSDOM(popupHtml)
  globalThis.window = popup.window
  globalThis.document = popup.window.document
  const popupModule = await import('../src/ui/popup/popup.js?f2=' + Math.random())
  popupModule.render({
    health: { level: 'green', summary: '' },
    tasks: [task],
    lastValues: values,
    nextRuns: {},
    healthMap: {}
  })
  const popupText = popup.window.document.querySelector('#task-list .task-row').textContent
  assert.match(popupText, /群組：跨來源價格/)
  assert.match(popupText, /數字/)
  assert.match(popupText, /文字/)
  assert.match(popupText, /內嵌框架（b\.test）/)
  assert.match(popupText, /001/, '文字值 001 必須保留字串，不得格式化成數字')
  assert.doesNotMatch(popupText, /\bmulti\b/)
})

test('F2 編輯後 task.fields 名稱優先於 spec 快照，任務頁與 popup 都顯示新名', async () => {
  resetChromeMock()
  installChromeMock()
  const task = mixedTask()
  task.fields = [
    { key: 'price', name: '最新現價' },
    { key: 'label', name: '最新名稱' }
  ]

  const targetModule = await import('../src/shared/describe.js?f2-rename=' + Math.random())
  const summary = targetModule.describeTarget(targetModule.targetOfTask(task))
  assert.match(summary, /最新現價/)
  assert.match(summary, /最新名稱/)
  assert.doesNotMatch(summary, /(?:：|、)現價（/)
  assert.doesNotMatch(summary, /(?:：|、)名稱（/)

  const report = new JSDOM(reportHtml, { url: 'chrome-extension://abc/ui/report/report.html' })
  globalThis.window = report.window
  globalThis.document = report.window.document
  const tasks = await import('../src/ui/report/tasks.js?f2-rename=' + Math.random())
  tasks.renderTasks([task], {}, [])
  const reportText = report.window.document.querySelector('#task-list .task-row').textContent
  assert.match(reportText, /最新現價/)
  assert.match(reportText, /最新名稱/)

  const popup = new JSDOM(popupHtml)
  globalThis.window = popup.window
  globalThis.document = popup.window.document
  const popupModule = await import('../src/ui/popup/popup.js?f2-rename=' + Math.random())
  popupModule.render({ health: { level: 'green', summary: '' }, tasks: [task], lastValues: {}, nextRuns: {}, healthMap: {} })
  const popupText = popup.window.document.querySelector('#task-list .task-row').textContent
  assert.match(popupText, /最新現價/)
  assert.match(popupText, /最新名稱/)
})
