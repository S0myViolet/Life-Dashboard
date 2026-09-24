import { describe, expect, it } from 'vitest'
import {
  catchUpDueOn,
  catchUpStartedOnAfterEdit,
  catchUpStatus,
  isCatchUpDue,
  localDateInZone,
  PeopleSearchSchema,
  PersonInputSchema,
} from '../src/index.ts'

const DAY_MS = 86_400_000

/** Owner-local "today" at an instant, the way the app derives it. */
const todayAt = (iso: string, tz: string) => localDateInZone(new Date(iso), tz)

describe('catchUpStatus', () => {
  it('is not set without a cadence', () => {
    expect(
      catchUpStatus(
        { catchUpEveryDays: null, lastCaughtUpOn: '2026-09-01', catchUpStartedOn: null },
        '2026-09-24',
      ),
    ).toEqual({ state: 'not_set', dueOn: null, daysUntilDue: null, neverCaughtUp: false })
  })

  it('counts from the last catch-up', () => {
    const c = { catchUpEveryDays: 14, lastCaughtUpOn: '2026-09-10', catchUpStartedOn: '2026-08-01' }
    expect(catchUpStatus(c, '2026-09-20')).toMatchObject({
      state: 'upcoming',
      dueOn: '2026-09-24',
      daysUntilDue: 4,
    })
    expect(catchUpStatus(c, '2026-09-24')).toMatchObject({ state: 'due', daysUntilDue: 0 })
    expect(catchUpStatus(c, '2026-09-30')).toMatchObject({ state: 'overdue', daysUntilDue: -6 })
    expect(isCatchUpDue(catchUpStatus(c, '2026-09-24'))).toBe(true)
    expect(isCatchUpDue(catchUpStatus(c, '2026-09-23'))).toBe(false)
  })

  it('counts from when the cadence was set until the first catch-up', () => {
    const c = { catchUpEveryDays: 30, lastCaughtUpOn: null, catchUpStartedOn: '2026-09-01' }
    expect(catchUpStatus(c, '2026-09-24')).toEqual({
      state: 'upcoming',
      dueOn: '2026-10-01',
      daysUntilDue: 7,
      neverCaughtUp: true,
    })
  })

  it('with nothing to count from, it is due now rather than silently never', () => {
    const c = { catchUpEveryDays: 30, lastCaughtUpOn: null, catchUpStartedOn: null }
    expect(catchUpStatus(c, '2026-09-24')).toMatchObject({ state: 'due', dueOn: '2026-09-24' })
    expect(catchUpDueOn(c)).toBeNull()
  })

  it('handles month ends and leap days as calendar days', () => {
    expect(
      catchUpDueOn({ catchUpEveryDays: 30, lastCaughtUpOn: '2028-01-31', catchUpStartedOn: null }),
    ).toBe('2028-03-01')
    expect(
      catchUpDueOn({ catchUpEveryDays: 365, lastCaughtUpOn: '2027-03-01', catchUpStartedOn: null }),
    ).toBe('2028-02-29')
  })
})

