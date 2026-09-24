import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildBriefingSkeletonContent, buildBriefingSourceFreshness } from '@personal-home/core'
import {
  getBriefing,
  getLatestPublishedBriefing,
  insertOrGetBriefing,
  listRecentBriefings,
  markBriefingFailed,
  publishBriefing,
  withOwner,
  withService,
  type OwnerClaims,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

const scheduledFor = new Date('2026-09-24T10:00:00Z')

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})

describe('public.briefings access', () => {
  it('owner can read, nobody but the service connection can write', async () => {
    await withService(t.db, (tx) =>
      insertOrGetBriefing(tx, {
        kind: 'morning',
        localDate: '2026-09-01',
        timezone: 'Europe/London',
        scheduledFor,
      }),
    )
    const mine = await withOwner(t.db, owner, (tx) => listRecentBriefings(tx))
    expect(mine.map((b) => b.localDate)).toContain('2026-09-01')
    expect(await withOwner(t.db, stranger, (tx) => listRecentBriefings(tx))).toEqual([])
    await expect(withAnon(t.db, (tx) => tx`select * from public.briefings`)).rejects.toThrow(
      /permission denied/,
    )

    await expect(
      withOwner(
        t.db,
        owner,
        (tx) => tx`insert into public.briefings (kind, local_date, timezone, scheduled_for)
                   values ('evening', '2026-09-01', 'Europe/London', now())`,
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withOwner(t.db, owner, (tx) => tx`update public.briefings set notify = true`),
    ).rejects.toThrow(/permission denied/)
    await expect(withOwner(t.db, owner, (tx) => tx`delete from public.briefings`)).rejects.toThrow(
      /permission denied/,
    )
  })

  it('has only a select policy for the owner', async () => {
    const policies = await t.db<{ name: string; cmd: string }[]>`
      select polname as name, polcmd::text as cmd from pg_policy where polrelid = 'public.briefings'::regclass
    `
    expect(policies).toEqual([{ name: 'owner_read', cmd: 'r' }])
  })
})

describe('briefing rows', () => {
  it('insert-or-get is idempotent, also under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        withService(t.db, (tx) =>
          insertOrGetBriefing(tx, {
            kind: 'morning',
            localDate: '2026-09-24',
            timezone: 'Europe/London',
            scheduledFor,
          }),
        ),
      ),
    )
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.briefing.id)).size).toBe(1)
    expect(results[0]!.briefing).toMatchObject({
      kind: 'morning',
      localDate: '2026-09-24',
      timezone: 'Europe/London',
      scheduledFor,
      status: 'preparing',
      publishedAt: null,
      isLate: false,
      notify: false,
    })
    // A later insert with another timezone keeps the original row.
    const again = await withService(t.db, (tx) =>
      insertOrGetBriefing(tx, {
        kind: 'morning',
        localDate: '2026-09-24',
        timezone: 'Asia/Kolkata',
        scheduledFor: new Date(),
      }),
    )
    expect(again.created).toBe(false)
    expect(again.briefing.timezone).toBe('Europe/London')
  })

  it('publishes once; a second publish is a no-op', async () => {
    const { briefing } = await withService(t.db, (tx) =>
      insertOrGetBriefing(tx, {
        kind: 'evening',
        localDate: '2026-09-24',
        timezone: 'Europe/London',
        scheduledFor,
      }),
    )
    const content = buildBriefingSkeletonContent('evening', '2026-09-24')
    const sourceFreshness = buildBriefingSourceFreshness()
    const publishedAt = new Date('2026-09-24T21:00:10Z')
    const [a, b] = await Promise.all([
      withService(t.db, (tx) =>
        publishBriefing(tx, {
          id: briefing.id,
          publishedAt,
          isLate: false,
          notify: true,
          content,
          sourceFreshness,
        }),
      ),
      withService(t.db, (tx) =>
        publishBriefing(tx, {
          id: briefing.id,
          publishedAt,
          isLate: false,
          notify: true,
          content,
          sourceFreshness,
        }),
      ),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    const row = await withService(t.db, (tx) =>
      getBriefing(tx, { kind: 'evening', localDate: '2026-09-24' }),
    )
    expect(row).toMatchObject({ status: 'published', publishedAt, notify: true, isLate: false })
    expect(row?.content).toEqual(content)
    expect(row?.sourceFreshness).toEqual(sourceFreshness)
    expect(
      await withOwner(t.db, owner, (tx) => getLatestPublishedBriefing(tx, 'evening')),
    ).toMatchObject({ id: briefing.id })
  })

  it('never notifies for a late briefing, even if asked to', async () => {
    const { briefing } = await withService(t.db, (tx) =>
      insertOrGetBriefing(tx, {
        kind: 'morning',
        localDate: '2026-09-02',
        timezone: 'Europe/London',
        scheduledFor,
      }),
    )
    const row = await withService(t.db, (tx) =>
      publishBriefing(tx, {
        id: briefing.id,
        publishedAt: new Date(scheduledFor.getTime() + 3 * 3_600_000),
        isLate: true,
        notify: true,
        content: buildBriefingSkeletonContent('morning', '2026-09-02'),
        sourceFreshness: buildBriefingSourceFreshness(),
      }),
    )
    expect(row).toMatchObject({ isLate: true, notify: false })
    // The table enforces it as well.
    await expect(
      t.db`update public.briefings set notify = true where id = ${briefing.id}::uuid`,
    ).rejects.toThrow(/briefings_notify_only_on_time/)
  })

  it('marks only preparing briefings as failed', async () => {
    await withService(t.db, (tx) =>
      insertOrGetBriefing(tx, {
        kind: 'evening',
        localDate: '2026-09-03',
        timezone: 'Europe/London',
        scheduledFor,
      }),
    )
    expect(
      await withService(t.db, (tx) =>
        markBriefingFailed(
          tx,
          { kind: 'evening', localDate: '2026-09-03' },
          { code: 'x', message: 'y' },
        ),
      ),
    ).toBe(true)
    expect(
      (
        await withService(t.db, (tx) =>
          getBriefing(tx, { kind: 'evening', localDate: '2026-09-03' }),
        )
      )?.status,
    ).toBe('failed')
    // The published evening briefing for 2026-09-24 is untouched.
    expect(
      await withService(t.db, (tx) =>
        markBriefingFailed(
          tx,
          { kind: 'evening', localDate: '2026-09-24' },
          { code: 'x', message: 'y' },
        ),
      ),
    ).toBe(false)
  })

  it('enforces one row per (kind, local_date) and consistent publication fields in SQL', async () => {
    await expect(
      t.db`insert into public.briefings (kind, local_date, timezone, scheduled_for) values ('morning', '2026-09-24', 'UTC', now())`,
    ).rejects.toThrow(/briefings_kind_local_date_key/)
    await expect(
      t.db`insert into public.briefings (kind, local_date, timezone, scheduled_for, status) values ('morning', '2030-01-01', 'UTC', now(), 'published')`,
    ).rejects.toThrow(/briefings_published_at_matches_status/)
    await expect(
      t.db`insert into public.briefings (kind, local_date, timezone, scheduled_for) values ('lunch', '2030-01-01', 'UTC', now())`,
    ).rejects.toThrow(/briefings_kind_check/)
  })
})
