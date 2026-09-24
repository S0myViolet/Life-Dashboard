/**
 * Background revisits: an OPT-IN PROTOTYPE, off by default.
 *
 * ChatGPT's and Claude's consumer terms restrict automated or programmatic
 * access, so this is only ever enabled by the owner after reading that note.
 * When on, every 30 minutes each selected, active conversation that has not
 * been captured recently is queued (bounded). At most one collector tab per
 * service is open at a time; it is a normal, visible background tab in the
 * owner's window (never hidden, never minimised), it is closed by the helper
 * after one capture or a timeout, and the helper only ever closes tabs it
 * opened itself. A sign-in page or verification check stops revisits for that
 * service until the owner resumes them; challenges are never clicked through.
 */
import type { CaptureProvider, CaptureSelectionItem } from '@personal-home/core'

export const REVISIT = {
  intervalMs: 30 * 60_000,
  /** How long a collector tab may take to render and report. */
  tabTimeoutMs: 90_000,
  maxQueue: 20,
} as const

export interface RevisitTask {
  conversationId: string
  provider: CaptureProvider
  url: string
  queuedAt: number
}

export interface RevisitCollector {
  tabId: number
  provider: CaptureProvider
  conversationId: string
  url: string
  openedAt: number
}

export interface RevisitState {
  queue: RevisitTask[]
  collectors: RevisitCollector[]
  /** conversationId → last time a revisit was attempted. */
  lastVisitedAt: Record<string, number>
  blocked: Partial<Record<CaptureProvider, { reason: string; at: number }>>
}

export const emptyRevisitState = (): RevisitState => ({
  queue: [],
  collectors: [],
  lastVisitedAt: {},
  blocked: {},
})

/**
 * Queue selected, active conversations that are due: not revisited and not
 * captured (passively or by revisit) within the interval, not already queued
 * or open, and whose service is not blocked.
 */
export function planRevisits(
  state: RevisitState,
  selection: CaptureSelectionItem[],
  lastCapturedAt: Record<string, number>,
  now: number,
): RevisitState {
  const queued = new Set(state.queue.map((t) => t.conversationId))
  const open = new Set(state.collectors.map((c) => c.conversationId))
  const selectedIds = new Set(selection.map((s) => s.id))
  // Drop tasks for conversations that are no longer selected/active.
  const queue = state.queue.filter((t) => selectedIds.has(t.conversationId) && !state.blocked[t.provider])
  const due = selection
    .filter((s) => s.captureState === 'active')
    .filter((s) => !state.blocked[s.provider])
    .filter((s) => !queued.has(s.id) && !open.has(s.id))
    .filter((s) => {
      const last = Math.max(state.lastVisitedAt[s.id] ?? 0, lastCapturedAt[s.id] ?? 0)
      return now - last >= REVISIT.intervalMs
    })
    .sort((a, b) => (state.lastVisitedAt[a.id] ?? 0) - (state.lastVisitedAt[b.id] ?? 0))
  for (const s of due) {
    if (queue.length >= REVISIT.maxQueue) break
    queue.push({ conversationId: s.id, provider: s.provider, url: s.url, queuedAt: now })
  }
  return { ...state, queue }
}

/** Tasks to open now: the first queued task of each service without an open collector. */
export function nextToOpen(state: RevisitState): RevisitTask[] {
  const busy = new Set(state.collectors.map((c) => c.provider))
  const out: RevisitTask[] = []
  for (const t of state.queue) {
    if (busy.has(t.provider) || state.blocked[t.provider]) continue
    busy.add(t.provider)
    out.push(t)
  }
  return out
}

export function startCollector(state: RevisitState, task: RevisitTask, tabId: number, now: number): RevisitState {
  return {
    ...state,
    queue: state.queue.filter((t) => t.conversationId !== task.conversationId),
    collectors: [
      ...state.collectors,
      { tabId, provider: task.provider, conversationId: task.conversationId, url: task.url, openedAt: now },
    ],
    lastVisitedAt: { ...state.lastVisitedAt, [task.conversationId]: now },
  }
}

export function collectorForTab(state: RevisitState, tabId: number | undefined): RevisitCollector | null {
  if (tabId === undefined) return null
  return state.collectors.find((c) => c.tabId === tabId) ?? null
}

export function finishCollector(state: RevisitState, tabId: number): RevisitState {
  return { ...state, collectors: state.collectors.filter((c) => c.tabId !== tabId) }
}

export function expiredCollectors(state: RevisitState, now: number): RevisitCollector[] {
  return state.collectors.filter((c) => now - c.openedAt >= REVISIT.tabTimeoutMs)
}

/** Stop revisits for a service (sign-in page or challenge) and drop its queued tasks. */
export function blockProvider(
  state: RevisitState,
  provider: CaptureProvider,
  reason: string,
  now: number,
): RevisitState {
  return {
    ...state,
    queue: state.queue.filter((t) => t.provider !== provider),
    blocked: { ...state.blocked, [provider]: { reason, at: now } },
  }
}

export function unblockProvider(state: RevisitState, provider: CaptureProvider): RevisitState {
  const blocked = { ...state.blocked }
  delete blocked[provider]
  return { ...state, blocked }
}

export type CollectorNavigation = 'ok' | 'signed_out' | 'left'

const LOGIN_PATHS: Record<CaptureProvider, RegExp> = {
  chatgpt: /^\/(auth\/|log-?in|sign-?in)/i,
  claude: /^\/(login|log-in|signin|sign-in|magic-link)/i,
}

const HOSTS: Record<CaptureProvider, string> = { chatgpt: 'chatgpt.com', claude: 'claude.ai' }

/** A provider sign-in path (the SPA or the server moved a conversation page there). */
export function isLoginPath(provider: CaptureProvider, pathname: string): boolean {
  return LOGIN_PATHS[provider].test(pathname)
}

/**
 * Where did a collector tab go? `url` is undefined when Chrome hides it, which
 * happens once the tab leaves the sites the helper has access to (for example
 * a redirect to the provider's separate sign-in host).
 */
export function classifyCollectorNavigation(provider: CaptureProvider, url: string | undefined): CollectorNavigation {
  if (url === undefined || url === '') return 'signed_out'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'left'
  }
  if (parsed.protocol === 'about:' || parsed.protocol === 'chrome:') return 'ok' // still loading
  if (parsed.hostname !== HOSTS[provider]) return 'signed_out'
  if (isLoginPath(provider, parsed.pathname)) return 'signed_out'
  return 'ok'
}
