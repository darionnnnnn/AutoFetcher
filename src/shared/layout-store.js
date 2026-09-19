// 儀表板與卡片版面儲存層（layout-store）
import { getRawLayout, updateLayout } from './storage.js'
import { clampCard, findFreeSlot, collides } from '../ui/report/layout.js'
import { parentIdOf } from './series-index.js'

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
  const toSave = stripTransient(layout)
  await updateLayout(() => toSave)
}

// 寫入前移除暫時性旗標（newerVersion 只給讀的人看，不落地）
function stripTransient(layout) {
  const toSave = structuredClone(layout)
  delete toSave.newerVersion
  return toSave
}

// editLayout 的「這次不寫」標記（例如找不到目標）；用 Symbol 鍵才不會和卡片欄位撞名
const UNCHANGED = Symbol('unchanged')
const unchanged = (value) => ({ [UNCHANGED]: true, value })

/**
 * 版面的讀-改-寫一律在 layout 鎖內：對鎖內讀到的原始值正規化後交給 edit 就地改。
 * edit 回傳 unchanged(值) 表示這次不寫；回傳值（或 unchanged 帶的值）交還呼叫端。
 */
async function editLayout(edit) {
  let result
  await updateLayout((raw) => {
    const layout = normalizeLayout(raw)
    result = edit(layout)
    if (result && result[UNCHANGED]) return undefined
    return stripTransient(layout)
  })
  return result && result[UNCHANGED] ? result.value : result
}

/**
 * 新增儀表板，回傳新增的儀表板物件
 */
export async function addDashboard(name) {
  return editLayout((layout) => {
    const newDash = {
      id: crypto.randomUUID(),
      name: (typeof name === 'string' && name.trim() !== '') ? name : `儀表板 ${layout.dashboards.length + 1}`,
      cards: []
    }
    layout.dashboards.push(newDash)
    return newDash
  })
}

/**
 * 重新命名儀表板
 */
export async function renameDashboard(id, name) {
  // 空白名稱一律忽略(存進去會讓頁籤變成看不見的空標籤,只能靠下次正規化補回)
  if (typeof name !== 'string') return
  const trimmed = name.trim()
  if (trimmed === '') return
  await editLayout((layout) => {
    const dash = layout.dashboards.find(d => d.id === id)
    if (!dash) return unchanged()
    dash.name = trimmed
  })
}

/**
 * 刪除儀表板（若刪後儀表板為空，自動補一個空的預設儀表板）
 */
export async function deleteDashboard(id) {
  await editLayout((layout) => {
    const index = layout.dashboards.findIndex(d => d.id === id)
    if (index === -1) return unchanged()

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
  })
}

/**
 * 複製儀表板，卡片內容保留但每張卡片重新配置 id
 */
export async function duplicateDashboard(id) {
  return editLayout((layout) => {
    const dash = layout.dashboards.find(d => d.id === id)
    if (!dash) return unchanged(null)

    const dup = {
      id: crypto.randomUUID(),
      name: `${dash.name || '儀表板'} (副本)`,
      cards: dash.cards.map(c => ({
        ...structuredClone(c),
        id: crypto.randomUUID()
      }))
    }
    layout.dashboards.push(dup)
    return dup
  })
}

/**
 * 依照給定 id 順序排列儀表板，未列到的保留原本相對順序排在後方
 */
export async function reorderDashboards(ids) {
  if (!Array.isArray(ids)) return
  await editLayout((layout) => {
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
  })
}

/**
 * 設定最後開啟的儀表板 id
 */
export async function setLastDashboard(id) {
  await editLayout((layout) => {
    layout.lastDashboardId = id
  })
}

/**
 * 指定位置是否沒有和既有卡片重疊(重疊判定只有一份,在 layout.js)
 */
function isFreeAt(cards, card) {
  if (!Array.isArray(cards)) return true
  return !cards.some(c => c && collides(card, c))
}

/**
 * 檢查兩張卡片的來源任務集合是否相同（順序無關，只比對 taskId）
 */
function sameSourceTaskIds(sourceA, sourceB) {
  const setA = new Set()
  for (const s of sourceA) {
    if (s && s.taskId != null) setA.add(String(s.taskId))
  }
  const setB = new Set()
  for (const s of sourceB) {
    if (s && s.taskId != null) setB.add(String(s.taskId))
  }
  if (setA.size !== setB.size) return false
  for (const id of setA) {
    if (!setB.has(id)) return false
  }
  return true
}

/**
 * 新增卡片至指定儀表板，自動配置 id、夾住寬高並尋找不重疊空位
 */
