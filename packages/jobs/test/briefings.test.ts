/**
 * Briefing jobs end to end: scheduler → queue → handler → public.briefings,
 * against a real Postgres with a simulated clock.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addLocalDays,
  buildBriefingSkeletonContent,
  localTimeInZone,
  zonedLocalToUtc,
  type BriefingKind,
  type ClaimedJob,
} from '@personal-home/core'
import {
  enqueueJob,
  insertOrGetBriefing,
  listJobs,
  withService,
  type BriefingRow,
} from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import {
  briefingJobHandlers,
  createBriefingJobHandler,
  createJobHandlerRegistry,
  runDispatcher,
  type JobContext,
  type JobHandlerRegistry,
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

const registry = createJobHandlerRegistry(briefingJobHandlers)

/** The simulated clocks below start in March 2026; the owner is claimed before all of them. */
const OWNER_CLAIMED_AT = '2026-01-01T00:00:00Z'

async function claimOwner(t: TestDatabase, claimedAt = OWNER_CLAIMED_AT) {
  await seedOwner(t.db)
  // claimed_at defaults to the real clock; align it with the simulated one.
  await t.db`update private.owner set claimed_at = ${claimedAt}::timestamptz`
}

async function setup(timezone = 'Europe/London'): Promise<TestDatabase> {
  const t = await createTestDatabase()
  dbs.push(t)
  await claimOwner(t)
  await t.db`update public.owner_settings set timezone = ${timezone}, timezone_confirmed = true`
  return t
}

/** The content published on a row makes no claim that contradicts its late label. */
function expectNoTimingClaim(row: BriefingRow | undefined) {
  expect(row?.status).toBe('published')
  expect(JSON.stringify(row?.content)).not.toMatch(/on schedule|on time/i)
}

async function setTimezone(t: TestDatabase, timezone: string) {
  await t.db`update public.owner_settings set timezone = ${timezone}`
}

function tick(
  t: TestDatabase,
  at: Date | string,
  handlers: JobHandlerRegistry = registry,
  workerId = 'tick',
) {
  const now = typeof at === 'string' ? new Date(at) : at
  return runDispatcher({
    db: t.db,
    workerId,
    handlers,
    budgetMs: 30_000,
    maxJobs: 20,
    now: () => now,
  })
}

/** Run the dispatcher every `stepMinutes` from `from` (inclusive) to `to` (exclusive). */
async function tickEvery(
  t: TestDatabase,
  from: string,
  to: string,
  stepMinutes: number,
  handlers = registry,
) {
  for (let ms = Date.parse(from); ms < Date.parse(to); ms += stepMinutes * 60_000) {
    const s = await tick(t, new Date(ms), handlers)
    expect(s.errors).toEqual([])
  }
}

async function rows(t: TestDatabase, kind?: BriefingKind): Promise<BriefingRow[]> {
  const all = await withService(
    t.db,
    (tx) => tx<BriefingRow[]>`select * from public.briefings order by kind, local_date`,
  )
  return kind ? all.filter((r) => r.kind === kind) : [...all]
}

function directContext(
  t: TestDatabase,
  kind: BriefingKind,
  payload: Record<string, unknown>,
  now: Date,
): JobContext {
  const job = {
    id: randomUUID(),
    kind: kind === 'morning' ? 'briefing.morning' : 'briefing.evening',
    dedupeKey: null,
    scheduleName: null,
    payload,
    status: 'running',
    runAt: now,
    attempts: 1,
    maxAttempts: 5,
    leaseOwner: 'direct',
    leaseToken: randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    lastError: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  } satisfies ClaimedJob
  return {
    job,
    db: t.db,
    now: () => now,
    signal: new AbortController().signal,
    workerId: 'direct',
    heartbeat: async () => true,
  }
}

const london = (date: string, time: string) => zonedLocalToUtc(date, time, 'Europe/London')

