import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIEFING_LATE_AFTER_MS,
  BriefingContentSchema,
  BriefingJobPayloadSchema,
  briefingDedupeKey,
  briefingJobKind,
  briefingKindOfJob,
  briefingLocalTime,
  buildBriefingSkeletonContent,
  buildBriefingSourceFreshness,
  computeJobBackoffMs,
  computeJobRetryAt,
  DEFAULT_JOB_BACKOFF,
  EnqueueJobInputSchema,
  isBriefingLate,
  JOB_KINDS,
  JOB_RETRY_AFTER_MAX_MS,
  JOB_SCHEDULE_DEFINITIONS,
  JobFailure,
  latestDueOccurrence,
  parseRetryAfter,
  sanitizeJobError,
  seededUnitInterval,
  shouldMaterialiseOccurrence,
  type JobScheduleDefinition,
} from '../src/index.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('backoff', () => {
  it('is deterministic for a seed and never uses Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used')
    })
    const a = computeJobBackoffMs(3, 'job-1')
    expect(computeJobBackoffMs(3, 'job-1')).toBe(a)
    const seeds = new Set(Array.from({ length: 50 }, (_, i) => computeJobBackoffMs(3, `job-${i}`)))
    expect(seeds.size).toBeGreaterThan(40)
    expect(Math.random).not.toHaveBeenCalled()
  })

  it('grows exponentially within the jitter band and respects the cap', () => {
    const { baseMs, capMs, jitterRatio } = DEFAULT_JOB_BACKOFF
    for (let attempt = 1; attempt <= 30; attempt++) {
      const raw = Math.min(capMs, baseMs * 2 ** (attempt - 1))
      for (const seed of ['a', 'b', 'c', 'd']) {
        const d = computeJobBackoffMs(attempt, seed)
        expect(d).toBeLessThanOrEqual(raw)
        expect(d).toBeGreaterThanOrEqual(Math.floor(raw * (1 - jitterRatio)))
      }
    }
    expect(computeJobBackoffMs(1, 'x', { baseMs: 1000, capMs: 8000, jitterRatio: 0 })).toBe(1000)
    expect(computeJobBackoffMs(3, 'x', { baseMs: 1000, capMs: 8000, jitterRatio: 0 })).toBe(4000)
    expect(computeJobBackoffMs(9, 'x', { baseMs: 1000, capMs: 8000, jitterRatio: 0 })).toBe(8000)
    expect(computeJobBackoffMs(500, 'x')).toBeLessThanOrEqual(capMs)
  })

  it('rejects invalid attempts and policies', () => {
    expect(() => computeJobBackoffMs(0, 'x')).toThrow(RangeError)
    expect(() => computeJobBackoffMs(1.5, 'x')).toThrow(RangeError)
    expect(() => computeJobBackoffMs(1, 'x', { baseMs: 0, capMs: 1, jitterRatio: 0 })).toThrow(
      RangeError,
    )
    expect(() => computeJobBackoffMs(1, 'x', { baseMs: 10, capMs: 5, jitterRatio: 0 })).toThrow(
      RangeError,
    )
    expect(() => computeJobBackoffMs(1, 'x', { baseMs: 10, capMs: 50, jitterRatio: 2 })).toThrow(
      RangeError,
    )
  })

  it('seededUnitInterval stays in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const u = seededUnitInterval(`s${i}`)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
  })

  it('honours Retry-After but never retries sooner than the backoff, clamped to 24h', () => {
    const now = new Date('2026-09-24T12:00:00Z')
    const policy = { baseMs: 30_000, capMs: 3_600_000, jitterRatio: 0 }
    const later = new Date(now.getTime() + 120_000)
    expect(computeJobRetryAt({ now, attempt: 1, seed: 's', retryAt: later, policy })).toEqual(later)
    const sooner = new Date(now.getTime() + 1_000)
    expect(
      computeJobRetryAt({ now, attempt: 1, seed: 's', retryAt: sooner, policy }).getTime(),
    ).toBe(now.getTime() + 30_000)
    const absurd = new Date(now.getTime() + 30 * 86_400_000)
    expect(
      computeJobRetryAt({ now, attempt: 1, seed: 's', retryAt: absurd, policy }).getTime(),
    ).toBe(now.getTime() + JOB_RETRY_AFTER_MAX_MS)
    expect(computeJobRetryAt({ now, attempt: 2, seed: 's', policy }).getTime()).toBe(
      now.getTime() + 60_000,
    )
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = new Date('2026-09-24T12:00:00Z')
    expect(parseRetryAfter('120', now)).toEqual(new Date('2026-09-24T12:02:00Z'))
    expect(parseRetryAfter(' 0 ', now)).toEqual(now)
    expect(parseRetryAfter('Thu, 24 Sep 2026 12:05:00 GMT', now)).toEqual(
      new Date('2026-09-24T12:05:00Z'),
    )
    expect(parseRetryAfter('99999999', now)).toEqual(
      new Date(now.getTime() + JOB_RETRY_AFTER_MAX_MS),
    )
    for (const bad of [
      null,
      undefined,
      '',
      '-5',
      '1.5',
      'soon',
      '2026-09-24 12:05:00',
      'Thu, 99 Sep 2026 12:05:00 GMT',
    ]) {
      expect(parseRetryAfter(bad, now), String(bad)).toBeNull()
    }
  })
})

