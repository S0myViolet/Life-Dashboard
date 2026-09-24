/** Wording for important dates and catch-ups. No scores, no judgements. */
import {
  CATCH_UP_PRESETS,
  type CatchUpStatus,
  type ImportantDateOccurrence,
} from '@personal-home/core'
import { formatLocalDate, monthName, plural, relativeDay } from '@/components/learning/format'

/** '3 December 1990', or '3 December' without a year. */
export function importantDateText(d: { month: number; day: number; year: number | null }): string {
  return `${d.day} ${monthName(d.month)}${d.year != null ? ` ${d.year}` : ''}`
}

/** 'today', 'tomorrow · turns 36', 'in 12 days (Sun, 28 Feb 2027) · marked on 28 Feb — no 29 Feb this year'. */
export function occurrenceText(
  label: string,
  next: ImportantDateOccurrence,
  today: string,
): string {
  const parts = [relativeDay(next.date, today)]
  if (next.daysUntil > 1) parts[0] += ` (${formatLocalDate(next.date, { today, weekday: true })})`
  if (next.years != null && next.years > 0) {
    parts.push(/birthday/i.test(label) ? `turns ${next.years}` : plural(next.years, 'year'))
  }
  if (next.observedFromFeb29) parts.push('marked on 28 Feb — no 29 Feb this year')
  return parts.join(' · ')
}

export function cadenceLabel(days: number): string {
  return CATCH_UP_PRESETS.find((p) => p.days === days)?.label ?? `Every ${days} days`
}

/** 'Due today', 'Overdue by 3 days', 'Next in 12 days (4 Oct)'. */
export function catchUpText(status: CatchUpStatus, today: string): string {
  if (status.state === 'not_set' || status.dueOn == null || status.daysUntilDue == null) {
    return 'No catch-up reminder'
  }
  if (status.state === 'due') return 'Catch-up due today'
  if (status.state === 'overdue')
    return `Catch-up overdue by ${plural(-status.daysUntilDue, 'day')}`
  return `Next catch-up ${relativeDay(status.dueOn, today)} (${formatLocalDate(status.dueOn, { today })})`
}

export function lastCaughtUpText(lastCaughtUpOn: string | null, today: string): string {
  if (!lastCaughtUpOn) return 'No catch-up recorded yet'
  const rel = relativeDay(lastCaughtUpOn, today)
  return rel === 'today'
    ? 'Last caught up today'
    : `Last caught up ${rel} (${formatLocalDate(lastCaughtUpOn, { today })})`
}
