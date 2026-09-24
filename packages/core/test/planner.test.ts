/**
 * planDay: one describe block per planner rule (see the planner spec).
 * All fixtures are synthetic; times are Europe/London unless stated (BST = UTC+1 in Sep 2026).
 */
import { describe, expect, it } from 'vitest'
import {
  planDay,
  plannerAvailabilityForWeekday,
  plannerDurationLabel,
  plannerDateLabel,
  plannerRankCandidates,
  type PlanDraft,
  type PlanDraftBlock,
  type PlannerCandidateInput,
  type PlannerInput,
  localTimeInZone,
  zonedLocalToUtc,
} from '../src/index.ts'

const TZ = 'Europe/London'
const DATE = '2026-09-24' // Thursday
const at = (time: string, date = DATE) => zonedLocalToUtc(date, time, TZ)
const wall = (iso: string | null) => (iso ? localTimeInZone(new Date(iso), TZ) : null)
const CREATED = '2026-09-01T08:00:00Z'

let seq = 0
function task(over: Partial<PlannerCandidateInput> = {}): PlannerCandidateInput {
  seq++
  return {
    id: over.id ?? `t${seq}`,
    kind: 'task',
    title: over.title ?? `Task ${seq}`,
    createdAt: CREATED,
    ...over,
  }
}

function input(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    now: at('08:00'),
    timezone: TZ,
    localDate: DATE,
    availability: [{ start: '09:00', end: '17:00' }],
    candidates: [],
    ...over,
  }
}

const blocks = (d: PlanDraft): PlanDraftBlock[] => [...d.scheduled, ...d.smallTasks]
const slot = (b: PlanDraftBlock) => `${wall(b.start)}–${wall(b.end)}`
const ids = (xs: { candidateId: string }[]) => xs.map((x) => x.candidateId)

