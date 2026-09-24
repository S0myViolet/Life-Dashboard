import { describe, expect, it } from 'vitest'
import {
  connectionBackoffMs,
  connectionErrorCode,
  connectionErrorKindOf,
  connectionFailure,
  connectionIsDue,
  connectionTransition,
  DEFAULT_CONNECTION_BACKOFF,
  initialConnectionHealth,
  type ConnectionHealth,
} from '../src/index.ts'

const t0 = new Date('2026-09-24T10:00:00Z')
const at = (mins: number) => new Date(t0.getTime() + mins * 60_000)

const healthy = (): ConnectionHealth => initialConnectionHealth(t0)

describe('connection status state machine', () => {
  it('success → connected, clears errors and counters', () => {
    const failed = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: at(1),
      failure: connectionFailure('transient', 'http_503', 'Google returned HTTP 503'),
    })
    const ok = connectionTransition(failed, { type: 'attempt_succeeded', at: at(5) })
    expect(ok).toMatchObject({
      status: 'connected',
      lastAttemptAt: at(5),
      lastSuccessAt: at(5),
      lastErrorCode: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    })
  })

  it('auth failure → needs_reconnect with no automatic retry, keeps last success', () => {
    const h = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: at(2),
      failure: connectionFailure(
        'auth',
        'invalid_grant',
        'Google refused the refresh token (invalid_grant)',
      ),
    })
    expect(h).toMatchObject({
      status: 'needs_reconnect',
      lastAttemptAt: at(2),
      lastSuccessAt: t0,
      lastErrorCode: 'auth.invalid_grant',
      nextAttemptAt: null,
      consecutiveFailures: 1,
    })
    expect(connectionIsDue(h, at(1000))).toBe(false)
  })

  it('429 → error with next attempt from Retry-After, clamped to 24h', () => {
    const h = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: at(0),
      failure: connectionFailure('rate_limited', 'http_429', 'Too many requests', {
        retryAfterMs: 120_000,
      }),
    })
    expect(h.status).toBe('error')
    expect(h.nextAttemptAt).toEqual(new Date(t0.getTime() + 120_000))
    expect(connectionIsDue(h, at(1))).toBe(false)
    expect(connectionIsDue(h, at(2))).toBe(true)

    const absurd = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: connectionFailure('rate_limited', 'http_429', 'x', {
        retryAfterMs: 30 * 86_400_000,
      }),
    })
    expect(absurd.nextAttemptAt).toEqual(
      new Date(t0.getTime() + DEFAULT_CONNECTION_BACKOFF.maxRetryAfterMs),
    )
  })

  it('429 without Retry-After and transient failures back off exponentially up to the cap', () => {
    let h = healthy()
    const delays: number[] = []
    for (let i = 0; i < 9; i++) {
      h = connectionTransition(h, {
        type: 'attempt_failed',
        at: t0,
        failure: connectionFailure('transient', 'network', 'Network error'),
      })
      delays.push(h.nextAttemptAt!.getTime() - t0.getTime())
    }
    expect(h.status).toBe('error')
    expect(delays.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 480_000])
    expect(delays.at(-1)).toBe(DEFAULT_CONNECTION_BACKOFF.maxMs)
    expect(connectionBackoffMs(0)).toBe(60_000)

    const r = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: connectionFailure('rate_limited', 'http_429', 'x'),
    })
    expect(r.nextAttemptAt).toEqual(new Date(t0.getTime() + 60_000))
  })

  it('a 503 Retry-After longer than the backoff is honoured', () => {
    const h = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: connectionFailure('transient', 'http_503', 'x', { retryAfterMs: 600_000 }),
    })
    expect(h.nextAttemptAt).toEqual(new Date(t0.getTime() + 600_000))
  })

  it('config failures retry slowly', () => {
    const h = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: connectionFailure('config', 'invalid_client', 'Client credentials rejected'),
    })
    expect(h.status).toBe('error')
    expect(h.nextAttemptAt).toEqual(
      new Date(t0.getTime() + DEFAULT_CONNECTION_BACKOFF.configRetryMs),
    )
  })

  it('pause is never left by job outcomes, only by resume', () => {
    let h = connectionTransition(healthy(), { type: 'paused', at: at(1) })
    expect(h).toMatchObject({ status: 'paused', pausedAt: at(1), nextAttemptAt: null })
    expect(connectionIsDue(h, at(100))).toBe(false)

    h = connectionTransition(h, { type: 'attempt_succeeded', at: at(2) })
    expect(h.status).toBe('paused')
    expect(h.lastSuccessAt).toEqual(at(2))
    h = connectionTransition(h, {
      type: 'attempt_failed',
      at: at(3),
      failure: connectionFailure('rate_limited', 'http_429', 'x', { retryAfterMs: 1000 }),
    })
    expect(h).toMatchObject({
      status: 'paused',
      // Kept for the resume; a paused connection is never due.
      nextAttemptAt: new Date(at(3).getTime() + 1000),
      lastErrorCode: 'rate_limited.http_429',
    })
    expect(connectionIsDue(h, at(100))).toBe(false)
    h = connectionTransition(h, { type: 'reconnected', at: at(4) })
    expect(h.status).toBe('paused')
    expect(connectionTransition(h, { type: 'paused', at: at(9) })).toBe(h)

    const resumed = connectionTransition(h, { type: 'resumed', at: at(5) })
    expect(resumed).toMatchObject({ status: 'connected', pausedAt: null, nextAttemptAt: at(5) })
  })

  it('resume restores the status implied by the last recorded outcome', () => {
    const authFailed = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: at(1),
      failure: connectionFailure('auth', 'invalid_grant', 'x'),
    })
    const r1 = connectionTransition(
      connectionTransition(authFailed, { type: 'paused', at: at(2) }),
      {
        type: 'resumed',
        at: at(3),
      },
    )
    expect(r1).toMatchObject({ status: 'needs_reconnect', nextAttemptAt: null })

    const transient = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: at(1),
      failure: connectionFailure('transient', 'http_500', 'x'),
    })
    const r2 = connectionTransition(
      connectionTransition(transient, { type: 'paused', at: at(2) }),
      {
        type: 'resumed',
        at: at(3),
      },
    )
    expect(r2).toMatchObject({ status: 'error', nextAttemptAt: at(3) })
    // Resume of a connection that is not paused changes nothing.
    expect(connectionTransition(transient, { type: 'resumed', at: at(4) })).toBe(transient)
  })

  it('reconnect clears a needs_reconnect state but is not a success by itself', () => {
    const failed = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: at(1),
      failure: connectionFailure('auth', 'invalid_grant', 'x'),
    })
    const reconnected = connectionTransition(failed, { type: 'reconnected', at: at(2) })
    expect(reconnected).toMatchObject({
      status: 'connected',
      lastErrorCode: null,
      consecutiveFailures: 0,
      lastAttemptAt: at(2),
      // Only a proven access check moves the last success.
      lastSuccessAt: t0,
    })
    // The callback's first access check failing leaves the real last success alone.
    const checkFailed = connectionTransition(reconnected, {
      type: 'attempt_failed',
      at: at(2),
      failure: connectionFailure('transient', 'http_503', 'x'),
    })
    expect(checkFailed).toMatchObject({ status: 'error', lastSuccessAt: t0 })
  })

  it('pause then resume keeps a provider Retry-After deadline', () => {
    const limited = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: connectionFailure('rate_limited', 'http_429', 'x', { retryAfterMs: 3_600_000 }),
    })
    expect(limited.nextAttemptAt).toEqual(at(60))
    const paused = connectionTransition(limited, { type: 'paused', at: at(1) })
    expect(connectionIsDue(paused, at(120))).toBe(false)
    const resumed = connectionTransition(paused, { type: 'resumed', at: at(2) })
    expect(resumed).toMatchObject({ status: 'error', pausedAt: null, nextAttemptAt: at(60) })
    expect(connectionIsDue(resumed, at(59))).toBe(false)
    expect(connectionIsDue(resumed, at(60))).toBe(true)

    // A 503 with Retry-After is honoured the same way.
    const unavailable = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: connectionFailure('transient', 'http_503', 'x', { retryAfterMs: 1_800_000 }),
    })
    const r = connectionTransition(
      connectionTransition(unavailable, { type: 'paused', at: at(1) }),
      {
        type: 'resumed',
        at: at(2),
      },
    )
    expect(r.nextAttemptAt).toEqual(at(30))

    // Once the deadline has passed, resume checks straight away.
    const late = connectionTransition(paused, { type: 'resumed', at: at(90) })
    expect(late.nextAttemptAt).toEqual(at(90))
  })

  it('resume after a configuration error checks straight away (the owner may have fixed it)', () => {
    const cfg = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: connectionFailure('config', 'api_disabled', 'x'),
    })
    const r = connectionTransition(connectionTransition(cfg, { type: 'paused', at: at(1) }), {
      type: 'resumed',
      at: at(2),
    })
    expect(r).toMatchObject({ status: 'error', nextAttemptAt: at(2) })
  })

  it('stores sanitised, length-capped messages', () => {
    const h = connectionTransition(healthy(), {
      type: 'attempt_failed',
      at: t0,
      failure: {
        kind: 'transient',
        code: 'transient.unexpected',
        message: `token=ya29.abcdefghijklmnop for owner@example.com ${'x'.repeat(1000)}`,
      },
    })
    expect(h.lastErrorMessage).not.toContain('ya29')
    expect(h.lastErrorMessage).not.toContain('owner@example.com')
    expect(h.lastErrorMessage!.length).toBeLessThanOrEqual(300)
  })
})

describe('error codes', () => {
  it('builds well-formed codes and reads their kind back', () => {
    expect(connectionErrorCode('auth', 'invalid_grant')).toBe('auth.invalid_grant')
    expect(connectionErrorCode('transient', 'HTTP 503!')).toBe('transient.http_503')
    expect(connectionErrorCode('provider', '')).toBe('provider.unknown')
    expect(connectionErrorKindOf('rate_limited.http_429')).toBe('rate_limited')
    expect(connectionErrorKindOf('nonsense.x')).toBeNull()
    expect(connectionErrorKindOf('Auth.X')).toBeNull()
    expect(connectionErrorKindOf(null)).toBeNull()
  })
})
