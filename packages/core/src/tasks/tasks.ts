/**
 * Local tasks: validation, due-date resolution in the owner's timezone,
 * overdue/today classification and status transitions.
 *
 * Due model (mirrors public.tasks):
 *   - `dueDate` is an owner-local calendar date ('YYYY-MM-DD').
 *   - `dueAt` is an explicit deadline instant, present only when the owner gave a time.
 *     Its local date in the owner's timezone equals `dueDate` when it is saved.
 * A date-only task floats with the owner's calendar ("sometime on 3 October");
 * a timed task is anchored to its instant. If the owner later changes timezone,
 * timed tasks keep their instant and are shown at the new local time.
 */
import { z } from 'zod'
import {
  CalendarDateSchema,
  WallClockTimeSchema,
  addLocalDays,
  localDateInZone,
  localTimeInZone,
  timeZoneOffsetMs,
  zonedLocalToUtc,
} from '../time/index.ts'
import { tasksOptionalTextSchema, tasksTitleSchema } from './text.ts'

const DAY_MS = 86_400_000

export const TASK_TITLE_MAX = 300
export const TASK_DETAILS_MAX = 10_000
export const TASK_DURATION_MIN_MINUTES = 5
export const TASK_DURATION_MAX_MINUTES = 720

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const
export const TaskStatusSchema = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof TaskStatusSchema>

/** 1 = highest. Null means the owner gave no explicit priority. */
export const TASK_PRIORITIES = [1, 2, 3, 4] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]
export const TaskPrioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
export const TASK_PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  1: 'P1 · Highest',
  2: 'P2 · High',
  3: 'P3 · Medium',
  4: 'P4 · Low',
}

/** Where a task came from (public.tasks.source). Inferred ones stay unconfirmed until accepted. */
export const TASK_SOURCES = [
  'manual',
  'quick_capture',
  'plan',
  'project_action',
  'email_suggestion',
  'chat_suggestion',
] as const
export const TaskSourceSchema = z.enum(TASK_SOURCES)
export type TaskSource = z.infer<typeof TaskSourceSchema>

export const TaskTitleSchema = tasksTitleSchema(TASK_TITLE_MAX, 'Give the task a title')
export const TaskDetailsSchema = tasksOptionalTextSchema(TASK_DETAILS_MAX)
export const TaskDurationSchema = z
  .number()
  .int({ message: 'Use whole minutes' })
  .min(TASK_DURATION_MIN_MINUTES, {
    message: `Duration must be ${TASK_DURATION_MIN_MINUTES}–${TASK_DURATION_MAX_MINUTES} minutes`,
  })
  .max(TASK_DURATION_MAX_MINUTES, {
    message: `Duration must be ${TASK_DURATION_MIN_MINUTES}–${TASK_DURATION_MAX_MINUTES} minutes`,
  })

/**
 * Provenance for tasks created from another source. Keys are camelCase (the db
 * client camel-cases jsonb keys on read) and links are https only.
 */
export const TaskSourceRefSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    id: z.string().min(1).max(200).optional(),
    url: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .optional(),
  })
  .strict()
export type TaskSourceRef = z.infer<typeof TaskSourceRefSchema>

const dueTimeNeedsDate = (
  v: { dueDate?: string | null; dueTime?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (v.dueTime && !v.dueDate) {
    ctx.addIssue({ code: 'custom', path: ['dueTime'], message: 'Pick a due date for this time' })
  }
}

/** A new task. Omitted optional fields are stored as "not given". */
export const TaskCreateInputSchema = z
  .object({
    title: TaskTitleSchema,
    details: TaskDetailsSchema.optional(),
    projectId: z.uuid().nullable().optional(),
    priority: TaskPrioritySchema.nullable().optional(),
    dueDate: CalendarDateSchema.nullable().optional(),
    dueTime: WallClockTimeSchema.nullable().optional(),
    durationMinutes: TaskDurationSchema.nullable().optional(),
    splittable: z.boolean().optional(),
    source: TaskSourceSchema.optional(),
    /** False for inferred suggestions that the owner has not accepted yet. */
    confirmed: z.boolean().optional(),
    sourceRef: TaskSourceRefSchema.nullable().optional(),
  })
  .superRefine(dueTimeNeedsDate)
export type TaskCreateInput = z.input<typeof TaskCreateInputSchema>
export type TaskCreateParsed = z.output<typeof TaskCreateInputSchema>

/**
 * A change to owner-editable fields. `undefined` keeps the stored value, `null`
 * clears it. The due date and time are replaced together: giving `dueDate`
 * without `dueTime` makes the task date-only.
 */
export const TaskUpdateInputSchema = z
  .object({
    title: TaskTitleSchema.optional(),
    details: TaskDetailsSchema.optional(),
    projectId: z.uuid().nullable().optional(),
    priority: TaskPrioritySchema.nullable().optional(),
    dueDate: CalendarDateSchema.nullable().optional(),
    dueTime: WallClockTimeSchema.nullable().optional(),
    durationMinutes: TaskDurationSchema.nullable().optional(),
    splittable: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.dueTime !== undefined && v.dueDate === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'Send the due date together with the due time',
      })
    }
    dueTimeNeedsDate(v, ctx)
  })
