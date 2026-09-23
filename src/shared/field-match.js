// 「這個 pick 是不是既有的那個值」——選取結果對回既有欄位的唯一一份判定。
// background 的重選（applyRepick）與 Picker 的換目標（applyRetarget）共用：
// 兩邊各寫一份的話，同一格在其中一條路徑上會 key 重生、歷史序列斷掉、使用者改過的名稱被預設名蓋掉。
import { putInner, putExclude } from './table.js'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
  }
  return value
}

function json(value) {
  return JSON.stringify(sorted(value))
}

/**
 * 來源是值身分的一部分。新 multi field 直接帶 source；舊 pick 仍可把
 * locator/frame 放在外層，讓同一個比對入口兼容 B1 前的訊息格式。
 */
export function pickSourceOf(value) {
  const normalize = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const out = clone(input)
    // frameId/tabId are execution-only handles; B1's persisted frame shape is
    // deliberately just the stable URL. Document identity/generation belongs
    // on source itself so it can disambiguate same-URL documents at runtime.
    delete out.frameId
    delete out.tabId
    if (out.frame && typeof out.frame === 'object' && !Array.isArray(out.frame)) {
      if (out.frame.url !== undefined) out.frame = { url: out.frame.url }
      else delete out.frame
    }
    return Object.keys(out).length > 0 ? out : null
  }
  if (value?.source && typeof value.source === 'object' && !Array.isArray(value.source)) {
    return normalize(value.source)
  }
  if (value?.spec?.source && typeof value.spec.source === 'object' && !Array.isArray(value.spec.source)) {
    return normalize(value.spec.source)
  }
  const source = {}
  if (value?.locator && typeof value.locator === 'object') source.locator = clone(value.locator)
  if (value?.frame && typeof value.frame === 'object') source.frame = clone(value.frame)
  if (value?.frameUrl !== undefined) source.frame = { url: value.frameUrl }
  // documentIdentity 是選取端可用來消歧同 URL frame 的穩定描述；frameId、tabId
  // 是執行期識別，不得成為永久值 key 的一部分。
  for (const key of ['identity', 'documentIdentity', 'documentGeneration', 'documentId', 'sourceId']) {
    if (value?.[key] !== undefined) source[key] = clone(value[key])
  }
  return normalize(source)
}

/**
 * 將來源化成可比較的身分。明確 identity 代表來源升到等價外層後仍是同一
 * 個文件／目標；沒有 identity 時完整比較 locator、frame 與文件描述。
 * frameId/tabId 不在永久契約內，也不能讓重選因執行期 id 改變而重生 key。
 */
export function sourceIdentityOf(value) {
  const source = pickSourceOf(value)
  if (!source) return null
  const explicit = source.identity ?? source.documentIdentity ?? source.documentGeneration ?? source.sourceId
  if (explicit !== undefined && explicit !== null && String(explicit) !== '') {
    return { identity: String(explicit) }
  }
  const out = clone(source)
  delete out.frameId
  delete out.tabId
  if (out.frame && typeof out.frame === 'object') {
    delete out.frame.frameId
    delete out.frame.documentId
  }
  return out
}

export function sameSource(a, b) {
  const left = sourceIdentityOf(a)
  const right = sourceIdentityOf(b)
  // 兩邊都沒有來源是舊單值／舊 block 規格的相容情況；只有一邊有來源
  // 時必須拒絕，避免新格式跨來源誤配到舊格式。
  if (left === null || right === null) return left === right
  return json(left) === json(right)
}

/**
 * 由 pick 逐欄挑出擷取規格。
 * **逐欄挑，不得整包照抄**：pick 來自 content script 的訊息，多帶任何一個欄位都會進 storage、
 * 讓 `sameSpec` 的全等比對永遠對不上。
 * 格內子路徑也要挑（非空陣列才抄）：漏了它，重選會讓任務默默改回抓整格串接（AF-15）。
 */
