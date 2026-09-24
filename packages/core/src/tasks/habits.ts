/**
 * Habits: selected ISO weekdays, completions per owner-local date, and honest
 * history. A scheduled day that passed without a completion is shown as missed;
 * it is never hidden or rolled into a flattering streak.
 */
import { z } from 'zod'
import {
  CalendarDateSchema,
  addLocalDays,
  isoWeekday,
  localDateInZone,
  localDaysBetween,
} from '../time/index.ts'
import { tasksOptionalTextSchema, tasksTitleSchema } from './text.ts'

export const HABIT_TITLE_MAX = 200
export const HABIT_DETAILS_MAX = 2000
/** Default history grid length (brief: completion and history; UI shows 8 weeks). */
export const HABIT_HISTORY_WEEKS = 8
/** How far back a completion may be recorded or removed. */
export const HABIT_BACKFILL_DAYS = 366

export const HABIT_ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
export type HabitIsoWeekday = (typeof HABIT_ISO_WEEKDAYS)[number]
export const HABIT_WEEKDAY_LABELS: Readonly<
  Record<HabitIsoWeekday, { short: string; long: string }>
> = {
  1: { short: 'Mon', long: 'Monday' },
  2: { short: 'Tue', long: 'Tuesday' },
  3: { short: 'Wed', long: 'Wednesday' },
  4: { short: 'Thu', long: 'Thursday' },
  5: { short: 'Fri', long: 'Friday' },
  6: { short: 'Sat', long: 'Saturday' },
  7: { short: 'Sun', long: 'Sunday' },
}

export const HabitTitleSchema = tasksTitleSchema(HABIT_TITLE_MAX, 'Give the habit a name')
export const HabitDetailsSchema = tasksOptionalTextSchema(HABIT_DETAILS_MAX)

/** ISO weekdays (Monday = 1), de-duplicated and sorted; at least one. */
export const HabitWeekdaysSchema = z
  .array(z.int().min(1).max(7))
  .max(7 * 4)
  .transform((days) => [...new Set(days)].sort((a, b) => a - b))
  .pipe(z.array(z.int()).min(1, { message: 'Pick at least one day' }).max(7))

export const HabitCreateInputSchema = z.object({
  title: HabitTitleSchema,
  details: HabitDetailsSchema.optional(),
  weekdays: HabitWeekdaysSchema.default([1, 2, 3, 4, 5, 6, 7]),
})
export type HabitCreateInput = z.input<typeof HabitCreateInputSchema>

export const HabitUpdateInputSchema = z.object({
  title: HabitTitleSchema.optional(),
  details: HabitDetailsSchema.optional(),
  weekdays: HabitWeekdaysSchema.optional(),
})
export type HabitUpdateInput = z.input<typeof HabitUpdateInputSchema>

/** True when the habit is scheduled on this owner-local date. */
export function isHabitDueOn(weekdays: readonly number[], localDate: string): boolean {
  return weekdays.includes(isoWeekday(localDate))
}

/** "Every day", "Weekdays", "Weekends", or "Mon, Wed, Fri". */
export function describeHabitWeekdays(weekdays: readonly number[]): string {
  const set = [...new Set(weekdays)].sort((a, b) => a - b)
  const key = set.join(',')
  if (key === '1,2,3,4,5,6,7') return 'Every day'
  if (key === '1,2,3,4,5') return 'Weekdays'
  if (key === '6,7') return 'Weekends'
  return set.map((d) => HABIT_WEEKDAY_LABELS[d as HabitIsoWeekday]?.short ?? String(d)).join(', ')
}

export type HabitCompletionDateCheck = { ok: true } | { ok: false; message: string }

