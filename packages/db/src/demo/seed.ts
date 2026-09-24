/**
 * Demo data for a LOCAL database: realistic, clearly labelled rows across tasks, habits (with
 * history), reminders, books with reading logs, learning goals, people with dates and catch-up
 * cadences, notes and a journal entry.
 *
 * Every demo row carries the `[demo]` marker at the start of its title, name or body, so the
 * owner can always tell it apart from their own data and `removeDemoData` can find it again.
 * Child rows (habit completions, reading logs, person dates, task reminders) are removed with
 * their demo parent. Writes go through the same repositories and core validation as the app,
 * so demo rows obey every rule real rows do.
 *
 * Nothing here decides *where* it may run: scripts/seed-demo.mjs checks `demoSeedRefusal()`
 * (local database only, never production or Vercel) before calling in. The functions take a
 * transaction and work as the service role or as the owner (RLS applies to both paths the same
 * way: owner tables only).
 */
import {
  addLocalDays,
  isValidTimeZone,
  isoWeekday,
  localDateInZone,
  localTimeInZone,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import { createTask, setTaskStatus } from '../tasks/tasks.ts'
import { createHabit, setHabitCompletion } from '../tasks/habits.ts'
import { createReminder } from '../tasks/reminders.ts'
import { createBook, recordReadingLog } from '../learning/books.ts'
import { createLearningGoal } from '../learning/goals.ts'
import { addPersonDate, createPerson } from '../people/people.ts'
import { saveNote } from '../notes/repository.ts'
import { saveJournalEntry } from '../journal/entries.ts'

/** The marker every demo row starts with. */
export const DEMO_MARKER = '[demo]'

/** `[demo] Title` — the label a demo row is stored under. */
export function demoLabel(text: string): string {
  return `${DEMO_MARKER} ${text}`
}

/** True for a title, name or body that carries the demo marker. */
export function isDemoLabel(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.startsWith(DEMO_MARKER)
}

// A LIKE pattern for the marker: `[` and `]` are not LIKE wildcards, so only `%` is added.
const DEMO_LIKE = `${DEMO_MARKER}%`

export interface DemoCounts {
  tasks: number
  reminders: number
  habits: number
  habitCompletions: number
  books: number
  readingLogs: number
  learningGoals: number
  people: number
  personDates: number
  notes: number
  journalEntries: number
  /** Daily plans drafted from demo rows (removed so they are redrafted from real data). */
  dailyPlans: number
}

export const DEMO_TABLES = [
  'tasks',
  'reminders',
  'habits',
  'habitCompletions',
  'books',
  'readingLogs',
  'learningGoals',
  'people',
  'personDates',
  'notes',
  'journalEntries',
  'dailyPlans',
] as const satisfies readonly (keyof DemoCounts)[]

export function demoTotal(counts: DemoCounts): number {
  return DEMO_TABLES.reduce((sum, key) => sum + counts[key], 0)
}

/** How many demo rows exist, per table (child rows counted through their demo parent). */
export async function countDemoRows(tx: Tx): Promise<DemoCounts> {
  const [row] = await tx<DemoCounts[]>`
    select
      (select count(*) from public.tasks where title like ${DEMO_LIKE})::int as tasks,
      (select count(*) from public.reminders r
        where r.title like ${DEMO_LIKE}
           or (r.subject_kind = 'task' and exists (
                select 1 from public.tasks t where t.id = r.subject_id and t.title like ${DEMO_LIKE})))::int
        as reminders,
      (select count(*) from public.habits where title like ${DEMO_LIKE})::int as habits,
      (select count(*) from public.habit_completions c
        join public.habits h on h.id = c.habit_id where h.title like ${DEMO_LIKE})::int as habit_completions,
      (select count(*) from public.books where title like ${DEMO_LIKE})::int as books,
      (select count(*) from public.reading_logs l
        join public.books b on b.id = l.book_id where b.title like ${DEMO_LIKE})::int as reading_logs,
      (select count(*) from public.learning_goals where title like ${DEMO_LIKE})::int as learning_goals,
      (select count(*) from public.people where name like ${DEMO_LIKE})::int as people,
      (select count(*) from public.person_dates d
        join public.people p on p.id = d.person_id where p.name like ${DEMO_LIKE})::int as person_dates,
      (select count(*) from public.notes where title like ${DEMO_LIKE})::int as notes,
      (select count(*) from public.journal_entries where body like ${DEMO_LIKE})::int as journal_entries,
      (select count(*) from public.daily_plans p where exists (
        select 1 from public.plan_blocks b where b.plan_id = p.id and b.title_snapshot like ${DEMO_LIKE})
      )::int as daily_plans
  `
  if (!row) throw new Error('demo count returned no row')
  return row
}

/** Cheap check for Home: is any demo row present? */
export async function demoDataPresent(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ present: boolean }[]>`
    select (
      exists (select 1 from public.tasks where title like ${DEMO_LIKE})
      or exists (select 1 from public.reminders where title like ${DEMO_LIKE})
      or exists (select 1 from public.habits where title like ${DEMO_LIKE})
      or exists (select 1 from public.books where title like ${DEMO_LIKE})
      or exists (select 1 from public.learning_goals where title like ${DEMO_LIKE})
      or exists (select 1 from public.people where name like ${DEMO_LIKE})
      or exists (select 1 from public.notes where title like ${DEMO_LIKE})
      or exists (select 1 from public.journal_entries where body like ${DEMO_LIKE})
    ) as present
  `
  return row?.present === true
}

