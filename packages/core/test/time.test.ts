import { describe, expect, it } from 'vitest'
import {
  addLocalDays,
  CalendarDateSchema,
  IanaTimeZoneSchema,
  isoWeekday,
  isValidTimeZone,
  latestLocalDailyOccurrence,
  localDateInZone,
  localDaysBetween,
  localTimeInZone,
  nextLocalDailyOccurrence,
  nextLocalDailyRun,
  timeZoneOffsetMs,
  WallClockTimeSchema,
  zonedLocalToUtc,
} from '../src/index.ts'

const iso = (d: Date) => d.toISOString()
const at = (s: string) => new Date(s)
const HOUR = 3_600_000

describe('isValidTimeZone', () => {
  it('accepts IANA names in their exact spelling', () => {
    for (const tz of [
      'Europe/London',
      'America/New_York',
      'Australia/Lord_Howe',
      'Asia/Kolkata',
      'Pacific/Chatham',
      'UTC',
      'America/Argentina/Buenos_Aires',
    ]) {
      expect(isValidTimeZone(tz), tz).toBe(true)
    }
  })

  it('rejects offsets, wrong case, unknown names and non-strings', () => {
    for (const tz of ['+05:30', '-08:00', 'europe/london', 'Mars/Olympus_Mons', '', ' Europe/London', 42, null]) {
      expect(isValidTimeZone(tz), String(tz)).toBe(false)
    }
    expect(IanaTimeZoneSchema.safeParse('Europe/London').success).toBe(true)
    expect(IanaTimeZoneSchema.safeParse('GMT+1:00').success).toBe(false)
  })
})