describe('rule 1 — priorities', () => {
  it('picks at most three, in the documented order, with reasons', () => {
    const d = planDay(
      input({
        candidates: [
          task({ id: 'p2', priority: 2 }),
          task({ id: 'soon', dueDate: '2026-09-26' }),
          task({ id: 'proj', kind: 'project_action' }),
          task({ id: 'p1', priority: 1 }),
          task({ id: 'today-untimed', dueDate: DATE }),
          task({ id: 'today-timed', dueAt: at('17:00').toISOString(), dueDate: DATE }),
          task({ id: 'overdue', dueDate: '2026-09-22' }),
        ],
      }),
    )
    expect(d.priorities.map((p) => [p.rank, p.candidateId, p.reason])).toEqual([
      [1, 'overdue', 'Overdue since Tue 22 Sep'],
      [2, 'today-timed', 'Due today 17:00'],
      [3, 'today-untimed', 'Due today'],
    ])
  })

  it('ranks the full order: overdue > today timed > today untimed > P1 > project action > due soon > P2 > older', () => {
    const cands = [
      task({ id: 'older', createdAt: '2026-08-01T00:00:00Z' }),
      task({ id: 'newer', createdAt: '2026-09-10T00:00:00Z' }),
      task({ id: 'p2', priority: 2 }),
      task({ id: 'soon', dueDate: '2026-09-27' }),
      task({ id: 'proj', kind: 'project_action' }),
      task({ id: 'p1', priority: 1 }),
      task({ id: 'today-untimed', dueDate: DATE }),
      task({ id: 'today-timed', dueAt: at('17:00').toISOString(), dueDate: DATE }),
      task({ id: 'overdue', dueDate: '2026-09-22' }),
    ]
    const d = planDay(input({ availability: null, candidates: cands }))
    expect(ids(d.list)).toEqual([
      'overdue',
      'today-timed',
      'today-untimed',
      'p1',
      'proj',
      'soon',
      'p2',
      'older',
      'newer',
    ])
  })

  it('explains each kind of reason deterministically', () => {
    const d = planDay(
      input({
        now: at('10:00'),
        availability: null,
        candidates: [task({ id: 'x', dueAt: at('08:30').toISOString(), dueDate: DATE })],
      }),
    )
    expect(d.priorities[0]?.reason).toBe('Overdue since 08:30')

    const reasons = (c: PlannerCandidateInput) =>
      planDay(input({ availability: null, candidates: [c] })).priorities[0]?.reason
    expect(reasons(task({ priority: 1 }))).toBe('Marked high priority')
    expect(reasons(task({ kind: 'project_action' }))).toBe('Agreed project action')
    expect(reasons(task({ dueDate: '2026-09-25' }))).toBe('Due tomorrow')
    expect(reasons(task({ dueDate: '2026-09-26' }))).toBe('Due Sat 26 Sep')
    expect(
      reasons(task({ dueAt: at('09:15', '2026-09-27').toISOString(), dueDate: '2026-09-27' })),
    ).toBe('Due Sun 27 Sep 09:15')
    expect(reasons(task({ priority: 2 }))).toBe('Marked priority 2')
    expect(reasons(task({ dueDate: '2025-12-30' }))).toBe('Overdue since Tue 30 Dec 2025')
    // Nothing pressing: no priority rather than an invented one.
    expect(reasons(task({ priority: 3 }))).toBeUndefined()
    expect(reasons(task({ dueDate: '2026-10-30' }))).toBeUndefined()
  })

  it('never makes tentative items, habits or reading goals priorities', () => {
    const d = planDay(
      input({
        candidates: [
          task({ id: 'tentative-overdue', dueDate: '2026-09-20', confirmed: false }),
          task({ id: 'email', kind: 'email_deadline', dueDate: DATE, confirmed: false }),
          task({ id: 'unagreed-project', kind: 'project_action', confirmed: false }),
          task({ id: 'habit', kind: 'habit', dueDate: '2026-09-20' }),
          task({ id: 'reading', kind: 'reading_goal', priority: 1 }),
          task({ id: 'real', priority: 2 }),
        ],
      }),
    )
    expect(ids(d.priorities)).toEqual(['real'])
    const tentative = blocks(d).filter((b) => b.tentative)
    expect(ids(tentative).sort()).toEqual(['email', 'tentative-overdue', 'unagreed-project'])
    expect(tentative.every((b) => b.priorityRank === null)).toBe(true)
  })

  it('confirmed email deadlines can be priorities', () => {
    const d = planDay(
      input({ candidates: [task({ id: 'mail', kind: 'email_deadline', dueDate: DATE })] }),
    )
    expect(ids(d.priorities)).toEqual(['mail'])
  })

  it('respects a lower maxPriorities option', () => {
    const d = planDay(
      input({
        options: { maxPriorities: 1 },
        candidates: [task({ priority: 1 }), task({ priority: 1 })],
      }),
    )
    expect(d.priorities).toHaveLength(1)
  })

  it('when planning tomorrow, items due today count as overdue by then and are labelled truthfully', () => {
    const d = planDay(
      input({
        now: at('21:00'),
        localDate: '2026-09-25',
        availability: null,
        candidates: [
          task({ id: 'due-today', dueDate: DATE }),
          task({
            id: 'due-tomorrow',
            dueAt: at('17:00', '2026-09-25').toISOString(),
            dueDate: '2026-09-25',
          }),
        ],
      }),
    )
    expect(d.priorities.map((p) => [p.candidateId, p.reasonCode, p.reason])).toEqual([
      ['due-today', 'overdue', 'Due today'],
      ['due-tomorrow', 'due_today_timed', 'Due tomorrow 17:00'],
    ])
  })
})

describe('rule 2 — durations', () => {
  it('uses entered durations as-is and labels the default estimate', () => {
    const d = planDay(
      input({ candidates: [task({ id: 'entered', durationMinutes: 50 }), task({ id: 'guess' })] }),
    )
    const byId = new Map(blocks(d).map((b) => [b.candidateId, b]))
    expect(byId.get('entered')).toMatchObject({ minutes: 50, estimated: false })
    expect(byId.get('guess')).toMatchObject({ minutes: 30, estimated: true })
  })

  it('uses a configured default estimate', () => {
    const d = planDay(
      input({ options: { defaultEstimateMinutes: 45 }, candidates: [task({ id: 'guess' })] }),
    )
    expect(blocks(d)[0]).toMatchObject({ minutes: 45, estimated: true })
  })
})

