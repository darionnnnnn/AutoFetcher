// AutoFetcher 內嵌 SVG 圖示（擴充功能頁共用；AF-21 批次 8）
// 圖示一律用 DOM API（createElementNS）建立，不用符號字元：⚙ ✕ 這類字元在不同系統字型長得不一樣。
// 線條用 currentColor，跟著按鈕的文字色走（亮暗兩軌自動對）；尺寸 16px、viewBox 24。
// 匯出的獨立 HTML 用 outerHTML 帶出卡片，SVG 是靜態標記，不需要腳本就能呈現。

const SVG_NS = 'http://www.w3.org/2000/svg'

// 圖示名稱 → 形狀（每個形狀是 [標籤, 屬性]）。不用 <circle>：卡片裡的圖表點是 circle，圖示混進去會讓點數對不上
const SHAPES = {
  settings: [
    ['path', { d: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z' }],
    ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }]
  ],
  close: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'M6 6l12 12' }]
  ],
  grip: [
    ['path', { d: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', 'stroke-width': 3 }]
  ],
  remove: [
    ['path', { d: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z' }],
    ['path', { d: 'M8 12h8' }]
  ],
  trash: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M8 6V4h8v2' }],
    ['path', { d: 'M19 6l-1 14H6L5 6' }]
  ],
  refresh: [
    ['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }],
    ['path', { d: 'M21 3v6h-6' }]
  ],
  external: [
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
    ['path', { d: 'M15 3h6v6' }],
    ['path', { d: 'M10 14 21 3' }]
  ],
  alert: [
    ['path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }]
  ],
  check: [
    ['path', { d: 'M20 6 9 17l-5-5' }]
  ],
  copy: [
    ['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }],
    ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]
  ],
  plus: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'M5 12h14' }]
  ],
  'chevron-left': [['path', { d: 'm15 18-6-6 6-6' }]],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'chevron-up': [['path', { d: 'm18 15-6-6-6 6' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'chevrons-left': [['path', { d: 'm11 17-5-5 5-5' }], ['path', { d: 'm18 17-5-5 5-5' }]],
  'chevrons-right': [['path', { d: 'm13 17 5-5-5-5' }], ['path', { d: 'm6 17 5-5-5-5' }]]
}

export const ICON_NAMES = Object.freeze(Object.keys(SHAPES))

/**
 * 建立一個內嵌 SVG 圖示（裝飾用：aria-hidden；意義由按鈕的 aria-label 或可見文字表達）
 * @param {string} name ICON_NAMES 之一
 * @param {{ size?: number }} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 16 } = {}) {
  const shapes = SHAPES[name]
  if (!shapes) throw new Error(`沒有這個圖示：${name}`)
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('data-icon', name)
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    svg.appendChild(el)
  }
  return svg
}

/**
 * 把按鈕的內容換成圖示（只有圖示的按鈕：aria-label 與 title 必填）
 * 帶 text 時圖示接在可見文字前面，aria-label 不設（可見文字就是名稱）
 * @param {HTMLElement} btn
 * @param {string} name
 * @param {{ label?: string, text?: string }} opts
 * @returns {HTMLElement}
 */
export function setIcon(btn, name, { label, text } = {}) {
  btn.textContent = ''
  btn.appendChild(icon(name))
  if (text) {
    const span = document.createElement('span')
    span.textContent = text
    btn.appendChild(span)
    btn.classList.add('has-icon')
  } else {
    btn.classList.add('icon-btn')
    if (label) {
      btn.setAttribute('aria-label', label)
      btn.title = label
    }
  }
  return btn
}

// 燈號等級 → 狀態 chip（Report 應用列與 popup 頂部共用一份，兩處長得一樣）
const LEVEL_CHIP = {
  green: { cls: 'is-ok', text: '正常' },
  yellow: { cls: 'is-warn', text: '注意' },
  red: { cls: 'is-bad', text: '異常' },
  off: { cls: 'is-off', text: '已暫停' }
}

/**
 * 燈號等級（computeHealth 的 level）→ { cls, text }
 * @param {string} level
 */
export function levelChipOf(level) {
  return LEVEL_CHIP[level] || LEVEL_CHIP.off
}
