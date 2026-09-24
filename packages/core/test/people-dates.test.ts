import { describe, expect, it } from 'vitest'
import {
  daysInMonth,
  importantDateInYear,
  isLeapYear,
  isValidImportantDate,
  nextImportantDateOccurrence,
  PersonDateInputSchema,
  upcomingImportantDates,
} from '../src/index.ts'

describe('leap years', () => {
  it('follows the Gregorian rule', () => {
    expect([2024, 2028, 2000, 2400].map(isLeapYear)).toEqual([true, true, true, true])
    expect([2026, 2027, 1900, 2100].map(isLeapYear)).toEqual([false, false, false, false])
  })

  it('February has 29 days when the year is unknown', () => {
    expect(daysInMonth(2)).toBe(29)
    expect(daysInMonth(2, 2026)).toBe(28)
    expect(daysInMonth(2, 2028)).toBe(29)
    expect(daysInMonth(4)).toBe(30)
    expect(daysInMonth(12)).toBe(31)
  })
})

describe('29 February', () => {
  const leapDay = { month: 2, day: 29, year: null }

  it('is observed on 28 February in a common year and flagged', () => {
    expect(importantDateInYear(leapDay, 2027)).toEqual({
      date: '2027-02-28',
      observedFromFeb29: true,
    })
    expect(importantDateInYear(leapDay, 2028)).toEqual({
      date: '2028-02-29',
      observedFromFeb29: false,
    })
  })

  it('the next occurrence from late 2026 is 28 Feb 2027', () => {
    expect(nextImportantDateOccurrence(leapDay, '2026-09-24')).toEqual({
      date: '2027-02-28',
      daysUntil: 157,
      observedFromFeb29: true,
      years: null,
    })
  })

  it('is due today on 28 Feb of a common year', () => {
    const o = nextImportantDateOccurrence(leapDay, '2027-02-28')
    expect(o.date).toBe('2027-02-28')
    expect(o.daysUntil).toBe(0)
  })

  it('once 28 Feb has passed in a common year, the next one is 29 Feb of the leap year', () => {
    const o = nextImportantDateOccurrence(leapDay, '2027-03-01')
    expect(o).toMatchObject({ date: '2028-02-29', observedFromFeb29: false })
  })

  it('in a leap year it waits for the 29th (the 28th is not the day)', () => {
    const o = nextImportantDateOccurrence(leapDay, '2028-02-28')
    expect(o).toMatchObject({ date: '2028-02-29', daysUntil: 1, observedFromFeb29: false })
  })

  it('counts years for a leap-day birthday', () => {
    const born = { month: 2, day: 29, year: 2000 }
    expect(nextImportantDateOccurrence(born, '2026-09-24')).toMatchObject({
      date: '2027-02-28',
      years: 27,
    })
    expect(nextImportantDateOccurrence(born, '2028-01-01')).toMatchObject({
      date: '2028-02-29',
      years: 28,
    })
  })

  it('rejects 29 Feb with a year that has none', () => {
    expect(isValidImportantDate({ month: 2, day: 29, year: 2023 })).toBe(false)
    expect(isValidImportantDate({ month: 2, day: 29, year: 2024 })).toBe(true)
    expect(isValidImportantDate({ month: 2, day: 29, year: null })).toBe(true)
    const r = PersonDateInputSchema.safeParse({ label: 'Birthday', month: 2, day: 29, year: 2023 })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('2023 has no 29 February')
    expect(
      PersonDateInputSchema.safeParse({ label: 'Birthday', month: 2, day: 29, year: 1900 }).success,
    ).toBe(false)
    expect(
      PersonDateInputSchema.safeParse({ label: 'Birthday', month: 2, day: 29, year: 2000 }).success,
    ).toBe(true)
  })
})

describe('nextImportantDateOccurrence', () => {
  it('today counts as upcoming (0 days)', () => {
    expect(
      nextImportantDateOccurrence({ month: 9, day: 24, year: null }, '2026-09-24'),
    ).toMatchObject({ date: '2026-09-24', daysUntil: 0 })
  })

  it('rolls over to next year once the day has passed', () => {
    expect(
      nextImportantDateOccurrence({ month: 9, day: 23, year: 1990 }, '2026-09-24'),
    ).toMatchObject({ date: '2027-09-23', daysUntil: 364, years: 37 })
  })

  it('crosses the new year', () => {
    expect(
      nextImportantDateOccurrence({ month: 1, day: 2, year: null }, '2026-12-30'),
    ).toMatchObject({ date: '2027-01-02', daysUntil: 3 })
  })

  it('a date with a future year first occurs in that year', () => {
    expect(
      nextImportantDateOccurrence({ month: 6, day: 1, year: 2028 }, '2026-09-24'),
    ).toMatchObject({ date: '2028-06-01', years: 0 })
  })

  it('throws on impossible dates', () => {
    expect(() =>
      nextImportantDateOccurrence({ month: 4, day: 31, year: null }, '2026-09-24'),
    ).toThrow(RangeError)
    expect(() =>
      nextImportantDateOccurrence({ month: 13, day: 1, year: null }, '2026-09-24'),
    ).toThrow(RangeError)
    expect(() =>
      nextImportantDateOccurrence({ month: 1, day: 1, year: null }, '24/09/2026'),
    ).toThrow(RangeError)
  })
})

describe('upcomingImportantDates', () => {
  it('keeps dates within the horizon (inclusive), soonest first', () => {
    const dates = [
      { id: 'far', month: 12, day: 25, year: null },
      { id: 'edge', month: 10, day: 8, year: null },
      { id: 'soon', month: 9, day: 26, year: null },
      { id: 'today', month: 9, day: 24, year: null },
      { id: 'past', month: 9, day: 1, year: null },
    ]
    const out = upcomingImportantDates(dates, '2026-09-24', 14)
    expect(out.map((x) => x.date.id)).toEqual(['today', 'soon', 'edge'])
    expect(out.map((x) => x.occurrence.daysUntil)).toEqual([0, 2, 14])
  })
})

describe('PersonDateInputSchema', () => {
  it('validates and defaults', () => {
    expect(PersonDateInputSchema.parse({ label: ' Birthday ', month: 3, day: 14 })).toEqual({
      label: 'Birthday',
      month: 3,
      day: 14,
      year: null,
      remindDaysBefore: 7,
    })
    expect(PersonDateInputSchema.safeParse({ label: 'x', month: 4, day: 31 }).success).toBe(false)
    expect(PersonDateInputSchema.safeParse({ label: 'x', month: 0, day: 1 }).success).toBe(false)
    expect(PersonDateInputSchema.safeParse({ label: '', month: 1, day: 1 }).success).toBe(false)
    expect(
      PersonDateInputSchema.safeParse({ label: 'x', month: 1, day: 1, remindDaysBefore: 61 })
        .success,
    ).toBe(false)
    expect(
      PersonDateInputSchema.safeParse({ label: 'x', month: 1, day: 1, year: 1899 }).success,
    ).toBe(false)
  })
})