describe('sanitizeJobError', () => {
  it('keeps the message, drops stacks and redacts secrets and personal data', () => {
    const err = new Error(
      'fetch failed: Authorization: Bearer ya29.a0AfH6SMBx-secret-token and apikey=sb_secret_abcdefghijklmnop ' +
        'for owner.person@example.com at postgres://postgres:hunter2@db.example.co:5432/postgres ' +
        'url https://api.example.com/v1?access_token=abc123&page=2 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig ' +
        'blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w',
    )
    const out = sanitizeJobError(err)
    for (const leaked of [
      'ya29',
      'sb_secret_',
      'owner.person@example.com',
      'hunter2',
      'abc123',
      'eyJhbGci',
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph',
    ]) {
      expect(out, leaked).not.toContain(leaked)
    }
    expect(out).toContain('fetch failed')
    expect(out).toContain('page=2')
    expect(out).not.toContain('\n')
    expect(out).not.toMatch(/at .*\.ts:\d+/)
  })

  it('redacts JSON-style secret fields but keeps ordinary words', () => {
    const out = sanitizeJobError(
      new Error(
        'token refresh failed: {"refresh_token":"1//0gSecretRefresh","error":"invalid_grant"} password=hunter2',
      ),
    )
    expect(out).toContain('token refresh failed')
    expect(out).toContain('invalid_grant')
    expect(out).not.toContain('1//0gSecretRefresh')
    expect(out).not.toContain('hunter2')
  })

  it('handles non-errors, control characters and length', () => {
    expect(sanitizeJobError({ token: 'secret' })).toBe('Non-error value thrown')
    expect(sanitizeJobError('line1\nline2\u0000 x')).toBe('line1 line2 x')
    expect(sanitizeJobError('')).toBe('Unknown error')
    expect(sanitizeJobError(new TypeError('boom'))).toBe('TypeError: boom')
    const long = sanitizeJobError('word '.repeat(1000))
    expect(long.length).toBe(500)
    expect(long.endsWith('…')).toBe(true)
    expect(sanitizeJobError('x'.repeat(10), 5)).toBe('xxxx…')
  })

  it('JobFailure carries retry intent', () => {
    const retryAt = new Date('2026-09-24T12:00:00Z')
    const f = new JobFailure('rate limited', { retryAt })
    expect(f.retryable).toBe(true)
    expect(f.retryAt).toEqual(retryAt)
    expect(new JobFailure('bad payload', { retryable: false }).retryable).toBe(false)
    expect(sanitizeJobError(f)).toBe('JobFailure: rate limited')
  })
})

describe('enqueue input', () => {
  it('validates kind, dedupe key, payload size and attempts', () => {
    expect(EnqueueJobInputSchema.parse({ kind: 'briefing.morning' })).toMatchObject({
      kind: 'briefing.morning',
      payload: {},
      maxAttempts: 5,
    })
    expect(EnqueueJobInputSchema.safeParse({ kind: 'nope' }).success).toBe(false)
    expect(
      EnqueueJobInputSchema.safeParse({ kind: 'sync.rss', dedupeKey: 'has space' }).success,
    ).toBe(false)
    expect(
      EnqueueJobInputSchema.safeParse({ kind: 'sync.rss', dedupeKey: 'x'.repeat(201) }).success,
    ).toBe(false)
    expect(EnqueueJobInputSchema.safeParse({ kind: 'sync.rss', maxAttempts: 0 }).success).toBe(
      false,
    )
    expect(
      EnqueueJobInputSchema.safeParse({ kind: 'sync.rss', payload: { blob: 'x'.repeat(20_000) } })
        .success,
    ).toBe(false)
  })
})

