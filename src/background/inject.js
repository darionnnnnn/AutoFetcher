// 動態注入 content script (ES module)
export async function injectContent(tabId, opts) {
  const target = opts?.allFrames === true
    ? { tabId, allFrames: true }
    : { tabId, frameIds: [opts?.frameId ?? 0] }
  await chrome.scripting.executeScript({
    target,
    func: (url) => import(url),
    args: [await chrome.runtime.getURL('content/main.js')]
  })
}
