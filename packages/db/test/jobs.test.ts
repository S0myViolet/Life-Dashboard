/**
 * Queue semantics against a real Postgres (template = shim + all migrations).
 * Every test uses an explicit logical clock (`now`) so lease expiry and backoff
 * are deterministic; the SQL functions compare against that clock, not now().
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  computeJobRetryAt,
  JOB_KINDS,
  JOB_SCHEDULE_DEFINITIONS,
  type JobScheduleDefinition,
} from '@personal-home/core'
import {
  claimJobs,
  completeJob,
  countJobsByStatus,
  enqueueJob,
  failJob,
  getJob,
  heartbeatJob,
  listJobSchedules,
  listJobs,
  readJobOwnerContext,
  reapExpiredJobs,
  syncJobSchedules,
  withOwner,
  withService,
} from '../src/index.ts'
import { createTestDatabase, seedOwner, withAnon, type TestDatabase } from './harness.ts'

let t: TestDatabase
const T0 = new Date('2026-09-24T12:00:00.000Z')
const plus = (ms: number, from = T0) => new Date(from.getTime() + ms)
const svc = <R>(fn: Parameters<typeof withService<R>>[1]) => withService(t.db, fn)

beforeAll(async () => {
  t = await createTestDatabase()
})
afterAll(async () => {
  await t?.drop()
})

async function freshDb(): Promise<TestDatabase> {
  return createTestDatabase()
}

describe('schema', () => {
  it('the job_kind domain lists exactly JOB_KINDS', async () => {
    const [row] = await t.db<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c join pg_type ty on ty.oid = c.contypid
      join pg_namespace n on n.oid = ty.typnamespace
      where n.nspname = 'private' and ty.typname = 'job_kind'
    `
    const values = [...(row?.def ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(values).toEqual([...JOB_KINDS].sort())
    await expect(t.db`insert into private.jobs (kind) values ('sync.nonexistent')`).rejects.toThrow(
      /job_kind/,
    )
  })

  it('status check lists exactly the core JOB_STATUSES', async () => {
    const [row] = await t.db<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
      where c.conrelid = 'private.jobs'::regclass and pg_get_constraintdef(c.oid) like '%status = ANY%'
        and pg_get_constraintdef(c.oid) like '%queued%'
    `
    const values = [...(row?.def ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    const { JOB_STATUSES } = await import('@personal-home/core')
    expect(values).toEqual([...JOB_STATUSES].sort())
  })

  it('anon and authenticated cannot touch the queue', async () => {
    const owner = await seedOwner(t.db, 'queue-owner@example.com')
    for (const run of [
      (sql: string) => withOwner(t.db, owner, (tx) => tx.unsafe(sql)),
      (sql: string) => withAnon(t.db, (tx) => tx.unsafe(sql)),
    ]) {
      await expect(run('select * from private.jobs')).rejects.toThrow(/permission denied/)
      await expect(run('select * from private.job_schedules')).rejects.toThrow(/permission denied/)
      await expect(run(`select * from private.claim_jobs('x', 1, 1000)`)).rejects.toThrow(
        /permission denied/,
      )
      await expect(run(`select * from private.enqueue_job('sync.rss')`)).rejects.toThrow(
        /permission denied/,
      )
    }
    const grants = await t.db<{ fn: string }[]>`
      select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private'
        and p.proname in ('enqueue_job','claim_jobs','heartbeat_job','complete_job','fail_job','reap_expired_jobs')
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
    `
    expect(grants).toEqual([])
  })
})

describe('enqueue', () => {
  it('is idempotent on dedupe_key and returns the existing job', async () => {
    const a = await svc((tx) =>
      enqueueJob(
        tx,
        { kind: 'sync.rss', dedupeKey: 'sync.rss:idem-1', payload: { feedId: 'f1' } },
        T0,
      ),
    )
    const b = await svc((tx) =>
      enqueueJob(
        tx,
        { kind: 'sync.rss', dedupeKey: 'sync.rss:idem-1', payload: { feedId: 'other' } },
        T0,
      ),
    )
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.job.id).toBe(a.job.id)
    expect(b.job.payload).toEqual({ feedId: 'f1' })
    expect(a.job).toMatchObject({ status: 'queued', attempts: 0, maxAttempts: 5, runAt: T0 })
    // Jobs without a key are never deduplicated.
    const c = await svc((tx) => enqueueJob(tx, { kind: 'sync.rss' }, T0))
    const d = await svc((tx) => enqueueJob(tx, { kind: 'sync.rss' }, T0))
    expect(c.job.id).not.toBe(d.job.id)
  })

  it('refuses a dedupe key already used by another kind', async () => {
    await svc((tx) => enqueueJob(tx, { kind: 'sync.rss', dedupeKey: 'shared-key' }, T0))
    await expect(
      svc((tx) => enqueueJob(tx, { kind: 'sync.whoop', dedupeKey: 'shared-key' }, T0)),
    ).rejects.toThrow(/already belongs/)
  })

  it('validates input at the boundary', async () => {
    await expect(svc((tx) => enqueueJob(tx, { kind: 'nope' as never }, T0))).rejects.toThrow()
    await expect(
      svc((tx) => enqueueJob(tx, { kind: 'sync.rss', payload: { account_id: 'x' } }, T0)),
    ).rejects.toThrow(/camelCase/)
    await expect(
      svc((tx) => enqueueJob(tx, { kind: 'sync.rss', payload: { blob: 'x'.repeat(20_000) } }, T0)),
    ).rejects.toThrow(/bytes/)
  })

  it('is idempotent under concurrency: 25 racing enqueues create one job', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        svc((tx) =>
          enqueueJob(
            tx,
            { kind: 'briefing.morning', dedupeKey: 'briefing.morning:2026-01-01' },
            T0,
          ),
        ),
      ),
    )
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1)
    const [row] = await t.db<{ n: number }[]>`
      select count(*)::int as n from private.jobs where dedupe_key = 'briefing.morning:2026-01-01'
    `
    expect(row?.n).toBe(1)
  })
})

describe('claim', () => {
  it('8 concurrent claimers over 50 jobs process every job exactly once', async () => {
    const db = await freshDb()
    try {
      for (let i = 0; i < 50; i++) {
        await withService(db.db, (tx) =>
          enqueueJob(tx, { kind: 'sync.rss', payload: { n: i } }, T0),
        )
      }
      const processed = new Map<string, string[]>()
      const worker = async (w: number) => {
        const workerId = `worker-${w}`
        for (;;) {
          const limit = 1 + (w % 3)
          const jobs = await withService(db.db, (tx) =>
            claimJobs(tx, { workerId, limit, leaseMs: 60_000, now: plus(1000) }),
          )
          if (jobs.length === 0) return
          for (const job of jobs) {
            processed.set(job.id, [...(processed.get(job.id) ?? []), workerId])
            // Interleave with the other workers.
            await new Promise((r) => setTimeout(r, (job.payload.n as number) % 3))
            const ok = await withService(db.db, (tx) =>
              completeJob(tx, job, { result: { by: workerId }, now: plus(2000) }),
            )
            expect(ok).toBe(true)
          }
        }
      }
      await Promise.all(Array.from({ length: 8 }, (_, w) => worker(w)))

      expect(processed.size).toBe(50)
      const twice = [...processed.entries()].filter(([, by]) => by.length !== 1)
      expect(twice).toEqual([])
      const counts = await withService(db.db, (tx) => countJobsByStatus(tx))
      expect(counts).toEqual({ succeeded: 50 })
      const rows = await withService(db.db, (tx) => listJobs(tx, { kind: 'sync.rss' }))
      expect(
        rows.every((r) => r.attempts === 1 && r.leaseToken === null && r.finishedAt !== null),
      ).toBe(true)
      // More than one worker actually took part.
      expect(new Set([...processed.values()].map((by) => by[0])).size).toBeGreaterThan(1)
    } finally {
      await db.drop()
    }
  })

  it('only claims due jobs of the requested kinds', async () => {
    const db = await freshDb()
    try {
      await withService(db.db, async (tx) => {
        await enqueueJob(tx, { kind: 'sync.rss', runAt: plus(60_000) }, T0)
        await enqueueJob(tx, { kind: 'sync.whoop' }, T0)
        await enqueueJob(tx, { kind: 'briefing.morning' }, T0)
      })
      const got = await withService(db.db, (tx) =>
        claimJobs(tx, {
          workerId: 'w',
          limit: 10,
          leaseMs: 10_000,
          kinds: ['briefing.morning', 'sync.rss'],
          now: T0,
        }),
      )
      expect(got.map((j) => j.kind)).toEqual(['briefing.morning'])
      expect(
        await withService(db.db, (tx) =>
          claimJobs(tx, { workerId: 'w', limit: 10, leaseMs: 10_000, kinds: [], now: T0 }),
        ),
      ).toEqual([])
      const later = await withService(db.db, (tx) =>
        claimJobs(tx, {
          workerId: 'w',
          limit: 10,
          leaseMs: 10_000,
          kinds: ['sync.rss'],
          now: plus(60_000),
        }),
      )
      expect(later.map((j) => j.kind)).toEqual(['sync.rss'])
    } finally {
      await db.drop()
    }
  })

  it('rejects nonsense claim parameters', async () => {
    await expect(
      svc((tx) => claimJobs(tx, { workerId: '', limit: 1, leaseMs: 1000 })),
    ).rejects.toThrow(/worker/)
    await expect(
      svc((tx) => claimJobs(tx, { workerId: 'w', limit: 0, leaseMs: 1000 })),
    ).rejects.toThrow(/limit/)
    await expect(
      svc((tx) => claimJobs(tx, { workerId: 'w', limit: 1, leaseMs: 10 })),
    ).rejects.toThrow(/lease/)
  })
})

describe('leases', () => {
  it('an expired lease is reclaimed by another worker; the original worker can no longer finish', async () => {
    const db = await freshDb()
    try {
      const { job } = await withService(db.db, (tx) => enqueueJob(tx, { kind: 'sync.rss' }, T0))
      const [a] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 1_000, now: T0 }),
      )
      expect(a?.id).toBe(job.id)
      // Still leased by A: B gets nothing.
      expect(
        await withService(db.db, (tx) =>
          claimJobs(tx, { workerId: 'B', limit: 1, leaseMs: 1_000, now: plus(999) }),
        ),
      ).toEqual([])
      // A stalls past its lease; B reclaims with a new token.
      const [b] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'B', limit: 1, leaseMs: 30_000, now: plus(1_500) }),
      )
      expect(b?.id).toBe(job.id)
      expect(b?.leaseToken).not.toBe(a?.leaseToken)
      expect(b?.attempts).toBe(2)
      expect(b?.leaseOwner).toBe('B')

      expect(
        await withService(db.db, (tx) =>
          completeJob(tx, a!, { result: { by: 'A' }, now: plus(2_000) }),
        ),
      ).toBe(false)
      expect(
        await withService(db.db, (tx) =>
          failJob(tx, a!, { error: new Error('late'), attempt: 1, now: plus(2_000) }),
        ),
      ).toBeNull()
      expect(
        await withService(db.db, (tx) =>
          heartbeatJob(tx, a!, { leaseMs: 30_000, now: plus(2_000) }),
        ),
      ).toBeNull()

      expect(
        await withService(db.db, (tx) =>
          completeJob(tx, b!, { result: { by: 'B' }, now: plus(3_000) }),
        ),
      ).toBe(true)
      const final = await withService(db.db, (tx) => getJob(tx, job.id))
      expect(final).toMatchObject({
        status: 'succeeded',
        result: { by: 'B' },
        attempts: 2,
        leaseToken: null,
        finishedAt: plus(3_000),
      })
      // A finished job cannot be completed again, even with the right token.
      expect(await withService(db.db, (tx) => completeJob(tx, b!, { now: plus(4_000) }))).toBe(
        false,
      )
    } finally {
      await db.drop()
    }
  })

  it('heartbeats keep a long job leased', async () => {
    const db = await freshDb()
    try {
      await withService(db.db, (tx) => enqueueJob(tx, { kind: 'sync.rss' }, T0))
      const [a] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 1_000, now: T0 }),
      )
      const expiry = await withService(db.db, (tx) =>
        heartbeatJob(tx, a!, { leaseMs: 1_000, now: plus(800) }),
      )
      expect(expiry).toEqual(plus(1_800))
      expect(
        await withService(db.db, (tx) =>
          claimJobs(tx, { workerId: 'B', limit: 1, leaseMs: 1_000, now: plus(1_500) }),
        ),
      ).toEqual([])
      expect(await withService(db.db, (tx) => completeJob(tx, a!, { now: plus(1_700) }))).toBe(true)
    } finally {
      await db.drop()
    }
  })

  it('a lease that expires during the final attempt is reaped as dead', async () => {
    const db = await freshDb()
    try {
      const { job } = await withService(db.db, (tx) =>
        enqueueJob(tx, { kind: 'sync.rss', maxAttempts: 1 }, T0),
      )
      await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 1_000, now: T0 }),
      )
      expect(await withService(db.db, (tx) => reapExpiredJobs(tx, { now: plus(999) }))).toEqual([])
      expect(
        await withService(db.db, (tx) =>
          claimJobs(tx, { workerId: 'B', limit: 1, leaseMs: 1_000, now: plus(2_000) }),
        ),
      ).toEqual([])
      const reaped = await withService(db.db, (tx) =>
        reapExpiredJobs(tx, { kinds: ['sync.rss'], now: plus(2_000) }),
      )
      expect(reaped.map((j) => j.id)).toEqual([job.id])
      expect(reaped[0]).toMatchObject({
        status: 'dead',
        lastError: 'Lease expired during the final attempt',
        finishedAt: plus(2_000),
      })
    } finally {
      await db.drop()
    }
  })
})

describe('failure handling', () => {
  it('retries with deterministic backoff and becomes claimable only after run_at', async () => {
    const db = await freshDb()
    try {
      const { job } = await withService(db.db, (tx) => enqueueJob(tx, { kind: 'sync.rss' }, T0))
      const [c1] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: T0 }),
      )
      const failedAt = plus(500)
      expect(
        await withService(db.db, (tx) =>
          failJob(tx, c1!, { error: new Error('HTTP 503'), attempt: 1, now: failedAt }),
        ),
      ).toBe('failed')
      const expected = computeJobRetryAt({ now: failedAt, attempt: 1, seed: job.id })
      const row = await withService(db.db, (tx) => getJob(tx, job.id))
      expect(row).toMatchObject({
        status: 'failed',
        runAt: expected,
        lastError: 'HTTP 503',
        leaseToken: null,
        finishedAt: null,
      })
      expect(expected.getTime() - failedAt.getTime()).toBeGreaterThanOrEqual(24_000)
      expect(expected.getTime() - failedAt.getTime()).toBeLessThanOrEqual(30_000)

      const tooEarly = new Date(expected.getTime() - 1)
      expect(
        await withService(db.db, (tx) =>
          claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: tooEarly }),
        ),
      ).toEqual([])
      const [c2] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: expected }),
      )
      expect(c2?.attempts).toBe(2)
      // The second failure waits longer (exponential).
      await withService(db.db, (tx) =>
        failJob(tx, c2!, { error: 'again', attempt: 2, now: expected }),
      )
      const r2 = await withService(db.db, (tx) => getJob(tx, job.id))
      expect(r2!.runAt.getTime() - expected.getTime()).toBeGreaterThanOrEqual(48_000)
    } finally {
      await db.drop()
    }
  })

  it('honours Retry-After when it is later than the backoff', async () => {
    const db = await freshDb()
    try {
      const { job } = await withService(db.db, (tx) => enqueueJob(tx, { kind: 'sync.whoop' }, T0))
      const [c] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: T0 }),
      )
      const retryAfter = plus(15 * 60_000)
      await withService(db.db, (tx) =>
        failJob(tx, c!, { error: new Error('HTTP 429'), attempt: 1, retryAt: retryAfter, now: T0 }),
      )
      expect((await withService(db.db, (tx) => getJob(tx, job.id)))?.runAt).toEqual(retryAfter)
      // A day-long Retry-After is clamped at 24 hours in SQL too.
      const direct = await withService(db.db, async (tx) => {
        const [again] = await claimJobs(tx, {
          workerId: 'A',
          limit: 1,
          leaseMs: 10_000,
          now: retryAfter,
        })
        await tx`select private.fail_job(${again!.id}::uuid, ${again!.leaseToken}::uuid, 'x', ${plus(72 * 3_600_000)}::timestamptz, true, ${retryAfter}::timestamptz)`
        return getJob(tx, again!.id)
      })
      expect(direct?.runAt).toEqual(plus(24 * 3_600_000, retryAfter))
    } finally {
      await db.drop()
    }
  })

  it('goes dead after max attempts, or at once when not retryable', async () => {
    const db = await freshDb()
    try {
      const { job } = await withService(db.db, (tx) =>
        enqueueJob(tx, { kind: 'sync.rss', maxAttempts: 3 }, T0),
      )
      let now = T0
      const outcomes: (string | null)[] = []
      for (let i = 1; i <= 3; i++) {
        const [c] = await withService(db.db, (tx) =>
          claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now }),
        )
        expect(c?.attempts).toBe(i)
        outcomes.push(
          await withService(db.db, (tx) =>
            failJob(tx, c!, { error: `boom ${i}`, attempt: i, now }),
          ),
        )
        now = plus(2 * 3_600_000, now)
      }
      expect(outcomes).toEqual(['failed', 'failed', 'dead'])
      expect(await withService(db.db, (tx) => getJob(tx, job.id))).toMatchObject({
        status: 'dead',
        attempts: 3,
        lastError: 'boom 3',
      })
      expect(
        await withService(db.db, (tx) =>
          claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: plus(10 * 86_400_000) }),
        ),
      ).toEqual([])

      const { job: j2 } = await withService(db.db, (tx) => enqueueJob(tx, { kind: 'sync.rss' }, T0))
      const [c2] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: T0 }),
      )
      expect(c2?.id).toBe(j2.id)
      expect(
        await withService(db.db, (tx) =>
          failJob(tx, c2!, { error: 'invalid payload', attempt: 1, retryable: false, now: T0 }),
        ),
      ).toBe('dead')
    } finally {
      await db.drop()
    }
  })

  it('stores only a sanitised, bounded last_error', async () => {
    const db = await freshDb()
    try {
      const { job } = await withService(db.db, (tx) =>
        enqueueJob(tx, { kind: 'sync.google', maxAttempts: 2 }, T0),
      )
      const [c] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: T0 }),
      )
      const err = new Error(
        'token refresh failed for person@example.com: {"refresh_token":"1//0gSecretRefresh"} Authorization: Bearer ya29.secret\nat line 2',
      )
      await withService(db.db, (tx) => failJob(tx, c!, { error: err, attempt: 1, now: T0 }))
      const row = await withService(db.db, (tx) => getJob(tx, job.id))
      expect(row?.lastError).toBeTruthy()
      for (const leaked of ['person@example.com', '1//0gSecretRefresh', 'ya29.secret', '\n']) {
        expect(row?.lastError).not.toContain(leaked)
      }
      expect(row!.lastError!.length).toBeLessThanOrEqual(500)

      // The SQL backstop strips control characters and truncates even if a caller forgets to sanitise.
      const [c2] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: plus(7_200_000) }),
      )
      const raw = `line1\nline2\u0007${'x'.repeat(5000)}`
      await t.db`select 1` // keep the shared pool warm
      await withService(
        db.db,
        (tx) =>
          tx`select private.fail_job(${c2!.id}::uuid, ${c2!.leaseToken}::uuid, ${raw}, null, true, ${plus(7_200_000)}::timestamptz)`,
      )
      const row2 = await withService(db.db, (tx) => getJob(tx, job.id))
      expect(row2?.lastError?.length).toBe(1000)
      expect(row2?.lastError).not.toMatch(/[\u0000-\u001f]/)
      expect(row2?.status).toBe('dead')
    } finally {
      await db.drop()
    }
  })
})

describe('schedules', () => {
  it('syncs definitions idempotently and tracks enabled_since', async () => {
    const db = await freshDb()
    try {
      await withService(db.db, (tx) => syncJobSchedules(tx, JOB_SCHEDULE_DEFINITIONS, T0))
      const first = await withService(db.db, (tx) => listJobSchedules(tx))
      expect(first.map((s) => s.name).sort()).toEqual(
        JOB_SCHEDULE_DEFINITIONS.map((d) => d.name).sort(),
      )
      const morning = first.find((s) => s.name === 'briefing.morning')!
      expect(morning).toMatchObject({
        cadence: 'daily_local_time',
        localTime: '11:00',
        enabled: true,
        enabledSince: T0,
      })
      expect(first.find((s) => s.name === 'sync.google')).toMatchObject({
        enabled: false,
        enabledSince: null,
        intervalSeconds: 900,
      })

      // Re-sync later: nothing changes (enabled_since is not bumped, no write at all).
      await withService(db.db, (tx) =>
        syncJobSchedules(tx, JOB_SCHEDULE_DEFINITIONS, plus(86_400_000)),
      )
      const second = await withService(db.db, (tx) => listJobSchedules(tx))
      expect(second).toEqual(first)

      // Disable, then re-enable: enabled_since moves to the re-enable time.
      const without: JobScheduleDefinition[] = JOB_SCHEDULE_DEFINITIONS.filter(
        (d) => d.name !== 'briefing.evening',
      )
      await withService(db.db, (tx) => syncJobSchedules(tx, without, plus(1_000)))
      expect(
        (await withService(db.db, (tx) => listJobSchedules(tx))).find(
          (s) => s.name === 'briefing.evening',
        ),
      ).toMatchObject({
        enabled: false,
        enabledSince: null,
      })
      await withService(db.db, (tx) => syncJobSchedules(tx, JOB_SCHEDULE_DEFINITIONS, plus(2_000)))
      expect(
        (await withService(db.db, (tx) => listJobSchedules(tx))).find(
          (s) => s.name === 'briefing.evening',
        ),
      ).toMatchObject({
        enabled: true,
        enabledSince: plus(2_000),
      })
    } finally {
      await db.drop()
    }
  })

  it('completing a scheduled job records last_success_at', async () => {
    const db = await freshDb()
    try {
      await withService(db.db, (tx) => syncJobSchedules(tx, JOB_SCHEDULE_DEFINITIONS, T0))
      await withService(db.db, (tx) =>
        enqueueJob(
          tx,
          {
            kind: 'briefing.morning',
            dedupeKey: 'briefing.morning:2026-09-24',
            scheduleName: 'briefing.morning',
          },
          T0,
        ),
      )
      const [c] = await withService(db.db, (tx) =>
        claimJobs(tx, { workerId: 'A', limit: 1, leaseMs: 10_000, now: T0 }),
      )
      await withService(db.db, (tx) => completeJob(tx, c!, { now: plus(5_000) }))
      const s = (await withService(db.db, (tx) => listJobSchedules(tx))).find(
        (x) => x.name === 'briefing.morning',
      )
      expect(s?.lastSuccessAt).toEqual(plus(5_000))
    } finally {
      await db.drop()
    }
  })

  it('reads the owner context for scheduling', async () => {
    const db = await freshDb()
    try {
      expect(await withService(db.db, (tx) => readJobOwnerContext(tx))).toEqual({
        hasOwner: false,
        timezone: 'Europe/London',
        timezoneConfirmed: false,
      })
      await seedOwner(db.db)
      await db.db`update public.owner_settings set timezone = 'Asia/Kolkata', timezone_confirmed = true`
      expect(await withService(db.db, (tx) => readJobOwnerContext(tx))).toEqual({
        hasOwner: true,
        timezone: 'Asia/Kolkata',
        timezoneConfirmed: true,
      })
    } finally {
      await db.drop()
    }
  })
})
