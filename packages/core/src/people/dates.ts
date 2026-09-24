/**
 * Important dates (birthdays, anniversaries): a month and day, with an optional year.
 *
 * 29 February in a year without one is observed on 28 February, so the reminder
 * still lands before the day has passed and in the same month. The occurrence says
 * so (`observedFromFeb29`) and the UI labels it.
 */
import { z } from 'zod'
import { localDaysBetween } from '../time/index.ts'

export interface ImportantDateLike {
  month: number
  day: number
  year: number | null
}

export interface ImportantDateOccurrence {
  /** The local date the next occurrence is observed on (today or later). */
  date: string
  /** Whole days from today: 0 means today. */
  daysUntil: number
  /** True when a 29 February date falls on 28 February because the year has no 29th. */
  observedFromFeb29: boolean
  /** Years since the original date (e.g. the age being turned), when the year is known. */
  years: number | null
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Days in a month; February counts 29 when `year` is unknown (it could be a leap year). */
export function daysInMonth(month: number, year: number | null = null): number {
  if (month === 2) return year == null || isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function isValidImportantDate(d: ImportantDateLike): boolean {
  return (
    Number.isInteger(d.month) &&
    Number.isInteger(d.day) &&
    d.month >= 1 &&
    d.month <= 12 &&
    d.day >= 1 &&
    d.day <= daysInMonth(d.month, d.year) &&
    (d.year == null || (Number.isInteger(d.year) && d.year >= 1900 && d.year <= 2200))
  )
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function parseYear(localDate: string): number {
  const year = Number(localDate.slice(0, 4))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !Number.isInteger(year)) {
    throw new RangeError(`invalid local date (expected YYYY-MM-DD): ${localDate}`)
  }
  return year
}

/** Where a month/day falls in a given year (29 Feb → 28 Feb in common years). */
export function importantDateInYear(
  d: Pick<ImportantDateLike, 'month' | 'day'>,
  year: number,
): { date: string; observedFromFeb29: boolean } {
  const shifted = d.month === 2 && d.day === 29 && !isLeapYear(year)
  const day = shifted ? 28 : d.day
  return { date: `${pad(year, 4)}-${pad(d.month)}-${pad(day)}`, observedFromFeb29: shifted }
}

/**
 * The next occurrence on or after `today` (an owner-local 'YYYY-MM-DD'). A date with a
 * year in the future first occurs in that year.
 */
export function nextImportantDateOccurrence(
  d: ImportantDateLike,
  today: string,
): ImportantDateOccurrence {
  if (!isValidImportantDate(d)) {
    throw new RangeError(`invalid important date: ${d.year ?? '----'}-${d.month}-${d.day}`)
  }
  const todayYear = parseYear(today)
  let year = todayYear
  let occurrence = importantDateInYear(d, year)
  if (occurrence.date < today) {
    year += 1
    occurrence = importantDateInYear(d, year)
  }
  if (d.year != null && year < d.year) {
    year = d.year
    occurrence = importantDateInYear(d, year)
  }
  return {
    date: occurrence.date,
    daysUntil: localDaysBetween(today, occurrence.date),
    observedFromFeb29: occurrence.observedFromFeb29,
    years: d.year == null ? null : year - d.year,
  }
}

/** Upcoming occurrences within `horizonDays` of today (inclusive), soonest first. */
export function upcomingImportantDates<T extends ImportantDateLike>(
  dates: readonly T[],
  today: string,
  horizonDays: number,
): Array<{ date: T; occurrence: ImportantDateOccurrence }> {
  return dates
    .map((date) => ({ date, occurrence: nextImportantDateOccurrence(date, today) }))
    .filter((x) => x.occurrence.daysUntil <= horizonDays)
    .sort((a, b) => a.occurrence.daysUntil - b.occurrence.daysUntil)
}

export const PERSON_DATE_LIMITS = {
  labelMax: 80,
  yearMin: 1900,
  yearMax: 2200,
  remindDaysBeforeMax: 60,
  remindDaysBeforeDefault: 7,
} as const

export const PersonDateInputSchema = z
  .object({
    label: z.string().trim().min(1, 'Give the date a label').max(PERSON_DATE_LIMITS.labelMax),
    month: z.number().int().min(1, 'Pick a month').max(12, 'Pick a month'),
    day: z.number().int().min(1, 'Pick a day').max(31, 'Pick a day'),
    year: z
      .number()
      .int('Year must be a whole number')
      .min(PERSON_DATE_LIMITS.yearMin, `Year must be ${PERSON_DATE_LIMITS.yearMin} or later`)
      .max(PERSON_DATE_LIMITS.yearMax, `Year must be ${PERSON_DATE_LIMITS.yearMax} or earlier`)
      .nullish()
      .transform((v) => v ?? null),
    remindDaysBefore: z
      .number()
      .int()
      .min(0)
      .max(PERSON_DATE_LIMITS.remindDaysBeforeMax)
      .default(PERSON_DATE_LIMITS.remindDaysBeforeDefault),
  })
  .superRefine((d, ctx) => {
    if (d.day > daysInMonth(d.month, d.year)) {
      ctx.addIssue({
        code: 'custom',
        path: ['day'],
        message:
          d.month === 2 && d.day === 29 && d.year != null
            ? `${d.year} has no 29 February`
            : 'That day does not exist in this month',
      })
    }
  })
export type PersonDateInput = z.input<typeof PersonDateInputSchema>
export type PersonDateFields = z.output<typeof PersonDateInputSchema>
