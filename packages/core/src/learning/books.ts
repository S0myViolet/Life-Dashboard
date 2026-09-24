/**
 * Reading list: books, their status and the owner's manual reading logs.
 *
 * Progress is entered by hand (brief §1: "Reading progress will be logged manually").
 * A log needs only one measure: the page reached, the pages read in a session, a
 * percentage, or minutes spent (brief §2: "pages or percentage per book without
 * requiring both").
 */
import { z } from 'zod'
import { CalendarDateSchema } from '../time/index.ts'

export const BOOK_STATUSES = ['want', 'reading', 'paused', 'finished'] as const
export const BookStatusSchema = z.enum(BOOK_STATUSES)
export type BookStatus = z.infer<typeof BookStatusSchema>

export const BOOK_STATUS_LABELS: Record<BookStatus, string> = {
  want: 'Want to read',
  reading: 'Reading',
  paused: 'Paused',
  finished: 'Finished',
}

/** Limits mirror the checks in supabase/migrations/20260924001000_m1_schema.sql. */
export const BOOK_LIMITS = {
  titleMax: 300,
  authorMax: 200,
  totalPagesMax: 20_000,
  pageReachedMax: 20_000,
  pagesReadMax: 5_000,
  minutesMax: 1_440,
  noteMax: 2_000,
} as const

/** '' and whitespace-only become null; other strings are trimmed. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

export const BookInputSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the book a title').max(BOOK_LIMITS.titleMax),
    author: optionalText(BOOK_LIMITS.authorMax),
    totalPages: z
      .number()
      .int('Total pages must be a whole number')
      .min(1)
      .max(BOOK_LIMITS.totalPagesMax)
      .nullish()
      .transform((v) => v ?? null),
    status: BookStatusSchema.default('want'),
    startedOn: CalendarDateSchema.nullish().transform((v) => v ?? null),
    finishedOn: CalendarDateSchema.nullish().transform((v) => v ?? null),
  })
  .refine((b) => !b.startedOn || !b.finishedOn || b.finishedOn >= b.startedOn, {
    message: 'The finish date is before the start date',
    path: ['finishedOn'],
  })
export type BookInput = z.input<typeof BookInputSchema>
export type BookFields = z.output<typeof BookInputSchema>

/**
 * Fill in the dates a status change implies, without overwriting dates the owner gave:
 * starting to read records a start date, finishing records a finish date, and a book
 * that is no longer finished loses its finish date.
 */
export function bookDatesForStatus(
  fields: { status: BookStatus; startedOn: string | null; finishedOn: string | null },
  today: string,
): { startedOn: string | null; finishedOn: string | null } {
  let { startedOn, finishedOn } = fields
  if ((fields.status === 'reading' || fields.status === 'paused') && !startedOn) startedOn = today
  if (fields.status === 'finished') {
    finishedOn ??= today
    if (startedOn && startedOn > finishedOn) startedOn = finishedOn
  } else {
    finishedOn = null
  }
  return { startedOn, finishedOn }
}

/** Percentages are stored as numeric(5, 2). */
function roundPercent(p: number): number {
  return Math.round(p * 100) / 100
}

/**
 * One reading log. Any one measure is enough. The page reached and a percentage are
 * both *positions*, so a single log may carry at most one of them; pages read and
 * minutes describe the session and can accompany either.
 */
export const ReadingLogInputSchema = z
  .object({
    bookId: z.uuid(),
    /** Owner-local date of the reading. Defaults to the owner's today at the boundary. */
    localDate: CalendarDateSchema.optional(),
    pageReached: z
      .number()
      .int('Page must be a whole number')
      .min(0)
      .max(BOOK_LIMITS.pageReachedMax)
      .nullish()
      .transform((v) => v ?? null),
    pagesRead: z
      .number()
      .int('Pages read must be a whole number')
      .min(1, 'Pages read must be at least 1')
      .max(BOOK_LIMITS.pagesReadMax)
      .nullish()
      .transform((v) => v ?? null),
    percent: z
      .number()
      .min(0, 'Percentage must be between 0 and 100')
      .max(100, 'Percentage must be between 0 and 100')
      .nullish()
      .transform((v) => (v == null ? null : roundPercent(v))),
    minutes: z
      .number()
      .int('Minutes must be a whole number')
      .min(1)
      .max(BOOK_LIMITS.minutesMax)
      .nullish()
      .transform((v) => v ?? null),
    note: optionalText(BOOK_LIMITS.noteMax),
  })
  .refine(
    (l) => l.pageReached != null || l.pagesRead != null || l.percent != null || l.minutes != null,
    { message: 'Enter a page, pages read, a percentage or minutes', path: ['pageReached'] },
  )
  .refine((l) => l.pageReached == null || l.percent == null, {
    message: 'Give either the page reached or a percentage, not both',
    path: ['percent'],
  })
export type ReadingLogInput = z.input<typeof ReadingLogInputSchema>
export type ReadingLogFields = z.output<typeof ReadingLogInputSchema>

/**
 * Consistency checks that need the book: a page past the book's known length is
 * rejected (the owner should correct the total first) rather than silently capped.
 */
export function readingLogProblem(
  log: Pick<ReadingLogFields, 'pageReached'>,
  book: { totalPages: number | null },
): string | null {
  if (log.pageReached != null && book.totalPages != null && log.pageReached > book.totalPages) {
    return `Page ${log.pageReached} is past the end of this book (${book.totalPages} pages). Update the total pages first.`
  }
  return null
}

/**
 * The status a book should move to when progress is logged: logging on a book you
 * wanted to read or had paused means you are reading it. Finished books stay finished.
 */
export function bookStatusAfterLog(status: BookStatus): BookStatus {
  return status === 'want' || status === 'paused' ? 'reading' : status
}
