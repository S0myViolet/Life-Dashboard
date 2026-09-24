/**
 * Learning goals: an optional target date, an optional practice habit (the habit
 * itself — weekdays, completions — belongs to the tasks/habits area) and, for
 * reading goals, an optional book ("finish by 30 November") and/or a daily minutes
 * target ("30 min/day"), measured against the minutes in reading logs.
 */
import { z } from 'zod'
import { CalendarDateSchema, localDaysBetween } from '../time/index.ts'
import type { BookStatus } from './books.ts'
import type { ReadingProgress } from './progress.ts'

export const LEARNING_GOAL_STATUSES = ['active', 'paused', 'done'] as const
export const LearningGoalStatusSchema = z.enum(LEARNING_GOAL_STATUSES)
export type LearningGoalStatus = z.infer<typeof LearningGoalStatusSchema>

export const LEARNING_GOAL_STATUS_LABELS: Record<LearningGoalStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
}

export const LEARNING_GOAL_LIMITS = {
  titleMax: 200,
  detailsMax: 4_000,
  dailyMinutesMin: 5,
  dailyMinutesMax: 600,
  habitTitleMax: 200,
} as const

export const LearningGoalInputSchema = z.object({
  title: z.string().trim().min(1, 'Give the goal a title').max(LEARNING_GOAL_LIMITS.titleMax),
  details: z
    .string()
    .trim()
    .max(LEARNING_GOAL_LIMITS.detailsMax)
    .nullish()
    .transform((v) => (v ? v : null)),
  targetDate: CalendarDateSchema.nullish().transform((v) => v ?? null),
  status: LearningGoalStatusSchema.default('active'),
  habitId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  bookId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  dailyMinutes: z
    .number()
    .int('Minutes must be a whole number')
    .min(LEARNING_GOAL_LIMITS.dailyMinutesMin, 'At least 5 minutes a day')
    .max(LEARNING_GOAL_LIMITS.dailyMinutesMax, 'At most 600 minutes a day')
    .nullish()
    .transform((v) => v ?? null),
})
export type LearningGoalInput = z.input<typeof LearningGoalInputSchema>
export type LearningGoalFields = z.output<typeof LearningGoalInputSchema>

/** A new practice habit created from a learning goal (stored in public.habits). */
export const PracticeHabitInputSchema = z.object({
  title: z.string().trim().min(1, 'Give the habit a name').max(LEARNING_GOAL_LIMITS.habitTitleMax),
  /** ISO weekdays, Monday = 1 … Sunday = 7. */
  weekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1, 'Pick at least one day')
    .max(7)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
})
export type PracticeHabitInput = z.input<typeof PracticeHabitInputSchema>

export type LearningGoalTargetState =
  | 'no_target'
  | 'upcoming'
  | 'due_today'
  | 'overdue'
  /** Marked done, or its book is finished. */
  | 'reached'

export type LearningGoalPace =
  | { kind: 'pages'; perDay: number; pagesLeft: number; days: number }
  | { kind: 'percent'; perDay: number; percentLeft: number; days: number }

export interface LearningGoalSummaryInput {
  status: LearningGoalStatus
  targetDate: string | null
  dailyMinutes: number | null
  /** The linked book, when there is one. */
  book?: { status: BookStatus; progress: ReadingProgress } | null
  /** Minutes logged today (for the linked book, or across all books). Required for a minutes goal. */
  minutesToday?: number | null
}

export interface LearningGoalSummary {
  targetState: LearningGoalTargetState
  /** Days from today to the target date: 0 on the day, negative once it has passed. */
  daysLeft: number | null
  /** Reading needed per day (today included) to finish the linked book by the target date. */
  pace: LearningGoalPace | null
  /** Why no pace could be given for a book goal with a target date. */
  paceMissing: 'no_progress' | null
  minutes: { today: number; target: number; met: boolean } | null
}

export function learningGoalSummary(
  goal: LearningGoalSummaryInput,
  today: string,
): LearningGoalSummary {
  const reached = goal.status === 'done' || goal.book?.status === 'finished'
  const daysLeft = goal.targetDate ? localDaysBetween(today, goal.targetDate) : null

  let targetState: LearningGoalTargetState
  if (reached) targetState = 'reached'
  else if (daysLeft == null) targetState = 'no_target'
  else if (daysLeft > 0) targetState = 'upcoming'
  else if (daysLeft === 0) targetState = 'due_today'
  else targetState = 'overdue'

  let pace: LearningGoalPace | null = null
  let paceMissing: LearningGoalSummary['paceMissing'] = null
  if (!reached && goal.book && daysLeft != null && daysLeft >= 0) {
    const days = daysLeft + 1
    const p = goal.book.progress
    if (p.pagesLeft != null) {
      pace = { kind: 'pages', perDay: Math.ceil(p.pagesLeft / days), pagesLeft: p.pagesLeft, days }
    } else if (p.percent != null && !p.percentOutdated) {
      const percentLeft = Math.max(0, 100 - p.percent)
      pace = {
        kind: 'percent',
        perDay: Math.ceil((percentLeft / days) * 10 - 1e-9) / 10,
        percentLeft,
        days,
      }
    } else {
      paceMissing = 'no_progress'
    }
  }

  let minutes: LearningGoalSummary['minutes'] = null
  if (goal.dailyMinutes != null && goal.minutesToday != null) {
    minutes = {
      today: goal.minutesToday,
      target: goal.dailyMinutes,
      met: goal.minutesToday >= goal.dailyMinutes,
    }
  }

  return { targetState, daysLeft, pace, paceMissing, minutes }
}
