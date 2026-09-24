/**
 * Date and time labels for tasks, habits and reminders, always in the owner's
 * timezone (never the device's). Built from local-date parts rather than
 * Intl month names so labels do not change between ICU versions
 * ("Sep" vs "Sept").
 */
import { addLocalDays, isoWeekday, localDateInZone, localTimeInZone } from '@personal-home/core'

const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS_SHORT = [
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
]
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function parts(localDate: string) {
  return {
    year: Number(localDate.slice(0, 4)),
    month: Number(localDate.slice(5, 7)),
    day: Number(localDate.slice(8, 10)),
    weekday: isoWeekday(localDate),
  }
}

/** "Thu 24 Sep" (plus the year when it is not `today`'s year). */
export function formatShortDate(localDate: string, today?: string): string {
  const p = parts(localDate)
  const base = `${WEEKDAYS_SHORT[p.weekday - 1]} ${p.day} ${MONTHS_SHORT[p.month - 1]}`
  return today && today.slice(0, 4) !== localDate.slice(0, 4) ? `${base} ${p.year}` : base
}

/** "Thursday 24 September" (plus the year when it is not `today`'s year). */
export function formatLongDate(localDate: string, today?: string): string {
  const p = parts(localDate)
  const base = `${WEEKDAYS_LONG[p.weekday - 1]} ${p.day} ${MONTHS_LONG[p.month - 1]}`
  return today && today.slice(0, 4) !== localDate.slice(0, 4) ? `${base} ${p.year}` : base
}

/** "Today", "Tomorrow", "Yesterday" or "Thu 24 Sep". */
export function formatRelativeDate(localDate: string, today: string): string {
  if (localDate === today) return 'Today'
  if (localDate === addLocalDays(today, 1)) return 'Tomorrow'
  if (localDate === addLocalDays(today, -1)) return 'Yesterday'
  return formatShortDate(localDate, today)
}

/** "Today · 14:30", "Tomorrow", "Mon 28 Sep · 09:00". */
export function formatDueLabel(
  task: { dueDate: string | null; dueAt: Date | null },
  now: Date,
  tz: string,
): string | null {
  const today = localDateInZone(now, tz)
  if (task.dueAt) {
    const date = localDateInZone(task.dueAt, tz)
    return `${formatRelativeDate(date, today)} · ${localTimeInZone(task.dueAt, tz)}`
  }
  if (task.dueDate) return formatRelativeDate(task.dueDate, today)
  return null
}

/** "Today · 18:00" for an instant. */
export function formatInstantLabel(instant: Date, now: Date, tz: string): string {
  const today = localDateInZone(now, tz)
  return `${formatRelativeDate(localDateInZone(instant, tz), today)} · ${localTimeInZone(instant, tz)}`
}

/** A notice for a due/reminder time adjusted or disambiguated by DST, or null. */
export function dstNotice(
  requested: { date: string; time: string },
  outcome: { shiftedTo: string | null; ambiguous?: boolean },
  tz: string,
): string | null {
  const day = formatShortDate(requested.date)
  if (outcome.shiftedTo) {
    return `${requested.time} doesn’t exist on ${day} in ${tz} (the clocks go forward), so it was saved as ${outcome.shiftedTo}.`
  }
  if (outcome.ambiguous) {
    return `${requested.time} happens twice on ${day} in ${tz} (the clocks go back); the first one is used.`
  }
  return null
}
