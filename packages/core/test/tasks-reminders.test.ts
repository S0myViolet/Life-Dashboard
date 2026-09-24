import { describe, expect, it } from 'vitest'
import {
  ReminderInputSchema,
  ReminderSubjectSchema,
  localDateInZone,
  localTimeInZone,
  nextReminderOccurrence,
  reminderIsDue,
  resolveReminderSchedule,
  resolveTaskReminder,
  type ReminderRecurrence,
} from '../src/index.ts'

const LONDON = 'Europe/London'
const at = (s: string) => new Date(s)
const local = (d: Date, tz = LONDON) => `${localDateInZone(d, tz)} ${localTimeInZone(d, tz)}`

describe('reminder input', () => {
  it('validates title, date, time and recurrence', () => {
    expect(
      ReminderInputSchema.parse({ title: ' Call  mum ', date: '2026-10-01', time: '18:00' }),
    ).toEqual({ title: 'Call mum', date: '2026-10-01', time: '18:00' })
    expect(
      ReminderInputSchema.safeParse({ title: '', date: '2026-10-01', time: '18:00' }).success,
    ).toBe(false)
    expect(
      ReminderInputSchema.safeParse({ title: 'x', date: '2026-13-01', time: '18:00' }).success,
    ).toBe(false)
    expect(
      ReminderInputSchema.safeParse({ title: 'x', date: '2026-10-01', time: '7pm' }).success,
    ).toBe(false)
    expect(
      ReminderInputSchema.safeParse({
        title: 'x',
        date: '2026-10-01',
        time: '18:00',
        recurrence: 'hourly',
      }).success,
    ).toBe(false)
  })

  it('requires a subject id for non-custom reminders only', () => {
    const id = '5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a'
    expect(ReminderSubjectSchema.safeParse({ kind: 'custom', id: null }).success).toBe(true)
    expect(ReminderSubjectSchema.safeParse({ kind: 'task', id }).success).toBe(true)
    expect(ReminderSubjectSchema.safeParse({ kind: 'task', id: null }).success).toBe(false)
    expect(ReminderSubjectSchema.safeParse({ kind: 'custom', id }).success).toBe(false)
  })
})

describe('resolveReminderSchedule', () => {
  const now = at('2026-09-24T12:00:00Z') // 13:00 BST

  it('accepts a future one-off time in the owner zone', () => {
    const r = resolveReminderSchedule({ date: '2026-09-24', time: '18:00' }, now, LONDON)
    expect(r).toEqual({
      ok: true,
      schedule: {
        remindAt: at('2026-09-24T17:00:00Z'),
        recurrence: null,
        recurrenceTime: null,
        recurrenceDay: null,
        shiftedTo: null,
      },
    })
  })

  it('refuses a one-off time that has passed', () => {
    const r = resolveReminderSchedule({ date: '2026-09-24', time: '12:00' }, now, LONDON)
    expect(r).toMatchObject({ ok: false, field: 'time' })
  })

  it('starts a recurring reminder at its next occurrence when the first has passed', () => {
    const r = resolveReminderSchedule(
      { date: '2026-09-24', time: '09:00', recurrence: 'daily' },
      now,
      LONDON,
    )
    expect(r.ok && r.schedule.remindAt).toEqual(at('2026-09-25T08:00:00Z'))
    expect(r.ok && r.schedule.recurrenceTime).toBe('09:00')
  })

  it('anchors monthly/yearly reminders to the entered day', () => {
    const r = resolveReminderSchedule(
      { date: '2026-10-31', time: '09:00', recurrence: 'monthly' },
      now,
      LONDON,
    )
    expect(r.ok && r.schedule.recurrenceDay).toBe(31)
    const w = resolveReminderSchedule(
      { date: '2026-10-31', time: '09:00', recurrence: 'weekly' },
      now,
      LONDON,
    )
    expect(w.ok && w.schedule.recurrenceDay).toBe(null)
  })

  it('moves a DST-gap time forward and reports it', () => {
    const r = resolveReminderSchedule({ date: '2027-03-28', time: '01:30' }, now, LONDON)
    expect(r.ok && r.schedule.shiftedTo).toBe('02:30')
    expect(r.ok && r.schedule.remindAt).toEqual(at('2027-03-28T01:30:00Z'))
  })

  it('refuses dates more than ten years ahead', () => {
    const r = resolveReminderSchedule({ date: '2040-01-01', time: '09:00' }, now, LONDON)
    expect(r).toMatchObject({ ok: false, field: 'date' })
  })
})

