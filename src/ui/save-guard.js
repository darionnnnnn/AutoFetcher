// 「還不能儲存」守門元件（AF-21 批次 4）：Picker 先用，站台設定與卡片抽屜之後共用同一份。
// 規則：儲存鈕永遠不設 disabled——按下去有原因就把原因列在儲存鈕正上方、焦點送到第一條；
// 每一條原因是一顆按鈕，點了跳到那一欄（或執行指定動作，例如「回頁面重選目標」）。
// 不用 innerHTML：原因文字可能含任務名稱。

/**
 * @typedef {Object} SaveGuardReason
 * @property {string} id 原因代號（同一欄的原因共用，方便呼叫端比對）
 * @property {string} text 給使用者看的一句話
 * @property {string} [field] 點了要跳過去的元素 id
 * @property {Function} [action] 點了要執行的動作（有 action 時優先於 field）
 */

/**
 * 建立一個守門元件。
 * @param {Object} opts
 * @param {HTMLElement} opts.container 原因區（建議 role="alert"，放在固定列正上方）
 * @param {HTMLElement} [opts.saveButton] 儲存鈕（只用來確保它不被設成 disabled）
 * @param {HTMLElement} [opts.countEl] 儲存鈕旁的「還差 N 項」
 * @param {string} [opts.title] 條列上方的標題
 */
export function createSaveGuard({ container, saveButton = null, countEl = null, title = '還不能儲存：' } = {}) {
  // 目前被標成 aria-invalid 的欄位（清除時只清自己標的，不動別人的）
  const marked = new Set()

  function doc() {
    return container?.ownerDocument || globalThis.document
  }

  function unmarkAll() {
    for (const el of marked) {
      if (el && typeof el.removeAttribute === 'function') el.removeAttribute('aria-invalid')
    }
    marked.clear()
  }

  function markField(id) {
    const el = id ? doc()?.getElementById(id) : null
    if (!el) return null
    el.setAttribute('aria-invalid', 'true')
    marked.add(el)
    return el
  }

  function setCount(n) {
    if (!countEl) return
    countEl.hidden = !(n > 0)
    countEl.textContent = n > 0 ? `還差 ${n} 項` : ''
  }

  function keepSaveEnabled() {
    // 停用的控制項被點到不得靜默無事：守門只說原因，從不把儲存鈕關掉
    if (saveButton && saveButton.hasAttribute('disabled')) saveButton.removeAttribute('disabled')
  }

  function jumpTo(reason) {
    if (typeof reason.action === 'function') {
      try { reason.action() } catch {}
      return
    }
    const el = markField(reason.field)
    if (!el) return
    // 欄位收在摺疊區（例如「進階設定」）裡時先展開，否則捲不到也 focus 不了
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.open) p.open = true
    }
    if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'center' }) } catch {}
    }
    if (typeof el.focus === 'function') el.focus()
  }

  /**
   * 列出原因。沒有原因等同 clear()。
   * @param {SaveGuardReason[]} reasons
   * @param {{ focus?: boolean }} [opts] focus：把焦點移到第一條（按儲存時要，即時更新時不要）
   * @returns {number} 原因數
   */
  function show(reasons, { focus = true } = {}) {
    const list = Array.isArray(reasons) ? reasons.filter(r => r && r.text) : []
    if (list.length === 0) {
      clear()
      return 0
    }
    unmarkAll()
    const d = doc()
    const head = d.createElement('div')
    head.className = 'save-guard-title'
    head.textContent = title
    const ul = d.createElement('ul')
    ul.className = 'save-guard-list'
    const buttons = []
    for (const r of list) {
      const li = d.createElement('li')
      const btn = d.createElement('button')
      btn.type = 'button'
      btn.className = 'save-guard-item'
      if (r.id) btn.dataset.reason = r.id
      btn.textContent = r.text
      btn.addEventListener('click', () => jumpTo(r))
      li.appendChild(btn)
      ul.appendChild(li)
      buttons.push(btn)
      if (r.field && typeof r.action !== 'function') markField(r.field)
    }
    container.replaceChildren(head, ul)
    container.hidden = false
    setCount(list.length)
    keepSaveEnabled()
    if (focus && buttons[0] && typeof buttons[0].focus === 'function') buttons[0].focus()
    return list.length
  }

  /**
   * 一條純文字（存檔失敗、立即測試的錯誤、進行中說明）：不跳轉、不算「還差幾項」。
   * 文字為空等同 clear()。
   * @param {string} text
   */
  function message(text) {
    const s = text === null || text === undefined ? '' : String(text)
    if (s === '') {
      clear()
      return
    }
    unmarkAll()
    const line = doc().createElement('div')
    line.className = 'save-guard-message'
    line.textContent = s
    container.replaceChildren(line)
    container.hidden = false
    setCount(0)
    keepSaveEnabled()
  }

  function clear() {
    unmarkAll()
    if (container) {
      container.replaceChildren()
      container.hidden = true
    }
    setCount(0)
  }

  return { show, message, clear }
}

/**
 * 欄位離開焦點時的就地錯誤：錯誤字放在欄位正下方，`aria-describedby` 指向它。
 * @param {HTMLElement} field
 * @param {string} text 空字串＝清掉
 */
export function setFieldError(field, text) {
  if (!field || !field.ownerDocument) return
  const d = field.ownerDocument
  const errId = `${field.id || 'field'}-error`
  let errEl = d.getElementById(errId)
  const msg = text ? String(text) : ''
  if (!msg) {
    if (errEl) {
      errEl.textContent = ''
      errEl.hidden = true
    }
    field.removeAttribute('aria-invalid')
    const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== errId)
    if (ids.length > 0) field.setAttribute('aria-describedby', ids.join(' '))
    else field.removeAttribute('aria-describedby')
    return
  }
  if (!errEl) {
    errEl = d.createElement('div')
    errEl.id = errId
    errEl.className = 'field-error'
    field.after(errEl)
  }
  errEl.textContent = msg
  errEl.hidden = false
  field.setAttribute('aria-invalid', 'true')
  const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
  if (!ids.includes(errId)) ids.push(errId)
  field.setAttribute('aria-describedby', ids.join(' '))
}