describe('localDateInZone / localTimeInZone', () => {
  it('reads the wall clock in each zone', () => {
    const t = at('2026-06-15T23:30:00Z')
    expect(localDateInZone(t, 'Europe/London')).toBe('2026-06-16') // BST 00:30
    expect(localTimeInZone(t, 'Europe/London')).toBe('00:30')
    expect(localDateInZone(t, 'America/New_York')).toBe('2026-06-15') // EDT 19:30
    expect(localTimeInZone(t, 'America/New_York')).toBe('19:30')
    expect(localDateInZone(t, 'Asia/Kolkata')).toBe('2026-06-16') // IST 05:00
    expect(localTimeInZone(t, 'Asia/Kolkata')).toBe('05:00')
  })

  it('handles year boundaries in both directions', () => {
    // Chatham is UTC+13:45 in (southern) summer: 11:15Z on 31 Dec is 01:00 on 1 Jan.
    expect(localDateInZone(at('2026-12-31T11:15:00Z'), 'Pacific/Chatham')).toBe('2027-01-01')
    expect(localTimeInZone(at('2026-12-31T11:15:00Z'), 'Pacific/Chatham')).toBe('01:00')
    expect(localDateInZone(at('2026-12-31T10:14:59Z'), 'Pacific/Chatham')).toBe('2026-12-31')
    // New York is UTC-5 in winter: 03:00Z on 1 Jan is still 31 Dec.
    expect(localDateInZone(at('2027-01-01T03:00:00Z'), 'America/New_York')).toBe('2026-12-31')
    expect(localDateInZone(at('2027-01-01T00:00:00Z'), 'Europe/London')).toBe('2027-01-01')
  })

  it('accepts epoch milliseconds and rejects invalid input', () => {
    expect(localDateInZone(Date.UTC(2026, 8, 24, 12), 'UTC')).toBe('2026-09-24')
    expect(() => localDateInZone(new Date('nope'), 'UTC')).toThrow(RangeError)
    expect(() => localDateInZone(new Date(), 'Nowhere/Special')).toThrow(RangeError)
  })

  it('reports offsets including 30- and 45-minute zones', () => {
    expect(timeZoneOffsetMs(at('2026-01-15T00:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * HOUR)
    expect(timeZoneOffsetMs(at('2026-01-15T00:00:00Z'), 'Pacific/Chatham')).toBe(13.75 * HOUR)
    expect(timeZoneOffsetMs(at('2026-07-15T00:00:00Z'), 'Pacific/Chatham')).toBe(12.75 * HOUR)
    expect(timeZoneOffsetMs(at('2026-01-15T00:00:00Z'), 'Australia/Lord_Howe')).toBe(11 * HOUR)
    expect(timeZoneOffsetMs(at('2026-07-15T00:00:00Z'), 'Australia/Lord_Howe')).toBe(10.5 * HOUR)
  })
})

describe('zonedLocalToUtc', () => {
  it('converts ordinary times', () => {
    expect(iso(zonedLocalToUtc('2026-03-28', '11:00', 'Europe/London'))).toBe('2026-03-28T11:00:00.000Z')
    expect(iso(zonedLocalToUtc('2026-03-30', '11:00', 'Europe/London'))).toBe('2026-03-30T10:00:00.000Z')
    expect(iso(zonedLocalToUtc('2026-09-24', '11:00', 'Asia/Kolkata'))).toBe('2026-09-24T05:30:00.000Z')
    expect(iso(zonedLocalToUtc('2026-09-24', '22:00', 'America/New_York'))).toBe('2026-09-25T02:00:00.000Z')
  })

  describe('Europe/London 2026', () => {
    it('spring forward (29 March): a time in the gap shifts forward by the gap', () => {
      // 01:00 GMT → 02:00 BST. 01:30 does not exist; it becomes 02:30 BST = 01:30Z.
      expect(iso(zonedLocalToUtc('2026-03-29', '00:59', 'Europe/London'))).toBe('2026-03-29T00:59:00.000Z')
      expect(iso(zonedLocalToUtc('2026-03-29', '01:00', 'Europe/London'))).toBe('2026-03-29T01:00:00.000Z')
      expect(iso(zonedLocalToUtc('2026-03-29', '01:30', 'Europe/London'))).toBe('2026-03-29T01:30:00.000Z')
      expect(localTimeInZone(zonedLocalToUtc('2026-03-29', '01:30', 'Europe/London'), 'Europe/London')).toBe(
        '02:30',
      )
      expect(iso(zonedLocalToUtc('2026-03-29', '02:00', 'Europe/London'))).toBe('2026-03-29T01:00:00.000Z')
      expect(iso(zonedLocalToUtc('2026-03-29', '11:00', 'Europe/London'))).toBe('2026-03-29T10:00:00.000Z')
    })

    it('fall back (25 October): an ambiguous time resolves to the earlier instant', () => {
      // 02:00 BST → 01:00 GMT. 01:30 happens at 00:30Z (BST) and 01:30Z (GMT).
      expect(iso(zonedLocalToUtc('2026-10-25', '01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z')
      expect(iso(zonedLocalToUtc('2026-10-25', '00:59', 'Europe/London'))).toBe('2026-10-24T23:59:00.000Z')
      expect(iso(zonedLocalToUtc('2026-10-25', '02:00', 'Europe/London'))).toBe('2026-10-25T02:00:00.000Z')
      expect(iso(zonedLocalToUtc('2026-10-25', '11:00', 'Europe/London'))).toBe('2026-10-25T11:00:00.000Z')
      expect(iso(zonedLocalToUtc('2026-10-24', '11:00', 'Europe/London'))).toBe('2026-10-24T10:00:00.000Z')
    })
  })

  it('America/New_York 2026: gap on 8 March, overlap on 1 November', () => {
    expect(iso(zonedLocalToUtc('2026-03-08', '02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z') // 03:30 EDT
    expect(iso(zonedLocalToUtc('2026-03-08', '03:00', 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z')
    expect(iso(zonedLocalToUtc('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z') // EDT, earlier
    expect(iso(zonedLocalToUtc('2026-11-01', '11:00', 'America/New_York'))).toBe('2026-11-01T16:00:00.000Z')
  })

  it('Australia/Lord_Howe: 30-minute DST shift', () => {
    // 4 Oct 2026, 02:00 (+10:30) → 02:30 (+11). 02:15 is shifted forward 30 min to 02:45.
    const gap = zonedLocalToUtc('2026-10-04', '02:15', 'Australia/Lord_Howe')
    expect(iso(gap)).toBe('2026-10-03T15:45:00.000Z')
    expect(localTimeInZone(gap, 'Australia/Lord_Howe')).toBe('02:45')
    // 5 Apr 2026, 02:00 (+11) → 01:30 (+10:30). 01:45 is ambiguous: 14:45Z or 15:15Z.
    expect(iso(zonedLocalToUtc('2026-04-05', '01:45', 'Australia/Lord_Howe'))).toBe('2026-04-04T14:45:00.000Z')
    expect(iso(zonedLocalToUtc('2026-04-05', '11:00', 'Australia/Lord_Howe'))).toBe('2026-04-05T00:30:00.000Z')
  })

  it('Pacific/Chatham: +12:45/+13:45 with a gap on 27 September 2026', () => {
    // 02:45 (+12:45) → 03:45 (+13:45). 03:00 becomes 04:00 local = 14:15Z the day before.
    expect(iso(zonedLocalToUtc('2026-09-27', '03:00', 'Pacific/Chatham'))).toBe('2026-09-26T14:15:00.000Z')
    expect(iso(zonedLocalToUtc('2026-09-26', '11:00', 'Pacific/Chatham'))).toBe('2026-09-25T22:15:00.000Z')
    expect(iso(zonedLocalToUtc('2026-09-28', '11:00', 'Pacific/Chatham'))).toBe('2026-09-27T21:15:00.000Z')
    expect(iso(zonedLocalToUtc('2027-01-01', '11:00', 'Pacific/Chatham'))).toBe('2026-12-31T21:15:00.000Z')
  })

  it('Asia/Kolkata has no DST', () => {
    for (const d of ['2026-01-01', '2026-03-29', '2026-10-25', '2026-12-31']) {
      expect(zonedLocalToUtc(d, '11:00', 'Asia/Kolkata').getUTCHours()).toBe(5)
      expect(zonedLocalToUtc(d, '11:00', 'Asia/Kolkata').getUTCMinutes()).toBe(30)
    }
  })

  it('round-trips 11:00 and 22:00 on every day of 2026 in every test zone', () => {
    const zones = ['Europe/London', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Pacific/Chatham']
    for (const tz of zones) {
      let d = '2026-01-01'
      for (let i = 0; i < 365; i++) {
        for (const t of ['11:00', '22:00']) {
          const u = zonedLocalToUtc(d, t, tz)
          expect(localDateInZone(u, tz)).toBe(d)
          expect(localTimeInZone(u, tz)).toBe(t)
        }
        d = addLocalDays(d, 1)
      }
      expect(d).toBe('2027-01-01')
    }
  })

  it('rejects invalid dates, times and zones', () => {
    expect(() => zonedLocalToUtc('2026-02-30', '11:00', 'UTC')).toThrow(RangeError)
    expect(() => zonedLocalToUtc('2026-13-01', '11:00', 'UTC')).toThrow(RangeError)
    expect(() => zonedLocalToUtc('26-01-01', '11:00', 'UTC')).toThrow(RangeError)
    expect(() => zonedLocalToUtc('2026-01-01', '24:00', 'UTC')).toThrow(RangeError)
    expect(() => zonedLocalToUtc('2026-01-01', '9:00', 'UTC')).toThrow(RangeError)
    expect(() => zonedLocalToUtc('2026-01-01', '11:00', 'Not/AZone')).toThrow(RangeError)
  })
})

describe('nextLocalDailyRun', () => {
  it('is strictly after the given instant', () => {
    expect(iso(nextLocalDailyRun(at('2026-06-01T09:59:59Z'), '11:00', 'Europe/London'))).toBe(
      '2026-06-01T10:00:00.000Z',
    )
    expect(iso(nextLocalDailyRun(at('2026-06-01T10:00:00Z'), '11:00', 'Europe/London'))).toBe(
      '2026-06-02T10:00:00.000Z',
    )
  })

  it('stays at 11:00 local across both London DST changes', () => {
    const runs: string[] = []
    let t = at('2026-03-26T12:00:00Z')
    for (let i = 0; i < 5; i++) {
      t = nextLocalDailyRun(t, '11:00', 'Europe/London')
      runs.push(iso(t))
    }
    expect(runs).toEqual([
      '2026-03-27T11:00:00.000Z',
      '2026-03-28T11:00:00.000Z',
      '2026-03-29T10:00:00.000Z',
      '2026-03-30T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
    ])
    const autumn: string[] = []
    t = at('2026-10-23T12:00:00Z')
    for (let i = 0; i < 4; i++) {
      t = nextLocalDailyRun(t, '22:00', 'Europe/London')
      autumn.push(iso(t))
    }
    expect(autumn).toEqual([
      '2026-10-23T21:00:00.000Z',
      '2026-10-24T21:00:00.000Z',
      '2026-10-25T22:00:00.000Z',
      '2026-10-26T22:00:00.000Z',
    ])
  })

  it('runs an ambiguous time once and a nonexistent time once on transition days', () => {
    const first = nextLocalDailyRun(at('2026-10-24T12:00:00Z'), '01:30', 'Europe/London')
    expect(iso(first)).toBe('2026-10-25T00:30:00.000Z')
    expect(iso(nextLocalDailyRun(first, '01:30', 'Europe/London'))).toBe('2026-10-26T01:30:00.000Z')

    const gap = nextLocalDailyRun(at('2026-03-28T12:00:00Z'), '01:30', 'Europe/London')
    expect(iso(gap)).toBe('2026-03-29T01:30:00.000Z')
    expect(iso(nextLocalDailyRun(gap, '01:30', 'Europe/London'))).toBe('2026-03-30T00:30:00.000Z')
  })

  it('crosses year boundaries and reports the local date', () => {
    const o = nextLocalDailyOccurrence(at('2026-12-31T23:30:00Z'), '11:00', 'Europe/London')
    expect(o.localDate).toBe('2027-01-01')
    expect(iso(o.at)).toBe('2027-01-01T11:00:00.000Z')
    const ch = nextLocalDailyOccurrence(at('2026-12-31T12:00:00Z'), '11:00', 'Pacific/Chatham')
    expect(ch.localDate).toBe('2027-01-01')
    expect(iso(ch.at)).toBe('2026-12-31T21:15:00.000Z')
  })

  it('handles Lord Howe and Chatham transition days', () => {
    expect(iso(nextLocalDailyRun(at('2026-10-03T00:00:00Z'), '02:15', 'Australia/Lord_Howe'))).toBe(
      '2026-10-03T15:45:00.000Z',
    )
    // 00:00Z on 26 Sep is 12:45 local (+12:45); the next 11:00 is on 27 Sep, after the
    // 02:45 → 03:45 jump, so at +13:45.
    expect(iso(nextLocalDailyRun(at('2026-09-26T00:00:00Z'), '11:00', 'Pacific/Chatham'))).toBe(
      '2026-09-26T21:15:00.000Z',
    )
    expect(iso(nextLocalDailyRun(at('2026-09-25T00:00:00Z'), '11:00', 'Pacific/Chatham'))).toBe(
      '2026-09-25T22:15:00.000Z',
    )
    expect(iso(nextLocalDailyRun(at('2026-09-26T21:15:00Z'), '11:00', 'Pacific/Chatham'))).toBe(
      '2026-09-27T21:15:00.000Z',
    )
  })
})

describe('latestLocalDailyOccurrence', () => {
  it('returns the most recent occurrence at or before the instant', () => {
    const exact = latestLocalDailyOccurrence(at('2026-03-29T10:00:00Z'), '11:00', 'Europe/London')
    expect(exact).toEqual({ localDate: '2026-03-29', at: at('2026-03-29T10:00:00Z') })
    const before = latestLocalDailyOccurrence(at('2026-03-29T09:59:59Z'), '11:00', 'Europe/London')
    expect(before).toEqual({ localDate: '2026-03-28', at: at('2026-03-28T11:00:00Z') })
    // 03:30Z on 1 Jan is 22:30 EST on 31 Dec.
    const ny = latestLocalDailyOccurrence(at('2027-01-01T03:30:00Z'), '22:00', 'America/New_York')
    expect(ny).toEqual({ localDate: '2026-12-31', at: at('2027-01-01T03:00:00Z') })
    // 02:00Z is 21:00 EST on 31 Dec, so the latest 22:00 was on 30 Dec.
    expect(latestLocalDailyOccurrence(at('2027-01-01T02:00:00Z'), '22:00', 'America/New_York').localDate).toBe(
      '2026-12-30',
    )
  })
})

describe('calendar helpers', () => {
  it('addLocalDays handles month, leap-year and year boundaries', () => {
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addLocalDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addLocalDays('2026-03-29', 1)).toBe('2026-03-30')
    expect(addLocalDays('2026-09-24', 0)).toBe('2026-09-24')
    expect(addLocalDays('2026-09-24', 365)).toBe('2027-09-24')
    expect(() => addLocalDays('2026-09-24', 0.5)).toThrow(RangeError)
  })

  it('isoWeekday is Monday=1 … Sunday=7', () => {
    expect(isoWeekday('2026-09-24')).toBe(4) // Thursday
    expect(isoWeekday('2026-09-28')).toBe(1) // Monday
    expect(isoWeekday('2026-03-29')).toBe(7) // Sunday (DST change)
    expect(isoWeekday('2027-01-01')).toBe(5) // Friday
    expect(() => isoWeekday('2026-9-24')).toThrow(RangeError)
  })

  it('localDaysBetween counts calendar days', () => {
    expect(localDaysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(localDaysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(localDaysBetween('2026-10-26', '2026-10-24')).toBe(-2)
  })

  it('schemas validate dates and times', () => {
    expect(CalendarDateSchema.safeParse('2028-02-29').success).toBe(true)
    expect(CalendarDateSchema.safeParse('2027-02-29').success).toBe(false)
    expect(CalendarDateSchema.safeParse('2026-09-24T00:00').success).toBe(false)
    expect(WallClockTimeSchema.safeParse('23:59').success).toBe(true)
    expect(WallClockTimeSchema.safeParse('24:00').success).toBe(false)
    expect(WallClockTimeSchema.safeParse('11:00:00').success).toBe(false)
  })
})
