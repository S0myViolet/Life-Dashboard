/**
 * Offline drafts for notes and journal text: the pure decisions, kept free of IndexedDB and
 * React so they can be unit-tested.
 *
 * A draft is the owner's local text plus the server version (and content) it was based on. It is
 * written to the device first ("Saved on this device"), then synced. A sync either lands, is
 * retried later ("Waiting to sync"), or meets a newer server version. In that case a field-level
 * three-way merge decides: if no field was changed on both sides, the merge is applied and synced;
 * otherwise the owner chooses (keep this device's / keep saved / merge). Nothing is overwritten
 * silently and the local text is never dropped until the server has it.
 */

export type DraftKind = 'note' | 'journal'

export type DraftState =
  /** Local changes not yet on the server. */
  | 'pending'
  /** The server moved on and both sides changed the same field: the owner must choose. */
  | 'conflict'
  /** The note was deleted on another device; the local text is kept until the owner decides. */
  | 'deleted_remotely'
  /** The server refused the content (validation). Kept locally; not retried automatically. */
  | 'rejected'

export interface DraftRecord<C> {
  /** 'note:<uuid>' or 'journal:<YYYY-MM-DD>'. */
  key: string
  kind: DraftKind
  /** Note id or journal local date. */
  targetId: string
  /** Server version `value` is based on; 0 = not on the server yet. */
  baseVersion: number
  /** Server content at `baseVersion` (the merge base). */
  base: C
  /** The owner's local content. */
  value: C
  state: DraftState
  /** Failed sync attempts since the last success (drives backoff). */
  attempts: number
  /** Epoch ms of the next automatic attempt; null = as soon as possible. */
  nextAttemptAt: number | null
  /** A short code (never content) for the last failure. */
  lastError: string | null
  /** Set when state is 'conflict'. */
  conflict: { server: C; serverVersion: number; fields: string[]; proposal: C } | null
  updatedAt: number
}

export interface DraftContentAdapter<C> {
  /**
   * When the server has nothing for a draft that was based on a saved version: recreate it
   * (journal days) instead of asking the owner (notes deleted on another device).
   */
  recreateWhenMissing?: boolean
  equal(a: C, b: C): boolean
  merge(base: C, mine: C, theirs: C): { status: 'clean'; merged: C } | { status: 'conflict'; fields: string[]; proposal: C }
}

export interface ServerSnapshot<C> {
  version: number
  content: C
}

/** What the sync transport reported for one attempt. */
export type DraftSendResult<C> =
  | { status: 'saved'; server: ServerSnapshot<C> }
  | { status: 'conflict'; server: ServerSnapshot<C> }
  | { status: 'not_found' }
  | { status: 'invalid' }
  /** Offline, timeout, 5xx, signed out, deploy skew: try again later. */
  | { status: 'retry'; code: string }

export type SyncIndicator = 'synced' | 'saving' | 'saved_local' | 'waiting' | 'conflict' | 'rejected' | 'not_saved'

export const SYNC_INDICATOR_LABELS: Record<SyncIndicator, string> = {
  synced: 'Synced',
  /** Transient (≈150 ms): being written to this device. */
  saving: 'Saving…',
  saved_local: 'Saved on this device',
  waiting: 'Waiting to sync',
  conflict: 'Changed elsewhere — choose a version',
  rejected: 'Not synced — check the text',
  /** Local storage unavailable and not yet synced. */
  not_saved: 'Not saved yet',
}

/** Retry schedule after failed attempts: 2 s, 5 s, 15 s, 30 s, then every minute. */
export function draftRetryDelayMs(attempts: number): number {
  const steps = [2_000, 5_000, 15_000, 30_000]
  if (attempts <= 0) return 0
  return steps[attempts - 1] ?? 60_000
}

export function draftIndicator(
  draft: Pick<DraftRecord<unknown>, 'state' | 'attempts'> | null | undefined,
  o: { persisted: boolean; online: boolean },
): SyncIndicator {
  if (!draft) return 'synced'
  if (draft.state === 'conflict' || draft.state === 'deleted_remotely') return 'conflict'
  if (draft.state === 'rejected') return 'rejected'
  if (!o.online || draft.attempts > 0) return o.persisted ? 'waiting' : 'not_saved'
  return o.persisted ? 'saved_local' : 'not_saved'
}

export function newDraft<C>(
  kind: DraftKind,
  targetId: string,
  server: ServerSnapshot<C> | null,
  empty: C,
  value: C,
  now: number,
): DraftRecord<C> {
  return {
    key: `${kind}:${targetId}`,
    kind,
    targetId,
    baseVersion: server?.version ?? 0,
    base: server?.content ?? empty,
    value,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    conflict: null,
    updatedAt: now,
  }
}

/** Rebase a draft onto a newer server snapshot: merge cleanly, or record a conflict. */
export function draftRebase<C>(
  draft: DraftRecord<C>,
  server: ServerSnapshot<C>,
  adapter: DraftContentAdapter<C>,
  now: number,
): DraftRecord<C> {
  const m = adapter.merge(draft.base, draft.value, server.content)
  if (m.status === 'clean') {
    return {
      ...draft,
      baseVersion: server.version,
      base: server.content,
      value: m.merged,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      conflict: null,
      updatedAt: now,
    }
  }
  return {
    ...draft,
    state: 'conflict',
    conflict: { server: server.content, serverVersion: server.version, fields: m.fields, proposal: m.proposal },
    nextAttemptAt: null,
    updatedAt: now,
  }
}

