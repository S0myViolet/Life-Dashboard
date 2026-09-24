/**
 * Page data for Plan › Tasks and Plan › Habits, shaped for client components:
 * plain strings and numbers, with every date already formatted in the owner's
 * timezone on the server (so the device timezone never leaks into labels).
 */
import 'server-only'
import {
  HABIT_DAY_STATE_LABELS,
  HABIT_HISTORY_WEEKS,
  REMINDER_RECURRENCE_LABELS,
  addLocalDays,
  classifyTaskDue,
  describeHabitWeekdays,
  formatTaskDuration,
  groupTasksByDue,
  habitGridStart,
  localDateInZone,
  localTimeInZone,
  summarizeHabit,
  taskDueFormValues,
} from '@personal-home/core'
import {
  habitHistory,
  listHabits,
  listReminders,
  listTaskProjectOptions,
  listTaskReminders,
  listTasks,
  type Tx,
} from '@personal-home/db'
import { formatDueLabel, formatInstantLabel, formatLongDate, formatShortDate } from './format'
import { requireTasksTimeZone } from './service'
import type {
  HabitView,
  HabitsData,
  ReminderListData,
  ReminderView,
  TaskBoardData,
  TaskView,
} from './view-types'

export type * from './view-types'

export const OPEN_TASK_LIMIT = 1000
export const CLOSED_TASK_LIMIT = 50

export async function loadTaskBoard(tx: Tx, now: Date): Promise<TaskBoardData> {
  const tz = await requireTasksTimeZone(tx)
  const today = localDateInZone(now, tz)
  const [open, closed, projects] = await Promise.all([
    listTasks(tx, { filter: 'open', limit: OPEN_TASK_LIMIT }),
    listTasks(tx, { filter: 'done', limit: CLOSED_TASK_LIMIT + 1 }),
    listTaskProjectOptions(tx),
  ])
  const shownClosed = closed.slice(0, CLOSED_TASK_LIMIT)
  const reminders = await listTaskReminders(
    tx,
    open.map((t) => t.id),
  )
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  const groups = groupTasksByDue([...open, ...shownClosed], now, tz)
  const tasks: TaskView[] = []
  for (const group of ['overdue', 'today', 'upcoming', 'no_date', 'done'] as const) {
    for (const t of groups[group]) {
      const due = taskDueFormValues(t, tz)
      const reminder = reminders.get(t.id)?.[0] ?? null
      const openGroup = classifyTaskDue({ ...t, status: 'open' }, now, tz) as TaskView['openGroup']
      tasks.push({
        id: t.id,
        title: t.title,
        details: t.details,
        status: t.status,
        group,
        openGroup,
        priority: t.priority,
        durationMinutes: t.durationMinutes,
        durationLabel: t.durationMinutes ? formatTaskDuration(t.durationMinutes) : null,
        splittable: t.splittable,
        projectId: t.projectId,
        projectName: t.projectId ? (projectNames.get(t.projectId) ?? null) : null,
        dueLabel: formatDueLabel(t, now, tz),
        dueDate: due.dueDate,
        dueTime: due.dueTime,
        reminder: reminder
          ? {
              label: formatInstantLabel(reminder.remindAt, now, tz),
              date: localDateInZone(reminder.remindAt, tz),
              time: localTimeInZone(reminder.remindAt, tz),
            }
          : null,
        closedLabel:
          t.status === 'done' && t.completedAt
            ? `Done ${formatInstantLabel(t.completedAt, now, tz).replace(/^(Today|Yesterday)/, (m) => m.toLowerCase())}`
            : t.status === 'cancelled'
              ? 'Cancelled'
              : null,
      })
    }
  }
  return {
    tz,
    today,
    tomorrow: addLocalDays(today, 1),
    tasks,
    openTruncated: open.length >= OPEN_TASK_LIMIT,
    closedHasMore: closed.length > CLOSED_TASK_LIMIT,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
  }
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function loadReminders(tx: Tx, now: Date): Promise<ReminderListData> {
  const tz = await requireTasksTimeZone(tx)
  const rows = await listReminders(tx)
  const views = rows.map<ReminderView>((r) => ({
    id: r.id,
    title: r.title,
    subjectKind: r.subjectKind,
    taskId: r.subjectKind === 'task' ? r.subjectId : null,
    whenLabel: formatInstantLabel(r.remindAt, now, tz),
    recurrenceLabel: r.recurrence ? REMINDER_RECURRENCE_LABELS[r.recurrence] : null,
    due: r.remindAt.getTime() <= now.getTime(),
  }))
  return {
    tz,
    today: localDateInZone(now, tz),
    due: views.filter((v) => v.due),
    upcoming: views.filter((v) => !v.due),
  }
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

/** How far back completions are loaded, so streaks can span more than the grid. */
export const HABIT_STREAK_LOOKBACK_DAYS = 370

export async function loadHabits(tx: Tx, now: Date): Promise<HabitsData> {
  const tz = await requireTasksTimeZone(tx)
  const today = localDateInZone(now, tz)
  const weeks = HABIT_HISTORY_WEEKS
  const gridStart = habitGridStart(today, weeks)
  const lookback = addLocalDays(today, -HABIT_STREAK_LOOKBACK_DAYS)
  const fromDate = lookback < gridStart ? lookback : gridStart
  const habits = await listHabits(tx, { includeArchived: true })
  const history = await habitHistory(tx, { today, fromDate })

  const views = habits.map<HabitView>((h) => {
    const s = summarizeHabit(h, history.get(h.id) ?? [], {
      today,
      tz,
      weeks,
      historyStart: fromDate,
    })
    return {
      id: h.id,
      title: h.title,
      details: h.details,
      weekdays: h.weekdays,
      weekdaysLabel: describeHabitWeekdays(h.weekdays),
      active: h.active,
      dueToday: s.today.scheduled,
      doneToday: s.today.state === 'done',
      weeks: s.weeks.map((w) =>
        w.map((c) => ({
          date: c.date,
          state: c.state,
          scheduled: c.scheduled,
          label: `${formatLongDate(c.date, today)}: ${
            c.state === 'done' && !c.scheduled
              ? 'done (not scheduled)'
              : HABIT_DAY_STATE_LABELS[c.state]
          }`,
        })),
      ),
      weekLabels: s.weeks.map((w) => ({
        short: formatShortDate(w[0]!.date).replace(/^\w+ /, ''),
        long: `Week of ${formatLongDate(w[0]!.date, today)}`,
      })),
      currentStreak: s.currentStreak,
      currentStreakIsLowerBound: s.currentStreakIsLowerBound,
      longestStreak: s.longestStreak,
      scheduledDays: s.scheduledDays,
      completedScheduledDays: s.completedScheduledDays,
      missedDays: s.missedDays,
      extraCompletions: s.extraCompletions,
    }
  })
  return {
    tz,
    today,
    todayLabel: formatLongDate(today),
    weeks,
    habits: views.filter((v) => v.active),
    archived: views.filter((v) => !v.active),
  }
}
