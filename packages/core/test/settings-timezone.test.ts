import { describe, expect, it } from 'vitest'
import {
  OwnerTimezoneSchema,
  greetingForLocalHour,
  groupTimezonesForPicker,
  homeHeading,
  ownerTimezoneCandidates,
  ownerTimezoneIsValid,
  ownerTimezonePrimaryName,
  timezonePickerLabel,
} from '../src/index.ts'

describe('ownerTimezoneIsValid / OwnerTimezoneSchema', () => {
  it('accepts IANA zones including legacy spellings and UTC', () => {
    for (const tz of [
      'Europe/London',
      'America/New_York',
      'America/Argentina/Buenos_Aires',
      'Asia/Kolkata',
      'Asia/Calcutta',
      'Australia/Lord_Howe',
      'UTC',
    ]) {
      expect(ownerTimezoneIsValid(tz), tz).toBe(true)
    }
  })

  it('rejects junk, injection-shaped strings and unknown zones', () => {
    for (const tz of [
      '',
      'Mars/Olympus',
      'Europe/London; drop table x',
      '../etc/passwd',
      '/Europe/London',
      'Europe//London',
      'Europe/London/Extra/More',
      'x'.repeat(65),
      'Europe/Lon don',
    ]) {
      expect(ownerTimezoneIsValid(tz), tz).toBe(false)
    }
  })

  it('trims before validating', () => {
    expect(OwnerTimezoneSchema.parse('  Europe/Paris ')).toBe('Europe/Paris')
    expect(OwnerTimezoneSchema.safeParse(42).success).toBe(false)
    expect(OwnerTimezoneSchema.safeParse('Mars/Olympus').success).toBe(false)
  })
})

describe('legacy timezone spellings', () => {
  it('maps CLDR legacy names (as reported by Chrome) to IANA primary names', () => {
    expect(ownerTimezonePrimaryName('Asia/Calcutta')).toBe('Asia/Kolkata')
    expect(ownerTimezonePrimaryName('Europe/Kiev')).toBe('Europe/Kyiv')
    expect(ownerTimezonePrimaryName('Europe/London')).toBe('Europe/London')
  })

  it('lists equivalent candidates, primary first, without duplicates', () => {
    expect(ownerTimezoneCandidates('Asia/Calcutta')).toEqual(['Asia/Kolkata', 'Asia/Calcutta'])
    expect(ownerTimezoneCandidates('Europe/Kyiv')).toEqual(['Europe/Kyiv', 'Europe/Kiev'])
    expect(ownerTimezoneCandidates('Europe/London')).toEqual(['Europe/London'])
  })

  it('maps merged zones forward only', () => {
    expect(ownerTimezoneCandidates('Europe/Uzhgorod')).toEqual([
      'Europe/Kyiv',
      'Europe/Uzhgorod',
      'Europe/Kiev',
    ])
    expect(ownerTimezoneCandidates('Europe/Kyiv')).not.toContain('Europe/Uzhgorod')
  })
})

describe('groupTimezonesForPicker', () => {
  it('keeps regional zones and UTC, drops POSIX names and legacy duplicates', () => {
    const groups = groupTimezonesForPicker([
      'Europe/London',
      'Europe/Kiev',
      'Europe/Kyiv',
      'Asia/Calcutta',
      'UTC',
      'Etc/GMT+5',
      'EST5EDT',
      'posixrules',
      'Factory',
      'America/Argentina/Buenos_Aires',
    ])
    expect(groups).toEqual([
      { region: 'UTC', zones: ['UTC'] },
      { region: 'America', zones: ['America/Argentina/Buenos_Aires'] },
      // Asia/Calcutta stays: its primary spelling is not in the list.
      { region: 'Asia', zones: ['Asia/Calcutta'] },
      { region: 'Europe', zones: ['Europe/Kyiv', 'Europe/London'] },
    ])
  })

  it('labels zones readably', () => {
    expect(timezonePickerLabel('America/Argentina/Buenos_Aires')).toBe('Argentina / Buenos Aires')
    expect(timezonePickerLabel('UTC')).toBe('UTC')
  })
})

describe('greeting and heading', () => {
  it('greets by local hour', () => {
    expect(greetingForLocalHour(0)).toBe('Hello')
    expect(greetingForLocalHour(4)).toBe('Hello')
    expect(greetingForLocalHour(5)).toBe('Good morning')
    expect(greetingForLocalHour(11)).toBe('Good morning')
    expect(greetingForLocalHour(12)).toBe('Good afternoon')
    expect(greetingForLocalHour(16)).toBe('Good afternoon')
    expect(greetingForLocalHour(17)).toBe('Good evening')
    expect(greetingForLocalHour(21)).toBe('Good evening')
    expect(greetingForLocalHour(22)).toBe('Hello')
    expect(() => greetingForLocalHour(24)).toThrow(RangeError)
    expect(() => greetingForLocalHour(-1)).toThrow(RangeError)
    expect(() => greetingForLocalHour(7.5)).toThrow(RangeError)
  })

  it('computes date and greeting in the owner timezone, not the server one', () => {
    // 23:30 UTC on the 24th is 00:30 on the 25th in London (BST = UTC+1) but 19:30 in New York.
    const instant = new Date('2026-09-24T23:30:00Z')
    const london = homeHeading(instant, 'Europe/London')
    expect(london).toMatchObject({
      localDate: '2026-09-25',
      localHour: 0,
      greeting: 'Hello',
      dateLabel: 'Friday 25 September',
      usedFallback: false,
    })
    const ny = homeHeading(instant, 'America/New_York')
    expect(ny).toMatchObject({
      localDate: '2026-09-24',
      localHour: 19,
      greeting: 'Good evening',
      dateLabel: 'Thursday 24 September',
    })
    const kolkata = homeHeading(new Date('2026-09-24T03:00:00Z'), 'Asia/Kolkata')
    expect(kolkata).toMatchObject({ localHour: 8, greeting: 'Good morning' })
  })

  it('handles DST changes in London', () => {
    // 2026-10-25 01:30 UTC: clocks went back at 02:00 BST → 01:00 GMT, so 01:30 GMT.
    expect(homeHeading(new Date('2026-10-25T01:30:00Z'), 'Europe/London').localHour).toBe(1)
    // 2026-03-29 01:30 UTC: clocks went forward at 01:00 GMT → 02:00 BST, so 02:30 BST.
    expect(homeHeading(new Date('2026-03-29T01:30:00Z'), 'Europe/London').localHour).toBe(2)
  })

  it('falls back to UTC (and says so) for a zone this runtime does not know', () => {
    const heading = homeHeading(new Date('2026-09-24T12:00:00Z'), 'Mars/Olympus')
    expect(heading).toMatchObject({ timezone: 'UTC', usedFallback: true, localHour: 12 })
  })
})
