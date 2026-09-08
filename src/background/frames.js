// AutoFetcher: 重新找回目標所在的 iframe
import { MSG } from '../shared/messages.js'
import { injectContent } from './inject.js'

// 兩個網址是不是同一個目標頁：query 常帶 token 或時戳，只比 origin + pathname。
// frame 定位的第二層與「立即測試」核對分頁網址都走這一份，不得各寫一次。
export function sameOriginPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.origin === ub.origin && ua.pathname === ub.pathname
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 取得每個 frame 的網址
export async function listFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href
    })
    if (!Array.isArray(results)) return []
    return results.map((r) => ({ frameId: r.frameId, url: r.result }))
  } catch {
    return []
  }
}

// 純函式：依網址比對 frame 清單
export function matchFrameByUrl(frames, frameUrl) {
  if (!Array.isArray(frames) || frames.length === 0 || typeof frameUrl !== 'string') {
    return null
  }

  // 第一層：完全相同
  const exactMatches = frames.filter((f) => f && f.url === frameUrl)
  if (exactMatches.length === 1) {
    return { frameId: exactMatches[0].frameId }
  }
  if (exactMatches.length > 1) {
    return { ambiguous: exactMatches.map((f) => f.frameId) }
  }

  // 第二層：origin + pathname
  // frameUrl 本身不合法時 sameOriginPath 一律 false，等於沒有任何命中
  const pathMatches = frames.filter((f) => f && typeof f.url === 'string' && sameOriginPath(f.url, frameUrl))

  if (pathMatches.length === 1) {
    return { frameId: pathMatches[0].frameId }
  }
  if (pathMatches.length > 1) {
    return { ambiguous: pathMatches.map((f) => f.frameId) }
  }

  return null
}

// 定位目標所在的 frame
export async function locateFrame(tabId, frame, locator, opts = {}) {
  if (!frame?.url) {
    return { frameId: 0 }
  }

  const pollMs = opts?.pollMs ?? 250
  const timeoutMs = opts?.timeoutMs ?? 20000
  const startTime = Date.now()

  let ambiguousCandidates = null
  let latestFrames = []

  while (true) {
    latestFrames = await listFrames(tabId)
    const match = matchFrameByUrl(latestFrames, frame.url)
    if (match?.frameId !== undefined) {
      return { frameId: match.frameId }
    }
    if (match?.ambiguous) {
      ambiguousCandidates = match.ambiguous
      break
    }
    if (Date.now() - startTime >= timeoutMs) {
      break
    }
    await sleep(pollMs)
  }

  // 收尾判定
  const candidateIds = ambiguousCandidates
    ? ambiguousCandidates
    : latestFrames.map((f) => f.frameId).filter((id) => id !== 0 && id != null)

  if (candidateIds.length === 0) {
    return null
  }

  const matchedFrameIds = []
  for (const fid of candidateIds) {
    try {
      await injectContent(tabId, { frameId: fid })
      const res = await chrome.tabs.sendMessage(
        tabId,
        { type: MSG.RESOLVE_LOCATOR, locator },
        { frameId: fid }
      )
      if (res?.ok === true && res?.found === true) {
        matchedFrameIds.push(fid)
      }
    } catch {
      // 送訊息拋例外或回別的都算沒命中
    }
  }

  if (matchedFrameIds.length === 1) {
    return { frameId: matchedFrameIds[0] }
  }

  return null
}
