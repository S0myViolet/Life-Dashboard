/**
 * Reading progress from manual logs, computed honestly.
 *
 * Rules:
 *   - The latest *position* wins: a page reached or a percentage. Pages read in a
 *     session move the last position forward by that many pages.
 *   - With no position logged at all, pages read are counted from the start of the
 *     book (the first "read 20 pages" means page 20). This is labelled
 *     `pages_read_total` so the UI can say "45 pages read" rather than "page 45".
 *   - A percentage is shown only when it can be derived: the total page count is
 *     known, or the owner logged a percentage. When the total is unknown and pages
 *     were read after the last logged percentage, that percentage is returned with
 *     its date and `percentOutdated: true`; it is never extrapolated.
 *   - Finished books are 100%: the owner said so.
 *   - A page past the known total is reported (`pastTotal`) and the percentage is
 *     capped at 100, rather than showing "112%".
 */
import type { BookStatus } from './books.ts'

export interface ReadingLogForProgress {
  localDate: string
  /** Tie-breaker for several logs on the same day (insertion order when absent). */
  createdAt?: Date | string | number | null
  pageReached: number | null
  pagesRead: number | null
  percent: number | null
  minutes: number | null
}

export interface BookForProgress {
  totalPages: number | null
  status: BookStatus
}

export type ReadingPageBasis =
  /** From a logged page reached (plus pages read since). */
  | 'page_reached'
  /** Sum of pages read, counted from the start of the book: no position was ever logged. */
  | 'pages_read_total'
  /** Converted from a logged percentage using the total page count (plus pages read since). */
  | 'percent_of_total'
  /** The book is marked finished and its length is known. */
  | 'finished'

export type ReadingPercentBasis =
  /** Current page divided by the total page count. */
  | 'pages'
  /** The percentage the owner logged. */
  | 'logged'
  /** The book is marked finished. */
  | 'finished'

export interface ReadingProgress {
  /** Best known current page, or null when it cannot be derived. */
  currentPage: number | null
  pageBasis: ReadingPageBasis | null
  /** 0–100, unrounded. null when it cannot be derived honestly. */
  percent: number | null
  percentBasis: ReadingPercentBasis | null
  /** Date of the log the percentage reflects (null for a finished book or no percentage). */
  percentAsOf: string | null
  /** True when pages were read after the logged percentage and it could not be updated. */
  percentOutdated: boolean
  totalPages: number | null
  /** Pages left to read, only when both the current page and the total are known. */
  pagesLeft: number | null
  /** The current page is beyond the known total (the total is probably wrong). */
  pastTotal: boolean
  /** Sum of pages read across all logs. */
  pagesReadLogged: number
  /** Sum of minutes across all logs. */
  minutesLogged: number
  logCount: number
  firstLoggedOn: string | null
  lastLoggedOn: string | null
}

