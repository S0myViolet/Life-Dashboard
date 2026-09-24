/**
 * Serializable page data shared by the server loaders (view.ts) and the
 * client components. No server-only imports here.
 */
import type {
  HabitDayState,
  ReminderSubjectKind,
  TaskDueGroup,
  TaskPriority,
  TaskStatus,
} from '@personal-home/core'

export interface TaskView {
  id: string
  title: string
  details: string | null
  status: TaskStatus
  group: TaskDueGroup
  /** The group the task belongs to when open (used to reopen it optimistically). */
  openGroup: Exclude<TaskDueGroup, 'done'>
  priority: TaskPriority | null
  durationMinutes: number | null
  durationLabel: string | null
  splittable: boolean
  projectId: string | null
  projectName: string | null
  dueLabel: string | null
  /** Edit-form values in the owner's timezone ('' when unset). */
  dueDate: string
  dueTime: string
  reminder: { label: string; date: string; time: string } | null
  closedLabel: string | null
}

export interface TaskBoardData {
  tz: string
  today: string
  tomorrow: string
  tasks: TaskView[]
  openTruncated: boolean
  closedHasMore: boolean
  projects: { id: string; name: string }[]
}

export interface ReminderView {
  id: string
  title: string
  subjectKind: ReminderSubjectKind
  taskId: string | null
  whenLabel: string
  recurrenceLabel: string | null
  due: boolean
}

export interface ReminderListData {
  tz: string
  today: string
  due: ReminderView[]
  upcoming: ReminderView[]
}

export interface HabitCellView {
  date: string
  state: HabitDayState
  scheduled: boolean
  /** Screen-reader text, e.g. "Monday 3 August: missed". */
  label: string
}

export interface HabitView {
  id: string
  title: string
  details: string | null
  weekdays: number[]
  weekdaysLabel: string
  active: boolean
  dueToday: boolean
  doneToday: boolean
  weeks: HabitCellView[][]
  /** Row headers: short visible text and the full label for screen readers. */
  weekLabels: { short: string; long: string }[]
  currentStreak: number
  currentStreakIsLowerBound: boolean
  longestStreak: number
  scheduledDays: number
  completedScheduledDays: number
  missedDays: number
  extraCompletions: number
}

export interface HabitsData {
  tz: string
  today: string
  todayLabel: string
  weeks: number
  habits: HabitView[]
  archived: HabitView[]
}
