import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addPersonDate,
  createPerson,
  deletePerson,
  deletePersonDate,
  getPerson,
  listPeople,
  listPeopleAttention,
  markCaughtUp,
  updatePerson,
  updatePersonDate,
  withOwner,
  type OwnerClaims,
  type Person,
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

async function person(input: Parameters<typeof createPerson>[1], day = today): Promise<Person> {
  const r = await asOwner((tx) => createPerson(tx, input, day))
  if (!r.ok) throw new Error(`createPerson failed: ${JSON.stringify(r)}`)
  return r.value
}

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(async () => {
  await t.db`delete from public.people`
})

describe('people', () => {
  it('creates a person; a cadence starts counting from today', async () => {
    const sam = await person({
      name: ' Sam Ortiz ',
      relationship: 'old school friend',
      notes: 'Moved to Leeds.\nLikes climbing.',
      catchUpEveryDays: 30,
    })
    expect(sam).toMatchObject({
      name: 'Sam Ortiz',
      relationship: 'old school friend',
      notes: 'Moved to Leeds.\nLikes climbing.',
      catchUpEveryDays: 30,
      lastCaughtUpOn: null,
      catchUpStartedOn: today,
    })
    const summary = await asOwner((tx) => getPerson(tx, sam.id, today))
    expect(summary?.catchUp).toEqual({
      state: 'upcoming',
      dueOn: '2026-10-24',
      daysUntilDue: 30,
      neverCaughtUp: true,
    })
  })

  it('keeps the cadence start through edits, clears it when the cadence is removed', async () => {
    const p = await person({ name: 'Ada', catchUpEveryDays: 14 }, '2026-09-01')
    const edited = await asOwner((tx) =>
      updatePerson(tx, p.id, { name: 'Ada L.', catchUpEveryDays: 21 }, today),
    )
    expect(edited).toMatchObject({
      ok: true,
      value: { catchUpEveryDays: 21, catchUpStartedOn: '2026-09-01' },
    })
    const off = await asOwner((tx) => updatePerson(tx, p.id, { name: 'Ada L.' }, today))
    expect(off).toMatchObject({
      ok: true,
      value: { catchUpEveryDays: null, catchUpStartedOn: null },
    })
    const on = await asOwner((tx) =>
      updatePerson(tx, p.id, { name: 'Ada L.', catchUpEveryDays: 7 }, today),
    )
    expect(on).toMatchObject({ ok: true, value: { catchUpStartedOn: today } })
    expect(
      await asOwner((tx) => updatePerson(tx, crypto.randomUUID(), { name: 'x' }, today)),
    ).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses a last catch-up in the future', async () => {
    expect(
      await asOwner((tx) =>
        createPerson(tx, { name: 'x', catchUpEveryDays: 7, lastCaughtUpOn: '2026-09-25' }, today),
      ),
    ).toMatchObject({ ok: false, reason: 'invalid', field: 'lastCaughtUpOn' })
  })

  it('"caught up today" is idempotent and never moves the date backwards', async () => {
    const p = await person({ name: 'Mum', catchUpEveryDays: 7, lastCaughtUpOn: '2026-09-01' })
    expect((await asOwner((tx) => markCaughtUp(tx, p.id, today)))?.lastCaughtUpOn).toBe(today)
    expect((await asOwner((tx) => markCaughtUp(tx, p.id, today)))?.lastCaughtUpOn).toBe(today)
    // A westward timezone change can make "today" earlier than the stored date.
    expect((await asOwner((tx) => markCaughtUp(tx, p.id, '2026-09-23')))?.lastCaughtUpOn).toBe(
      today,
    )
    const summary = await asOwner((tx) => getPerson(tx, p.id, today))
    expect(summary?.catchUp).toMatchObject({
      state: 'upcoming',
      dueOn: '2026-10-01',
      neverCaughtUp: false,
    })
    expect(await asOwner((tx) => markCaughtUp(tx, crypto.randomUUID(), today))).toBeNull()
  })

  it('the database enforces the cadence range and start consistency', async () => {
    await expect(
      t.db`insert into public.people (name, catch_up_every_days) values ('x', 3)`,
    ).rejects.toThrow(/check/)
    await expect(
      t.db`insert into public.people (name, catch_up_started_on) values ('x', ${today})`,
    ).rejects.toThrow(/people_cadence_started/)
  })

  it('searches name, relationship and notes case-insensitively, as plain text', async () => {
    await person({ name: 'Ann Lee', relationship: 'Sister' })
    await person({ name: 'Bob', notes: 'Met at the 100% club' })
    await person({ name: 'Carla_M', relationship: 'mentor' })
    const names = async (search: string) =>
      (await asOwner((tx) => listPeople(tx, { today, search }))).map((p) => p.name)
    expect(await names('')).toEqual(['Ann Lee', 'Bob', 'Carla_M'])
    expect(await names('ANN')).toEqual(['Ann Lee'])
    expect(await names('sister')).toEqual(['Ann Lee'])
    expect(await names('100%')).toEqual(['Bob'])
    expect(await names('%')).toEqual(['Bob'])
    expect(await names('_')).toEqual(['Carla_M'])
    expect(await names('nobody')).toEqual([])
  })

  it('deleting a person removes their dates', async () => {
    const p = await person({ name: 'x' })
    await asOwner((tx) => addPersonDate(tx, p.id, { label: 'Birthday', month: 5, day: 1 }))
    expect(await asOwner((tx) => deletePerson(tx, p.id))).toBe(true)
    const [{ n }] = (await t.db`select count(*)::int as n from public.person_dates`) as unknown as [
      { n: number },
    ]
    expect(n).toBe(0)
  })
})

