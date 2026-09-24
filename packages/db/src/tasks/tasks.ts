/**
 * public.tasks access. Owner transactions (withOwner, RLS enforced) for user
 * reads/writes; service transactions work too for trusted jobs.
 *
 * Input is validated here with the core schemas even when the caller already
 * did, so every write path gets the same rules. Expected problems (invalid
 * input, missing rows) are returned as values; only bugs throw.
 */
import {
  IanaTimeZoneSchema,
  TaskCreateInputSchema,
  TaskUpdateInputSchema,
  resolveTaskDue,
  resolveTaskReminder,
  taskDueWindows,
  taskStatusTransition,
  type TaskCreateInput,
  type TaskDueResolution,
  type TaskPriority,
  type TaskReminderChoice,
  type TaskSource,
  type TaskStatus,
  type TaskStatusAction,
  type TaskUpdateInput,
} from '@personal-home/core'
import type postgres from 'postgres'
import type { Tx } from '../client.ts'
import { applyTaskReminderPlan, type ReminderRow } from './reminders.ts'
import {
  TASKS_NOT_FOUND,
  tasksFirstIssue,
  tasksInvalid,
  tasksIsUuid,
  type TasksInvalid,
  type TasksNotFound,
} from './shared.ts'

export interface TaskRow {
  id: string
  title: string
  details: string | null
  projectId: string | null
  status: TaskStatus
  priority: TaskPriority | null
  dueDate: string | null
  dueAt: Date | null
  durationMinutes: number | null
  splittable: boolean
  source: TaskSource
  confirmed: boolean
  sourceRef: Record<string, unknown> | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Owner timezone and project options
// ---------------------------------------------------------------------------

/**
 * The owner's saved IANA timezone, or null when the caller cannot see the
 * settings row (not the owner) or it holds a name this runtime cannot use.
 */
export async function tasksOwnerTimeZone(tx: Tx): Promise<string | null> {
  const [row] = await tx<{ timezone: string }[]>`select timezone from public.owner_settings`
  if (!row) return null
  return IanaTimeZoneSchema.safeParse(row.timezone).success ? row.timezone : null
}

export interface TaskProjectOption {
  id: string
  name: string
  status: string
}

async function projectsTablePresent(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ present: boolean }[]>`
    select to_regclass('public.projects') is not null as present
  `
  return row?.present === true
}

/**
 * Projects a task can belong to. public.projects is created by the capture
 * area; until it exists there are no options (never an error).
 */
export async function listTaskProjectOptions(tx: Tx): Promise<TaskProjectOption[]> {
  if (!(await projectsTablePresent(tx))) return []
  return tx<TaskProjectOption[]>`
    select id, name, status from public.projects
    order by case status when 'active' then 0 when 'paused' then 1 else 2 end, lower(name), id
  `
}