export type TaskUpdateInput = z.input<typeof TaskUpdateInputSchema>
export type TaskUpdateParsed = z.output<typeof TaskUpdateInputSchema>

// ---------------------------------------------------------------------------
// Due date/time in the owner's timezone
// ---------------------------------------------------------------------------

export interface TaskDueResolution {
  dueDate: string | null
  dueAt: Date | null
  /**
   * Set when the entered time does not exist on that date (DST spring-forward
   * gap): the local time actually saved, moved forward by the gap.
   */
  shiftedTo: string | null
  /** True when the entered time happens twice that day (DST fall-back); the first is used. */
  ambiguous: boolean
}

export type TaskDueResult = { ok: true; due: TaskDueResolution } | { ok: false; message: string }

/**
 * Turn an owner-entered due date and optional wall-clock time into the stored
 * (due_date, due_at) pair, using the owner's IANA timezone.
 */
export function resolveTaskDue(
  input: { dueDate?: string | null; dueTime?: string | null },
  tz: string,
): TaskDueResult {
  const dueDate = input.dueDate ?? null
  const dueTime = input.dueTime ?? null
  if (!dueDate) {
    if (dueTime) return { ok: false, message: 'Pick a due date for this time' }
    return { ok: true, due: { dueDate: null, dueAt: null, shiftedTo: null, ambiguous: false } }
  }
  if (!CalendarDateSchema.safeParse(dueDate).success) {
    return { ok: false, message: 'Enter the due date as YYYY-MM-DD' }
  }
  if (!dueTime) {
    return { ok: true, due: { dueDate, dueAt: null, shiftedTo: null, ambiguous: false } }
  }
  if (!WallClockTimeSchema.safeParse(dueTime).success) {
    return { ok: false, message: 'Enter the time as HH:MM' }
  }
  const at = zonedLocalToUtc(dueDate, dueTime, tz)
  const actualDate = localDateInZone(at, tz)
  const actualTime = localTimeInZone(at, tz)
  if (actualDate !== dueDate) {
    return { ok: false, message: `${dueTime} on ${dueDate} does not exist in ${tz}` }
  }
  return {
    ok: true,
    due: {
      dueDate,
      dueAt: at,
      shiftedTo: actualTime === dueTime ? null : actualTime,
      ambiguous: wallTimeIsAmbiguous(at, dueDate, dueTime, tz),
    },
  }
}

function wallTimeIsAmbiguous(at: Date, localDate: string, time: string, tz: string): boolean {
  const ms = at.getTime()
  const before = timeZoneOffsetMs(ms - DAY_MS, tz)
  const after = timeZoneOffsetMs(ms + DAY_MS, tz)
  if (before === after) return false
  for (const delta of [before - after, after - before]) {
    const other = ms + delta
    if (
      other !== ms &&
      localDateInZone(other, tz) === localDate &&
      localTimeInZone(other, tz) === time
    )
      return true
  }
  return false
}

/** The owner-local date and time to show in an edit form. */
export function taskDueFormValues(
  task: { dueDate: string | null; dueAt: Date | null },
  tz: string,
): { dueDate: string; dueTime: string } {
  if (task.dueAt) {
    return { dueDate: localDateInZone(task.dueAt, tz), dueTime: localTimeInZone(task.dueAt, tz) }
  }
  return { dueDate: task.dueDate ?? '', dueTime: '' }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Display groups for the task list, in display order. */
export const TASK_DUE_GROUPS = ['overdue', 'today', 'upcoming', 'no_date', 'done'] as const
export type TaskDueGroup = (typeof TASK_DUE_GROUPS)[number]
export const TASK_DUE_GROUP_LABELS: Readonly<Record<TaskDueGroup, string>> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  no_date: 'No date',
  done: 'Done',
}

export interface TaskDueFields {
  status: TaskStatus
  dueDate: string | null
  dueAt: Date | null
}