describe('important dates', () => {
  it('adds, updates and deletes dates, soonest first on the person', async () => {
    const p = await person({ name: 'Priya' })
    const bday = await asOwner((tx) =>
      addPersonDate(tx, p.id, { label: 'Birthday', month: 12, day: 3, year: 1990 }),
    )
    const anniv = await asOwner((tx) =>
      addPersonDate(tx, p.id, { label: 'Anniversary', month: 10, day: 2, remindDaysBefore: 14 }),
    )
    if (!bday.ok || !anniv.ok) throw new Error('expected ok')
    const summary = await asOwner((tx) => getPerson(tx, p.id, today))
    expect(summary?.dates.map((d) => d.label)).toEqual(['Anniversary', 'Birthday'])
    expect(summary?.dates[1]?.next).toEqual({
      date: '2026-12-03',
      daysUntil: 70,
      observedFromFeb29: false,
      years: 36,
    })

    const moved = await asOwner((tx) =>
      updatePersonDate(tx, bday.value.id, { label: 'Birthday', month: 9, day: 30, year: 1990 }),
    )
    expect(moved).toMatchObject({
      ok: true,
      value: { month: 9, day: 30, year: 1990, remindDaysBefore: 7 },
    })
    expect(await asOwner((tx) => deletePersonDate(tx, anniv.value.id))).toEqual({ personId: p.id })
    expect(await asOwner((tx) => deletePersonDate(tx, anniv.value.id))).toBeNull()
    expect(
      await asOwner((tx) =>
        addPersonDate(tx, crypto.randomUUID(), { label: 'x', month: 1, day: 1 }),
      ),
    ).toEqual({ ok: false, reason: 'not_found' })
  })

  it('29 February: allowed without a year or with a leap year; never with a common year', async () => {
    const p = await person({ name: 'Leap' })
    expect(
      (await asOwner((tx) => addPersonDate(tx, p.id, { label: 'Birthday', month: 2, day: 29 }))).ok,
    ).toBe(true)
    expect(
      (
        await asOwner((tx) =>
          addPersonDate(tx, p.id, { label: 'Birthday', month: 2, day: 29, year: 2000 }),
        )
      ).ok,
    ).toBe(true)
    await expect(
      asOwner((tx) =>
        addPersonDate(tx, p.id, { label: 'Birthday', month: 2, day: 29, year: 2023 }),
      ),
    ).rejects.toThrow(/29 February/)
    // The database check backs the schema up.
    await expect(
      t.db`insert into public.person_dates (person_id, label, month, day, year)
           values (${p.id}, 'x', 2, 29, 1900)`,
    ).rejects.toThrow(/person_dates_leap_day_year/)
    await expect(
      t.db`insert into public.person_dates (person_id, label, month, day) values (${p.id}, 'x', 4, 31)`,
    ).rejects.toThrow(/person_dates_valid_day/)
  })
})

