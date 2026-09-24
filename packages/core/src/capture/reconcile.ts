/**
 * Reconciling a captured page snapshot with what is already stored.
 *
 * Rules (brief §4 "ChatGPT and Claude project collection", point 5):
 *   - New message key → insert the message and its first text version.
 *   - Same key, different content hash (edit, regeneration) → one new version.
 *   - Same key, same hash → only widen first/last-seen times.
 *   - A message missing from a snapshot is NEVER deleted or superseded: virtualised
 *     and partial pages render only a window of the thread.
 *   - Messages still streaming are ignored until a later snapshot shows them settled.
 *   - Snapshots whose pageState is not `ok` change no messages; problem states only
 *     move the conversation's capture state.
 *   - Ordering is a sort key (provider position hint + first-seen time + key), never identity.
 *
 * Convergence: every stored field is a function of the set of observations, not of
 * their arrival order (times are min/max, the current version is the one observed
 * last, the order hint comes from the latest observation that carried one), so
 * retried, duplicated or out-of-order uploads end in the same state.
 */
import {
  captureStateForProblem,
  type CapturePageState,
  type CaptureRole,
  type CaptureSnapshotOutcome,
  type CaptureState,
} from './constants.ts'
import type { CaptureCoverage, CaptureSnapshot } from './schema.ts'
import {
  captureContentDerivedKey,
  captureContentHash,
  captureIsDerivedKey,
  captureNormalizeText,
} from './text.ts'

export type CaptureKeySource = 'provider' | 'derived'

export interface CaptureStoredVersion {
  contentHash: string
  /** ISO instant: earliest capture that showed this text. */
  capturedAt: string
  /** ISO instant: latest capture that showed this text. */
  lastObservedAt: string
  supersededAt: string | null
}

export interface CaptureStoredMessage {
  key: string
  keySource: CaptureKeySource
  role: CaptureRole
  orderHint: number
  /** Capture time of the observation that supplied orderHint; null when interpolated. */
  orderObservedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  currentHash: string | null
  versions: CaptureStoredVersion[]
}

export interface CaptureStoredConversation {
  messages: CaptureStoredMessage[]
}

export interface CapturePreparedMessage {
  key: string
  keySource: CaptureKeySource
  role: CaptureRole
  /** Normalized text. */
  text: string
  contentHash: string
  orderHint: number | null
  isStreaming: boolean
}

export interface CapturePreparedSnapshot {
  /** ISO instant, clamped so it is never later than when the server received it. */
  capturedAt: string
  pageState: CapturePageState
  complete: boolean
  /** In snapshot order; streaming messages are kept but flagged. */
  messages: CapturePreparedMessage[]
  /** Messages whose text was empty after normalization (for example image-only turns). */
  emptyMessages: number
}

export type CaptureOp =
  | {
      kind: 'insert_message'
      key: string
      keySource: CaptureKeySource
      role: CaptureRole
      orderHint: number
      orderObservedAt: string | null
      seenAt: string
    }
  | { kind: 'insert_version'; key: string; contentHash: string; text: string; capturedAt: string }
  | {
      kind: 'observe_version'
      key: string
      contentHash: string
      capturedAt: string
      lastObservedAt: string
    }
  | { kind: 'touch_message'; key: string; firstSeenAt: string; lastSeenAt: string }
  | { kind: 'set_order'; key: string; orderHint: number; orderObservedAt: string }
  | { kind: 'set_current'; key: string; contentHash: string }
  | { kind: 'set_superseded'; key: string; contentHash: string; supersededAt: string | null }

export interface CaptureReconcileStats {
  newMessages: number
  /** New versions of messages that were already stored (edits, regenerations). */
  newVersions: number
  /** Settled messages whose text matched what was stored. */
  unchanged: number
  ignoredStreaming: number
  ignoredEmpty: number
  /** Same key reported with a different role; the message is left untouched. */
  roleConflicts: number
}

export interface CaptureReconcilePlan {
  outcome: CaptureSnapshotOutcome
  reason: string | null
  /** Set only for problem page states: the conversation moves to this state. */
  nextCaptureState: CaptureState | null
  /** The page showed the first and last message with nothing streaming. */
  complete: boolean
  ops: CaptureOp[]
  stats: CaptureReconcileStats
  /** A message was added or a message's current text changed (see captureContentChanged). */
  contentChanged: boolean
}

// ---------------------------------------------------------------------------
// Preparation (async: hashing)
// ---------------------------------------------------------------------------

