/**
 * Service-worker controller: pairing and token storage, selection sync,
 * snapshot upload with an offline queue and backoff, the toolbar badge,
 * startup/wake catch-up and the opt-in revisit prototype.
 *
 * State lives in chrome.storage.local (the worker is stopped when idle).
 * Read-modify-write sections are serialized with an in-memory lock; network
 * calls happen outside it.
 */
import {
  CaptureSnapshotSchema,
  CaptureStatusReportSchema,
  captureNormalizePairingCode,
  captureParseConversationUrl,
  captureStateForProblem,
  type CaptureConversationRef,
  type CaptureProblemState,
  type CaptureProvider,
  type CaptureSelectionItem,
  type CaptureStatusReport,
} from '@personal-home/core'
import { CaptureApi, normalizeDashboardOrigin, originPermissionPattern, type FetchLike } from '../shared/api.ts'
import { computeBadge } from '../shared/badge.ts'
import type {
  ActivityEntry,
  ContentRequest,
  HelloResponse,
  HelperStateView,
  ObservationResponse,
  PageObservation,
  PageRequest,
  PairResult,
} from '../shared/protocol.ts'
import {
  classifyUpload,
  dueItems,
  enqueue,
  markFailed,
  parseRetryAfter,
  removeItem,
  retryAllNow,
  type UploadItem,
} from '../shared/queue.ts'
import {
  blockProvider,
  classifyCollectorNavigation,
  collectorForTab,
  emptyRevisitState,
  expiredCollectors,
  finishCollector,
  nextToOpen,
  planRevisits,
  startCollector,
  unblockProvider,
  type RevisitCollector,
} from '../shared/revisit.ts'
import { buildSnapshots, snapshotBodyBytes } from '../shared/snapshot.ts'
import type { ChromeApi } from './chrome-api.ts'
import {
  PROBLEM_TTL_MS,
  appendLog,
  emptyConversationStatus,
  type ConversationStatus,
  type Pairing,
  type StateKey,
  type StoredState,
} from './state.ts'

export const TICK_ALARM = 'ph-tick'
export const TIMING = {
  tickMinutes: 1,
  selectionMaxAgeMs: 5 * 60_000,
  /** A missing conversation triggers at most one selection sync per this interval. */
  helloResyncMs: 15_000,
  /** A gap this long between ticks means the browser was asleep or closed. */
  wakeGapMs: 3 * 60_000,
  maxUploadsPerFlush: 20,
} as const

const PROVIDER_TABS = ['https://chatgpt.com/*', 'https://claude.ai/*']
const PROVIDER_HOSTS = new Set(['chatgpt.com', 'claude.ai'])

export interface MessageSender {
  id?: string
  url?: string
  tab?: { id?: number }
}

const conversationKey = (ref: { provider: CaptureProvider; externalId: string }) =>
  `${ref.provider}:${ref.externalId.toLowerCase()}`

/**
 * Only keep selection entries whose URL is a real conversation URL of the same
 * provider and id: the helper opens these URLs in revisit tabs, so a dashboard
 * must never be able to point it anywhere else.
 */
export function captureSafeSelection(items: CaptureSelectionItem[]): CaptureSelectionItem[] {
  return items.flatMap((item) => {
    const ref = captureParseConversationUrl(item.url)
    if (!ref || ref.provider !== item.provider || ref.externalId !== item.externalId.toLowerCase()) return []
    return [{ ...item, url: ref.canonicalUrl }]
  })
}

function findSelected(items: CaptureSelectionItem[], ref: CaptureConversationRef) {
  return items.find((i) => i.provider === ref.provider && i.externalId.toLowerCase() === ref.externalId)
}

const PAIR_ERRORS: Record<string, string> = {
  invalid_origin: 'Enter the dashboard address, for example https://home.example.com.',
  permission_missing: 'Chrome did not grant access to the dashboard address. Try again and choose Allow.',
  invalid_code: 'That does not look like a pairing code (12 letters and digits, e.g. ABCD-EFGH-JKMN).',
  invalid_device_name: 'Give this browser a short name (1–60 characters).',
  invalid_or_expired_code:
    'The dashboard refused the code: it is wrong, already used, expired or locked after too many attempts. Create a new one in Settings → Chrome helper.',
  extension_origin_required:
    'The dashboard did not receive this extension’s origin. Reload the extension and try again; see the README if it persists.',
  network_error: 'Could not reach the dashboard. Check the address and your connection.',
  unexpected_response: 'The dashboard answered with something unexpected. Check the address.',
}

export class Background {
  private lock: Promise<unknown> = Promise.resolve()
  private flushing: Promise<void> | null = null
  private revisiting = false
  private lastHelloSync = 0
  /** Tabs this worker is closing itself (so onRemoved does not log them as closed by the owner). */
  private closing = new Set<number>()

