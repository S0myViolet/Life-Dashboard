/**
 * The draft sync engine (browser only). One instance per page load.
 *
 *   edit()  → memory now, IndexedDB within ~150 ms ("Saved on this device"), sync after ~1 s idle
 *   sync    → one draft at a time through the kind's transport (a Server Action)
 *   failure → exponential retry, and immediately when the browser comes back online or the tab
 *             becomes visible again ("Waiting to sync")
 *   reload  → drafts are read back from IndexedDB and reconciled with the server's version
 *
 * The engine is the single owner of draft records; editors render what it reports. It never logs
 * draft content.
 */
import { idbDelete, idbGetAll, idbPut, openDraftsDb } from './idb'
import {
  draftAfterSend,
  draftIndicator,
  draftOnLoad,
  draftResolve,
  newDraft,
  type ConflictChoice,
  type DraftContentAdapter,
  type DraftKind,
  type DraftRecord,
  type DraftSendResult,
  type ServerSnapshot,
  type SyncIndicator,
} from './logic'

export interface DraftTransport<C> extends DraftContentAdapter<C> {
  empty: C
  send(draft: DraftRecord<C>): Promise<DraftSendResult<C>>
}

export interface DraftSnapshot<C> {
  key: string
  /** The local draft, or null when everything is on the server. */
  draft: DraftRecord<C> | null
  /** Latest server state this page knows about. */
  server: ServerSnapshot<C> | null
  /** What the editor shows. */
  value: C
  indicator: SyncIndicator
  /** Local text not yet written to IndexedDB. */
  persisting: boolean
}

type Listener = (snapshot: DraftSnapshot<unknown>) => void

const PERSIST_DELAY_MS = 150
const SYNC_DELAY_MS = 1_000

export function draftKey(kind: DraftKind, targetId: string): string {
  return `${kind}:${targetId}`
}

class DraftEngine {
  private drafts = new Map<string, DraftRecord<unknown>>()
  private servers = new Map<string, ServerSnapshot<unknown> | null>()
  private transports = new Map<DraftKind, DraftTransport<unknown>>()
  private listeners = new Map<string, Set<Listener>>()
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private persistChain = new Map<string, Promise<void>>()
  private unpersisted = new Set<string>()
  private persisted = true
  private loading: Promise<void> | null = null
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private syncRunning: Promise<void> | null = null
  private syncAgain = false
  private started = false

  register<C>(kind: DraftKind, transport: DraftTransport<C>): void {
    this.transports.set(kind, transport as DraftTransport<unknown>)
    this.start()
  }

