import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createBook,
  createLearningGoal,
  createPracticeHabit,
  deleteBook,
  deleteLearningGoal,
  deleteReadingLog,
  getBook,
  getBookDetail,
  getLearningGoal,
  listBookOptions,
  listBooksWithProgress,
  listLearningGoals,
  listPracticeHabitOptions,
  readingMinutesOn,
  recordReadingLog,
  setBookStatus,
  setLearningGoalStatus,
  updateBook,
  updateLearningGoal,
  withOwner,
  type OwnerClaims,
  type Tx,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

const today = '2026-09-24'
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)
const asStranger = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, stranger, fn)

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(async () => {
  await t.db`delete from public.learning_goals`
  await t.db`delete from public.books`
  await t.db`delete from public.habits`
})

describe('books', () => {
  it('creates a book and fills in the dates its status implies', async () => {
    const want = await asOwner((tx) => createBook(tx, { title: '  Middlemarch ' }, today))
    expect(want).toMatchObject({
      title: 'Middlemarch',
      author: null,
      totalPages: null,
      status: 'want',
      startedOn: null,
      finishedOn: null,
    })
    const reading = await asOwner((tx) =>
      createBook(
        tx,
        { title: 'Dune', author: 'Frank Herbert', totalPages: 612, status: 'reading' },
        today,
      ),
    )
    expect(reading).toMatchObject({ status: 'reading', startedOn: today, totalPages: 612 })

    const finished = await asOwner((tx) => setBookStatus(tx, reading.id, 'finished', '2026-09-30'))
    expect(finished).toMatchObject({
      status: 'finished',
      startedOn: today,
      finishedOn: '2026-09-30',
    })
    const again = await asOwner((tx) => setBookStatus(tx, reading.id, 'reading', '2026-10-01'))
    expect(again).toMatchObject({ status: 'reading', finishedOn: null })
  })

  it('updates, and returns null for a missing book', async () => {
    const book = await asOwner((tx) => createBook(tx, { title: 'Draft' }, today))
    const updated = await asOwner((tx) =>
      updateBook(tx, book.id, { title: 'Final', totalPages: 200, status: 'paused' }, today),
    )
    expect(updated).toMatchObject({
      title: 'Final',
      totalPages: 200,
      status: 'paused',
      startedOn: today,
    })
    expect(
      await asOwner((tx) => updateBook(tx, crypto.randomUUID(), { title: 'x' }, today)),
    ).toBeNull()
  })

  it('the database rejects a finish date before the start date', async () => {
    await expect(
      t.db`insert into public.books (title, status, started_on, finished_on)
           values ('x', 'finished', '2026-09-10', '2026-09-01')`,
    ).rejects.toThrow(/books_finished_after_started/)
  })

  it('lists reading books first, with progress, then want-to-read, then finished', async () => {
    const want = await asOwner((tx) => createBook(tx, { title: 'Later' }, today))
    const done = await asOwner((tx) =>
      createBook(tx, { title: 'Done', status: 'finished', totalPages: 100 }, today),
    )
    const reading = await asOwner((tx) =>
      createBook(tx, { title: 'Now', status: 'reading', totalPages: 400 }, today),
    )
    await asOwner((tx) => recordReadingLog(tx, { bookId: reading.id, pageReached: 100 }, today))

    const list = await asOwner((tx) => listBooksWithProgress(tx))
    expect(list.map((b) => b.id)).toEqual([reading.id, want.id, done.id])
    expect(list[0]?.progress).toMatchObject({ currentPage: 100, percent: 25 })
    expect(list[0]?.lastLog).toMatchObject({ pageReached: 100, localDate: today })
    expect(list[1]?.progress.percent).toBeNull()
    expect(list[2]?.progress).toMatchObject({ percent: 100, percentBasis: 'finished' })

    const options = await asOwner((tx) => listBookOptions(tx, { statuses: ['reading', 'want'] }))
    expect(options.map((o) => o.title)).toEqual(['Now', 'Later'])
  })

  it('deleting a book removes its logs and unlinks goals', async () => {
    const book = await asOwner((tx) => createBook(tx, { title: 'Gone', totalPages: 10 }, today))
    await asOwner((tx) => recordReadingLog(tx, { bookId: book.id, pagesRead: 3 }, today))
    const goal = await asOwner((tx) =>
      createLearningGoal(tx, { title: 'Finish it', bookId: book.id }),
    )
    expect(goal.ok).toBe(true)
    expect(await asOwner((tx) => deleteBook(tx, book.id))).toBe(true)
    expect(await asOwner((tx) => deleteBook(tx, book.id))).toBe(false)
    const [{ n }] = (await t.db`select count(*)::int as n from public.reading_logs`) as unknown as [
      { n: number },
    ]
    expect(n).toBe(0)
    if (goal.ok) {
      expect((await asOwner((tx) => getLearningGoal(tx, goal.value.id)))?.bookId).toBeNull()
    }
  })
})

