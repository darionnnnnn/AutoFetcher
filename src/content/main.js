import { MSG } from '../shared/messages.js'

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = typeof msg === 'object' && msg !== null ? msg.type : msg
  if (
    type === MSG.DESCRIBE ||
    type === MSG.EXTRACT ||
    type === MSG.SCROLL_INTO_VIEW
  ) {
    sendResponse({ ok: false, error: 'not_implemented' })
  }
})
