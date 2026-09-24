'use server'

/**
 * Tasks, habits and reminders server actions. Server actions are public POST
 * endpoints: each one authenticates itself (withOwnerTx → requireOwner) and
 * validates its input (service.ts) — the page-level check does not cover them.
 */
import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import type { Tx } from '@personal-home/db'
import { withOwnerTx } from '@/lib/server/session'
import type { TasksActionResult, TasksFormState } from './forms'
import {
  archiveHabitById,
  changeTaskStatus,
  createHabitFromForm,
  createReminderFromForm,
  createTaskFromForm,
  dismissReminderById,
  removeHabit,
  removeReminder,
  removeTask,
  toggleHabitDay,
  updateHabitFromForm,
  updateTaskFromForm,
} from './service'

const TASK_PATHS = ['/plan/tasks', '/']
const HABIT_PATHS = ['/plan/habits', '/']
const RETRY = 'Could not save right now. Please try again.'

function logFailure(kind: string, error: unknown) {
  // The kind of failure only: never titles, notes or other submitted values.
  const code = (error as { code?: unknown })?.code
  console.error(`tasks action failed: ${kind}`, {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === 'string' ? code : undefined,
  })
}

async function runForm(
  kind: string,
  paths: string[],
  mutate: (tx: Tx, now: Date) => Promise<TasksFormState>,
): Promise<TasksFormState> {
  try {
    const state = await withOwnerTx((tx) => mutate(tx, new Date()))
    if (state.status === 'saved') for (const p of paths) revalidatePath(p)
    return state
  } catch (error) {
    unstable_rethrow(error) // redirects from requireOwner()
    logFailure(kind, error)
    return {
      status: 'error',
      message: RETRY,
      fieldErrors: {},
      values: {},
      stamp: crypto.randomUUID(),
    }
  }
}

async function runAction(
  kind: string,
  paths: string[],
  mutate: (tx: Tx, now: Date) => Promise<TasksActionResult>,
): Promise<TasksActionResult> {
  try {
    const result = await withOwnerTx((tx) => mutate(tx, new Date()))
    // Revalidate on failure too: "not found" means the page is out of date.
    for (const p of paths) revalidatePath(p)
    return result
  } catch (error) {
    unstable_rethrow(error)
    logFailure(kind, error)
    return { ok: false, message: RETRY }
  }
}

// Tasks ---------------------------------------------------------------------

export async function createTaskAction(
  _previous: TasksFormState,
  formData: FormData,
): Promise<TasksFormState> {
  return runForm('task.create', TASK_PATHS, (tx, now) => createTaskFromForm(tx, formData, now))
}

export async function updateTaskAction(
  _previous: TasksFormState,
  formData: FormData,
): Promise<TasksFormState> {
  return runForm('task.update', TASK_PATHS, (tx, now) => updateTaskFromForm(tx, formData, now))
}

export async function setTaskStatusAction(
  id: string,
  action: 'complete' | 'reopen',
): Promise<TasksActionResult> {
  return runAction('task.status', TASK_PATHS, (tx, now) => changeTaskStatus(tx, id, action, now))
}

export async function deleteTaskAction(id: string): Promise<TasksActionResult> {
  return runAction('task.delete', TASK_PATHS, (tx) => removeTask(tx, id))
}

// Reminders -----------------------------------------------------------------

export async function createReminderAction(
  _previous: TasksFormState,
  formData: FormData,
): Promise<TasksFormState> {
  return runForm('reminder.create', TASK_PATHS, (tx, now) =>
    createReminderFromForm(tx, formData, now),
  )
}

export async function dismissReminderAction(id: string): Promise<TasksActionResult> {
  return runAction('reminder.dismiss', TASK_PATHS, (tx, now) => dismissReminderById(tx, id, now))
}

export async function deleteReminderAction(id: string): Promise<TasksActionResult> {
  return runAction('reminder.delete', TASK_PATHS, (tx) => removeReminder(tx, id))
}

// Habits --------------------------------------------------------------------

export async function createHabitAction(
  _previous: TasksFormState,
  formData: FormData,
): Promise<TasksFormState> {
  return runForm('habit.create', HABIT_PATHS, (tx) => createHabitFromForm(tx, formData))
}

export async function updateHabitAction(
  _previous: TasksFormState,
  formData: FormData,
): Promise<TasksFormState> {
  return runForm('habit.update', HABIT_PATHS, (tx) => updateHabitFromForm(tx, formData))
}

export async function toggleHabitAction(
  habitId: string,
  localDate: string,
  done: boolean,
): Promise<TasksActionResult> {
  return runAction('habit.toggle', HABIT_PATHS, (tx, now) =>
    toggleHabitDay(tx, { habitId, localDate, done }, now),
  )
}

export async function archiveHabitAction(
  id: string,
  archived: boolean,
): Promise<TasksActionResult> {
  return runAction('habit.archive', HABIT_PATHS, (tx, now) =>
    archiveHabitById(tx, id, archived, now),
  )
}

export async function deleteHabitAction(id: string): Promise<TasksActionResult> {
  return runAction('habit.delete', HABIT_PATHS, (tx) => removeHabit(tx, id))
}
