/**
 * Dispatcher loop against a real Postgres: budget, isolation, timeouts,
 * heartbeats, lease loss, aborts and schedule materialisation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  JOB_SCHEDULE_DEFINITIONS,
  JobFailure,
  type JobKind,
  type JobScheduleDefinition,
} from '@personal-home/core'
import {
  claimJobs,
  countJobsByStatus,
  enqueueJob,
  getJob,
  listJobs,
  withService,
  type Db,
} from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import {
  createDefaultJobHandlerRegistry,
  createJobHandlerRegistry,
  registeredJobKinds,
  runDispatcher,
  type DispatcherLogEvent,
  type JobHandler,
  type RunDispatcherOptions,
} from '../src/index.ts'

// The db harness reads its template via inject('templateDb'). That key is typed in
// packages/db/test/global-setup.ts, which this package's tsconfig does not include.
declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

const dbs: TestDatabase[] = []
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.drop()
})

async function freshDb(): Promise<TestDatabase> {
  const t = await createTestDatabase()
  dbs.push(t)
  return t
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })

/** No recurring schedules unless a test asks for them. */
const NO_SCHEDULES: readonly JobScheduleDefinition[] = []

function handler(
  kind: JobKind,
  run: JobHandler['run'],
  extra: Partial<JobHandler> = {},
): JobHandler {
  return { kind, run, ...extra }
}

async function enqueueMany(db: Db, kind: JobKind, n: number, at = new Date(Date.now() - 1_000)) {
  for (let i = 0; i < n; i++) {
    await withService(db, (tx) => enqueueJob(tx, { kind, payload: { n: i } }, at))
  }
}

function dispatch(
  db: Db,
  o: Partial<RunDispatcherOptions> & Pick<RunDispatcherOptions, 'handlers'>,
) {
  return runDispatcher({
    db,
    workerId: 'test-worker',
    budgetMs: 10_000,
    maxJobs: 100,
    schedules: NO_SCHEDULES,
    defaultJobTimeoutMs: 2_000,
    finalizeReserveMs: 200,
    ...o,
  })
}

