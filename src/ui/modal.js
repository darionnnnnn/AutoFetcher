// 共用確認對話框（AF-21 批次 4 定案 6）：真正的 modal——原生 <dialog> 的 showModal()
// 置中、遮罩（::backdrop）、背景不可點；開啟時焦點在安全的那顆（取消），Esc＝取消，關閉後焦點回到觸發的元素。
// 內文一律 textContent（或呼叫端用 textContent 建好的節點），不解析成標記。

// 同一時間只會有一個確認框；新的要開時，舊的當作取消收掉
let current = null

function makeButton(doc, text, action, className) {
  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.dataset.action = action
  if (className) btn.className = className
  btn.textContent = text
  return btn
}

/**
 * 開一個確認框。
 * @param {object} opts
 * @param {string} opts.title 標題
 * @param {string|Node|Array<string|Node>} [opts.body] 內文：字串走 textContent，節點原樣放入
 * @param {string} [opts.confirmText] 確認鈕文字
 * @param {string} [opts.cancelText] 取消鈕文字
 * @param {boolean} [opts.danger] 危險動作：確認鈕用危險樣式（不是主要按鈕）
 * @param {{text: string, value: any}} [opts.extra] 多一顆按鈕，按下回傳它的 value
 * @param {Element} [opts.container] 對話框元素掛在哪裡（預設 body；showModal 一律進最上層，位置不影響顯示）
 * @param {{confirm?: string, cancel?: string}} [opts.ids] 兩顆按鈕的 id（呼叫端既有的 id 契約）
 * @returns {Promise<boolean|any>} 確認 true、取消／Esc false、extra 回傳 extra.value
 */
export function confirmDialog({ title, body, confirmText = '確定', cancelText = '取消', danger = false, extra = null, container = null, ids = null } = {}) {
  const doc = globalThis.document
  if (current) current.finish(false)

  const trigger = doc.activeElement
  const dlg = doc.createElement('dialog')
  dlg.className = 'modal'
  const titleId = `modal-title-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  dlg.setAttribute('aria-labelledby', titleId)

  const h = doc.createElement('h2')
  h.className = 'modal-title'
  h.id = titleId
  h.textContent = title || ''
  dlg.appendChild(h)

  const bodyEl = doc.createElement('div')
  bodyEl.className = 'modal-body'
  const parts = Array.isArray(body) ? body : (body == null ? [] : [body])
  for (const part of parts) {
    if (part && typeof part === 'object' && typeof part.nodeType === 'number') {
      bodyEl.appendChild(part)
    } else {
      const p = doc.createElement('p')
      p.textContent = String(part)
      bodyEl.appendChild(p)
    }
  }
  dlg.appendChild(bodyEl)

  const actions = doc.createElement('div')
  actions.className = 'modal-actions'
  const cancelBtn = makeButton(doc, cancelText, 'cancel')
  const confirmBtn = makeButton(doc, confirmText, 'confirm', danger ? 'btn-danger' : 'btn-primary')
  if (ids?.confirm) confirmBtn.id = ids.confirm
  if (ids?.cancel) cancelBtn.id = ids.cancel
  actions.appendChild(cancelBtn)
  let extraBtn = null
  if (extra && extra.text) {
    extraBtn = makeButton(doc, extra.text, 'extra')
    actions.appendChild(extraBtn)
  }
  actions.appendChild(confirmBtn)
  dlg.appendChild(actions)

  return new Promise((resolve) => {
    const state = {
      done: false,
      finish(value) {
        if (state.done) return
        state.done = true
        if (current === state) current = null
        try { if (dlg.open) dlg.close() } catch {}
        dlg.remove()
        if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) {
          try { trigger.focus() } catch {}
        }
        resolve(value)
      }
    }
    current = state

    cancelBtn.onclick = () => state.finish(false)
    confirmBtn.onclick = () => state.finish(true)
    if (extraBtn) extraBtn.onclick = () => state.finish(extra.value)
    // 原生 Esc 會先發 cancel 事件：接住它，走同一個出口（焦點歸還、移除元素）
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault()
      state.finish(false)
    })
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        state.finish(false)
      }
    })
    dlg.addEventListener('close', () => state.finish(false))

    ;(container || doc.body).appendChild(dlg)
    dlg.showModal()
    cancelBtn.focus()
  })
}

// 把開著的確認框當作取消收掉（呼叫端的前提變了，例如確認框說的那批選取已經不同）
export function dismissDialog() {
  if (current) current.finish(false)
}

// 目前有沒有確認框開著
export function isDialogOpen() {
  return current !== null
}