describe('catch-up due dates across DST', () => {
  it('Europe/London spring forward (29 Mar 2026): due on the local date, not 24h multiples', () => {
    const c = { catchUpEveryDays: 7, lastCaughtUpOn: '2026-03-22', catchUpStartedOn: null }
    expect(catchUpDueOn(c)).toBe('2026-03-29')
    // 23:59 GMT on the 28th: not yet.
    expect(catchUpStatus(c, todayAt('2026-03-28T23:59:00Z', 'Europe/London')).state).toBe(
      'upcoming',
    )
    // Midnight GMT on the 29th is already the 29th locally: due.
    expect(catchUpStatus(c, todayAt('2026-03-29T00:00:00Z', 'Europe/London')).state).toBe('due')
    // Late on the 29th (BST): still "due", not yet overdue.
    expect(catchUpStatus(c, todayAt('2026-03-29T22:59:00Z', 'Europe/London')).state).toBe('due')
    // 00:00 BST on the 30th is 23:00Z on the 29th: overdue by one day.
    expect(catchUpStatus(c, todayAt('2026-03-29T23:00:00Z', 'Europe/London'))).toMatchObject({
      state: 'overdue',
      daysUntilDue: -1,
    })
  })

  it('Europe/London fall back (25 Oct 2026): the 25-hour day is one day', () => {
    const c = { catchUpEveryDays: 7, lastCaughtUpOn: '2026-10-19', catchUpStartedOn: null }
    expect(catchUpDueOn(c)).toBe('2026-10-26')
    // 23:30 GMT on the 25th is still the 25th locally.
    expect(catchUpStatus(c, todayAt('2026-10-25T23:30:00Z', 'Europe/London')).state).toBe(
      'upcoming',
    )
    expect(catchUpStatus(c, todayAt('2026-10-26T00:00:00Z', 'Europe/London')).state).toBe('due')
  })

  it('a naive "last + N × 24h" would be off by an hour; local dates are not', () => {
    // Caught up at 00:30 BST on 25 Oct (23:30Z on the 24th). 24h later is 23:30 GMT on the 25th,
    // still the 25th locally: millisecond arithmetic would say "one day" twice.
    const caughtUpAt = new Date('2026-10-24T23:30:00Z')
    expect(localDateInZone(caughtUpAt, 'Europe/London')).toBe('2026-10-25')
    const naiveNext = new Date(caughtUpAt.getTime() + DAY_MS)
    expect(localDateInZone(naiveNext, 'Europe/London')).toBe('2026-10-25')
    const c = { catchUpEveryDays: 7, lastCaughtUpOn: '2026-10-25', catchUpStartedOn: null }
    expect(catchUpDueOn(c)).toBe('2026-11-01')
  })

  it('America/New_York (8 Mar and 1 Nov 2026) and Australia/Sydney (5 Apr 2026)', () => {
    const ny = { catchUpEveryDays: 7, lastCaughtUpOn: '2026-03-01', catchUpStartedOn: null }
    expect(catchUpDueOn(ny)).toBe('2026-03-08')
    // 23:30 EST on the 7th = 04:30Z on the 8th: not due yet.
    expect(catchUpStatus(ny, todayAt('2026-03-08T04:30:00Z', 'America/New_York')).state).toBe(
      'upcoming',
    )
    // 00:30 EST on the 8th = 05:30Z: due.
    expect(catchUpStatus(ny, todayAt('2026-03-08T05:30:00Z', 'America/New_York')).state).toBe('due')

    const nyFall = { catchUpEveryDays: 14, lastCaughtUpOn: '2026-10-18', catchUpStartedOn: null }
    expect(catchUpDueOn(nyFall)).toBe('2026-11-01')
    // 23:30 EST on 1 Nov = 04:30Z on the 2nd: still the 1st locally, so due (not overdue).
    expect(catchUpStatus(nyFall, todayAt('2026-11-02T04:30:00Z', 'America/New_York')).state).toBe(
      'due',
    )

    const syd = { catchUpEveryDays: 7, lastCaughtUpOn: '2026-03-29', catchUpStartedOn: null }
    expect(catchUpDueOn(syd)).toBe('2026-04-05')
    // 00:30 AEDT on 5 Apr = 13:30Z on the 4th: due in Sydney while still the 4th in UTC.
    expect(catchUpStatus(syd, todayAt('2026-04-04T13:30:00Z', 'Australia/Sydney')).state).toBe(
      'due',
    )
  })

  it('"caught up today" late at night uses the owner-local date, not UTC', () => {
    // 00:30 BST on 1 June = 23:30Z on 31 May.
    const today = todayAt('2026-05-31T23:30:00Z', 'Europe/London')
    expect(today).toBe('2026-06-01')
    const c = { catchUpEveryDays: 30, lastCaughtUpOn: today, catchUpStartedOn: null }
    expect(catchUpDueOn(c)).toBe('2026-07-01')
  })
})

describe('catchUpStartedOnAfterEdit', () => {
  it('starts counting when a cadence is first set, keeps counting when it changes', () => {
    expect(catchUpStartedOnAfterEdit(null, 30, '2026-09-24')).toBe('2026-09-24')
    expect(
      catchUpStartedOnAfterEdit(
        { catchUpEveryDays: null, catchUpStartedOn: null },
        30,
        '2026-09-24',
      ),
    ).toBe('2026-09-24')
    expect(
      catchUpStartedOnAfterEdit(
        { catchUpEveryDays: 14, catchUpStartedOn: '2026-08-01' },
        30,
        '2026-09-24',
      ),
    ).toBe('2026-08-01')
    expect(
      catchUpStartedOnAfterEdit(
        { catchUpEveryDays: 14, catchUpStartedOn: '2026-08-01' },
        null,
        '2026-09-24',
      ),
    ).toBeNull()
  })
})

describe('PersonInputSchema', () => {
  it('trims and nulls optional text; keeps notes as written', () => {
    expect(
      PersonInputSchema.parse({
        name: '  Sam  ',
        relationship: ' ',
        notes: '  Likes <b>tea</b>\n\n',
        catchUpEveryDays: null,
      }),
    ).toEqual({
      name: 'Sam',
      relationship: null,
      notes: '  Likes <b>tea</b>',
      catchUpEveryDays: null,
      lastCaughtUpOn: null,
    })
  })

  it('enforces the cadence range from the schema (7–730 days)', () => {
    expect(PersonInputSchema.safeParse({ name: 'x', catchUpEveryDays: 6 }).success).toBe(false)
    expect(PersonInputSchema.safeParse({ name: 'x', catchUpEveryDays: 731 }).success).toBe(false)
    expect(PersonInputSchema.safeParse({ name: 'x', catchUpEveryDays: 7.5 }).success).toBe(false)
    expect(PersonInputSchema.safeParse({ name: 'x', catchUpEveryDays: 7 }).success).toBe(true)
    expect(PersonInputSchema.safeParse({ name: '' }).success).toBe(false)
  })

  it('search text is trimmed, bounded and falls back to empty', () => {
    expect(PeopleSearchSchema.parse('  ann ')).toBe('ann')
    expect(PeopleSearchSchema.parse(undefined)).toBe('')
    expect(PeopleSearchSchema.parse(['a', 'b'])).toBe('')
    expect(PeopleSearchSchema.parse('x'.repeat(101))).toBe('x'.repeat(100))
  })
})