describe('rule 3 — free time: windows minus busy, protected and the past', () => {
  it('rounds now up to the next 5-minute mark and never schedules before it', () => {
    const d = planDay(input({ now: at('09:07'), candidates: [task({ id: 'a' })] }))
    expect(slot(d.scheduled[0]!)).toBe('09:10–09:40')
    const exact = planDay(input({ now: at('09:10'), candidates: [task({ id: 'a' })] }))
    expect(slot(exact.scheduled[0]!)).toBe('09:10–09:40')
    const seconds = planDay(
      input({ now: new Date(at('09:10').getTime() + 1000), candidates: [task({ id: 'a' })] }),
    )
    expect(slot(seconds.scheduled[0]!)).toBe('09:15–09:45')
  })

  it('schedules around busy events and protected blocks without overlap', () => {
    const d = planDay(
      input({
        busy: [
          { id: 'standup', title: 'Standup', start: at('09:00'), end: at('09:30') },
          { id: 'lunch', title: 'Lunch', start: at('10:00'), end: at('11:00') },
        ],
        protectedBlocks: [{ id: 'mine', start: at('09:30'), end: at('09:45'), minutes: 15 }],
        candidates: [
          task({ id: 'a', durationMinutes: 60 }),
          task({ id: 'b', durationMinutes: 15 }),
        ],
      }),
    )
    expect(blocks(d).map((b) => [b.candidateId, slot(b)])).toEqual([
      ['a', '11:00–12:00'],
      ['b', '09:45–10:00'],
    ])
  })

  it('ignores all-day and free events unless they are marked busy', () => {
    const base = { title: 'x', start: at('00:00'), end: at('00:00', '2026-09-25') }
    const free = planDay(
      input({
        busy: [
          { ...base, id: 'holiday', allDay: true },
          { id: 'focus', title: 'Optional', start: at('09:00'), end: at('12:00'), busy: false },
        ],
        candidates: [task({ id: 'a' })],
      }),
    )
    expect(slot(free.scheduled[0]!)).toBe('09:00–09:30')
    const busy = planDay(
      input({
        busy: [{ ...base, id: 'off', allDay: true, busy: true }],
        candidates: [task({ id: 'a', priority: 1 })],
      }),
    )
    expect(busy.scheduled).toEqual([])
    expect(busy.doesNotFit[0]).toMatchObject({ candidateId: 'a', reasonCode: 'not_enough_time' })
  })

  it('merges overlapping windows and supports an end of 24:00', () => {
    const d = planDay(
      input({
        now: at('20:00'),
        availability: [
          { start: '21:00', end: '24:00' },
          { start: '22:00', end: '23:00' },
        ],
        candidates: [task({ id: 'late', durationMinutes: 120, priority: 1 })],
      }),
    )
    expect(slot(d.scheduled[0]!)).toBe('21:00–23:00')
    expect(d.capacity.freeMinutes).toBe(180)
  })
})

describe('rule 4 — about 20% of free time stays unallocated', () => {
  it('allocates at most floor(free × 0.8)', () => {
    const d = planDay(
      input({
        availability: [{ start: '09:00', end: '10:40' }], // 100 min
        candidates: [
          task({ id: 'a', priority: 1 }),
          task({ id: 'b', priority: 1 }),
          task({ id: 'c', priority: 1 }),
        ],
      }),
    )
    expect(d.capacity).toMatchObject({
      known: true,
      freeMinutes: 100,
      budgetMinutes: 80,
      bufferMinutes: 20,
      allocatedMinutes: 60,
      overflowMinutes: 30,
      demandMinutes: 90,
    })
    expect(ids(d.scheduled)).toEqual(['a', 'b'])
    expect(d.doesNotFit).toMatchObject([{ candidateId: 'c', reasonCode: 'not_enough_time' }])
  })

  it('uses the free time left after busy/protected time and the past', () => {
    const d = planDay(
      input({
        now: at('12:02'),
        busy: [{ id: 'e', title: 'Meeting', start: at('13:00'), end: at('14:00') }],
        protectedBlocks: [{ id: 'p', start: at('15:00'), end: at('15:30'), minutes: 30 }],
      }),
    )
    // 12:05–17:00 = 295 min, minus 60 busy and 30 protected = 205.
    expect(d.capacity.freeMinutes).toBe(205)
    expect(d.capacity.budgetMinutes).toBe(164)
  })
})