describe('nextReminderOccurrence (DST-safe, drift-free)', () => {
  const next = (
    remindAt: string,
    recurrence: ReminderRecurrence,
    after: string,
    anchors: { recurrenceTime?: string; recurrenceDay?: number } = {},
  ) => nextReminderOccurrence({ remindAt: at(remindAt), recurrence, ...anchors }, at(after), LONDON)

  it('keeps 09:00 local across the spring and autumn changes', () => {
    // 09:00 GMT on Saturday 28 March → 09:00 BST on Sunday 29 March.
    expect(local(next('2026-03-28T09:00:00Z', 'daily', '2026-03-28T09:00:00Z'))).toBe(
      '2026-03-29 09:00',
    )
    expect(next('2026-03-28T09:00:00Z', 'daily', '2026-03-28T09:00:00Z')).toEqual(
      at('2026-03-29T08:00:00Z'),
    )
    expect(local(next('2026-10-24T08:00:00Z', 'daily', '2026-10-24T08:00:00Z'))).toBe(
      '2026-10-25 09:00',
    )
    expect(local(next('2026-03-23T09:00:00Z', 'weekly', '2026-03-23T09:00:00Z'))).toBe(
      '2026-03-30 09:00',
    )
  })

  it('returns to the anchored time after a gap day', () => {
    // 01:30 does not exist on 29 March; it fires at 02:30 that day and 01:30 the next.
    const onGapDay = next('2026-03-28T01:30:00Z', 'daily', '2026-03-28T01:30:00Z', {
      recurrenceTime: '01:30',
    })
    expect(local(onGapDay)).toBe('2026-03-29 02:30')
    const after = next(onGapDay.toISOString(), 'daily', onGapDay.toISOString(), {
      recurrenceTime: '01:30',
    })
    expect(local(after)).toBe('2026-03-30 01:30')
  })

  it('clamps monthly reminders to short months without drifting', () => {
    const jan31 = '2027-01-31T09:00:00Z'
    const feb = next(jan31, 'monthly', jan31, { recurrenceTime: '09:00', recurrenceDay: 31 })
    expect(local(feb)).toBe('2027-02-28 09:00')
    const mar = next(feb.toISOString(), 'monthly', feb.toISOString(), {
      recurrenceTime: '09:00',
      recurrenceDay: 31,
    })
    expect(local(mar)).toBe('2027-03-31 09:00')
    const apr = next(mar.toISOString(), 'monthly', mar.toISOString(), {
      recurrenceTime: '09:00',
      recurrenceDay: 31,
    })
    expect(local(apr)).toBe('2027-04-30 09:00')
  })

  it('keeps 29 February yearly reminders on the 28th in common years and the 29th in leap years', () => {
    const leap = '2028-02-29T09:00:00Z'
    const y1 = next(leap, 'yearly', leap, { recurrenceTime: '09:00', recurrenceDay: 29 })
    expect(local(y1)).toBe('2029-02-28 09:00')
    let y = y1
    for (let i = 0; i < 3; i++) {
      y = next(y.toISOString(), 'yearly', y.toISOString(), {
        recurrenceTime: '09:00',
        recurrenceDay: 29,
      })
    }
    expect(local(y)).toBe('2032-02-29 09:00')
  })

  it('skips a backlog of missed occurrences instead of replaying them', () => {
    const r = next('2025-01-06T09:00:00Z', 'daily', '2026-09-24T12:00:00Z', {
      recurrenceTime: '09:00',
    })
    expect(local(r)).toBe('2026-09-25 09:00')
    const w = next('2025-01-06T09:00:00Z', 'weekly', '2026-09-24T12:00:00Z') // Mondays
    expect(local(w)).toBe('2026-09-28 09:00')
    const m = next('2025-01-31T09:00:00Z', 'monthly', '2026-09-24T12:00:00Z', { recurrenceDay: 31 })
    expect(local(m)).toBe('2026-09-30 09:00')
    const yr = next('2020-12-25T09:00:00Z', 'yearly', '2026-09-24T12:00:00Z')
    expect(local(yr)).toBe('2026-12-25 09:00')
  })

  it('always moves past the current occurrence', () => {
    const r = next('2026-09-30T08:00:00Z', 'daily', '2026-09-24T12:00:00Z')
    expect(local(r)).toBe('2026-10-01 09:00')
  })
})