export function pickSpecOf(pick) {
  if (pick?.spec && typeof pick.spec === 'object' && !Array.isArray(pick.spec)) {
    return clone(pick.spec)
  }
  if (pick?.cell) {
    const cell = {
      row: { index: pick.cell.row?.index, header: pick.cell.row?.header ?? '' },
      col: { index: pick.cell.col?.index, header: pick.cell.col?.header ?? '' }
    }
    putInner(cell, pick.cell.inner)
    return { cell }
  }
  if (pick?.block) {
    const block = { axis: pick.block.axis, index: pick.block.index, headerText: pick.block.headerText }
    putInner(block, pick.block.inner)
    putExclude(block, pick.block.exclude)
    return { block }
  }
  return null
}

/**
 * 比對「是不是同一個值」時要忽略定位方式與排除／略過設定：重選送回來的 pick 沒有 pos，
 * 且排除清單不是值的身分（重選改了排除仍是同一個值），帶著比會永遠不相等導致 key 重生、歷史序列斷掉。
 */
export function stripPos(spec) {
  if (!spec) return spec
  const out = JSON.parse(JSON.stringify(spec))
  if (out.cell) {
    delete out.cell.row?.pos
    delete out.cell.col?.pos
  }
  if (out.block) {
    delete out.block.exclude
    delete out.block.skip
  }
  return out
}

/** 兩個 pick／規格是不是同一個值 */
export function sameSpec(a, b) {
  const left = pickSpecOf(a)
  const right = pickSpecOf(b)
  if (!left || !right || !sameSource(a, b)) return false
  return json(stripPos(left)) === json(stripPos(right))
}

/**
 * 把新的一批 picks 對回既有的值：對得到就沿用 key 與名稱，對不到就是新值。
 * @param {Array<{key: string, name: string, spec: object, auto?: string}>} prevRows 既有的值
 * @param {Array<object>} picks 新選到的 picks（順序就是結果順序）
 * @returns {Array<{key, name, auto, kept, spec}>} 陣列另帶 `removed` 屬性（沒被認領的舊 key）
 *   `name` 為 null 代表這是新值，名稱交給呼叫端算預設名。
 */
export function reconcileFields(prevRows, picks) {
  const prev = Array.isArray(prevRows) ? prevRows : []
  const list = Array.isArray(picks) ? picks : []
  // 同一個舊值只能被認領一次：兩個一模一樣的 pick 不得共用同一個 key
  const claimed = new Set()
  const out = list.map((pick) => {
    // 認不得的 pick（pickSpecOf 回 null）一律當新值：null 與 null 做 JSON 比對會相等
    const hit = pickSpecOf(pick)
      ? prev.find(p => {
        if (claimed.has(p.key)) return false
        // 舊呼叫端把相對規格放在 row.spec；來源則是 B1 新增的平行欄位。
        // 比對時只附加來源，不把呼叫端尚未回填的 aggregate／skip 當成新身分。
        const previous = p?.spec && typeof p.spec === 'object'
          ? { ...p.spec, ...(p.source ? { source: p.source } : {}) }
          : p
        return sameSpec(previous, pick)
      })
      : undefined
    if (hit) {
      claimed.add(hit.key)
      const row = { key: hit.key, name: hit.name, auto: hit.auto ?? null, kept: true, spec: pickSpecOf(pick) }
      const source = pickSourceOf(pick)
      if (source) row.source = source
      return row
    }
    const row = { key: crypto.randomUUID().slice(0, 8), name: null, auto: null, kept: false, spec: pickSpecOf(pick) }
    const source = pickSourceOf(pick)
    if (source) row.source = source
    return row
  })
  // 呼叫端要知道哪些 key 沒了，才清得掉它們的卡片來源與 lastValues（孤兒序列）
  out.removed = prev.filter(p => !claimed.has(p.key)).map(p => p.key)
  return out
}
