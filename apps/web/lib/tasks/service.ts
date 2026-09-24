/**
 * Bodies of the tasks/habits/reminders server actions. Each takes an owner
 * transaction (RLS-enforced) and untrusted input, validates it and returns a
 * state the form renders. Kept apart from actions.ts so it can be tested
 * against a real database without a Next.js request.
 */
import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CalendarDateSchema, localDateInZone } from '@personal-home/core'
import {
  createHabit,
  createReminder,
  createTask,
  deleteHabit,
  deleteReminder,
  deleteTask,
  dismissReminder,
  setHabitArchived,
  setHabitCompletion,
  setTaskStatus,
  tasksOwnerTimeZone,
  updateHabit,
  updateTask,
  type TasksInvalid,
  type Tx,
} from '@personal-home/db'
import { dstNotice, formatInstantLabel } from './format'
import {
  HABIT_FORM_FIELDS,
  REMINDER_FORM_FIELDS,
  TASK_FORM_FIELDS,
  formValues,
  parseHabitForm,
  parseReminderForm,
  parseTaskForm,
  type TasksActionResult,
  type TasksFormState,
} from './forms'

export class TasksTimeZoneUnavailableError extends Error {
  constructor() {
    super('The owner timezone could not be read')
    this.name = 'TasksTimeZoneUnavailableError'
  }
}

/** The owner's timezone for this transaction; throws when it cannot be read. */
export async function requireTasksTimeZone(tx: Tx): Promise<string> {
  const tz = await tasksOwnerTimeZone(tx)
  if (!tz) throw new TasksTimeZoneUnavailableError()
  return tz
}

const IdSchema = z.uuid()
const NOT_FOUND = 'It may have been deleted. Reload the page and try again.'

function formError(
  formData: FormData,
  fields: readonly string[],
  fieldErrors: Record<string, string>,
  message = 'Check the highlighted fields.',
): TasksFormState {
  return {
    status: 'error',
    message,
    fieldErrors,
    values: formValues(formData, fields),
    stamp: randomUUID(),
  }
}

function invalidToForm(
  formData: FormData,
  fields: readonly string[],
  r: TasksInvalid,
): TasksFormState {
  if (r.field === 'form' || !fields.includes(r.field)) {
    return formError(formData, fields, {}, r.message)
  }
  return formError(formData, fields, { [r.field]: r.message })
}

function saved(message: string, notice: string | null = null): TasksFormState {
  return { status: 'saved', message, notice, stamp: randomUUID() }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTaskFromForm(
  tx: Tx,
  formData: FormData,
  now: Date,
): Promise<TasksFormState> {
  const parsed = parseTaskForm(formData, 'create')
  if (!parsed.ok) return formError(formData, TASK_FORM_FIELDS, parsed.fieldErrors)
  const tz = await requireTasksTimeZone(tx)
  const { fields, reminder } = parsed.value
  const r = await createTask(tx, fields, { tz, now, reminder })
  if (!r.ok) {
    if (r.reason === 'not_found') return formError(formData, TASK_FORM_FIELDS, {}, NOT_FOUND)
    return invalidToForm(formData, TASK_FORM_FIELDS, r)
  }
  return saved(`Added “${r.task.title}”.`, taskNotices(fields, r, tz, now))
}

export async function updateTaskFromForm(
  tx: Tx,
  formData: FormData,
  now: Date,
): Promise<TasksFormState> {
  const id = IdSchema.safeParse(formData.get('id'))
  if (!id.success) return formError(formData, TASK_FORM_FIELDS, {}, NOT_FOUND)
  const parsed = parseTaskForm(formData, 'update')
  if (!parsed.ok) return formError(formData, TASK_FORM_FIELDS, parsed.fieldErrors)
  const tz = await requireTasksTimeZone(tx)
  const { fields, reminder } = parsed.value
  const r = await updateTask(tx, id.data, fields, { tz, now, reminder })
  if (!r.ok) {
    if (r.reason === 'not_found') return formError(formData, TASK_FORM_FIELDS, {}, NOT_FOUND)
    return invalidToForm(formData, TASK_FORM_FIELDS, r)
  }
  return saved(`Saved “${r.task.title}”.`, taskNotices(fields, r, tz, now))
}

function taskNotices(
  fields: { dueDate?: string | null; dueTime?: string | null },
  r: {
    due: { shiftedTo: string | null; ambiguous: boolean }
    reminder: { remindAt: Date } | null
  },
  tz: string,
  now: Date,
): string | null {
  const notes: string[] = []
  if (fields.dueDate && fields.dueTime) {
    const n = dstNotice({ date: fields.dueDate, time: fields.dueTime }, r.due, tz)
    if (n) notes.push(n)
  }
  if (r.reminder)
    notes.push(`Reminder set for ${formatInstantLabel(r.reminder.remindAt, now, tz)}.`)
  return notes.length ? notes.join(' ') : null
}

const TaskStatusActionSchema = z.enum(['complete', 'reopen'])

export async function changeTaskStatus(
  tx: Tx,
  id: unknown,
  action: unknown,
  now: Date,
): Promise<TasksActionResult> {
  const parsedId = IdSchema.safeParse(id)
  const parsedAction = TaskStatusActionSchema.safeParse(action)
  if (!parsedId.success || !parsedAction.success) return { ok: false, message: NOT_FOUND }
  const r = await setTaskStatus(tx, parsedId.data, parsedAction.data, now)
  if (!r.ok) return { ok: false, message: r.reason === 'not_found' ? NOT_FOUND : r.message }
  return { ok: true }
}

export async function removeTask(tx: Tx, id: unknown): Promise<TasksActionResult> {
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success || !(await deleteTask(tx, parsed.data)))
    return { ok: false, message: NOT_FOUND }
  return { ok: true, message: 'Task deleted.' }
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function createReminderFromForm(
  tx: Tx,
  formData: FormData,
  now: Date,
): Promise<TasksFormState> {
  const parsed = parseReminderForm(formData)
  if (!parsed.ok) return formError(formData, REMINDER_FORM_FIELDS, parsed.fieldErrors)
  const tz = await requireTasksTimeZone(tx)
  const r = await createReminder(tx, parsed.value, { tz, now })
  if (!r.ok) {
    if (r.reason === 'not_found') return formError(formData, REMINDER_FORM_FIELDS, {}, NOT_FOUND)
    return invalidToForm(formData, REMINDER_FORM_FIELDS, r)
  }
  const notice = dstNotice(
    { date: parsed.value.date, time: parsed.value.time },
    { shiftedTo: r.shiftedTo },
    tz,
  )
  return saved(`Reminder set for ${formatInstantLabel(r.reminder.remindAt, now, tz)}.`, notice)
}

export async function dismissReminderById(
  tx: Tx,
  id: unknown,
  now: Date,
): Promise<TasksActionResult> {
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success) return { ok: false, message: NOT_FOUND }
  const tz = await requireTasksTimeZone(tx)
  const r = await dismissReminder(tx, parsed.data, { tz, now })
  if (!r.ok) return { ok: false, message: NOT_FOUND }
  if (r.advancedTo) {
    return { ok: true, message: `Next reminder: ${formatInstantLabel(r.advancedTo, now, tz)}.` }
  }
  return { ok: true, message: 'Reminder dismissed.' }
}

