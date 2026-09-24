/**
 * Habits repository against a real database: CRUD, idempotent completion for a
 * local date, history for N weeks and RLS.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { habitGridStart, summarizeHabit } from '@personal-home/core'
import {
  createHabit,
  deleteHabit,
  getHabit,
  habitHistory,
  listHabitCompletions,
  listHabits,
  setHabitArchived,
  setHabitCompletion,
  updateHabit,
  withOwner,
  type HabitRow,
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

const LONDON = 'Europe/London'
const TODAY = '2026-09-24'
const NOW = new Date('2026-09-24T12:00:00Z')

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(async () => {
  await t.db`delete from public.habits`
})

const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)
const asStranger = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, stranger, fn)

async function make(title = 'Stretch', weekdays = [1, 2, 3, 4, 5, 6, 7]): Promise<HabitRow> {
  const r = await asOwner((tx) => createHabit(tx, { title, weekdays }))
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.habit
}

const complete = (habitId: string, localDate: string, done = true) =>
  asOwner((tx) => setHabitCompletion(tx, { habitId, localDate, done, today: TODAY, now: NOW }))

describe('habits CRUD', () => {
  it('creates with sorted weekdays, updates, archives, restores and deletes', async () => {
    const r = await asOwner((tx) =>
      createHabit(tx, { title: ' Read ', weekdays: [5, 1, 3], details: 'Ten pages' }),
    )
    expect(r.ok && r.habit).toMatchObject({
      title: 'Read',
      weekdays: [1, 3, 5],
      details: 'Ten pages',
      active: true,
      archivedAt: null,
    })
    if (!r.ok) return
    const id = r.habit.id
    const u = await asOwner((tx) => updateHabit(tx, id, { weekdays: [7, 6] }))
    expect(u.ok && u.habit).toMatchObject({ title: 'Read', weekdays: [6, 7], details: 'Ten pages' })
    const cleared = await asOwner((tx) =>
      updateHabit(tx, id, { details: null, title: 'Read more' }),
    )
    expect(cleared.ok && cleared.habit).toMatchObject({ title: 'Read more', details: null })

    const archived = await asOwner((tx) => setHabitArchived(tx, id, true, NOW))
    expect(archived.ok && archived.habit).toMatchObject({ active: false, archivedAt: NOW })
    expect(await asOwner((tx) => listHabits(tx))).toEqual([])
    expect((await asOwner((tx) => listHabits(tx, { includeArchived: true }))).length).toBe(1)
    const restored = await asOwner((tx) => setHabitArchived(tx, id, false, NOW))
    expect(restored.ok && restored.habit).toMatchObject({ active: true, archivedAt: null })

    expect(await asOwner((tx) => deleteHabit(tx, id))).toBe(true)
    expect(await asOwner((tx) => getHabit(tx, id))).toBeNull()
  })

  it('returns field errors for invalid input', async () => {
    expect(await asOwner((tx) => createHabit(tx, { title: '' }))).toMatchObject({
      ok: false,
      field: 'title',
    })
    expect(await asOwner((tx) => createHabit(tx, { title: 'x', weekdays: [] }))).toMatchObject({
      ok: false,
      field: 'weekdays',
    })
    expect(await asOwner((tx) => createHabit(tx, { title: 'x', weekdays: [0, 8] }))).toMatchObject({
      ok: false,
      field: 'weekdays',
    })
  })
})

describe('habit completion', () => {
  it('is idempotent in both directions', async () => {
    const h = await make()
    expect(await complete(h.id, TODAY)).toEqual({ ok: true, done: true, changed: true })
    expect(await complete(h.id, TODAY)).toEqual({ ok: true, done: true, changed: false })
    expect(await complete(h.id, TODAY, false)).toEqual({ ok: true, done: false, changed: true })
    expect(await complete(h.id, TODAY, false)).toEqual({ ok: true, done: false, changed: false })
  })

  it('stays one row under concurrent check-offs', async () => {
    const h = await make()
    const results = await Promise.all(Array.from({ length: 6 }, () => complete(h.id, TODAY)))
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1)
    const rows = await asOwner((tx) => listHabitCompletions(tx, { from: TODAY, to: TODAY }))
    expect(rows).toHaveLength(1)
  })

  it('refuses future dates, old dates and archived habits', async () => {
    const h = await make()
    expect(await complete(h.id, '2026-09-25')).toMatchObject({ ok: false, field: 'localDate' })
    expect(await complete(h.id, '2024-01-01')).toMatchObject({ ok: false, field: 'localDate' })
    await asOwner((tx) => setHabitArchived(tx, h.id, true, NOW))
    expect(await complete(h.id, TODAY)).toMatchObject({ ok: false, field: 'habitId' })
    expect(await complete('not-a-uuid', TODAY)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('history returns completions in range and feeds an honest summary', async () => {
    const h = await make('Walk', [1, 3, 5])
    await t.db`update public.habits set created_at = '2026-09-01T08:00:00Z' where id = ${h.id}`
    for (const d of ['2026-09-02', '2026-09-04', '2026-09-07', '2026-09-23']) {
      expect((await complete(h.id, d)).ok).toBe(true)
    }
    const from = habitGridStart(TODAY, 8)
    const history = await asOwner((tx) => habitHistory(tx, { today: TODAY, fromDate: from }))
    expect(history.get(h.id)).toEqual(['2026-09-02', '2026-09-04', '2026-09-07', '2026-09-23'])
    const habit = (await asOwner((tx) => getHabit(tx, h.id)))!
    const s = summarizeHabit(habit, history.get(h.id) ?? [], { today: TODAY, tz: LONDON })
    expect(s.missedDays).toBe(6) // 9, 11, 14, 16, 18, 21 September
    expect(s.completedScheduledDays).toBe(4)
    expect(s.currentStreak).toBe(1)
    const narrow = await asOwner((tx) =>
      listHabitCompletions(tx, { from: '2026-09-03', to: '2026-09-07', habitIds: [h.id] }),
    )
    expect(narrow.map((r) => r.localDate)).toEqual(['2026-09-04', '2026-09-07'])
  })

  it('deleting a habit removes its completions', async () => {
    const h = await make()
    await complete(h.id, TODAY)
    await asOwner((tx) => deleteHabit(tx, h.id))
    const [row] = await t.db<
      { n: number }[]
    >`select count(*)::int as n from public.habit_completions`
    expect(row?.n).toBe(0)
  })
})

describe('habits row level security', () => {
  it('a stranger and anon see and change nothing', async () => {
    const h = await make()
    await complete(h.id, TODAY)
    expect(await asStranger((tx) => listHabits(tx, { includeArchived: true }))).toEqual([])
    expect(
      await asStranger((tx) => listHabitCompletions(tx, { from: '2026-01-01', to: TODAY })),
    ).toEqual([])
    expect(
      await asStranger((tx) =>
        setHabitCompletion(tx, { habitId: h.id, localDate: TODAY, done: false, today: TODAY }),
      ),
    ).toEqual({ ok: false, reason: 'not_found' })
    expect(await asStranger((tx) => updateHabit(tx, h.id, { title: 'x' }))).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(await asStranger((tx) => deleteHabit(tx, h.id))).toBe(false)
    await expect(asStranger((tx) => createHabit(tx, { title: 'x' }))).rejects.toThrow(
      /row-level security/,
    )
    await expect(
      asStranger(
        (tx) =>
          tx`insert into public.habit_completions (habit_id, local_date) values (${h.id}, ${TODAY})`,
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(withAnon(t.db, (tx) => tx`select * from public.habits`)).rejects.toThrow(
      /permission denied/,
    )
    await expect(
      withAnon(t.db, (tx) => tx`select * from public.habit_completions`),
    ).rejects.toThrow(/permission denied/)
    const still = await asOwner((tx) => listHabitCompletions(tx, { from: TODAY, to: TODAY }))
    expect(still).toHaveLength(1)
  })
})
