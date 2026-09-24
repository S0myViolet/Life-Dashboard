/**
 * Plan view models and form validation (pure). Synthetic data only.
 */
import { describe, expect, it } from 'vitest'
import { zonedLocalToUtc, type PlanDraft } from '@personal-home/core'
import type { PlanBlockRow, PlannerPlan } from '@personal-home/db'
import { PlanBlockFormSchema, PlanDayFormSchema, parsePlanForm } from '@/lib/planner/inputs'
import {
  buildPlanBlockViews,
  buildPlanDayView,
  buildPlanWeekView,
  planLongDateLabel,
  planWeekStart,
} from '@/lib/planner/view'

const TZ = 'Europe/London'
const DATE = '2026-09-24'
const at = (t: string) => zonedLocalToUtc(DATE, t, TZ)

let n = 0
function row(over: Partial<PlanBlockRow>): PlanBlockRow {
  n++
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    planId: 'plan',
    candidateKind: 'task',
    candidateId: `cand-${n}`,
    titleSnapshot: `Block ${n}`,
    bucket: 'scheduled',
    startAt: null,
    endAt: null,
    minutes: 30,
    position: n,
    state: 'suggested',
    estimated: false,
    tentative: false,
    splitPart: null,
    splitTotal: null,
    priorityRank: null,
    note: null,
    editedByOwner: false,
    acceptedAt: null,
    doneAt: null,
    createdAt: at('07:00'),
    updatedAt: at('07:00'),
    ...over,
  }
}

function draft(over: Partial<PlanDraft> = {}): PlanDraft {
  return {
    version: 1,
    localDate: DATE,
    timezone: TZ,
    generatedAt: at('08:00').toISOString(),
    mode: 'time',
    priorities: [],
    scheduled: [],
    smallTasks: [],
    list: [],
    canWait: [],
    doesNotFit: [],
    alreadyPlanned: [],
    conflicts: [],
    capacity: {
      known: true,
      freeMinutes: 480,
      bufferMinutes: 96,
      budgetMinutes: 384,
      allocatedMinutes: 90,
      overflowMinutes: 0,
      demandMinutes: 90,
    },
    notes: [{ code: 'calendars_not_connected', message: 'Calendars are not connected…' }],
    ...over,
  }
}

function plan(blocks: PlanBlockRow[], d: PlanDraft = draft()): PlannerPlan {
  return {
    plan: {
      id: 'plan',
      localDate: DATE,
      timezone: TZ,
      generatedAt: at('08:00'),
      source: 'auto_first_use',
      mode: d.mode,
      draft: d,
      status: 'draft',
      revision: 1,
      createdAt: at('08:00'),
      updatedAt: at('08:00'),
    },
    blocks,
  }
}

describe('block views', () => {
  it('labels times, estimates, split parts and allowed actions', () => {
    const blocks = [
      row({
        id: 'a',
        startAt: at('09:00'),
        endAt: at('09:30'),
        estimated: true,
        candidateId: 's',
        splitPart: 1,
        splitTotal: 2,
      }),
      row({
        id: 'b',
        startAt: at('10:00'),
        endAt: at('10:30'),
        state: 'accepted',
        candidateId: 's',
        splitPart: 2,
        splitTotal: 2,
      }),
      row({ id: 'c', startAt: at('11:00'), endAt: at('11:30'), state: 'pinned' }),
      row({ id: 'd', startAt: at('12:00'), endAt: at('12:30'), state: 'done' }),
    ]
    const views = buildPlanBlockViews(blocks, { now: at('09:40'), timezone: TZ, readOnly: false })
    const [a, b, c, d] = views
    expect(a).toMatchObject({
      timeLabel: '09:00–09:30',
      startTime: '09:00',
      durationLabel: 'Estimate · 30 min',
      splitLabel: '1 of 2',
      isPast: true,
      can: { accept: false, pin: false, edit: true, moveUp: false, moveDown: true, dismiss: true },
    })
    expect(b).toMatchObject({
      splitLabel: '2 of 2',
      preserved: true,
      can: { accept: false, pin: true, moveUp: true },
    })
    expect(c).toMatchObject({ can: { unpin: true, pin: false, moveDown: false } })
    expect(d).toMatchObject({
      can: { done: false, edit: false, moveUp: false, moveDown: false, dismiss: false },
    })
    const ro = buildPlanBlockViews(blocks, { now: at('08:00'), timezone: TZ, readOnly: true })
    expect(ro.every((v) => Object.values(v.can).every((x) => x === false))).toBe(true)
  })
})

