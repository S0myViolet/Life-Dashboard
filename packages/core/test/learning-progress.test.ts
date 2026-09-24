import { describe, expect, it } from 'vitest'
import {
  bookDatesForStatus,
  BookInputSchema,
  bookStatusAfterLog,
  formatReadingPercent,
  readingLogProblem,
  ReadingLogInputSchema,
  readingProgress,
  sortReadingLogs,
  type ReadingLogForProgress,
} from '../src/index.ts'

const BOOK_ID = '6a0d5a4e-8a53-4f0e-9d8e-0b1f1c9a2b10'

function log(
  localDate: string,
  fields: Partial<ReadingLogForProgress> = {},
): ReadingLogForProgress {
  return {
    localDate,
    pageReached: null,
    pagesRead: null,
    percent: null,
    minutes: null,
    ...fields,
  }
}

describe('readingProgress — pages', () => {
  it('uses the latest page reached and divides by the total', () => {
    const p = readingProgress({ totalPages: 300, status: 'reading' }, [
      log('2026-09-01', { pageReached: 40 }),
      log('2026-09-03', { pageReached: 150 }),
    ])
    expect(p.currentPage).toBe(150)
    expect(p.pageBasis).toBe('page_reached')
    expect(p.percent).toBe(50)
    expect(p.percentBasis).toBe('pages')
    expect(p.pagesLeft).toBe(150)
    expect(p.lastLoggedOn).toBe('2026-09-03')
    expect(p.logCount).toBe(2)
  })

  it('moves forward from the last page reached by pages read since', () => {
    const p = readingProgress({ totalPages: 200, status: 'reading' }, [
      log('2026-09-01', { pageReached: 50 }),
      log('2026-09-02', { pagesRead: 20 }),
      log('2026-09-03', { pagesRead: 10 }),
    ])
    expect(p.currentPage).toBe(80)
    expect(p.pageBasis).toBe('page_reached')
    expect(p.percent).toBe(40)
    expect(p.pagesReadLogged).toBe(30)
  })

  it('counts pages read from the start when no position was ever logged', () => {
    const p = readingProgress({ totalPages: 300, status: 'reading' }, [
      log('2026-09-01', { pagesRead: 30 }),
      log('2026-09-02', { pagesRead: 15 }),
    ])
    expect(p.currentPage).toBe(45)
    expect(p.pageBasis).toBe('pages_read_total')
    expect(p.percent).toBe(15)
  })

  it('does not double count pages read that come with a page reached', () => {
    const p = readingProgress({ totalPages: 100, status: 'reading' }, [
      log('2026-09-01', { pageReached: 20, pagesRead: 20 }),
      log('2026-09-02', { pageReached: 35, pagesRead: 15 }),
    ])
    expect(p.currentPage).toBe(35)
    expect(p.pagesReadLogged).toBe(35)
  })

  it('a later page reached can move backwards (re-reading, a correction)', () => {
    const p = readingProgress({ totalPages: 100, status: 'reading' }, [
      log('2026-09-01', { pageReached: 60 }),
      log('2026-09-02', { pageReached: 40 }),
    ])
    expect(p.currentPage).toBe(40)
  })
})

