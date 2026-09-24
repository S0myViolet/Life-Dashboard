/**
 * Form plumbing shared by the Learning and People server actions and their client
 * forms. Plain module (no 'use client' / 'use server'), so both sides can import it.
 */
import type { z } from 'zod'

export type FormActionState =
  | { status: 'idle' }
  | {
      status: 'saved'
      message: string
      /** Stored values the form needs to stay in step with (never raw rows). */
      values?: Partial<Record<string, string | null>>
    }
  | { status: 'error'; message: string; fieldErrors?: Partial<Record<string, string>> }

export const IDLE_FORM_STATE: FormActionState = { status: 'idle' }

export function formError(
  message: string,
  fieldErrors?: Partial<Record<string, string>>,
): FormActionState {
  return fieldErrors ? { status: 'error', message, fieldErrors } : { status: 'error', message }
}

/** First message per top-level field, keyed by the schema's field name. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    out[key] ??= issue.message
  }
  return out
}

/** A text field: trimmed; empty or missing → null. Non-string entries (files) → null. */
export function formText(fd: FormData, name: string): string | null {
  const raw = fd.get(name)
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return v === '' ? null : v
}

/** A multi-line text field kept as typed (the schema trims); missing → null. */
export function formMultiline(fd: FormData, name: string): string | null {
  const raw = fd.get(name)
  return typeof raw === 'string' ? raw : null
}

/**
 * A numeric field: empty → null; anything that is not a finite number records
 * "Enter a number" in `errors` (keyed by field name) and returns null.
 */
export function formNumber(
  fd: FormData,
  name: string,
  errors: Record<string, string>,
): number | null {
  const raw = fd.get(name)
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) {
    errors[name] = 'Enter a number'
    return null
  }
  return n
}

/** Checkbox groups: every numeric value submitted under `name`. */
export function formNumberList(fd: FormData, name: string): number[] {
  return fd
    .getAll(name)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
}
