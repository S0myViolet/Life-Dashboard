/**
 * MV3 service worker entry. Every listener is registered synchronously at the
 * top level (never after an await), so Chrome can deliver the event that woke
 * the worker. All state is in chrome.storage.local; see background.ts.
 */
import { Background } from './background.ts'
import { realChromeApi } from './chrome-api.ts'

const chromeApi = realChromeApi()
// Keep chrome.storage (device token, queue, settings) away from content scripts.
// Chrome remembers the level; it is set again on every start, and pairing
// checks it before a token is stored.
void chromeApi.restrictStorage()
const background = new Background(chromeApi, (input, init) => fetch(input, init))

chrome.runtime.onInstalled.addListener((details) => {
  void background.onInstalled(details.reason)
})

chrome.runtime.onStartup.addListener(() => {
  void background.onStartup()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  void background.onAlarm(alarm.name)
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  background.onMessage(message, sender).then(sendResponse, () => sendResponse({ error: 'internal_error' }))
  return true // reply asynchronously
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void background.onTabUpdated(tabId, changeInfo.status, tab.url)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void background.onTabRemoved(tabId)
})

// A worker started for any other reason still makes sure the tick alarm exists.
void background.ensureAlarm().then(() => background.refreshBadge())
