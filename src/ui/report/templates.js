import { findFreeSlot } from './layout.js'
import { getTasks } from '../../shared/storage.js'
import { getLayout, saveLayout, addCard } from '../../shared/layout-store.js'
import { buildSeriesIndex } from '../../shared/series-index.js'

/**
 * 將卡片規格陣列依序排入無重疊的合法格線座標
 */
function arrangeCards(cardSpecs) {
  const result = []
  for (const spec of cardSpecs) {
    const slot = findFreeSlot(result, spec.w, spec.h)
    result.push({
      ...spec,
      x: slot.x,
      y: slot.y
    })
  }
  return result
}

/**
 * 依範本種類與任務清單建立卡片結構（純函式，不含 id）
 */
export function buildTemplate(kind, tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return []

  const index = buildSeriesIndex(tasks)
  const numericSeriesIds = index.seriesIds.filter(sid => index.byId[sid]?.mode !== 'text')
  const allSeriesIds = index.seriesIds

  if (kind === 'overview') {
    if (numericSeriesIds.length === 0) return []
    const specs = []
    for (const sid of numericSeriesIds) {
      specs.push({
        type: 'number',
        title: '',
        w: 3,
        h: 2,
        source: [{ taskId: sid }],
        options: {}
      })
    }
    specs.push({
      type: 'line',
      title: '',
      w: 12,
      h: 3,
      source: numericSeriesIds.map(sid => ({ taskId: sid })),
      options: {}
    })
    return arrangeCards(specs)
  }

  if (kind === 'deepDive') {
    if (numericSeriesIds.length === 0) return []
    const targetId = numericSeriesIds[0]
    const specs = [
      {
        type: 'line',
        title: '',
        w: 9,
        h: 3,
        source: [{ taskId: targetId }],
        options: {}
      },
      {
        type: 'gauge',
        title: '',
        w: 3,
        h: 2,
        source: [{ taskId: targetId }],
        options: {}
      },
      {
        type: 'table',
        title: '',
        w: 12,
        h: 3,
        source: [{ taskId: targetId }],
        options: { mode: 'recent' }
      }
    ]
    return arrangeCards(specs)
  }

  if (kind === 'compare') {
    if (numericSeriesIds.length === 0) return []
    const specs = [
      {
        type: 'line',
        title: '',
        w: 12,
        h: 3,
        source: numericSeriesIds.map(sid => ({ taskId: sid })),
        options: {}
      },
      {
        type: 'table',
        title: '',
        w: 12,
        h: 3,
        source: allSeriesIds.map(sid => ({ taskId: sid })),
        options: { mode: 'pivot' }
      }
    ]
    return arrangeCards(specs)
  }

  return []
}

/**
 * 將範本卡片套用至指定儀表板（取代現有所有卡片）
 */
export async function applyTemplate(dashId, kind) {
  const tasks = await getTasks()
  const templateCards = buildTemplate(kind, tasks)
  if (!Array.isArray(templateCards) || templateCards.length === 0) {
    return
  }

  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === dashId)
  if (!dash) return

  dash.cards = []
  await saveLayout(layout)

  for (const card of templateCards) {
    await addCard(dashId, card)
  }
}
