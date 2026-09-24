import { describe, expect, it } from 'vitest'
import {
  LearningGoalInputSchema,
  learningGoalSummary,
  PracticeHabitInputSchema,
  readingProgress,
  type ReadingProgress,
} from '../src/index.ts'

const today = '2026-09-24'

function progressAt(totalPages: number | null, fields: { pageReached?: number; percent?: number }) {
  return readingProgress({ totalPages, status: 'reading' }, [
    {
      localDate: '2026-09-20',
      pageReached: fields.pageReached ?? null,
      pagesRead: null,
      percent: fields.percent ?? null,
      minutes: null,
    },
  ])
}

describe('learningGoalSummary — target dates', () => {
  it('classifies the target date relative to today', () => {
    const base = { status: 'active' as const, dailyMinutes: null }
    expect(learningGoalSummary({ ...base, targetDate: null }, today).targetState).toBe('no_target')
    expect(learningGoalSummary({ ...base, targetDate: '2026-10-01' }, today)).toMatchObject({
      targetState: 'upcoming',
      daysLeft: 7,
    })
    expect(learningGoalSummary({ ...base, targetDate: today }, today)).toMatchObject({
      targetState: 'due_today',
      daysLeft: 0,
    })
    expect(learningGoalSummary({ ...base, targetDate: '2026-09-20' }, today)).toMatchObject({
      targetState: 'overdue',
      daysLeft: -4,
    })
  })

  it('a done goal or a finished book has reached its target, even past the date', () => {
    expect(
      learningGoalSummary({ status: 'done', targetDate: '2026-09-01', dailyMinutes: null }, today)
        .targetState,
    ).toBe('reached')
    const finished = readingProgress({ totalPages: 100, status: 'finished' }, [])
    const s = learningGoalSummary(
      {
        status: 'active',
        targetDate: '2026-09-01',
        dailyMinutes: null,
        book: { status: 'finished', progress: finished },
      },
      today,
    )
    expect(s.targetState).toBe('reached')
    expect(s.pace).toBeNull()
  })
})

describe('learningGoalSummary — finish-by-date pace', () => {
  it('pages per day, today included, rounded up', () => {
    // 300-page book at page 100, target in 9 days → 10 reading days, 200 pages → 20/day.
    const s = learningGoalSummary(
      {
        status: 'active',
        targetDate: '2026-10-03',
        dailyMinutes: null,
        book: { status: 'reading', progress: progressAt(300, { pageReached: 100 }) },
      },
      today,
    )
    expect(s.pace).toEqual({ kind: 'pages', perDay: 20, pagesLeft: 200, days: 10 })

    const odd = learningGoalSummary(
      {
        status: 'active',
        targetDate: '2026-09-26',
        dailyMinutes: null,
        book: { status: 'reading', progress: progressAt(300, { pageReached: 100 }) },
      },
      today,
    )
    expect(odd.pace).toEqual({ kind: 'pages', perDay: 67, pagesLeft: 200, days: 3 })
  })

  it('on the target day, everything left is due today', () => {
    const s = learningGoalSummary(
      {
        status: 'active',
        targetDate: today,
        dailyMinutes: null,
        book: { status: 'reading', progress: progressAt(120, { pageReached: 100 }) },
      },
      today,
    )
    expect(s.pace).toEqual({ kind: 'pages', perDay: 20, pagesLeft: 20, days: 1 })
  })

  it('uses percent per day when only a percentage is known', () => {
    const s = learningGoalSummary(
      {
        status: 'active',
        targetDate: '2026-09-27',
        dailyMinutes: null,
        book: { status: 'reading', progress: progressAt(null, { percent: 50 }) },
      },
      today,
    )
    expect(s.pace).toEqual({ kind: 'percent', perDay: 12.5, percentLeft: 50, days: 4 })
  })

  it('gives no pace — and says why — when progress cannot be measured', () => {
    const unknown: ReadingProgress = progressAt(null, { pageReached: 40 })
    const s = learningGoalSummary(
      {
        status: 'active',
        targetDate: '2026-10-24',
        dailyMinutes: null,
        book: { status: 'reading', progress: unknown },
      },
      today,
    )
    expect(s.pace).toBeNull()
    expect(s.paceMissing).toBe('no_progress')
  })

  it('gives no pace once the date has passed', () => {
    const s = learningGoalSummary(
      {
        status: 'active',
        targetDate: '2026-09-23',
        dailyMinutes: null,
        book: { status: 'reading', progress: progressAt(300, { pageReached: 100 }) },
      },
      today,
    )
    expect(s.targetState).toBe('overdue')
    expect(s.pace).toBeNull()
  })
})

describe('learningGoalSummary — minutes per day', () => {
  it('compares minutes logged today with the daily target', () => {
    const base = { status: 'active' as const, targetDate: null, dailyMinutes: 30 }
    expect(learningGoalSummary({ ...base, minutesToday: 20 }, today).minutes).toEqual({
      today: 20,
      target: 30,
      met: false,
    })
    expect(learningGoalSummary({ ...base, minutesToday: 30 }, today).minutes?.met).toBe(true)
    // No measurement supplied → no claim either way.
    expect(learningGoalSummary(base, today).minutes).toBeNull()
  })
})

describe('schemas', () => {
  it('validates learning goals', () => {
    expect(LearningGoalInputSchema.safeParse({ title: '' }).success).toBe(false)
    expect(LearningGoalInputSchema.parse({ title: ' Arabic ', details: '' })).toMatchObject({
      title: 'Arabic',
      details: null,
      status: 'active',
      habitId: null,
      bookId: null,
      targetDate: null,
      dailyMinutes: null,
    })
    expect(LearningGoalInputSchema.safeParse({ title: 'x', dailyMinutes: 4 }).success).toBe(false)
    expect(LearningGoalInputSchema.safeParse({ title: 'x', habitId: 'nope' }).success).toBe(false)
    expect(
      LearningGoalInputSchema.safeParse({ title: 'x', targetDate: '2027-02-29' }).success,
    ).toBe(false)
  })

  it('normalises practice-habit weekdays', () => {
    expect(
      PracticeHabitInputSchema.parse({ title: 'Read', weekdays: [5, 1, 1, 3] }).weekdays,
    ).toEqual([1, 3, 5])
    expect(PracticeHabitInputSchema.safeParse({ title: 'Read', weekdays: [] }).success).toBe(false)
    expect(PracticeHabitInputSchema.safeParse({ title: 'Read', weekdays: [0] }).success).toBe(false)
  })
})
