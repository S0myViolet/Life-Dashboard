/**
 * Home › Needs attention, tasks and reminders part.
 *
 *   const attention = await listNeedsAttention(tx, new Date(), ownerTimezone)
 *
 * Returns overdue tasks, timed tasks due within the next 24 hours and due
 * reminders, as typed items (see core `TasksAttentionItem`). Only confirmed
 * tasks are included: unaccepted suggestions never raise attention items.
 * Works in an owner transaction (RLS) or a service transaction.
 */
import {
  IanaTimeZoneSchema,
  TASKS_DUE_SOON_MS,
  buildTasksNeedsAttention,
  localDateInZone,
  type TaskPriority,
  type TaskStatus,
  type TasksNeedsAttention,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import { listDueReminders } from './reminders.ts'

interface AttentionTaskRow {
  id: string
  title: string
  status: TaskStatus
  confirmed: boolean
  dueDate: string | null
  dueAt: Date | null
  priority: TaskPriority | null
  projectId: string | null
}

export async function listNeedsAttention(
  tx: Tx,
  now: Date,
  tz: string,
  options: { limit?: number } = {},
): Promise<TasksNeedsAttention> {
  const zone = IanaTimeZoneSchema.parse(tz)
  const today = localDateInZone(now, zone)
  const soonEnd = new Date(now.getTime() + TASKS_DUE_SOON_MS)
  // Candidates only; core decides what qualifies (and agrees with the task list).
  const tasks = await tx<AttentionTaskRow[]>`
    select id, title, status, confirmed, due_date, due_at, priority, project_id
    from public.tasks
    where status = 'open' and confirmed and due_date is not null
      and (
        (due_at is not null and due_at < ${soonEnd}::timestamptz)
        or (due_at is null and due_date < ${today}::date)
      )
    order by due_date, due_at nulls first, id
    limit 1000
  `
  const reminders = await listDueReminders(tx, now, 1000)
  return buildTasksNeedsAttention({ tasks, reminders, now, tz: zone, limit: options.limit })
}
