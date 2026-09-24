/**
 * Offline upload queue: bounds, superseding within a page visit, backoff and
 * the classification of dashboard answers.
 */
import { describe, expect, it } from 'vitest'
import {
  BACKOFF,
  QUEUE_LIMITS,
  backoffDelay,
  classifyUpload,
  dueItems,
  enqueue,
  markFailed,
  parseRetryAfter,
  retryAllNow,
  type UploadItem,
} from '../src/shared/queue.ts'

let seq = 0
function item(extra: Partial<UploadItem> = {}): UploadItem {
  seq++
  return {
    id: `item-${seq}`,
    kind: 'snapshot',
    conversationKey: 'chatgpt:abc',
    sessionId: 's1',
    body: {} as never,
    bytes: 1000,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: seq,
    lastError: null,
    ...extra,
  } as UploadItem
}

describe('enqueue', () => {
  it('a newer snapshot of the same page visit supersedes queued ones (all chunks)', () => {
    let q = enqueue([], [item({ id: 'a1' }), item({ id: 'a2' })], 100).queue
    q = enqueue(q, item({ id: 'other', sessionId: 's2' }), 100).queue
    q = enqueue(q, item({ id: 'status', kind: 'status', sessionId: null }), 100).queue
    const r = enqueue(q, item({ id: 'b1' }), 100)
    expect(r.superseded).toBe(2)
    expect(r.queue.map((i) => i.id)).toEqual(['other', 'status', 'b1'])
  })

  it('is bounded by count and bytes, dropping the oldest first', () => {
    let q: UploadItem[] = []
    for (let i = 0; i < QUEUE_LIMITS.maxItems + 5; i++) q = enqueue(q, item({ sessionId: `s${i}` }), 100).queue
    expect(q).toHaveLength(QUEUE_LIMITS.maxItems)

    const big = Math.floor(QUEUE_LIMITS.maxBytes / 3)
    let b: UploadItem[] = []
    const dropped: UploadItem[] = []
    for (let i = 0; i < 5; i++) {
      const r = enqueue(b, item({ id: `big${i}`, sessionId: `b${i}`, bytes: big }), 100)
      b = r.queue
      dropped.push(...r.dropped)
    }
    expect(b.reduce((n, x) => n + x.bytes, 0)).toBeLessThanOrEqual(QUEUE_LIMITS.maxBytes)
    expect(dropped.map((d) => d.id)).toEqual(['big0', 'big1'])
  })

  it('drops items older than a week', () => {
    const old = item({ id: 'old', createdAt: 0, sessionId: 'x' })
    const r = enqueue([old], item({ id: 'new', createdAt: QUEUE_LIMITS.maxAgeMs + 10 }), QUEUE_LIMITS.maxAgeMs + 10)
    expect(r.queue.map((i) => i.id)).toEqual(['new'])
    expect(r.dropped.map((i) => i.id)).toEqual(['old'])
  })
})

describe('backoff', () => {
  it('grows exponentially with jitter and caps at 30 minutes', () => {
    const lo = () => 0
    const hi = () => 0.999999
    expect(backoffDelay(1, null, lo)).toBe(BACKOFF.baseMs / 2)
    expect(backoffDelay(1, null, hi)).toBeLessThanOrEqual(BACKOFF.baseMs)
    expect(backoffDelay(3, null, hi)).toBeLessThanOrEqual(BACKOFF.baseMs * 4)
    expect(backoffDelay(3, null, lo)).toBe(BACKOFF.baseMs * 2)
    expect(backoffDelay(50, null, hi)).toBeLessThanOrEqual(BACKOFF.maxMs)
  })

  it('honours a longer Retry-After, capped', () => {
    expect(backoffDelay(1, 600_000, () => 0)).toBe(600_000)
    expect(backoffDelay(1, 10 * 24 * 3600_000, () => 0)).toBe(BACKOFF.maxRetryAfterMs)
    expect(parseRetryAfter('120', 0)).toBe(120_000)
    expect(parseRetryAfter('Thu, 24 Sep 2026 12:01:00 GMT', Date.parse('2026-09-24T12:00:00Z'))).toBe(60_000)
    expect(parseRetryAfter('soon', 0)).toBeNull()
    expect(parseRetryAfter(null, 0)).toBeNull()
  })

  it('markFailed schedules the item; retryAllNow makes everything due (startup/wake)', () => {
    const q = markFailed([item({ id: 'x' })], 'x', 1000, 'network_error', null, () => 0)
    expect(q[0]).toMatchObject({ attempts: 1, lastError: 'network_error', nextAttemptAt: 1000 + BACKOFF.baseMs / 2 })
    expect(dueItems(q, 1000)).toHaveLength(0)
    expect(dueItems(retryAllNow(q, 1000), 1000)).toHaveLength(1)
  })
})

describe('classifyUpload', () => {
  it('maps dashboard answers to what the helper does next', () => {
    expect(classifyUpload(200, null)).toBe('done')
    expect(classifyUpload(null, 'network_error')).toBe('retry')
    expect(classifyUpload(503, 'server_error')).toBe('retry')
    expect(classifyUpload(429, null)).toBe('retry')
    expect(classifyUpload(422, 'unprocessable_data')).toBe('drop')
    expect(classifyUpload(401, 'invalid_token')).toBe('unauthorized')
    expect(classifyUpload(403, 'origin_mismatch')).toBe('forbidden_origin')
    expect(classifyUpload(403, 'not_selected')).toBe('deselected')
    expect(classifyUpload(409, 'not_active')).toBe('deselected')
    expect(classifyUpload(400, 'invalid_snapshot')).toBe('drop')
    expect(classifyUpload(413, 'payload_too_large')).toBe('drop')
  })
})
