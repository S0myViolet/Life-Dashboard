/**
 * Owner-created reminders: schedule validation in the owner's timezone,
 * DST-safe recurrence, and reminders attached to tasks.
 *
 * Milestone 1 shows due reminders in the app; Web Push delivery (Milestone 2)
 * reads the same rows. Recurring reminders keep their wall-clock time and
 * day-of-month anchor (`recurrenceTime`, `recurrenceDay`), so "09:00 on the
 * 31st" stays 09:00 across DST changes and returns to the 31st after a short month.
 */
import { z } from 'zod'
import {
  CalendarDateSchema,
  WallClockTimeSchema,
  addLocalDays,
  localDateInZone,
  localDaysBetween,
  localTimeInZone,
  zonedLocalToUtc,
} from '../time/index.ts'
import { tasksTitleSchema } from './text.ts'

export const REMINDER_TITLE_MAX = 300
/** Reminders further ahead than this are almost certainly typos. */
export const REMINDER_MAX_AHEAD_DAYS = 3660

export const REMINDER_RECURRENCES = ['daily', 'weekly', 'monthly', 'yearly'] as const
export const ReminderRecurrenceSchema = z.enum(REMINDER_RECURRENCES)
export type ReminderRecurrence = z.infer<typeof ReminderRecurrenceSchema>
export const REMINDER_RECURRENCE_LABELS: Readonly<Record<ReminderRecurrence, string>> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
}

export const REMINDER_STATUSES = ['scheduled', 'delivered', 'dismissed', 'cancelled'] as const
export const ReminderStatusSchema = z.enum(REMINDER_STATUSES)
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>

export const REMINDER_SUBJECT_KINDS = ['custom', 'task', 'person', 'habit'] as const
export const ReminderSubjectKindSchema = z.enum(REMINDER_SUBJECT_KINDS)
export type ReminderSubjectKind = z.infer<typeof ReminderSubjectKindSchema>

export const ReminderTitleSchema = tasksTitleSchema(
  REMINDER_TITLE_MAX,
  'Say what to remind you about',
)

/** Owner input for a reminder: a local date and time in the owner's timezone. */
export const ReminderInputSchema = z.object({
  title: ReminderTitleSchema,
  date: CalendarDateSchema,
  time: WallClockTimeSchema,
  recurrence: ReminderRecurrenceSchema.nullable().optional(),
})
export type ReminderInput = z.input<typeof ReminderInputSchema>

/** What to attach a reminder to. `custom` reminders have no subject. */
export const ReminderSubjectSchema = z
  .object({ kind: ReminderSubjectKindSchema, id: z.uuid().nullable() })
  .refine((s) => (s.kind === 'custom') === (s.id === null), {
    message: 'Custom reminders have no subject; other kinds need one',
  })
export type ReminderSubject = z.infer<typeof ReminderSubjectSchema>

export interface ReminderSchedule {
  remindAt: Date
  recurrence: ReminderRecurrence | null
  /** Wall-clock 'HH:MM' the reminder recurs at (recurring only). */
  recurrenceTime: string | null
  /** Day-of-month anchor (monthly/yearly only). */
  recurrenceDay: number | null
  /** Set when the entered time fell in a DST gap and was moved forward. */
  shiftedTo: string | null
}

export type ReminderScheduleResult =
  { ok: true; schedule: ReminderSchedule } | { ok: false; field: 'date' | 'time'; message: string }

function dayOfMonth(localDate: string): number {
  return Number(localDate.slice(8, 10))
}

/**
 * Validate an owner-entered reminder time.
 *   - The date/time must exist in the owner's timezone (a DST-gap time moves forward).
 *   - One-off reminders must be in the future.
 *   - A recurring reminder whose first time has passed starts at its next occurrence.
 *   - Nothing more than REMINDER_MAX_AHEAD_DAYS ahead.
 */