describe('day view', () => {
  it('builds priorities with state, timeline, small tasks and the next action', () => {
    const d = draft({
      priorities: [
        {
          rank: 1,
          candidateKind: 'task',
          candidateId: 'p1',
          title: 'Report',
          reasonCode: 'overdue',
          reason: 'Overdue since Tue 22 Sep',
        },
        {
          rank: 2,
          candidateKind: 'task',
          candidateId: 'p2',
          title: 'Call',
          reasonCode: 'due_today_timed',
          reason: 'Due today 17:00',
        },
        {
          rank: 3,
          candidateKind: 'task',
          candidateId: 'p3',
          title: 'Big',
          reasonCode: 'high_priority',
          reason: 'Marked high priority',
        },
      ],
      doesNotFit: [
        {
          candidateKind: 'task',
          candidateId: 'p3',
          title: 'Big',
          minutes: 600,
          estimated: false,
          tentative: false,
          splittable: false,
          priorityRank: 3,
          reasonCode: 'no_gap_long_enough',
          reason: 'No single gap long enough',
          fitReasonCode: null,
        },
      ],
    })
    const blocks = [
      row({
        id: 'r',
        candidateId: 'p1',
        titleSnapshot: 'Report',
        startAt: at('09:00'),
        endAt: at('10:00'),
        minutes: 60,
        state: 'accepted',
      }),
      row({
        id: 'c',
        candidateId: 'p2',
        titleSnapshot: 'Call',
        startAt: at('10:00'),
        endAt: at('10:30'),
      }),
      row({
        id: 's',
        titleSnapshot: 'Small',
        bucket: 'small',
        startAt: at('10:30'),
        endAt: at('10:40'),
        minutes: 10,
      }),
      row({
        id: 'x',
        titleSnapshot: 'Gone',
        startAt: at('11:00'),
        endAt: at('11:30'),
        state: 'dismissed',
      }),
    ]
    const v = buildPlanDayView({
      localDate: DATE,
      today: DATE,
      timezone: TZ,
      now: at('09:50'),
      plan: plan(blocks, d),
    })
    expect(v.relative).toBe('today')
    expect(v.priorities.map((p) => [p.title, p.reason, p.state, p.timeLabel])).toEqual([
      ['Report', 'Overdue since Tue 22 Sep', 'accepted', '09:00–10:00'],
      ['Call', 'Due today 17:00', 'suggested', '10:00–10:30'],
      ['Big', 'Marked high priority', 'does_not_fit', null],
    ])
    expect(v.timeline.map((e) => (e.type === 'block' ? e.block.title : e.event.title))).toEqual([
      'Report',
      'Call',
    ])
    expect(v.smallTasks.map((b) => b.title)).toEqual(['Small'])
    expect(v.dismissed.map((b) => b.title)).toEqual(['Gone'])
    expect(v.nextAction?.title).toBe('Report')
    expect(v.nextAction?.isNow).toBe(true)
    expect(v.notes).toEqual([]) // the calendar note is shown in the timeline instead
    expect(v.counts).toEqual({ suggested: 2, tentativeSuggested: 0, accepted: 1, done: 0 })
    expect(v.dateLabel).toBe('Thursday 24 September')
  })

  it('places read-only busy events in the timeline with their source and link', () => {
    const blocks = [row({ id: 'b', startAt: at('10:00'), endAt: at('10:30') })]
    const v = buildPlanDayView({
      localDate: DATE,
      today: DATE,
      timezone: TZ,
      now: at('08:00'),
      plan: plan(blocks),
      events: [
        {
          id: 'e',
          title: 'Standup',
          source: 'Work (Google)',
          url: 'https://calendar.example/e',
          start: at('09:00'),
          end: at('09:15'),
        },
      ],
    })
    expect(v.timeline.map((e) => e.type)).toEqual(['event', 'block'])
    const unsafe = buildPlanDayView({
      localDate: DATE,
      today: DATE,
      timezone: TZ,
      now: at('08:00'),
      plan: plan(blocks),
      events: [
        // SYNTHETIC FIXTURE: an imported event carrying a script URL must not become a link.
        {
          id: 'x',
          title: 'Bad',
          source: 'Other',
          url: 'javascript:alert(1)',
          start: at('11:00'),
          end: at('11:30'),
        },
      ],
    })
    const bad = unsafe.timeline.find((e) => e.type === 'event')!
    expect(bad.type === 'event' && bad.event.url).toBeNull()
    const ev = v.timeline[0]!
    expect(ev.type === 'event' && ev.event).toMatchObject({
      timeLabel: '09:00–09:15',
      source: 'Work (Google)',
      url: 'https://calendar.example/e',
    })
  })

  it('marks past days read-only and only proposes changes for new data', () => {
    const blocks = [row({ id: 'b', startAt: at('10:00'), endAt: at('10:30') })]
    const past = buildPlanDayView({
      localDate: DATE,
      today: '2026-09-25',
      timezone: TZ,
      now: at('10:00'),
      plan: plan(blocks),
    })
    expect(past).toMatchObject({ relative: 'past', readOnly: true, canPlan: false })
    const moveOnly = {
      kept: [],
      unchanged: [],
      moves: [{ blockId: 'b' } as never],
      additions: [],
      removals: [],
      rejected: [],
      conflicts: [],
      hasChanges: true,
    }
    const noisy = buildPlanDayView({
      localDate: DATE,
      today: DATE,
      timezone: TZ,
      now: at('11:00'),
      plan: plan(blocks),
      revision: moveOnly,
    })
    expect(noisy.changes).toBeNull()
    const withNew = buildPlanDayView({
      localDate: DATE,
      today: DATE,
      timezone: TZ,
      now: at('11:00'),
      plan: plan(blocks),
      revision: { ...moveOnly, additions: [{} as never] },
    })
    expect(withNew.changes).toEqual({ additions: 1, removals: 0, moves: 1 })
    const tomorrow = buildPlanDayView({
      localDate: '2026-09-25',
      today: DATE,
      timezone: TZ,
      now: at('11:00'),
      plan: null,
    })
    expect(tomorrow).toMatchObject({ relative: 'tomorrow', canPlan: true, exists: false })
  })

  it('orders list-mode items by position', () => {
    const blocks = [
      row({ id: 'l2', bucket: 'list', position: 1, titleSnapshot: 'Second' }),
      row({ id: 'l1', bucket: 'list', position: 0, titleSnapshot: 'First' }),
    ]
    const v = buildPlanDayView({
      localDate: DATE,
      today: DATE,
      timezone: TZ,
      now: at('08:00'),
      plan: plan(blocks, draft({ mode: 'list' })),
    })
    expect(v.list.map((b) => [b.title, b.can.moveUp, b.can.moveDown])).toEqual([
      ['First', false, true],
      ['Second', true, false],
    ])
  })
})

