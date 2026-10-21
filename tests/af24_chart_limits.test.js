// AF-24 E4：圖表序列上限與調色盤各只有一份
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { exceedsSeriesLimit, MAX_CHART_SERIES } from '../src/ui/report/drop-rules.js'
import { CHART_PALETTE_SIZE } from '../src/ui/report/charts.js'

const read = p => readFileSync(new URL(`../src/ui/report/${p}`, import.meta.url), 'utf8')

test('exceedsSeriesLimit：剛好到上限不算超過、多一條算、沒有要加的不算', () => {
  const src = n => Array.from({ length: n }, (_, i) => ({ taskId: `t${i}` }))
  assert.equal(exceedsSeriesLimit(src(MAX_CHART_SERIES - 1), ['x']), false)
  assert.equal(exceedsSeriesLimit(src(MAX_CHART_SERIES), ['x']), true)
  assert.equal(exceedsSeriesLimit(src(MAX_CHART_SERIES + 2), []), false)
  assert.equal(exceedsSeriesLimit(undefined, ['x']), false)
})

test('上限數字與調色盤循環只寫在 drop-rules／charts', () => {
  assert.equal(MAX_CHART_SERIES, CHART_PALETTE_SIZE, '序列上限就是調色盤大小，同一個常數')
  for (const f of ['dashboard.js', 'trend-popover.js', 'cards.js', 'charts.js']) {
    const s = read(f)
    assert.equal(/% 8\b/.test(s), false, `${f} 不得自己算調色盤`)
    assert.equal(/(> 8|slice\(0, 8\)|上限 8)/.test(s), false, `${f} 不得寫死 8`)
  }
  assert.ok(/export function getChartColor/.test(read('charts.js')))
})