export async function removeReminder(tx: Tx, id: unknown): Promise<TasksActionResult> {
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success || !(await deleteReminder(tx, parsed.data))) {
    return { ok: false, message: NOT_FOUND }
  }
  return { ok: true, message: 'Reminder deleted.' }
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export async function createHabitFromForm(tx: Tx, formData: FormData): Promise<TasksFormState> {
  const parsed = parseHabitForm(formData)
  if (!parsed.ok) return formError(formData, HABIT_FORM_FIELDS, parsed.fieldErrors)
  const r = await createHabit(tx, parsed.value)
  if (!r.ok) {
    if (r.reason === 'not_found') return formError(formData, HABIT_FORM_FIELDS, {}, NOT_FOUND)
    return invalidToForm(formData, HABIT_FORM_FIELDS, r)
  }
  return saved(`Added “${r.habit.title}”.`)
}

export async function updateHabitFromForm(tx: Tx, formData: FormData): Promise<TasksFormState> {
  const id = IdSchema.safeParse(formData.get('id'))
  if (!id.success) return formError(formData, HABIT_FORM_FIELDS, {}, NOT_FOUND)
  const parsed = parseHabitForm(formData)
  if (!parsed.ok) return formError(formData, HABIT_FORM_FIELDS, parsed.fieldErrors)
  const r = await updateHabit(tx, id.data, parsed.value)
  if (!r.ok) {
    if (r.reason === 'not_found') return formError(formData, HABIT_FORM_FIELDS, {}, NOT_FOUND)
    return invalidToForm(formData, HABIT_FORM_FIELDS, r)
  }
  return saved(`Saved “${r.habit.title}”.`)
}

/** Check off (or un-check) a habit for an owner-local date, today by default. */
export async function toggleHabitDay(
  tx: Tx,
  input: { habitId: unknown; localDate: unknown; done: unknown },
  now: Date,
): Promise<TasksActionResult> {
  const habitId = IdSchema.safeParse(input.habitId)
  const localDate = CalendarDateSchema.safeParse(input.localDate)
  if (!habitId.success || !localDate.success || typeof input.done !== 'boolean') {
    return { ok: false, message: NOT_FOUND }
  }
  const tz = await requireTasksTimeZone(tx)
  const r = await setHabitCompletion(tx, {
    habitId: habitId.data,
    localDate: localDate.data,
    done: input.done,
    today: localDateInZone(now, tz),
    now,
  })
  if (!r.ok) return { ok: false, message: r.reason === 'not_found' ? NOT_FOUND : r.message }
  return { ok: true }
}

export async function archiveHabitById(
  tx: Tx,
  id: unknown,
  archived: unknown,
  now: Date,
): Promise<TasksActionResult> {
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success || typeof archived !== 'boolean') return { ok: false, message: NOT_FOUND }
  const r = await setHabitArchived(tx, parsed.data, archived, now)
  if (!r.ok) return { ok: false, message: NOT_FOUND }
  return { ok: true, message: archived ? 'Habit archived.' : 'Habit restored.' }
}

export async function removeHabit(tx: Tx, id: unknown): Promise<TasksActionResult> {
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success || !(await deleteHabit(tx, parsed.data))) {
    return { ok: false, message: NOT_FOUND }
  }
  return { ok: true, message: 'Habit deleted.' }
}