describe('runDispatcher', () => {
  it('stops before its time budget and leaves unclaimed jobs queued', async () => {
    const t = await freshDb()
    await enqueueMany(t.db, 'sync.rss', 30)
    const handlers = createJobHandlerRegistry([
      handler(
        'sync.rss',
        async (ctx) => {
          await sleep(200, ctx.signal)
          return { ok: true }
        },
        { timeoutMs: 400 },
      ),
    ])
    const budgetMs = 1_500
    const t0 = performance.now()
    const summary = await dispatch(t.db, { handlers, budgetMs, finalizeReserveMs: 150 })
    const elapsed = performance.now() - t0

    expect(summary.stoppedReason).toBe('budget')
    expect(elapsed).toBeLessThanOrEqual(budgetMs + 100)
    expect(summary.durationMs).toBeLessThanOrEqual(budgetMs)
    expect(summary.totals.succeeded).toBeGreaterThanOrEqual(3)
    expect(summary.totals.succeeded).toBeLessThan(30)
    const counts = await withService(t.db, (tx) => countJobsByStatus(tx))
    // Nothing is left leased: jobs that did not fit were never claimed.
    expect(counts.running ?? 0).toBe(0)
    expect(counts.succeeded).toBe(summary.totals.succeeded)
    expect(counts.queued).toBe(30 - summary.totals.succeeded)
  })

  it('isolates throwing handlers: other jobs still succeed', async () => {
    const t = await freshDb()
    await enqueueMany(t.db, 'sync.rss', 6)
    const deadSeen: string[] = []
    const handlers = createJobHandlerRegistry([
      handler(
        'sync.rss',
        (ctx) => {
          const n = ctx.job.payload.n as number
          if (n === 1) throw new Error('synchronous throw') // not even a rejected promise
          if (n === 3) return Promise.reject(new TypeError('async rejection'))
          if (n === 4) throw new JobFailure('invalid payload', { retryable: false })
          return Promise.resolve({ n })
        },
        { onDead: async (ctx) => void deadSeen.push(ctx.error) },
      ),
    ])
    const summary = await dispatch(t.db, { handlers })
    expect(summary.stoppedReason).toBe('idle')
    expect(summary.totals).toMatchObject({
      claimed: 6,
      succeeded: 3,
      retrying: 2,
      dead: 1,
      leaseLost: 0,
    })
    expect(deadSeen).toEqual(['JobFailure: invalid payload'])
    const jobs = await withService(t.db, (tx) => listJobs(tx, { kind: 'sync.rss' }))
    const byN = new Map(jobs.map((j) => [j.payload.n as number, j]))
    expect(byN.get(1)).toMatchObject({ status: 'failed', lastError: 'synchronous throw' })
    expect(byN.get(3)).toMatchObject({ status: 'failed', lastError: 'TypeError: async rejection' })
    expect(byN.get(4)).toMatchObject({ status: 'dead' })
    expect(byN.get(5)).toMatchObject({ status: 'succeeded', result: { n: 5 } })
  })

  it('times out a hung handler that ignores its signal and moves on', async () => {
    const t = await freshDb()
    await enqueueMany(t.db, 'sync.rss', 1)
    await enqueueMany(t.db, 'sync.whoop', 1)
    const handlers = createJobHandlerRegistry([
      handler('sync.rss', () => new Promise(() => {}), { timeoutMs: 200 }),
      handler('sync.whoop', async () => ({ ok: true }), { timeoutMs: 200 }),
    ])
    const summary = await dispatch(t.db, { handlers })
    expect(summary.totals).toMatchObject({ claimed: 2, succeeded: 1, retrying: 1, timedOut: 1 })
    const [rss] = await withService(t.db, (tx) => listJobs(tx, { kind: 'sync.rss' }))
    expect(rss).toMatchObject({
      status: 'failed',
      lastError: 'JobTimeoutError: Job timed out after 200 ms',
    })
  })

  it('passes Retry-After from a JobFailure through to run_at', async () => {
    const t = await freshDb()
    const now = new Date('2026-09-24T12:00:00Z')
    const { job } = await withService(t.db, (tx) => enqueueJob(tx, { kind: 'sync.whoop' }, now))
    const retryAt = new Date('2026-09-24T12:20:00Z')
    const handlers = createJobHandlerRegistry([
      handler('sync.whoop', async () => {
        throw new JobFailure('HTTP 429 from provider', { retryAt })
      }),
    ])
    await dispatch(t.db, { handlers, now: () => now })
    expect(await withService(t.db, (tx) => getJob(tx, job.id))).toMatchObject({
      status: 'failed',
      runAt: retryAt,
    })
    // Not claimable before then.
    const early = await dispatch(t.db, { handlers, now: () => new Date('2026-09-24T12:19:59Z') })
    expect(early.totals.claimed).toBe(0)
  })

  it('heartbeats keep a long job leased so no other worker can take it', async () => {
    const t = await freshDb()
    await enqueueMany(t.db, 'sync.rss', 1)
    let stolen = 0
    let running = true
    let thief: Promise<void> = Promise.resolve()
    const handlers = createJobHandlerRegistry([
      handler(
        'sync.rss',
        async (ctx) => {
          // Another worker polls for due jobs for the whole time this job runs.
          thief = (async () => {
            while (running) {
              const got = await withService(t.db, (tx) =>
                claimJobs(tx, { workerId: 'thief', limit: 1, leaseMs: 10_000 }),
              )
              stolen += got.length
              await sleep(50)
            }
          })()
          await sleep(1_200, ctx.signal)
          return { done: true }
        },
        { timeoutMs: 3_000 },
      ),
    ])
    // The lease (400 ms) is far shorter than the job (1.2 s): only heartbeats keep it.
    const summary = await dispatch(t.db, { handlers, leaseMs: 400, heartbeatIntervalMs: 100 })
    running = false
    await thief
    expect(stolen).toBe(0)
    expect(summary.totals).toMatchObject({ succeeded: 1, leaseLost: 0 })
    const [job] = await withService(t.db, (tx) => listJobs(tx, { kind: 'sync.rss' }))
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1, leaseOwner: 'test-worker' })
  })

  it('aborts a job whose lease was taken over and does not overwrite the new holder', async () => {
    const t = await freshDb()
    await enqueueMany(t.db, 'sync.rss', 1)
    let sawAbort: unknown = null
    const handlers = createJobHandlerRegistry([
      handler(
        'sync.rss',
        async (ctx) => {
          // Simulate a stall long enough for the lease to be reclaimed elsewhere.
          await withService(
            ctx.db,
            (tx) =>
              tx`update private.jobs set lease_expires_at = now() - interval '1 second' where id = ${ctx.job.id}::uuid`,
          )
          const [taken] = await withService(ctx.db, (tx) =>
            claimJobs(tx, { workerId: 'other', limit: 1, leaseMs: 60_000 }),
          )
          expect(taken?.id).toBe(ctx.job.id)
          try {
            await sleep(5_000, ctx.signal)
          } catch (err) {
            sawAbort = err
            throw err
          }
        },
        { timeoutMs: 6_000 },
      ),
    ])
    const summary = await dispatch(t.db, { handlers, leaseMs: 600, heartbeatIntervalMs: 100 })
    expect(summary.totals).toMatchObject({ claimed: 1, leaseLost: 1, succeeded: 0 })
    expect(String(sawAbort)).toMatch(/Lease lost/)
    const [job] = await withService(t.db, (tx) => listJobs(tx, { kind: 'sync.rss' }))
    // Still running under the other worker's lease, untouched by the first worker.
    expect(job).toMatchObject({ status: 'running', leaseOwner: 'other', attempts: 2 })
  })

  it('stops on abort and records the interrupted job as retryable', async () => {
    const t = await freshDb()
    await enqueueMany(t.db, 'sync.rss', 3)
    const controller = new AbortController()
    const handlers = createJobHandlerRegistry([
      handler('sync.rss', async (ctx) => {
        setTimeout(() => controller.abort(), 50)
        await sleep(2_000, ctx.signal)
      }),
    ])
    const summary = await dispatch(t.db, { handlers, signal: controller.signal })
    expect(summary.stoppedReason).toBe('aborted')
    expect(summary.totals).toMatchObject({ claimed: 1, retrying: 1 })
    const counts = await withService(t.db, (tx) => countJobsByStatus(tx))
    expect(counts).toEqual({ failed: 1, queued: 2 })
  })

  it('respects maxJobs and never claims kinds it has no handler for', async () => {
    const t = await freshDb()
    await enqueueMany(t.db, 'sync.rss', 5)
    await enqueueMany(t.db, 'sync.google', 2)
    const handlers = createJobHandlerRegistry([handler('sync.rss', async () => ({}))])
    const first = await dispatch(t.db, { handlers, maxJobs: 3 })
    expect(first).toMatchObject({ stoppedReason: 'max_jobs', totals: { claimed: 3 } })
    const second = await dispatch(t.db, { handlers })
    expect(second).toMatchObject({ stoppedReason: 'idle', totals: { claimed: 2 } })
    const google = await withService(t.db, (tx) => listJobs(tx, { kind: 'sync.google' }))
    expect(google.map((j) => j.status)).toEqual(['queued', 'queued'])
  })

  it('reaps jobs whose lease expired on their final attempt and runs onDead', async () => {
    const t = await freshDb()
    const past = new Date(Date.now() - 60_000)
    const { job } = await withService(t.db, (tx) =>
      enqueueJob(tx, { kind: 'sync.rss', maxAttempts: 1 }, past),
    )
    await withService(t.db, (tx) =>
      claimJobs(tx, { workerId: 'crashed', limit: 1, leaseMs: 1_000, now: past }),
    )
    const dead: string[] = []
    const handlers = createJobHandlerRegistry([
      handler('sync.rss', async () => ({}), { onDead: async (ctx) => void dead.push(ctx.job.id) }),
    ])
    const summary = await dispatch(t.db, { handlers })
    expect(summary.reaped).toBe(1)
    expect(dead).toEqual([job.id])
    expect(await withService(t.db, (tx) => getJob(tx, job.id))).toMatchObject({ status: 'dead' })
  })

  it('materialises schedules idempotently and reports why a schedule is skipped', async () => {
    const t = await freshDb()
    const schedules: JobScheduleDefinition[] = [
      {
        name: 'briefing.morning',
        kind: 'briefing.morning',
        cadence: 'daily_local_time',
        localTime: '11:00',
        enabled: true,
      },
      {
        name: 'sync.rss',
        kind: 'sync.rss',
        cadence: 'interval',
        intervalSeconds: 3_600,
        enabled: true,
      },
      {
        name: 'sync.google',
        kind: 'sync.google',
        cadence: 'interval',
        intervalSeconds: 900,
        enabled: false,
      },
    ]
    const ran: string[] = []
    const handlers = createJobHandlerRegistry([
      handler('sync.rss', async (ctx) => {
        ran.push(String(ctx.job.payload.periodStart))
        return {}
      }),
    ])
    const at = (iso: string) => () => new Date(iso)

    // No owner yet: nothing is scheduled.
    const before = await dispatch(t.db, { handlers, schedules, now: at('2026-09-24T12:10:00Z') })
    expect(before.schedules?.skipped).toEqual([
      { name: 'briefing.morning', reason: 'no_handler' },
      { name: 'sync.rss', reason: 'no_owner' },
    ])

    await seedOwner(t.db)
    // claimed_at defaults to the real clock; the schedule starts no earlier than the claim.
    await t.db`update private.owner set claimed_at = '2026-09-24T12:12:00Z'`
    const runs = await Promise.all([
      dispatch(t.db, { handlers, schedules, now: at('2026-09-24T12:15:00Z'), workerId: 'a' }),
      dispatch(t.db, { handlers, schedules, now: at('2026-09-24T12:15:00Z'), workerId: 'b' }),
    ])
    const again = await dispatch(t.db, { handlers, schedules, now: at('2026-09-24T12:40:00Z') })
    expect(runs.reduce((n, r) => n + (r.schedules?.enqueued ?? 0), 0)).toBe(1)
    expect(again.schedules?.enqueued).toBe(0)
    expect(ran).toEqual(['2026-09-24T12:00:00.000Z'])

    const next = await dispatch(t.db, { handlers, schedules, now: at('2026-09-24T13:00:00Z') })
    expect(next.schedules?.enqueued).toBe(1)
    expect(ran).toEqual(['2026-09-24T12:00:00.000Z', '2026-09-24T13:00:00.000Z'])
    const jobs = await withService(t.db, (tx) => listJobs(tx, { kind: 'sync.rss' }))
    expect(jobs.map((j) => j.dedupeKey)).toEqual([
      'sync.rss:2026-09-24T12:00:00.000Z',
      'sync.rss:2026-09-24T13:00:00.000Z',
    ])
    expect(jobs.every((j) => j.scheduleName === 'sync.rss')).toBe(true)
  })

  it('summaries and logs carry no payloads or error text', async () => {
    const t = await freshDb()
    const secret = 'journal: my private thoughts'
    await withService(t.db, (tx) =>
      enqueueJob(tx, { kind: 'sync.rss', payload: { note: secret } }, new Date(Date.now() - 1000)),
    )
    const events: DispatcherLogEvent[] = []
    const handlers = createJobHandlerRegistry([
      handler('sync.rss', async () => {
        throw new Error('failed while reading person@example.com with Bearer abcdefghijklmnop')
      }),
    ])
    const summary = await dispatch(t.db, { handlers, log: (e) => events.push(e) })
    const text = JSON.stringify(summary) + JSON.stringify(events)
    expect(text).not.toContain('private thoughts')
    expect(text).not.toContain('person@example.com')
    expect(text).not.toContain('abcdefghijklmnop')
    expect(summary.jobs[0]).toMatchObject({ kind: 'sync.rss', outcome: 'retrying' })
  })

  it('rejects invalid options', async () => {
    const t = await freshDb()
    const handlers = createJobHandlerRegistry([])
    await expect(dispatch(t.db, { handlers, budgetMs: 0 })).rejects.toThrow(RangeError)
    await expect(dispatch(t.db, { handlers, maxJobs: -1 })).rejects.toThrow(RangeError)
    await expect(
      dispatch(t.db, { handlers, leaseMs: 100, heartbeatIntervalMs: 200 }),
    ).rejects.toThrow(RangeError)
    const slow = createJobHandlerRegistry([
      handler('sync.rss', async () => {}, { timeoutMs: 60_000 }),
    ])
    await expect(dispatch(t.db, { handlers: slow, budgetMs: 30_000 })).rejects.toThrow(
      /exceeds budgetMs for: sync.rss/,
    )
    expect(() =>
      createJobHandlerRegistry([
        handler('sync.rss', async () => {}),
        handler('sync.rss', async () => {}),
      ]),
    ).toThrow(/duplicate/)
  })
})

describe('default handler registry', () => {
  it('has a real handler for every enabled schedule, and every other schedule stays disabled', () => {
    const registry = createDefaultJobHandlerRegistry()
    expect(registeredJobKinds(registry)).toEqual(['ai.reconcile', 'briefing.evening', 'briefing.morning', 'retention.purge', 'sync.google', 'sync.microsoft'])
    for (const def of JOB_SCHEDULE_DEFINITIONS) {
      if (def.enabled) expect(registry[def.kind], def.name).toBeDefined()
      else expect(registry[def.kind], def.name).toBeUndefined()
    }
  })
})
