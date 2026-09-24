/**
 * "Needs attention" items contributed by tasks and reminders (Home, brief §2):
 * overdue tasks, timed tasks due within the next 24 hours, and due reminders.
 *
 * Only confirmed tasks count: an unaccepted AI/email suggestion must never raise
 * an urgent item (brief §5). The database layer fetches candidates; this module
 * decides what qualifies and in which order, so the rules are unit-tested.
 */
import { classifyTaskDue, type TaskPriority, type TaskStatus } from './tasks.ts'
import {
  reminderIsDue,
  type ReminderRecurrence,
  type ReminderStatus,
  type ReminderSubjectKind,
} from './reminders.ts'

/** Route of the tasks screen; `?task=<id>` opens that task's edit sheet. */
export const TASKS_ROUTE = '/plan/tasks'
export const HABITS_ROUTE = '/plan/habits'
export const TASKS_REMINDERS_ANCHOR = 'reminders'
/** "Approaching within 24 hours" (brief §5) is a duration, not a calendar day. */
export const TASKS_DUE_SOON_MS = 24 * 60 * 60 * 1000

export function taskHref(taskId: string): string {
  return `${TASKS_ROUTE}?task=${encodeURIComponent(taskId)}`
}

export interface TasksAttentionTaskItem {
  kind: 'task_overdue' | 'task_due_soon'
  /** Stable React key / dedupe key. */
  key: string
  taskId: string
  title: string
  dueDate: string
  /** Null for a date-only task. */
  dueAt: Date | null
  priority: TaskPriority | null
  projectId: string | null
  href: string
}

export interface TasksAttentionReminderItem {
  kind: 'reminder_due'
  key: string
  reminderId: string
  title: string
  remindAt: Date
  recurrence: ReminderRecurrence | null
  subjectKind: ReminderSubjectKind
  subjectId: string | null
  href: string
}

export type TasksAttentionItem = TasksAttentionTaskItem | TasksAttentionReminderItem

export interface TasksNeedsAttention {
  /** Overdue tasks (oldest first), then due reminders, then tasks due soon (soonest first). */
  items: TasksAttentionItem[]
  counts: { overdue: number; dueSoon: number; reminders: number }
  /** True when `items` was cut to the limit; `counts` are always complete. */
  truncated: boolean
}

export interface TasksAttentionTaskCandidate {
  id: string
  title: string
  status: TaskStatus
  confirmed: boolean
  dueDate: string | null
  dueAt: Date | null
  priority: number | null
  projectId: string | null
}

export interface TasksAttentionReminderCandidate {
  id: string
  title: string
  status: ReminderStatus
  remindAt: Date
  recurrence: ReminderRecurrence | null
  subjectKind: ReminderSubjectKind
  subjectId: string | null
}

const asPriority = (p: number | null): TaskPriority | null =>
  p === 1 || p === 2 || p === 3 || p === 4 ? p : null

export function buildTasksNeedsAttention(input: {
  tasks: readonly TasksAttentionTaskCandidate[]
  reminders: readonly TasksAttentionReminderCandidate[]
  now: Date
  tz: string
  limit?: number
}): TasksNeedsAttention {
  const { now, tz } = input
  const limit = Math.max(0, Math.trunc(input.limit ?? 50))
  const soonEnd = now.getTime() + TASKS_DUE_SOON_MS

  const overdue: TasksAttentionTaskItem[] = []
  const dueSoon: TasksAttentionTaskItem[] = []
  for (const t of input.tasks) {
    if (!t.confirmed || t.status !== 'open' || !t.dueDate) continue
    const item = (kind: TasksAttentionTaskItem['kind']): TasksAttentionTaskItem => ({
      kind,
      key: `task:${t.id}`,
      taskId: t.id,
      title: t.title,
      dueDate: t.dueDate!,
      dueAt: t.dueAt,
      priority: asPriority(t.priority),
      projectId: t.projectId,
      href: taskHref(t.id),
    })
    if (classifyTaskDue(t, now, tz) === 'overdue') overdue.push(item('task_overdue'))
    else if (t.dueAt && t.dueAt.getTime() < soonEnd) dueSoon.push(item('task_due_soon'))
  }
  const reminders: TasksAttentionReminderItem[] = input.reminders
    .filter((r) => reminderIsDue(r, now))
    .map((r) => ({
      kind: 'reminder_due',
      key: `reminder:${r.id}`,
      reminderId: r.id,
      title: r.title,
      remindAt: r.remindAt,
      recurrence: r.recurrence,
      subjectKind: r.subjectKind,
      subjectId: r.subjectId,
      href:
        r.subjectKind === 'task' && r.subjectId
          ? taskHref(r.subjectId)
          : `${TASKS_ROUTE}#${TASKS_REMINDERS_ANCHOR}`,
    }))

  const dueKey = (i: TasksAttentionTaskItem) =>
    i.dueAt ? i.dueAt.getTime() : Number.NEGATIVE_INFINITY
  overdue.sort(
    (a, b) =>
      (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
      dueKey(a) - dueKey(b) ||
      (a.priority ?? 9) - (b.priority ?? 9),
  )
  dueSoon.sort((a, b) => dueKey(a) - dueKey(b) || (a.priority ?? 9) - (b.priority ?? 9))
  reminders.sort((a, b) => a.remindAt.getTime() - b.remindAt.getTime())

  const all: TasksAttentionItem[] = [...overdue, ...reminders, ...dueSoon]
  return {
    items: all.slice(0, limit),
    counts: { overdue: overdue.length, dueSoon: dueSoon.length, reminders: reminders.length },
    truncated: all.length > limit,
  }
}