describe('rule 5 — order, earliest slot and splitting', () => {
  it('places priorities first, then the rest by rank, each in the earliest slot that fits', () => {
    const d = planDay(
      input({
        candidates: [
          task({ id: 'low', durationMinutes: 60, createdAt: '2026-01-01T00:00:00Z' }),
          task({ id: 'p1', durationMinutes: 60, priority: 1 }),
          task({ id: 'soon', durationMinutes: 30, dueDate: '2026-09-26' }),
        ],
      }),
    )
    expect(d.scheduled.map((b) => [b.candidateId, slot(b)])).toEqual([
      ['p1', '09:00–10:00'],
      ['soon', '10:00–10:30'],
      ['low', '10:30–11:30'],
    ])
  })

  it('splits a splittable task across gaps into parts of at least 15 minutes, labelled', () => {
    const d = planDay(
      input({
        availability: [
          { start: '09:00', end: '09:40' },
          { start: '10:00', end: '10:40' },
        ],
        candidates: [task({ id: 's', durationMinutes: 60, splittable: true, priority: 1 })],
      }),
    )
    expect(d.scheduled.map((b) => [slot(b), b.minutes, b.splitPart, b.splitTotal])).toEqual([
      ['09:00–09:40', 40, 1, 2],
      ['10:00–10:20', 20, 2, 2],
    ])
  })

  it('never leaves a part shorter than the minimum block', () => {
    const d = planDay(
      input({
        availability: [
          { start: '09:00', end: '09:50' },
          { start: '10:00', end: '11:00' },
          { start: '12:00', end: '13:00' },
        ],
        busy: [{ id: 'b', start: at('10:15'), end: at('11:00') }],
        options: { bufferRatio: 0 },
        candidates: [task({ id: 's', durationMinutes: 60, splittable: true, priority: 1 })],
      }),
    )
    // Whole fits at 12:00, so it is not split at all.
    expect(d.scheduled.map(slot)).toEqual(['12:00–13:00'])

    const split = planDay(
      input({
        availability: [
          { start: '09:00', end: '09:50' },
          { start: '10:00', end: '10:30' },
        ],
        options: { bufferRatio: 0 },
        candidates: [task({ id: 's', durationMinutes: 60, splittable: true, priority: 1 })],
      }),
    )
    // 50 would leave 10 (< 15), so the first part shrinks to 45 and the second is 15.
    expect(split.scheduled.map((b) => [slot(b), b.minutes])).toEqual([
      ['09:00–09:45', 45],
      ['10:00–10:15', 15],
    ])
  })

  it('never splits a non-splittable task', () => {
    const d = planDay(
      input({
        availability: [
          { start: '09:00', end: '09:40' },
          { start: '10:00', end: '10:40' },
        ],
        candidates: [task({ id: 'n', durationMinutes: 60, priority: 1 })],
      }),
    )
    expect(d.scheduled).toEqual([])
    expect(d.doesNotFit).toMatchObject([{ candidateId: 'n', reasonCode: 'no_gap_long_enough' }])
  })

  it('continues a split task whose first part the owner already accepted', () => {
    const d = planDay(
      input({
        protectedBlocks: [
          {
            id: 'part1',
            candidateKind: 'task',
            candidateId: 's',
            start: at('09:00'),
            end: at('09:30'),
            minutes: 30,
            splitPart: 1,
            splitTotal: 2,
          },
        ],
        candidates: [task({ id: 's', durationMinutes: 60, splittable: true })],
      }),
    )
    expect(d.alreadyPlanned).toEqual([])
    expect(d.scheduled.map((b) => [slot(b), b.minutes, b.splitPart, b.splitTotal])).toEqual([
      ['09:30–10:00', 30, 2, 2],
    ])
  })

  it('treats a candidate with an accepted whole block as already planned', () => {
    const d = planDay(
      input({
        protectedBlocks: [
          {
            id: 'b1',
            candidateKind: 'task',
            candidateId: 'x',
            start: at('09:00'),
            end: at('09:30'),
            minutes: 30,
          },
        ],
        candidates: [task({ id: 'x', durationMinutes: 90, splittable: true, priority: 1 })],
      }),
    )
    expect(d.alreadyPlanned).toMatchObject([
      { candidateId: 'x', plannedMinutes: 30, priorityRank: 1 },
    ])
    expect(ids(d.priorities)).toEqual(['x'])
    expect(blocks(d)).toEqual([])
  })

  it('notes when a deadline cannot be met', () => {
    const d = planDay(
      input({
        now: at('09:00'),
        candidates: [
          task({ id: 'x', durationMinutes: 120, dueAt: at('10:00').toISOString(), dueDate: DATE }),
        ],
      }),
    )
    expect(d.scheduled[0]).toMatchObject({ note: 'Ends after its 10:00 deadline' })
  })
})