  constructor(
    private readonly chrome: ChromeApi,
    private readonly fetchImpl: FetchLike,
    private readonly clock: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private read<K extends StateKey>(keys: K[]): Promise<Pick<StoredState, K>> {
    return this.chrome.storageGet(keys)
  }

  /** Serialized read-modify-write of the given keys. `fn` must not do network I/O. */
  private update<K extends StateKey, T>(keys: K[], fn: (s: Pick<StoredState, K>) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const state = await this.chrome.storageGet(keys)
      const result = await fn(state)
      await this.chrome.storageSet(state as Partial<StoredState>)
      return result
    }
    const next = this.lock.then(run, run)
    this.lock = next.catch(() => undefined)
    return next
  }

  private log(kind: ActivityEntry['kind'], text: string): Promise<void> {
    return this.update(['log'], (s) => {
      s.log = appendLog(s.log, { at: this.clock(), kind, text })
    })
  }

  private api(pairing: Pick<Pairing, 'apiOrigin'>): CaptureApi {
    return new CaptureApi(pairing.apiOrigin, this.fetchImpl)
  }

  private usablePairing(p: Pairing | null): p is Pairing {
    return p !== null && p.authFailedAt === null
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async ensureAlarm(): Promise<void> {
    // Alarms usually survive restarts but that is not guaranteed: re-create if missing.
    if (!(await this.chrome.alarmExists(TICK_ALARM))) {
      await this.chrome.alarmCreate(TICK_ALARM, TIMING.tickMinutes, 0.5)
    }
  }

  async onInstalled(reason: string): Promise<void> {
    await this.ensureAlarm()
    if (reason === 'install') {
      const { pairing } = await this.read(['pairing'])
      if (!pairing) await this.chrome.openOptionsPage().catch(() => undefined)
    }
    await this.catchUp('install')
  }

  async onStartup(): Promise<void> {
    await this.ensureAlarm()
    await this.catchUp('startup')
  }

  /** Browser start or wake: re-sync the selection, retry the queue now, re-check open pages, plan revisits. */
  async catchUp(reason: 'startup' | 'wake' | 'install' | 'manual'): Promise<void> {
    const now = this.clock()
    await this.update(['queue', 'lastTickAt'], (s) => {
      s.queue = retryAllNow(s.queue, now)
      s.lastTickAt = now
    })
    if (reason === 'startup' || reason === 'wake') {
      await this.log('info', reason === 'startup' ? 'Browser started: catching up.' : 'Woke up after a pause: catching up.')
    }
    await this.syncSelection()
    await this.flushQueue()
    await this.notifyPages()
    await this.revisitStep()
    await this.refreshBadge()
  }

  async onAlarm(name: string): Promise<void> {
    if (name !== TICK_ALARM) return
    const now = this.clock()
    const { lastTickAt } = await this.read(['lastTickAt'])
    if (lastTickAt !== null && now - lastTickAt > TIMING.wakeGapMs) {
      // Chrome fires a missed repeating alarm once on wake: treat it as a catch-up.
      await this.catchUp('wake')
      return
    }
    await this.update(['lastTickAt'], (s) => {
      s.lastTickAt = now
    })
    const { selection } = await this.read(['selection'])
    if (selection.syncedAt === null || now - selection.syncedAt > TIMING.selectionMaxAgeMs) {
      await this.syncSelection()
    }
    await this.flushQueue()
    await this.revisitStep()
    await this.refreshBadge()
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /** Content scripts may only use content messages, and only from the provider sites. */
  private senderKind(sender: MessageSender): 'content' | 'page' | null {
    if (sender.id !== this.chrome.extensionId) return null
    if (sender.tab && sender.url) {
      try {
        const url = new URL(sender.url)
        if (url.protocol === 'https:' && PROVIDER_HOSTS.has(url.hostname)) return 'content'
      } catch {
        return null
      }
    }
    if (sender.url?.startsWith(`chrome-extension://${this.chrome.extensionId}/`)) return 'page'
    return null
  }

  async onMessage(message: unknown, sender: MessageSender): Promise<unknown> {
    const kind = this.senderKind(sender)
    if (!kind || !message || typeof message !== 'object') return { error: 'forbidden' }
    const type = (message as { type?: unknown }).type
    if (kind === 'content') {
      const m = message as ContentRequest
      const tabId = sender.tab?.id
      switch (type) {
        case 'ph:hello':
          return typeof m.type === 'string' && 'url' in m ? this.hello(String(m.url), tabId) : { error: 'bad_request' }
        case 'ph:observation':
          return 'observation' in m ? this.observe(m.observation, tabId) : { error: 'bad_request' }
        case 'ph:problem':
          return 'state' in m ? this.problem(String(m.url), m.state, tabId) : { error: 'bad_request' }
        default:
          return { error: 'bad_request' }
      }
    }
    const m = message as PageRequest
    switch (m.type) {
      case 'ph:get-state':
        return this.view()
      case 'ph:pair':
        return this.pair(String(m.apiOrigin ?? ''), String(m.code ?? ''), String(m.deviceName ?? ''))
      case 'ph:unpair':
        await this.unpair()
        return this.view()
      case 'ph:set-paused-all':
        await this.setPausedAll(m.paused === true)
        return this.view()
      case 'ph:set-revisit':
        await this.setRevisit(m.enabled === true, m.acknowledged === true)
        return this.view()
      case 'ph:resume-revisits':
        if (m.provider === 'chatgpt' || m.provider === 'claude') {
          await this.update(['revisit'], (s) => {
            s.revisit = unblockProvider(s.revisit, m.provider)
          })
          await this.log('info', `Revisits resumed for ${m.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}.`)
          await this.refreshBadge()
        }
        return this.view()
      case 'ph:sync-now':
        await this.catchUp('manual')
        return this.view()
      case 'ph:track':
        return this.track(String(m.url ?? ''))
      default:
        return { error: 'bad_request' }
    }
  }

  private async hello(url: string, tabId: number | undefined): Promise<HelloResponse> {
    const ref = captureParseConversationUrl(url)
    if (!ref) return { collect: false, mode: 'passive', reason: 'not_conversation' }
    const { pairing, selection, settings, revisit } = await this.read(['pairing', 'selection', 'settings', 'revisit'])
    const mode = collectorForTab(revisit, tabId) ? 'revisit' : 'passive'
    if (!pairing) return { collect: false, mode, reason: 'not_paired' }
    if (pairing.authFailedAt !== null) return { collect: false, mode, reason: 'auth_failed' }
    if (settings.pausedAll) return { collect: false, mode, reason: 'paused_all' }
    let item = findSelected(selection.items, ref)
    if (!item && this.clock() - this.lastHelloSync > TIMING.helloResyncMs) {
      // The owner may have just selected it on the dashboard.
      this.lastHelloSync = this.clock()
      await this.syncSelection()
      const fresh = await this.read(['pairing', 'selection'])
      if (!this.usablePairing(fresh.pairing)) return { collect: false, mode, reason: 'auth_failed' }
      item = findSelected(fresh.selection.items, ref)
    }
    if (!item) return { collect: false, mode, reason: 'not_selected' }
    if (item.captureState !== 'active') return { collect: false, mode, reason: 'not_active' }
    return { collect: true, mode }
  }

  private async observe(observation: PageObservation, tabId: number | undefined): Promise<ObservationResponse> {
    if (!observation || typeof observation !== 'object' || !Array.isArray(observation.messages)) {
      return { accepted: false, queued: 0 }
    }
    const ref = captureParseConversationUrl(String(observation.url))
    const { pairing, selection, settings, revisit } = await this.read(['pairing', 'selection', 'settings', 'revisit'])
    const item = ref ? findSelected(selection.items, ref) : undefined
    const collector = collectorForTab(revisit, tabId)
    if (!ref || !item || item.captureState !== 'active' || !this.usablePairing(pairing) || settings.pausedAll) {
      if (collector) await this.closeCollector(collector, 'Revisit ended: the conversation is not being collected.')
      return { accepted: false, queued: 0 }
    }
    const mode = collector ? 'revisit' : 'passive'
    const now = this.clock()
    // Shape check before building; the endpoint schema validates everything again below.
    const messages = observation.messages.filter(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        typeof m.text === 'string' &&
        (m.role === 'user' || m.role === 'assistant') &&
        (m.key === undefined || typeof m.key === 'string') &&
        (m.orderHint === undefined || typeof m.orderHint === 'number'),
    )
    const built = buildSnapshots({
      provider: ref.provider,
      externalId: ref.externalId,
      canonicalUrl: ref.canonicalUrl,
      observation: {
        ...observation,
        messages,
        observedFirstMessage: observation.observedFirstMessage === true,
        observedLastMessage: observation.observedLastMessage === true,
        streamingInProgress: observation.streamingInProgress === true,
        renderedCount: Number.isInteger(observation.renderedCount) ? Math.max(0, observation.renderedCount) : 0,
        capturedAt: safeInstant(observation.capturedAt, now),
      },
      mode,
      extensionVersion: this.chrome.version,
      newId: this.newId,
    })
    const items: UploadItem[] = []
    for (const snapshot of built.snapshots) {
      const parsed = CaptureSnapshotSchema.safeParse(snapshot)
      if (!parsed.success) continue // never send what the endpoint would reject
      items.push({
        id: this.newId(),
        kind: 'snapshot',
        conversationKey: conversationKey(ref),
        sessionId: typeof observation.sessionId === 'string' ? observation.sessionId.slice(0, 64) : null,
        body: parsed.data,
        bytes: snapshotBodyBytes(parsed.data),
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        lastError: null,
      })
    }
    const queued = await this.update(['queue', 'conversations', 'log'], (s) => {
      const result = enqueue(s.queue, items, now)
      s.queue = result.queue
      const status = s.conversations[item.id] ?? emptyConversationStatus()
      s.conversations[item.id] = { ...status, lastCapturedAt: now }
      if (built.oversized > 0) {
        s.log = appendLog(s.log, {
          at: now,
          kind: 'warning',
          text: `${built.oversized} message(s) were longer than 200,000 characters and were not sent.`,
        })
      }
      const lost = result.dropped.length
      if (lost > 0) {
        s.log = appendLog(s.log, {
          at: now,
          kind: 'warning',
          text: `Upload queue full or stale: ${lost} older capture(s) dropped (they will be recaptured on a later visit).`,
        })
      }
      return s.queue.length
    })
    await this.flushQueue()
    if (collector) {
      await this.closeCollector(collector, `Revisit captured ${observation.messages.length} rendered message(s).`)
    }
    await this.refreshBadge()
    return { accepted: items.length > 0, queued }
  }

  private async problem(url: string, state: CaptureProblemState, tabId: number | undefined): Promise<{ ok: boolean }> {
    if (state !== 'signed_out' && state !== 'challenge' && state !== 'structure_changed') return { ok: false }
    const ref = captureParseConversationUrl(url)
    const { revisit, selection } = await this.read(['revisit', 'selection'])
    const collector = collectorForTab(revisit, tabId)
    const item = ref ? findSelected(selection.items, ref) : undefined
    if (ref && item) await this.reportProblem(ref, item.id, state, collector ? 'revisit' : 'passive')
    if (collector) {
      await this.closeCollector(collector, `Revisit stopped: ${problemText(state)}.`)
    }
    if (state === 'signed_out' || state === 'challenge') {
      const provider = ref?.provider ?? collector?.provider
      if (provider) await this.blockRevisits(provider, state)
    }
    await this.refreshBadge()
    return { ok: true }
  }

  /** Queue a status report, pause the conversation locally, and upload. */
  private async reportProblem(
    ref: CaptureConversationRef,
    conversationId: string,
    state: CaptureProblemState,
    mode: 'passive' | 'revisit',
  ): Promise<void> {
    const now = this.clock()
    const body: CaptureStatusReport = {
      schemaVersion: 1,
      provider: ref.provider,
      externalId: ref.externalId,
      state,
      mode,
      observedAt: new Date(now).toISOString(),
      extensionVersion: this.chrome.version,
    }
    const parsed = CaptureStatusReportSchema.safeParse(body)
    if (!parsed.success) return
    await this.update(['queue', 'selection', 'conversations', 'log'], (s) => {
      s.queue = enqueue(
        s.queue,
        {
          id: this.newId(),
          kind: 'status',
          conversationKey: conversationKey(ref),
          sessionId: null,
          body: parsed.data,
          bytes: JSON.stringify(parsed.data).length,
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
          lastError: null,
        },
        now,
      ).queue
      // Stop collecting it right away; the next selection sync confirms the server state.
      s.selection.items = s.selection.items.map((i) =>
        i.id === conversationId ? { ...i, captureState: captureStateForProblem(state) } : i,
      )
      const status = s.conversations[conversationId] ?? emptyConversationStatus()
      s.conversations[conversationId] = {
        ...status,
        problem: { state, at: now, provider: ref.provider, externalId: ref.externalId, url: ref.canonicalUrl },
      }
      s.log = appendLog(s.log, {
        at: now,
        kind: 'problem',
        text: `${ref.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} conversation ${ref.externalId.slice(0, 8)}: ${problemText(state)}. Collection paused; saved messages are kept.`,
      })
    })
    await this.flushQueue()
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  async syncSelection(): Promise<void> {
    const { pairing } = await this.read(['pairing'])
    if (!this.usablePairing(pairing)) return
    const res = await this.api(pairing).selection(pairing.token)
    const now = this.clock()
    if (res.ok) {
      const changed = await this.update(['selection', 'conversations', 'pairing'], (s) => {
        if (s.pairing?.token !== pairing.token) return false // re-paired meanwhile
        const before = JSON.stringify(s.selection.items)
        const items = captureSafeSelection(res.data.conversations)
        s.selection = { items, syncedAt: now, error: null }
        const active = new Set(items.map((c) => c.id))
        const next: StoredState['conversations'] = {}
        for (const [id, status] of Object.entries(s.conversations)) {
          if (active.has(id)) {
            // Active again (the owner chose Reconnect/Resume): no open problem.
            next[id] = { ...status, problem: null }
          } else if (status.problem && now - status.problem.at < PROBLEM_TTL_MS) {
            next[id] = status // still paused on the dashboard (or removed): shown for a day
          }
        }
        s.conversations = next
        return before !== JSON.stringify(s.selection.items)
      })
      if (changed) await this.notifyPages()
      return
    }
    if (res.status === 401 || (res.status === 403 && res.error.startsWith('origin_'))) {
      await this.markAuthFailed(res.status === 401 ? 'revoked' : 'origin')
      return
    }
    // Keep the last known selection; never replace it with an empty list on failure.
    await this.update(['selection'], (s) => {
      s.selection = { ...s.selection, error: res.error }
    })
  }

  private async markAuthFailed(reason: 'revoked' | 'origin'): Promise<void> {
    const now = this.clock()
    const already = await this.update(['pairing', 'log'], (s) => {
      if (!s.pairing || s.pairing.authFailedAt !== null) return true
      s.pairing = { ...s.pairing, authFailedAt: now, authFailure: reason }
      s.log = appendLog(s.log, {
        at: now,
        kind: 'problem',
        text:
          reason === 'revoked'
            ? 'The dashboard no longer accepts this browser (revoked or unknown). Pair again from the options page.'
            : 'The dashboard refused this extension’s origin (was it reloaded from another folder?). Pair again.',
      })
      return false
    })
    if (!already) {
      await this.closeAllCollectors('Revisit stopped: this browser is no longer paired.')
      await this.refreshBadge()
    }
  }

  /** Ask open ChatGPT/Claude tabs to re-check whether they should collect. */
  private async notifyPages(): Promise<void> {
    let tabs: { id?: number }[] = []
    try {
      tabs = await this.chrome.tabsQuery(PROVIDER_TABS)
    } catch {
      return
    }
    await Promise.all(
      tabs
        .filter((t): t is { id: number } => typeof t.id === 'number')
        .map((t) => this.chrome.tabsSendMessage(t.id, { type: 'ph:recheck' }).catch(() => undefined)),
    )
  }

  // -------------------------------------------------------------------------
  // Upload queue
  // -------------------------------------------------------------------------

  flushQueue(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushLoop().finally(() => {
        this.flushing = null
      })
    }
    return this.flushing
  }

  private async flushLoop(): Promise<void> {
    for (let i = 0; i < TIMING.maxUploadsPerFlush; i++) {
      const { pairing, queue } = await this.read(['pairing', 'queue'])
      if (!this.usablePairing(pairing)) return
      const item = dueItems(queue, this.clock())[0]
      if (!item) return
      const api = this.api(pairing)
      const res = item.kind === 'snapshot' ? await api.snapshot(pairing.token, item.body) : await api.status(pairing.token, item.body)
      const now = this.clock()
      const disposition = res.ok ? 'done' : classifyUpload(res.status, res.error)
      if (disposition === 'unauthorized' || disposition === 'forbidden_origin') {
        await this.markAuthFailed(disposition === 'unauthorized' ? 'revoked' : 'origin')
        return
      }
      let resync = false
      await this.update(['queue', 'conversations', 'selection', 'log'], (s) => {
        const conversation = s.selection.items.find((c) => conversationKey(c) === item.conversationKey)
        const status: ConversationStatus | null = conversation
          ? (s.conversations[conversation.id] ?? emptyConversationStatus())
          : null
        switch (disposition) {
          case 'done': {
            s.queue = removeItem(s.queue, item.id)
            if (conversation && status) {
              const result = res.ok && item.kind === 'snapshot' ? (res.data as { outcome?: string; newMessages?: number; newVersions?: number }) : null
              s.conversations[conversation.id] = {
                ...status,
                lastUploadAt: now,
                lastResult: result
                  ? `${result.outcome}: ${result.newMessages ?? 0} new, ${result.newVersions ?? 0} edited`
                  : 'status reported',
              }
            }
            break
          }
          case 'retry':
            s.queue = markFailed(s.queue, item.id, now, res.ok ? 'unknown' : res.error, res.ok ? null : parseRetryAfter(res.retryAfter, now))
            break
          case 'deselected':
            s.queue = removeItem(s.queue, item.id)
            resync = true
            s.log = appendLog(s.log, {
              at: now,
              kind: 'info',
              text: 'A capture was not accepted because the conversation is no longer selected or active.',
            })
            break
          case 'drop':
            s.queue = removeItem(s.queue, item.id)
            s.log = appendLog(s.log, {
              at: now,
              kind: 'warning',
              text: `The dashboard rejected a capture (${res.ok ? 'unknown' : res.error}); it was discarded.`,
            })
            break
        }
      })
      if (resync) await this.syncSelection()
      // Offline or the dashboard is failing: stop here; the next tick retries with backoff.
      if (disposition === 'retry') return
    }
  }

  // -------------------------------------------------------------------------
  // Revisits (opt-in prototype)
  // -------------------------------------------------------------------------

  async revisitStep(): Promise<void> {
    if (this.revisiting) return
    this.revisiting = true
    try {
      const { settings, pairing } = await this.read(['settings', 'pairing'])
      if (!settings.revisitEnabled || settings.pausedAll || !this.usablePairing(pairing)) {
        await this.closeAllCollectors('Revisit tab closed: revisits are off or paused.')
        return
      }
      const now = this.clock()
      const { revisit } = await this.read(['revisit'])
      for (const c of expiredCollectors(revisit, now)) {
        await this.closeCollector(c, 'Revisit timed out: the page did not finish rendering; it was closed.')
      }
      const tasks = await this.update(['revisit', 'selection', 'conversations'], (s) => {
        const captured: Record<string, number> = {}
        for (const [id, status] of Object.entries(s.conversations)) {
          if (status.lastCapturedAt !== null) captured[id] = status.lastCapturedAt
        }
        s.revisit = planRevisits(s.revisit, s.selection.items, captured, now)
        return nextToOpen(s.revisit)
      })
      for (const task of tasks) {
        const ref = captureParseConversationUrl(task.url)
        if (!ref || ref.provider !== task.provider) continue // never open anything else
        let tabId: number | undefined
        try {
          tabId = (await this.chrome.tabsCreateBackground(ref.canonicalUrl)).id
        } catch {
          tabId = undefined
        }
        if (tabId === undefined) {
          await this.log('warning', 'Could not open a revisit tab.')
          continue
        }
        const openedTab = tabId
        await this.update(['revisit', 'log'], (s) => {
          s.revisit = startCollector(s.revisit, task, openedTab, now)
          s.log = appendLog(s.log, {
            at: now,
            kind: 'info',
            text: `Revisit: opened a ${task.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} conversation in a background tab.`,
          })
        })
        await this.chrome.tabsKeepAlive(openedTab).catch(() => undefined)
      }
    } finally {
      this.revisiting = false
    }
  }

  private async closeCollector(collector: RevisitCollector, text: string): Promise<void> {
    const found = await this.update(['revisit', 'log'], (s) => {
      if (!collectorForTab(s.revisit, collector.tabId)) return false
      s.revisit = finishCollector(s.revisit, collector.tabId)
      s.log = appendLog(s.log, { at: this.clock(), kind: 'info', text })
      return true
    })
    if (!found) return
    // Only ever close a tab this helper opened (it is in the collector list).
    this.closing.add(collector.tabId)
    await this.chrome.tabsRemove(collector.tabId).catch(() => undefined)
  }

  private async closeAllCollectors(text: string): Promise<void> {
    const { revisit } = await this.read(['revisit'])
    for (const c of revisit.collectors) await this.closeCollector(c, text)
  }

  private async blockRevisits(provider: CaptureProvider, state: 'signed_out' | 'challenge'): Promise<void> {
    await this.update(['revisit', 'log'], (s) => {
      if (s.revisit.blocked[provider]) return
      s.revisit = blockProvider(s.revisit, provider, state, this.clock())
      s.log = appendLog(s.log, {
        at: this.clock(),
        kind: 'problem',
        text: `Revisits stopped for ${provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}: ${problemText(state)}. Sign in yourself, then resume them in the popup.`,
      })
    })
    const { revisit } = await this.read(['revisit'])
    for (const c of revisit.collectors.filter((c) => c.provider === provider)) {
      await this.closeCollector(c, 'Revisit tab closed.')
    }
  }

  async onTabUpdated(tabId: number, status: string | undefined, url: string | undefined): Promise<void> {
    if (status !== 'complete') return
    const { revisit, selection } = await this.read(['revisit', 'selection'])
    const collector = collectorForTab(revisit, tabId)
    if (!collector) return
    if (classifyCollectorNavigation(collector.provider, url) !== 'signed_out') return
    // Redirected to a sign-in page (or off the site): report, close, stop revisits for this service.
    const ref = captureParseConversationUrl(collector.url)
    const item = ref ? findSelected(selection.items, ref) : undefined
    if (ref && item) await this.reportProblem(ref, item.id, 'signed_out', 'revisit')
    await this.closeCollector(collector, 'Revisit stopped: the page went to a sign-in screen.')
    await this.blockRevisits(collector.provider, 'signed_out')
    await this.refreshBadge()
  }

  async onTabRemoved(tabId: number): Promise<void> {
    if (this.closing.delete(tabId)) return
    const { revisit } = await this.read(['revisit'])
    const collector = collectorForTab(revisit, tabId)
    if (!collector) return
    await this.update(['revisit', 'log'], (s) => {
      s.revisit = finishCollector(s.revisit, tabId)
      s.log = appendLog(s.log, { at: this.clock(), kind: 'info', text: 'A revisit tab was closed before it finished.' })
    })
    await this.refreshBadge()
  }

  // -------------------------------------------------------------------------
  // Owner actions (popup / options)
  // -------------------------------------------------------------------------

  async pair(apiOriginInput: string, codeInput: string, deviceNameInput: string): Promise<PairResult> {
    const fail = (error: string): PairResult => ({ ok: false, error, message: PAIR_ERRORS[error] ?? 'Pairing failed.' })
    const origin = normalizeDashboardOrigin(apiOriginInput)
    if (!origin) return fail('invalid_origin')
    const code = captureNormalizePairingCode(codeInput)
    if (!code) return fail('invalid_code')
    const deviceName = deviceNameInput.replace(/\s+/g, ' ').trim()
    if (deviceName.length < 1 || deviceName.length > 60 || /[\p{Cc}\p{Cf}]/u.test(deviceName)) {
      return fail('invalid_device_name')
    }
    if (!(await this.chrome.hasHostPermission(originPermissionPattern(origin)))) return fail('permission_missing')

    const res = await this.api({ apiOrigin: origin }).pair(code, deviceName)
    if (!res.ok) return fail(res.status === 401 ? 'invalid_or_expired_code' : res.status === 403 ? 'extension_origin_required' : res.error)
    const now = this.clock()
    const dashboardOrigin = normalizeDashboardOrigin(res.data.dashboardOrigin) ?? origin
    await this.update(['pairing', 'queue', 'selection', 'conversations', 'revisit', 'log'], (s) => {
      if (s.pairing?.apiOrigin !== origin) {
        // Never send captures queued for one dashboard to another.
        s.queue = []
        s.selection = { items: [], syncedAt: null, error: null }
        s.conversations = {}
        s.revisit = { ...emptyRevisitState(), collectors: s.revisit.collectors }
      }
      s.pairing = {
        apiOrigin: origin,
        dashboardOrigin,
        token: res.data.token,
        deviceId: res.data.deviceId,
        deviceName,
        pairedAt: now,
        authFailedAt: null,
        authFailure: null,
      }
      s.log = appendLog(s.log, { at: now, kind: 'info', text: `Paired with ${origin} as “${deviceName}”.` })
    })
    await this.ensureAlarm()
    await this.syncSelection()
    await this.flushQueue()
    await this.refreshBadge()
    return { ok: true, state: await this.view() }
  }

  async unpair(): Promise<void> {
    await this.closeAllCollectors('Revisit tab closed: unpaired.')
    await this.update(['pairing', 'queue', 'selection', 'conversations', 'revisit', 'log'], (s) => {
      s.pairing = null
      s.queue = []
      s.selection = { items: [], syncedAt: null, error: null }
      s.conversations = {}
      s.revisit = emptyRevisitState()
      s.log = appendLog(s.log, {
        at: this.clock(),
        kind: 'info',
        text: 'Unpaired: the token and queued captures were deleted from this browser. Revoke the browser in Settings → Chrome helper too.',
      })
    })
    await this.notifyPages()
    await this.refreshBadge()
  }

  async setPausedAll(paused: boolean): Promise<void> {
    await this.update(['settings', 'log'], (s) => {
      s.settings = { ...s.settings, pausedAll: paused }
      s.log = appendLog(s.log, {
        at: this.clock(),
        kind: 'info',
        text: paused ? 'Paused: nothing is collected until you resume.' : 'Resumed collecting.',
      })
    })
    if (paused) await this.closeAllCollectors('Revisit tab closed: paused.')
    await this.notifyPages()
    await this.refreshBadge()
  }

  async setRevisit(enabled: boolean, acknowledged: boolean): Promise<void> {
    if (enabled && !acknowledged) return // the terms-of-use note must be acknowledged first
    await this.update(['settings', 'revisit', 'log'], (s) => {
      s.settings = {
        ...s.settings,
        revisitEnabled: enabled,
        revisitAcknowledgedAt: enabled ? this.clock() : s.settings.revisitAcknowledgedAt,
      }
      if (!enabled) s.revisit = { ...s.revisit, queue: [] }
      s.log = appendLog(s.log, {
        at: this.clock(),
        kind: 'info',
        text: enabled ? 'Background revisits (prototype) switched on.' : 'Background revisits switched off.',
      })
    })
    if (enabled) await this.revisitStep()
    else await this.closeAllCollectors('Revisit tab closed: revisits switched off.')
    await this.refreshBadge()
  }

  private async track(url: string): Promise<{ ok: boolean; error?: string }> {
    const ref = captureParseConversationUrl(url)
    if (!ref) return { ok: false, error: 'not_conversation' }
    const { pairing } = await this.read(['pairing'])
    if (!pairing) return { ok: false, error: 'not_paired' }
    const target = new URL('/projects/attach', pairing.dashboardOrigin)
    target.searchParams.set('url', ref.canonicalUrl)
    this.lastHelloSync = 0 // the next page check re-syncs right away
    await this.chrome.openPage(target.toString())
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  async refreshBadge(): Promise<void> {
    const { pairing, settings, queue, conversations, revisit } = await this.read([
      'pairing',
      'settings',
      'queue',
      'conversations',
      'revisit',
    ])
    const now = this.clock()
    const attention =
      Object.values(conversations).filter((c) => c.problem !== null && now - c.problem.at < PROBLEM_TTL_MS).length +
      Object.keys(revisit.blocked).length
    await this.chrome
      .setBadge(
        computeBadge({
          paired: pairing !== null,
          authFailed: pairing?.authFailedAt != null,
          pausedAll: settings.pausedAll,
          attention,
          queued: queue.length,
          revisitCollecting: revisit.collectors.length > 0,
        }),
      )
      .catch(() => undefined)
  }

  async view(): Promise<HelperStateView> {
    const s = await this.read(['pairing', 'selection', 'settings', 'queue', 'conversations', 'revisit', 'log'])
    const nextRetry = s.queue.length > 0 ? Math.min(...s.queue.map((q) => q.nextAttemptAt)) : null
    return {
      paired: s.pairing !== null,
      apiOrigin: s.pairing?.apiOrigin ?? null,
      dashboardOrigin: s.pairing?.dashboardOrigin ?? null,
      deviceName: s.pairing?.deviceName ?? null,
      pairedAt: s.pairing?.pairedAt ?? null,
      authFailed: s.pairing?.authFailedAt != null,
      pausedAll: s.settings.pausedAll,
      selectionSyncedAt: s.selection.syncedAt,
      selectionError: s.selection.error,
      conversations: [
        ...s.selection.items.map((i) => {
          const status = s.conversations[i.id]
          return {
            id: i.id,
            provider: i.provider,
            externalId: i.externalId,
            url: i.url,
            captureState: i.captureState,
            lastUploadAt: status?.lastUploadAt ?? null,
            lastResult: status?.problem ? problemText(status.problem.state) : (status?.lastResult ?? null),
          }
        }),
        // Reported problems for conversations the dashboard no longer lists as active.
        ...Object.entries(s.conversations)
          .filter(([id, c]) => c.problem !== null && !s.selection.items.some((i) => i.id === id))
          .map(([id, c]) => ({
            id,
            provider: c.problem!.provider,
            externalId: c.problem!.externalId,
            url: c.problem!.url,
            captureState: captureStateForProblem(c.problem!.state),
            lastUploadAt: c.lastUploadAt,
            lastResult: `${problemText(c.problem!.state)} — choose Reconnect on the dashboard`,
          })),
      ],
      queued: s.queue.length,
      nextRetryAt: nextRetry,
      revisit: {
        enabled: s.settings.revisitEnabled,
        acknowledgedAt: s.settings.revisitAcknowledgedAt,
        blocked: s.revisit.blocked,
        collectors: s.revisit.collectors.map((c) => ({
          provider: c.provider,
          conversationId: c.conversationId,
          url: c.url,
          openedAt: c.openedAt,
        })),
        queued: s.revisit.queue.length,
      },
      log: s.log,
      extensionVersion: this.chrome.version,
    }
  }
}

function problemText(state: CaptureProblemState): string {
  switch (state) {
    case 'signed_out':
      return 'signed out'
    case 'challenge':
      return 'a verification check was shown (not clicked)'
    case 'structure_changed':
      return 'the page no longer looks as expected'
  }
}

/** The content script's clock, but never in the future. */
function safeInstant(value: unknown, now: number): string {
  const t = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return new Date(Number.isNaN(t) ? now : Math.min(t, now)).toISOString()
}