/** True when the snapshot can vouch for the whole conversation as rendered. */
export function captureCoverageIsComplete(coverage: CaptureCoverage): boolean {
  return (
    coverage.pageState === 'ok' &&
    coverage.observedFirstMessage &&
    coverage.observedLastMessage &&
    !coverage.streamingInProgress &&
    (coverage.omittedCount ?? 0) === 0
  )
}

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Normalize texts, derive missing keys and hash contents. The server always
 * hashes the text itself; client-side hashes are never trusted.
 */
export async function capturePrepareSnapshot(
  snapshot: CaptureSnapshot,
  options: { receivedAt: Date },
): Promise<CapturePreparedSnapshot> {
  const capturedMs = Math.min(Date.parse(snapshot.capturedAt), options.receivedAt.getTime())
  const occurrences = new Map<string, number>()
  const seenKeys = new Set<string>()
  const messages: CapturePreparedMessage[] = []
  let emptyMessages = 0
  let anyStreaming = false

  for (const m of snapshot.messages) {
    const text = captureNormalizeText(m.text)
    if (text.length === 0) {
      emptyMessages++
      continue
    }
    let key = m.key
    let keySource: CaptureKeySource
    if (key !== undefined) {
      keySource = captureIsDerivedKey(key) ? 'derived' : 'provider'
    } else {
      const base = `${m.role}\n${text}`
      const n = occurrences.get(base) ?? 0
      occurrences.set(base, n + 1)
      key = await captureContentDerivedKey(m.role, text, n)
      keySource = 'derived'
    }
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const isStreaming = m.isStreaming === true
    anyStreaming ||= isStreaming
    messages.push({
      key,
      keySource,
      role: m.role,
      text,
      contentHash: await captureContentHash(text),
      orderHint: m.orderHint ?? null,
      isStreaming,
    })
  }

  return {
    capturedAt: iso(capturedMs),
    pageState: snapshot.coverage.pageState,
    complete: captureCoverageIsComplete(snapshot.coverage) && !anyStreaming,
    messages,
    emptyMessages,
  }
}

// ---------------------------------------------------------------------------
// Reconcile (pure, synchronous)
// ---------------------------------------------------------------------------

const minIso = (a: string, b: string) => (a <= b ? a : b)
const maxIso = (a: string, b: string) => (a >= b ? a : b)

/** The current version is the one observed most recently (ties: larger hash). */
export function captureCurrentVersion(versions: CaptureStoredVersion[]): CaptureStoredVersion | null {
  let best: CaptureStoredVersion | null = null
  for (const v of versions) {
    if (
      !best ||
      v.lastObservedAt > best.lastObservedAt ||
      (v.lastObservedAt === best.lastObservedAt && v.contentHash > best.contentHash)
    ) {
      best = v
    }
  }
  return best
}

/**
 * When a version stopped being current: the earliest time another text of the
 * same message is known to have been observed after this version's last
 * observation. A function of the aggregates only, so it converges.
 */
function supersededAtFor(
  v: CaptureStoredVersion,
  versions: CaptureStoredVersion[],
  current: CaptureStoredVersion,
): string | null {
  if (v.contentHash === current.contentHash) return null
  let best: string | null = null
  for (const w of versions) {
    if (w.contentHash === v.contentHash) continue
    const candidate =
      w.capturedAt > v.lastObservedAt
        ? w.capturedAt
        : w.lastObservedAt > v.lastObservedAt
          ? w.lastObservedAt
          : null
    if (candidate !== null && (best === null || candidate < best)) best = candidate
  }
  // Only reachable on an exact tie of lastObservedAt, which the hash tie-break decided.
  return best ?? current.lastObservedAt
}

interface EffectiveHint {
  value: number
  provided: boolean
}

/**
 * Order hints for the settled snapshot messages. Provided hints win; messages
 * without one are placed between their neighbours in the snapshot (using stored
 * hints for neighbours that are already stored), or after everything stored.
 */
function effectiveHints(
  messages: CapturePreparedMessage[],
  stored: Map<string, CaptureStoredMessage>,
): EffectiveHint[] {
  const known: (number | null)[] = messages.map(
    (m) => m.orderHint ?? stored.get(m.key)?.orderHint ?? null,
  )
  const out: EffectiveHint[] = messages.map((m, i) => ({
    value: known[i] ?? 0,
    provided: m.orderHint !== null,
  }))
  let maxStored = -1
  for (const s of stored.values()) maxStored = Math.max(maxStored, s.orderHint)

  let i = 0
  while (i < messages.length) {
    if (known[i] !== null) {
      i++
      continue
    }
    let j = i
    while (j < messages.length && known[j] === null) j++
    const run = j - i
    const prev = i > 0 ? known[i - 1]! : null
    const next = j < messages.length ? known[j]! : null
    for (let k = 1; k <= run; k++) {
      let value: number
      if (prev !== null && next !== null) value = prev + ((next - prev) * k) / (run + 1)
      else if (prev !== null) value = prev + k
      else if (next !== null) value = next - (run + 1 - k)
      else value = stored.size === 0 ? k - 1 : maxStored + k
      out[i + k - 1] = { value, provided: false }
    }
    i = j
  }
  return out
}

