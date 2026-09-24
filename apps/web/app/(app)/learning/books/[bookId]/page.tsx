import { notFound } from 'next/navigation'
import { z } from 'zod'
import { BOOK_STATUS_LABELS, formatReadingPercent, type BookStatus } from '@personal-home/core'
import { getBookDetail, type ReadingLog } from '@personal-home/db'
import {
  deleteBookAction,
  deleteReadingLogAction,
  setBookStatusAction,
} from '@/app/(app)/learning/actions'
import { PageHeader } from '@/components/shell/app-shell'
import { ButtonLink, buttonClass } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { BookForm } from '@/components/learning/book-form'
import { ConfirmDeleteButton } from '@/components/learning/form-kit'
import {
  formatLocalDate,
  plural,
  progressHeadline,
  progressNotes,
} from '@/components/learning/format'
import { LogReadingForm } from '@/components/learning/log-reading-form'
import { ownerToday } from '@/components/learning/owner-today'
import { ReadingProgressBar } from '@/components/learning/progress-bar'
import { defaultMeasureFor } from '@/components/learning/reading-sections'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Book' }

const STATUS_BUTTONS: Record<BookStatus, { status: BookStatus; label: string }[]> = {
  want: [{ status: 'reading', label: 'Start reading' }],
  reading: [
    { status: 'finished', label: 'Mark finished' },
    { status: 'paused', label: 'Pause' },
  ],
  paused: [
    { status: 'reading', label: 'Resume' },
    { status: 'finished', label: 'Mark finished' },
  ],
  finished: [{ status: 'reading', label: 'Reading again' }],
}

function logSummary(log: ReadingLog): string {
  const parts: string[] = []
  if (log.pageReached != null) parts.push(`Reached page ${log.pageReached}`)
  if (log.percent != null) parts.push(`${formatReadingPercent(log.percent)} through`)
  if (log.pagesRead != null) parts.push(`${plural(log.pagesRead, 'page')} read`)
  if (log.minutes != null) parts.push(`${log.minutes} min`)
  return parts.join(' · ')
}

export default async function BookPage({ params }: { params: Promise<{ bookId: string }> }) {
  await requireOwner()
  const { bookId } = await params
  if (!z.uuid().safeParse(bookId).success) notFound()
  const data = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    return { detail: await getBookDetail(tx, bookId), today }
  })
  if (!data.detail) notFound()
  const { detail, today } = data
  const { book, progress, logs } = detail
  const notes = progressNotes(progress, today)

  return (
    <>
      <PageHeader
        title={book.title}
        subtitle={
          <>
            {book.author ? <span>{book.author} · </span> : null}
            <span>{BOOK_STATUS_LABELS[book.status]}</span>
          </>
        }
        actions={<ButtonLink href="/learning">All books</ButtonLink>}
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 space-y-4 lg:col-span-3">
          <Card aria-labelledby="progress-title">
            <CardHeader id="progress-title" title="Progress" />
            <p className="text-[15px] text-ink" data-testid="book-progress">
              {progressHeadline(progress)}
            </p>
            {progress.percent != null ? (
              <div className="mt-2">
                <ReadingProgressBar percent={progress.percent} label={`${book.title} progress`} />
              </div>
            ) : null}
            {notes.map((n) => (
              <p key={n} className="mt-1 text-xs text-ink-muted">
                {n}
              </p>
            ))}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-ink-faint">Started</dt>
                <dd className="text-ink">
                  {book.startedOn ? formatLocalDate(book.startedOn, { today }) : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-faint">Finished</dt>
                <dd className="text-ink">
                  {book.finishedOn ? formatLocalDate(book.finishedOn, { today }) : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-faint">Logs</dt>
                <dd className="text-ink">{progress.logCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-faint">Minutes logged</dt>
                <dd className="text-ink">{progress.minutesLogged}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              {STATUS_BUTTONS[book.status].map((b) => (
                <form key={b.status} action={setBookStatusAction.bind(null, book.id, b.status)}>
                  <button
                    type="submit"
                    className={buttonClass(b.status === 'finished' ? 'primary' : 'secondary')}
                  >
                    {b.label}
                  </button>
                </form>
              ))}
            </div>
          </Card>

          <Card aria-labelledby="log-title">
            <CardHeader id="log-title" title="Log progress" />
            <LogReadingForm
              bookId={book.id}
              bookTitle={book.title}
              defaultMeasure={defaultMeasureFor({ lastLog: logs[0] ?? null })}
              totalPages={book.totalPages}
              today={today}
            />
          </Card>

          <Card aria-labelledby="history-title">
            <CardHeader
              id="history-title"
              title="History"
              meta={logs.length ? plural(logs.length, 'entry', 'entries') : undefined}
            />
            {logs.length ? (
              <ul className="divide-y divide-line" data-testid="reading-history">
                {logs.map((log) => (
                  <li key={log.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm text-ink">{logSummary(log)}</p>
                      <p className="text-xs text-ink-faint">
                        {formatLocalDate(log.localDate, { today, weekday: true })}
                      </p>
                      {log.note ? (
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-muted">
                          {log.note}
                        </p>
                      ) : null}
                    </div>
                    <form action={deleteReadingLogAction.bind(null, log.id)}>
                      <button type="submit" className={buttonClass('ghost', 'shrink-0')}>
                        Remove
                        <span className="sr-only">
                          {' '}
                          log from {formatLocalDate(log.localDate, { withYear: true })}
                        </span>
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No progress logged yet">
                Log a page, pages read or a percentage — any one is enough.
              </EmptyState>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card aria-labelledby="edit-title">
            <CardHeader
              id="edit-title"
              title="Details"
              meta={book.status === 'finished' ? <Pill tone="positive">Finished</Pill> : undefined}
            />
            <BookForm
              idPrefix="edit-book"
              book={{
                id: book.id,
                title: book.title,
                author: book.author,
                totalPages: book.totalPages,
                status: book.status,
                startedOn: book.startedOn,
                finishedOn: book.finishedOn,
              }}
            />
          </Card>
          <Card aria-labelledby="remove-title">
            <CardHeader id="remove-title" title="Remove" />
            <p className="mb-2 text-sm text-ink-muted">
              Deleting a book also deletes its reading history. Goals linked to it stay, without the
              book.
            </p>
            <ConfirmDeleteButton
              action={deleteBookAction.bind(null, book.id)}
              label="Delete book"
              confirmLabel="Delete"
              question={`Delete “${book.title}”?`}
            />
          </Card>
        </div>
      </div>
    </>
  )
}