export function resolveReminderSchedule(
  input: { date: string; time: string; recurrence?: ReminderRecurrence | null },
  now: Date,
  tz: string,
): ReminderScheduleResult {
  if (!CalendarDateSchema.safeParse(input.date).success) {
    return { ok: false, field: 'date', message: 'Enter the date as YYYY-MM-DD' }
  }
  if (!WallClockTimeSchema.safeParse(input.time).success) {
    return { ok: false, field: 'time', message: 'Enter the time as HH:MM' }
  }
  const recurrence = input.recurrence ?? null
  let remindAt = zonedLocalToUtc(input.date, input.time, tz)
  if (localDateInZone(remindAt, tz) !== input.date) {
    return {
      ok: false,
      field: 'time',
      message: `${input.time} on ${input.date} does not exist in ${tz}`,
    }
  }
  const actualTime = localTimeInZone(remindAt, tz)
  const recurrenceTime = recurrence ? input.time : null
  const recurrenceDay =
    recurrence === 'monthly' || recurrence === 'yearly' ? dayOfMonth(input.date) : null

  if (remindAt.getTime() <= now.getTime()) {
    if (!recurrence) {
      return { ok: false, field: 'time', message: 'That time has already passed' }
    }
    remindAt = nextReminderOccurrence(
      { remindAt, recurrence, recurrenceTime, recurrenceDay },
      now,
      tz,
    )
  }
  const today = localDateInZone(now, tz)
  if (localDaysBetween(today, localDateInZone(remindAt, tz)) > REMINDER_MAX_AHEAD_DAYS) {
    return { ok: false, field: 'date', message: 'Pick a date within the next ten years' }
  }
  return {
    ok: true,
    schedule: {
      remindAt,
      recurrence,
      recurrenceTime,
      recurrenceDay,
      shiftedTo: actualTime === input.time ? null : actualTime,
    },
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

interface RecurringReminder {
  remindAt: Date
  recurrence: ReminderRecurrence
  recurrenceTime?: string | null
  recurrenceDay?: number | null
}

/**
 * The first occurrence after the current one (k ≥ 1) that is strictly later
 * than `after`. Occurrences are computed from the current `remindAt` in owner-local
 * calendar terms (days, weeks, months, years), never fixed millisecond steps, so
 * they keep their wall-clock time across DST changes. Missed occurrences are
 * skipped rather than replayed.
 */
export function nextReminderOccurrence(reminder: RecurringReminder, after: Date, tz: string): Date {
  const startDate = localDateInZone(reminder.remindAt, tz)
  const time =
    reminder.recurrenceTime && WallClockTimeSchema.safeParse(reminder.recurrenceTime).success
      ? reminder.recurrenceTime
      : localTimeInZone(reminder.remindAt, tz)
  const startYear = Number(startDate.slice(0, 4))
  const startMonth = Number(startDate.slice(5, 7))
  const anchorDay =
    reminder.recurrenceDay && reminder.recurrenceDay >= 1 && reminder.recurrenceDay <= 31
      ? reminder.recurrenceDay
      : dayOfMonth(startDate)

  const dateOf = (k: number): string => {
    switch (reminder.recurrence) {
      case 'daily':
        return addLocalDays(startDate, k)
      case 'weekly':
        return addLocalDays(startDate, 7 * k)
      case 'monthly': {
        const index = startYear * 12 + (startMonth - 1) + k
        const y = Math.floor(index / 12)
        const m = (index % 12) + 1
        return `${pad(y, 4)}-${pad(m)}-${pad(Math.min(anchorDay, daysInMonth(y, m)))}`
      }
      case 'yearly': {
        const y = startYear + k
        return `${pad(y, 4)}-${pad(startMonth)}-${pad(Math.min(anchorDay, daysInMonth(y, startMonth)))}`
      }
    }
  }

  // Jump close to `after` instead of stepping through a long backlog.
  const afterDate = localDateInZone(after, tz)
  let k = 1
  const days = localDaysBetween(startDate, afterDate)
  if (days > 2) {
    const estimate = (() => {
      switch (reminder.recurrence) {
        case 'daily':
          return days - 1
        case 'weekly':
          return Math.floor(days / 7) - 1
        case 'monthly':
          return (
            (Number(afterDate.slice(0, 4)) - startYear) * 12 +
            (Number(afterDate.slice(5, 7)) - startMonth) -
            1
          )
        case 'yearly':
          return Number(afterDate.slice(0, 4)) - startYear - 1
      }
    })()
    k = Math.max(1, estimate)
  }
  for (let guard = 0; guard < 1000; guard++, k++) {
    const at = zonedLocalToUtc(dateOf(k), time, tz)
    if (at.getTime() > after.getTime()) return at
  }
  throw new Error('no next reminder occurrence found')
}

/** Scheduled or delivered-but-not-dismissed, and its time has come. */
export function reminderIsDue(
  reminder: { status: ReminderStatus; remindAt: Date },
  now: Date,
): boolean {
  return (
    (reminder.status === 'scheduled' || reminder.status === 'delivered') &&
    reminder.remindAt.getTime() <= now.getTime()
  )
}

// ---------------------------------------------------------------------------
// Reminders attached to tasks
// ---------------------------------------------------------------------------

/**
 * The reminder field on the task form.
 *   none   — no reminder (removes a scheduled one)
 *   keep   — leave the task's current reminder as it is (edit form default)
 *   at_due / 15m / 1h / 1d — relative to the task's due time
 *   custom — a specific date and time
 */
export const TASK_REMINDER_CHOICES = [
  'none',
  'keep',
  'at_due',
  '15m',
  '1h',
  '1d',
  'custom',
] as const
export const TaskReminderChoiceSchema = z.enum(TASK_REMINDER_CHOICES)
export type TaskReminderChoice = z.infer<typeof TaskReminderChoiceSchema>
export const TASK_REMINDER_CHOICE_LABELS: Readonly<Record<TaskReminderChoice, string>> = {
  none: 'No reminder',
  keep: 'Keep current reminder',
  at_due: 'At the due time',
  '15m': '15 minutes before',
  '1h': '1 hour before',
  '1d': '1 day before',
  custom: 'At a date and time…',
}

export type TaskReminderPlan =
  { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; remindAt: Date; shiftedTo: string | null }

export type TaskReminderResult =
  | { ok: true; plan: TaskReminderPlan }
  | { ok: false; field: 'reminder' | 'reminderDate' | 'reminderTime'; message: string }

/**
 * Work out a task's reminder from the form choice and the task's (already
 * resolved) due instant. Relative choices need a due time. "1 day before" is the
 * same local time on the previous day, so it stays correct across DST changes.
 */
export function resolveTaskReminder(
  input: {
    choice: TaskReminderChoice
    date?: string | null
    time?: string | null
    dueAt: Date | null
  },
  now: Date,
  tz: string,
): TaskReminderResult {
  const { choice, dueAt } = input
  if (choice === 'none') return { ok: true, plan: { kind: 'clear' } }
  if (choice === 'keep') return { ok: true, plan: { kind: 'keep' } }

  let remindAt: Date
  let shiftedTo: string | null = null
  if (choice === 'custom') {
    if (!input.date) return { ok: false, field: 'reminderDate', message: 'Pick a reminder date' }
    if (!input.time) return { ok: false, field: 'reminderTime', message: 'Pick a reminder time' }
    const r = resolveReminderSchedule({ date: input.date, time: input.time }, now, tz)
    if (!r.ok) {
      return {
        ok: false,
        field: r.field === 'date' ? 'reminderDate' : 'reminderTime',
        message: r.message,
      }
    }
    remindAt = r.schedule.remindAt
    shiftedTo = r.schedule.shiftedTo
  } else {
    if (!dueAt) {
      return {
        ok: false,
        field: 'reminder',
        message: 'Add a due time to be reminded relative to it, or choose a date and time',
      }
    }
    if (choice === '1d') {
      const date = addLocalDays(localDateInZone(dueAt, tz), -1)
      remindAt = zonedLocalToUtc(date, localTimeInZone(dueAt, tz), tz)
    } else {
      const minutes = choice === 'at_due' ? 0 : choice === '15m' ? 15 : 60
      remindAt = new Date(dueAt.getTime() - minutes * 60_000)
    }
    if (remindAt.getTime() <= now.getTime()) {
      return { ok: false, field: 'reminder', message: 'That reminder time has already passed' }
    }
  }
  return { ok: true, plan: { kind: 'set', remindAt, shiftedTo } }
}