/** A completion can be recorded for today or up to HABIT_BACKFILL_DAYS back, never the future. */
export function checkHabitCompletionDate(
  localDate: string,
  today: string,
): HabitCompletionDateCheck {
  if (!CalendarDateSchema.safeParse(localDate).success) {
    return { ok: false, message: 'Enter the date as YYYY-MM-DD' }
  }
  const diff = localDaysBetween(localDate, today)
  if (diff < 0) return { ok: false, message: 'You can’t check off a day that hasn’t happened yet' }
  if (diff > HABIT_BACKFILL_DAYS) {
    return { ok: false, message: `Only the last ${HABIT_BACKFILL_DAYS} days can be changed` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// History and streaks
// ---------------------------------------------------------------------------

/**
 * done         — completed that day (scheduled or not)
 * missed       — scheduled, in the past, not completed
 * pending      — scheduled today and not completed yet (not a miss until the day ends)
 * rest         — not a scheduled day
 * before_start — before the habit existed
 * inactive     — after the habit was archived
 * future       — after today
 */
export const HABIT_DAY_STATES = [
  'done',
  'missed',
  'pending',
  'rest',
  'before_start',
  'inactive',
  'future',
] as const
export type HabitDayState = (typeof HABIT_DAY_STATES)[number]

export const HABIT_DAY_STATE_LABELS: Readonly<Record<HabitDayState, string>> = {
  done: 'done',
  missed: 'missed',
  pending: 'due today, not done yet',
  rest: 'not scheduled',
  before_start: 'before this habit started',
  inactive: 'habit archived',
  future: 'upcoming',
}

export interface HabitDayCell {
  date: string
  weekday: number
  state: HabitDayState
  /** Whether the habit is scheduled on this weekday. */
  scheduled: boolean
}

export interface HabitForSummary {
  weekdays: readonly number[]
  createdAt: Date
  active: boolean
  archivedAt: Date | null
}

export interface HabitSummary {
  /** Oldest week first; each week Monday → Sunday. */
  weeks: HabitDayCell[][]
  today: HabitDayCell
  /** Consecutive scheduled days completed, ending today (or yesterday while today is pending). */
  currentStreak: number
  /** True when the streak reaches the start of the loaded history, so it may be longer. */
  currentStreakIsLowerBound: boolean
  /** Longest run within the loaded history. */
  longestStreak: number
  /** Within the grid window, up to and including today when it is already done. */
  scheduledDays: number
  completedScheduledDays: number
  missedDays: number
  /** Completions on days that were not scheduled (shown, not counted as scheduled). */
  extraCompletions: number
}

export interface HabitSummaryOptions {
  /** Owner-local today. */
  today: string
  tz: string
  weeks?: number
  /**
   * First date for which `completions` is complete (the query's lower bound).
   * Must be on or before the grid start. Streaks never look further back than
   * this. Defaults to the grid start.
   */
  historyStart?: string
}

/** Monday of the week `weeks - 1` weeks before today's week. */
export function habitGridStart(today: string, weeks: number = HABIT_HISTORY_WEEKS): string {
  return addLocalDays(today, -(isoWeekday(today) - 1) - 7 * (weeks - 1))
}

export function habitDayState(
  habit: HabitForSummary,
  completions: ReadonlySet<string>,
  date: string,
  ctx: { today: string; startDate: string; archivedDate: string | null },
): HabitDayState {
  if (completions.has(date)) return 'done'
  if (date > ctx.today) return 'future'
  if (date < ctx.startDate) return 'before_start'
  if (ctx.archivedDate && date > ctx.archivedDate) return 'inactive'
  if (!isHabitDueOn(habit.weekdays, date)) return 'rest'
  return date === ctx.today ? 'pending' : 'missed'
}

export function summarizeHabit(
  habit: HabitForSummary,
  completionDates: Iterable<string>,
  options: HabitSummaryOptions,
): HabitSummary {
  const { today, tz } = options
  const weeks = Math.max(1, Math.min(53, Math.trunc(options.weeks ?? HABIT_HISTORY_WEEKS)))
  const completions = new Set(completionDates)
  const startDate = localDateInZone(habit.createdAt, tz)
  const archivedDate =
    !habit.active && habit.archivedAt ? localDateInZone(habit.archivedAt, tz) : null
  const ctx = { today, startDate, archivedDate }
  const stateOf = (date: string) => habitDayState(habit, completions, date, ctx)
  const cell = (date: string): HabitDayCell => ({
    date,
    weekday: isoWeekday(date),
    state: stateOf(date),
    scheduled: isHabitDueOn(habit.weekdays, date),
  })

  const gridStart = habitGridStart(today, weeks)
  // Days without loaded history would otherwise look missed.
  const historyStart = options.historyStart ?? gridStart
  if (historyStart > gridStart) {
    throw new RangeError('habit history must cover the whole grid')
  }
  const grid: HabitDayCell[][] = []
  let scheduledDays = 0
  let completedScheduledDays = 0
  let missedDays = 0
  let extraCompletions = 0
  for (let w = 0; w < weeks; w++) {
    const row: HabitDayCell[] = []
    for (let d = 0; d < 7; d++) {
      const c = cell(addLocalDays(gridStart, w * 7 + d))
      row.push(c)
      if (c.state === 'done') {
        if (c.scheduled) {
          scheduledDays++
          completedScheduledDays++
        } else {
          extraCompletions++
        }
      } else if (c.state === 'missed') {
        scheduledDays++
        missedDays++
      }
    }
    grid.push(row)
  }

  // Streaks only look as far back as the history we were given.
  const lowerBound = historyStart > startDate ? historyStart : startDate

  let currentStreak = 0
  let broken = false
  for (let date = today; date >= lowerBound; date = addLocalDays(date, -1)) {
    const s = stateOf(date)
    if (s === 'missed') {
      broken = true
      break
    }
    if (s === 'done' && isHabitDueOn(habit.weekdays, date)) currentStreak++
  }
  const currentStreakIsLowerBound = !broken && currentStreak > 0 && historyStart > startDate

  let longestStreak = 0
  let run = 0
  for (let date = lowerBound; date <= today; date = addLocalDays(date, 1)) {
    const s = stateOf(date)
    if (s === 'missed') run = 0
    else if (s === 'done' && isHabitDueOn(habit.weekdays, date)) {
      run++
      if (run > longestStreak) longestStreak = run
    }
  }

  return {
    weeks: grid,
    today: cell(today),
    currentStreak,
    currentStreakIsLowerBound,
    longestStreak,
    scheduledDays,
    completedScheduledDays,
    missedDays,
    extraCompletions,
  }
}
