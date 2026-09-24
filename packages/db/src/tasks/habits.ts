/**
 * public.habits and public.habit_completions access (owner transactions).
 * Completions are keyed by (habit, owner-local date), so checking a day off
 * twice, or unchecking it twice, is a no-op.
 */
import {
  CalendarDateSchema,
  HabitCreateInputSchema,
  HabitUpdateInputSchema,
  checkHabitCompletionDate,
  type HabitCreateInput,
  type HabitUpdateInput,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import {
  TASKS_NOT_FOUND,
  tasksFirstIssue,
  tasksInvalid,
  tasksIsUuid,
  type TasksInvalid,
  type TasksNotFound,
} from './shared.ts'

export interface HabitRow {
  id: string
  title: string
  details: string | null
  /** ISO weekdays, Monday = 1. */
  weekdays: number[]
  active: boolean
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface HabitCompletionRow {
  habitId: string
  localDate: string
  completedAt: Date
}

export type HabitWriteResult = { ok: true; habit: HabitRow } | TasksInvalid | TasksNotFound

/** Active habits first (oldest first), then archived ones when asked for. */
export async function listHabits(
  tx: Tx,
  options: { includeArchived?: boolean } = {},
): Promise<HabitRow[]> {
  const filter = options.includeArchived ? tx`true` : tx`active`
  return tx<HabitRow[]>`
    select * from public.habits where ${filter}
    order by active desc, created_at, id
  `
}

export async function getHabit(tx: Tx, id: string): Promise<HabitRow | null> {
  if (!tasksIsUuid(id)) return null
  const [row] = await tx<HabitRow[]>`select * from public.habits where id = ${id}::uuid`
  return row ?? null
}

export async function createHabit(tx: Tx, input: HabitCreateInput): Promise<HabitWriteResult> {
  const parsed = HabitCreateInputSchema.safeParse(input)
  if (!parsed.success) return tasksFirstIssue(parsed.error)
  const v = parsed.data
  const [habit] = await tx<HabitRow[]>`
    insert into public.habits (title, details, weekdays)
    values (${v.title}, ${v.details ?? null}, ${v.weekdays}::smallint[])
    returning *
  `
  if (!habit) throw new Error('habit insert returned no row')
  return { ok: true, habit }
}

/** Change a habit's name, details or weekdays (undefined keeps, null clears details). */
export async function updateHabit(
  tx: Tx,
  id: string,
  input: HabitUpdateInput,
): Promise<HabitWriteResult> {
  if (!tasksIsUuid(id)) return TASKS_NOT_FOUND
  const parsed = HabitUpdateInputSchema.safeParse(input)
  if (!parsed.success) return tasksFirstIssue(parsed.error)
  const v = parsed.data
  const [habit] = await tx<HabitRow[]>`
    update public.habits set
      title = coalesce(${v.title ?? null}, title),
      details = case when ${v.details !== undefined} then ${v.details ?? null} else details end,
      weekdays = coalesce(${v.weekdays ?? null}::smallint[], weekdays)
    where id = ${id}::uuid
    returning *
  `
  if (!habit) return TASKS_NOT_FOUND
  return { ok: true, habit }
}

/** Archive (hide) or restore a habit. History is kept either way. */
export async function setHabitArchived(
  tx: Tx,
  id: string,
  archived: boolean,
  now: Date,
): Promise<HabitWriteResult> {
  if (!tasksIsUuid(id)) return TASKS_NOT_FOUND
  const [habit] = archived
    ? await tx<HabitRow[]>`
        update public.habits set active = false, archived_at = coalesce(archived_at, ${now}::timestamptz)
        where id = ${id}::uuid returning *
      `
    : await tx<HabitRow[]>`
        update public.habits set active = true, archived_at = null
        where id = ${id}::uuid returning *
      `
  if (!habit) return TASKS_NOT_FOUND
  return { ok: true, habit }
}

/** Delete a habit and its completion history. */
export async function deleteHabit(tx: Tx, id: string): Promise<boolean> {
  if (!tasksIsUuid(id)) return false
  const rows = await tx`delete from public.habits where id = ${id}::uuid returning id`
  return rows.length > 0
}

export type HabitCompletionResult =
  { ok: true; done: boolean; changed: boolean } | TasksInvalid | TasksNotFound

/**
 * Mark (done = true) or unmark a habit for an owner-local date. Idempotent.
 * `today` is the owner-local date now: future dates and dates more than a year
 * back are refused, as are archived habits.
 */
export async function setHabitCompletion(
  tx: Tx,
  input: { habitId: string; localDate: string; done: boolean; today: string; now?: Date },
): Promise<HabitCompletionResult> {
  if (!tasksIsUuid(input.habitId)) return TASKS_NOT_FOUND
  if (!CalendarDateSchema.safeParse(input.today).success) throw new RangeError('invalid today')
  const check = checkHabitCompletionDate(input.localDate, input.today)
  if (!check.ok) return tasksInvalid('localDate', check.message)
  // Lock the habit row so a concurrent archive/delete cannot interleave.
  const [habit] = await tx<{ active: boolean }[]>`
    select active from public.habits where id = ${input.habitId}::uuid for update
  `
  if (!habit) return TASKS_NOT_FOUND
  if (!habit.active) return tasksInvalid('habitId', 'This habit is archived. Restore it first.')
  if (input.done) {
    const rows = await tx`
      insert into public.habit_completions (habit_id, local_date, completed_at)
      values (${input.habitId}::uuid, ${input.localDate}::date, ${input.now ?? new Date()}::timestamptz)
      on conflict (habit_id, local_date) do nothing
      returning id
    `
    return { ok: true, done: true, changed: rows.length > 0 }
  }
  const rows = await tx`
    delete from public.habit_completions
    where habit_id = ${input.habitId}::uuid and local_date = ${input.localDate}::date
    returning id
  `
  return { ok: true, done: false, changed: rows.length > 0 }
}

/**
 * Completions between two owner-local dates (inclusive), for history grids and
 * streaks. Pass `habitIds` to restrict to some habits.
 */
export async function listHabitCompletions(
  tx: Tx,
  range: { from: string; to: string; habitIds?: readonly string[] },
): Promise<HabitCompletionRow[]> {
  const from = CalendarDateSchema.parse(range.from)
  const to = CalendarDateSchema.parse(range.to)
  const habitFilter = range.habitIds
    ? tx`habit_id = any(${range.habitIds.filter(tasksIsUuid)}::uuid[])`
    : tx`true`
  return tx<HabitCompletionRow[]>`
    select habit_id, local_date, completed_at from public.habit_completions
    where local_date between ${from}::date and ${to}::date and ${habitFilter}
    order by habit_id, local_date
  `
}

/** Completion dates per habit from `fromDate` to `today` inclusive (input to core `summarizeHabit`). */
export async function habitHistory(
  tx: Tx,
  input: { today: string; fromDate: string; habitIds?: readonly string[] },
): Promise<Map<string, string[]>> {
  const rows = await listHabitCompletions(tx, {
    from: input.fromDate,
    to: input.today,
    habitIds: input.habitIds,
  })
  const out = new Map<string, string[]>()
  for (const r of rows) {
    const list = out.get(r.habitId) ?? []
    list.push(r.localDate)
    out.set(r.habitId, list)
  }
  return out
}
