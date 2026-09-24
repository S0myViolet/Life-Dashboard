/**
 * Offline upload queue (pure functions over a plain array kept in
 * chrome.storage.local). Bounded by item count and total bytes; retries use
 * exponential backoff with jitter and honour Retry-After.
 */
import type { CaptureSnapshot, CaptureStatusReport } from '@personal-home/core'

export type UploadItem =
  | (UploadItemBase & { kind: 'snapshot'; body: CaptureSnapshot })
  | (UploadItemBase & { kind: 'status'; body: CaptureStatusReport })

interface UploadItemBase {
  id: string
  /** 'provider:externalId' */
  conversationKey: string
  /** Page visit that produced the snapshot (snapshots only). */
  sessionId: string | null
  /** Serialized body size. */
  bytes: number
  attempts: number
  /** Epoch ms before which the item is not retried. */
  nextAttemptAt: number
  createdAt: number
  lastError: string | null
}

export const QUEUE_LIMITS = {
  maxItems: 40,
  /** chrome.storage.local holds 10 MB in total; leave room for everything else. */
  maxBytes: 6 * 1024 * 1024,
  /** A queued item older than this is dropped (its page is long gone; later visits recapture). */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
} as const

export const BACKOFF = {
  baseMs: 30_000,
  maxMs: 30 * 60_000,
  /** Retry-After values above this are capped. */
  maxRetryAfterMs: 6 * 60 * 60_000,
} as const

export interface EnqueueResult {
  queue: UploadItem[]
  /** Items removed to make room or because the new item supersedes them. */
  dropped: UploadItem[]
  superseded: number
}

/**
 * Add items (normally one; several chunks of one snapshot). Snapshots supersede
 * queued snapshots of the same page visit and conversation: the content
 * script's accumulation only grows within a visit, so the newest one carries
 * everything the older ones did. When the queue is over its bounds the oldest
 * items go first. Items older than a week are dropped.
 */
export function enqueue(queue: UploadItem[], items: UploadItem | UploadItem[], now: number): EnqueueResult {
  const incoming = Array.isArray(items) ? items : [items]
  const sessions = new Set(
    incoming
      .filter((i) => i.kind === 'snapshot' && i.sessionId !== null)
      .map((i) => `${i.conversationKey}|${i.sessionId}`),
  )
  let superseded = 0
  const dropped: UploadItem[] = []
  let next = queue.filter((q) => {
    if (now - q.createdAt > QUEUE_LIMITS.maxAgeMs) {
      dropped.push(q)
      return false
    }
    if (q.kind === 'snapshot' && q.sessionId !== null && sessions.has(`${q.conversationKey}|${q.sessionId}`)) {
      superseded++
      return false
    }
    return true
  })
  next.push(...incoming)
  next.sort((a, b) => a.createdAt - b.createdAt)
  const total = () => next.reduce((n, q) => n + q.bytes, 0)
  while (next.length > QUEUE_LIMITS.maxItems || (next.length > 1 && total() > QUEUE_LIMITS.maxBytes)) {
    const [oldest, ...rest] = next
    dropped.push(oldest!)
    next = rest
  }
  return { queue: next, dropped, superseded }
}

export function dueItems(queue: UploadItem[], now: number): UploadItem[] {
  return queue.filter((q) => q.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt)
}

export function removeItem(queue: UploadItem[], id: string): UploadItem[] {
  return queue.filter((q) => q.id !== id)
}

/**
 * Delay before the next attempt: min(max, base * 2^(attempts-1)) with 50-100%
 * jitter, or the server's Retry-After when that is longer.
 */
export function backoffDelay(attempts: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const n = Math.max(1, Math.min(attempts, 20))
  const exp = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** (n - 1))
  const jittered = Math.round(exp * (0.5 + random() * 0.5))
  const after = retryAfterMs === null ? 0 : Math.min(Math.max(0, retryAfterMs), BACKOFF.maxRetryAfterMs)
  return Math.max(jittered, after)
}

export function markFailed(
  queue: UploadItem[],
  id: string,
  now: number,
  error: string,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): UploadItem[] {
  return queue.map((q) => {
    if (q.id !== id) return q
    const attempts = q.attempts + 1
    return { ...q, attempts, lastError: error, nextAttemptAt: now + backoffDelay(attempts, retryAfterMs, random) }
  })
}

/** Make everything due now (browser startup / wake / manual sync). */
export function retryAllNow(queue: UploadItem[], now: number): UploadItem[] {
  return queue.map((q) => (q.nextAttemptAt > now ? { ...q, nextAttemptAt: now } : q))
}

/** Parse a Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

export type UploadDisposition =
  /** Delivered (or the server already had it). */
  | 'done'
  /** Transient: keep and retry later. */
  | 'retry'
  /** The server will never accept this body; drop it. */
  | 'drop'
  /** The device token is unknown or revoked: stop uploading until re-paired. */
  | 'unauthorized'
  /** The conversation is not (or no longer) collectable: drop and re-sync the selection. */
  | 'deselected'
  /** The token is valid but this browser is not the paired origin. */
  | 'forbidden_origin'

export function classifyUpload(status: number | null, errorCode: string | null): UploadDisposition {
  if (status === null) return 'retry' // network error, offline, timeout
  if (status >= 200 && status < 300) return 'done'
  if (status === 401) return 'unauthorized'
  if (status === 403) {
    return errorCode === 'origin_mismatch' || errorCode === 'origin_required' ? 'forbidden_origin' : 'deselected'
  }
  if (status === 409) return 'deselected'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry'
  return 'drop' // 400, 404, 413, 415 ...
}
