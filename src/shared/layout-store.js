// 儀表板與卡片版面儲存層（layout-store）
import { getRawLayout, setRawLayout } from './storage.js'
import { clampCard, findFreeSlot } from '../ui/report/layout.js'

// 目前支援的版面架構版本
const CURRENT_VERSION = 1

// 卡片型別對應的預設寬度（與 layout.js 的 autoArrange 寬度表保持一致）
const DEFAULT_CARD_WIDTHS = {
  number: 3,
  gauge: 3,
  status: 4,
  line: 6,
  bar: 6,
  text: 6,
  table: 12
}

// 預設儀表板的穩定 id（未存入 storage 前維持同一個 id）
const DEFAULT_DASHBOARD_ID = '00000000-0000-4000-8000-000000000001'

function getDefaultDashboardId() {
  return DEFAULT_DASHBOARD_ID
}

/**
 * 卡片欄位正規化：補齊 id、type、x、y、w、h、source、options
 */
function normalizeCard(card) {
  const type = (typeof card?.type === 'string' && card.type) ? card.type : 'number'
  return {
    ...card,
    id: (typeof card?.id === 'string' && card.id) ? card.id : crypto.randomUUID(),
    type,
    x: typeof card?.x === 'number' ? card.x : 0,
    y: typeof card?.y === 'number' ? card.y : 0,
    w: typeof card?.w === 'number' ? card.w : (DEFAULT_CARD_WIDTHS[type] ?? 6),
    h: typeof card?.h === 'number' ? card.h : 2,
    source: Array.isArray(card?.source) ? card.source : [],
    options: (card?.options && typeof card.options === 'object' && !Array.isArray(card.options))
      ? { ...card.options }
      : {}
  }
}

/**
 * 版面物件正規化（純記憶體操作，不寫回 storage）
 */
function normalizeLayout(raw) {
  // 整份資料不是物件或缺 dashboards（例如是字串）時，退回預設版面
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.dashboards)) {
    return {
      version: CURRENT_VERSION,
      dashboards: [{
        id: getDefaultDashboardId(),
        name: '預設',
        cards: []
      }]
    }
  }

  const result = { ...raw }

  // 版本判定：大於目前版本時照讀不丟棄，並標記 newerVersion
  if (typeof raw.version === 'number' && raw.version > CURRENT_VERSION) {
    result.version = raw.version
    result.newerVersion = true
  } else {
    result.version = CURRENT_VERSION
    delete result.newerVersion
  }

  // dashboards 不是陣列或為空時，建立一個預設儀表板
  if (raw.dashboards.length === 0) {
    result.dashboards = [{
      id: getDefaultDashboardId(),
      name: '預設',
      cards: []
    }]
  } else {
    result.dashboards = raw.dashboards.map((d, index) => {
      if (!d || typeof d !== 'object') {
        return {
          id: crypto.randomUUID(),
          name: `儀表板 ${index + 1}`,
          cards: []
        }
      }
      const id = (typeof d.id === 'string' && d.id) ? d.id : crypto.randomUUID()
      const name = (typeof d.name === 'string' && d.name.trim() !== '') ? d.name : `儀表板 ${index + 1}`
      const rawCards = Array.isArray(d.cards) ? d.cards : []
      const cards = rawCards.map(normalizeCard)
      return {
        ...d,
        id,
        name,
        cards
      }
    })
  }

  return result
}

/**
 * 讀取並正規化版面資料（不寫回 storage）
 */
export async function getLayout() {
  const raw = await getRawLayout()
  return normalizeLayout(raw)
}

/**
 * 儲存版面資料至 storage（寫入前移除 newerVersion 等暫時性旗標）
 */
export async function saveLayout(layout) {
  const toSave = structuredClone(layout)
  delete toSave.newerVersion
  await setRawLayout(toSave)
}

/**
 * 新增儀表板，回傳新增的儀表板物件
 */
export async function addDashboard(name) {
  const layout = await getLayout()
  const newDash = {
    id: crypto.randomUUID(),
    name: (typeof name === 'string' && name.trim() !== '') ? name : `儀表板 ${layout.dashboards.length + 1}`,
    cards: []
  }
  layout.dashboards.push(newDash)
  await saveLayout(layout)
  return newDash
}

/**
 * 重新命名儀表板
 */
export async function renameDashboard(id, name) {
  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === id)
  if (!dash) return
  dash.name = name
  await saveLayout(layout)
}