export type LoadDecision<C> =
  /** No local work: show the server content. `discard` means a stale local draft can be deleted. */
  | { use: 'server'; discard: boolean }
  /** Show (and sync) this draft. */
  | { use: 'draft'; draft: DraftRecord<C> }

/**
 * Reconcile a draft found on the device with what the server sent for the same page.
 * `server` null means the server has no such note/entry (never created, or deleted).
 */
export function draftOnLoad<C>(
  draft: DraftRecord<C> | null | undefined,
  server: ServerSnapshot<C> | null,
  adapter: DraftContentAdapter<C>,
  now: number,
): LoadDecision<C> {
  if (!draft) return { use: 'server', discard: false }
  if (server && adapter.equal(draft.value, server.content)) return { use: 'server', discard: true }
  if (!server) {
    // Created offline (baseVersion 0) and not synced yet: keep it. Based on a version the server
    // no longer has: it was deleted elsewhere; keep the text and let the owner decide.
    if (draft.baseVersion === 0) return { use: 'draft', draft }
    if (adapter.recreateWhenMissing) return { use: 'draft', draft: { ...draft, baseVersion: 0, state: 'pending', conflict: null } }
    return { use: 'draft', draft: { ...draft, state: 'deleted_remotely', nextAttemptAt: null } }
  }
  if (draft.state === 'conflict' && draft.conflict && draft.conflict.serverVersion === server.version) {
    return { use: 'draft', draft }
  }
  if (draft.baseVersion === server.version) {
    return { use: 'draft', draft: draft.state === 'conflict' ? { ...draft, state: 'pending', conflict: null } : draft }
  }
  // The server moved on (or was restored to an older version): merge onto what it has now.
  return { use: 'draft', draft: draftRebase(draft, server, adapter, now) }
}

export type AfterSend<C> =
  /** Everything local is on the server: delete the draft. */
  | { action: 'delete'; server: ServerSnapshot<C> }
  /** Keep the (updated) draft. `syncNow`: send again without waiting (e.g. after a clean rebase). */
  | { action: 'keep'; draft: DraftRecord<C>; syncNow: boolean; server?: ServerSnapshot<C> }

/**
 * Apply one sync attempt's result. `sent` is the value that was sent; the owner may have typed
 * more since (then `current.value` differs and the draft stays pending on the new base).
 */
export function draftAfterSend<C>(
  current: DraftRecord<C>,
  sent: { value: C; baseVersion: number },
  result: DraftSendResult<C>,
  adapter: DraftContentAdapter<C>,
  now: number,
): AfterSend<C> {
  switch (result.status) {
    case 'saved': {
      if (adapter.equal(current.value, sent.value) || adapter.equal(current.value, result.server.content)) {
        return { action: 'delete', server: result.server }
      }
      // Typed more while the request was in flight: keep going from the saved version.
      return {
        action: 'keep',
        syncNow: true,
        server: result.server,
        draft: {
          ...current,
          baseVersion: result.server.version,
          base: result.server.content,
          state: 'pending',
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          conflict: null,
          updatedAt: now,
        },
      }
    }
    case 'conflict': {
      if (adapter.equal(current.value, result.server.content)) return { action: 'delete', server: result.server }
      const rebased = draftRebase(current, result.server, adapter, now)
      return { action: 'keep', draft: rebased, syncNow: rebased.state === 'pending', server: result.server }
    }
    case 'not_found':
      return {
        action: 'keep',
        syncNow: false,
        draft: { ...current, state: 'deleted_remotely', nextAttemptAt: null, updatedAt: now },
      }
    case 'invalid':
      return {
        action: 'keep',
        syncNow: false,
        draft: { ...current, state: 'rejected', lastError: 'invalid', nextAttemptAt: null, updatedAt: now },
      }
    case 'retry': {
      const attempts = current.attempts + 1
      return {
        action: 'keep',
        syncNow: false,
        draft: {
          ...current,
          attempts,
          lastError: result.code,
          nextAttemptAt: now + draftRetryDelayMs(attempts),
          updatedAt: now,
        },
      }
    }
  }
}

export type ConflictChoice<C> =
  | { choice: 'mine' }
  | { choice: 'theirs' }
  | { choice: 'merged'; value: C }

/** Resolve a conflict: the result is always based on the server version the owner has now seen. */
export function draftResolve<C>(draft: DraftRecord<C>, choice: ConflictChoice<C>, now: number): DraftRecord<C> {
  if (!draft.conflict) return draft
  const { server, serverVersion } = draft.conflict
  const value = choice.choice === 'mine' ? draft.value : choice.choice === 'theirs' ? server : choice.value
  return {
    ...draft,
    baseVersion: serverVersion,
    base: server,
    value,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    conflict: null,
    updatedAt: now,
  }
}