export async function addCard(dashId, card) {
  return editLayout((layout) => {
    const dash = layout.dashboards.find(d => d.id === dashId)
    if (!dash) return unchanged(null)

    const normalized = normalizeCard(card)

    // 檢查同儀表板內是否已存在型別相同、來源集合相同的卡片
    // source 為空陣列或缺少的卡片（例如文字卡）一律不去重
    if (Array.isArray(card?.source) && card.source.length > 0) {
      const existing = dash.cards.find(c =>
        c &&
        c.type === normalized.type &&
        Array.isArray(c.source) &&
        c.source.length > 0 &&
        // 樞紐表與「最近 N 筆」型別同樣是 table，但呈現的是兩件事，不能互相去重
        (c.options?.mode || '') === (normalized.options?.mode || '') &&
        sameSourceTaskIds(normalized.source, c.source)
      )
      if (existing) {
        return unchanged(existing)
      }
    }

    const newCard = {
      ...normalized,
      id: crypto.randomUUID()
    }
    const clamped = clampCard(newCard)
    // 指定的位置若是空的就尊重它(拖曳建卡要落在使用者放開的地方);
    // 重疊或超出邊界才自己找空位
    if (!isFreeAt(dash.cards, clamped)) {
      const slot = findFreeSlot(dash.cards, clamped.w, clamped.h)
      clamped.x = slot.x
      clamped.y = slot.y
    }

    dash.cards.push(clamped)
    return clamped
  })
}

/**
 * 淺層更新指定卡片（未提供的欄位保留，id 不可被竄改）
 */
export async function updateCard(dashId, cardId, patch) {
  if (!patch || typeof patch !== 'object') return
  await editLayout((layout) => {
    const dash = layout.dashboards.find(d => d.id === dashId)
    if (!dash) return unchanged()
    const card = dash.cards.find(c => c.id === cardId)
    if (!card) return unchanged()

    Object.assign(card, patch, { id: cardId })
  })
}

/**
 * 移除指定卡片
 */
export async function removeCard(dashId, cardId) {
  await editLayout((layout) => {
    const dash = layout.dashboards.find(d => d.id === dashId)
    if (!dash) return unchanged()
    const cardIndex = dash.cards.findIndex(c => c.id === cardId)
    if (cardIndex === -1) return unchanged()

    dash.cards.splice(cardIndex, 1)
  })
}

const GEOMETRY_KEYS = ['x', 'y', 'w', 'h']

/**
 * 只改卡片位置與大小（拖曳移動／縮放放開、自動排列）：在 layout 鎖內讀最新版面，
 * arrange(最新卡片的副本) 回傳排好的卡片陣列，只取回**仍存在**的卡片的 x/y/w/h 套上去；
 * 來源、選項、卡片增刪一律不動（背景同時修剪掉的來源與卡片不會被舊副本蓋回）。
 * 回傳是否有寫入。
 */
export async function arrangeCards(dashId, arrange) {
  return editLayout((layout) => {
    const dash = layout.dashboards.find(d => d.id === dashId)
    if (!dash) return unchanged(false)
    const arranged = arrange(structuredClone(dash.cards))
    if (!Array.isArray(arranged)) return unchanged(false)
    const geo = new Map(arranged.filter(c => c && typeof c.id === 'string').map(c => [c.id, c]))
    let changed = false
    for (const card of dash.cards) {
      const next = geo.get(card.id)
      if (!next) continue
      for (const k of GEOMETRY_KEYS) {
        if (typeof next[k] === 'number' && next[k] !== card[k]) {
          card[k] = next[k]
          changed = true
        }
      }
    }
    return changed ? true : unchanged(false)
  })
}

// 復原／重做：只把「from → to 這一步」的差異套到最新版面上。
// 卡片：to 有 from 沒有＝這一步加的（重做時補回，來源要全都還在才補）；from 有 to 沒有＝這一步拿掉的（從最新版面移除）；
// 兩邊都有：只改這一步動過的欄位，而且卡片要還在最新版面上（背景刪掉的卡片不復活）。
// 來源：from 就有、最新版面卻沒有的＝別人（背景修剪）拿掉的，不放回；這一步自己加回的也要序列還在（isLive）。
function sourceIdsOf(card) {
  return new Set((Array.isArray(card?.source) ? card.source : []).map(s => s?.taskId))
}

function restoredSource(toList, fromCard, latestCard, isLive) {
  const inFrom = sourceIdsOf(fromCard)
  const inLatest = sourceIdsOf(latestCard)
  return (Array.isArray(toList) ? toList : []).filter(s => {
    const id = s?.taskId
    if (inFrom.has(id)) return inLatest.has(id)
    return isLive(id)
  })
}