describe('briefing idempotency', () => {
  it('running the same morning job twice publishes one briefing', async () => {
    const t = await setup()
    const payload = {
      localDate: '2026-09-24',
      scheduledFor: '2026-09-24T10:00:00.000Z',
      timezone: 'Europe/London',
    }
    const handler = createBriefingJobHandler('morning')
    const now = new Date('2026-09-24T10:00:30Z')
    const first = await handler.run(directContext(t, 'morning', payload, now))
    const second = await handler.run(directContext(t, 'morning', payload, now))
    expect(first).toMatchObject({ outcome: 'published', localDate: '2026-09-24', isLate: false })
    expect(second).toMatchObject({ outcome: 'already_published' })
    const r = await rows(t)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      kind: 'morning',
      localDate: '2026-09-24',
      status: 'published',
      notify: true,
      isLate: false,
    })
  })

  it('running it concurrently publishes one briefing', async () => {
    const t = await setup()
    const payload = {
      localDate: '2026-09-24',
      scheduledFor: '2026-09-24T21:00:00.000Z',
      timezone: 'Europe/London',
    }
    const handler = createBriefingJobHandler('evening')
    const now = new Date('2026-09-24T21:00:05Z')
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handler.run(directContext(t, 'evening', payload, now))),
    )
    expect(results.filter((r) => r && r.outcome === 'published')).toHaveLength(1)
    expect(results.filter((r) => r && r.outcome === 'already_published')).toHaveLength(5)
    expect(await rows(t)).toHaveLength(1)

    // Two dispatchers ticking at the same moment enqueue and publish once.
    const t2 = await setup()
    await tick(t2, '2026-09-24T09:00:00Z') // schedules enabled before 11:00
    await Promise.all([
      tick(t2, '2026-09-24T10:00:00Z', registry, 'a'),
      tick(t2, '2026-09-24T10:00:00Z', registry, 'b'),
      tick(t2, '2026-09-24T10:00:00Z', registry, 'c'),
    ])
    expect((await rows(t2)).map((r) => `${r.kind}:${r.localDate}:${r.status}`)).toEqual([
      'morning:2026-09-24:published',
    ])
    expect(
      await withService(t2.db, (tx) => listJobs(tx, { kind: 'briefing.morning' })),
    ).toHaveLength(1)
  })

  it('a failed attempt is retried into the same row', async () => {
    const t = await setup()
    let calls = 0
    const flaky = createJobHandlerRegistry([
      createBriefingJobHandler('morning', {
        buildContent: (kind, localDate) => {
          calls++
          if (calls === 1) throw new Error('cache refresh failed')
          return buildBriefingSkeletonContent(kind, localDate)
        },
      }),
    ])
    await tick(t, '2026-09-24T09:00:00Z', flaky)
    const first = await tick(t, '2026-09-24T10:00:00Z', flaky)
    expect(first.totals).toMatchObject({ claimed: 1, retrying: 1 })
    expect((await rows(t, 'morning')).map((r) => r.status)).toEqual(['preparing'])

    await tick(t, '2026-09-24T10:02:00Z', flaky)
    const r = await rows(t, 'morning')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      status: 'published',
      isLate: false,
      notify: true,
      publishedAt: new Date('2026-09-24T10:02:00Z'),
    })
    const [job] = await withService(t.db, (tx) => listJobs(tx, { kind: 'briefing.morning' }))
    expect(job).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      lastError: 'cache refresh failed',
    })
  })

  it('marks the briefing failed (not "preparing") when the job dies', async () => {
    const t = await setup()
    const broken = createJobHandlerRegistry([
      createBriefingJobHandler('morning', {
        buildContent: () => {
          throw new Error('always broken')
        },
      }),
    ])
    await tick(t, '2026-09-24T09:00:00Z', broken)
    // Five attempts with backoff (30 s, 1 min, 2 min, 4 min), all within the same morning.
    await tickEvery(t, '2026-09-24T10:00:00Z', '2026-09-24T11:00:00Z', 5, broken)
    const [job] = await withService(t.db, (tx) => listJobs(tx, { kind: 'briefing.morning' }))
    expect(job).toMatchObject({ status: 'dead', attempts: 5 })
    const [row] = await rows(t, 'morning')
    expect(row).toMatchObject({ status: 'failed', notify: false, publishedAt: null })
    expect(row?.content).toMatchObject({ failure: { code: 'job_failed' } })
  })
})