const emptyStats = (): CaptureReconcileStats => ({
  newMessages: 0,
  newVersions: 0,
  unchanged: 0,
  ignoredStreaming: 0,
  ignoredEmpty: 0,
  roleConflicts: 0,
})

export function captureReconcile(
  stored: CaptureStoredConversation,
  snapshot: CapturePreparedSnapshot,
): CaptureReconcilePlan {
  const stats = emptyStats()
  stats.ignoredEmpty = snapshot.emptyMessages

  if (snapshot.pageState !== 'ok') {
    if (snapshot.pageState === 'empty') {
      return {
        outcome: 'ignored_partial',
        reason: 'empty_page',
        nextCaptureState: null,
        complete: false,
        ops: [],
        stats,
        contentChanged: false,
      }
    }
    return {
      outcome: 'rejected',
      reason: snapshot.pageState,
      nextCaptureState: captureStateForProblem(snapshot.pageState),
      complete: false,
      ops: [],
      stats,
      contentChanged: false,
    }
  }

  const t = snapshot.capturedAt
  const byKey = new Map(stored.messages.map((m) => [m.key, m]))
  const settled = snapshot.messages.filter((m) => !m.isStreaming)
  stats.ignoredStreaming = snapshot.messages.length - settled.length

  if (settled.length === 0) {
    return {
      outcome: 'ignored_partial',
      reason: 'no_settled_messages',
      nextCaptureState: null,
      complete: false,
      ops: [],
      stats,
      contentChanged: false,
    }
  }

  const hints = effectiveHints(settled, byKey)
  const ops: CaptureOp[] = []

  settled.forEach((m, i) => {
    const hint = hints[i]!
    const s = byKey.get(m.key)
    if (!s) {
      ops.push({
        kind: 'insert_message',
        key: m.key,
        keySource: m.keySource,
        role: m.role,
        orderHint: hint.value,
        orderObservedAt: hint.provided ? t : null,
        seenAt: t,
      })
      ops.push({
        kind: 'insert_version',
        key: m.key,
        contentHash: m.contentHash,
        text: m.text,
        capturedAt: t,
      })
      ops.push({ kind: 'set_current', key: m.key, contentHash: m.contentHash })
      stats.newMessages++
      return
    }
    if (s.role !== m.role) {
      stats.roleConflicts++
      return
    }

    const firstSeenAt = minIso(s.firstSeenAt, t)
    const lastSeenAt = maxIso(s.lastSeenAt, t)
    if (firstSeenAt !== s.firstSeenAt || lastSeenAt !== s.lastSeenAt) {
      ops.push({ kind: 'touch_message', key: m.key, firstSeenAt, lastSeenAt })
    }

    if (
      m.orderHint !== null &&
      (s.orderObservedAt === null ||
        t > s.orderObservedAt ||
        (t === s.orderObservedAt && m.orderHint > s.orderHint))
    ) {
      ops.push({ kind: 'set_order', key: m.key, orderHint: m.orderHint, orderObservedAt: t })
    }

    let versions = s.versions
    const existing = versions.find((v) => v.contentHash === m.contentHash)
    if (!existing) {
      ops.push({
        kind: 'insert_version',
        key: m.key,
        contentHash: m.contentHash,
        text: m.text,
        capturedAt: t,
      })
      versions = [
        ...versions,
        { contentHash: m.contentHash, capturedAt: t, lastObservedAt: t, supersededAt: null },
      ]
      stats.newVersions++
    } else {
      const capturedAt = minIso(existing.capturedAt, t)
      const lastObservedAt = maxIso(existing.lastObservedAt, t)
      if (capturedAt !== existing.capturedAt || lastObservedAt !== existing.lastObservedAt) {
        ops.push({
          kind: 'observe_version',
          key: m.key,
          contentHash: m.contentHash,
          capturedAt,
          lastObservedAt,
        })
        versions = versions.map((v) => (v === existing ? { ...v, capturedAt, lastObservedAt } : v))
      }
      stats.unchanged++
    }

    const current = captureCurrentVersion(versions)!
    if (current.contentHash !== s.currentHash) {
      ops.push({ kind: 'set_current', key: m.key, contentHash: current.contentHash })
    }
    for (const v of versions) {
      const supersededAt = supersededAtFor(v, versions, current)
      if (supersededAt !== v.supersededAt) {
        ops.push({ kind: 'set_superseded', key: m.key, contentHash: v.contentHash, supersededAt })
      }
    }
  })

  const plan: CaptureReconcilePlan = {
    outcome: 'applied',
    reason: null,
    nextCaptureState: null,
    complete: snapshot.complete,
    ops,
    stats,
    contentChanged: false,
  }
  plan.contentChanged = captureContentChanged(plan)
  return plan
}

