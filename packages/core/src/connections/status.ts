/**
 * Pure connection status state machine.
 *
 *   success                     → connected (errors cleared)
 *   auth failure                → needs_reconnect (no automatic retry)
 *   rate limited (429)          → error, next attempt from Retry-After (or backoff)
 *   transient / 5xx / network   → error, next attempt after exponential backoff
 *   config problem              → error, slow retry (owner must fix settings)
 *   owner pause                 → paused; job outcomes never leave paused
 *   owner resume                → back to what the last recorded outcome says
 *
 * Only the owner leaves `paused` (resume). Reconnecting through OAuth refreshes
 * credentials but does not resume a paused connection.
 *
 * A pause keeps `nextAttemptAt` (paused rows are never due anyway), so a
 * provider's Retry-After still holds when the owner resumes. Only a proven
 * access check (`attempt_succeeded`) ever sets `lastSuccessAt`.
 */
import type { ConnectionStatus } from '../catalog.ts'
import {
  connectionErrorKindOf,
  sanitizeConnectionErrorMessage,
  type ConnectionFailure,
} from './errors.ts'

/** Statuses a stored connection row can have (needs_setup/not_connected/unsupported describe providers without a row). */
export const STORED_CONNECTION_STATUSES = [
  'connected',
  'syncing',
  'paused',
  'needs_reconnect',
  'error',
] as const satisfies readonly ConnectionStatus[]
export type StoredConnectionStatus = (typeof STORED_CONNECTION_STATUSES)[number]

export interface ConnectionHealth {
  status: StoredConnectionStatus
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  nextAttemptAt: Date | null
  consecutiveFailures: number
  pausedAt: Date | null
}

export type ConnectionEvent =
  | { type: 'attempt_succeeded'; at: Date; nextAttemptAt?: Date | null }
  | { type: 'attempt_failed'; at: Date; failure: ConnectionFailure }
  | { type: 'paused'; at: Date }
  | { type: 'resumed'; at: Date }
  /**
   * Fresh OAuth consent for an existing account. Not a success by itself: the
   * callback records its first access check as `attempt_succeeded`/`attempt_failed`.
   */
  | { type: 'reconnected'; at: Date }

export interface ConnectionBackoffPolicy {
  /** First retry delay after a transient/provider failure. */
  baseMs: number
  /** Ceiling for exponential backoff. */
  maxMs: number
  /** Delay before retrying after a configuration failure. */
  configRetryMs: number
  /** Upper bound applied to a provider's Retry-After (protects against absurd values). */
  maxRetryAfterMs: number
}

export const DEFAULT_CONNECTION_BACKOFF: ConnectionBackoffPolicy = {
  baseMs: 60_000,
  maxMs: 60 * 60_000,
  configRetryMs: 6 * 60 * 60_000,
  maxRetryAfterMs: 24 * 60 * 60_000,
}

export const CONNECTION_MAX_ERROR_MESSAGE_LENGTH = 300

/** Exponential backoff for the n-th consecutive failure (n ≥ 1). */
export function connectionBackoffMs(
  consecutiveFailures: number,
  policy: ConnectionBackoffPolicy = DEFAULT_CONNECTION_BACKOFF,
): number {
  const n = Math.max(1, Math.floor(consecutiveFailures))
  const exp = Math.min(n - 1, 30)
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exp)
}

const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms)

/** Health of a connection that was just authorised and verified. */
export function initialConnectionHealth(at: Date): ConnectionHealth {
  return {
    status: 'connected',
    lastAttemptAt: at,
    lastSuccessAt: at,
    lastErrorCode: null,
    lastErrorMessage: null,
    nextAttemptAt: null,
    consecutiveFailures: 0,
    pausedAt: null,
  }
}

function statusFromLastOutcome(h: ConnectionHealth): StoredConnectionStatus {
  const kind = connectionErrorKindOf(h.lastErrorCode)
  if (!h.lastErrorCode) return 'connected'
  return kind === 'auth' ? 'needs_reconnect' : 'error'
}

/**
 * Whether the stored next attempt protects the provider (Retry-After or the
 * backoff after rate limits / provider trouble) and must survive a resume.
 * A configuration wait is ours alone: resuming may re-check straight away.
 */
