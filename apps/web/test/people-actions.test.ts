/**
 * People server actions against a real database, with the session replaced by an owner
 * transaction on a test database (RLS applies) and Next's cache/navigation stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPerson,
  listPeopleAttention,
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
  addPersonDateAction,
  createPersonAction,
  deletePersonAction,
  markCaughtUpAction,
  updatePersonAction,
} = await import('@/app/(app)/people/actions')

let t: TestDatabase
let owner: OwnerClaims
const IDLE = { status: 'idle' } as const

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

/** createPersonAction redirects to the new person's page on success. */
async function create(fields: Record<string, string>): Promise<string> {
  try {
    const state = await createPersonAction(IDLE, form(fields))
    throw new Error(`expected a redirect, got ${JSON.stringify(state)}`)
  } catch (error) {
    if (!(error instanceof RedirectSignal)) throw error
    const id = /^\/people\/([0-9a-f-]{36})$/.exec(error.url)?.[1]
    if (!id) throw new Error(`unexpected redirect ${error.url}`)
    return id
  }
}

const person = (id: string, today: string) =>
  withOwner(t.db, owner, (tx) => getPerson(tx, id, today))

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
  await t.db`delete from public.people`
  await t.db`update public.owner_settings set timezone = 'Europe/London'`
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createPersonAction', () => {
  it('adds a person with a 29 February birthday and a cadence, then shows their page', async () => {
    const id = await create({
      name: 'Rosa',
      relationship: 'aunt',
      notes: 'Line one\nLine two  ',
      birthdayMonth: '2',
      birthdayDay: '29',
      birthdayYear: '',
      catchUpEveryDays: '14',
    })
    const p = await person(id, '2026-09-24')
    expect(p).toMatchObject({
      name: 'Rosa',
      relationship: 'aunt',
      notes: 'Line one\nLine two',
      catchUpEveryDays: 14,
      catchUpStartedOn: '2026-09-24',
      lastCaughtUpOn: null,
      catchUp: { state: 'upcoming', dueOn: '2026-10-08' },
    })
    expect(p?.dates).toEqual([
      expect.objectContaining({
        label: 'Birthday',
        month: 2,
        day: 29,
        year: null,
        remindDaysBefore: 7,
        next: { date: '2027-02-28', daysUntil: 157, observedFromFeb29: true, years: null },
      }),
    ])
  })

  it('refuses 29 February in a common year and a half-filled birthday', async () => {
    expect(
      await createPersonAction(
        IDLE,
        form({ name: 'x', birthdayMonth: '2', birthdayDay: '29', birthdayYear: '2023' }),
      ),
    ).toEqual({
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: { birthdayDay: '2023 has no 29 February' },
    })
    expect(await createPersonAction(IDLE, form({ name: 'x', birthdayMonth: '5' }))).toMatchObject({
      status: 'error',
      fieldErrors: { birthdayDay: 'Pick a day' },
    })
    expect(
      await createPersonAction(IDLE, form({ name: ' ', catchUpEveryDays: '3' })),
    ).toMatchObject({
      status: 'error',
      fieldErrors: { name: 'Give the person a name', catchUpEveryDays: 'At least every 7 days' },
    })
    const [{ n }] = (await t.db`select count(*)::int as n from public.people`) as unknown as [
      { n: number },
    ]
    expect(n).toBe(0)
  })

  it('without a birthday or cadence, stores just the person', async () => {
    const id = await create({ name: 'Sam', catchUpEveryDays: '' })
    expect(await person(id, '2026-09-24')).toMatchObject({
      catchUpEveryDays: null,
      catchUpStartedOn: null,
      dates: [],
      catchUp: { state: 'not_set' },
    })
  })
})

describe('markCaughtUpAction', () => {
  it('records the owner-local date, late at night across BST', async () => {
    const id = await create({ name: 'Mum', catchUpEveryDays: '7' })
    // 23:30 UTC on 31 May is 00:30 BST on 1 June.
    vi.setSystemTime(new Date('2026-05-31T23:30:00Z'))
    await markCaughtUpAction(id)
    expect((await person(id, '2026-06-01'))?.lastCaughtUpOn).toBe('2026-06-01')
  })

  it('moves a due catch-up off the attention list', async () => {
    const id = await create({ name: 'Dad', catchUpEveryDays: '7' })
    await t.db`update public.people set last_caught_up_on = '2026-09-01' where id = ${id}`
    const before = await withOwner(t.db, owner, (tx) => listPeopleAttention(tx, '2026-09-24', 14))
    expect(before.dueCatchUps.map((c) => c.personName)).toEqual(['Dad'])
    await markCaughtUpAction(id)
    const after = await withOwner(t.db, owner, (tx) => listPeopleAttention(tx, '2026-09-24', 14))
    expect(after.dueCatchUps).toEqual([])
  })

  it('rejects a malformed id', async () => {
    await expect(markCaughtUpAction('nope')).rejects.toThrow()
  })
})

describe('updatePersonAction and dates', () => {
  it('saves edits, refuses a future last catch-up, and adds dates', async () => {
    const id = await create({ name: 'Ines' })
    expect(
      await updatePersonAction(
        id,
        IDLE,
        form({
          name: 'Inês',
          relationship: 'friend',
          catchUpEveryDays: '30',
          lastCaughtUpOn: '2026-09-20',
        }),
      ),
    ).toEqual({ status: 'saved', message: 'Saved.' })
    expect(await person(id, '2026-09-24')).toMatchObject({
      name: 'Inês',
      catchUp: { state: 'upcoming', dueOn: '2026-10-20' },
    })
    expect(
      await updatePersonAction(id, IDLE, form({ name: 'Inês', lastCaughtUpOn: '2026-09-25' })),
    ).toMatchObject({
      status: 'error',
      fieldErrors: { lastCaughtUpOn: 'The last catch-up cannot be in the future' },
    })
    expect(await updatePersonAction(crypto.randomUUID(), IDLE, form({ name: 'x' }))).toEqual({
      status: 'error',
      message: 'That person could not be found.',
    })

    expect(
      await addPersonDateAction(
        id,
        IDLE,
        form({ label: 'Anniversary', month: '6', day: '12', year: '2015', remindDaysBefore: '14' }),
      ),
    ).toEqual({ status: 'saved', message: 'Added anniversary.' })
    expect(
      await addPersonDateAction(id, IDLE, form({ label: '', month: '4', day: '31' })),
    ).toMatchObject({
      status: 'error',
      fieldErrors: { label: 'Give the date a label', day: 'That day does not exist in this month' },
    })
    expect((await person(id, '2026-09-24'))?.dates).toEqual([
      expect.objectContaining({ label: 'Anniversary', year: 2015, remindDaysBefore: 14 }),
    ])
  })

  it('deletes a person and redirects to the list', async () => {
    const id = await create({ name: 'Gone' })
    await expect(deletePersonAction(id)).rejects.toThrow(RedirectSignal)
    expect(await person(id, '2026-09-24')).toBeNull()
  })
})
