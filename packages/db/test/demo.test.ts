/**
 * Demo data (packages/db/src/demo) against a real Postgres, plus scripts/seed-demo.mjs end to end.
 * All data here is synthetic.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { zonedLocalToUtc } from '@personal-home/core'
import {
  DEMO_MARKER,
  countDemoRows,
  createTask,
  demoDataPresent,
  demoLabel,
  demoSeedRefusal,
  demoTotal,
  isDemoLabel,
  listBooksWithProgress,
  listHabitCompletions,
  listHabits,
  listNeedsAttention,
  listPeopleAttention,
  listTasks,
  plannerEnsurePlan,
  plannerEnsureTodayPlan,
  plannerLoadSettings,
  removeDemoData,
  saveJournalEntry,
  seedDemoData,
  withOwner,
  withService,
  type OwnerClaims,
  type Tx,
} from '../src/index.ts'
import { createAuthUser, createTestDatabase, seedOwner, type TestDatabase } from './harness.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TZ = 'Europe/London'
// A Thursday, mid-morning in London.
const NOW = zonedLocalToUtc('2026-09-24', '10:00', TZ)
const TODAY = '2026-09-24'

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)

async function wipe() {
  await t.db`
    delete from public.daily_plans; delete from public.learning_goals; delete from public.tasks;
    delete from public.reminders; delete from public.habits; delete from public.books;
    delete from public.people; delete from public.notes; delete from public.journal_entries;
    delete from public.projects
  `.simple()
}

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
  await t.db`update public.owner_settings set timezone = ${TZ}, timezone_confirmed = true`
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(wipe)

describe('seedDemoData', () => {
  it('seeds labelled rows across every area, relative to the owner’s today', async () => {
    const result = await asOwner((tx) => seedDemoData(tx, { now: NOW }))
    expect(result.today).toBe(TODAY)
    expect(result.timezone).toBe(TZ)
    expect(demoTotal(result.replaced)).toBe(0)
    expect(result.counts).toMatchObject({
      projects: 2,
      tasks: 9,
      reminders: 3,
      habits: 4,
      books: 4,
      readingLogs: 6,
      learningGoals: 2,
      people: 4,
      personDates: 3,
      notes: 3,
      journalEntries: 1,
    })
    expect(result.counts.habitCompletions).toBeGreaterThan(60)

    // Every top-level row carries the marker.
    const unmarked = await t.db<{ n: number }[]>`
      select (
        (select count(*) from public.tasks where title not like '[demo]%') +
        (select count(*) from public.projects where name not like '[demo]%') +
        (select count(*) from public.reminders where subject_kind = 'custom' and title not like '[demo]%') +
        (select count(*) from public.habits where title not like '[demo]%') +
        (select count(*) from public.books where title not like '[demo]%') +
        (select count(*) from public.learning_goals where title not like '[demo]%') +
        (select count(*) from public.people where name not like '[demo]%') +
        (select count(*) from public.notes where title not like '[demo]%') +
        (select count(*) from public.journal_entries where body not like '[demo]%')
      )::int as n
    `
    expect(unmarked[0]!.n).toBe(0)
    expect(await asOwner((tx) => demoDataPresent(tx))).toBe(true)
  })

  it('feeds Home: attention items, today’s tasks, habit history, reading and people', async () => {
    await asOwner((tx) => seedDemoData(tx, { now: NOW }))
    await asOwner(async (tx) => {
      const attention = await listNeedsAttention(tx, NOW, TZ)
      expect(attention.counts).toEqual({ overdue: 1, dueSoon: 1, reminders: 1 })
      expect(attention.items.map((i) => i.title)).toEqual([
        demoLabel('Send the quarterly VAT figures to the accountant'),
        demoLabel('Put the recycling out'),
        demoLabel('Call the dentist to move the check-up'),
      ])

      const today = await listTasks(tx, { filter: 'today', now: NOW, tz: TZ })
      expect(today.map((r) => r.title).sort()).toEqual(
        [
          demoLabel('Call the dentist to move the check-up'),
          demoLabel('Draft the project kickoff notes'),
          demoLabel('Pay the window cleaner'),
        ].sort(),
      )
      // Due in about three hours, on the quarter hour.
      const timed = today.find((r) => r.dueAt)!
      const minutesAhead = (timed.dueAt!.getTime() - NOW.getTime()) / 60_000
      expect(minutesAhead).toBeGreaterThanOrEqual(180)
      expect(minutesAhead).toBeLessThan(195)

      // Habits: history with honest misses, nothing checked off today yet.
      const habits = await listHabits(tx)
      expect(habits).toHaveLength(4)
      const completions = await listHabitCompletions(tx, { from: '2026-07-01', to: TODAY })
      expect(completions.some((c) => c.localDate === TODAY)).toBe(false)
      const stretch = habits.find((h) => h.title === demoLabel('Morning stretch'))!
      const stretchDays = completions.filter((c) => c.habitId === stretch.id).length
      expect(stretchDays).toBeGreaterThan(40)
      expect(stretchDays).toBeLessThan(56)

      const books = await listBooksWithProgress(tx)
      const pragmatic = books.find((b) => b.title === demoLabel('The Pragmatic Programmer'))!
      expect(pragmatic.status).toBe('reading')
      expect(pragmatic.progress.currentPage).toBe(140)

      const people = await listPeopleAttention(tx, TODAY, 30)
      expect(people.upcomingDates.map((d) => [d.personName, d.daysUntil, d.reminderDue])).toEqual([
        [demoLabel('Grandma Rose'), 2, true],
        [demoLabel('Maya Patel'), 5, true],
        [demoLabel('Tom Okafor'), 21, false],
      ])
      expect(people.dueCatchUps.map((c) => [c.personName, c.daysOverdue])).toEqual([
        [demoLabel('Maya Patel'), 6],
        [demoLabel('Grandma Rose'), 0],
      ])
    })
  })

  it('re-running replaces the previous demo rows and never touches the owner’s own rows', async () => {
    const mine = await asOwner((tx) =>
      createTask(tx, { title: 'My real task', dueDate: TODAY }, { tz: TZ, now: NOW }),
    )
    expect(mine.ok).toBe(true)
    await t.db`insert into public.people (name) values ('Real friend')`
    // The owner's own journal entry for yesterday must not be overwritten by the demo entry.
    await asOwner((tx) =>
      saveJournalEntry(tx, {
        localDate: '2026-09-23',
        baseVersion: 0,
        content: { body: 'My own words', prompts: {} },
      }),
    )

    const first = await asOwner((tx) => seedDemoData(tx, { now: NOW }))
    expect(first.skippedJournalDates).toEqual(['2026-09-23'])
    expect(first.counts.journalEntries).toBe(0)
    const second = await asOwner((tx) => seedDemoData(tx, { now: NOW }))
    expect(demoTotal(second.replaced)).toBe(demoTotal(first.counts))
    expect(second.counts).toEqual(first.counts)

    const removed = await asOwner((tx) => removeDemoData(tx))
    expect(removed).toEqual(second.counts)
    expect(demoTotal(await asOwner((tx) => countDemoRows(tx)))).toBe(0)
    expect(await asOwner((tx) => demoDataPresent(tx))).toBe(false)

    const left = await t.db<{ title: string }[]>`
      select title from public.tasks union all select name from public.people
      union all select body from public.journal_entries
    `
    expect(left.map((r) => r.title).sort()).toEqual(['My own words', 'My real task', 'Real friend'])
    // No orphans: completions, logs, dates and task reminders went with their parents.
    const orphans = await t.db<{ n: number }[]>`
      select ((select count(*) from public.habit_completions) + (select count(*) from public.reading_logs)
        + (select count(*) from public.person_dates) + (select count(*) from public.reminders))::int as n
    `
    expect(orphans[0]!.n).toBe(0)
  })

  it('removes plans drafted from demo rows, keeps other plans, and redrafts today’s untouched draft', async () => {
    await asOwner(async (tx) => {
      const settings = await plannerLoadSettings(tx)
      // A plan for another day with no demo content stays.
      await plannerEnsurePlan(tx, {
        now: NOW,
        localDate: '2026-09-20',
        settings,
        source: 'manual',
      })
      // Today's draft, made before the demo data existed: replaced by seeding.
      await plannerEnsureTodayPlan(tx, { now: NOW })
    })
    await asOwner((tx) => seedDemoData(tx, { now: NOW }))
    expect(
      (await t.db`select local_date from public.daily_plans order by local_date`).map(
        (r) => r.localDate,
      ),
    ).toEqual(['2026-09-20'])

    const drafted = await asOwner((tx) => plannerEnsureTodayPlan(tx, { now: NOW }))
    expect(drafted.created).toBe(true)
    expect(drafted.plan.blocks.some((b) => isDemoLabel(b.titleSnapshot))).toBe(true)
    expect((await asOwner((tx) => countDemoRows(tx))).dailyPlans).toBe(1)

    await asOwner((tx) => removeDemoData(tx))
    expect(
      (await t.db`select local_date from public.daily_plans order by local_date`).map(
        (r) => r.localDate,
      ),
    ).toEqual(['2026-09-20'])
  })

  it('works as the service role too, and a non-owner cannot seed', async () => {
    const r = await withService(t.db, (tx) => seedDemoData(tx, { now: NOW }))
    expect(demoTotal(r.counts)).toBeGreaterThan(100)
    await expect(withOwner(t.db, stranger, (tx) => seedDemoData(tx, { now: NOW }))).rejects.toThrow(
      /owner settings not found/,
    )
    // A stranger sees (and removes) nothing.
    const removed = await withOwner(t.db, stranger, (tx) => removeDemoData(tx))
    expect(demoTotal(removed)).toBe(0)
    expect(await asOwner((tx) => demoDataPresent(tx))).toBe(true)
  })
})

describe('demo labels', () => {
  it('marks and recognises demo text', () => {
    expect(demoLabel('Walk')).toBe(`${DEMO_MARKER} Walk`)
    expect(isDemoLabel('[demo] Walk')).toBe(true)
    expect(isDemoLabel('Walk [demo]')).toBe(false)
    expect(isDemoLabel(null)).toBe(false)
  })
})

describe('demoSeedRefusal', () => {
  const local = 'postgres://postgres@127.0.0.1:54329/ph_dev'
  it('accepts local databases only', () => {
    expect(demoSeedRefusal(local, {})).toBeNull()
    expect(demoSeedRefusal('postgresql://u@localhost/db', {})).toBeNull()
    expect(demoSeedRefusal('postgres://u@[::1]:5432/db', {})).toBeNull()
    expect(demoSeedRefusal('postgres://u:p@db.abcd.supabase.co:5432/postgres', {})).toMatch(
      /not local/,
    )
    expect(demoSeedRefusal('postgres://u@127.0.0.2/db', {})).toMatch(/not local/)
    expect(demoSeedRefusal('postgres://u@localhost.example.com/db', {})).toMatch(/not local/)
    expect(demoSeedRefusal('postgres://u@localhost/db?host=db.example.com', {})).toMatch(
      /query parameter/,
    )
    expect(demoSeedRefusal('mysql://u@localhost/db', {})).toMatch(/postgres/)
    expect(demoSeedRefusal('not a url', {})).toMatch(/parsed/)
    expect(demoSeedRefusal(undefined, {})).toMatch(/no database URL/)
  })
  it('refuses production and Vercel environments', () => {
    expect(demoSeedRefusal(local, { NODE_ENV: 'production' })).toMatch(/production/)
    expect(demoSeedRefusal(local, { VERCEL: '1' })).toMatch(/Vercel/)
    expect(demoSeedRefusal(local, { VERCEL_ENV: 'preview' })).toMatch(/Vercel/)
    expect(demoSeedRefusal(local, { NODE_ENV: 'development' })).toBeNull()
  })
})

describe('scripts/seed-demo.mjs', () => {
  function runScript(args: string[], env: Record<string, string | undefined>) {
    const clean = { ...process.env }
    delete clean.VERCEL
    delete clean.VERCEL_ENV
    delete clean.NODE_ENV
    return spawnSync(process.execPath, ['scripts/seed-demo.mjs', ...args], {
      cwd: ROOT,
      env: { ...clean, ...env },
      encoding: 'utf8',
    })
  }

  it('seeds and removes through the command line', () => {
    const seeded = runScript([], { DATABASE_URL: t.url })
    expect(seeded.status, seeded.stderr).toBe(0)
    expect(seeded.stdout).toMatch(/seeded \d+ demo rows/)
    expect(seeded.stdout).not.toContain('postgres://')

    const removed = runScript(['--remove', '--database-url', t.url], {})
    expect(removed.status, removed.stderr).toBe(0)
    expect(removed.stdout).toMatch(/removed \d+ demo rows/)
  })

  it('refuses production, Vercel and remote targets without writing anything', async () => {
    for (const env of [
      { DATABASE_URL: t.url, NODE_ENV: 'production' },
      { DATABASE_URL: t.url, VERCEL: '1' },
      { DATABASE_URL: 'postgres://postgres@db.example.com:5432/postgres' },
    ]) {
      const r = runScript([], env)
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/refusing to run/)
    }
    expect(await asOwner((tx) => demoDataPresent(tx))).toBe(false)
  })
})