function keepsProviderDeadline(h: ConnectionHealth): boolean {
  const kind = connectionErrorKindOf(h.lastErrorCode)
  return kind === 'rate_limited' || kind === 'transient' || kind === 'provider'
}

function failedHealth(
  base: ConnectionHealth,
  f: ConnectionFailure,
  at: Date,
  policy: ConnectionBackoffPolicy,
): ConnectionHealth {
  switch (f.kind) {
    case 'auth':
      return { ...base, status: 'needs_reconnect', nextAttemptAt: null }
    case 'rate_limited': {
      const wait =
        f.retryAfterMs !== undefined && Number.isFinite(f.retryAfterMs)
          ? Math.min(Math.max(0, f.retryAfterMs), policy.maxRetryAfterMs)
          : connectionBackoffMs(base.consecutiveFailures, policy)
      return { ...base, status: 'error', nextAttemptAt: addMs(at, wait) }
    }
    case 'config':
      return { ...base, status: 'error', nextAttemptAt: addMs(at, policy.configRetryMs) }
    case 'transient':
    case 'provider': {
      // A 503 may carry Retry-After too: never retry earlier than the provider asked.
      const backoff = connectionBackoffMs(base.consecutiveFailures, policy)
      const asked =
        f.retryAfterMs !== undefined && Number.isFinite(f.retryAfterMs)
          ? Math.min(Math.max(0, f.retryAfterMs), policy.maxRetryAfterMs)
          : 0
      return { ...base, status: 'error', nextAttemptAt: addMs(at, Math.max(backoff, asked)) }
    }
  }
}

export function connectionTransition(
  current: ConnectionHealth,
  event: ConnectionEvent,
  policy: ConnectionBackoffPolicy = DEFAULT_CONNECTION_BACKOFF,
): ConnectionHealth {
  const paused = current.status === 'paused'
  switch (event.type) {
    case 'paused':
      if (paused) return current
      // nextAttemptAt is kept: it may hold a provider's Retry-After.
      return { ...current, status: 'paused', pausedAt: event.at }

    case 'resumed': {
      if (!paused) return current
      const status = statusFromLastOutcome(current)
      // Check again straight away, unless only a reconnect can help or the
      // provider asked us to wait longer.
      let nextAttemptAt: Date | null = status === 'needs_reconnect' ? null : event.at
      if (
        nextAttemptAt &&
        keepsProviderDeadline(current) &&
        current.nextAttemptAt &&
        current.nextAttemptAt.getTime() > nextAttemptAt.getTime()
      )
        nextAttemptAt = current.nextAttemptAt
      return { ...current, status, pausedAt: null, nextAttemptAt }
    }

    case 'reconnected':
      return {
        ...current,
        status: paused ? 'paused' : 'connected',
        lastAttemptAt: event.at,
        lastErrorCode: null,
        lastErrorMessage: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      }

    case 'attempt_succeeded':
      return {
        ...current,
        status: paused ? 'paused' : 'connected',
        lastAttemptAt: event.at,
        lastSuccessAt: event.at,
        lastErrorCode: null,
        lastErrorMessage: null,
        consecutiveFailures: 0,
        nextAttemptAt: paused ? null : (event.nextAttemptAt ?? null),
      }

    case 'attempt_failed': {
      const f = event.failure
      const next = failedHealth(
        {
          ...current,
          lastAttemptAt: event.at,
          lastErrorCode: f.code,
          lastErrorMessage: sanitizeConnectionErrorMessage(
            f.message,
            CONNECTION_MAX_ERROR_MESSAGE_LENGTH,
          ),
          consecutiveFailures: current.consecutiveFailures + 1,
        },
        f,
        event.at,
        policy,
      )
      // Still paused, but keep the deadline so a later resume honours it.
      return paused ? { ...next, status: 'paused' } : next
    }
  }
}

/** Whether a background job should work on this connection now. */
export function connectionIsDue(
  h: Pick<ConnectionHealth, 'status' | 'nextAttemptAt'>,
  now: Date,
): boolean {
  if (h.status === 'paused' || h.status === 'needs_reconnect') return false
  return h.nextAttemptAt === null || h.nextAttemptAt.getTime() <= now.getTime()
}