export async function tasksProjectExists(tx: Tx, projectId: string): Promise<boolean> {
  if (!tasksIsUuid(projectId) || !(await projectsTablePresent(tx))) return false
  const [row] = await tx<{ ok: boolean }[]>`
    select exists (select 1 from public.projects where id = ${projectId}::uuid) as ok
  `
  return row?.ok === true
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const TASK_LIST_FILTERS = [
  'open',
  'today',
  'overdue',
  'upcoming',
  'no_date',
  'done',
] as const
export type TaskListFilter = (typeof TASK_LIST_FILTERS)[number]

export interface ListTasksOptions {
  /** Default 'open'. 'done' also returns cancelled tasks (most recently closed first). */
  filter?: TaskListFilter
  /** Required for 'today', 'overdue' and 'upcoming'. */
  now?: Date
  tz?: string
  /** Only tasks in this project (null = only tasks without a project). */
  projectId?: string | null
  /** Unaccepted suggestions are left out unless asked for. */
  includeUnconfirmed?: boolean
  /** Default 500 (open filters) / 50 (done); at most 1000. */
  limit?: number
}

/**
 * List tasks. Date filters use the owner's timezone and agree with
 * core `classifyTaskDue`: timed tasks by their instant, date-only tasks by date.
 */
export async function listTasks(tx: Tx, options: ListTasksOptions = {}): Promise<TaskRow[]> {
  const filter = options.filter ?? 'open'
  const limit = Math.min(
    1000,
    Math.max(1, Math.trunc(options.limit ?? (filter === 'done' ? 50 : 500))),
  )
  const conditions: postgres.Fragment[] = []

  if (filter === 'done') conditions.push(tx`status in ('done', 'cancelled')`)
  else conditions.push(tx`status = 'open'`)
  if (!options.includeUnconfirmed) conditions.push(tx`confirmed`)

  if (filter === 'today' || filter === 'overdue' || filter === 'upcoming') {
    if (!options.now || !options.tz)
      throw new Error(`listTasks: filter '${filter}' needs now and tz`)
    const now = options.now
    const { today, tomorrowStart } = taskDueWindows(now, IanaTimeZoneSchema.parse(options.tz))
    if (filter === 'overdue') {
      conditions.push(tx`(
        (due_at is not null and due_at < ${now}::timestamptz)
        or (due_at is null and due_date < ${today}::date)
      )`)
    } else if (filter === 'today') {
      conditions.push(tx`(
        (due_at is not null and due_at >= ${now}::timestamptz and due_at < ${tomorrowStart}::timestamptz)
        or (due_at is null and due_date = ${today}::date)
      )`)
    } else {
      conditions.push(tx`(
        (due_at is not null and due_at >= ${tomorrowStart}::timestamptz)
        or (due_at is null and due_date > ${today}::date)
      )`)
    }
  } else if (filter === 'no_date') {
    conditions.push(tx`due_date is null`)
  }

  if (options.projectId !== undefined) {
    if (options.projectId === null) conditions.push(tx`project_id is null`)
    else if (!tasksIsUuid(options.projectId)) return []
    else conditions.push(tx`project_id = ${options.projectId}::uuid`)
  }

  const where = conditions.reduce((acc, c) => tx`${acc} and ${c}`)
  if (filter === 'done') {
    return tx<TaskRow[]>`
      select * from public.tasks where ${where}
      order by coalesce(completed_at, updated_at) desc, id
      limit ${limit}
    `
  }
  return tx<TaskRow[]>`
    select * from public.tasks where ${where}
    order by due_date asc nulls last, due_at asc nulls last, priority asc nulls last, created_at, id
    limit ${limit}
  `
}

export async function getTask(tx: Tx, id: string): Promise<TaskRow | null> {
  if (!tasksIsUuid(id)) return null
  const [row] = await tx<TaskRow[]>`select * from public.tasks where id = ${id}::uuid`
  return row ?? null
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface TaskReminderInput {
  choice: TaskReminderChoice
  /** For 'custom': owner-local date and time. */
  date?: string | null
  time?: string | null
}

export interface TaskWriteContext {
  /** The owner's IANA timezone: due and reminder times are entered in it. */
  tz: string
  now: Date
  /** Omit to leave reminders untouched. */
  reminder?: TaskReminderInput
}

export type TaskWriteResult =
  | { ok: true; task: TaskRow; due: TaskDueResolution; reminder: ReminderRow | null }
  | TasksInvalid
  | TasksNotFound

async function checkProject(
  tx: Tx,
  projectId: string | null | undefined,
): Promise<TasksInvalid | null> {
  if (!projectId) return null
  if (await tasksProjectExists(tx, projectId)) return null
  return tasksInvalid('projectId', 'That project no longer exists')
}

export async function createTask(
  tx: Tx,
  input: TaskCreateInput,
  ctx: TaskWriteContext,
): Promise<TaskWriteResult> {
  const tz = IanaTimeZoneSchema.parse(ctx.tz)
  const parsed = TaskCreateInputSchema.safeParse(input)
  if (!parsed.success) return tasksFirstIssue(parsed.error)
  const v = parsed.data
  const due = resolveTaskDue({ dueDate: v.dueDate, dueTime: v.dueTime }, tz)
  if (!due.ok) return tasksInvalid(v.dueTime ? 'dueTime' : 'dueDate', due.message)
  const projectProblem = await checkProject(tx, v.projectId)
  if (projectProblem) return projectProblem

  const reminderPlan = ctx.reminder
    ? resolveTaskReminder({ ...ctx.reminder, dueAt: due.due.dueAt }, ctx.now, tz)
    : null
  if (reminderPlan && !reminderPlan.ok)
    return tasksInvalid(reminderPlan.field, reminderPlan.message)

  const [task] = await tx<TaskRow[]>`
    insert into public.tasks (
      title, details, project_id, priority, due_date, due_at, duration_minutes, splittable,
      source, confirmed, source_ref
    ) values (
      ${v.title}, ${v.details ?? null}, ${v.projectId ?? null}::uuid, ${v.priority ?? null},
      ${due.due.dueDate}::date, ${due.due.dueAt}::timestamptz, ${v.durationMinutes ?? null},
      ${v.splittable ?? false}, ${v.source ?? 'manual'}, ${v.confirmed ?? true},
      ${v.sourceRef ? tx.json(v.sourceRef as postgres.JSONValue) : null}::jsonb
    )
    returning *
  `
  if (!task) throw new Error('task insert returned no row')
  const reminder =
    reminderPlan && reminderPlan.ok
      ? await applyTaskReminderPlan(tx, task, reminderPlan.plan)
      : null
  return { ok: true, task, due: due.due, reminder }
}

/**
 * Change owner-editable fields (see TaskUpdateInputSchema: undefined keeps,
 * null clears). Renaming a task renames its reminders too.
 */
export async function updateTask(
  tx: Tx,
  id: string,
  input: TaskUpdateInput,
  ctx: TaskWriteContext,
): Promise<TaskWriteResult> {
  const tz = IanaTimeZoneSchema.parse(ctx.tz)
  if (!tasksIsUuid(id)) return TASKS_NOT_FOUND
  const parsed = TaskUpdateInputSchema.safeParse(input)
  if (!parsed.success) return tasksFirstIssue(parsed.error)
  const v = parsed.data
  const [current] = await tx<
    TaskRow[]
  >`select * from public.tasks where id = ${id}::uuid for update`
  if (!current) return TASKS_NOT_FOUND

  let due: TaskDueResolution = {
    dueDate: current.dueDate,
    dueAt: current.dueAt,
    shiftedTo: null,
    ambiguous: false,
  }
  if (v.dueDate !== undefined) {
    const r = resolveTaskDue({ dueDate: v.dueDate, dueTime: v.dueTime ?? null }, tz)
    if (!r.ok) return tasksInvalid(v.dueTime ? 'dueTime' : 'dueDate', r.message)
    due = r.due
  }
  if (v.projectId !== undefined && v.projectId !== current.projectId) {
    const projectProblem = await checkProject(tx, v.projectId)
    if (projectProblem) return projectProblem
  }
  const reminderPlan = ctx.reminder
    ? resolveTaskReminder({ ...ctx.reminder, dueAt: due.dueAt }, ctx.now, tz)
    : null
  if (reminderPlan && !reminderPlan.ok)
    return tasksInvalid(reminderPlan.field, reminderPlan.message)

  const next = {
    title: v.title ?? current.title,
    details: v.details === undefined ? current.details : v.details,
    projectId: v.projectId === undefined ? current.projectId : v.projectId,
    priority: v.priority === undefined ? current.priority : v.priority,
    durationMinutes: v.durationMinutes === undefined ? current.durationMinutes : v.durationMinutes,
    splittable: v.splittable ?? current.splittable,
  }
  const [task] = await tx<TaskRow[]>`
    update public.tasks set
      title = ${next.title},
      details = ${next.details},
      project_id = ${next.projectId}::uuid,
      priority = ${next.priority},
      due_date = ${due.dueDate}::date,
      due_at = ${due.dueAt}::timestamptz,
      duration_minutes = ${next.durationMinutes},
      splittable = ${next.splittable}
    where id = ${id}::uuid
    returning *
  `
  if (!task) return TASKS_NOT_FOUND
  if (task.title !== current.title) {
    await tx`
      update public.reminders set title = ${task.title}
      where subject_kind = 'task' and subject_id = ${id}::uuid
    `
  }
  const reminder =
    reminderPlan && reminderPlan.ok
      ? await applyTaskReminderPlan(tx, task, reminderPlan.plan)
      : null
  return { ok: true, task, due, reminder }
}

export type TaskStatusResult =
  | { ok: true; task: TaskRow; changed: boolean }
  | TasksNotFound
  | { ok: false; reason: 'invalid_transition'; message: string }

/**
 * complete / reopen / cancel. Idempotent: repeating an action returns the task
 * unchanged (a second "complete" keeps the first completion time).
 */
export async function setTaskStatus(
  tx: Tx,
  id: string,
  action: TaskStatusAction,
  now: Date,
): Promise<TaskStatusResult> {
  if (!tasksIsUuid(id)) return TASKS_NOT_FOUND
  const [current] = await tx<
    TaskRow[]
  >`select * from public.tasks where id = ${id}::uuid for update`
  if (!current) return TASKS_NOT_FOUND
  const t = taskStatusTransition(current.status, action)
  if (!t.ok) return { ok: false, reason: 'invalid_transition', message: t.message }
  if (!t.changed) return { ok: true, task: current, changed: false }
  const completedAt = t.status === 'done' ? now : null
  const [task] = await tx<TaskRow[]>`
    update public.tasks set status = ${t.status}, completed_at = ${completedAt}::timestamptz
    where id = ${id}::uuid
    returning *
  `
  if (!task) return TASKS_NOT_FOUND
  return { ok: true, task, changed: true }
}

export const completeTask = (tx: Tx, id: string, now: Date) =>
  setTaskStatus(tx, id, 'complete', now)
export const reopenTask = (tx: Tx, id: string, now: Date) => setTaskStatus(tx, id, 'reopen', now)
export const cancelTask = (tx: Tx, id: string, now: Date) => setTaskStatus(tx, id, 'cancel', now)

/** Delete a task and (via trigger) its reminders. False when it was not there. */
export async function deleteTask(tx: Tx, id: string): Promise<boolean> {
  if (!tasksIsUuid(id)) return false
  const rows = await tx`delete from public.tasks where id = ${id}::uuid returning id`
  return rows.length > 0
}
