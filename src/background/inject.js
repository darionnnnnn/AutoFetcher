// 動態注入 content script (ES module)
export async function injectContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (url) => import(url),
    args: [await chrome.runtime.getURL('content/main.js')]
  })
}