/**
 * 刪除儀表板（若刪後儀表板為空，自動補一個空的預設儀表板）
 */
export async function deleteDashboard(id) {
  const layout = await getLayout()
  const index = layout.dashboards.findIndex(d => d.id === id)
  if (index === -1) return

  layout.dashboards.splice(index, 1)
  if (layout.dashboards.length === 0) {
    layout.dashboards.push({
      id: crypto.randomUUID(),
      name: '預設',
      cards: []
    })
  }
  if (layout.lastDashboardId === id) {
    delete layout.lastDashboardId
  }
  await saveLayout(layout)
}

/**
 * 複製儀表板，卡片內容保留但每張卡片重新配置 id
 */
export async function duplicateDashboard(id) {
  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === id)
  if (!dash) return null

  const dup = {
    id: crypto.randomUUID(),
    name: `${dash.name || '儀表板'} (副本)`,
    cards: dash.cards.map(c => ({
      ...structuredClone(c),
      id: crypto.randomUUID()
    }))
  }
  layout.dashboards.push(dup)
  await saveLayout(layout)
  return dup
}

/**
 * 依照給定 id 順序排列儀表板，未列到的保留原本相對順序排在後方
 */
export async function reorderDashboards(ids) {
  if (!Array.isArray(ids)) return
  const layout = await getLayout()
  const map = new Map(layout.dashboards.map(d => [d.id, d]))
  const ordered = []
  const seen = new Set()
  for (const id of ids) {
    if (map.has(id) && !seen.has(id)) {
      ordered.push(map.get(id))
      seen.add(id)
    }
  }
  for (const d of layout.dashboards) {
    if (!seen.has(d.id)) {
      ordered.push(d)
      seen.add(d.id)
    }
  }
  layout.dashboards = ordered
  await saveLayout(layout)
}

/**
 * 設定最後開啟的儀表板 id
 */
export async function setLastDashboard(id) {
  const layout = await getLayout()
  layout.lastDashboardId = id
  await saveLayout(layout)
}

/**
 * 新增卡片至指定儀表板，自動配置 id、夾住寬高並尋找不重疊空位
 */
export async function addCard(dashId, card) {
  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === dashId)
  if (!dash) return null

  const normalized = normalizeCard(card)
  const newCard = {
    ...normalized,
    id: crypto.randomUUID()
  }
  const clamped = clampCard(newCard)
  const slot = findFreeSlot(dash.cards, clamped.w, clamped.h)
  clamped.x = slot.x
  clamped.y = slot.y

  dash.cards.push(clamped)
  await saveLayout(layout)
  return clamped
}

/**
 * 淺層更新指定卡片（未提供的欄位保留，id 不可被竄改）
 */
export async function updateCard(dashId, cardId, patch) {
  if (!patch || typeof patch !== 'object') return
  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === dashId)
  if (!dash) return
  const card = dash.cards.find(c => c.id === cardId)
  if (!card) return

  Object.assign(card, patch, { id: cardId })
  await saveLayout(layout)
}

/**
 * 移除指定卡片
 */
export async function removeCard(dashId, cardId) {
  const layout = await getLayout()
  const dash = layout.dashboards.find(d => d.id === dashId)
  if (!dash) return
  const cardIndex = dash.cards.findIndex(c => c.id === cardId)
  if (cardIndex === -1) return

  dash.cards.splice(cardIndex, 1)
  await saveLayout(layout)
}

/**
 * 任務刪除連動：移除包含該任務的卡片來源或篩選，若來源或篩選因此歸零且原先有指定則刪除該卡片
 */
export async function pruneCardsForTask(taskId) {
  const layout = await getLayout()
  for (const dash of layout.dashboards) {
    dash.cards = dash.cards.filter(card => {
      // 處理 source
      const hadSource = Array.isArray(card.source) && card.source.length > 0
      if (hadSource) {
        card.source = card.source.filter(s => s.taskId !== taskId)
        if (card.source.length === 0) {
          return false
        }
      }

      // 處理 status 卡片的 options.taskIds
      if (card.options && Array.isArray(card.options.taskIds)) {
        const hadTaskIds = card.options.taskIds.length > 0
        if (hadTaskIds) {
          card.options.taskIds = card.options.taskIds.filter(id => id !== taskId)
          if (card.options.taskIds.length === 0) {
            return false
          }
        }
      }

      return true
    })
  }
  await saveLayout(layout)
}