/**
 * Whether applying the plan changes what the conversation says: a new message
 * or a different current text for an existing one. Order-only and seen-time
 * updates do not count, so summaries (M2) are only re-requested on real changes.
 */
export function captureContentChanged(plan: Pick<CaptureReconcilePlan, 'ops'>): boolean {
  return plan.ops.some((op) => op.kind === 'set_current')
}

// ---------------------------------------------------------------------------
// In-memory application (the reference model the database layer mirrors)
// ---------------------------------------------------------------------------

export function captureSortMessages<T extends Pick<CaptureStoredMessage, 'orderHint' | 'firstSeenAt' | 'key'>>(
  messages: T[],
): T[] {
  return [...messages].sort(
    (a, b) =>
      a.orderHint - b.orderHint ||
      (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

export function captureApplyOps(
  stored: CaptureStoredConversation,
  ops: CaptureOp[],
): CaptureStoredConversation {
  const map = new Map<string, CaptureStoredMessage>(
    stored.messages.map((m) => [m.key, { ...m, versions: m.versions.map((v) => ({ ...v })) }]),
  )
  const need = (key: string) => {
    const m = map.get(key)
    if (!m) throw new Error('capture op refers to an unknown message')
    return m
  }
  const needVersion = (key: string, hash: string) => {
    const v = need(key).versions.find((x) => x.contentHash === hash)
    if (!v) throw new Error('capture op refers to an unknown version')
    return v
  }
  for (const op of ops) {
    switch (op.kind) {
      case 'insert_message':
        if (!map.has(op.key)) {
          map.set(op.key, {
            key: op.key,
            keySource: op.keySource,
            role: op.role,
            orderHint: op.orderHint,
            orderObservedAt: op.orderObservedAt,
            firstSeenAt: op.seenAt,
            lastSeenAt: op.seenAt,
            currentHash: null,
            versions: [],
          })
        }
        break
      case 'insert_version': {
        const m = need(op.key)
        if (!m.versions.some((v) => v.contentHash === op.contentHash)) {
          m.versions.push({
            contentHash: op.contentHash,
            capturedAt: op.capturedAt,
            lastObservedAt: op.capturedAt,
            supersededAt: null,
          })
        }
        break
      }
      case 'observe_version': {
        const v = needVersion(op.key, op.contentHash)
        v.capturedAt = op.capturedAt
        v.lastObservedAt = op.lastObservedAt
        break
      }
      case 'touch_message': {
        const m = need(op.key)
        m.firstSeenAt = op.firstSeenAt
        m.lastSeenAt = op.lastSeenAt
        break
      }
      case 'set_order': {
        const m = need(op.key)
        m.orderHint = op.orderHint
        m.orderObservedAt = op.orderObservedAt
        break
      }
      case 'set_current':
        need(op.key).currentHash = op.contentHash
        break
      case 'set_superseded':
        needVersion(op.key, op.contentHash).supersededAt = op.supersededAt
        break
    }
  }
  // Canonical shape: versions ordered by first capture, then hash.
  for (const m of map.values()) {
    m.versions.sort((a, b) =>
      a.capturedAt < b.capturedAt
        ? -1
        : a.capturedAt > b.capturedAt
          ? 1
          : a.contentHash < b.contentHash
            ? -1
            : a.contentHash > b.contentHash
              ? 1
              : 0,
    )
  }
  return { messages: captureSortMessages([...map.values()]) }
}

/** Ordered `key=currentHash` lines: equal fingerprints mean equal current content. */
export function captureContentFingerprint(conversation: CaptureStoredConversation): string {
  return captureSortMessages(conversation.messages)
    .map((m) => `${m.key}=${m.currentHash ?? ''}`)
    .join('\n')
}
