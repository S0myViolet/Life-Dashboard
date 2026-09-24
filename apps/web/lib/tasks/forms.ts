/**
 * Untrusted FormData → typed input for the tasks, habits and reminders
 * repositories. Shape checks only; the repositories validate the values with
 * the core zod schemas (and the owner's timezone) before writing.
 *
 * Form input names match the repository field names, so a field error from
 * either layer can be shown next to the right input.
 */
import {
  REMINDER_RECURRENCES,
  TASK_REMINDER_CHOICES,
  type HabitCreateInput,
  type ReminderInput,
  type ReminderRecurrence,
  type TaskCreateInput,
  type TaskReminderChoice,
} from '@personal-home/core'

/** Result of a form submission, rendered by the form that sent it. */
export type TasksFormState =
  | { status: 'idle' }
  | {
      status: 'saved'
      message: string
      /** Extra information, e.g. a time moved by a DST change. */
      notice: string | null
      /** Changes on every response so the form can reset itself. */
      stamp: string
    }
  | {
      status: 'error'
      message: string
      fieldErrors: Record<string, string>
      /** The submitted values, to refill the form. */
      values: Record<string, string>
      stamp: string
    }

export const TASKS_FORM_IDLE: TasksFormState = { status: 'idle' }

/** Result of a button action (complete, dismiss, delete, toggle). */
export type TasksActionResult = { ok: true; message?: string } | { ok: false; message: string }

export type FormParse<T> =
  { ok: true; value: T } | { ok: false; fieldErrors: Record<string, string> }

function str(formData: FormData, name: string): string | undefined {
  const v = formData.get(name)
  return typeof v === 'string' ? v : undefined
}

function optionalText(formData: FormData, name: string): string | null | undefined {
  const v = str(formData, name)
  if (v === undefined) return undefined
  return v.trim() === '' ? null : v.trim()
}

/** The string values of the named fields, for refilling a form after an error. */
export function formValues(formData: FormData, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const all = formData.getAll(name).filter((v): v is string => typeof v === 'string')
    if (all.length === 1) out[name] = all[0]!.slice(0, 10_000)
    else if (all.length > 1) out[name] = all.join(',').slice(0, 10_000)
  }
  return out
}

export const TASK_FORM_FIELDS = [
  'id',
  'title',
  'details',
  'projectId',
  'priority',
  'dueDate',
  'dueTime',
  'durationMinutes',
  'splittable',
  'reminder',
  'reminderDate',
  'reminderTime',
] as const

export interface ParsedTaskForm {
  fields: TaskCreateInput
  reminder: { choice: TaskReminderChoice; date: string | null; time: string | null }
}

/**
 * Parse the add/edit task form. On the edit form an absent `projectId` means
 * "keep" (the project picker is only shown when projects exist) and the reminder
 * defaults to "keep"; on the add form it defaults to "none".
 */
export function parseTaskForm(
  formData: FormData,
  mode: 'create' | 'update',
): FormParse<ParsedTaskForm> {
  const fieldErrors: Record<string, string> = {}

  const priorityRaw = (str(formData, 'priority') ?? '').trim()
  let priority: 1 | 2 | 3 | 4 | null = null
  if (priorityRaw !== '') {
    if (/^[1-4]$/.test(priorityRaw)) priority = Number(priorityRaw) as 1 | 2 | 3 | 4
    else fieldErrors.priority = 'Choose a priority from the list'
  }

  const durationRaw = (str(formData, 'durationMinutes') ?? '').trim()
  let durationMinutes: number | null = null
  if (durationRaw !== '') {
    if (/^\d{1,4}$/.test(durationRaw)) durationMinutes = Number(durationRaw)
    else fieldErrors.durationMinutes = 'Enter the duration in whole minutes'
  }

  const projectRaw = str(formData, 'projectId')
  const projectId =
    projectRaw === undefined ? undefined : projectRaw.trim() === '' ? null : projectRaw.trim()

  const choiceRaw = str(formData, 'reminder') ?? (mode === 'create' ? 'none' : 'keep')
  let choice: TaskReminderChoice = 'none'
  if ((TASK_REMINDER_CHOICES as readonly string[]).includes(choiceRaw)) {
    choice = choiceRaw as TaskReminderChoice
    if (mode === 'create' && choice === 'keep') choice = 'none'
  } else {
    fieldErrors.reminder = 'Choose a reminder from the list'
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }

  const fields: TaskCreateInput = {
    title: str(formData, 'title') ?? '',
    details: optionalText(formData, 'details') ?? (mode === 'create' ? null : undefined),
    priority,
    dueDate: optionalText(formData, 'dueDate') ?? null,
    dueTime: optionalText(formData, 'dueTime') ?? null,
    durationMinutes,
    splittable: str(formData, 'splittable') === 'on',
  }
  if (projectId !== undefined) fields.projectId = projectId
  // An absent details field on the edit form keeps the stored details.
  if (mode === 'update' && str(formData, 'details') === undefined) delete fields.details

  return {
    ok: true,
    value: {
      fields,
      reminder: {
        choice,
        date: optionalText(formData, 'reminderDate') ?? null,
        time: optionalText(formData, 'reminderTime') ?? null,
      },
    },
  }
}

export const REMINDER_FORM_FIELDS = ['id', 'title', 'date', 'time', 'recurrence'] as const

export function parseReminderForm(formData: FormData): FormParse<ReminderInput> {
  const recurrenceRaw = (str(formData, 'recurrence') ?? '').trim()
  let recurrence: ReminderRecurrence | null = null
  if (recurrenceRaw !== '') {
    if ((REMINDER_RECURRENCES as readonly string[]).includes(recurrenceRaw)) {
      recurrence = recurrenceRaw as ReminderRecurrence
    } else {
      return { ok: false, fieldErrors: { recurrence: 'Choose how often from the list' } }
    }
  }
  const date = (str(formData, 'date') ?? '').trim()
  const time = (str(formData, 'time') ?? '').trim()
  const fieldErrors: Record<string, string> = {}
  if (!date) fieldErrors.date = 'Pick a date'
  if (!time) fieldErrors.time = 'Pick a time'
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }
  return { ok: true, value: { title: str(formData, 'title') ?? '', date, time, recurrence } }
}

export const HABIT_FORM_FIELDS = ['id', 'title', 'details', 'weekdays'] as const

export function parseHabitForm(
  formData: FormData,
): FormParse<HabitCreateInput & { weekdays: number[] }> {
  const raw = formData.getAll('weekdays').filter((v): v is string => typeof v === 'string')
  const weekdays: number[] = []
  for (const v of raw) {
    if (!/^[1-7]$/.test(v))
      return { ok: false, fieldErrors: { weekdays: 'Pick days from the list' } }
    weekdays.push(Number(v))
  }
  if (weekdays.length === 0)
    return { ok: false, fieldErrors: { weekdays: 'Pick at least one day' } }
  return {
    ok: true,
    value: {
      title: str(formData, 'title') ?? '',
      details: optionalText(formData, 'details') ?? null,
      weekdays,
    },
  }
}
