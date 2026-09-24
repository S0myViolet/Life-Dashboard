import { describe, expect, it } from 'vitest'
import { catchUpStatus, nextImportantDateOccurrence, readingProgress } from '@personal-home/core'
import {
  formatLocalDate,
  progressHeadline,
  progressNotes,
  relativeDay,
} from '@/components/learning/format'
import { formNumber, formText, zodFieldErrors } from '@/components/learning/form-state'
import { catchUpText, lastCaughtUpText, occurrenceText } from '@/components/people/format'
import { z } from 'zod'

const today = '2026-09-24'
const log = (fields: Partial<Parameters<typeof readingProgress>[1][number]>) => ({
  localDate: '2026-09-20',
  pageReached: null,
  pagesRead: null,
  percent: null,
  minutes: null,
  ...fields,
})

describe('progressHeadline', () => {
  it('says only what is known', () => {
    expect(progressHeadline(readingProgress({ totalPages: 300, status: 'reading' }, []))).toBe(
      'No progress logged yet',
    )
    expect(
      progressHeadline(
        readingProgress({ totalPages: 300, status: 'reading' }, [log({ minutes: 20 })]),
      ),
    ).toBe('Time logged, no position yet')
    expect(
      progressHeadline(
        readingProgress({ totalPages: null, status: 'reading' }, [log({ pageReached: 42 })]),
      ),
    ).toBe('Page 42')
    expect(
      progressHeadline(
        readingProgress({ totalPages: null, status: 'reading' }, [log({ percent: 62.5 })]),
      ),
    ).toBe('62.5%')
    expect(
      progressHeadline(
        readingProgress({ totalPages: 300, status: 'reading' }, [log({ pagesRead: 1 })]),
      ),
    ).toBe('1 page read of 300 · 0.3%')
    expect(progressHeadline(readingProgress({ totalPages: 300, status: 'finished' }, []))).toBe(
      'Finished · 300 pages',
    )
    expect(progressHeadline(readingProgress({ totalPages: null, status: 'finished' }, []))).toBe(
      'Finished',
    )
  })

  it('adds plain caveats', () => {
    const outdated = readingProgress({ totalPages: null, status: 'reading' }, [
      log({ percent: 40, localDate: '2026-09-01' }),
      log({ pagesRead: 10 }),
    ])
    expect(progressNotes(outdated, today)).toEqual([
      "Percentage as of 1 Sept; pages read since can't be converted without the total page count.",
    ])
    const past = readingProgress({ totalPages: 100, status: 'reading' }, [
      log({ pageReached: 90 }),
      log({ pagesRead: 20 }),
    ])
    expect(progressNotes(past, today)).toEqual([
      'Past the 100 pages recorded for this book — check the total.',
    ])
    const noTotal = readingProgress({ totalPages: null, status: 'reading' }, [
      log({ pageReached: 9 }),
    ])
    expect(progressNotes(noTotal, today)).toEqual(['Add the total pages to see a percentage.'])
  })
})

describe('dates', () => {
  it('formats local dates without shifting them', () => {
    expect(formatLocalDate('2026-09-24')).toBe('24 Sept')
    expect(formatLocalDate('2027-01-02', { today })).toBe('2 Jan 2027')
    expect(formatLocalDate('2026-12-31', { withYear: true })).toBe('31 Dec 2026')
    expect(relativeDay('2026-09-24', today)).toBe('today')
    expect(relativeDay('2026-09-25', today)).toBe('tomorrow')
    expect(relativeDay('2026-09-23', today)).toBe('yesterday')
    expect(relativeDay('2026-10-04', today)).toBe('in 10 days')
    expect(relativeDay('2026-09-01', today)).toBe('23 days ago')
  })

  it('describes important dates and catch-ups', () => {
    const leap = nextImportantDateOccurrence({ month: 2, day: 29, year: 2000 }, today)
    expect(occurrenceText('Birthday', leap, today)).toBe(
      'in 157 days (Sun, 28 Feb 2027) · turns 27 · marked on 28 Feb — no 29 Feb this year',
    )
    const anniv = nextImportantDateOccurrence({ month: 9, day: 25, year: 2016 }, today)
    expect(occurrenceText('Anniversary', anniv, today)).toBe('tomorrow · 10 years')
    const c = { catchUpEveryDays: 7, catchUpStartedOn: null }
    expect(catchUpText(catchUpStatus({ ...c, lastCaughtUpOn: '2026-09-17' }, today), today)).toBe(
      'Catch-up due today',
    )
    expect(catchUpText(catchUpStatus({ ...c, lastCaughtUpOn: '2026-09-10' }, today), today)).toBe(
      'Catch-up overdue by 7 days',
    )
    expect(catchUpText(catchUpStatus({ ...c, lastCaughtUpOn: '2026-09-23' }, today), today)).toBe(
      'Next catch-up in 6 days (30 Sept)',
    )
    expect(
      catchUpText(
        catchUpStatus(
          { catchUpEveryDays: null, lastCaughtUpOn: null, catchUpStartedOn: null },
          today,
        ),
        today,
      ),
    ).toBe('No catch-up reminder')
    expect(lastCaughtUpText(null, today)).toBe('No catch-up recorded yet')
    expect(lastCaughtUpText(today, today)).toBe('Last caught up today')
    expect(lastCaughtUpText('2026-09-20', today)).toBe('Last caught up 4 days ago (20 Sept)')
  })
})

describe('form parsing', () => {
  it('reads text and numbers from FormData safely', () => {
    const fd = new FormData()
    fd.append('a', '  hi ')
    fd.append('b', '   ')
    fd.append('n', ' 12 ')
    fd.append('bad', '12abc')
    fd.append('file', new Blob(['x']), 'x.txt')
    const errors: Record<string, string> = {}
    expect(formText(fd, 'a')).toBe('hi')
    expect(formText(fd, 'b')).toBeNull()
    expect(formText(fd, 'missing')).toBeNull()
    expect(formText(fd, 'file')).toBeNull()
    expect(formNumber(fd, 'n', errors)).toBe(12)
    expect(formNumber(fd, 'b', errors)).toBeNull()
    expect(formNumber(fd, 'bad', errors)).toBeNull()
    expect(errors).toEqual({ bad: 'Enter a number' })
  })

  it('keeps the first message per field', () => {
    const r = z
      .object({ a: z.string().min(2, 'too short').regex(/x/, 'needs x'), b: z.number() })
      .safeParse({ a: 'y', b: 'no' })
    expect(r.success).toBe(false)
    if (!r.success) expect(Object.keys(zodFieldErrors(r.error))).toEqual(['a', 'b'])
    if (!r.success) expect(zodFieldErrors(r.error).a).toBe('too short')
  })
})
