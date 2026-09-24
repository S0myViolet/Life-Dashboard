/**
 * Reading list repository: public.books and public.reading_logs.
 *
 * Every function takes an owner transaction (withOwner): Row Level Security decides
 * what is visible, so a non-owner reads nothing and cannot write. Inputs are parsed
 * with the core schemas here as well as at the UI boundary.
 *
 * `today` is always the owner-local date ('YYYY-MM-DD'), supplied by the caller.
 */
import {
  bookDatesForStatus,
  BookInputSchema,
  BookStatusSchema,
  bookStatusAfterLog,
  CalendarDateSchema,
  readingLogProblem,
  ReadingLogInputSchema,
  readingProgress,
  type BookInput,
  type BookStatus,
  type ReadingLogInput,
  type ReadingProgress,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

export interface Book {
  id: string
  title: string
  author: string | null
  totalPages: number | null
  status: BookStatus
  startedOn: string | null
  finishedOn: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ReadingLog {
  id: string
  bookId: string
  localDate: string
  pagesRead: number | null
  pageReached: number | null
  percent: number | null
  minutes: number | null
  note: string | null
  createdAt: Date
}

export interface BookWithProgress extends Book {
  progress: ReadingProgress
  lastLog: ReadingLog | null
}

export interface BookDetail {
  book: Book
  progress: ReadingProgress
  /** Newest first. */
  logs: ReadingLog[]
}

export interface BookOption {
  id: string
  title: string
  author: string | null
  status: BookStatus
  totalPages: number | null
}

/** Expected failures come back as values; unexpected ones (database errors) throw. */
export type LearningResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid'; field: string; message: string }

const bookColumns = (tx: Tx) =>
  tx`id, title, author, total_pages, status, started_on, finished_on, created_at, updated_at`

// numeric(5,2) arrives as a string from the driver; float8 is exact for two decimals' display.
const logColumns = (tx: Tx) =>
  tx`id, book_id, local_date, pages_read, page_reached, percent::float8 as percent, minutes, note, created_at`

const STATUS_ORDER = ['reading', 'paused', 'want', 'finished'] as const

function requireToday(today: string): string {
  return CalendarDateSchema.parse(today)
}

export async function createBook(tx: Tx, input: BookInput, today: string): Promise<Book> {
  const fields = BookInputSchema.parse(input)
  const dates = bookDatesForStatus(fields, requireToday(today))
  const [row] = await tx<Book[]>`
    insert into public.books (title, author, total_pages, status, started_on, finished_on)
    values (${fields.title}, ${fields.author}, ${fields.totalPages}, ${fields.status},
            ${dates.startedOn}, ${dates.finishedOn})
    returning ${bookColumns(tx)}
  `
  if (!row) throw new Error('insert into books returned no row')
  return row
}

export async function updateBook(
  tx: Tx,
  id: string,
  input: BookInput,
  today: string,
): Promise<Book | null> {
  const fields = BookInputSchema.parse(input)
  const dates = bookDatesForStatus(fields, requireToday(today))
  const [row] = await tx<Book[]>`
    update public.books
    set title = ${fields.title}, author = ${fields.author}, total_pages = ${fields.totalPages},
        status = ${fields.status}, started_on = ${dates.startedOn}, finished_on = ${dates.finishedOn}
    where id = ${id}::uuid
    returning ${bookColumns(tx)}
  `
  return row ?? null
}

/** Change only the status, filling in the dates it implies. */
export async function setBookStatus(
  tx: Tx,
  id: string,
  status: BookStatus,
  today: string,
): Promise<Book | null> {
  const next = BookStatusSchema.parse(status)
  const book = await getBook(tx, id, { forUpdate: true })
  if (!book) return null
  const dates = bookDatesForStatus({ ...book, status: next }, requireToday(today))
  const [row] = await tx<Book[]>`
    update public.books
    set status = ${next}, started_on = ${dates.startedOn}, finished_on = ${dates.finishedOn}
    where id = ${id}::uuid
    returning ${bookColumns(tx)}
  `
  return row ?? null
}

export async function deleteBook(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx`delete from public.books where id = ${id}::uuid returning id`
  return rows.length > 0
}

export async function getBook(
  tx: Tx,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Book | null> {
  const [row] = await tx<Book[]>`
    select ${bookColumns(tx)} from public.books where id = ${id}::uuid
    ${options.forUpdate ? tx`for update` : tx``}
  `
  return row ?? null
}

/** Small list for pickers (quick capture, goal forms). Reading first, finished last. */
export async function listBookOptions(
  tx: Tx,
  options: { statuses?: readonly BookStatus[] } = {},
): Promise<BookOption[]> {
  const statuses = (options.statuses ?? STATUS_ORDER).map((s) => BookStatusSchema.parse(s))
  return tx<BookOption[]>`
    select id, title, author, status, total_pages
    from public.books
    where status = any(${statuses}::text[])
    order by array_position(${[...STATUS_ORDER]}::text[], status), lower(title), id
  `
}

/**
 * Books with their computed progress. Reading and paused books come first, ordered by
 * most recent activity; then want-to-read; then finished (most recently finished first).
 */
export async function listBooksWithProgress(
  tx: Tx,
  options: { statuses?: readonly BookStatus[] } = {},
): Promise<BookWithProgress[]> {
  const statuses = (options.statuses ?? STATUS_ORDER).map((s) => BookStatusSchema.parse(s))
  const books = await tx<(Book & { lastActivity: Date })[]>`
    select ${bookColumns(tx)},
           greatest(b.updated_at, (select max(l.created_at) from public.reading_logs l where l.book_id = b.id))
             as last_activity
    from public.books b
    where b.status = any(${statuses}::text[])
    order by array_position(${[...STATUS_ORDER]}::text[], b.status),
             b.finished_on desc nulls last,
             last_activity desc,
             b.id
  `
  if (books.length === 0) return []
  const byBook = await listReadingLogsForBooks(
    tx,
    books.map((b) => b.id),
  )
  return books.map(({ lastActivity: _lastActivity, ...book }) => {
    const bookLogs = byBook.get(book.id) ?? []
    return {
      ...book,
      progress: readingProgress(book, bookLogs),
      lastLog: bookLogs.at(-1) ?? null,
    }
  })
}

export async function getBookDetail(tx: Tx, id: string): Promise<BookDetail | null> {
  const book = await getBook(tx, id)
  if (!book) return null
  const logs = await listReadingLogs(tx, id)
  return { book, progress: readingProgress(book, logs), logs: [...logs].reverse() }
}

/** Logs for several books, each list in chronological order (oldest first). */
export async function listReadingLogsForBooks(
  tx: Tx,
  bookIds: readonly string[],
): Promise<Map<string, ReadingLog[]>> {
  const byBook = new Map<string, ReadingLog[]>()
  if (bookIds.length === 0) return byBook
  const logs = await tx<ReadingLog[]>`
    select ${logColumns(tx)} from public.reading_logs
    where book_id = any(${[...bookIds]}::uuid[])
    order by local_date, created_at, id
  `
  for (const log of logs) {
    const list = byBook.get(log.bookId)
    if (list) list.push(log)
    else byBook.set(log.bookId, [log])
  }
  return byBook
}

/** A book's logs in chronological order (oldest first). */
export async function listReadingLogs(tx: Tx, bookId: string): Promise<ReadingLog[]> {
  return tx<ReadingLog[]>`
    select ${logColumns(tx)} from public.reading_logs
    where book_id = ${bookId}::uuid
    order by local_date, created_at, id
  `
}

export interface RecordedReadingLog {
  log: ReadingLog
  book: Book
  progress: ReadingProgress
  /** The status the book moved from, when logging started or resumed it. */
  statusChangedFrom: BookStatus | null
}

/**
 * Save a reading log. Any one measure is enough (see ReadingLogInputSchema). Logging on a
 * want-to-read or paused book marks it as reading. The book row is locked so concurrent
 * logs for one book serialise.
 */
export async function recordReadingLog(
  tx: Tx,
  input: ReadingLogInput,
  today: string,
): Promise<LearningResult<RecordedReadingLog>> {
  const fields = ReadingLogInputSchema.parse(input)
  const localDate = fields.localDate ?? requireToday(today)
  if (localDate > requireToday(today)) {
    return {
      ok: false,
      reason: 'invalid',
      field: 'localDate',
      message: 'That date is in the future',
    }
  }
  const book = await getBook(tx, fields.bookId, { forUpdate: true })
  if (!book) return { ok: false, reason: 'not_found' }
  const problem = readingLogProblem(fields, book)
  if (problem) return { ok: false, reason: 'invalid', field: 'pageReached', message: problem }

  const [log] = await tx<ReadingLog[]>`
    insert into public.reading_logs (book_id, local_date, pages_read, page_reached, percent, minutes, note)
    values (${book.id}::uuid, ${localDate}, ${fields.pagesRead}, ${fields.pageReached},
            ${fields.percent}, ${fields.minutes}, ${fields.note})
    returning ${logColumns(tx)}
  `
  if (!log) throw new Error('insert into reading_logs returned no row')

  let current = book
  let statusChangedFrom: BookStatus | null = null
  const nextStatus = bookStatusAfterLog(book.status)
  if (nextStatus !== book.status) {
    const dates = bookDatesForStatus({ ...book, status: nextStatus }, localDate)
    const [updated] = await tx<Book[]>`
      update public.books
      set status = ${nextStatus}, started_on = ${dates.startedOn}, finished_on = ${dates.finishedOn}
      where id = ${book.id}::uuid
      returning ${bookColumns(tx)}
    `
    if (updated) {
      current = updated
      statusChangedFrom = book.status
    }
  }

  const logs = await listReadingLogs(tx, book.id)
  return {
    ok: true,
    value: { log, book: current, progress: readingProgress(current, logs), statusChangedFrom },
  }
}

/** Delete one log. Returns the book it belonged to, or null when there was no such log. */
export async function deleteReadingLog(tx: Tx, logId: string): Promise<{ bookId: string } | null> {
  const [row] = await tx<{ bookId: string }[]>`
    delete from public.reading_logs where id = ${logId}::uuid returning book_id
  `
  return row ?? null
}

/** Minutes logged on one local date, per book and in total (a true 0 when nothing was logged). */
export async function readingMinutesOn(
  tx: Tx,
  localDate: string,
): Promise<{ total: number; byBook: Map<string, number> }> {
  const rows = await tx<{ bookId: string; minutes: number }[]>`
    select book_id, sum(minutes)::int as minutes
    from public.reading_logs
    where local_date = ${CalendarDateSchema.parse(localDate)} and minutes is not null
    group by book_id
  `
  const byBook = new Map(rows.map((r) => [r.bookId, r.minutes]))
  return { total: rows.reduce((sum, r) => sum + r.minutes, 0), byBook }
}
