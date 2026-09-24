/**
 * Optional available hours used by the daily planner.
 *
 * Stored in owner_settings.available_hours as [{ weekday, start, end }] where
 * weekday is ISO (Monday = 1 … Sunday = 7) and start/end are local 'HH:MM'
 * (24-hour) in the owner's timezone. `null` means "not set": the planner then
 * suggests an ordered list without inventing a working schedule.
 *
 * Slots on the same day may touch (09:00–12:00 and 12:00–13:00) but not overlap.
 */
import { z } from 'zod'

export const AVAILABLE_HOURS_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export const AvailableHoursTimeSchema = z
  .string()
  .regex(AVAILABLE_HOURS_TIME_RE, 'Use a 24-hour time like 09:30')

export const AvailableHoursWeekdaySchema = z.number().int().min(1).max(7)
export type AvailableHoursWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export const AVAILABLE_HOURS_WEEKDAYS: readonly AvailableHoursWeekday[] = [1, 2, 3, 4, 5, 6, 7]

export const AVAILABLE_HOURS_WEEKDAY_LABELS: Record<AvailableHoursWeekday, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
}

export const AVAILABLE_HOURS_WEEKDAY_SHORT_LABELS: Record<AvailableHoursWeekday, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
}

export const AVAILABLE_HOURS_MAX_SLOTS_PER_DAY = 6

export const AvailableHoursSlotSchema = z
  .strictObject({
    weekday: AvailableHoursWeekdaySchema,
    start: AvailableHoursTimeSchema,
    end: AvailableHoursTimeSchema,
  })
  .refine((slot) => slot.start < slot.end, {
    message: 'End time must be after the start time',
    path: ['end'],
  })
export interface AvailableHoursSlot {
  weekday: AvailableHoursWeekday
  start: string
  end: string
}
export type AvailableHours = AvailableHoursSlot[]

export const AvailableHoursSchema = z
  .array(AvailableHoursSlotSchema)
  .max(AVAILABLE_HOURS_MAX_SLOTS_PER_DAY * 7)
  .superRefine((slots, ctx) => {
    const byDay = new Map<number, { index: number; start: string; end: string }[]>()
    slots.forEach((slot, index) => {
      const list = byDay.get(slot.weekday) ?? []
      list.push({ index, start: slot.start, end: slot.end })
      byDay.set(slot.weekday, list)
    })
    for (const [weekday, list] of byDay) {
      const label = AVAILABLE_HOURS_WEEKDAY_LABELS[weekday as AvailableHoursWeekday]
      if (list.length > AVAILABLE_HOURS_MAX_SLOTS_PER_DAY) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} has more than ${AVAILABLE_HOURS_MAX_SLOTS_PER_DAY} time ranges`,
          path: [list[AVAILABLE_HOURS_MAX_SLOTS_PER_DAY]!.index],
        })
      }
      const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start))
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!
        const cur = sorted[i]!
        if (cur.start < prev.end) {
          ctx.addIssue({
            code: 'custom',
            message: `Overlaps ${prev.start}–${prev.end} on ${label}`,
            path: [cur.index, 'start'],
          })
        }
      }
    }
  })
  .transform((slots) => normalizeAvailableHours(slots as AvailableHours))

/** Sort by weekday then start time. Does not validate. */
export function normalizeAvailableHours(slots: AvailableHours): AvailableHours {
  return [...slots]
    .map((s) => ({ weekday: s.weekday, start: s.start, end: s.end }))
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start))
}

/**
 * Read what is stored. `null`/missing is "not set"; a stored value that fails
 * validation is reported as invalid rather than silently shown as empty.
 */
export function parseStoredAvailableHours(
  raw: unknown,
): { status: 'not_set' } | { status: 'set'; hours: AvailableHours } | { status: 'invalid' } {
  if (raw === null || raw === undefined) return { status: 'not_set' }
  const parsed = AvailableHoursSchema.safeParse(raw)
  if (!parsed.success) return { status: 'invalid' }
  if (parsed.data.length === 0) return { status: 'not_set' }
  return { status: 'set', hours: parsed.data }
}

export function availableHoursForWeekday(
  hours: AvailableHours,
  weekday: AvailableHoursWeekday,
): AvailableHoursSlot[] {
  return normalizeAvailableHours(hours.filter((s) => s.weekday === weekday))
}

function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** Total available minutes on a weekday (slots never overlap once validated). */
export function availableMinutesForWeekday(
  hours: AvailableHours,
  weekday: AvailableHoursWeekday,
): number {
  return availableHoursForWeekday(hours, weekday).reduce(
    (sum, s) => sum + minutes(s.end) - minutes(s.start),
    0,
  )
}

/**
 * Short human summary, grouping consecutive weekdays with identical ranges:
 * "Mon–Fri 09:00–17:30 · Sat 10:00–12:00". Returns null when nothing is set.
 */
export function summarizeAvailableHours(hours: AvailableHours | null): string | null {
  if (!hours || hours.length === 0) return null
  const dayKey = (d: AvailableHoursWeekday) =>
    availableHoursForWeekday(hours, d)
      .map((s) => `${s.start}–${s.end}`)
      .join(', ')
  const groups: { from: AvailableHoursWeekday; to: AvailableHoursWeekday; key: string }[] = []
  for (const day of AVAILABLE_HOURS_WEEKDAYS) {
    const key = dayKey(day)
    if (!key) continue
    const last = groups[groups.length - 1]
    if (last && last.key === key && last.to === day - 1) last.to = day
    else groups.push({ from: day, to: day, key })
  }
  return groups
    .map((g) => {
      const days =
        g.from === g.to
          ? AVAILABLE_HOURS_WEEKDAY_SHORT_LABELS[g.from]
          : `${AVAILABLE_HOURS_WEEKDAY_SHORT_LABELS[g.from]}–${AVAILABLE_HOURS_WEEKDAY_SHORT_LABELS[g.to]}`
      return `${days} ${g.key}`
    })
    .join(' · ')
}
