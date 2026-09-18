// 「這個 pick 是不是既有的那個值」——選取結果對回既有欄位的唯一一份判定。
// background 的重選（applyRepick）與 Picker 的換目標（applyRetarget）共用：
// 兩邊各寫一份的話，同一格在其中一條路徑上會 key 重生、歷史序列斷掉、使用者改過的名稱被預設名蓋掉。
import { putInner, putExclude } from './table.js'

/**
 * 由 pick 逐欄挑出擷取規格。
 * **逐欄挑，不得整包照抄**：pick 來自 content script 的訊息，多帶任何一個欄位都會進 storage、
 * 讓 `sameSpec` 的全等比對永遠對不上。
 * 格內子路徑也要挑（非空陣列才抄）：漏了它，重選會讓任務默默改回抓整格串接（AF-15）。
 */
export function pickSpecOf(pick) {
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
  return JSON.stringify(stripPos(pickSpecOf(a))) === JSON.stringify(stripPos(pickSpecOf(b)))
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
    const hit = prev.find(p => !claimed.has(p.key) && sameSpec(p.spec, pick))
    if (hit) {
      claimed.add(hit.key)
      return { key: hit.key, name: hit.name, auto: hit.auto ?? null, kept: true, spec: pickSpecOf(pick) }
    }
    return { key: crypto.randomUUID().slice(0, 8), name: null, auto: null, kept: false, spec: pickSpecOf(pick) }
  })
  // 呼叫端要知道哪些 key 沒了，才清得掉它們的卡片來源與 lastValues（孤兒序列）
  out.removed = prev.filter(p => !claimed.has(p.key)).map(p => p.key)
  return out
}