/**
 * Delete every demo row and what hangs off it. Rows without the marker are never touched,
 * except daily plans that contain demo blocks: their priorities and blocks were drafted from
 * demo data, so they are deleted and redrafted from real data on the next visit.
 * Returns what was removed.
 */
export async function removeDemoData(tx: Tx): Promise<DemoCounts> {
  const before = await countDemoRows(tx)
  await tx`
    delete from public.daily_plans p where exists (
      select 1 from public.plan_blocks b where b.plan_id = p.id and b.title_snapshot like ${DEMO_LIKE})
  `
  // Goals first: they reference demo habits and books (on delete set null would keep them).
  await tx`delete from public.learning_goals where title like ${DEMO_LIKE}`
  // Task reminders go with their task (trigger); custom demo reminders by title.
  await tx`delete from public.tasks where title like ${DEMO_LIKE}`
  await tx`delete from public.reminders where title like ${DEMO_LIKE}`
  await tx`delete from public.habits where title like ${DEMO_LIKE}`
  await tx`delete from public.notes where title like ${DEMO_LIKE}`
  await tx`delete from public.books where title like ${DEMO_LIKE}`
  await tx`delete from public.people where name like ${DEMO_LIKE}`
  await tx`delete from public.journal_entries where body like ${DEMO_LIKE}`
  return before
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface DemoSeedResult {
  timezone: string
  today: string
  /** Demo rows removed first (re-running the seed replaces the previous demo rows). */
  replaced: DemoCounts
  /** Demo rows present afterwards. */
  counts: DemoCounts
  /** Journal dates skipped because the owner already had an entry that day. */
  skippedJournalDates: string[]
}

function must<T>(result: { ok: true; value: T } | { ok: false }, what: string): T {
  if (!result.ok) throw new Error(`demo seed: could not create ${what}: ${JSON.stringify(result)}`)
  return result.value
}

function mustTask<T extends { ok: boolean }>(result: T, what: string): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`demo seed: could not create ${what}: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

/** A local date `days` from `today` as { month, day } for an important date. */
function monthDay(localDate: string): { month: number; day: number } {
  return { month: Number(localDate.slice(5, 7)), day: Number(localDate.slice(8, 10)) }
}

/**
 * Round an instant up to the next quarter hour, then express it in owner-local terms.
 * Used for a timed task "due in about three hours" whatever time the seed runs.
 */
function localSlot(instant: Date, tz: string): { date: string; time: string } {
  const quarter = 15 * 60_000
  const rounded = new Date(Math.ceil(instant.getTime() / quarter) * quarter)
  return { date: localDateInZone(rounded, tz), time: localTimeInZone(rounded, tz) }
}

/**
 * Seed the demo data set, replacing any earlier demo rows. Dates are relative to `now` in the
 * owner's saved timezone, so the data looks current whenever it is seeded: an overdue task, a
 * timed task due in about three hours, a due reminder, habits with eight weeks of history (with
 * honest misses), books in progress, a birthday coming up and a catch-up that is overdue.
 */
export async function seedDemoData(tx: Tx, opts: { now?: Date } = {}): Promise<DemoSeedResult> {
  const now = opts.now ?? new Date()
  const [settings] = await tx<{ timezone: string }[]>`select timezone from public.owner_settings`
  if (!settings) throw new Error('demo seed: owner settings not found (run the migrations first)')
  if (!isValidTimeZone(settings.timezone)) {
    throw new Error('demo seed: the saved timezone is not usable here')
  }
  const tz = settings.timezone
  const today = localDateInZone(now, tz)
  const day = (offset: number) => addLocalDays(today, offset)
  const ctx = { tz, now }

  const replaced = await removeDemoData(tx)
  // Today's untouched draft plan (no owner decisions yet) is redrafted from the new data on the
  // next visit. Plans the owner has acted on are left alone.
  await tx`delete from public.daily_plans where local_date >= ${today}::date and status = 'draft'`

  // --- Tasks ---------------------------------------------------------------
  const soon = localSlot(new Date(now.getTime() + 3 * 3_600_000), tz)
  const task = async (
    what: string,
    input: Parameters<typeof createTask>[1],
    reminder?: Parameters<typeof createTask>[2]['reminder'],
  ) => mustTask(await createTask(tx, input, { ...ctx, reminder }), what).task

  await task('overdue task', {
    title: demoLabel('Send the quarterly VAT figures to the accountant'),
    dueDate: day(-2),
    priority: 1,
    durationMinutes: 45,
    details: 'Spreadsheet is in the shared folder; check the fuel receipts first.',
  })
  await task(
    'timed task',
    {
      title: demoLabel('Call the dentist to move the check-up'),
      dueDate: soon.date,
      dueTime: soon.time,
      durationMinutes: 10,
      priority: 2,
    },
    { choice: '1h' },
  )
  await task('task due today', {
    title: demoLabel('Draft the project kickoff notes'),
    dueDate: today,
    priority: 2,
    durationMinutes: 60,
    splittable: true,
  })
  await task('small task due today', {
    title: demoLabel('Pay the window cleaner'),
    dueDate: today,
    durationMinutes: 10,
  })
  await task('task due tomorrow', {
    title: demoLabel('Book train tickets for the weekend'),
    dueDate: day(1),
    priority: 3,
    durationMinutes: 20,
  })
  await task('upcoming task', {
    title: demoLabel('Order a birthday present for Maya'),
    dueDate: day(4),
    durationMinutes: 30,
  })
  await task('undated task', {
    title: demoLabel('Sort out the photo backup'),
    durationMinutes: 90,
    splittable: true,
  })
  const done = await task('finished task', {
    title: demoLabel('Return the library books'),
    dueDate: day(-1),
    durationMinutes: 15,
  })
  const completed = await setTaskStatus(
    tx,
    done.id,
    'complete',
    new Date(now.getTime() - 20 * 3_600_000),
  )
  if (!completed.ok) throw new Error('demo seed: could not complete a task')

  // --- Reminders -----------------------------------------------------------
  // A reminder that is already due: the app never lets the owner set one in the past, so it is
  // written directly (as a reminder whose time has just passed would be).
  await tx`
    insert into public.reminders (title, subject_kind, remind_at)
    values (${demoLabel('Put the recycling out')}, 'custom', ${new Date(now.getTime() - 30 * 60_000)}::timestamptz)
  `
  // A weekly reminder on the coming Sunday morning (schedule resolved like any owner reminder).
  const sunday = day(7 - isoWeekday(today) || 7)
  mustTask(
    await createReminder(
      tx,
      { title: demoLabel('Water the plants'), date: sunday, time: '10:00', recurrence: 'weekly' },
      ctx,
    ),
    'weekly reminder',
  )

  // --- Habits (eight weeks of history, with honest misses) ------------------
  const HISTORY_DAYS = 56
  const habitStart = new Date(now.getTime() - (HISTORY_DAYS + 1) * 86_400_000)
  const habit = async (title: string, weekdays: number[], skipEvery: number) => {
    const h = mustTask(await createHabit(tx, { title: demoLabel(title), weekdays }), title).habit
    await tx`update public.habits set created_at = ${habitStart}::timestamptz where id = ${h.id}::uuid`
    // Completions on scheduled days before today; every `skipEvery`-th scheduled day is missed.
    let scheduled = 0
    for (let offset = -HISTORY_DAYS; offset < 0; offset++) {
      const date = day(offset)
      if (!weekdays.includes(isoWeekday(date))) continue
      scheduled++
      if (scheduled % skipEvery === 0) continue
      const r = await setHabitCompletion(tx, { habitId: h.id, localDate: date, done: true, today })
      if (!r.ok) throw new Error(`demo seed: could not record a completion for ${title}`)
    }
    return h
  }
  await habit('Morning stretch', [1, 2, 3, 4, 5, 6, 7], 5)
  await habit('Evening walk', [1, 2, 3, 4, 5], 4)
  const reading = await habit('Read 20 minutes', [1, 2, 3, 4, 5, 6, 7], 3)
  await habit('Weekly review', [7], 6)

  // --- Books and reading logs ----------------------------------------------
  const book = async (input: Parameters<typeof createBook>[1]) => createBook(tx, input, today)
  const log = async (input: Parameters<typeof recordReadingLog>[1]) =>
    must(await recordReadingLog(tx, input, today), 'reading log')

  const pragmatic = await book({
    title: demoLabel('The Pragmatic Programmer'),
    author: 'David Thomas and Andrew Hunt',
    totalPages: 352,
    status: 'reading',
    startedOn: day(-21),
  })
  await log({ bookId: pragmatic.id, localDate: day(-20), pageReached: 40, minutes: 30 })
  await log({ bookId: pragmatic.id, localDate: day(-12), pageReached: 88, minutes: 35 })
  await log({ bookId: pragmatic.id, localDate: day(-5), pagesRead: 24, minutes: 30 })
  await log({ bookId: pragmatic.id, localDate: day(-1), pageReached: 140, minutes: 25 })

  const systems = await book({
    title: demoLabel('Thinking in Systems'),
    author: 'Donella H. Meadows',
    totalPages: 240,
    status: 'reading',
    startedOn: day(-10),
  })
  await log({ bookId: systems.id, localDate: day(-9), percent: 12 })
  await log({ bookId: systems.id, localDate: day(-3), percent: 31, minutes: 20 })

  await book({
    title: demoLabel('Atomic Habits'),
    author: 'James Clear',
    totalPages: 320,
    status: 'finished',
    startedOn: day(-62),
    finishedOn: day(-30),
  })
  await book({
    title: demoLabel('The Overstory'),
    author: 'Richard Powers',
    totalPages: 502,
    status: 'want',
  })

  // --- Learning goals ------------------------------------------------------
  must(
    await createLearningGoal(tx, {
      title: demoLabel('Read 20 minutes a day'),
      details: 'Mostly the programming book, before bed.',
      habitId: reading.id,
      bookId: pragmatic.id,
      dailyMinutes: 20,
      targetDate: day(60),
    }),
    'learning goal',
  )
  must(
    await createLearningGoal(tx, {
      title: demoLabel('Finish Thinking in Systems'),
      bookId: systems.id,
      targetDate: day(35),
    }),
    'learning goal',
  )

  // --- People --------------------------------------------------------------
  const person = async (input: Parameters<typeof createPerson>[1]) =>
    must(await createPerson(tx, input, today), 'person')
  const date = async (personId: string, input: Parameters<typeof addPersonDate>[2]) =>
    must(await addPersonDate(tx, personId, input), 'important date')

  const maya = await person({
    name: demoLabel('Maya Patel'),
    relationship: 'sister',
    notes: 'Training for the half marathon in October.',
    catchUpEveryDays: 14,
    lastCaughtUpOn: day(-20),
  })
  await date(maya.id, { label: 'Birthday', ...monthDay(day(5)), year: 1994, remindDaysBefore: 7 })

  const rose = await person({
    name: demoLabel('Grandma Rose'),
    relationship: 'grandmother',
    notes: 'Prefers a phone call on Sunday afternoons.',
    catchUpEveryDays: 7,
    lastCaughtUpOn: day(-7),
  })
  await date(rose.id, { label: 'Birthday', ...monthDay(day(2)), year: 1941, remindDaysBefore: 3 })

  const tom = await person({
    name: demoLabel('Tom Okafor'),
    relationship: 'old school friend',
    catchUpEveryDays: 30,
    lastCaughtUpOn: day(-12),
  })
  await date(tom.id, {
    label: 'Wedding anniversary',
    ...monthDay(day(21)),
    year: 2019,
    remindDaysBefore: 7,
  })

  await person({
    name: demoLabel('Sam Lee'),
    relationship: 'mentor',
    notes: 'Suggested reading: Thinking in Systems.',
  })

  // --- Notes and journal ---------------------------------------------------
  const note = async (
    title: string,
    body: string,
    links: { bookId?: string; personId?: string },
  ) => {
    const r = await saveNote(tx, {
      id: globalThis.crypto.randomUUID(),
      baseVersion: 0,
      content: {
        title: demoLabel(title),
        body,
        pinned: false,
        projectId: null,
        linkedDate: null,
        bookId: links.bookId ?? null,
        personId: links.personId ?? null,
      },
    })
    if (r.status !== 'saved') throw new Error(`demo seed: could not save a note (${r.status})`)
  }
  await note(
    'Kickoff agenda',
    'Goals for the first month\nWho owns what\nOpen questions: budget sign-off, launch date',
    {},
  )
  await note(
    'Ideas from The Pragmatic Programmer',
    'Tracer bullets: build a thin end-to-end slice first.\nDon’t live with broken windows.',
    { bookId: pragmatic.id },
  )
  await note('Gift ideas for Maya', 'Running socks, the new Sally Rooney, a massage voucher.', {
    personId: maya.id,
  })

  const skippedJournalDates: string[] = []
  const journalDate = day(-1)
  const entry = await saveJournalEntry(tx, {
    localDate: journalDate,
    baseVersion: 0,
    content: {
      body: demoLabel(
        'Long day, but the kickoff prep moved forward. Walked in the evening and read a chapter before bed.',
      ),
      prompts: {
        what_happened: 'Planning meeting ran over; lunch with Tom.',
        moved_forward: 'Kickoff notes outline is done.',
        needs_attention: 'VAT figures are still waiting.',
        next: 'Send the figures first thing, then the dentist.',
      },
    },
  })
  // The owner already wrote an entry that day: never overwrite it with demo text.
  if (entry.status !== 'saved' || !isDemoLabel(entry.entry.body))
    skippedJournalDates.push(journalDate)

  return { timezone: tz, today, replaced, counts: await countDemoRows(tx), skippedJournalDates }
}

// ---------------------------------------------------------------------------
// Where demo data may be written
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface DemoSeedEnvironment {
  NODE_ENV?: string | undefined
  VERCEL?: string | undefined
  VERCEL_ENV?: string | undefined
}

/**
 * Why demo data must NOT be written to this database, or null when it may be.
 * Only a local Postgres (localhost / 127.0.0.1 / ::1) is accepted, and never when the
 * environment says production or Vercel.
 */
export function demoSeedRefusal(
  databaseUrl: string | undefined,
  env: DemoSeedEnvironment,
): string | null {
  if (env.NODE_ENV === 'production') return 'NODE_ENV is production'
  if (env.VERCEL || env.VERCEL_ENV) return 'this looks like a Vercel environment'
  if (!databaseUrl) return 'no database URL was given'
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    return 'the database URL could not be parsed'
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return 'the database URL is not a postgres:// URL'
  }
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    return 'the database host is not local (only localhost, 127.0.0.1 or ::1 are allowed)'
  }
  // A host given as a query parameter would override the URL's host.
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === 'host' || key.toLowerCase() === 'hostaddr') {
      return 'the database URL overrides its host with a query parameter'
    }
  }
  return null
}