describe('rule 6 — small tasks fill short gaps', () => {
  it('uses gaps the bigger items could not use', () => {
    const d = planDay(
      input({
        availability: [{ start: '09:00', end: '10:30' }],
        busy: [{ id: 'm', title: 'Call', start: at('09:20'), end: at('09:30') }],
        candidates: [
          task({ id: 'small', durationMinutes: 10 }),
          task({ id: 'big', durationMinutes: 45, createdAt: '2026-08-01T00:00:00Z' }),
        ],
      }),
    )
    expect(d.scheduled.map((b) => [b.candidateId, slot(b)])).toEqual([['big', '09:30–10:15']])
    // Best fit: the 15-minute gap after the big item (the 20-minute gap is also short).
    expect(d.smallTasks.map((b) => [b.candidateId, slot(b), b.bucket])).toEqual([
      ['small', '10:15–10:25', 'small'],
    ])
  })

  it('small items with deadline pressure are scheduled in rank order, not held back', () => {
    const d = planDay(
      input({
        candidates: [task({ id: 's', durationMinutes: 10, dueDate: '2026-09-25' })],
      }),
    )
    expect(d.scheduled.map((b) => b.candidateId)).toEqual(['s'])
    expect(d.smallTasks).toEqual([])
  })
})

describe('rule 7 — what does not fit, and what can wait', () => {
  it('reports not enough time, no gap long enough and after the last window', () => {
    const d = planDay(
      input({
        availability: [
          { start: '09:00', end: '10:00' },
          { start: '11:00', end: '11:30' },
        ],
        candidates: [
          task({ id: 'fits', durationMinutes: 45, priority: 1 }),
          task({ id: 'too-long', durationMinutes: 40, priority: 1 }),
          task({ id: 'no-time', durationMinutes: 30, priority: 1 }),
        ],
      }),
    )
    // free 90, budget 72: 'fits' takes 45 → 27 left; both others need more than 27 (rank order).
    expect(d.doesNotFit.map((x) => [x.candidateId, x.reasonCode, x.reason])).toEqual([
      ['no-time', 'not_enough_time', 'Not enough free time today'],
      ['too-long', 'not_enough_time', 'Not enough free time today'],
    ])

    const gaps = planDay(
      input({
        availability: [
          { start: '09:00', end: '09:30' },
          { start: '10:00', end: '10:30' },
          { start: '11:00', end: '11:30' },
        ],
        candidates: [task({ id: 'long', durationMinutes: 45, priority: 1 })],
      }),
    )
    expect(gaps.doesNotFit).toMatchObject([
      { candidateId: 'long', reasonCode: 'no_gap_long_enough' },
    ])

    const late = planDay(
      input({ now: at('18:00'), candidates: [task({ id: 'x', priority: 1 }), task({ id: 'y' })] }),
    )
    expect(late.doesNotFit).toMatchObject([
      { candidateId: 'x', reasonCode: 'after_last_window', reason: "After the day's last window" },
    ])
    expect(late.canWait).toMatchObject([
      { candidateId: 'y', reasonCode: 'low_pressure', fitReasonCode: 'after_last_window' },
    ])
    expect(late.notes.map((n) => n.code)).toContain('day_over')
    expect(late.capacity).toMatchObject({
      freeMinutes: 0,
      allocatedMinutes: 0,
      overflowMinutes: 60,
    })
  })

  it('sends low-pressure items to Can wait when capacity is short, pressured ones to Does not fit', () => {
    const d = planDay(
      input({
        availability: [{ start: '09:00', end: '10:00' }], // budget 48
        candidates: [
          task({ id: 'urgent', durationMinutes: 40, dueDate: DATE }),
          task({ id: 'due-soon', durationMinutes: 30, dueDate: '2026-09-25' }),
          task({ id: 'someday', durationMinutes: 30 }),
          task({ id: 'habit', kind: 'habit' }),
        ],
      }),
    )
    expect(ids(d.scheduled)).toEqual(['urgent'])
    expect(ids(d.doesNotFit)).toEqual(['due-soon'])
    expect(ids(d.canWait)).toEqual(['someday', 'habit'])
    const c = d.capacity
    expect(c.allocatedMinutes + (c.overflowMinutes ?? 0)).toBe(c.demandMinutes)
  })

  it('never claims everything fits: overflow is reported', () => {
    const d = planDay(
      input({
        availability: [{ start: '09:00', end: '09:30' }],
        candidates: [task({ durationMinutes: 120, priority: 1 })],
      }),
    )
    expect(d.capacity.allocatedMinutes).toBe(0)
    expect(d.capacity.overflowMinutes).toBe(120)
  })
})