function restoredStatusIds(toIds, fromCard, latestCard, isLive) {
  const inFrom = new Set(Array.isArray(fromCard?.options?.taskIds) ? fromCard.options.taskIds : [])
  const inLatest = new Set(Array.isArray(latestCard?.options?.taskIds) ? latestCard.options.taskIds : [])
  return toIds.filter(id => inFrom.has(id) ? inLatest.has(id) : isLive(id))
}

function applyCardStep(latestCard, fromCard, toCard, isLive) {
  for (const k of GEOMETRY_KEYS) {
    if (fromCard[k] !== toCard[k]) latestCard[k] = toCard[k]
  }
  if (JSON.stringify(fromCard.source) !== JSON.stringify(toCard.source)) {
    latestCard.source = restoredSource(toCard.source, fromCard, latestCard, isLive)
  }
  if (JSON.stringify(fromCard.options) !== JSON.stringify(toCard.options)) {
    const options = structuredClone(toCard.options || {})
    if (Array.isArray(options.taskIds)) options.taskIds = restoredStatusIds(options.taskIds, fromCard, latestCard, isLive)
    latestCard.options = options
  }
}

/**
 * 復原／重做的唯一寫入（AF-21 終檢）：from、to 是這一步前後的 dashboards 快照，
 * 在 layout 鎖內以最新版面為底只套這一步的差異。isLive(序列 id) 判定序列是否還在任務清單裡。
 */
export async function applyLayoutStep(from, to, isLive = () => true) {
  const fromDashes = new Map((Array.isArray(from) ? from : []).map(d => [d?.id, d]))
  const toDashes = new Map((Array.isArray(to) ? to : []).map(d => [d?.id, d]))
  return editLayout((layout) => {
    let changed = false
    for (const dash of layout.dashboards) {
      const f = fromDashes.get(dash.id)
      const t = toDashes.get(dash.id)
      if (!f || !t) continue
      const fCards = new Map((f.cards || []).map(c => [c.id, c]))
      const tCards = new Map((t.cards || []).map(c => [c.id, c]))
      const before = JSON.stringify(dash.cards)
      // 這一步拿掉的卡片
      dash.cards = dash.cards.filter(c => !(fCards.has(c.id) && !tCards.has(c.id)))
      for (const card of dash.cards) {
        const fc = fCards.get(card.id)
        const tc = tCards.get(card.id)
        if (fc && tc) applyCardStep(card, fc, tc, isLive)
      }
      // 這一步加的卡片（重做建卡）：最新版面還沒有、來源都還在才補回
      for (const tc of t.cards || []) {
        if (fCards.has(tc.id) || dash.cards.some(c => c.id === tc.id)) continue
        const src = Array.isArray(tc.source) ? tc.source : []
        if (!src.every(s => isLive(s?.taskId))) continue
        dash.cards.push(structuredClone(tc))
      }
      if (JSON.stringify(dash.cards) !== before) changed = true
    }
    return changed ? true : unchanged(false)
  })
}

// 內部輔助函式：清理所有儀表板中的卡片來源與篩選，若來源歸零則移除該卡片
function pruneCardsInLayout(layout, shouldRemoveSource, shouldRemoveStatusId) {
  for (const dash of layout.dashboards) {
    dash.cards = dash.cards.filter(card => {
      // 處理 source
      const hadSource = Array.isArray(card.source) && card.source.length > 0
      if (hadSource) {
        card.source = card.source.filter(s => !shouldRemoveSource(s))
        if (card.source.length === 0) {
          return false
        }
      }

      // 處理 status 卡片的 options.taskIds
      if (card.options && Array.isArray(card.options.taskIds)) {
        const hadTaskIds = card.options.taskIds.length > 0
        if (hadTaskIds) {
          card.options.taskIds = card.options.taskIds.filter(id => !shouldRemoveStatusId(id))
          if (card.options.taskIds.length === 0) {
            return false
          }
        }
      }

      return true
    })
  }
}

/**
 * 任務刪除連動：移除包含該任務的卡片來源或篩選，若來源或篩選因此歸零且原先有指定則刪除該卡片
 */
export async function pruneCardsForTask(taskId) {
  await editLayout((layout) => {
    pruneCardsInLayout(
      layout,
      s => parentIdOf(s.taskId) === taskId,
      id => parentIdOf(id) === taskId
    )
  })
}

// 序列刪除連動：移除包含指定完整序列 id 的卡片來源或篩選，若歸零則刪除該卡片
export async function pruneSeries(seriesIds) {
  if (!Array.isArray(seriesIds) || seriesIds.length === 0) return
  const idSet = new Set(seriesIds)
  await editLayout((layout) => {
    pruneCardsInLayout(
      layout,
      s => idSet.has(s.taskId),
      id => idSet.has(id)
    )
  })
}
