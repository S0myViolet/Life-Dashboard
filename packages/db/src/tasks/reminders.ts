/**
 * public.reminders access. Owner-created reminders (custom, or attached to a
 * task) are stored and shown in the app in Milestone 1; Web Push delivery in
 * Milestone 2 reads `listDueReminders` and marks rows delivered.
 */
import {
  IanaTimeZoneSchema,
  ReminderInputSchema,
  ReminderSubjectSchema,
  nextReminderOccurrence,
  resolveReminderSchedule,
  type ReminderInput,
  type ReminderRecurrence,
  type ReminderStatus,
  type ReminderSubject,
  type ReminderSubjectKind,
  type TaskReminderPlan,
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

export interface ReminderRow {
  id: string
  title: string
  subjectKind: ReminderSubjectKind
  subjectId: string | null
  remindAt: Date
  recurrence: ReminderRecurrence | null
  recurrenceTime: string | null
  recurrenceDay: number | null
  status: ReminderStatus
  deliveredAt: Date | null
  dismissedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** A reminder plus the title of the task it belongs to (task reminders only). */
export interface ReminderListItem extends ReminderRow {
  taskTitle: string | null
}

// A task reminder only matters while its task is open. Reminders of other
// subject kinds (people, habits) are owned by those areas and always shown.
const ACTIVE_SUBJECT = (tx: Tx) => tx`(
  r.subject_kind <> 'task'
  or exists (select 1 from public.tasks t where t.id = r.subject_id and t.status = 'open')
)`

export interface ListRemindersOptions {
  /** Also return dismissed and cancelled reminders (most recent first after the active ones). */
  includeClosed?: boolean
  limit?: number
}

/**
 * Active reminders (scheduled or delivered), soonest first, excluding reminders
 * of tasks that are no longer open.
 */
export async function listReminders(
  tx: Tx,
  options: ListRemindersOptions = {},
): Promise<ReminderListItem[]> {
  const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 200)))
  const statusFilter = options.includeClosed ? tx`true` : tx`r.status in ('scheduled', 'delivered')`
  return tx<ReminderListItem[]>`
    select r.*, t.title as task_title
    from public.reminders r
    left join public.tasks t on r.subject_kind = 'task' and t.id = r.subject_id
    where ${statusFilter} and ${ACTIVE_SUBJECT(tx)}
    order by case when r.status in ('scheduled', 'delivered') then 0 else 1 end,
             r.remind_at, r.id
    limit ${limit}
  `
}

/** Reminders whose time has come and that are not dismissed yet (in-app now, push in M2). */
export async function listDueReminders(
  tx: Tx,
  now: Date,
  limit = 200,
): Promise<ReminderListItem[]> {
  const n = Math.min(1000, Math.max(1, Math.trunc(limit)))
  return tx<ReminderListItem[]>`
    select r.*, t.title as task_title
    from public.reminders r
    left join public.tasks t on r.subject_kind = 'task' and t.id = r.subject_id
    where r.status in ('scheduled', 'delivered')
      and r.remind_at <= ${now}::timestamptz
      and ${ACTIVE_SUBJECT(tx)}
    order by r.remind_at, r.id
    limit ${n}
  `
}

export async function getReminder(tx: Tx, id: string): Promise<ReminderRow | null> {
  if (!tasksIsUuid(id)) return null
  const [row] = await tx<ReminderRow[]>`select * from public.reminders where id = ${id}::uuid`
  return row ?? null
}

/** Active reminders of these tasks, keyed by task id (soonest first). */
export async function listTaskReminders(
  tx: Tx,
  taskIds: readonly string[],
): Promise<Map<string, ReminderRow[]>> {
  const ids = taskIds.filter(tasksIsUuid)
  const out = new Map<string, ReminderRow[]>()
  if (ids.length === 0) return out
  const rows = await tx<ReminderRow[]>`
    select * from public.reminders
    where subject_kind = 'task' and subject_id = any(${ids}::uuid[])
      and status in ('scheduled', 'delivered')
    order by remind_at, id
  `
  for (const row of rows) {
    const list = out.get(row.subjectId!) ?? []
    list.push(row)
    out.set(row.subjectId!, list)
  }
  return out
}

export interface ReminderWriteContext {
  now: Date
  tz: string
}

export type ReminderWriteResult =
  { ok: true; reminder: ReminderRow; shiftedTo: string | null } | TasksInvalid | TasksNotFound

async function subjectProblem(tx: Tx, subject: ReminderSubject): Promise<TasksInvalid | null> {
  if (subject.kind !== 'task') return null
  const [row] = await tx<{ status: string }[]>`
    select status from public.tasks where id = ${subject.id}::uuid
  `
  if (!row) return tasksInvalid('subject', 'That task no longer exists')
  if (row.status !== 'open') return tasksInvalid('subject', 'That task is already closed')
  return null
}

/** Create an owner reminder (custom by default). */
export async function createReminder(
  tx: Tx,
  input: ReminderInput,
  ctx: ReminderWriteContext & { subject?: ReminderSubject },
): Promise<ReminderWriteResult> {
  const tz = IanaTimeZoneSchema.parse(ctx.tz)
  const parsed = ReminderInputSchema.safeParse(input)
  if (!parsed.success) return tasksFirstIssue(parsed.error)
  const subjectParsed = ReminderSubjectSchema.safeParse(ctx.subject ?? { kind: 'custom', id: null })
  if (!subjectParsed.success) return tasksFirstIssue(subjectParsed.error)
  const subject = subjectParsed.data
  const problem = await subjectProblem(tx, subject)
  if (problem) return problem
  const v = parsed.data
  const r = resolveReminderSchedule(v, ctx.now, tz)
  if (!r.ok) return tasksInvalid(r.field, r.message)
  const s = r.schedule
  const [reminder] = await tx<ReminderRow[]>`
    insert into public.reminders (
      title, subject_kind, subject_id, remind_at, recurrence, recurrence_time, recurrence_day
    ) values (
      ${v.title}, ${subject.kind}, ${subject.id}::uuid, ${s.remindAt}::timestamptz,
      ${s.recurrence}, ${s.recurrenceTime}, ${s.recurrenceDay}
    )
    returning *
  `
  if (!reminder) throw new Error('reminder insert returned no row')
  return { ok: true, reminder, shiftedTo: s.shiftedTo }
}

