/**
 * Home loaders (components/home/data.ts) against a real database. The session layer is
 * replaced with an owner transaction on a test database (RLS still applies), as in the other
 * web tests. Covers a fresh owner (honest empty states), labelled demo data, a published
 * briefing, and one failing source not blanking the others. All data is synthetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBriefingSkeletonContent,
  buildBriefingSourceFreshness,
  localDateInZone,
  zonedLocalToUtc,
} from '@personal-home/core'
import {
  insertOrGetBriefing,
  publishBriefing,
  removeDemoData,
  seedDemoData,
  withOwner,
  withService,
  type OwnerClaims,
  type Tx,
} from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

const ctx = vi.hoisted(() => ({
  t: null as null | { db: unknown },
  owner: null as null | { sub: string; email?: string | null },
}))

vi.mock('@/lib/server/session', () => ({
  requireOwner: async () => ({ claims: ctx.owner, userId: ctx.owner!.sub, email: null }),
  withOwnerTx: async (fn: (tx: Tx, session: unknown) => Promise<unknown>) =>
    withOwner(ctx.t!.db as never, ctx.owner as OwnerClaims, (tx) =>
      fn(tx, { claims: ctx.owner, userId: ctx.owner!.sub, email: null }),
    ),
}))
vi.mock('next/navigation', () => ({ unstable_rethrow: () => {} }))

const { loadDemoPresence, loadHomeAttention, loadHomeBriefing, loadHomeToday } =
  await import('@/components/home/data')

const TZ = 'Europe/London'
let t: TestDatabase
let owner: OwnerClaims

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  ctx.t = t
  ctx.owner = owner
  await t.db`update public.owner_settings set timezone = ${TZ}, timezone_confirmed = true`
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(async () => {
  await withService(t.db, (tx) => removeDemoData(tx))
  await t.db`delete from public.briefings`
})

describe('a fresh owner', () => {
  it('gets honest empty states from every loader', async () => {
    const now = new Date()
    const attention = await loadHomeAttention(now, TZ)
    expect(attention).toEqual({
      items: [],
      more: { tasks: 0, people: 0 },
      sources: { tasks: true, people: true },
    })
    const today = await loadHomeToday(now, TZ)
    expect(today.tasks).toEqual({ ok: true, data: { open: [], doneToday: [], more: 0 } })
    expect(today.habits).toEqual({ ok: true, data: { due: [], notDueCount: 0 } })
    const briefing = await loadHomeBriefing(now, TZ, true)
    expect(briefing.ok && briefing.data.latest).toBeNull()
    expect(briefing.ok && briefing.data.nextLabel).toMatch(/^Next (briefing|project review): /)
    expect(await loadDemoPresence()).toBe(false)
  })
})

describe('with demo data', () => {
  it('shows the labelled demo rows across the modules', async () => {
    const now = zonedLocalToUtc(localDateInZone(new Date(), TZ), '09:00', TZ)
    await withOwner(t.db, owner, (tx) => seedDemoData(tx, { now }))
    expect(await loadDemoPresence()).toBe(true)

    const attention = await loadHomeAttention(now, TZ)
    expect(attention.items.map((i) => i.kind)).toEqual([
      'task_overdue',
      'reminder_due',
      'task_due_soon',
      'person_date',
      'person_date',
      'catch_up',
    ])
    expect(attention.more).toEqual({ tasks: 0, people: 1 })
    expect(attention.items.every((i) => i.title.includes('[demo]'))).toBe(true)

    const today = await loadHomeToday(now, TZ)
    expect(today.tasks.ok && today.tasks.data.open.map((x) => x.title)).toEqual([
      // The tasks area's order: timed tasks first within a day, then by priority.
      '[demo] Call the dentist to move the check-up',
      '[demo] Draft the project kickoff notes',
      '[demo] Pay the window cleaner',
    ])
    expect(today.habits.ok && today.habits.data.due.map((h) => [h.title, h.done])).toEqual(
      expect.arrayContaining([
        ['[demo] Morning stretch', false],
        ['[demo] Read 20 minutes', false],
      ]),
    )
  })

  it('isolates a failing source: people fail, tasks still show', async () => {
    const now = new Date()
    await withOwner(t.db, owner, (tx) => seedDemoData(tx, { now }))
    await t.db`revoke select on public.person_dates from authenticated`
    try {
      const attention = await loadHomeAttention(now, TZ)
      expect(attention.sources).toEqual({ tasks: true, people: false })
      expect(attention.items.some((i) => i.kind === 'task_overdue')).toBe(true)
      expect(attention.items.some((i) => i.kind === 'person_date' || i.kind === 'catch_up')).toBe(
        false,
      )
    } finally {
      await t.db`grant select on public.person_dates to authenticated`
    }
  })
})

describe('latest briefing', () => {
  it('reads the published briefing written by the job framework', async () => {
    const today = localDateInZone(new Date(), TZ)
    const scheduledFor = zonedLocalToUtc(today, '11:00', TZ)
    await withService(t.db, async (tx) => {
      const { briefing } = await insertOrGetBriefing(tx, {
        kind: 'morning',
        localDate: today,
        timezone: TZ,
        scheduledFor,
      })
      await publishBriefing(tx, {
        id: briefing.id,
        publishedAt: new Date(scheduledFor.getTime() + 2 * 3_600_000),
        isLate: true,
        notify: false,
        content: buildBriefingSkeletonContent('morning', today),
        sourceFreshness: buildBriefingSourceFreshness(),
      })
    })
    const r = await loadHomeBriefing(new Date(scheduledFor.getTime() + 3 * 3_600_000), TZ, true)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.latest).toMatchObject({
      title: 'Morning briefing',
      dateLabel: 'Today',
      late: true,
      publishedLabel: 'Published 13:00',
      scheduledLabel: 'Scheduled for 11:00',
      sourceCount: 0,
    })
  })
})
