/**
 * The slice of the extension APIs the service worker uses, behind an interface
 * so the controller can be tested with a fake (test/background.test.ts).
 */
import type { Badge } from '../shared/badge.ts'
import { STATE_DEFAULTS, type StateKey, type StoredState } from './state.ts'

export interface TabInfo {
  id?: number
  url?: string
}

export interface ChromeApi {
  readonly extensionId: string
  readonly version: string
  storageGet<K extends StateKey>(keys: K[]): Promise<Pick<StoredState, K>>
  storageSet(patch: Partial<StoredState>): Promise<void>
  alarmExists(name: string): Promise<boolean>
  alarmCreate(name: string, periodInMinutes: number, delayInMinutes: number): Promise<void>
  /** A normal background tab in the owner's current window (visible in the tab strip). */
  tabsCreateBackground(url: string): Promise<TabInfo>
  tabsKeepAlive(tabId: number): Promise<void>
  tabsRemove(tabId: number): Promise<void>
  tabsQuery(urlPatterns: string[]): Promise<TabInfo[]>
  tabsSendMessage(tabId: number, message: unknown): Promise<void>
  openPage(url: string): Promise<void>
  openOptionsPage(): Promise<void>
  setBadge(badge: Badge): Promise<void>
  hasHostPermission(pattern: string): Promise<boolean>
}

export const realChromeApi = (): ChromeApi => ({
  extensionId: chrome.runtime.id,
  version: chrome.runtime.getManifest().version,
  async storageGet(keys) {
    const raw = (await chrome.storage.local.get(keys as string[])) as Partial<StoredState>
    const defaults = STATE_DEFAULTS()
    const out = {} as Pick<StoredState, (typeof keys)[number]>
    for (const k of keys) (out as Record<string, unknown>)[k] = raw[k] ?? defaults[k]
    return out
  },
  async storageSet(patch) {
    await chrome.storage.local.set(patch)
  },
  async alarmExists(name) {
    return (await chrome.alarms.get(name)) !== undefined
  },
  async alarmCreate(name, periodInMinutes, delayInMinutes) {
    try {
      // Explicit, as the alarms docs advise (Chrome 150+).
      await chrome.alarms.create(name, { periodInMinutes, delayInMinutes, persistAcrossSessions: true })
    } catch {
      // Older Chrome rejects the unknown property; the alarm is re-created on startup anyway.
      await chrome.alarms.create(name, { periodInMinutes, delayInMinutes })
    }
  },
  async tabsCreateBackground(url) {
    const tab = await chrome.tabs.create({ url, active: false })
    return { id: tab.id, url: tab.url }
  },
  async tabsKeepAlive(tabId) {
    await chrome.tabs.update(tabId, { autoDiscardable: false })
  },
  async tabsRemove(tabId) {
    await chrome.tabs.remove(tabId)
  },
  async tabsQuery(urlPatterns) {
    const tabs = await chrome.tabs.query({ url: urlPatterns })
    return tabs.map((t) => ({ id: t.id, url: t.url }))
  },
  async tabsSendMessage(tabId, message) {
    await chrome.tabs.sendMessage(tabId, message)
  },
  async openPage(url) {
    await chrome.tabs.create({ url, active: true })
  },
  async openOptionsPage() {
    await chrome.runtime.openOptionsPage()
  },
  async setBadge(badge) {
    await chrome.action.setBadgeText({ text: badge.text })
    await chrome.action.setBadgeBackgroundColor({ color: badge.color })
    await chrome.action.setTitle({ title: badge.title })
  },
  async hasHostPermission(pattern) {
    return chrome.permissions.contains({ origins: [pattern] })
  },
})
