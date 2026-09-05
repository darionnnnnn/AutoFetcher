function bootstrap() {
  // A2 之後接上 scheduler
}

chrome.runtime.onInstalled.addListener(bootstrap)
chrome.runtime.onStartup.addListener(bootstrap)