describe('readingProgress — missing total pages', () => {
  it('gives the page but no percentage when the total is unknown', () => {
    const p = readingProgress({ totalPages: null, status: 'reading' }, [
      log('2026-09-01', { pageReached: 120 }),
    ])
    expect(p.currentPage).toBe(120)
    expect(p.percent).toBeNull()
    expect(p.percentBasis).toBeNull()
    expect(p.pagesLeft).toBeNull()
    expect(p.totalPages).toBeNull()
  })

  it('pages read only, no total: a page count, no percentage and no pages left', () => {
    const p = readingProgress({ totalPages: null, status: 'reading' }, [
      log('2026-09-01', { pagesRead: 25 }),
    ])
    expect(p.currentPage).toBe(25)
    expect(p.pageBasis).toBe('pages_read_total')
    expect(p.percent).toBeNull()
    expect(p.pagesLeft).toBeNull()
  })

  it('shows a logged percentage without a total, and never extrapolates it', () => {
    const p = readingProgress({ totalPages: null, status: 'reading' }, [
      log('2026-09-01', { percent: 40 }),
      log('2026-09-04', { pagesRead: 30 }),
    ])
    expect(p.percent).toBe(40)
    expect(p.percentBasis).toBe('logged')
    expect(p.percentAsOf).toBe('2026-09-01')
    expect(p.percentOutdated).toBe(true)
    expect(p.currentPage).toBeNull()
    expect(p.lastLoggedOn).toBe('2026-09-04')
  })

  it('a page reached after a percentage replaces it (no total → no percentage)', () => {
    const p = readingProgress({ totalPages: null, status: 'reading' }, [
      log('2026-09-01', { percent: 40 }),
      log('2026-09-02', { pageReached: 180 }),
    ])
    expect(p.currentPage).toBe(180)
    expect(p.percent).toBeNull()
  })

  it('treats a zero or missing total the same (nothing to divide by)', () => {
    const p = readingProgress({ totalPages: 0, status: 'reading' }, [
      log('2026-09-01', { pageReached: 10 }),
    ])
    expect(p.percent).toBeNull()
    expect(p.totalPages).toBeNull()
  })

  it('has no progress at all with no logs, or with minutes only', () => {
    for (const logs of [[], [log('2026-09-01', { minutes: 30 })]]) {
      const p = readingProgress({ totalPages: 250, status: 'reading' }, logs)
      expect(p.currentPage).toBeNull()
      expect(p.percent).toBeNull()
      expect(p.pagesLeft).toBeNull()
    }
    const withMinutes = readingProgress({ totalPages: 250, status: 'reading' }, [
      log('2026-09-01', { minutes: 30 }),
      log('2026-09-02', { minutes: 15 }),
    ])
    expect(withMinutes.minutesLogged).toBe(45)
  })
})