describe('reminderIsDue', () => {
  const now = at('2026-09-24T12:00:00Z')
  it('is due once scheduled/delivered and its time has come', () => {
    expect(reminderIsDue({ status: 'scheduled', remindAt: now }, now)).toBe(true)
    expect(reminderIsDue({ status: 'delivered', remindAt: at('2026-09-24T08:00:00Z') }, now)).toBe(
      true,
    )
    expect(reminderIsDue({ status: 'scheduled', remindAt: at('2026-09-24T12:00:01Z') }, now)).toBe(
      false,
    )
    expect(reminderIsDue({ status: 'dismissed', remindAt: at('2026-09-24T08:00:00Z') }, now)).toBe(
      false,
    )
    expect(reminderIsDue({ status: 'cancelled', remindAt: at('2026-09-24T08:00:00Z') }, now)).toBe(
      false,
    )
  })
})

describe('resolveTaskReminder', () => {
  const now = at('2026-09-24T12:00:00Z')
  const dueAt = at('2026-09-25T13:30:00Z') // 14:30 BST tomorrow

  it('keeps, clears and sets relative reminders', () => {
    expect(resolveTaskReminder({ choice: 'keep', dueAt }, now, LONDON)).toEqual({
      ok: true,
      plan: { kind: 'keep' },
    })
    expect(resolveTaskReminder({ choice: 'none', dueAt }, now, LONDON)).toEqual({
      ok: true,
      plan: { kind: 'clear' },
    })
    const cases = {
      at_due: '2026-09-25T13:30:00.000Z',
      '15m': '2026-09-25T13:15:00.000Z',
      '1h': '2026-09-25T12:30:00.000Z',
      '1d': '2026-09-24T13:30:00.000Z',
    } as const
    for (const [choice, expected] of Object.entries(cases)) {
      const r = resolveTaskReminder({ choice: choice as keyof typeof cases, dueAt }, now, LONDON)
      expect(r.ok && r.plan.kind === 'set' && r.plan.remindAt.toISOString(), choice).toBe(expected)
    }
  })

  it('"1 day before" keeps the local time across a DST change', () => {
    const due = at('2026-03-29T08:00:00Z') // 09:00 BST on the spring-forward day
    const r = resolveTaskReminder({ choice: '1d', dueAt: due }, at('2026-03-01T00:00:00Z'), LONDON)
    expect(r.ok && r.plan.kind === 'set' && local(r.plan.remindAt)).toBe('2026-03-28 09:00')
    expect(r.ok && r.plan.kind === 'set' && r.plan.remindAt).toEqual(at('2026-03-28T09:00:00Z'))
  })

  it('needs a due time for relative choices and refuses past times', () => {
    expect(resolveTaskReminder({ choice: '1h', dueAt: null }, now, LONDON)).toMatchObject({
      ok: false,
      field: 'reminder',
    })
    expect(
      resolveTaskReminder({ choice: '1d', dueAt: at('2026-09-25T06:00:00Z') }, now, LONDON),
    ).toMatchObject({ ok: false, field: 'reminder' })
  })

  it('takes a custom date and time in the owner zone', () => {
    const r = resolveTaskReminder(
      { choice: 'custom', date: '2026-09-25', time: '08:00', dueAt: null },
      now,
      LONDON,
    )
    expect(r.ok && r.plan.kind === 'set' && r.plan.remindAt).toEqual(at('2026-09-25T07:00:00Z'))
    expect(
      resolveTaskReminder({ choice: 'custom', date: '2026-09-25', dueAt: null }, now, LONDON),
    ).toMatchObject({
      ok: false,
      field: 'reminderTime',
    })
    expect(
      resolveTaskReminder({ choice: 'custom', time: '08:00', dueAt: null }, now, LONDON),
    ).toMatchObject({
      ok: false,
      field: 'reminderDate',
    })
    expect(
      resolveTaskReminder(
        { choice: 'custom', date: '2026-09-24', time: '08:00', dueAt: null },
        now,
        LONDON,
      ),
    ).toMatchObject({ ok: false, field: 'reminderTime' })
  })
})