describe('rule 8 — list mode without availability', () => {
  it('orders every candidate with estimates and invents no times', () => {
    const d = planDay(
      input({
        availability: null,
        candidates: [
          task({ id: 'b', durationMinutes: 20 }),
          task({ id: 'tent', confirmed: false, dueDate: '2026-09-20' }),
          task({ id: 'a', dueDate: '2026-09-23' }),
        ],
      }),
    )
    expect(d.mode).toBe('list')
    expect(ids(d.list)).toEqual(['a', 'b', 'tent'])
    expect(d.list.every((b) => b.start === null && b.end === null && b.bucket === 'list')).toBe(
      true,
    )
    expect(d.list.map((b) => [b.minutes, b.estimated])).toEqual([
      [30, true],
      [20, false],
      [30, true],
    ])
    expect(d.capacity).toEqual({
      known: false,
      freeMinutes: null,
      bufferMinutes: null,
      budgetMinutes: null,
      allocatedMinutes: 0,
      overflowMinutes: null,
      demandMinutes: 80,
    })
    expect(d.scheduled).toEqual([])
    expect(d.canWait).toEqual([])
    expect(d.doesNotFit).toEqual([])
    expect(d.notes.map((n) => n.code)).toEqual(['list_mode_not_set', 'calendars_not_connected'])
  })

  it('explains why list mode is used', () => {
    const d = planDay(input({ availability: null, listModeReason: 'none_for_weekday' }))
    expect(d.notes[0]?.code).toBe('list_mode_none_for_weekday')
    expect(d.notes.map((n) => n.code)).toContain('nothing_to_plan')
  })
})

describe('rule 9 — conflicts are reported, never auto-moved', () => {
  it('flags a protected block that overlaps a busy event and another protected block', () => {
    const d = planDay(
      input({
        busy: [{ id: 'ev', title: 'Dentist', start: at('10:00'), end: at('11:00') }],
        protectedBlocks: [
          { id: 'p1', title: 'Write', start: at('10:30'), end: at('11:30'), minutes: 60 },
          { id: 'p2', title: 'Read', start: at('11:15'), end: at('11:45'), minutes: 30 },
        ],
        candidates: [task({ id: 'a', durationMinutes: 60 })],
      }),
    )
    expect(d.conflicts.map((c) => [c.kind, c.blockId, c.withId, c.message])).toEqual([
      ['event', 'p1', 'ev', 'Overlaps “Dentist” (10:30–11:00)'],
      ['block', 'p1', 'p2', 'Overlaps “Read” (11:15–11:30)'],
    ])
    // The protected blocks are not in the output (never moved) and nothing new overlaps them.
    expect(slot(d.scheduled[0]!)).toBe('09:00–10:00')
  })
})

