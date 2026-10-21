// 清單就地拖曳排序（任務列、欄位設定共用）。與 dnd.js 不同：這裡沒有投放目標，
// 只在同一個容器內即時換位置。規則：
// - 移動超過門檻才算拖曳（單純點一下不寫入）
// - 只理會啟動這次拖曳的那根手指（pointerId）
// - pointercancel／Esc＝取消：DOM 回到拖前順序、不寫入
// - 放開時順序真的變了才呼叫 onCommit
// - 命中只看兄弟元素的矩形（不用 elementFromPoint，jsdom 測得動）
// - 拖曳中清單被整份重畫過（舊元素已脫離容器）時取消不還原，避免把舊列塞回去變成重複列
// - 真的拖過之後放開，吃掉緊接的那一下 click（label 的 click 會切換勾選框）

const DRAG_THRESHOLD_PX = 4

/**
 * @param {HTMLElement} item 可拖的那一列
 * @param {{ container: () => HTMLElement|null, items: (container: HTMLElement) => HTMLElement[],
 *   axis?: 'x'|'y', ignore?: (e: PointerEvent) => boolean, onCommit: (order: HTMLElement[]) => any }} opts
 */
export function makeSortable(item, { container, items, axis = 'y', ignore, onCommit }) {
  let drag = null

  const orderOf = (box) => items(box)

  const onMove = (e) => {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return
    const pos = axis === 'x' ? e.clientX : e.clientY
    if (!drag.active) {
      if (Math.abs(pos - drag.start) <= DRAG_THRESHOLD_PX) return
      drag.active = true
    }
    const box = drag.box
    const siblings = orderOf(box).filter(el => el !== item)
    for (const sib of siblings) {
      const rect = sib.getBoundingClientRect()
      const mid = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
      if (pos < mid) {
        if (item.nextSibling !== sib) box.insertBefore(item, sib)
        return
      }
    }
    const last = siblings[siblings.length - 1]
    if (last && last.nextSibling !== item) box.insertBefore(item, last.nextSibling)
  }

  const finish = async (commit, e) => {
    if (!drag || (e?.pointerId !== undefined && e.pointerId !== drag.pointerId)) return
    const { box, before, active, pointerId } = drag
    drag = null
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('pointercancel', onCancel)
    document.removeEventListener('keydown', onKey)
    if (typeof item.releasePointerCapture === 'function' && pointerId !== undefined) {
      try { item.releasePointerCapture(pointerId) } catch {}
    }
    if (!active) return
    swallowNextClick()
    if (!commit) {
      // 拖曳中被重畫過：舊元素已不在這個容器裡，現在的 DOM 就是最新狀態，不動它
      if (!box.isConnected || before.some(el => el.parentNode !== box)) return
      for (const el of before) box.appendChild(el)
      return
    }
    const after = orderOf(box)
    if (after.length === before.length && after.every((el, i) => el === before[i])) return
    await onCommit(after)
  }
  const onUp = (e) => finish(true, e)
  const onCancel = (e) => finish(false, e)
  const onKey = (e) => { if (e.key === 'Escape') finish(false) }

  // 只吃「這次拖曳結束後」的第一下 click；下一個 task 之後就不再攔
  const swallowNextClick = () => {
    const onClick = (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
    }
    item.addEventListener('click', onClick, { capture: true, once: true })
    setTimeout(() => item.removeEventListener('click', onClick, { capture: true }), 0)
  }

  item.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return
    if (typeof ignore === 'function' && ignore(e)) return
    const box = container()
    if (!box) return
    drag = {
      box,
      before: orderOf(box),
      start: axis === 'x' ? e.clientX : e.clientY,
      pointerId: e.pointerId,
      active: false
    }
    if (typeof item.setPointerCapture === 'function' && e.pointerId !== undefined) {
      try { item.setPointerCapture(e.pointerId) } catch {}
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    document.addEventListener('keydown', onKey)
  })
}
