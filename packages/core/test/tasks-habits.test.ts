import { describe, expect, it } from 'vitest'
import {
  HabitCreateInputSchema,
  HabitUpdateInputSchema,
  HabitWeekdaysSchema,
  addLocalDays,
  checkHabitCompletionDate,
  describeHabitWeekdays,
  habitGridStart,
  isHabitDueOn,
  summarizeHabit,
  type HabitForSummary,
} from '../src/index.ts'

const LONDON = 'Europe/London'
const at = (s: string) => new Date(s)

describe('habit input', () => {
  it('de-duplicates and sorts weekdays and requires at least one', () => {
    expect(HabitWeekdaysSchema.parse([5, 1, 3, 1])).toEqual([1, 3, 5])
    expect(HabitWeekdaysSchema.safeParse([]).success).toBe(false)
    expect(HabitWeekdaysSchema.safeParse([0]).success).toBe(false)
    expect(HabitWeekdaysSchema.safeParse([8]).success).toBe(false)
    expect(HabitWeekdaysSchema.safeParse([1.5]).success).toBe(false)
  })

  it('defaults to every day and bounds the title', () => {
    expect(HabitCreateInputSchema.parse({ title: ' Stretch ' })).toEqual({
      title: 'Stretch',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    })
    expect(HabitCreateInputSchema.safeParse({ title: '' }).success).toBe(false)
    expect(HabitCreateInputSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false)
    expect(HabitUpdateInputSchema.parse({ weekdays: [7, 6] })).toEqual({ weekdays: [6, 7] })
  })
})

describe('habit schedule', () => {
  it('is due on its ISO weekdays', () => {
    // 2026-09-21 is a Monday.
    expect(isHabitDueOn([1, 3, 5], '2026-09-21')).toBe(true)
    expect(isHabitDueOn([1, 3, 5], '2026-09-22')).toBe(false)
    expect(isHabitDueOn([7], '2026-09-27')).toBe(true)
  })

  it('describes common patterns', () => {
    expect(describeHabitWeekdays([1, 2, 3, 4, 5, 6, 7])).toBe('Every day')
    expect(describeHabitWeekdays([5, 4, 3, 2, 1])).toBe('Weekdays')
    expect(describeHabitWeekdays([6, 7])).toBe('Weekends')
    expect(describeHabitWeekdays([1, 3, 5])).toBe('Mon, Wed, Fri')
  })

  it('only accepts completions for today or the recent past', () => {
    expect(checkHabitCompletionDate('2026-09-24', '2026-09-24')).toEqual({ ok: true })
    expect(checkHabitCompletionDate('2026-09-01', '2026-09-24')).toEqual({ ok: true })
    expect(checkHabitCompletionDate('2026-09-25', '2026-09-24').ok).toBe(false)
    expect(checkHabitCompletionDate('2025-09-01', '2026-09-24').ok).toBe(false)
    expect(checkHabitCompletionDate('2026-02-30', '2026-09-24').ok).toBe(false)
  })
})