describe('reading logs', () => {
  it('logs by percentage and by page; any one measure is enough', async () => {
    const book = await asOwner((tx) => createBook(tx, { title: 'Kindle book' }, today))

    const byPercent = await asOwner((tx) =>
      recordReadingLog(tx, { bookId: book.id, percent: 12.5, note: 'Chapter 2' }, today),
    )
    expect(byPercent.ok).toBe(true)
    if (!byPercent.ok) return
    expect(byPercent.value.log).toMatchObject({
      percent: 12.5,
      pageReached: null,
      pagesRead: null,
      localDate: today,
      note: 'Chapter 2',
    })
    // Logging on a want-to-read book starts it.
    expect(byPercent.value.statusChangedFrom).toBe('want')
    expect(byPercent.value.book).toMatchObject({ status: 'reading', startedOn: today })
    expect(byPercent.value.progress).toMatchObject({ percent: 12.5, percentBasis: 'logged' })

    const byPage = await asOwner((tx) =>
      recordReadingLog(tx, { bookId: book.id, pageReached: 80, localDate: '2026-09-24' }, today),
    )
    expect(byPage.ok && byPage.value.progress).toMatchObject({
      currentPage: 80,
      percent: null, // total pages unknown: no percentage is invented
    })
    expect(byPage.ok && byPage.value.statusChangedFrom).toBeNull()

    await asOwner((tx) =>
      updateBook(tx, book.id, { title: 'Kindle book', totalPages: 320, status: 'reading' }, today),
    )
    const minutes = await asOwner((tx) =>
      recordReadingLog(tx, { bookId: book.id, minutes: 25 }, today),
    )
    expect(minutes.ok && minutes.value.progress).toMatchObject({
      currentPage: 80,
      percent: 25,
      minutesLogged: 25,
    })
  })

  it('rejects a page past the end, a future date, and an unknown book', async () => {
    const book = await asOwner((tx) =>
      createBook(tx, { title: 'Short', totalPages: 50, status: 'reading' }, today),
    )
    expect(
      await asOwner((tx) => recordReadingLog(tx, { bookId: book.id, pageReached: 51 }, today)),
    ).toMatchObject({ ok: false, reason: 'invalid', field: 'pageReached' })
    expect(
      await asOwner((tx) =>
        recordReadingLog(tx, { bookId: book.id, pagesRead: 5, localDate: '2026-09-25' }, today),
      ),
    ).toMatchObject({ ok: false, reason: 'invalid', field: 'localDate' })
    expect(
      await asOwner((tx) =>
        recordReadingLog(tx, { bookId: crypto.randomUUID(), pagesRead: 5 }, today),
      ),
    ).toEqual({ ok: false, reason: 'not_found' })
    await expect(
      asOwner((tx) => recordReadingLog(tx, { bookId: book.id }, today)),
    ).rejects.toThrow()
  })

  it('the database still requires at least one measure', async () => {
    const book = await asOwner((tx) => createBook(tx, { title: 'x' }, today))
    await expect(
      t.db`insert into public.reading_logs (book_id, local_date) values (${book.id}, ${today})`,
    ).rejects.toThrow(/reading_logs_has_measure/)
  })

  it('concurrent logs on one book serialise and all land', async () => {
    const book = await asOwner((tx) => createBook(tx, { title: 'Busy', totalPages: 500 }, today))
    const results = await Promise.all(
      [10, 20, 30, 40].map((pages) =>
        asOwner((tx) => recordReadingLog(tx, { bookId: book.id, pagesRead: pages }, today)),
      ),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    const detail = await asOwner((tx) => getBookDetail(tx, book.id))
    expect(detail?.progress).toMatchObject({ currentPage: 100, percent: 20, logCount: 4 })
    expect(detail?.book.status).toBe('reading')
  })

  it('deletes a log and reports its book', async () => {
    const book = await asOwner((tx) => createBook(tx, { title: 'x', totalPages: 100 }, today))
    const r = await asOwner((tx) =>
      recordReadingLog(tx, { bookId: book.id, pageReached: 10 }, today),
    )
    if (!r.ok) throw new Error('expected ok')
    expect(await asOwner((tx) => deleteReadingLog(tx, r.value.log.id))).toEqual({ bookId: book.id })
    expect(await asOwner((tx) => deleteReadingLog(tx, r.value.log.id))).toBeNull()
    expect((await asOwner((tx) => getBookDetail(tx, book.id)))?.logs).toEqual([])
  })

  it('sums minutes per book for a day', async () => {
    const a = await asOwner((tx) => createBook(tx, { title: 'A' }, today))
    const b = await asOwner((tx) => createBook(tx, { title: 'B' }, today))
    await asOwner(async (tx) => {
      await recordReadingLog(tx, { bookId: a.id, minutes: 10 }, today)
      await recordReadingLog(tx, { bookId: a.id, minutes: 15, pagesRead: 4 }, today)
      await recordReadingLog(tx, { bookId: b.id, minutes: 5, localDate: '2026-09-23' }, today)
      await recordReadingLog(tx, { bookId: b.id, pagesRead: 5 }, today)
    })
    const m = await asOwner((tx) => readingMinutesOn(tx, today))
    expect(m.total).toBe(25)
    expect(m.byBook.get(a.id)).toBe(25)
    expect(m.byBook.has(b.id)).toBe(false)
  })
})

describe('learning goals', () => {
  it('links a practice habit and a book, and summarises them for today', async () => {
    const habit = await asOwner((tx) =>
      createPracticeHabit(tx, { title: 'Read 30 minutes', weekdays: [7, 1, 2, 3, 4, 5, 6] }),
    )
    expect(habit).toMatchObject({
      title: 'Read 30 minutes',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      active: true,
    })
    const book = await asOwner((tx) =>
      createBook(tx, { title: 'Big book', totalPages: 300, status: 'reading' }, today),
    )
    await asOwner((tx) =>
      recordReadingLog(tx, { bookId: book.id, pageReached: 100, minutes: 20 }, today),
    )
    const created = await asOwner((tx) =>
      createLearningGoal(tx, {
        title: 'Finish Big book',
        targetDate: '2026-10-03',
        habitId: habit.id,
        bookId: book.id,
        dailyMinutes: 30,
      }),
    )
    expect(created.ok).toBe(true)

    let [view] = await asOwner((tx) => listLearningGoals(tx, today))
    expect(view?.habit).toMatchObject({ id: habit.id, dueToday: true, doneToday: false })
    expect(view?.book).toMatchObject({ id: book.id, title: 'Big book' })
    expect(view?.summary).toMatchObject({
      targetState: 'upcoming',
      daysLeft: 9,
      pace: { kind: 'pages', perDay: 20, pagesLeft: 200, days: 10 },
      minutes: { today: 20, target: 30, met: false },
    })

    await t.db`insert into public.habit_completions (habit_id, local_date) values (${habit.id}, ${today})`
    ;[view] = await asOwner((tx) => listLearningGoals(tx, today))
    expect(view?.habit?.doneToday).toBe(true)
  })

  it('a habit not scheduled today is not due today', async () => {
    // 2026-09-24 is a Thursday (ISO 4).
    const habit = await asOwner((tx) =>
      createPracticeHabit(tx, { title: 'Weekend reading', weekdays: [6, 7] }),
    )
    await asOwner((tx) => createLearningGoal(tx, { title: 'Read more', habitId: habit.id }))
    const [view] = await asOwner((tx) => listLearningGoals(tx, today))
    expect(view?.habit).toMatchObject({ dueToday: false, doneToday: false })
    expect(view?.summary.targetState).toBe('no_target')
    expect(await asOwner((tx) => listPracticeHabitOptions(tx))).toHaveLength(1)
  })

  it('rejects links to habits or books that do not exist', async () => {
    expect(
      await asOwner((tx) => createLearningGoal(tx, { title: 'x', habitId: crypto.randomUUID() })),
    ).toMatchObject({ ok: false, reason: 'invalid', field: 'habitId' })
    expect(
      await asOwner((tx) => createLearningGoal(tx, { title: 'x', bookId: crypto.randomUUID() })),
    ).toMatchObject({ ok: false, reason: 'invalid', field: 'bookId' })
  })

  it('updates, changes status, orders active first and deletes', async () => {
    const a = await asOwner((tx) =>
      createLearningGoal(tx, { title: 'Arabic', targetDate: '2027-06-01' }),
    )
    const b = await asOwner((tx) =>
      createLearningGoal(tx, { title: 'Guitar', targetDate: '2026-12-01' }),
    )
    const c = await asOwner((tx) => createLearningGoal(tx, { title: 'Chess' }))
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected ok')
    await asOwner((tx) => setLearningGoalStatus(tx, b.value.id, 'done'))
    const list = await asOwner((tx) => listLearningGoals(tx, today))
    expect(list.map((g) => g.title)).toEqual(['Arabic', 'Chess', 'Guitar'])
    expect(list[2]?.summary.targetState).toBe('reached')
    expect(
      (await asOwner((tx) => listLearningGoals(tx, today, { includeDone: false }))).length,
    ).toBe(2)

    const updated = await asOwner((tx) =>
      updateLearningGoal(tx, c.value.id, {
        title: 'Chess openings',
        dailyMinutes: 15,
        status: 'paused',
      }),
    )
    expect(updated).toMatchObject({
      ok: true,
      value: { title: 'Chess openings', dailyMinutes: 15, status: 'paused' },
    })
    expect(
      await asOwner((tx) => updateLearningGoal(tx, crypto.randomUUID(), { title: 'x' })),
    ).toEqual({ ok: false, reason: 'not_found' })
    expect(await asOwner((tx) => deleteLearningGoal(tx, a.value.id))).toBe(true)
  })

  it('the database bounds daily minutes', async () => {
    await expect(
      t.db`insert into public.learning_goals (title, daily_minutes) values ('x', 4)`,
    ).rejects.toThrow(/check/)
  })
})

describe('row level security', () => {
  it('a signed-in non-owner sees nothing and can change nothing', async () => {
    const book = await asOwner((tx) => createBook(tx, { title: 'Private', totalPages: 10 }, today))
    await asOwner((tx) => recordReadingLog(tx, { bookId: book.id, pagesRead: 2 }, today))
    const goal = await asOwner((tx) =>
      createLearningGoal(tx, { title: 'Private goal', bookId: book.id }),
    )
    if (!goal.ok) throw new Error('expected ok')

    expect(await asStranger((tx) => listBooksWithProgress(tx))).toEqual([])
    expect(await asStranger((tx) => getBook(tx, book.id))).toBeNull()
    expect(await asStranger((tx) => getBookDetail(tx, book.id))).toBeNull()
    expect(await asStranger((tx) => listLearningGoals(tx, today))).toEqual([])
    expect(await asStranger((tx) => listPracticeHabitOptions(tx))).toEqual([])
    expect(
      await asStranger((tx) => recordReadingLog(tx, { bookId: book.id, pagesRead: 1 }, today)),
    ).toEqual({ ok: false, reason: 'not_found' })
    expect(
      await asStranger((tx) => updateBook(tx, book.id, { title: 'Mine now' }, today)),
    ).toBeNull()
    expect(await asStranger((tx) => deleteBook(tx, book.id))).toBe(false)
    expect(await asStranger((tx) => deleteLearningGoal(tx, goal.value.id))).toBe(false)
    await expect(asStranger((tx) => createBook(tx, { title: 'Sneaky' }, today))).rejects.toThrow(
      /row-level security/,
    )
    await expect(
      asStranger(
        (tx) => tx`insert into public.reading_logs (book_id, local_date, pages_read)
                   values (${book.id}, ${today}, 1)`,
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      asStranger((tx) => createPracticeHabit(tx, { title: 'x', weekdays: [1] })),
    ).rejects.toThrow(/row-level security/)

    // Unchanged for the owner.
    const detail = await asOwner((tx) => getBookDetail(tx, book.id))
    expect(detail?.book.title).toBe('Private')
    expect(detail?.logs).toHaveLength(1)
  })

  it('anon has no access at all', async () => {
    for (const table of ['books', 'reading_logs', 'learning_goals']) {
      await expect(
        withAnon(t.db, (tx) => tx`select * from ${tx(`public.${table}`)}`),
      ).rejects.toThrow(/permission denied/)
    }
  })
})