describe('local-time scheduling', () => {
  it('publishes at 11:00 and 22:00 Europe/London each day across both 2026 DST changes', async () => {
    const t = await setup('Europe/London')
    for (const [from, to, days] of [
      [
        '2026-03-27T00:00:00Z',
        '2026-04-01T00:00:00Z',
        ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'],
      ],
      [
        '2026-10-23T00:00:00Z',
        '2026-10-28T00:00:00Z',
        ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'],
      ],
    ] as const) {
      await tickEvery(t, from, to, 30)
      for (const kind of ['morning', 'evening'] as const) {
        const localTime = kind === 'morning' ? '11:00' : '22:00'
        const got = (await rows(t, kind)).filter((r) => days.includes(r.localDate as never))
        expect(got.map((r) => r.localDate)).toEqual([...days])
        for (const r of got) {
          expect(r.scheduledFor).toEqual(london(r.localDate, localTime))
          // Published on the first tick at/after the scheduled instant: exactly on time.
          expect(r.publishedAt).toEqual(r.scheduledFor)
          expect(localTimeInZone(r.publishedAt!, 'Europe/London')).toBe(localTime)
          expect(r).toMatchObject({
            status: 'published',
            isLate: false,
            notify: true,
            timezone: 'Europe/London',
          })
        }
      }
    }
    // The UTC hour moves with DST; the local hour does not. (22 October is the one
    // catch-up briefing after the gap between the two simulated periods: late, silent.)
    const utcHours = (await rows(t, 'morning')).map(
      (r) => `${r.localDate}@${r.scheduledFor.getUTCHours()}`,
    )
    expect(utcHours).toEqual([
      '2026-03-27@11',
      '2026-03-28@11',
      '2026-03-29@10',
      '2026-03-30@10',
      '2026-03-31@10',
      '2026-10-22@10',
      '2026-10-23@10',
      '2026-10-24@10',
      '2026-10-25@11',
      '2026-10-26@11',
      '2026-10-27@11',
    ])
  })

  it('an owner timezone change mid-day does not create a second briefing for the same local date', async () => {
    const t = await setup('Europe/London')
    await tick(t, '2026-06-10T09:00:00Z')
    await tick(t, '2026-06-10T10:00:00Z') // 11:00 BST → morning 2026-06-10
    expect((await rows(t, 'morning')).map((r) => r.localDate)).toEqual(['2026-06-10'])

    // At 13:00 BST the owner moves to New York (08:00 EDT, still 10 June there).
    await setTimezone(t, 'America/New_York')
    await tickEvery(t, '2026-06-10T12:00:00Z', '2026-06-11T16:00:00Z', 30)

    const morning = await rows(t, 'morning')
    expect(morning.map((r) => `${r.localDate}:${r.timezone}`)).toEqual([
      '2026-06-10:Europe/London', // 11:00 EDT on 10 June did not publish a second one
      '2026-06-11:America/New_York',
    ])
    expect(morning[1]?.scheduledFor).toEqual(new Date('2026-06-11T15:00:00Z'))
    const evening = await rows(t, 'evening')
    expect(
      evening.map((r) => `${r.localDate}:${r.timezone}:${r.scheduledFor.toISOString()}`),
    ).toEqual(['2026-06-10:America/New_York:2026-06-11T02:00:00.000Z'])
    const morningJobs = await withService(t.db, (tx) => listJobs(tx, { kind: 'briefing.morning' }))
    expect(morningJobs.map((j) => j.dedupeKey)).toEqual([
      'briefing.morning:2026-06-10',
      'briefing.morning:2026-06-11',
    ])
  })

  it('moving east mid-day does not duplicate a date; a missed evening is published once, late', async () => {
    const t = await setup('America/New_York')
    await tick(t, '2026-06-10T13:00:00Z')
    await tick(t, '2026-06-10T15:00:00Z') // 11:00 EDT → morning 2026-06-10
    // At 12:00 EDT (16:00Z) the owner moves to Tokyo, where it is already 01:00 on 11 June.
    await setTimezone(t, 'Asia/Tokyo')
    await tickEvery(t, '2026-06-10T16:00:00Z', '2026-06-11T14:00:00Z', 30)
    const morning = await rows(t, 'morning')
    expect(morning.map((r) => `${r.localDate}:${r.timezone}`)).toEqual([
      '2026-06-10:America/New_York',
      '2026-06-11:Asia/Tokyo', // 11:00 JST = 02:00Z
    ])
    expect(morning.every((r) => !r.isLate)).toBe(true)
    const evening = await rows(t, 'evening')
    // 22:00 EDT on 10 June never comes (the owner left). 22:00 JST on 10 June (13:00Z) had
    // already passed when the owner switched, so it is the latest due evening review:
    // published once, labelled late, no notification. 11 June is on time.
    expect(
      evening.map(
        (r) => `${r.localDate}:${r.timezone}:${r.isLate ? 'late' : 'on-time'}:${r.notify}`,
      ),
    ).toEqual(['2026-06-10:Asia/Tokyo:late:false', '2026-06-11:Asia/Tokyo:on-time:true'])
  })
})

