import { describe, expect, it } from 'vitest'
import {
  buildTasksNeedsAttention,
  taskHref,
  type TasksAttentionReminderCandidate,
  type TasksAttentionTaskCandidate,
} from '../src/index.ts'

const LONDON = 'Europe/London'
const at = (s: string) => new Date(s)
const now = at('2026-09-24T12:00:00Z') // 13:00 BST

const task = (
  id: string,
  over: Partial<TasksAttentionTaskCandidate>,
): TasksAttentionTaskCandidate => ({
  id,
  title: id,
  status: 'open',
  confirmed: true,
  dueDate: null,
  dueAt: null,
  priority: null,
  projectId: null,
  ...over,
})
const reminder = (
  id: string,
  over: Partial<TasksAttentionReminderCandidate>,
): TasksAttentionReminderCandidate => ({
  id,
  title: id,
  status: 'scheduled',
  remindAt: now,
  recurrence: null,
  subjectKind: 'custom',
  subjectId: null,
  ...over,
})

describe('buildTasksNeedsAttention', () => {
  it('lists overdue tasks, due reminders, then timed tasks due within 24 hours', () => {
    const r = buildTasksNeedsAttention({
      now,
      tz: LONDON,
      tasks: [
        task('soon-late', { dueDate: '2026-09-25', dueAt: at('2026-09-25T11:59:00Z') }),
        task('soon-early', { dueDate: '2026-09-24', dueAt: at('2026-09-24T15:00:00Z') }),
        task('not-soon', { dueDate: '2026-09-25', dueAt: at('2026-09-25T12:00:00Z') }),
        task('today-untimed', { dueDate: '2026-09-24' }),
        task('overdue-timed', { dueDate: '2026-09-24', dueAt: at('2026-09-24T09:00:00Z') }),
        task('overdue-date', { dueDate: '2026-09-20', priority: 2 }),
        task('no-date', {}),
        task('done', { status: 'done', dueDate: '2026-09-01' }),
        task('cancelled', { status: 'cancelled', dueDate: '2026-09-01' }),
        task('suggested', { confirmed: false, dueDate: '2026-09-01' }),
      ],
      reminders: [
        reminder('r-later', { remindAt: at('2026-09-24T11:00:00Z') }),
        reminder('r-earlier', { remindAt: at('2026-09-24T10:00:00Z'), status: 'delivered' }),
        reminder('r-future', { remindAt: at('2026-09-24T12:00:01Z') }),
        reminder('r-dismissed', { remindAt: at('2026-09-24T10:00:00Z'), status: 'dismissed' }),
        reminder('r-task', {
          remindAt: at('2026-09-24T09:00:00Z'),
          subjectKind: 'task',
          subjectId: '11111111-1111-4111-8111-111111111111',
        }),
      ],
    })
    expect(r.items.map((i) => i.key)).toEqual([
      'task:overdue-date',
      'task:overdue-timed',
      'reminder:r-task',
      'reminder:r-earlier',
      'reminder:r-later',
      'task:soon-early',
      'task:soon-late',
    ])
    expect(r.counts).toEqual({ overdue: 2, dueSoon: 2, reminders: 3 })
    expect(r.truncated).toBe(false)
    const first = r.items[0]!
    expect(first).toEqual({
      kind: 'task_overdue',
      key: 'task:overdue-date',
      taskId: 'overdue-date',
      title: 'overdue-date',
      dueDate: '2026-09-20',
      dueAt: null,
      priority: 2,
      projectId: null,
      href: taskHref('overdue-date'),
    })
    const taskReminder = r.items.find((i) => i.key === 'reminder:r-task')!
    expect(taskReminder.href).toBe('/plan/tasks?task=11111111-1111-4111-8111-111111111111')
    const custom = r.items.find((i) => i.key === 'reminder:r-later')!
    expect(custom.href).toBe('/plan/tasks#reminders')
  })

  it('cuts to the limit but keeps complete counts', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task(`t${i}`, { dueDate: '2026-09-01' }))
    const r = buildTasksNeedsAttention({ now, tz: LONDON, tasks, reminders: [], limit: 3 })
    expect(r.items).toHaveLength(3)
    expect(r.counts.overdue).toBe(5)
    expect(r.truncated).toBe(true)
  })

  it('uses the owner timezone for date-only overdue', () => {
    const late = at('2026-06-15T23:30:00Z') // 00:30 on the 16th in London
    const tasks = [task('t', { dueDate: '2026-06-15' })]
    expect(
      buildTasksNeedsAttention({ now: late, tz: LONDON, tasks, reminders: [] }).counts.overdue,
    ).toBe(1)
    expect(
      buildTasksNeedsAttention({ now: late, tz: 'UTC', tasks, reminders: [] }).counts.overdue,
    ).toBe(0)
  })
})