describe('readingProgress — percentages and mixed logs', () => {
  it('keeps a logged percentage exactly and converts it to a page when the total is known', () => {
    const p = readingProgress({ totalPages: 301, status: 'reading' }, [
      log('2026-09-01', { percent: 50 }),
    ])
    expect(p.percent).toBe(50)
    expect(p.percentBasis).toBe('logged')
    expect(p.currentPage).toBe(150) // floor(150.5): never overstate
    expect(p.pageBasis).toBe('percent_of_total')
    expect(p.pagesLeft).toBe(151)
  })

  it('converts a percentage to a page without floating-point loss', () => {
    // (58 / 100) * 100 is 57.99999999999999 in binary floating point.
    const p = readingProgress({ totalPages: 100, status: 'reading' }, [
      log('2026-09-01', { percent: 58 }),
    ])
    expect(p.currentPage).toBe(58)
    const q = readingProgress({ totalPages: 300, status: 'reading' }, [
      log('2026-09-01', { percent: 33.33 }),
    ])
    expect(q.currentPage).toBe(99)
  })

  it('pages read after a percentage move the position on when the total is known', () => {
    const p = readingProgress({ totalPages: 200, status: 'reading' }, [
      log('2026-09-01', { percent: 25 }),
      log('2026-09-02', { pagesRead: 30 }),
    ])
    expect(p.currentPage).toBe(80)
    expect(p.percent).toBe(40)
    expect(p.percentBasis).toBe('pages')
    expect(p.percentOutdated).toBe(false)
  })

  it('pages then a percentage then pages: the latest position wins', () => {
    const p = readingProgress({ totalPages: 400, status: 'reading' }, [
      log('2026-09-01', { pageReached: 100 }),
      log('2026-09-02', { percent: 50 }),
      log('2026-09-03', { pagesRead: 40 }),
    ])
    expect(p.currentPage).toBe(240)
    expect(p.percent).toBe(60)
  })

  it('a percentage after pages replaces the page position', () => {
    const p = readingProgress({ totalPages: 100, status: 'reading' }, [
      log('2026-09-01', { pageReached: 90 }),
      log('2026-09-02', { percent: 20 }),
    ])
    expect(p.percent).toBe(20)
    expect(p.currentPage).toBe(20)
  })

  it('orders by date, then creation time, regardless of input order', () => {
    const p = readingProgress({ totalPages: 100, status: 'reading' }, [
      log('2026-09-02', { pageReached: 70, createdAt: '2026-09-02T20:00:00Z' }),
      log('2026-09-02', { pageReached: 60, createdAt: '2026-09-02T08:00:00Z' }),
      log('2026-09-01', { pageReached: 90, createdAt: '2026-09-03T08:00:00Z' }),
    ])
    expect(p.currentPage).toBe(70)
    expect(p.firstLoggedOn).toBe('2026-09-01')
  })

  it('caps the percentage at 100 and flags a page past the total', () => {
    const p = readingProgress({ totalPages: 200, status: 'reading' }, [
      log('2026-09-01', { pageReached: 190 }),
      log('2026-09-02', { pagesRead: 30 }),
    ])
    expect(p.currentPage).toBe(220)
    expect(p.pastTotal).toBe(true)
    expect(p.percent).toBe(100)
    expect(p.pagesLeft).toBe(0)
  })

  it('a finished book is 100%, with or without logs or a total', () => {
    const noLogs = readingProgress({ totalPages: null, status: 'finished' }, [])
    expect(noLogs.percent).toBe(100)
    expect(noLogs.percentBasis).toBe('finished')
    expect(noLogs.currentPage).toBeNull()
    const withTotal = readingProgress({ totalPages: 320, status: 'finished' }, [
      log('2026-09-01', { pageReached: 100 }),
    ])
    expect(withTotal.percent).toBe(100)
    expect(withTotal.currentPage).toBe(320)
    expect(withTotal.pagesLeft).toBe(0)
    // A finished book with a log past its total is not flagged: the owner said it's done.
    const over = readingProgress({ totalPages: 100, status: 'finished' }, [
      log('2026-09-01', { pageReached: 120 }),
    ])
    expect(over.pastTotal).toBe(false)
  })

  it('paused and want-to-read books report what was logged, nothing more', () => {
    const p = readingProgress({ totalPages: 100, status: 'paused' }, [
      log('2026-09-01', { pageReached: 30 }),
    ])
    expect(p.percent).toBe(30)
  })
})

describe('sortReadingLogs', () => {
  it('is stable for logs without creation times', () => {
    const a = log('2026-09-01', { pageReached: 1 })
    const b = log('2026-09-01', { pageReached: 2 })
    expect(sortReadingLogs([a, b])).toEqual([a, b])
    expect(sortReadingLogs([b, a])).toEqual([b, a])
  })
})

describe('formatReadingPercent', () => {
  it('rounds down so the end is never claimed early', () => {
    expect(formatReadingPercent((299 * 100) / 300)).toBe('99.6%')
    expect(formatReadingPercent(99.99)).toBe('99.9%')
    expect(formatReadingPercent(100)).toBe('100%')
    expect(formatReadingPercent(50)).toBe('50%')
    expect(formatReadingPercent(33.333)).toBe('33.3%')
    expect(formatReadingPercent((58 / 100) * 100)).toBe('58%')
    expect(formatReadingPercent(0)).toBe('0%')
  })
})

