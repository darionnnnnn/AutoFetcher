// AutoFetcher 跨環境鎖（AF-21 批次 1）：storage 的讀-改-寫一律在「那個鍵的鎖」內完成
//
// 有 navigator.locks 就用它：同一個擴充功能來源的頁面與 service worker 之間互斥，
// worker 被回收時鎖自動釋放。沒有（Node 測試環境）就用模組內「每個名稱一條 promise 鏈」的佇列。
// 鎖不可重入、不得巢狀：鎖內只能呼叫不取鎖的內部版本，同名再取一次就是死結。
import * as diag from './diag.js'

// 取鎖最多等多久（毫秒）；逾時就不帶鎖照做——某個卡死的頁面不能讓排程抓取永遠停擺
const DEFAULT_TIMEOUT_MS = 10000

// 目前這個執行環境持有的鎖：name -> holdId（每次取得遞增）
const held = new Map()
let nextHoldId = 0

// 沒有 navigator.locks 時的佇列：name -> 最後一位的完成 promise
const chains = new Map()

// 等 promise，最多 timeoutMs；逾時回 false
function waitWithTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer))
}

// 佇列版取鎖：回傳 { acquired, release }；逾時時 acquired 為 false，照樣要 release 自己那一格
async function acquireLocal(name, timeoutMs) {
  const prev = chains.get(name) || Promise.resolve()
  let release
  const mine = new Promise((resolve) => { release = resolve })
  const tail = prev.then(() => mine)
  chains.set(name, tail)
  tail.then(() => { if (chains.get(name) === tail) chains.delete(name) })
  const acquired = await waitWithTimeout(prev, timeoutMs)
  return { acquired, release }
}

// 持有期間執行 fn：登記 holdId，結束（含例外）就註銷
async function runHeld(name, fn) {
  const holdId = ++nextHoldId
  held.set(name, holdId)
  try {
    return await fn()
  } finally {
    if (held.get(name) === holdId) held.delete(name)
  }
}

// 取鎖逾時：記一筆診斷（diag 自己的鎖逾時不能再寫 diag，會遞迴）
async function reportTimeout(name) {
  if (name === 'diag') {
    console.warn('AutoFetcher: lock_timeout', name)
    return
  }
  try {
    await diag.log('lock_timeout', name)
  } catch {}
}

/**
 * 在名為 name 的鎖內執行 fn，回傳 fn 的回傳值；fn 丟例外會往外丟，鎖照樣釋放。
 * 取鎖逾時就不帶鎖照做並記一筆 lock_timeout 診斷。
 * @param {string} name 鎖名（storage 鍵用 lockNameOf 換算）
 * @param {() => any} fn 鎖內要做的事
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function withLock(name, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const locks = globalThis.navigator?.locks
  if (locks) {
    let granted = false
    try {
      return await locks.request(name, { signal: AbortSignal.timeout(timeoutMs) }, () => {
        granted = true
        return runHeld(name, fn)
      })
    } catch (err) {
      // 只有「還沒拿到鎖就被逾時中止」才退回不帶鎖照做；fn 自己丟的例外照原樣往外丟
      if (granted) throw err
      await reportTimeout(name)
      return await fn()
    }
  }

  const { acquired, release } = await acquireLocal(name, timeoutMs)
  try {
    if (acquired) return await runHeld(name, fn)
    await reportTimeout(name)
    return await fn()
  } finally {
    release()
  }
}

/**
 * 目前這個執行環境持有哪些鎖（副本：name -> holdId），診斷用。
 * @returns {Map<string, number>}
 */
export function heldLocks() {
  return new Map(held)
}

// 紀錄鍵裡的日期（rec:<YYYY-MM-DD>）；不是紀錄鍵回 null
function recordDateOf(key) {
  if (!key.startsWith('rec:')) return null
  const m = /\d{4}-\d{2}-\d{2}/.exec(key)
  return m ? m[0] : null
}

/**
 * storage 鍵對應的鎖名：session 加前綴；同一天的紀錄鍵共用一把；其餘就是鍵本身。
 * @param {string} key storage 鍵
 * @param {'local'|'session'} [area]
 */
export function lockNameOf(key, area = 'local') {
  if (area === 'session') return 'session:' + key
  const date = recordDateOf(key)
  return date ? 'rec@' + date : key
}