describe('summarizeHabit', () => {
  // Thursday 24 September 2026.
  const today = '2026-09-24'
  const monWedFri: HabitForSummary = {
    weekdays: [1, 3, 5],
    createdAt: at('2026-09-01T08:00:00Z'), // Tuesday 1 September
    active: true,
    archivedAt: null,
  }

  it('builds an 8-week Monday-first grid ending with the current week', () => {
    expect(habitGridStart(today)).toBe('2026-08-03')
    const s = summarizeHabit(monWedFri, [], { today, tz: LONDON })
    expect(s.weeks).toHaveLength(8)
    expect(s.weeks.every((w) => w.length === 7)).toBe(true)
    expect(s.weeks[0]![0]!.date).toBe('2026-08-03')
    expect(s.weeks[7]![6]!.date).toBe('2026-09-27')
    expect(
      s.weeks
        .flat()
        .map((c) => c.weekday)
        .slice(0, 7),
    ).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('shows missed scheduled days as missed, never hidden', () => {
    // Done: Wed 2, Fri 4, Mon 7, Fri 11 (extra: Sat 12). Missed: Wed 9, Mon 14, ...
    const done = ['2026-09-02', '2026-09-04', '2026-09-07', '2026-09-11', '2026-09-12']
    const s = summarizeHabit(monWedFri, done, { today, tz: LONDON })
    const state = (d: string) => s.weeks.flat().find((c) => c.date === d)!.state
    expect(state('2026-08-31')).toBe('before_start') // Monday before the habit existed
    expect(state('2026-09-01')).toBe('rest') // created on a Tuesday, not scheduled
    expect(state('2026-09-02')).toBe('done')
    expect(state('2026-09-09')).toBe('missed')
    expect(state('2026-09-12')).toBe('done') // extra, unscheduled
    expect(state('2026-09-14')).toBe('missed')
    expect(state('2026-09-23')).toBe('missed')
    expect(state('2026-09-24')).toBe('rest') // Thursday
    expect(state('2026-09-25')).toBe('future')
    // Scheduled days from Wed 2 Sep to Wed 23 Sep: 2,4,7,9,11,14,16,18,21,23 = 10.
    expect(s.scheduledDays).toBe(10)
    expect(s.completedScheduledDays).toBe(4)
    expect(s.missedDays).toBe(6)
    expect(s.extraCompletions).toBe(1)
    expect(s.currentStreak).toBe(0)
    expect(s.longestStreak).toBe(3) // 2, 4, 7
  })

  it('does not count today as missed until the day is over', () => {
    const daily: HabitForSummary = { ...monWedFri, weekdays: [1, 2, 3, 4, 5, 6, 7] }
    const done = ['2026-09-21', '2026-09-22', '2026-09-23']
    const s = summarizeHabit(daily, done, { today, tz: LONDON })
    expect(s.today.state).toBe('pending')
    expect(s.currentStreak).toBe(3)
    const after = summarizeHabit(daily, [...done, today], { today, tz: LONDON })
    expect(after.today.state).toBe('done')
    expect(after.currentStreak).toBe(4)
  })

  it('skips rest days in a streak but breaks on a miss', () => {
    const done = ['2026-09-18', '2026-09-21', '2026-09-23'] // Fri, Mon, Wed
    const s = summarizeHabit(monWedFri, done, { today, tz: LONDON })
    expect(s.currentStreak).toBe(3)
    const gap = summarizeHabit(monWedFri, ['2026-09-18', '2026-09-23'], { today, tz: LONDON })
    expect(gap.currentStreak).toBe(1)
  })

  it('flags a streak that reaches the start of the loaded history', () => {
    const daily: HabitForSummary = {
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      createdAt: at('2025-01-01T12:00:00Z'),
      active: true,
      archivedAt: null,
    }
    const historyStart = '2026-09-10'
    const done: string[] = []
    for (let d = historyStart; d <= today; d = addLocalDays(d, 1)) done.push(d)
    const s = summarizeHabit(daily, done, { today, tz: LONDON, historyStart, weeks: 1 })
    expect(s.currentStreak).toBe(15)
    expect(s.currentStreakIsLowerBound).toBe(true)
    expect(s.missedDays).toBe(0)
    const full = summarizeHabit(daily, done, {
      today,
      tz: LONDON,
      historyStart: '2025-01-01',
      weeks: 1,
    })
    expect(full.currentStreakIsLowerBound).toBe(false)
    // A grid longer than the loaded history would show unloaded days as missed: refuse.
    expect(() => summarizeHabit(daily, done, { today, tz: LONDON, historyStart })).toThrow(
      RangeError,
    )
  })

  it('uses the owner timezone for the start date', () => {
    // 23:30 UTC on 31 August is 00:30 on 1 September in London.
    const habit: HabitForSummary = { ...monWedFri, createdAt: at('2026-08-31T23:30:00Z') }
    const s = summarizeHabit(habit, [], { today, tz: LONDON })
    expect(s.weeks.flat().find((c) => c.date === '2026-08-31')!.state).toBe('before_start')
    const utc = summarizeHabit(habit, [], { today, tz: 'UTC' })
    expect(utc.weeks.flat().find((c) => c.date === '2026-08-31')!.state).toBe('missed')
  })

  it('does not count days after archiving as missed', () => {
    const archived: HabitForSummary = {
      ...monWedFri,
      active: false,
      archivedAt: at('2026-09-15T09:00:00Z'),
    }
    const s = summarizeHabit(archived, [], { today, tz: LONDON })
    const state = (d: string) => s.weeks.flat().find((c) => c.date === d)!.state
    expect(state('2026-09-14')).toBe('missed')
    expect(state('2026-09-16')).toBe('inactive')
  })
})