describe('ReadingLogInputSchema', () => {
  it('accepts any one measure', () => {
    for (const measure of [
      { pageReached: 12 },
      { pagesRead: 5 },
      { percent: 12.5 },
      { minutes: 20 },
    ]) {
      expect(ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, ...measure }).success).toBe(true)
    }
  })

  it('rejects a log with no measure', () => {
    const r = ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, note: 'Loved chapter 3' })
    expect(r.success).toBe(false)
  })

  it('rejects both a page reached and a percentage in one log', () => {
    const r = ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, pageReached: 10, percent: 10 })
    expect(r.success).toBe(false)
  })

  it('bounds and rounds values like the database', () => {
    expect(ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, percent: 100.01 }).success).toBe(
      false,
    )
    expect(ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, percent: -1 }).success).toBe(false)
    expect(ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, pagesRead: 0 }).success).toBe(false)
    expect(ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, pageReached: 1.5 }).success).toBe(
      false,
    )
    expect(ReadingLogInputSchema.parse({ bookId: BOOK_ID, percent: 33.3333 }).percent).toBe(33.33)
    expect(ReadingLogInputSchema.safeParse({ bookId: 'nope', pagesRead: 3 }).success).toBe(false)
    expect(
      ReadingLogInputSchema.safeParse({ bookId: BOOK_ID, pagesRead: 3, localDate: '2026-02-30' })
        .success,
    ).toBe(false)
  })

  it('turns an empty note into null', () => {
    expect(ReadingLogInputSchema.parse({ bookId: BOOK_ID, pagesRead: 3, note: '   ' }).note).toBe(
      null,
    )
  })
})

describe('book rules', () => {
  it('rejects a page past the known total', () => {
    expect(readingLogProblem({ pageReached: 301 }, { totalPages: 300 })).toMatch(/past the end/)
    expect(readingLogProblem({ pageReached: 300 }, { totalPages: 300 })).toBeNull()
    expect(readingLogProblem({ pageReached: 9000 }, { totalPages: null })).toBeNull()
  })

  it('logging progress starts a wanted or paused book, and leaves a finished one alone', () => {
    expect(bookStatusAfterLog('want')).toBe('reading')
    expect(bookStatusAfterLog('paused')).toBe('reading')
    expect(bookStatusAfterLog('reading')).toBe('reading')
    expect(bookStatusAfterLog('finished')).toBe('finished')
  })

  it('fills in the dates a status implies without overwriting given dates', () => {
    const today = '2026-09-24'
    expect(
      bookDatesForStatus({ status: 'reading', startedOn: null, finishedOn: null }, today),
    ).toEqual({ startedOn: today, finishedOn: null })
    expect(
      bookDatesForStatus({ status: 'reading', startedOn: '2026-09-01', finishedOn: null }, today),
    ).toEqual({ startedOn: '2026-09-01', finishedOn: null })
    expect(
      bookDatesForStatus({ status: 'finished', startedOn: '2026-09-01', finishedOn: null }, today),
    ).toEqual({ startedOn: '2026-09-01', finishedOn: today })
    expect(
      bookDatesForStatus(
        { status: 'reading', startedOn: '2026-09-01', finishedOn: '2026-09-20' },
        today,
      ),
    ).toEqual({ startedOn: '2026-09-01', finishedOn: null })
    expect(
      bookDatesForStatus({ status: 'want', startedOn: null, finishedOn: null }, today),
    ).toEqual({
      startedOn: null,
      finishedOn: null,
    })
  })

  it('validates book input', () => {
    expect(BookInputSchema.safeParse({ title: '   ' }).success).toBe(false)
    const ok = BookInputSchema.parse({ title: ' Middlemarch ', author: '', totalPages: null })
    expect(ok).toMatchObject({
      title: 'Middlemarch',
      author: null,
      totalPages: null,
      status: 'want',
    })
    expect(BookInputSchema.safeParse({ title: 'x', totalPages: 0 }).success).toBe(false)
    expect(
      BookInputSchema.safeParse({ title: 'x', startedOn: '2026-09-10', finishedOn: '2026-09-01' })
        .success,
    ).toBe(false)
  })
})