describe('schedule definitions', () => {
  it('are valid data: unique names, known kinds, briefings enabled at 11:00 and 22:00', () => {
    const names = JOB_SCHEDULE_DEFINITIONS.map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
    for (const d of JOB_SCHEDULE_DEFINITIONS) expect(JOB_KINDS).toContain(d.kind)
    const morning = JOB_SCHEDULE_DEFINITIONS.find((d) => d.name === 'briefing.morning')
    const evening = JOB_SCHEDULE_DEFINITIONS.find((d) => d.name === 'briefing.evening')
    expect(morning).toMatchObject({
      cadence: 'daily_local_time',
      localTime: '11:00',
      enabled: true,
    })
    expect(evening).toMatchObject({
      cadence: 'daily_local_time',
      localTime: '22:00',
      enabled: true,
    })
    expect(briefingLocalTime('morning')).toBe('11:00')
    expect(briefingLocalTime('evening')).toBe('22:00')
  })

  it('keeps every schedule without a real handler disabled', () => {
    const enabled = JOB_SCHEDULE_DEFINITIONS.filter((d) => d.enabled).map((d) => d.kind)
    expect(enabled.sort()).toEqual(['ai.reconcile', 'briefing.evening', 'briefing.morning', 'sync.google', 'sync.microsoft'])
  })

  it('computes the latest due daily occurrence in the owner timezone', () => {
    const morning = JOB_SCHEDULE_DEFINITIONS.find((d) => d.name === 'briefing.morning')!
    const o = latestDueOccurrence(morning, new Date('2026-03-29T10:30:00Z'), 'Europe/London')
    expect(o).toEqual({
      dedupeKey: 'briefing.morning:2026-03-29',
      dueAt: new Date('2026-03-29T10:00:00Z'),
      localDate: '2026-03-29',
      nextRunAt: new Date('2026-03-30T10:00:00Z'),
    })
    const before = latestDueOccurrence(morning, new Date('2026-03-29T09:59:00Z'), 'Europe/London')
    expect(before.dedupeKey).toBe('briefing.morning:2026-03-28')
    expect(() => latestDueOccurrence(morning, new Date(), null)).toThrow()
  })

  it('aligns interval occurrences to the epoch', () => {
    const def: JobScheduleDefinition = {
      name: 'sync.rss',
      kind: 'sync.rss',
      cadence: 'interval',
      intervalSeconds: 3600,
      enabled: true,
    }
    const o = latestDueOccurrence(def, new Date('2026-09-24T12:34:56Z'), null)
    expect(o).toEqual({
      dedupeKey: 'sync.rss:2026-09-24T12:00:00.000Z',
      dueAt: new Date('2026-09-24T12:00:00Z'),
      localDate: null,
      nextRunAt: new Date('2026-09-24T13:00:00Z'),
    })
  })

  it('materialises only occurrences after enabling and after the last one', () => {
    const occurrence = {
      dedupeKey: 'briefing.morning:2026-03-29',
      dueAt: new Date('2026-03-29T10:00:00Z'),
      localDate: '2026-03-29',
      nextRunAt: new Date('2026-03-30T10:00:00Z'),
    }
    expect(
      shouldMaterialiseOccurrence({
        occurrence,
        enabledSince: new Date('2026-03-01T00:00:00Z'),
        lastOccurrenceAt: null,
      }),
    ).toBe(true)
    // Installed after 11:00 today: today's morning briefing was never due.
    expect(
      shouldMaterialiseOccurrence({
        occurrence,
        enabledSince: new Date('2026-03-29T14:00:00Z'),
        lastOccurrenceAt: null,
      }),
    ).toBe(false)
    // Already materialised this (or a later) occurrence.
    expect(
      shouldMaterialiseOccurrence({
        occurrence,
        enabledSince: new Date('2026-03-01T00:00:00Z'),
        lastOccurrenceAt: new Date('2026-03-29T10:00:00Z'),
      }),
    ).toBe(false)
    const interval = {
      ...occurrence,
      localDate: null,
      dedupeKey: 'sync.rss:x',
      dueAt: new Date('2026-09-24T12:00:00Z'),
      nextRunAt: new Date('2026-09-24T13:00:00Z'),
    }
    expect(
      shouldMaterialiseOccurrence({
        occurrence: interval,
        enabledSince: new Date('2026-09-24T12:30:00Z'),
        lastOccurrenceAt: null,
      }),
    ).toBe(true)
    expect(
      shouldMaterialiseOccurrence({
        occurrence: interval,
        enabledSince: new Date('2026-09-24T13:00:00Z'),
        lastOccurrenceAt: null,
      }),
    ).toBe(false)
  })
})

