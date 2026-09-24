/**
 * Text clean-up shared by task, habit and reminder schemas.
 *
 * Postgres `text` cannot hold NUL, and single-line titles should not carry
 * control characters or runs of whitespace pasted from elsewhere.
 */
import { z } from 'zod'

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** Collapse a single-line title: control characters become spaces, whitespace runs collapse. */
export function tasksCleanTitle(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
}

/** Multi-line free text: drop control characters other than newline/tab, normalise newlines. */
export function tasksCleanMultiline(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE_TAB, '').trim()
}

/** A required single-line title of 1..max characters (after clean-up). */
export function tasksTitleSchema(max: number, emptyMessage: string) {
  return z
    .string()
    .transform(tasksCleanTitle)
    .pipe(
      z
        .string()
        .min(1, { message: emptyMessage })
        .max(max, { message: `Keep it to ${max} characters or fewer` }),
    )
}

/** Optional multi-line text; blank becomes null. */
export function tasksOptionalTextSchema(max: number) {
  return z
    .string()
    .transform(tasksCleanMultiline)
    .pipe(z.string().max(max, { message: `Keep it to ${max} characters or fewer` }))
    .transform((v) => (v === '' ? null : v))
    .nullable()
}
