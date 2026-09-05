// 儀表板範本產生與套用模組（純函式與版面組裝）
import { findFreeSlot } from './layout.js'
import { getTasks } from '../../shared/storage.js'
import { getLayout, saveLayout, addCard } from '../../shared/layout-store.js'

/**
 * 篩選出模式為數值的任務清單
 */
function getNumberTasks(tasks) {
  if (!Array.isArray(tasks)) return []
  return tasks.filter(t => t && t.mode === 'number')
}

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

  const numTasks = getNumberTasks(tasks)

  if (kind === 'overview') {
    if (numTasks.length === 0) return []
    const specs = []
    for (const t of numTasks) {
      specs.push({
        type: 'number',
        title: t.name || '',
        w: 3,
        h: 2,
        source: [{ taskId: t.id }],
        options: {}
      })
    }
    specs.push({
      type: 'line',
      title: '趨勢總覽',
      w: 12,
      h: 3,
      source: numTasks.map(t => ({ taskId: t.id })),
      options: {}
    })
    return arrangeCards(specs)
  }

  if (kind === 'deepDive') {
    if (numTasks.length === 0) return []
    const target = numTasks[0]
    const specs = [
      {
        type: 'line',
        title: target.name || '',
        w: 9,
        h: 3,
        source: [{ taskId: target.id }],
        options: {}
      },
      {
        type: 'gauge',
        title: target.name || '',
        w: 3,
        h: 2,
        source: [{ taskId: target.id }],
        options: {}
      },
      {
        type: 'table',
        title: target.name || '',
        w: 12,
        h: 3,
        source: [{ taskId: target.id }],
        options: { mode: 'recent' }
      }
    ]
    return arrangeCards(specs)
  }

  if (kind === 'compare') {
    const specs = [
      {
        type: 'line',
        title: '比較趨勢',
        w: 12,
        h: 3,
        source: numTasks.map(t => ({ taskId: t.id })),
        options: {}
      },
      {
        type: 'table',
        title: '比較明細',
        w: 12,
        h: 3,
        source: tasks.map(t => ({ taskId: t.id })),
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
  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === dashId)
  if (!dash) return

  dash.cards = []
  await saveLayout(layout)

  for (const card of templateCards) {
    await addCard(dashId, card)
  }
}
