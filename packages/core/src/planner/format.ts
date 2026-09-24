/**
 * Deterministic English labels for planner reasons. Intl month/weekday names differ between
 * ICU versions ("Sep" vs "Sept"), so the names are spelled out here.
 */
import { addLocalDays, isoWeekday, localDateInZone, localTimeInZone } from '../time/index.ts'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** "Tue 22 Sep" (adds the year when it differs from `referenceDate`'s). */
export function plannerDateLabel(localDate: string, referenceDate?: string): string {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number]
  const weekday = WEEKDAYS[isoWeekday(localDate) - 1]
  const base = `${weekday} ${d} ${MONTHS[m - 1]}`
  if (referenceDate && referenceDate.slice(0, 4) !== localDate.slice(0, 4)) return `${base} ${y}`
  return base
}

/** "today", "tomorrow" or "Tue 22 Sep", relative to `today`. */
export function plannerRelativeDayLabel(localDate: string, today: string): string {
  if (localDate === today) return 'today'
  if (localDate === addLocalDays(today, 1)) return 'tomorrow'
  return plannerDateLabel(localDate, today)
}

/** "1 h 30 min", "45 min", "2 h". */
export function plannerDurationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r} min`
  if (r === 0) return `${h} h`
  return `${h} h ${r} min`
}

/** Wall-clock "HH:MM" of an instant in `tz`. */
export function plannerTimeLabel(instant: Date | number | string, tz: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return localTimeInZone(d, tz)
}

/** Local date of an instant. */
export function plannerLocalDate(instant: Date | number | string, tz: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return localDateInZone(d, tz)
}
