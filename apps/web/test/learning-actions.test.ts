/**
 * Learning server actions against a real database. The session layer is replaced with
 * an owner transaction on a test database (RLS still applies); Next's cache and
 * navigation functions are stubbed. Covers `logReading` (the entry point Home's quick
 * capture calls), the form actions' parsing, and owner-local "today".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getBookDetail,
  listLearningGoals,
  withOwner,
  type OwnerClaims,
  type Tx,
} from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'

// Provided by packages/db/test/global-setup.ts (the vitest globalSetup).
declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

const ctx = vi.hoisted(() => ({
  t: null as null | { db: unknown },
  owner: null as null | { sub: string; email?: string | null },
}))

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`redirect ${url}`)
  }
}

vi.mock('@/lib/server/session', () => ({
  requireOwner: async () => ({ claims: ctx.owner, userId: ctx.owner!.sub, email: null }),
  withOwnerTx: async (fn: (tx: Tx, session: unknown) => Promise<unknown>) =>
    withOwner(ctx.t!.db as never, ctx.owner as OwnerClaims, (tx) =>
      fn(tx, { claims: ctx.owner, userId: ctx.owner!.sub, email: null }),
    ),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url)
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof RedirectSignal) throw error
  },
}))

const {
  createBookAction,
  createGoalAction,
  logReading,
  logReadingAction,
  setBookStatusAction,
  updateBookAction,
  updateGoalAction,
} = await import('@/app/(app)/learning/actions')
const { ownerToday } = await import('@/components/learning/owner-today')

let t: TestDatabase
let owner: OwnerClaims
const IDLE = { status: 'idle' } as const

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    for (const value of Array.isArray(v) ? v : [v]) fd.append(k, value)
  }
  return fd
}

async function bookIdByTitle(title: string): Promise<string> {
  const [row] = await t.db<{ id: string }[]>`select id from public.books where title = ${title}`
  if (!row) throw new Error(`no book ${title}`)
  return row.id
}

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  ctx.t = t
  ctx.owner = owner
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(async () => {
  await t.db`delete from public.learning_goals`
  await t.db`delete from public.books`
  await t.db`delete from public.habits`
  await t.db`update public.owner_settings set timezone = 'Europe/London'`
})
afterEach(() => {
  vi.useRealTimers()
})

describe('logReading (quick capture entry point)', () => {
  it('logs by percentage and by page and returns a short progress line', async () => {
    await createBookAction(IDLE, form({ title: 'Dune', totalPages: '400', status: 'reading' }))
    const bookId = await bookIdByTitle('Dune')

    expect(await logReading({ bookId, percent: 25 })).toEqual({
      ok: true,
      bookId,
      bookTitle: 'Dune',
      progress: 'About page 100 of 400 · 25%',
      statusChangedFrom: null,
    })
    expect(await logReading({ bookId, pageReached: 150, note: 'Arrakis' })).toMatchObject({
      ok: true,
      progress: 'Page 150 of 400 · 37.5%',
    })
    expect(await logReading({ bookId, pagesRead: 10 })).toMatchObject({
      ok: true,
      progress: 'Page 160 of 400 · 40%',
    })
  })

  it('rejects bad input without touching the database', async () => {
    await createBookAction(IDLE, form({ title: 'Short', totalPages: '50' }))
    const bookId = await bookIdByTitle('Short')
    expect(await logReading({ bookId })).toMatchObject({ ok: false })
    expect(await logReading({ bookId, pageReached: 10, percent: 10 })).toMatchObject({
      ok: false,
      fieldErrors: { percent: expect.any(String) },
    })
    expect(await logReading({ bookId, pageReached: 51 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('past the end'),
    })
    expect(await logReading({ bookId: 'not-a-uuid', pagesRead: 1 })).toMatchObject({ ok: false })
    expect(await logReading({ bookId: crypto.randomUUID(), pagesRead: 1 })).toEqual({
      ok: false,
      error: 'That book could not be found.',
    })
    const detail = await withOwner(t.db, owner, (tx) => getBookDetail(tx, bookId))
    expect(detail?.logs).toEqual([])
  })

  it('dates a log with the owner-local day, not the server UTC day', async () => {
    await t.db`update public.owner_settings set timezone = 'Pacific/Auckland'`
    await createBookAction(IDLE, form({ title: 'Kiwi' }))
    const bookId = await bookIdByTitle('Kiwi')
    // 20:00 UTC on 24 Sep is 08:00 on 25 Sep in Auckland (NZST, UTC+12).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T20:00:00Z'))
    const result = await logReading({ bookId, minutes: 20 })
    expect(result).toMatchObject({ ok: true, statusChangedFrom: 'want' })
    const detail = await withOwner(t.db, owner, (tx) => getBookDetail(tx, bookId))
    expect(detail?.logs[0]?.localDate).toBe('2026-09-25')
    expect(detail?.book.startedOn).toBe('2026-09-25')
    // A log for "tomorrow" in Auckland terms is in the future and refused.
    expect(await logReading({ bookId, minutes: 5, localDate: '2026-09-26' })).toMatchObject({
      ok: false,
      fieldErrors: { localDate: 'That date is in the future' },
    })
  })
})

describe('logReadingAction (book page form)', () => {
  it('maps the chosen measure onto the right field', async () => {
    await createBookAction(IDLE, form({ title: 'Form book', totalPages: '200' }))
    const bookId = await bookIdByTitle('Form book')
    const percent = await logReadingAction(
      IDLE,
      form({ bookId, measure: 'percent', amount: '12.5', minutes: '' }),
    )
    expect(percent).toEqual({
      status: 'saved',
      message: 'Logged: About page 25 of 200 · 12.5%. Marked as reading.',
    })
    const pages = await logReadingAction(IDLE, form({ bookId, measure: 'pages', amount: '15' }))
    // Still derived from the logged percentage, so still "about".
    expect(pages).toMatchObject({
      status: 'saved',
      message: 'Logged: About page 40 of 200 · 20%.',
    })
    const page = await logReadingAction(
      IDLE,
      form({ bookId, measure: 'page', amount: '90', minutes: '30', note: '  good bit ' }),
    )
    expect(page).toMatchObject({ status: 'saved', message: 'Logged: Page 90 of 200 · 45%.' })
    const detail = await withOwner(t.db, owner, (tx) => getBookDetail(tx, bookId))
    expect(detail?.logs[0]).toMatchObject({ pageReached: 90, minutes: 30, note: 'good bit' })
  })

  it('returns field errors for the single amount box', async () => {
    await createBookAction(IDLE, form({ title: 'Errors', totalPages: '100' }))
    const bookId = await bookIdByTitle('Errors')
    expect(await logReadingAction(IDLE, form({ bookId, measure: 'page', amount: 'abc' }))).toEqual({
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: { amount: 'Enter a number' },
    })
    expect(
      await logReadingAction(IDLE, form({ bookId, measure: 'percent', amount: '101' })),
    ).toMatchObject({
      status: 'error',
      fieldErrors: { amount: 'Percentage must be between 0 and 100' },
    })
    expect(
      await logReadingAction(IDLE, form({ bookId, measure: 'page', amount: '' })),
    ).toMatchObject({
      status: 'error',
      fieldErrors: { amount: expect.stringContaining('Enter a page') },
    })
    expect(
      await logReadingAction(IDLE, form({ bookId: 'nope', measure: 'page', amount: '1' })),
    ).toEqual({ status: 'error', message: 'That book could not be found.' })
  })
})

describe('book and goal forms', () => {
  it('validates the book form and fills dates from the status', async () => {
    expect(await createBookAction(IDLE, form({ title: '  ', totalPages: 'x' }))).toMatchObject({
      status: 'error',
      fieldErrors: { title: 'Give the book a title', totalPages: 'Enter a number' },
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
    expect(await createBookAction(IDLE, form({ title: 'Emma', status: 'finished' }))).toEqual({
      status: 'saved',
      message: 'Added “Emma”.',
    })
    const id = await bookIdByTitle('Emma')
    const [row] = await t.db<
      { finishedOn: string | null }[]
    >`select finished_on from public.books where id = ${id}`
    expect(row?.finishedOn).toBe('2026-09-24')

    expect(
      await updateBookAction(
        id,
        IDLE,
        form({ title: 'Emma', status: 'reading', totalPages: '474' }),
      ),
    ).toEqual({ status: 'saved', message: 'Saved.' })
    expect(await updateBookAction('bad-id', IDLE, form({ title: 'x' }))).toMatchObject({
      status: 'error',
    })
    await setBookStatusAction(id, 'paused')
    const detail = await withOwner(t.db, owner, (tx) => getBookDetail(tx, id))
    expect(detail?.book).toMatchObject({ status: 'paused', totalPages: 474, finishedOn: null })
  })

  it('creates a goal with a new practice habit, and a later save reuses it', async () => {
    await createBookAction(IDLE, form({ title: 'Goal book', totalPages: '300', status: 'reading' }))
    const bookId = await bookIdByTitle('Goal book')
    const created = await createGoalAction(
      IDLE,
      form({
        title: 'Finish Goal book',
        targetDate: '2026-12-31',
        bookId,
        dailyMinutes: '30',
        habitId: 'new',
        newHabitTitle: '',
        newHabitWeekdays: ['1', '3', '5'],
      }),
    )
    expect(created).toMatchObject({ status: 'saved', message: 'Added “Finish Goal book”.' })
    const habitId = created.status === 'saved' ? created.values?.habitId : null
    expect(habitId).toMatch(/^[0-9a-f-]{36}$/)
    const habits = await t.db<{ title: string; weekdays: number[] }[]>`
      select title, weekdays::int[] as weekdays from public.habits
    `
    // A blank habit name takes the goal's name.
    expect(habits).toEqual([{ title: 'Finish Goal book', weekdays: [1, 3, 5] }])

    const [goal] = await withOwner(t.db, owner, (tx) => listLearningGoals(tx, '2026-09-24'))
    expect(goal).toMatchObject({ habitId, bookId, dailyMinutes: 30 })
    const updated = await updateGoalAction(
      goal!.id,
      IDLE,
      form({ title: 'Finish Goal book', habitId: habitId!, bookId, status: 'paused' }),
    )
    expect(updated).toMatchObject({ status: 'saved', values: { habitId } })
    const [{ n }] = (await t.db`select count(*)::int as n from public.habits`) as unknown as [
      { n: number },
    ]
    expect(n).toBe(1)
  })

  it('reports goal form errors, including the new habit fields', async () => {
    expect(
      await createGoalAction(
        IDLE,
        form({ title: '', dailyMinutes: '2', habitId: 'new', newHabitWeekdays: [] }),
      ),
    ).toMatchObject({
      status: 'error',
      fieldErrors: {
        title: 'Give the goal a title',
        dailyMinutes: 'At least 5 minutes a day',
        newHabitWeekdays: 'Pick at least one day',
      },
    })
    expect(
      await createGoalAction(IDLE, form({ title: 'x', habitId: crypto.randomUUID() })),
    ).toMatchObject({ status: 'error', fieldErrors: { habitId: 'That habit no longer exists' } })
  })
})

describe('ownerToday', () => {
  it('uses the saved timezone, across midnight and DST', async () => {
    const at = (iso: string) => withOwner(t.db, owner, (tx) => ownerToday(tx, new Date(iso)))
    expect(await at('2026-03-28T23:59:00Z')).toEqual({
      today: '2026-03-28',
      timeZone: 'Europe/London',
      timeZoneFallback: false,
    })
    expect((await at('2026-03-29T23:30:00Z')).today).toBe('2026-03-30') // 00:30 BST
    expect((await at('2026-10-25T23:30:00Z')).today).toBe('2026-10-25') // 23:30 GMT
    await t.db`update public.owner_settings set timezone = 'America/Los_Angeles'`
    expect((await at('2026-09-25T03:00:00Z')).today).toBe('2026-09-24')
  })

  it('falls back to UTC, and says so, when the settings row cannot be read', async () => {
    await t.db`delete from public.owner_settings`
    try {
      const r = await withOwner(t.db, owner, (tx) =>
        ownerToday(tx, new Date('2026-09-24T23:30:00Z')),
      )
      expect(r).toEqual({ today: '2026-09-24', timeZone: 'UTC', timeZoneFallback: true })
    } finally {
      await t.db`insert into public.owner_settings (singleton) values (true) on conflict do nothing`
    }
  })
})