describe('late publication and outages', () => {
  it('labels a briefing published more than 30 minutes late and does not notify', async () => {
    const t = await setup('Europe/London')
    await tick(t, '2026-09-24T09:00:00Z')
    // The dispatcher was down at 11:00; it comes back at 11:30 exactly (not late) …
    await tick(t, '2026-09-24T10:30:00Z')
    // … and for the evening at 22:31 (late).
    await tick(t, '2026-09-24T21:31:00Z')
    const [evening] = await rows(t, 'evening')
    const [morning] = await rows(t, 'morning')
    expect(morning).toMatchObject({
      isLate: false,
      notify: true,
      publishedAt: new Date('2026-09-24T10:30:00Z'),
    })
    expect(evening).toMatchObject({
      isLate: true,
      notify: false,
      publishedAt: new Date('2026-09-24T21:31:00Z'),
    })
    expectNoTimingClaim(evening)
  })

  it('after a 3-day outage publishes only the latest due briefing per kind, late and silent', async () => {
    const t = await setup('Europe/London')
    await tick(t, '2026-06-01T09:00:00Z')
    await tick(t, '2026-06-01T10:00:00Z') // morning 1 June, on time
    await tick(t, '2026-06-01T21:00:00Z') // evening 1 June, on time
    // Outage: nothing runs until 09:00 BST on 4 June.
    await tick(t, '2026-06-04T08:00:00Z')
    let all = await rows(t)
    expect(
      all.map(
        (r) =>
          `${r.kind}:${r.localDate}:${r.isLate ? 'late' : 'on-time'}:${r.notify ? 'notify' : 'silent'}`,
      ),
    ).toEqual([
      'evening:2026-06-01:on-time:notify',
      'evening:2026-06-03:late:silent', // only the latest missed evening
      'morning:2026-06-01:on-time:notify',
      'morning:2026-06-03:late:silent', // only the latest missed morning
    ])
    for (const r of all.filter((x) => x.isLate)) expectNoTimingClaim(r)
    // Back to normal at 11:00 on 4 June.
    await tick(t, '2026-06-04T10:00:00Z')
    all = await rows(t, 'morning')
    expect(all.at(-1)).toMatchObject({ localDate: '2026-06-04', isLate: false, notify: true })
    const jobs = await withService(t.db, (tx) => listJobs(tx))
    expect(jobs.map((j) => j.dedupeKey).sort()).toEqual([
      'briefing.evening:2026-06-01',
      'briefing.evening:2026-06-03',
      'briefing.morning:2026-06-01',
      'briefing.morning:2026-06-03',
      'briefing.morning:2026-06-04',
    ])
    expect(all.filter((r) => r.localDate === '2026-06-02')).toEqual([])
  })

  it('stale jobs still queued from before an outage are superseded, not published', async () => {
    const t = await setup('Europe/London')
    await tick(t, '2026-06-01T09:00:00Z')
    // Jobs for 1 and 2 June were enqueued but never ran (e.g. every handler call crashed the worker).
    for (const d of ['2026-06-01', '2026-06-02']) {
      await withService(t.db, (tx) =>
        enqueueJob(
          tx,
          {
            kind: 'briefing.morning',
            dedupeKey: `briefing.morning:${d}`,
            payload: {
              localDate: d,
              scheduledFor: london(d, '11:00').toISOString(),
              timezone: 'Europe/London',
            },
            runAt: london(d, '11:00'),
          },
          london(d, '11:00'),
        ),
      )
    }
    // An attempt for 1 June had already created its row before crashing.
    await withService(t.db, (tx) =>
      insertOrGetBriefing(tx, {
        kind: 'morning',
        localDate: '2026-06-01',
        timezone: 'Europe/London',
        scheduledFor: london('2026-06-01', '11:00'),
      }),
    )
    await tick(t, '2026-06-03T11:00:00Z') // 12:00 BST on 3 June
    const morning = await rows(t, 'morning')
    expect(
      morning.map((r) => `${r.localDate}:${r.status}:${r.notify ? 'notify' : 'silent'}`),
    ).toEqual(['2026-06-01:failed:silent', '2026-06-03:published:silent'])
    expect(morning[0]?.content).toMatchObject({ failure: { code: 'superseded' } })
    expect(morning[1]).toMatchObject({ isLate: true })
    const jobs = await withService(t.db, (tx) => listJobs(tx, { kind: 'briefing.morning' }))
    expect(
      jobs.map(
        (j) => `${j.dedupeKey}:${j.status}:${(j.result as { outcome?: string } | null)?.outcome}`,
      ),
    ).toEqual([
      'briefing.morning:2026-06-01:succeeded:superseded',
      'briefing.morning:2026-06-02:succeeded:superseded',
      'briefing.morning:2026-06-03:succeeded:published',
    ])
  })
})