  private start() {
    if (this.started || typeof window === 'undefined') return
    this.started = true
    window.addEventListener('online', () => this.syncSoon(0))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.syncSoon(0)
      else this.flushPersist()
    })
    window.addEventListener('pagehide', () => this.flushPersist())
  }

  /** Read every stored draft once. */
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const db = await openDraftsDb()
        this.persisted = db !== null
        const stored = await idbGetAll<DraftRecord<unknown>>('drafts')
        for (const d of stored) {
          // The store also holds other device-only records (e.g. transcript review edits).
          if (!d || typeof d.key !== 'string' || (d.kind !== 'note' && d.kind !== 'journal')) continue
          if (!this.drafts.has(d.key)) this.drafts.set(d.key, d)
        }
      })()
    }
    return this.loading
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) this.listeners.set(key, (set = new Set()))
    set.add(listener)
    return () => set!.delete(listener)
  }

  snapshot<C>(kind: DraftKind, targetId: string): DraftSnapshot<C> {
    const key = draftKey(kind, targetId)
    const draft = (this.drafts.get(key) ?? null) as DraftRecord<C> | null
    const server = (this.servers.get(key) ?? null) as ServerSnapshot<C> | null
    const transport = this.transports.get(kind) as DraftTransport<C> | undefined
    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false
    const persisting = this.unpersisted.has(key)
    let indicator = draftIndicator(draft, { persisted: this.persisted, online })
    if (persisting && indicator === 'saved_local') indicator = 'saving'
    return {
      key,
      draft,
      server,
      value: (draft?.value ?? server?.content ?? transport?.empty) as C,
      indicator,
      persisting,
    }
  }

  private notify(key: string) {
    const set = this.listeners.get(key)
    if (!set || set.size === 0) return
    const [kind, ...rest] = key.split(':')
    const snap = this.snapshot(kind as DraftKind, rest.join(':'))
    for (const l of set) l(snap)
  }

  private transportFor<C>(kind: DraftKind): DraftTransport<C> {
    const t = this.transports.get(kind)
    if (!t) throw new Error(`no draft transport registered for ${kind}`)
    return t as DraftTransport<C>
  }

  private setDraft(key: string, draft: DraftRecord<unknown> | null, persistNow = false) {
    if (draft) this.drafts.set(key, draft)
    else this.drafts.delete(key)
    this.schedulePersist(key, persistNow ? 0 : PERSIST_DELAY_MS)
  }

  private schedulePersist(key: string, delay: number) {
    this.unpersisted.add(key)
    const existing = this.persistTimers.get(key)
    if (existing) clearTimeout(existing)
    this.persistTimers.set(
      key,
      setTimeout(() => void this.persist(key), delay),
    )
  }

  private persist(key: string): Promise<void> {
    const timer = this.persistTimers.get(key)
    if (timer) clearTimeout(timer)
    this.persistTimers.delete(key)
    const previous = this.persistChain.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      const draft = this.drafts.get(key)
      if (draft) {
        const ok = await idbPut('drafts', draft)
        if (!ok) this.persisted = false
      } else {
        await idbDelete('drafts', key)
      }
      if (!this.persistTimers.has(key)) this.unpersisted.delete(key)
      this.notify(key)
    })
    this.persistChain.set(key, next)
    return next
  }

  private flushPersist() {
    for (const key of [...this.persistTimers.keys()]) void this.persist(key)
  }

  /**
   * Called when an editor mounts or receives new server props: reconcile any stored draft with
   * the server's version (merge cleanly or mark a conflict) and start syncing it.
   */
  async open<C>(kind: DraftKind, targetId: string, server: ServerSnapshot<C> | null): Promise<DraftSnapshot<C>> {
    await this.load()
    const key = draftKey(kind, targetId)
    const transport = this.transportFor<C>(kind)
    const known = this.servers.get(key) as ServerSnapshot<C> | null | undefined
    // Never step back to an older (or absent) server snapshot than one a sync already returned.
    if (known === undefined || (server && (!known || server.version >= known.version))) {
      this.servers.set(key, server)
    }
    const current = (this.servers.get(key) ?? null) as ServerSnapshot<C> | null
    const draft = this.drafts.get(key) as DraftRecord<C> | undefined
    const decision = draftOnLoad(draft, current, transport, Date.now())
    if (decision.use === 'server') {
      if (decision.discard) this.setDraft(key, null, true)
    } else if (decision.draft !== draft) {
      this.setDraft(key, decision.draft as DraftRecord<unknown>, true)
    }
    this.notify(key)
    if (this.drafts.get(key)?.state === 'pending') this.syncSoon(SYNC_DELAY_MS)
    return this.snapshot<C>(kind, targetId)
  }

  /** The owner changed the text. */
  edit<C>(kind: DraftKind, targetId: string, value: C): void {
    const key = draftKey(kind, targetId)
    const transport = this.transportFor<C>(kind)
    const now = Date.now()
    const existing = this.drafts.get(key) as DraftRecord<C> | undefined
    const server = (this.servers.get(key) ?? null) as ServerSnapshot<C> | null
    let draft: DraftRecord<C>
    if (existing) {
      draft = { ...existing, value, updatedAt: now }
      if (draft.state === 'rejected') draft = { ...draft, state: 'pending', lastError: null, attempts: 0 }
    } else {
      if (server && transport.equal(server.content, value)) return
      draft = newDraft(kind, targetId, server, transport.empty, value, now)
    }
    this.setDraft(key, draft as DraftRecord<unknown>)
    this.notify(key)
    if (draft.state === 'pending') this.syncSoon(SYNC_DELAY_MS)
  }

  resolve<C>(kind: DraftKind, targetId: string, choice: ConflictChoice<C>): void {
    const key = draftKey(kind, targetId)
    const draft = this.drafts.get(key) as DraftRecord<C> | undefined
    if (!draft) return
    let next: DraftRecord<C>
    if (draft.state === 'deleted_remotely') {
      // "Restore": create the note again with the same id and this device's text.
      next = { ...draft, baseVersion: 0, state: 'pending', attempts: 0, nextAttemptAt: null, conflict: null }
      this.servers.set(key, null)
    } else {
      next = draftResolve(draft, choice, Date.now())
    }
    this.setDraft(key, next as DraftRecord<unknown>, true)
    this.notify(key)
    this.syncSoon(0)
  }

  /** Drop local changes (e.g. "Keep saved version" of a deleted note, or after a delete). */
  discard(kind: DraftKind, targetId: string): void {
    const key = draftKey(kind, targetId)
    this.setDraft(key, null, true)
    // Used after a delete (here or elsewhere): forget the server copy too, so returning to this
    // page never shows a note that no longer exists.
    this.servers.delete(key)
    this.notify(key)
  }

  /** Adopt a server snapshot returned by another action (e.g. adding a transcript). */
  observeServer<C>(kind: DraftKind, targetId: string, server: ServerSnapshot<C>): void {
    void this.open(kind, targetId, server)
  }

  syncSoon(delayMs: number): void {
    if (typeof window === 'undefined') return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.syncAll()
    }, delayMs)
  }

  /** Sync every due draft, one at a time. Resolves when this pass is finished. */
  syncAll(force = false): Promise<void> {
    if (this.syncRunning) {
      this.syncAgain = true
      return this.syncRunning
    }
    this.syncRunning = (async () => {
      try {
        await this.load()
        let passes = 0
        do {
          this.syncAgain = false
          passes++
          for (const key of [...this.drafts.keys()]) {
            const draft = this.drafts.get(key)
            if (!draft || draft.state !== 'pending') continue
            if (!this.transports.has(draft.kind)) continue
            if (!force && draft.nextAttemptAt !== null && draft.nextAttemptAt > Date.now()) continue
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
              this.notify(key)
              continue
            }
            await this.syncOne(key)
          }
        } while (this.syncAgain && passes < 5)
      } finally {
        this.syncRunning = null
        this.scheduleRetry()
      }
    })()
    return this.syncRunning
  }

  private scheduleRetry() {
    let earliest: number | null = null
    for (const d of this.drafts.values()) {
      if (d.state !== 'pending' || !this.transports.has(d.kind)) continue
      const at = d.nextAttemptAt ?? Date.now()
      earliest = earliest === null ? at : Math.min(earliest, at)
    }
    if (earliest !== null && !this.syncTimer) this.syncSoon(Math.max(250, earliest - Date.now()))
  }

  private async syncOne(key: string): Promise<void> {
    const draft = this.drafts.get(key)
    if (!draft) return
    const transport = this.transportFor<unknown>(draft.kind)
    const sent = { value: draft.value, baseVersion: draft.baseVersion }
    let result: DraftSendResult<unknown>
    try {
      result = await transport.send(draft)
    } catch {
      result = { status: 'retry', code: 'network' }
    }
    const current = this.drafts.get(key)
    if (!current) return
    const after = draftAfterSend(current, sent, result, transport, Date.now())
    if (after.action === 'delete') {
      this.servers.set(key, after.server)
      this.setDraft(key, null, true)
    } else {
      if (after.server) this.servers.set(key, after.server)
      this.setDraft(key, after.draft, true)
      if (after.syncNow) this.syncAgain = true
    }
    this.notify(key)
  }

  /**
   * Send this draft now and wait. Resolves true when nothing local is left unsynced for it
   * (used before actions that must build on the saved text, like adding a transcript).
   */
  async flush(kind: DraftKind, targetId: string): Promise<boolean> {
    const key = draftKey(kind, targetId)
    await this.persist(key)
    const draft = this.drafts.get(key)
    if (!draft) return true
    if (draft.state !== 'pending') return false
    this.drafts.set(key, { ...draft, nextAttemptAt: null })
    if (this.syncRunning) await this.syncRunning
    await this.syncAll(true)
    if (this.syncRunning) await this.syncRunning
    return !this.drafts.has(key)
  }

  /**
   * Drafts that need the owner's attention: a sync already failed (or the device is offline), a
   * conflict, a note deleted elsewhere, or rejected content. A draft that is simply about to sync
   * is not listed, so the notice does not flicker while typing.
   */
  attentionKeys(): string[] {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    return [...this.drafts.values()]
      .filter((d) => d.state !== 'pending' || d.attempts > 0 || offline)
      .map((d) => d.key)
  }
}

let engine: DraftEngine | null = null

export function getDraftEngine(): DraftEngine {
  if (!engine) engine = new DraftEngine()
  return engine
}

export type { DraftEngine }