function createdAtMs(v: ReadingLogForProgress['createdAt']): number | null {
  if (v == null) return null
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/** Chronological order: local date, then creation time, then input order. */
export function sortReadingLogs<T extends ReadingLogForProgress>(logs: readonly T[]): T[] {
  return logs
    .map((log, index) => ({ log, index, ms: createdAtMs(log.createdAt) }))
    .sort((a, b) => {
      if (a.log.localDate !== b.log.localDate) return a.log.localDate < b.log.localDate ? -1 : 1
      if (a.ms != null && b.ms != null && a.ms !== b.ms) return a.ms - b.ms
      return a.index - b.index
    })
    .map((x) => x.log)
}

type Position =
  | { kind: 'none' }
  | { kind: 'page'; page: number; basis: 'page_reached' | 'pages_read_total' }
  | { kind: 'percent'; percent: number; on: string; pagesSince: number }

/** Move a position forward by pages read in a session. */
function advance(position: Position, pagesRead: number): Position {
  switch (position.kind) {
    case 'none':
      // Nothing logged before: count from the start of the book.
      return { kind: 'page', page: pagesRead, basis: 'pages_read_total' }
    case 'page':
      return { kind: 'page', page: position.page + pagesRead, basis: position.basis }
    case 'percent':
      return {
        kind: 'percent',
        percent: position.percent,
        on: position.on,
        pagesSince: position.pagesSince + pagesRead,
      }
  }
}

export function readingProgress(
  book: BookForProgress,
  logs: readonly ReadingLogForProgress[],
): ReadingProgress {
  const total = book.totalPages != null && book.totalPages > 0 ? book.totalPages : null
  let position: Position = { kind: 'none' }
  let pagesReadLogged = 0
  let minutesLogged = 0
  const sorted = sortReadingLogs(logs)

  for (const log of sorted) {
    if (log.pagesRead != null && log.pagesRead > 0) pagesReadLogged += log.pagesRead
    if (log.minutes != null && log.minutes > 0) minutesLogged += log.minutes

    if (log.pageReached != null) {
      // Pages read in the same log are already included in the page reached.
      position = { kind: 'page', page: log.pageReached, basis: 'page_reached' }
    } else if (log.percent != null) {
      position = { kind: 'percent', percent: log.percent, on: log.localDate, pagesSince: 0 }
    } else if (log.pagesRead != null && log.pagesRead > 0) {
      position = advance(position, log.pagesRead)
    }
  }

  let currentPage: number | null = null
  let pageBasis: ReadingPageBasis | null = null
  let percent: number | null = null
  let percentBasis: ReadingPercentBasis | null = null
  let percentAsOf: string | null = null
  let percentOutdated = false

  if (position.kind === 'page') {
    currentPage = position.page
    pageBasis = position.basis
    if (total != null) {
      percent = (currentPage * 100) / total
      percentBasis = 'pages'
      percentAsOf = sorted.at(-1)?.localDate ?? null
    }
  } else if (position.kind === 'percent') {
    if (total != null) {
      // Multiply first and absorb binary noise: (58 / 100) * 100 is 57.99999999999999.
      currentPage = Math.floor((position.percent * total) / 100 + 1e-9) + position.pagesSince
      pageBasis = 'percent_of_total'
      if (position.pagesSince === 0) {
        percent = position.percent
        percentBasis = 'logged'
        percentAsOf = position.on
      } else {
        percent = (currentPage * 100) / total
        percentBasis = 'pages'
        percentAsOf = sorted.at(-1)?.localDate ?? null
      }
    } else {
      percent = position.percent
      percentBasis = 'logged'
      percentAsOf = position.on
      percentOutdated = position.pagesSince > 0
    }
  }

  let pastTotal = total != null && currentPage != null && currentPage > total

  if (book.status === 'finished') {
    pastTotal = false
    percent = 100
    percentBasis = 'finished'
    percentAsOf = null
    percentOutdated = false
    if (total != null) {
      currentPage = total
      pageBasis = 'finished'
    }
  } else if (percent != null) {
    percent = Math.min(100, Math.max(0, percent))
  }

  const pagesLeft =
    total != null && currentPage != null ? Math.max(0, total - Math.min(currentPage, total)) : null

  return {
    currentPage,
    pageBasis,
    percent,
    percentBasis,
    percentAsOf,
    percentOutdated,
    totalPages: total,
    pagesLeft,
    pastTotal,
    pagesReadLogged,
    minutesLogged,
    logCount: sorted.length,
    firstLoggedOn: sorted[0]?.localDate ?? null,
    lastLoggedOn: sorted.at(-1)?.localDate ?? null,
  }
}

/**
 * Display a percentage without overstating it: rounded *down* to one decimal, so
 * 299 of 300 pages reads "99.6%", never "100%" until the end is actually reached.
 */
export function formatReadingPercent(percent: number): string {
  if (percent >= 100) return '100%'
  // The epsilon absorbs binary noise (58 / 100 * 100 is 57.99999999999999) without rounding up.
  const floored = Math.floor(Math.max(0, percent) * 10 + 1e-9) / 10
  return `${Number.isInteger(floored) ? floored.toFixed(0) : floored.toFixed(1)}%`
}
