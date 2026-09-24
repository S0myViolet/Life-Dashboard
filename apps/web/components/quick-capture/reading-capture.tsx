'use client'

/**
 * Quick capture › Reading: pick a book, then the page reached or a percentage, and/or minutes.
 * Saved through the learning area's logReading server action (same validation, owner-local
 * date, and "logging a want-to-read book marks it as reading").
 */
import Link from 'next/link'
import { useRef, useState, useTransition } from 'react'
import { BookOpen } from 'lucide-react'
import { BOOK_LIMITS } from '@personal-home/core'
import { buttonClass } from '@/components/ui/button'
import { FieldError, inputClass, labelClass } from '@/components/tasks/ui'
import { logReading } from '@/app/(app)/learning/actions'

export interface QuickCaptureBook {
  id: string
  title: string
  author: string | null
  status: string
  totalPages: number | null
}

type Measure = 'page' | 'percent'
type Result =
  | { status: 'idle' }
  | { status: 'saved'; message: string; bookId: string }
  | { status: 'error'; message: string; fieldErrors: Record<string, string> }

/** '' → null; a number otherwise (NaN for junk, which the form reports). */
function numberOrNull(value: string): number | null {
  const v = value.trim()
  return v === '' ? null : Number(v)
}

export function ReadingCapture({ books }: { books: QuickCaptureBook[] }) {
  const [bookId, setBookId] = useState(books[0]?.id ?? '')
  const [measure, setMeasure] = useState<Measure>('page')
  const [amount, setAmount] = useState('')
  const [minutes, setMinutes] = useState('')
  const [result, setResult] = useState<Result>({ status: 'idle' })
  const [pending, startTransition] = useTransition()
  const amountRef = useRef<HTMLInputElement>(null)

  if (books.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="quick-reading-empty">
        No books on your reading list yet.{' '}
        <Link
          href="/learning"
          className="inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0"
        >
          Add a book in Learning
        </Link>
      </p>
    )
  }

  const book = books.find((b) => b.id === bookId) ?? books[0]!
  const errors = result.status === 'error' ? result.fieldErrors : {}
  const amountLabel = measure === 'page' ? 'Page reached' : 'Percent through'
  const amountMax = measure === 'percent' ? 100 : (book.totalPages ?? BOOK_LIMITS.pageReachedMax)

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const n = numberOrNull(amount)
    const m = numberOrNull(minutes)
    const fieldErrors: Record<string, string> = {}
    if (n !== null && !Number.isFinite(n)) fieldErrors.amount = 'Enter a number'
    if (m !== null && !Number.isFinite(m)) fieldErrors.minutes = 'Enter a number'
    if (n === null && m === null)
      fieldErrors.amount = `Enter the ${amountLabel.toLowerCase()} or minutes`
    if (Object.keys(fieldErrors).length > 0) {
      setResult({ status: 'error', message: 'Check the highlighted fields.', fieldErrors })
      amountRef.current?.focus()
      return
    }
    startTransition(async () => {
      const r = await logReading({
        bookId: book.id,
        pageReached: measure === 'page' ? n : null,
        percent: measure === 'percent' ? n : null,
        minutes: m,
      })
      if (r.ok) {
        const started = r.statusChangedFrom ? ' Marked as reading.' : ''
        setResult({
          status: 'saved',
          message: `Logged “${r.bookTitle}”: ${r.progress}.${started}`,
          bookId: r.bookId,
        })
        setAmount('')
        setMinutes('')
        amountRef.current?.focus()
      } else {
        const fe = r.fieldErrors ?? {}
        const amountError = fe.pageReached ?? fe.percent ?? fe.pagesRead
        setResult({
          status: 'error',
          message: r.error,
          fieldErrors: {
            ...(amountError ? { amount: amountError } : {}),
            ...(fe.minutes ? { minutes: fe.minutes } : {}),
          },
        })
      }
    })
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Log reading"
      className="space-y-3"
      data-testid="quick-reading-form"
    >
      <div>
        <label htmlFor="qc-book" className={labelClass}>
          Book
        </label>
        <select
          id="qc-book"
          value={book.id}
          onChange={(e) => setBookId(e.target.value)}
          className={inputClass}
        >
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.author ? ` — ${b.author}` : ''}
              {b.status === 'want' ? ' (want to read)' : b.status === 'paused' ? ' (paused)' : ''}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className={labelClass}>Progress</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {(['page', 'percent'] as const).map((m) => (
            <label
              key={m}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft sm:min-h-10"
            >
              <input
                type="radio"
                name="qc-measure"
                value={m}
                checked={measure === m}
                onChange={() => setMeasure(m)}
                className="size-4 accent-[var(--color-accent)]"
              />
              {m === 'page' ? 'Page' : 'Percent'}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor="qc-amount" className={labelClass}>
            {amountLabel}
          </label>
          <input
            ref={amountRef}
            id="qc-amount"
            type="number"
            inputMode={measure === 'percent' ? 'decimal' : 'numeric'}
            min={0}
            max={amountMax}
            step={measure === 'percent' ? 'any' : 1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={errors.amount ? 'qc-amount-error' : 'qc-amount-help'}
            className={inputClass}
          />
          {errors.amount ? (
            <FieldError id="qc-amount-error" message={errors.amount} />
          ) : (
            <p id="qc-amount-help" className="mt-1 text-xs text-ink-muted">
              {measure === 'page'
                ? book.totalPages
                  ? `Of ${book.totalPages} pages.`
                  : 'Total pages unknown.'
                : '0–100, e.g. from an e-reader.'}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="qc-minutes" className={labelClass}>
            Minutes <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <input
            id="qc-minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={BOOK_LIMITS.minutesMax}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-invalid={errors.minutes ? true : undefined}
            aria-describedby={errors.minutes ? 'qc-minutes-error' : undefined}
            className={inputClass}
          />
          <FieldError id="qc-minutes-error" message={errors.minutes} />
        </div>
        <button
          type="submit"
          disabled={pending}
          className={buttonClass('primary', 'col-span-2 sm:col-span-1')}
        >
          <BookOpen aria-hidden className="size-4" />
          {pending ? 'Saving…' : 'Log reading'}
        </button>
      </div>
      <div aria-live="polite" className="text-sm">
        {result.status === 'saved' ? (
          <p role="status" className="text-positive">
            {result.message}{' '}
            <Link
              href={`/learning/books/${result.bookId}`}
              className="inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0"
            >
              Open book
            </Link>
          </p>
        ) : result.status === 'error' ? (
          <p role="alert" className="text-danger">
            {result.message}
          </p>
        ) : null}
      </div>
    </form>
  )
}