describe('briefings', () => {
  it('uses the dedupe key briefing.<kind>:<localDate>', () => {
    expect(briefingDedupeKey('morning', '2026-03-29')).toBe('briefing.morning:2026-03-29')
    expect(briefingDedupeKey('evening', '2026-10-25')).toBe('briefing.evening:2026-10-25')
    expect(() => briefingDedupeKey('morning', '2026-3-29')).toThrow()
    expect(briefingJobKind('morning')).toBe('briefing.morning')
    expect(briefingKindOfJob('briefing.evening')).toBe('evening')
    expect(briefingKindOfJob('sync.rss')).toBeNull()
  })

  it('labels publication more than 30 minutes after schedule as late', () => {
    const s = new Date('2026-09-24T10:00:00Z')
    expect(isBriefingLate(s, new Date(s.getTime() + BRIEFING_LATE_AFTER_MS))).toBe(false)
    expect(isBriefingLate(s, new Date(s.getTime() + BRIEFING_LATE_AFTER_MS + 1))).toBe(true)
    expect(isBriefingLate(s, s)).toBe(false)
  })

  it('builds deterministic, honest skeleton content', () => {
    const a = buildBriefingSkeletonContent('morning', '2026-09-24')
    expect(buildBriefingSkeletonContent('morning', '2026-09-24')).toEqual(a)
    expect(BriefingContentSchema.parse(a)).toEqual(a)
    expect(a.sections.map((s) => s.key)).toEqual([
      'important_email',
      'todays_commitments',
      'daily_plan',
      'project_priorities',
      'upcoming_renewals',
    ])
    for (const s of a.sections) {
      expect(s.status).toBe('planned')
      expect(s.availableIn).toBe('Milestone 2')
    }
    expect(a.summary).toMatch(/Milestone 2/)
    expect(a.summary).toMatch(/no summaries/)
    // No invented numbers (counts, amounts) anywhere besides the milestone label.
    expect(JSON.stringify(a.sections).replaceAll('Milestone 2', '')).not.toMatch(/\d/)
    const e = buildBriefingSkeletonContent('evening', '2026-09-24')
    expect(e.sections.map((s) => s.key)).toContain('journal_prompts')
    // The same content is published on time, late, as an outage catch-up or by a manual
    // run, so it makes no claim about timing (lateness is the row's is_late label).
    for (const c of [a, e]) expect(c.summary).not.toMatch(/on schedule|on time|\blate\b/i)
    // JSON keys are camelCase so the postgres.camel transform returns them unchanged.
    expect(JSON.stringify(a)).not.toMatch(/"[a-z]+_[a-z_]+":/)
    expect(buildBriefingSourceFreshness().sources).toEqual([])
  })

  it('accepts a full payload or an empty one, nothing in between', () => {
    expect(
      BriefingJobPayloadSchema.safeParse({
        localDate: '2026-09-24',
        scheduledFor: '2026-09-24T10:00:00.000Z',
        timezone: 'Europe/London',
      }).success,
    ).toBe(true)
    expect(BriefingJobPayloadSchema.safeParse({}).success).toBe(true)
    expect(BriefingJobPayloadSchema.safeParse({ localDate: '2026-09-24' }).success).toBe(false)
    expect(
      BriefingJobPayloadSchema.safeParse({
        localDate: '2026-09-24',
        scheduledFor: '2026-09-24T10:00:00.000Z',
        timezone: 'Nowhere/Land',
      }).success,
    ).toBe(false)
  })
})
