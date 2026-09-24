/**
 * Catch-up cadence: "every N days", optional, per person.
 *
 * Everything here is calendar arithmetic on owner-local 'YYYY-MM-DD' dates, so a
 * cadence is never shifted by a DST change: 7 days after 22 March is 29 March
 * whether or not the clocks change in between. The caller turns "now" into the
 * owner's local date with `localDateInZone(now, timezone)`.
 *
 * No scoring: a person is either not on a cadence, not yet due, due, or overdue.
 */
import { addLocalDays, localDaysBetween } from '../time/index.ts'

export const CATCH_UP_LIMITS = { minDays: 7, maxDays: 730 } as const

/** Offered in the UI; any whole number of days in range is accepted. */
export const CATCH_UP_PRESETS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: 'Every week' },
  { days: 14, label: 'Every 2 weeks' },
  { days: 21, label: 'Every 3 weeks' },
  { days: 30, label: 'Every month' },
  { days: 60, label: 'Every 2 months' },
  { days: 90, label: 'Every 3 months' },
  { days: 180, label: 'Every 6 months' },
  { days: 365, label: 'Every year' },
]

export interface CatchUpCadenceLike {
  catchUpEveryDays: number | null
  lastCaughtUpOn: string | null
  /** When the cadence was set; the first catch-up is due one interval after it. */
  catchUpStartedOn: string | null
}

export type CatchUpState = 'not_set' | 'upcoming' | 'due' | 'overdue'

export interface CatchUpStatus {
  state: CatchUpState
  /** The local date the next catch-up is due, or null when not on a cadence. */
  dueOn: string | null
  /** Days from today until due: 0 = due today, negative = overdue by that many days. */
  daysUntilDue: number | null
  /** No catch-up has been recorded since the cadence was set. */
  neverCaughtUp: boolean
}

export function catchUpDueOn(c: CatchUpCadenceLike): string | null {
  if (c.catchUpEveryDays == null) return null
  const anchor = c.lastCaughtUpOn ?? c.catchUpStartedOn
  if (!anchor) return null
  return addLocalDays(anchor, c.catchUpEveryDays)
}

export function catchUpStatus(c: CatchUpCadenceLike, today: string): CatchUpStatus {
  if (c.catchUpEveryDays == null) {
    return { state: 'not_set', dueOn: null, daysUntilDue: null, neverCaughtUp: false }
  }
  const neverCaughtUp = c.lastCaughtUpOn == null
  const dueOn = catchUpDueOn(c)
  if (dueOn == null) {
    // A cadence with no start and no catch-up recorded (only possible with data written
    // outside the app): there is nothing to count from, so it is due now.
    return { state: 'due', dueOn: today, daysUntilDue: 0, neverCaughtUp }
  }
  const daysUntilDue = localDaysBetween(today, dueOn)
  const state: CatchUpState = daysUntilDue > 0 ? 'upcoming' : daysUntilDue === 0 ? 'due' : 'overdue'
  return { state, dueOn, daysUntilDue, neverCaughtUp }
}

/** True when a catch-up is due today or overdue. */
export function isCatchUpDue(status: CatchUpStatus): boolean {
  return status.state === 'due' || status.state === 'overdue'
}
