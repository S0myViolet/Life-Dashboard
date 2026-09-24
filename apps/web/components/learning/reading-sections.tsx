import Link from 'next/link'
import { BOOK_STATUS_LABELS } from '@personal-home/core'
import { listBooksWithProgress, type BookWithProgress } from '@personal-home/db'
import { setBookStatusAction } from '@/app/(app)/learning/actions'
import { buttonClass } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { withOwnerTx } from '@/lib/server/session'
import { formatLocalDate, plural, progressHeadline, progressNotes, relativeDay } from './format'
import { LogReadingForm, type ReadingMeasure } from './log-reading-form'
import { ownerToday } from './owner-today'
import { ReadingProgressBar } from './progress-bar'

/** The measure to preselect: whatever the owner used last, else page reached. */
export function defaultMeasureFor(book: Pick<BookWithProgress, 'lastLog'>): ReadingMeasure {
  const last = book.lastLog
  if (last?.percent != null) return 'percent'
  if (last?.pageReached != null) return 'page'
  if (last?.pagesRead != null) return 'pages'
  return 'page'
}

function BookTitle({ book }: { book: BookWithProgress }) {
  return (
    <div className="min-w-0">
      <h3 className="text-[15px] font-medium text-ink">
        <Link
          href={`/learning/books/${book.id}`}
          className="inline-flex min-h-11 items-center rounded-sm hover:text-accent-strong hover:underline sm:min-h-0"
        >
          {book.title}
        </Link>
      </h3>
      {book.author ? <p className="text-sm text-ink-muted">{book.author}</p> : null}
    </div>
  )
}

function CurrentBook({ book, today }: { book: BookWithProgress; today: string }) {
  const p = book.progress
  const notes = progressNotes(p, today)
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0" data-testid="current-book">
      <div className="flex items-start justify-between gap-3">
        <BookTitle book={book} />
        {book.status === 'paused' ? <Pill tone="caution">Paused</Pill> : null}
      </div>
      <p className="text-sm text-ink" data-testid="book-progress">
        {progressHeadline(p)}
      </p>
      {p.percent != null ? (
        <ReadingProgressBar percent={p.percent} label={`${book.title} progress`} />
      ) : null}
      {notes.map((n) => (
        <p key={n} className="text-xs text-ink-muted">
          {n}
        </p>
      ))}
      <p className="text-xs text-ink-faint">
        {p.lastLoggedOn
          ? `Last logged ${relativeDay(p.lastLoggedOn, today)}`
          : book.startedOn
            ? `Started ${formatLocalDate(book.startedOn, { today })}`
            : 'Not logged yet'}
      </p>
      <details className="rounded-xl border border-line bg-surface-muted/40 px-3 open:pb-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent hover:text-accent-strong">
          Log progress
        </summary>
        <div className="pt-1">
          <LogReadingForm
            bookId={book.id}
            bookTitle={book.title}
            defaultMeasure={defaultMeasureFor(book)}
            totalPages={book.totalPages}
            today={today}
          />
        </div>
      </details>
    </li>
  )
}

function WantBook({ book }: { book: BookWithProgress }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
      <BookTitle book={book} />
      <form action={setBookStatusAction.bind(null, book.id, 'reading')}>
        <button type="submit" className={buttonClass('secondary')}>
          Start reading<span className="sr-only"> {book.title}</span>
        </button>
      </form>
    </li>
  )
}

function FinishedBook({ book, today }: { book: BookWithProgress; today: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0">
      <BookTitle book={book} />
      <p className="text-xs text-ink-muted">
        {book.finishedOn ? `Finished ${formatLocalDate(book.finishedOn, { today })}` : 'Finished'}
      </p>
    </li>
  )
}

/** Reading now, want to read and finished books. Loads independently of goals. */
export async function ReadingSections() {
  const { books, today } = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    return { books: await listBooksWithProgress(tx), today }
  })
  const current = books.filter((b) => b.status === 'reading' || b.status === 'paused')
  const want = books.filter((b) => b.status === 'want')
  const finished = books.filter((b) => b.status === 'finished')
  const FINISHED_PREVIEW = 5

  return (
    <>
      <Card aria-labelledby="reading-now-title">
        <CardHeader
          id="reading-now-title"
          title="Reading now"
          meta={current.length ? plural(current.length, 'book') : undefined}
        />
        {current.length ? (
          <ul className="divide-y divide-line">
            {current.map((b) => (
              <CurrentBook key={b.id} book={b} today={today} />
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing on the go">
            Add a book below, or start one from your reading list.
          </EmptyState>
        )}
      </Card>

      <Card aria-labelledby="want-title">
        <CardHeader
          id="want-title"
          title={BOOK_STATUS_LABELS.want}
          meta={want.length ? plural(want.length, 'book') : undefined}
        />
        {want.length ? (
          <ul className="divide-y divide-line">
            {want.map((b) => (
              <WantBook key={b.id} book={b} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Your reading list is empty.</p>
        )}
      </Card>

      {finished.length ? (
        <Card aria-labelledby="finished-title">
          <CardHeader id="finished-title" title="Finished" meta={plural(finished.length, 'book')} />
          <ul className="divide-y divide-line">
            {finished.slice(0, FINISHED_PREVIEW).map((b) => (
              <FinishedBook key={b.id} book={b} today={today} />
            ))}
          </ul>
          {finished.length > FINISHED_PREVIEW ? (
            <details className="mt-2">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm text-accent hover:text-accent-strong">
                Show all {finished.length}
              </summary>
              <ul className="divide-y divide-line">
                {finished.slice(FINISHED_PREVIEW).map((b) => (
                  <FinishedBook key={b.id} book={b} today={today} />
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      ) : null}
    </>
  )
}