describe('determinism', () => {
  it('produces identical output for identical input and for reordered candidates', () => {
    const cands = [
      task({ id: 'a', priority: 1, durationMinutes: 50 }),
      task({ id: 'b', dueDate: DATE }),
      task({ id: 'c', durationMinutes: 10 }),
      task({ id: 'd', confirmed: false }),
      task({ id: 'e', kind: 'habit' }),
    ]
    const one = planDay(input({ candidates: cands }))
    const two = planDay(input({ candidates: [...cands] }))
    const reversed = planDay(input({ candidates: [...cands].reverse() }))
    expect(two).toEqual(one)
    expect(reversed).toEqual(one)
  })

  it('does not mutate its input', () => {
    const inp = input({ candidates: [task({ id: 'a' })] })
    const snapshot = JSON.stringify(inp)
    planDay(inp)
    expect(JSON.stringify(inp)).toBe(snapshot)
  })

  it('rejects invalid input at the boundary', () => {
    expect(() => planDay(input({ timezone: 'Mars/Olympus' }))).toThrow()
    expect(() => planDay(input({ localDate: '2026-02-30' }))).toThrow()
    expect(() =>
      planDay(input({ candidates: [{ ...task(), priority: 7 } as PlannerCandidateInput] })),
    ).toThrow()
  })

  it('dedupes a candidate listed twice', () => {
    const d = planDay(input({ candidates: [task({ id: 'x' }), task({ id: 'x', title: 'Again' })] }))
    expect(blocks(d)).toHaveLength(1)
  })
})

describe('ranking helper', () => {
  it('keeps a total order independent of input order', () => {
    const ctx = {
      nowMs: at('08:00').getTime(),
      timezone: TZ,
      localDate: DATE,
      today: DATE,
      dayStartMs: at('00:00').getTime(),
      dueSoonDays: 3,
    }
    const parse = (c: PlannerCandidateInput) => ({
      id: c.id,
      kind: c.kind,
      title: c.title,
      createdAt: new Date(c.createdAt as string),
      splittable: false,
      confirmed: true,
      priority: c.priority ?? null,
    })
    const a = [task({ id: 'z' }), task({ id: 'y' }), task({ id: 'x', kind: 'habit' })].map(parse)
    const r1 = plannerRankCandidates(a, ctx).map((x) => x.key)
    const r2 = plannerRankCandidates([...a].reverse(), ctx).map((x) => x.key)
    expect(r1).toEqual(r2)
    expect(r1).toEqual(['task:y', 'task:z', 'habit:x'])
  })
})

describe('available hours parsing', () => {
  it('handles unset, invalid and per-weekday availability defensively', () => {
    expect(plannerAvailabilityForWeekday(null, 4)).toEqual({
      windows: null,
      listModeReason: 'not_set',
      ignoredEntries: 0,
    })
    expect(plannerAvailabilityForWeekday([], 4).listModeReason).toBe('not_set')
    expect(plannerAvailabilityForWeekday({ nope: true }, 4).listModeReason).toBe('invalid')
    expect(plannerAvailabilityForWeekday([{ weekday: 9, start: 'x' }], 4).listModeReason).toBe(
      'invalid',
    )
    expect(
      plannerAvailabilityForWeekday([{ weekday: 1, start: '09:00', end: '17:00' }], 4)
        .listModeReason,
    ).toBe('none_for_weekday')
    expect(
      plannerAvailabilityForWeekday(
        [
          { weekday: 4, start: '13:00', end: '17:30' },
          { weekday: 4, start: '09:00', end: '12:00' },
          { weekday: 4, start: '11:30', end: '12:30' },
          { weekday: 4, start: '20:00', end: '24:00' },
          { weekday: 4, start: '18:00', end: '17:00' },
          { weekday: 4, start: '25:00', end: '26:00' },
          'garbage',
        ],
        4,
      ),
    ).toEqual({
      windows: [
        { start: '09:00', end: '12:30' },
        { start: '13:00', end: '17:30' },
        { start: '20:00', end: '24:00' },
      ],
      listModeReason: null,
      ignoredEntries: 3,
    })
  })
})

describe('labels', () => {
  it('formats dates and durations without relying on ICU month names', () => {
    expect(plannerDateLabel('2026-09-22')).toBe('Tue 22 Sep')
    expect(plannerDateLabel('2027-01-03', '2026-12-30')).toBe('Sun 3 Jan 2027')
    expect(plannerDurationLabel(30)).toBe('30 min')
    expect(plannerDurationLabel(60)).toBe('1 h')
    expect(plannerDurationLabel(95)).toBe('1 h 35 min')
  })
})
