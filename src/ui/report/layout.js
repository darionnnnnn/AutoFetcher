// 儀表板格線數學（純函式，不碰 DOM 也不碰 chrome）
export const COLS = 12
export const MAX_H = 6

const DEFAULT_WIDTHS = {
  number: 3,
  gauge: 3,
  status: 4,
  line: 6,
  bar: 6,
  text: 6,
  table: 12
}

/**
 * 限制卡片寬高與座標在合法格線範圍內
 */
export function clampCard(card) {
  const w = Math.min(COLS, Math.max(1, card.w ?? 1))
  const h = Math.min(MAX_H, Math.max(1, card.h ?? 1))
  let x = Math.max(0, card.x ?? 0)
  const y = Math.max(0, card.y ?? 0)
  if (x + w > COLS) {
    x = Math.max(0, COLS - w)
  }
  return { ...card, x, y, w, h }
}

/**
 * 判斷兩張卡片是否重疊（相鄰不算重疊，同 id 一律回傳 false）
 */
export function collides(a, b) {
  if (a.id !== undefined && b.id !== undefined && a.id === b.id) {
    return false
  }
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  )
}

/**
 * 消除垂直空隙，所有卡片盡量往上移到不重疊為止
 */
export function compact(cards) {
  if (!cards || cards.length === 0) return []
  const result = cards.map(c => ({ ...c }))
  const indices = result.map((_, i) => i)
  indices.sort((i1, i2) => {
    const c1 = result[i1]
    const c2 = result[i2]
    if (c1.y !== c2.y) return c1.y - c2.y
    return c1.x - c2.x
  })
  const placed = []
  for (const idx of indices) {
    const card = result[idx]
    let y = 0
    while (placed.some(p => collides({ ...card, y }, p))) {
      y++
    }
    card.y = y
    placed.push(card)
  }
  return result
}

/**
 * 放置或移動卡片，連鎖將被壓到的卡片往下推
 */
export function placeCard(cards, card) {
  const target = clampCard(card)
  const exists = cards.some(c => c.id === target.id)
  let list
  if (exists) {
    list = cards.map(c => (c.id === target.id ? target : { ...c, _origY: c.y }))
  } else {
    list = [...cards.map(c => ({ ...c, _origY: c.y })), target]
  }

  const queue = [target]
  while (queue.length > 0) {
    queue.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y
      const origA = a._origY ?? a.y
      const origB = b._origY ?? b.y
      return origA - origB
    })
    const pusher = queue.shift()
    for (const c of list) {
      if (c.id === target.id || c.id === pusher.id) continue
      if (collides(pusher, c)) {
        c.y = pusher.y + pusher.h
        if (!queue.includes(c)) {
          queue.push(c)
        }
      }
    }
  }

  return list.map(c => {
    const clone = { ...c }
    delete clone._origY
    return clone
  })
}

/**
 * 尋找能放下指定寬高的最上方、最左側空位
 */
export function findFreeSlot(cards, w, h) {
  const clampedW = Math.min(COLS, Math.max(1, w ?? 1))
  const clampedH = Math.min(MAX_H, Math.max(1, h ?? 1))
  if (!cards || cards.length === 0) {
    return { x: 0, y: 0 }
  }
  let maxY = 0
  for (const c of cards) {
    if (c.y + c.h > maxY) maxY = c.y + c.h
  }
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= COLS - clampedW; x++) {
      const candidate = { x, y, w: clampedW, h: clampedH }
      if (!cards.some(c => collides(candidate, c))) {
        return { x, y }
      }
    }
  }
  return { x: 0, y: maxY }
}

/**
 * 依型別寬度自動填滿格線版面
 */
export function autoArrange(cards, widthByType = {}) {
  if (!cards || cards.length === 0) return []
  const result = []
  for (const card of cards) {
    const w = Math.min(
      COLS,
      Math.max(1, widthByType[card.type] ?? DEFAULT_WIDTHS[card.type] ?? 6)
    )
    const h = Math.min(MAX_H, Math.max(1, card.h ?? 1))
    const slot = findFreeSlot(result, w, h)
    result.push({
      ...card,
      x: slot.x,
      y: slot.y,
      w,
      h
    })
  }
  return result
}

/**
 * 調整卡片大小並推開重疊卡片
 */
export function resizeCard(cards, id, w, h) {
  const target = cards.find(c => c.id === id)
  if (!target) return cards
  return placeCard(cards, { ...target, w, h })
}

