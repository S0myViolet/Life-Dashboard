/**
 * Planner persistence against a real Postgres (RLS on, role `authenticated`).
 * All data is synthetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { localTimeInZone, zonedLocalToUtc } from '@personal-home/core'
import {
  plannerAcceptAll,
  plannerApplyBlockAction,
  plannerEditBlock,
  plannerEnsurePlan,
  plannerEnsureTodayPlan,
  plannerGetPlan,
  plannerMoveBlock,
  plannerPreviewRevision,
  plannerReplan,
  plannerTaskSource,
  plannerWeekSummary,
  withOwner,
  withService,
  type OwnerClaims,
  type PlanBlockRow,
  type PlannerCandidateSource,
  type Tx,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

const TZ = 'Europe/London'
const DATE = '2026-09-24'
const at = (time: string, date = DATE) => zonedLocalToUtc(date, time, TZ)
const wall = (d: Date | null) => (d ? localTimeInZone(d, TZ) : null)
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }))

let t: TestDatabase
let owner: OwnerClaims

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
})
afterAll(async () => {
  await t?.drop()
})

const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)

async function reset(availableHours: unknown = ALL_WEEK) {
  await withService(t.db, async (tx) => {
    await tx`delete from public.daily_plans`
    await tx`delete from public.tasks`
    await tx`delete from public.habits`
    await tx`delete from public.learning_goals`
    await tx`delete from public.books`
    await tx`
      update public.owner_settings
      set timezone = ${TZ}, available_hours = ${availableHours === null ? null : tx.json(availableHours as never)}
    `
  })
}

// Distinct creation times keep the planner's "older first" tie-break deterministic in tests.
let created = Date.parse('2026-09-01T08:00:00Z')

async function addTask(
  tx: Tx,
  fields: {
    title: string
    priority?: number | null
    dueDate?: string | null
    dueAt?: Date | null
    durationMinutes?: number | null
    splittable?: boolean
    confirmed?: boolean
    source?: string
    createdAt?: Date
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.tasks (title, priority, due_date, due_at, duration_minutes, splittable,
                              confirmed, source, created_at)
    values (${fields.title}, ${fields.priority ?? null}, ${fields.dueDate ?? null}::date,
            ${fields.dueAt ?? null}::timestamptz, ${fields.durationMinutes ?? null},
            ${fields.splittable ?? false}, ${fields.confirmed ?? true}, ${fields.source ?? 'manual'},
            ${fields.createdAt ?? new Date((created += 60_000))}::timestamptz)
    returning id
  `
  return row!.id
}

const byTitle = (blocks: PlanBlockRow[], title: string) => {
  const b = blocks.find((x) => x.titleSnapshot === title)
  if (!b) throw new Error(`no block titled ${title}`)
  return b
}

describe('planner tables: owner-only', () => {
  it('a non-owner user and anon can neither read nor write plans', async () => {
    await reset()
    await asOwner(async (tx) => {
      await addTask(tx, { title: 'Secret', priority: 1 })
      await plannerEnsureTodayPlan(tx, { now: at('08:00') })
    })
    const stranger = await createAuthUser(t.db, 'stranger@example.com')
    const seen = await withOwner(t.db, stranger, async (tx) => ({
      plans: await tx`select * from public.daily_plans`,
      blocks: await tx`select * from public.plan_blocks`,
    }))
    expect(seen.plans).toHaveLength(0)
    expect(seen.blocks).toHaveLength(0)
    await expect(
      withOwner(
        t.db,
        stranger,
        (tx) => tx`insert into public.daily_plans (local_date, timezone, source, mode, draft)
                   values ('2026-12-01', 'UTC', 'manual', 'list', '{}')`,
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(withAnon(t.db, (tx) => tx`select * from public.plan_blocks`)).rejects.toThrow(
      /permission denied/,
    )
    await expect(withAnon(t.db, (tx) => tx`select * from public.daily_plans`)).rejects.toThrow(
      /permission denied/,
    )
  })

  it('rejects an invalid timezone and overlapping active blocks', async () => {
    await reset()
    await expect(
      asOwner(
        (tx) => tx`insert into public.daily_plans (local_date, timezone, source, mode, draft)
                   values ('2026-12-01', 'Mars/Base', 'manual', 'list', '{}')`,
      ),
    ).rejects.toThrow(/invalid IANA timezone/)

    const insertTwo = (secondState: string) =>
      asOwner(async (tx) => {
        const [p] = await tx<{ id: string }[]>`
          insert into public.daily_plans (local_date, timezone, source, mode, draft)
          values ('2026-12-02', 'UTC', 'manual', 'time', '{}') returning id`
        const common = { planId: p!.id, candidateKind: 'task', minutes: 60 }
        await tx`insert into public.plan_blocks ${tx({
          ...common,
          candidateId: crypto.randomUUID(),
          titleSnapshot: 'A',
          startAt: new Date('2026-12-02T09:00:00Z'),
          endAt: new Date('2026-12-02T10:00:00Z'),
        })}`
        await tx`insert into public.plan_blocks ${tx({
          ...common,
          candidateId: crypto.randomUUID(),
          titleSnapshot: 'B',
          startAt: new Date('2026-12-02T09:30:00Z'),
          endAt: new Date('2026-12-02T10:30:00Z'),
          state: secondState,
        })}`
      })
    await expect(insertTwo('suggested')).rejects.toThrow(/plan_blocks_no_overlap/)
    // A dismissed block no longer occupies time.
    await expect(insertTwo('dismissed')).resolves.toBeUndefined()
  })
})

describe('first use each local day', () => {
  beforeEach(() => reset())

  it('drafts today from saved tasks, habits and reading goals', async () => {
    const r = await asOwner(async (tx) => {
      await addTask(tx, { title: 'Overdue report', dueDate: '2026-09-22', durationMinutes: 60 })
      await addTask(tx, { title: 'Call bank', dueAt: at('17:00'), dueDate: DATE })
      await addTask(tx, {
        title: 'Maybe from email',
        dueDate: DATE,
        confirmed: false,
        source: 'email_suggestion',
      })
      await addTask(tx, { title: 'Done already', priority: 1 }).then(
        (id) => tx`update public.tasks set status = 'done', completed_at = now() where id = ${id}`,
      )
      await tx`insert into public.habits (title, weekdays) values ('Stretch', '{4}'), ('Weekend run', '{6,7}')`
      const [book] = await tx<{ id: string }[]>`
        insert into public.books (title, status) values ('Dune', 'reading') returning id`
      await tx`insert into public.learning_goals (title, book_id) values ('Read Dune', ${book!.id})`
      return plannerEnsureTodayPlan(tx, { now: at('08:00') })
    })
    expect(r.created).toBe(true)
    expect(r.today).toBe(DATE)
    const { plan, blocks } = r.plan
    expect(plan).toMatchObject({
      localDate: DATE,
      timezone: TZ,
      source: 'auto_first_use',
      mode: 'time',
      status: 'draft',
    })
    expect(plan.draft.priorities.map((p) => [p.title, p.reason])).toEqual([
      ['Overdue report', 'Overdue since Tue 22 Sep'],
      ['Call bank', 'Due today 17:00'],
    ])
    expect(
      blocks.map((b) => [
        b.titleSnapshot,
        b.candidateKind,
        wall(b.startAt),
        b.minutes,
        b.tentative,
      ]),
    ).toEqual([
      ['Overdue report', 'task', '09:00', 60, false],
      ['Call bank', 'task', '10:00', 30, false],
      ['Stretch', 'habit', '10:30', 30, false],
      ['Read Dune', 'reading_goal', '11:00', 30, false],
      ['Maybe from email', 'email_deadline', '11:30', 30, true],
    ])
    expect(
      blocks.every((b) => b.state === 'suggested' && b.startAt!.getTime() >= at('08:00').getTime()),
    ).toBe(true)
    expect(plan.draft.notes.map((n) => n.code)).toEqual(['calendars_not_connected'])
  })

  it('is idempotent and creates exactly one plan under concurrent first loads', async () => {
    await asOwner((tx) => addTask(tx, { title: 'Only task', priority: 1 }))
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        asOwner((tx) => plannerEnsureTodayPlan(tx, { now: at('08:00') })),
      ),
    )
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.plan.plan.id)).size).toBe(1)
    const counts = await withService(t.db, async (tx) => ({
      plans: (await tx`select count(*)::int as n from public.daily_plans`)[0]!.n,
      blocks: (await tx`select count(*)::int as n from public.plan_blocks`)[0]!.n,
    }))
    expect(counts).toEqual({ plans: 1, blocks: 1 })
    // Loading again later does not redraft.
    const again = await asOwner((tx) => plannerEnsureTodayPlan(tx, { now: at('15:00') }))
    expect(again.created).toBe(false)
    expect(wall(again.plan.blocks[0]!.startAt)).toBe('09:00')
  })

  it('uses list mode without available hours and never invents times', async () => {
    await reset(null)
    const plan = await asOwner(async (tx) => {
      await addTask(tx, { title: 'First', dueDate: DATE })
      await addTask(tx, { title: 'Second', durationMinutes: 45 })
      return (await plannerEnsureTodayPlan(tx, { now: at('08:00') })).plan
    })
    expect(plan.plan.mode).toBe('list')
    expect(
      plan.blocks.map((b) => [b.titleSnapshot, b.startAt, b.minutes, b.estimated, b.position]),
    ).toEqual([
      ['First', null, 30, true, 0],
      ['Second', null, 45, false, 1],
    ])
    expect(plan.plan.draft.capacity.known).toBe(false)
    expect(plan.plan.draft.notes[0]?.code).toBe('list_mode_not_set')
  })

  it('uses the local date in the owner timezone', async () => {
    await withService(
      t.db,
      (tx) => tx`update public.owner_settings set timezone = 'Pacific/Auckland'`,
    )
    // 2026-09-24T20:00Z is already 25 Sep in Auckland.
    const r = await asOwner((tx) =>
      plannerEnsureTodayPlan(tx, { now: new Date('2026-09-24T20:00:00Z') }),
    )
    expect(r.today).toBe('2026-09-25')
    expect(r.plan.plan.timezone).toBe('Pacific/Auckland')
  })

  it('reports a failing source instead of pretending there is nothing to do', async () => {
    const broken: PlannerCandidateSource = {
      name: 'calendar deadlines',
      load: async (tx) => {
        await tx`select * from public.no_such_table`
        return []
      },
    }
    const { plan } = await asOwner(async (tx) => {
      await addTask(tx, { title: 'Still here', priority: 1 })
      return plannerEnsurePlan(tx, {
        now: at('08:00'),
        localDate: DATE,
        source: 'manual',
        sources: [broken, plannerTaskSource],
      })
    })
    expect(plan.blocks.map((b) => b.titleSnapshot)).toEqual(['Still here'])
    expect(plan.plan.draft.notes.find((n) => n.code === 'sources_partial')?.message).toBe(
      'Some items could not be read (calendar deadlines), so this plan may be incomplete.',
    )
  })
})

describe('owner changes survive replans', () => {
  beforeEach(() => reset())

  it('accept, edit, pin and dismiss persist; replan only changes unaccepted suggestions', async () => {
    const ids = await asOwner(async (tx) => ({
      a: await addTask(tx, { title: 'A', priority: 1, durationMinutes: 60 }),
      b: await addTask(tx, { title: 'B', priority: 1, durationMinutes: 60 }),
      c: await addTask(tx, { title: 'C', durationMinutes: 60 }),
      d: await addTask(tx, { title: 'D', durationMinutes: 30 }),
      e: await addTask(tx, { title: 'E', durationMinutes: 30 }),
    }))
    const first = await asOwner((tx) => plannerEnsureTodayPlan(tx, { now: at('08:00') }))
    const blocks = first.plan.blocks
    expect(blocks.map((b) => [b.titleSnapshot, wall(b.startAt)])).toEqual([
      ['A', '09:00'],
      ['B', '10:00'],
      ['C', '11:00'],
      ['D', '12:00'],
      ['E', '12:30'],
    ])
    const now = at('08:05')
    await asOwner(async (tx) => {
      expect(
        await plannerApplyBlockAction(tx, {
          now,
          blockId: byTitle(blocks, 'A').id,
          action: 'accept',
        }),
      ).toEqual({ ok: true })
      expect(
        await plannerEditBlock(tx, {
          now,
          blockId: byTitle(blocks, 'C').id,
          startTime: '15:00',
          minutes: 45,
        }),
      ).toEqual({ ok: true })
      expect(
        await plannerApplyBlockAction(tx, { now, blockId: byTitle(blocks, 'D').id, action: 'pin' }),
      ).toEqual({ ok: true })
      expect(
        await plannerApplyBlockAction(tx, {
          now,
          blockId: byTitle(blocks, 'E').id,
          action: 'dismiss',
        }),
      ).toEqual({ ok: true })
    })
    const saved = (await asOwner((tx) => plannerGetPlan(tx, DATE)))!
    expect(saved.plan.status).toBe('active')
    expect(
      saved.blocks.map((b) => [
        b.titleSnapshot,
        b.state,
        wall(b.startAt),
        b.minutes,
        b.editedByOwner,
        b.estimated,
      ]),
    ).toEqual([
      ['A', 'accepted', '09:00', 60, false, false],
      ['B', 'suggested', '10:00', 60, false, false],
      ['D', 'pinned', '12:00', 30, false, false],
      ['E', 'dismissed', '12:30', 30, false, false],
      ['C', 'suggested', '15:00', 45, true, false],
    ])

    // New data arrives, time passes, the owner replans the rest of the day.
    await asOwner((tx) => addTask(tx, { title: 'Urgent', dueDate: DATE, durationMinutes: 30 }))
    const preview = await asOwner((tx) =>
      plannerPreviewRevision(tx, { now: at('10:32'), localDate: DATE }),
    )
    expect(preview!.additions.map((x) => x.title)).toEqual(['Urgent'])
    const { plan, revision } = await asOwner((tx) =>
      plannerReplan(tx, { now: at('10:32'), localDate: DATE }),
    )
    expect(revision!.kept.map((b) => b.title).sort()).toEqual(['A', 'C', 'D', 'E'])
    const after = new Map(plan.blocks.map((b) => [b.titleSnapshot, b]))
    for (const title of ['A', 'C', 'D', 'E']) {
      const before = saved.blocks.find((b) => b.titleSnapshot === title)!
      const now2 = after.get(title)!
      expect([now2.id, now2.state, now2.startAt, now2.minutes, now2.editedByOwner]).toEqual([
        before.id,
        before.state,
        before.startAt,
        before.minutes,
        before.editedByOwner,
      ])
    }
    // Dismissed E is not suggested again; B keeps its id but moves after now; Urgent is new.
    expect(plan.blocks.filter((b) => b.titleSnapshot === 'E')).toHaveLength(1)
    expect(after.get('B')!.id).toBe(byTitle(blocks, 'B').id)
    for (const b of plan.blocks.filter((x) => x.state === 'suggested' && !x.editedByOwner)) {
      expect(b.startAt!.getTime()).toBeGreaterThanOrEqual(at('10:35').getTime())
    }
    // B (60 min) no longer fits before the pinned D at 12:00, so it goes after it; the dismissed
    // E no longer occupies 12:30.
    const active = plan.blocks.filter((b) => b.state !== 'dismissed')
    expect(active.map((b) => [b.titleSnapshot, b.state, wall(b.startAt)])).toEqual([
      ['A', 'accepted', '09:00'],
      ['Urgent', 'suggested', '10:35'],
      ['D', 'pinned', '12:00'],
      ['B', 'suggested', '12:30'],
      ['C', 'suggested', '15:00'],
    ])
    expect(plan.plan.source).toBe('replan')
    void ids
  })

  it('refuses edits that overlap, accepts moves, and keeps split parts labelled', async () => {
    await asOwner(async (tx) => {
      await addTask(tx, { title: 'Long', priority: 1, durationMinutes: 120 })
      await addTask(tx, { title: 'Short', priority: 1, durationMinutes: 30 })
    })
    const { plan } = await asOwner((tx) => plannerEnsureTodayPlan(tx, { now: at('08:00') }))
    const long = byTitle(plan.blocks, 'Long')
    const short = byTitle(plan.blocks, 'Short')
    expect([wall(long.startAt), wall(short.startAt)]).toEqual(['09:00', '11:00'])
    const now = at('08:00')
    const overlap = await asOwner((tx) =>
      plannerEditBlock(tx, { now, blockId: short.id, startTime: '10:30', minutes: 30 }),
    )
    expect(overlap).toMatchObject({ ok: false, code: 'overlaps_block' })
    const past = await asOwner((tx) =>
      plannerEditBlock(tx, {
        now: at('12:00'),
        blockId: short.id,
        startTime: '11:30',
        minutes: 30,
      }),
    )
    expect(past).toMatchObject({ ok: false, code: 'in_past' })

    expect(
      await asOwner((tx) => plannerMoveBlock(tx, { now, blockId: short.id, direction: 'up' })),
    ).toEqual({ ok: true })
    const moved = (await asOwner((tx) => plannerGetPlan(tx, DATE)))!
    expect(
      moved.blocks.map((b) => [b.titleSnapshot, wall(b.startAt), wall(b.endAt), b.editedByOwner]),
    ).toEqual([
      ['Short', '09:00', '09:30', true],
      ['Long', '09:30', '11:30', true],
    ])
  })

  it('accept all skips tentative and elapsed suggestions', async () => {
    await asOwner(async (tx) => {
      await addTask(tx, { title: 'Sure', priority: 1 })
      await addTask(tx, { title: 'Unsure', confirmed: false, source: 'chat_suggestion' })
    })
    await asOwner((tx) => plannerEnsureTodayPlan(tx, { now: at('08:00') }))
    const r = await asOwner((tx) => plannerAcceptAll(tx, { now: at('08:10'), localDate: DATE }))
    expect(r).toEqual({ accepted: 1, skippedTentative: 1 })
    const plan = (await asOwner((tx) => plannerGetPlan(tx, DATE)))!
    expect(plan.blocks.map((b) => [b.titleSnapshot, b.state])).toEqual([
      ['Sure', 'accepted'],
      ['Unsure', 'suggested'],
    ])
    // A suggestion whose slot has passed cannot be accepted as-is.
    const late = await asOwner((tx) =>
      plannerApplyBlockAction(tx, {
        now: at('12:00'),
        blockId: byTitle(plan.blocks, 'Unsure').id,
        action: 'accept',
      }),
    )
    expect(late).toMatchObject({ ok: false, code: 'slot_passed' })
  })

  it('done completes the task (and the habit for today) and restore brings back a dismissal', async () => {
    const ids = await asOwner(async (tx) => {
      const task = await addTask(tx, { title: 'Finish', priority: 1 })
      const [h] = await tx<
        { id: string }[]
      >`insert into public.habits (title) values ('Walk') returning id`
      return { task, habit: h!.id }
    })
    const { plan } = await asOwner((tx) => plannerEnsureTodayPlan(tx, { now: at('08:00') }))
    const now = at('09:40')
    const done = await asOwner((tx) =>
      plannerApplyBlockAction(tx, {
        now,
        blockId: byTitle(plan.blocks, 'Finish').id,
        action: 'done',
      }),
    )
    expect(done).toEqual({ ok: true, message: 'Task completed.' })
    const habitDone = await asOwner((tx) =>
      plannerApplyBlockAction(tx, {
        now,
        blockId: byTitle(plan.blocks, 'Walk').id,
        action: 'done',
      }),
    )
    expect(habitDone.ok).toBe(true)
    const state = await asOwner(async (tx) => ({
      task: (
        await tx<{ status: string }[]>`select status from public.tasks where id = ${ids.task}`
      )[0]!.status,
      habit: (
        await tx`select local_date from public.habit_completions where habit_id = ${ids.habit}`
      ).map((r) => r.localDate),
    }))
    expect(state).toEqual({ task: 'done', habit: [DATE] })

    // Replanning afterwards keeps the done blocks and suggests nothing new for them.
    const { plan: after } = await asOwner((tx) =>
      plannerReplan(tx, { now: at('10:00'), localDate: DATE }),
    )
    expect(after.blocks.map((b) => [b.titleSnapshot, b.state])).toEqual([
      ['Finish', 'done'],
      ['Walk', 'done'],
    ])

    await asOwner(async (tx) => {
      const id = await addTask(tx, { title: 'Later', durationMinutes: 30 })
      void id
    })
    const { plan: withLater } = await asOwner((tx) =>
      plannerReplan(tx, { now: at('10:00'), localDate: DATE }),
    )
    const later = byTitle(withLater.blocks, 'Later')
    await asOwner((tx) =>
      plannerApplyBlockAction(tx, { now: at('10:00'), blockId: later.id, action: 'dismiss' }),
    )
    const restored = await asOwner((tx) =>
      plannerApplyBlockAction(tx, { now: at('10:00'), blockId: later.id, action: 'restore' }),
    )
    expect(restored).toEqual({ ok: true })
    const final = (await asOwner((tx) => plannerGetPlan(tx, DATE)))!
    expect(byTitle(final.blocks, 'Later').state).toBe('suggested')
  })

  it('replans a plan that does not exist yet by creating it', async () => {
    await asOwner((tx) => addTask(tx, { title: 'Tomorrow thing', dueDate: '2026-09-25' }))
    const r = await asOwner((tx) =>
      plannerReplan(tx, { now: at('21:00'), localDate: '2026-09-25' }),
    )
    expect(r.created).toBe(true)
    expect(r.plan.plan.source).toBe('manual')
    expect(r.plan.blocks.map((b) => [b.titleSnapshot, wall(b.startAt)])).toEqual([
      ['Tomorrow thing', '09:00'],
    ])
    expect(r.plan.plan.draft.priorities[0]?.reason).toBe('Due tomorrow')
  })

  it('concurrent replans and owner actions serialise without losing an acceptance', async () => {
    await asOwner(async (tx) => {
      for (let i = 0; i < 5; i++)
        await addTask(tx, { title: `T${i}`, durationMinutes: 30, priority: 2 })
    })
    const { plan } = await asOwner((tx) => plannerEnsureTodayPlan(tx, { now: at('08:00') }))
    const target = plan.blocks[2]!
    await Promise.all([
      asOwner((tx) => plannerReplan(tx, { now: at('08:30'), localDate: DATE })),
      asOwner((tx) =>
        plannerApplyBlockAction(tx, { now: at('08:30'), blockId: target.id, action: 'accept' }),
      ),
      asOwner((tx) => plannerReplan(tx, { now: at('08:40'), localDate: DATE })),
    ])
    const final = (await asOwner((tx) => plannerGetPlan(tx, DATE)))!
    const accepted = final.blocks.filter((b) => b.state === 'accepted')
    expect(accepted.map((b) => b.id)).toEqual([target.id])
    expect(final.blocks.filter((b) => b.candidateId === target.candidateId)).toHaveLength(1)
  })
})

describe('week summary', () => {
  it('counts tasks due and accepted blocks per day, and does not fabricate busy counts', async () => {
    await reset()
    await asOwner(async (tx) => {
      await addTask(tx, { title: 'Mon', dueDate: '2026-09-21' })
      await addTask(tx, { title: 'Thu 1', dueDate: DATE, priority: 1 })
      await addTask(tx, { title: 'Thu 2', dueDate: DATE })
      const { plan } = await plannerEnsureTodayPlan(tx, { now: at('08:00') })
      await plannerApplyBlockAction(tx, {
        now: at('08:00'),
        blockId: plan.blocks[0]!.id,
        action: 'accept',
      })
    })
    const week = await asOwner((tx) => plannerWeekSummary(tx, { from: '2026-09-21' }))
    expect(week).toHaveLength(7)
    expect(week[0]).toEqual({
      localDate: '2026-09-21',
      tasksDue: 1,
      acceptedBlocks: 0,
      hasPlan: false,
      busyEvents: null,
    })
    expect(week[1]).toEqual({
      localDate: '2026-09-22',
      tasksDue: 0,
      acceptedBlocks: 0,
      hasPlan: false,
      busyEvents: null,
    })
    expect(week[3]).toEqual({
      localDate: DATE,
      tasksDue: 2,
      acceptedBlocks: 1,
      hasPlan: true,
      busyEvents: null,
    })
  })
})
