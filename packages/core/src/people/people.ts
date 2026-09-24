/**
 * People are managed by hand: no contact import, no scraping and no relationship
 * scoring (brief §2). A person has a name, a free-text relationship label, plain-text
 * notes, important dates and an optional catch-up cadence.
 */
import { z } from 'zod'
import { CalendarDateSchema } from '../time/index.ts'
import { CATCH_UP_LIMITS } from './cadence.ts'

export const PERSON_LIMITS = {
  nameMax: 200,
  relationshipMax: 100,
  notesMax: 20_000,
  searchMax: 100,
} as const

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

export const PersonInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the person a name').max(PERSON_LIMITS.nameMax),
  /** Free text: "sister", "old school friend", "mentor". */
  relationship: optionalText(PERSON_LIMITS.relationshipMax),
  /** Plain text, shown as written (never rendered as HTML or Markdown). */
  notes: z
    .string()
    .max(PERSON_LIMITS.notesMax)
    .nullish()
    .transform((v) => (v && v.trim() ? v.trimEnd() : null)),
  catchUpEveryDays: z
    .number()
    .int('Days must be a whole number')
    .min(CATCH_UP_LIMITS.minDays, `At least every ${CATCH_UP_LIMITS.minDays} days`)
    .max(CATCH_UP_LIMITS.maxDays, `At most every ${CATCH_UP_LIMITS.maxDays} days`)
    .nullish()
    .transform((v) => v ?? null),
  /** The last time the owner caught up, when they want to record one. Never in the future. */
  lastCaughtUpOn: CalendarDateSchema.nullish().transform((v) => v ?? null),
})
export type PersonInput = z.input<typeof PersonInputSchema>
export type PersonFields = z.output<typeof PersonInputSchema>

/** A search box value: trimmed, bounded; empty means "everyone". */
export const PeopleSearchSchema = z
  .unknown()
  .transform((v) => (typeof v === 'string' ? v.trim().slice(0, PERSON_LIMITS.searchMax) : ''))

/**
 * The catch-up start date to store after an edit: the cadence is counted from when it
 * was first set, and restarts when it is switched off and on again.
 */
export function catchUpStartedOnAfterEdit(
  previous: { catchUpEveryDays: number | null; catchUpStartedOn: string | null } | null,
  nextEveryDays: number | null,
  today: string,
): string | null {
  if (nextEveryDays == null) return null
  if (previous?.catchUpEveryDays != null && previous.catchUpStartedOn) {
    return previous.catchUpStartedOn
  }
  return today
}