describe('listPeopleAttention', () => {
  it('returns dates within the horizon (with the reminder window) and due catch-ups', async () => {
    const leap = await person({ name: 'Leap Day' })
    const soon = await person({ name: 'Soon' })
    const far = await person({ name: 'Far' })
    await asOwner(async (tx) => {
      await addPersonDate(tx, leap.id, { label: 'Birthday', month: 2, day: 29, year: 2000 })
      await addPersonDate(tx, soon.id, {
        label: 'Birthday',
        month: 9,
        day: 24,
        remindDaysBefore: 0,
      })
      await addPersonDate(tx, soon.id, {
        label: 'Anniversary',
        month: 10,
        day: 4,
        remindDaysBefore: 7,
      })
      await addPersonDate(tx, far.id, { label: 'Birthday', month: 12, day: 25 })
    })
    const a = await asOwner((tx) => listPeopleAttention(tx, today, 14))
    expect(a.today).toBe(today)
    expect(a.horizonDays).toBe(14)
    expect(
      a.upcomingDates.map((d) => [d.personName, d.label, d.date, d.daysUntil, d.reminderDue]),
    ).toEqual([
      ['Soon', 'Birthday', '2026-09-24', 0, true],
      ['Soon', 'Anniversary', '2026-10-04', 10, false],
    ])

    // 29 Feb 2000 in the common year 2027 is observed on 28 Feb, 27 years on.
    const feb = await asOwner((tx) => listPeopleAttention(tx, '2027-02-20', 10))
    expect(feb.upcomingDates).toEqual([
      expect.objectContaining({
        personName: 'Leap Day',
        date: '2027-02-28',
        daysUntil: 8,
        observedFromFeb29: true,
        years: 27,
        reminderDue: false,
      }),
    ])
    const onTheDay = await asOwner((tx) => listPeopleAttention(tx, '2027-02-28', 0))
    expect(onTheDay.upcomingDates.map((d) => d.personName)).toEqual(['Leap Day'])
    expect(
      (await asOwner((tx) => listPeopleAttention(tx, '2027-03-01', 30))).upcomingDates,
    ).toEqual([])
  })

  it('lists due and overdue catch-ups, most overdue first', async () => {
    await person({ name: 'Due today', catchUpEveryDays: 7, lastCaughtUpOn: '2026-09-17' })
    await person({ name: 'Overdue', catchUpEveryDays: 7, lastCaughtUpOn: '2026-09-01' })
    await person({ name: 'Not yet', catchUpEveryDays: 30, lastCaughtUpOn: '2026-09-20' })
    await person({ name: 'Never', catchUpEveryDays: 14 }, '2026-09-01')
    await person({ name: 'No cadence' })
    const a = await asOwner((tx) => listPeopleAttention(tx, today, 14))
    expect(
      a.dueCatchUps.map((c) => [c.personName, c.dueOn, c.daysOverdue, c.neverCaughtUp]),
    ).toEqual([
      ['Overdue', '2026-09-08', 16, false],
      ['Never', '2026-09-15', 9, true],
      ['Due today', '2026-09-24', 0, false],
    ])
  })

  it('validates its arguments', async () => {
    await expect(asOwner((tx) => listPeopleAttention(tx, '24/09/2026', 14))).rejects.toThrow()
    await expect(asOwner((tx) => listPeopleAttention(tx, today, -1))).rejects.toThrow()
    await expect(asOwner((tx) => listPeopleAttention(tx, today, 1.5))).rejects.toThrow()
  })
})

describe('row level security', () => {
  it('a signed-in non-owner sees nothing and can change nothing', async () => {
    const p = await person({ name: 'Private', catchUpEveryDays: 7, lastCaughtUpOn: '2026-09-01' })
    const d = await asOwner((tx) =>
      addPersonDate(tx, p.id, { label: 'Birthday', month: 9, day: 25 }),
    )
    if (!d.ok) throw new Error('expected ok')

    expect(await asStranger((tx) => listPeople(tx, { today }))).toEqual([])
    expect(await asStranger((tx) => getPerson(tx, p.id, today))).toBeNull()
    expect(await asStranger((tx) => listPeopleAttention(tx, today, 30))).toEqual({
      today,
      horizonDays: 30,
      upcomingDates: [],
      dueCatchUps: [],
    })
    expect(await asStranger((tx) => markCaughtUp(tx, p.id, today))).toBeNull()
    expect(await asStranger((tx) => updatePerson(tx, p.id, { name: 'Mine' }, today))).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(await asStranger((tx) => deletePerson(tx, p.id))).toBe(false)
    expect(await asStranger((tx) => deletePersonDate(tx, d.value.id))).toBeNull()
    expect(
      await asStranger((tx) => addPersonDate(tx, p.id, { label: 'x', month: 1, day: 1 })),
    ).toEqual({ ok: false, reason: 'not_found' })
    await expect(asStranger((tx) => createPerson(tx, { name: 'Sneaky' }, today))).rejects.toThrow(
      /row-level security/,
    )
    await expect(
      asStranger(
        (tx) => tx`insert into public.person_dates (person_id, label, month, day)
                   values (${p.id}, 'x', 1, 1)`,
      ),
    ).rejects.toThrow(/row-level security/)

    const mine = await asOwner((tx) => getPerson(tx, p.id, today))
    expect(mine).toMatchObject({ name: 'Private', lastCaughtUpOn: '2026-09-01' })
    expect(mine?.dates).toHaveLength(1)
  })

  it('anon has no access at all', async () => {
    for (const table of ['people', 'person_dates']) {
      await expect(
        withAnon(t.db, (tx) => tx`select * from ${tx(`public.${table}`)}`),
      ).rejects.toThrow(/permission denied/)
    }
  })
})