describe('week view', () => {
  it('starts on Monday and links days to their plan', () => {
    expect(planWeekStart(DATE)).toBe('2026-09-21')
    expect(planWeekStart('2026-09-27')).toBe('2026-09-21')
    expect(planWeekStart('2026-09-21')).toBe('2026-09-21')
    const days = buildPlanWeekView({
      today: DATE,
      days: [
        {
          localDate: '2026-09-23',
          tasksDue: 1,
          acceptedBlocks: 0,
          hasPlan: false,
          busyEvents: null,
        },
        { localDate: DATE, tasksDue: 2, acceptedBlocks: 1, hasPlan: true, busyEvents: null },
      ],
    })
    expect(days.map((d) => [d.label, d.isToday, d.href])).toEqual([
      ['Wednesday 23 September', false, '/plan/day/2026-09-23'],
      ['Thursday 24 September', true, '/plan'],
    ])
    expect(planLongDateLabel('2026-03-29')).toBe('Sunday 29 March')
  })
})

describe('form validation', () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(fields)) f.set(k, v)
    return f
  }
  const id = '6f1c2b1e-3d4a-4b5c-8d6e-7f8091a2b3c4'

  it('accepts valid block actions and edits', () => {
    expect(parsePlanForm(PlanBlockFormSchema, form({ blockId: id, intent: 'accept' }))).toEqual({
      ok: true,
      data: { blockId: id, intent: 'accept', startTime: null, minutes: undefined },
    })
    expect(
      parsePlanForm(
        PlanBlockFormSchema,
        form({ blockId: id, intent: 'edit', startTime: '09:05', minutes: '45' }),
      ),
    ).toEqual({ ok: true, data: { blockId: id, intent: 'edit', startTime: '09:05', minutes: 45 } })
    expect(
      parsePlanForm(
        PlanBlockFormSchema,
        form({ blockId: id, intent: 'edit', startTime: '', minutes: '45' }),
      ),
    ).toMatchObject({
      ok: true,
      data: { startTime: null, minutes: 45 },
    })
  })

  it('rejects bad ids, intents, times and durations with a readable message', () => {
    expect(parsePlanForm(PlanBlockFormSchema, form({ blockId: 'x', intent: 'accept' }))).toEqual({
      ok: false,
      message: 'Unknown plan item.',
    })
    expect(parsePlanForm(PlanBlockFormSchema, form({ blockId: id, intent: 'delete-all' }))).toEqual(
      {
        ok: false,
        message: 'Unknown action.',
      },
    )
    expect(
      parsePlanForm(PlanBlockFormSchema, form({ blockId: id, intent: 'edit', minutes: '3' })),
    ).toEqual({
      ok: false,
      message: 'Duration must be at least 5 minutes.',
    })
    expect(parsePlanForm(PlanBlockFormSchema, form({ blockId: id, intent: 'edit' }))).toEqual({
      ok: false,
      message: 'Enter the duration in minutes.',
    })
    expect(
      parsePlanForm(
        PlanBlockFormSchema,
        form({ blockId: id, intent: 'edit', minutes: '30', startTime: '25:00' }),
      ),
    ).toMatchObject({
      ok: false,
    })
    expect(parsePlanForm(PlanDayFormSchema, form({ localDate: '2026-02-30' }))).toMatchObject({
      ok: false,
    })
    expect(parsePlanForm(PlanDayFormSchema, form({ localDate: DATE }))).toEqual({
      ok: true,
      data: { localDate: DATE },
    })
  })
})
