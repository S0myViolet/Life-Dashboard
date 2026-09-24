/**
 * Deterministic retry timing. Jitter comes from a hash of a caller-supplied seed
 * (normally the job id + attempt), never from Math.random, so a retry schedule
 * can be reproduced in tests and reasoned about from the stored row.
 */

export interface JobBackoffPolicy {
  /** Delay before the second attempt. */
  baseMs: number
  /** Maximum delay between attempts. */
  capMs: number
  /** Fraction of the delay removed at most by jitter (0 = no jitter, 1 = full jitter). */
  jitterRatio: number
}

export const DEFAULT_JOB_BACKOFF: JobBackoffPolicy = {
  baseMs: 30_000,
  capMs: 60 * 60_000,
  jitterRatio: 0.2,
}

/** Retry-After values beyond this are clamped, so a bad header cannot park a job for ever. */
export const JOB_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000

/** 32-bit FNV-1a of a string, mapped to [0, 1). */
export function seededUnitInterval(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // Final avalanche (murmur3 fmix32) so near-identical seeds spread out.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 0x1_0000_0000
}

/**
 * Delay after failed attempt number `attempt` (1-based): exponential from
 * `baseMs`, capped at `capMs`, then reduced by up to `jitterRatio` using the seed.
 */
export function computeJobBackoffMs(
  attempt: number,
  seed: string,
  policy: JobBackoffPolicy = DEFAULT_JOB_BACKOFF,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be >= 1')
  const { baseMs, capMs, jitterRatio } = policy
  if (!(baseMs > 0) || !(capMs >= baseMs)) throw new RangeError('invalid backoff policy')
  if (!(jitterRatio >= 0 && jitterRatio <= 1)) throw new RangeError('jitterRatio must be in [0, 1]')
  const exponent = Math.min(attempt - 1, 40)
  const raw = Math.min(capMs, baseMs * 2 ** exponent)
  const jitter = raw * jitterRatio * seededUnitInterval(`${seed}:${attempt}`)
  return Math.max(1, Math.round(raw - jitter))
}

/**
 * When a failed attempt should be retried. A provider's Retry-After is honoured
 * (never retried earlier) and our own backoff still applies as a floor, so a
 * `Retry-After: 0` cannot turn into a hot loop. Clamped to 24 hours.
 */
export function computeJobRetryAt(input: {
  now: Date
  attempt: number
  seed: string
  retryAt?: Date | null
  policy?: JobBackoffPolicy
}): Date {
  const nowMs = input.now.getTime()
  const backoffAt = nowMs + computeJobBackoffMs(input.attempt, input.seed, input.policy)
  const requested = input.retryAt?.getTime()
  const at =
    requested !== undefined && Number.isFinite(requested)
      ? Math.max(backoffAt, requested)
      : backoffAt
  return new Date(Math.min(at, nowMs + JOB_RETRY_AFTER_MAX_MS))
}

/**
 * Parse an HTTP Retry-After header (delay-seconds or HTTP-date) into an instant.
 * Returns null when absent or malformed.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): Date | null {
  if (value == null) return null
  const v = value.trim()
  if (v === '') return null
  if (/^\d+$/.test(v)) {
    const seconds = Number(v)
    if (!Number.isSafeInteger(seconds)) return null
    return new Date(now.getTime() + Math.min(seconds * 1000, JOB_RETRY_AFTER_MAX_MS))
  }
  // HTTP-date (IMF-fixdate, e.g. "Wed, 21 Oct 2015 07:28:00 GMT"). Require a GMT
  // designator so a bare local-time string is not silently misread.
  if (!/GMT$/.test(v)) return null
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}