/**
 * Which group a task belongs to at `now` in the owner's timezone.
 *   - Closed tasks (done or cancelled) → 'done'.
 *   - Timed tasks are overdue once their instant has passed, otherwise grouped by
 *     the local date of that instant (DST-safe: no fixed 24-hour arithmetic).
 *   - Date-only tasks are overdue from the day after their due date.
 */
export function classifyTaskDue(task: TaskDueFields, now: Date, tz: string): TaskDueGroup {
  if (task.status !== 'open') return 'done'
  const today = localDateInZone(now, tz)
  if (task.dueAt) {
    if (task.dueAt.getTime() < now.getTime()) return 'overdue'
    return localDateInZone(task.dueAt, tz) === today ? 'today' : 'upcoming'
  }
  if (task.dueDate) {
    if (task.dueDate < today) return 'overdue'
    return task.dueDate === today ? 'today' : 'upcoming'
  }
  return 'no_date'
}

export function taskIsOverdue(task: TaskDueFields, now: Date, tz: string): boolean {
  return classifyTaskDue(task, now, tz) === 'overdue'
}

/**
 * Boundaries the database filters use, so SQL and `classifyTaskDue` agree:
 * `today` is the owner-local date and `tomorrowStart` the first instant of the
 * next local day (found through the timezone rules, never now + 24 h).
 */
export function taskDueWindows(now: Date, tz: string): { today: string; tomorrowStart: Date } {
  const today = localDateInZone(now, tz)
  return { today, tomorrowStart: zonedLocalToUtc(addLocalDays(today, 1), '00:00', tz) }
}

export interface TaskSortFields extends TaskDueFields {
  id: string
  priority: number | null
  createdAt: Date
  completedAt: Date | null
  updatedAt?: Date
}

const nullsLast = <T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number => {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return cmp(a, b)
}

/**
 * Open tasks: earliest due date first; on the same date timed tasks come first in
 * time order, then untimed ones; then priority (P1 first, none last); then oldest.
 */
export function compareTasksByDue(a: TaskSortFields, b: TaskSortFields): number {
  return (
    nullsLast(a.dueDate, b.dueDate, (x, y) => (x < y ? -1 : x > y ? 1 : 0)) ||
    nullsLast(a.dueAt, b.dueAt, (x, y) => x.getTime() - y.getTime()) ||
    nullsLast(a.priority, b.priority, (x, y) => x - y) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** Closed tasks: most recently completed (or closed) first. */
export function compareClosedTasks(a: TaskSortFields, b: TaskSortFields): number {
  const at = (t: TaskSortFields) => (t.completedAt ?? t.updatedAt ?? t.createdAt).getTime()
  return at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Split tasks into the display groups, each sorted for display. */
export function groupTasksByDue<T extends TaskSortFields>(
  tasks: readonly T[],
  now: Date,
  tz: string,
): Record<TaskDueGroup, T[]> {
  const groups: Record<TaskDueGroup, T[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    no_date: [],
    done: [],
  }
  for (const task of tasks) groups[classifyTaskDue(task, now, tz)].push(task)
  for (const g of TASK_DUE_GROUPS) {
    groups[g].sort(g === 'done' ? compareClosedTasks : compareTasksByDue)
  }
  return groups
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export const TASK_STATUS_ACTIONS = ['complete', 'reopen', 'cancel'] as const
export type TaskStatusAction = (typeof TASK_STATUS_ACTIONS)[number]

export type TaskStatusTransition =
  { ok: true; status: TaskStatus; changed: boolean } | { ok: false; message: string }

/**
 * Allowed moves: open → done (complete), open → cancelled (cancel), done or
 * cancelled → open (reopen). Repeating an action is a no-op, so retries and
 * double clicks are safe. A done task must be reopened before it is cancelled.
 */
export function taskStatusTransition(
  from: TaskStatus,
  action: TaskStatusAction,
): TaskStatusTransition {
  switch (action) {
    case 'complete':
      if (from === 'open') return { ok: true, status: 'done', changed: true }
      if (from === 'done') return { ok: true, status: 'done', changed: false }
      return { ok: false, message: 'This task was cancelled. Reopen it before completing it.' }
    case 'reopen':
      return { ok: true, status: 'open', changed: from !== 'open' }
    case 'cancel':
      if (from === 'open') return { ok: true, status: 'cancelled', changed: true }
      if (from === 'cancelled') return { ok: true, status: 'cancelled', changed: false }
      return { ok: false, message: 'This task is already done. Reopen it before cancelling it.' }
  }
}

// ---------------------------------------------------------------------------
// Display helpers (pure; the UI formats dates itself)
// ---------------------------------------------------------------------------

/** "45 min", "1 h", "1 h 30 min". */
export function formatTaskDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}
