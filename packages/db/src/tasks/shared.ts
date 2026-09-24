/** Result helpers shared by the tasks, habits and reminders repositories. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a syntactically valid UUID (anything else can never match a row). */
export function tasksIsUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** A field-level problem the UI can show next to the input. */
export interface TasksInvalid {
  ok: false
  reason: 'invalid'
  field: string
  message: string
}
export interface TasksNotFound {
  ok: false
  reason: 'not_found'
}

export function tasksInvalid(field: string, message: string): TasksInvalid {
  return { ok: false, reason: 'invalid', field, message }
}
export const TASKS_NOT_FOUND: TasksNotFound = { ok: false, reason: 'not_found' }

/** First zod issue as a field error (`form` when it has no path). */
export function tasksFirstIssue(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): TasksInvalid {
  const issue = error.issues[0]
  const field = issue?.path.length ? String(issue.path[0]) : 'form'
  return tasksInvalid(field, issue?.message ?? 'Invalid input')
}
