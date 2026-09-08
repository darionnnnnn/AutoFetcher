// AF-9 作業 B：白話描述函式（shared/describe.js）唯一一份
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeWeekdays,
  describeSchedule,
  describeTarget,
  describeDashboard
} from '../src/shared/describe.js'

test('B1-1 星期：全勾、缺省、空陣列都是每天', () => {
  assert.equal(describeWeekdays([0, 1, 2, 3, 4, 5, 6]), '每天')
  assert.equal(describeWeekdays(undefined), '每天')
  assert.equal(describeWeekdays([]), '每天')
})

test('B1-2 星期：連續三天以上縮寫成區間', () => {
  assert.equal(describeWeekdays([1, 2, 3, 4, 5]), '週一～五')
  assert.equal(describeWeekdays([1, 2, 3]), '週一～三')
})

test('B1-3 星期：兩天或不連續就逐一列出，且以週一為起點排序', () => {
  assert.equal(describeWeekdays([0, 6]), '週六、週日')
  assert.equal(describeWeekdays([1, 3, 5]), '週一、週三、週五')
})

test('B2-1 daily 句型', () => {
  assert.equal(
    describeSchedule({ type: 'daily', times: ['09:30', '15:00'], weekdays: [1, 2, 3, 4, 5] }),
    '每日 09:30、15:00，週一～五'
  )
})

test('B2-2 interval 有時段的句型（回饋 4 的情境）', () => {
  assert.equal(
    describeSchedule({
      type: 'interval',
      everyMinutes: 10,
      window: { from: '08:30', to: '09:20' },
      weekdays: [1, 2, 3, 4, 5]
    }),
    '08:30～09:20 之間每 10 分鐘，週一～五'
  )
})

test('B2-3 interval 無時段、weekdays 空陣列＝每天', () => {
  assert.equal(
    describeSchedule({ type: 'interval', everyMinutes: 10, weekdays: [] }),
    '每 10 分鐘，每天'
  )
})

test('B2-4 未排程：缺 schedule、未知型別、缺必要值', () => {
  assert.equal(describeSchedule(null), '未排程')
  assert.equal(describeSchedule({ type: 'cron' }), '未排程')
  assert.equal(describeSchedule({ type: 'daily', times: [] }), '未排程')
  assert.equal(describeSchedule({ type: 'interval', everyMinutes: 0 }), '未排程')
})

test('B3-1 目標：單格取列 · 欄標題，網址只留主機名', () => {
  assert.equal(
    describeTarget({
      url: 'https://www.twse.com.tw/zh/trading/historical/x.html?a=1',
      mode: 'block',
      cell: { row: { header: '115/09/07' }, col: { header: '成交金額' } }
    }),
    '抓 www.twse.com.tw 的表格，取「115/09/07 · 成交金額」這一格'
  )
})

test('B3-2 目標：整欄聚合帶聚合方式', () => {
  assert.equal(
    describeTarget({
      url: 'https://a.example/c',
      mode: 'block',
      block: { axis: 'col', headerText: '成交金額', aggregate: 'sum' }
    }),
    '抓 a.example 的表格，取「成交金額」整欄的加總'
  )
})

test('B3-3 目標：多值講個數，位置定位另外附註', () => {
  assert.equal(
    describeTarget({ url: 'https://a.example/c', mode: 'block', fieldCount: 3, rowPos: 'last' }),
    '抓 a.example 的表格，取 3 個值，列取最後一筆'
  )
})

test('B3-4 目標：非表格講型別', () => {
  assert.equal(describeTarget({ url: 'https://a.example/c', mode: 'number' }), '抓 a.example 頁面上的數字')
  assert.equal(describeTarget({ url: 'https://a.example/c', mode: 'text' }), '抓 a.example 頁面上的文字')
})

test('B3-5 目標：網址不合法或空的時候不炸', () => {
  assert.equal(describeTarget({ url: '', mode: 'number' }), '抓 頁面上的數字')
  assert.equal(describeTarget({}), '抓 頁面上的數字')
})

test('B4 儀表板去處', () => {
  assert.equal(describeDashboard('預設儀表板', ['number', 'line']), '加入「預設儀表板」的數字、折線卡')
  assert.equal(describeDashboard('', ['number']), '不加入儀表板')
  assert.equal(describeDashboard('預設儀表板', []), '加入「預設儀表板」，尚未選卡片型別')
})