describe('briefing content and setup states', () => {
  it('publishes the honest Milestone 0 skeleton with empty source freshness', async () => {
    const t = await setup('Asia/Kolkata')
    await tick(t, '2026-09-24T05:00:00Z')
    await tick(t, '2026-09-24T05:30:00Z') // 11:00 IST
    const [row] = await rows(t, 'morning')
    expect(row?.content).toEqual(buildBriefingSkeletonContent('morning', '2026-09-24'))
    expect(row?.sourceFreshness).toEqual({
      version: 1,
      sources: [],
      note: expect.stringMatching(/Milestone 2/),
    })
  })

  it('a manual job with an empty payload publishes the latest due briefing in the owner timezone', async () => {
    const t = await setup('Pacific/Chatham')
    const now = new Date('2026-09-26T23:00:00Z') // 12:45 on 27 Sep (+13:45)
    await withService(t.db, (tx) => enqueueJob(tx, { kind: 'briefing.morning', payload: {} }, now))
    await runDispatcher({
      db: t.db,
      workerId: 'manual',
      handlers: registry,
      budgetMs: 30_000,
      maxJobs: 5,
      now: () => now,
      schedules: [],
    })
    const [row] = await rows(t, 'morning')
    expect(row).toMatchObject({
      localDate: '2026-09-27',
      timezone: 'Pacific/Chatham',
      scheduledFor: new Date('2026-09-26T21:15:00Z'),
    })
    expect(row).toMatchObject({ isLate: true, notify: false })
    expectNoTimingClaim(row)
  })

  it('does nothing before an owner exists and rejects malformed payloads', async () => {
    const t = await createTestDatabase()
    dbs.push(t)
    const s = await tick(t, '2026-09-24T10:00:00Z')
    expect(s.schedules?.skipped.map((x) => x.reason)).toEqual(['no_owner', 'no_owner'])
    await withService(t.db, (tx) =>
      enqueueJob(
        tx,
        { kind: 'briefing.evening', payload: { localDate: 'yesterday' } },
        new Date('2026-09-24T10:00:00Z'),
      ),
    )
    const s2 = await tick(t, '2026-09-24T10:00:00Z')
    expect(s2.totals).toMatchObject({ claimed: 1, dead: 1 })
    expect(await rows(t)).toEqual([])
  })

  it('new schedules do not publish occurrences from before they were enabled', async () => {
    const t = await setup('Europe/London')
    // First ever run at 15:00 BST: today's 11:00 was before the system existed.
    await tick(t, '2026-09-24T14:00:00Z')
    expect(await rows(t)).toEqual([])
    await tick(t, '2026-09-24T21:00:00Z')
    expect((await rows(t)).map((r) => `${r.kind}:${r.localDate}`)).toEqual(['evening:2026-09-24'])
    expect(addLocalDays('2026-09-24', 1)).toBe('2026-09-25')
  })

  it('does not publish briefings dated before the owner claimed the dashboard', async () => {
    const t = await createTestDatabase()
    dbs.push(t)
    // Deployed on 1 June: the schedules are enabled, but nobody has signed in yet.
    const deployed = await tick(t, '2026-06-01T08:00:00Z')
    expect(deployed.schedules?.skipped.map((x) => x.reason)).toEqual(['no_owner', 'no_owner'])
    // The owner signs in at 08:30 BST on 5 June and confirms Europe/London.
    await claimOwner(t, '2026-06-05T07:30:00Z')
    await t.db`update public.owner_settings set timezone_confirmed = true`
    await tick(t, '2026-06-05T08:00:00Z') // 09:00 BST
    expect(await rows(t)).toEqual([]) // nothing for 4 June, a day without an owner
    await tick(t, '2026-06-05T10:00:00Z') // 11:00 BST
    expect(
      (await rows(t)).map(
        (r) => `${r.kind}:${r.localDate}:${r.isLate ? 'late' : 'on-time'}:${r.notify}`,
      ),
    ).toEqual(['morning:2026-06-05:on-time:true'])
  })

  it('waits for the owner to confirm the timezone before scheduling briefings', async () => {
    const t = await createTestDatabase()
    dbs.push(t)
    await claimOwner(t)
    // Fresh settings: the Europe/London placeholder, not confirmed.
    const first = await tick(t, '2026-06-10T08:00:00Z')
    expect(first.schedules?.skipped).toEqual([
      { name: 'briefing.evening', reason: 'timezone_unconfirmed' },
      { name: 'briefing.morning', reason: 'timezone_unconfirmed' },
    ])
    await tick(t, '2026-06-10T10:00:00Z') // 11:00 in the placeholder zone
    expect(await rows(t)).toEqual([])

    // At 07:00 EDT the owner confirms New York.
    await t.db`update public.owner_settings set timezone = 'America/New_York', timezone_confirmed = true`
    await tickEvery(t, '2026-06-10T11:00:00Z', '2026-06-11T03:00:00Z', 30)
    expect(
      (await rows(t)).map(
        (r) =>
          `${r.kind}:${r.localDate}:${r.timezone}:${r.scheduledFor.toISOString()}:${r.isLate ? 'late' : 'on-time'}:${r.notify}`,
      ),
    ).toEqual([
      'evening:2026-06-10:America/New_York:2026-06-11T02:00:00.000Z:on-time:true',
      'morning:2026-06-10:America/New_York:2026-06-10T15:00:00.000Z:on-time:true',
    ])
  })
})