/** Replace a reminder's title and schedule; it becomes scheduled again. */
export async function updateReminder(
  tx: Tx,
  id: string,
  input: ReminderInput,
  ctx: ReminderWriteContext,
): Promise<ReminderWriteResult> {
  const tz = IanaTimeZoneSchema.parse(ctx.tz)
  if (!tasksIsUuid(id)) return TASKS_NOT_FOUND
  const parsed = ReminderInputSchema.safeParse(input)
  if (!parsed.success) return tasksFirstIssue(parsed.error)
  const v = parsed.data
  const r = resolveReminderSchedule(v, ctx.now, tz)
  if (!r.ok) return tasksInvalid(r.field, r.message)
  const s = r.schedule
  const [reminder] = await tx<ReminderRow[]>`
    update public.reminders set
      title = ${v.title},
      remind_at = ${s.remindAt}::timestamptz,
      recurrence = ${s.recurrence},
      recurrence_time = ${s.recurrenceTime},
      recurrence_day = ${s.recurrenceDay},
      status = 'scheduled',
      delivered_at = null,
      dismissed_at = null
    where id = ${id}::uuid
    returning *
  `
  if (!reminder) return TASKS_NOT_FOUND
  return { ok: true, reminder, shiftedTo: s.shiftedTo }
}

export async function deleteReminder(tx: Tx, id: string): Promise<boolean> {
  if (!tasksIsUuid(id)) return false
  const rows = await tx`delete from public.reminders where id = ${id}::uuid returning id`
  return rows.length > 0
}

export type ReminderDismissResult =
  { ok: true; reminder: ReminderRow; changed: boolean; advancedTo: Date | null } | TasksNotFound

/**
 * Dismiss a reminder. A recurring one moves to its next occurrence after `now`
 * (missed occurrences are skipped, not replayed) and stays scheduled; a one-off
 * becomes dismissed. Dismissing a dismissed/cancelled reminder changes nothing.
 */
export async function dismissReminder(
  tx: Tx,
  id: string,
  ctx: ReminderWriteContext,
): Promise<ReminderDismissResult> {
  const tz = IanaTimeZoneSchema.parse(ctx.tz)
  if (!tasksIsUuid(id)) return TASKS_NOT_FOUND
  const [current] = await tx<ReminderRow[]>`
    select * from public.reminders where id = ${id}::uuid for update
  `
  if (!current) return TASKS_NOT_FOUND
  if (current.status === 'dismissed' || current.status === 'cancelled') {
    return { ok: true, reminder: current, changed: false, advancedTo: null }
  }
  if (current.recurrence) {
    const after = current.remindAt.getTime() > ctx.now.getTime() ? current.remindAt : ctx.now
    const next = nextReminderOccurrence(
      {
        remindAt: current.remindAt,
        recurrence: current.recurrence,
        recurrenceTime: current.recurrenceTime,
        recurrenceDay: current.recurrenceDay,
      },
      after,
      tz,
    )
    const [reminder] = await tx<ReminderRow[]>`
      update public.reminders set
        remind_at = ${next}::timestamptz,
        status = 'scheduled',
        delivered_at = null,
        dismissed_at = ${ctx.now}::timestamptz
      where id = ${id}::uuid
      returning *
    `
    if (!reminder) return TASKS_NOT_FOUND
    return { ok: true, reminder, changed: true, advancedTo: next }
  }
  const [reminder] = await tx<ReminderRow[]>`
    update public.reminders set status = 'dismissed', dismissed_at = ${ctx.now}::timestamptz
    where id = ${id}::uuid
    returning *
  `
  if (!reminder) return TASKS_NOT_FOUND
  return { ok: true, reminder, changed: true, advancedTo: null }
}

/**
 * Apply the reminder choice from the task form. A task has at most one active
 * reminder managed by the form: setting one replaces the active ones, clearing
 * removes them, keep leaves them. Returns the task's active reminder afterwards.
 */
export async function applyTaskReminderPlan(
  tx: Tx,
  task: { id: string; title: string },
  plan: TaskReminderPlan,
): Promise<ReminderRow | null> {
  if (plan.kind === 'keep') {
    const [row] = await tx<ReminderRow[]>`
      select * from public.reminders
      where subject_kind = 'task' and subject_id = ${task.id}::uuid
        and status in ('scheduled', 'delivered')
      order by remind_at, id
      limit 1
    `
    return row ?? null
  }
  await tx`
    delete from public.reminders
    where subject_kind = 'task' and subject_id = ${task.id}::uuid
      and status in ('scheduled', 'delivered')
  `
  if (plan.kind === 'clear') return null
  const [row] = await tx<ReminderRow[]>`
    insert into public.reminders (title, subject_kind, subject_id, remind_at)
    values (${task.title}, 'task', ${task.id}::uuid, ${plan.remindAt}::timestamptz)
    returning *
  `
  return row ?? null
}
