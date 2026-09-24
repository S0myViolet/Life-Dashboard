/**
 * Display helpers for owner-local dates and reading progress. Local dates are
 * 'YYYY-MM-DD' strings; they are formatted as UTC calendar dates so no timezone
 * can shift them by a day.
 */
import { formatReadingPercent, localDaysBetween, type ReadingProgress } from '@personal-home/core'

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

export function monthName(month: number, style: 'long' | 'short' = 'long'): string {
  const name = MONTHS_LONG[month - 1] ?? String(month)
  return style === 'short' ? name.slice(0, 3) : name
}

/** '2026-09-24' → '24 Sep' (or '24 Sep 2026' with the year, or when not this year). */
export function formatLocalDate(
  localDate: string,
  options: { today?: string; withYear?: boolean; weekday?: boolean } = {},
): string {
  const [y, m, d] = localDate.split('-').map(Number)
  if (!y || !m || !d) return localDate
  const showYear =
    options.withYear ||
    (options.today ? options.today.slice(0, 4) !== localDate.slice(0, 4) : false)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(showYear ? { year: 'numeric' } : {}),
    ...(options.weekday ? { weekday: 'short' } : {}),
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** 'today', 'yesterday', '3 days ago', 'tomorrow', 'in 5 days'. */
export function relativeDay(localDate: string, today: string): string {
  const n = localDaysBetween(today, localDate)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** One line describing where the owner is in a book, without claiming more than is known. */
export function progressHeadline(p: ReadingProgress): string {
  if (p.percentBasis === 'finished') {
    return p.totalPages != null ? `Finished · ${plural(p.totalPages, 'page')}` : 'Finished'
  }
  const parts: string[] = []
  if (p.currentPage != null) {
    const of = p.totalPages != null ? ` of ${p.totalPages}` : ''
    if (p.pageBasis === 'pages_read_total') parts.push(`${plural(p.currentPage, 'page')} read${of}`)
    else if (p.pageBasis === 'percent_of_total') parts.push(`About page ${p.currentPage}${of}`)
    else parts.push(`Page ${p.currentPage}${of}`)
  }
  if (p.percent != null) parts.push(formatReadingPercent(p.percent))
  if (parts.length === 0) {
    return p.logCount > 0 ? 'Time logged, no position yet' : 'No progress logged yet'
  }
  return parts.join(' · ')
}

/** Caveats worth showing next to the headline, in plain words. */
export function progressNotes(p: ReadingProgress, today: string): string[] {
  const notes: string[] = []
  if (p.percentOutdated && p.percentAsOf) {
    notes.push(
      `Percentage as of ${formatLocalDate(p.percentAsOf, { today })}; pages read since can't be converted without the total page count.`,
    )
  }
  if (p.pastTotal && p.totalPages != null) {
    notes.push(`Past the ${p.totalPages} pages recorded for this book — check the total.`)
  }
  if (p.percent == null && p.currentPage != null && p.totalPages == null) {
    notes.push('Add the total pages to see a percentage.')
  }
  return notes
}
