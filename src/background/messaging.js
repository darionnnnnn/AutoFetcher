// AutoFetcher：background 送訊息給 content 的唯一入口（AF-21 批次 2 定案 6）
// `chrome.tabs.sendMessage` 只准出現在這個檔（慣例測試 D13b 會擋）：
// 沒有逾時的送訊息只要回應遺失，就會吊到 service worker 被回收。

// 我們自己丟的逾時要**帶得出身分**：判斷「該不該重試」不得比對 Chrome 的英文錯誤字串，
// 那串字會隨瀏覽器版本與語系變，比對它就是把契約押在別人的文案上（AF-13）。
export function timeoutError(message) {
  const err = new Error(message)
  err.afTimeout = true
  return err
}

/**
 * 送訊息給 content，並且**一定要有逾時**。
 * 計時器贏了要清、輸了更要清：不清的話每送一次就留一個計時器吊著事件迴圈，
 * MV3 的 service worker 因此遲遲不能閒置回收（AF-12 發現，AF-13 把捲動與前置動作也納入）。
 * 一律指名 frameId（D13：不指名就是廣播給每個 frame）。
 */
export function sendToFrame(tabId, message, frameId, timeoutMs, label) {
  let timer = null
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message, { frameId }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(`${label} timeout`)), timeoutMs)
    })
  ]).finally(() => { if (timer !== null) clearTimeout(timer) })
}
