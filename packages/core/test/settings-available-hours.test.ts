import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_HOURS_MAX_SLOTS_PER_DAY,
  AvailableHoursSchema,
  availableMinutesForWeekday,
  parseStoredAvailableHours,
  summarizeAvailableHours,
  type AvailableHours,
} from '../src/index.ts'

const weekdays = (start: string, end: string): AvailableHours =>
  ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, start, end }))

describe('AvailableHoursSchema', () => {
  it('accepts valid slots and sorts them by weekday then start', () => {
    const parsed = AvailableHoursSchema.parse([
      { weekday: 3, start: '13:00', end: '17:00' },
      { weekday: 1, start: '09:00', end: '12:00' },
      { weekday: 3, start: '09:00', end: '12:00' },
    ])
    expect(parsed).toEqual([
      { weekday: 1, start: '09:00', end: '12:00' },
      { weekday: 3, start: '09:00', end: '12:00' },
      { weekday: 3, start: '13:00', end: '17:00' },
    ])
  })

  it('allows touching ranges on the same day', () => {
    expect(
      AvailableHoursSchema.safeParse([
        { weekday: 2, start: '09:00', end: '12:00' },
        { weekday: 2, start: '12:00', end: '13:00' },
      ]).success,
    ).toBe(true)
  })

  it('rejects overlaps on the same day but not across days', () => {
    const res = AvailableHoursSchema.safeParse([
      { weekday: 2, start: '09:00', end: '12:00' },
      { weekday: 2, start: '11:30', end: '13:00' },
      { weekday: 4, start: '11:30', end: '13:00' },
    ])
    expect(res.success).toBe(false)
    expect(res.error?.issues).toHaveLength(1)
    expect(res.error?.issues[0]?.path).toEqual([1, 'start'])
    expect(res.error?.issues[0]?.message).toMatch(/Overlaps 09:00–12:00 on Tuesday/)
    // Containment is an overlap too.
    expect(
      AvailableHoursSchema.safeParse([
        { weekday: 6, start: '08:00', end: '18:00' },
        { weekday: 6, start: '10:00', end: '11:00' },
      ]).success,
    ).toBe(false)
  })

  it('rejects start >= end, bad times, bad weekdays and extra keys', () => {
    const bad = [
      [{ weekday: 1, start: '10:00', end: '10:00' }],
      [{ weekday: 1, start: '17:00', end: '09:00' }],
      [{ weekday: 1, start: '9:00', end: '17:00' }],
      [{ weekday: 1, start: '09:00', end: '24:00' }],
      [{ weekday: 1, start: '09:60', end: '17:00' }],
      [{ weekday: 0, start: '09:00', end: '17:00' }],
      [{ weekday: 8, start: '09:00', end: '17:00' }],
      [{ weekday: 1.5, start: '09:00', end: '17:00' }],
      [{ weekday: '1', start: '09:00', end: '17:00' }],
      [{ weekday: 1, start: '09:00', end: '17:00', note: 'x' }],
      'Mon 9-5',
    ]
    for (const value of bad) expect(AvailableHoursSchema.safeParse(value).success).toBe(false)
  })

  it('limits the number of ranges per day', () => {
    const many = Array.from({ length: AVAILABLE_HOURS_MAX_SLOTS_PER_DAY + 1 }, (_, i) => ({
      weekday: 5,
      start: `${String(8 + i).padStart(2, '0')}:00`,
      end: `${String(8 + i).padStart(2, '0')}:30`,
    }))
    expect(AvailableHoursSchema.safeParse(many.slice(0, -1)).success).toBe(true)
    expect(AvailableHoursSchema.safeParse(many).success).toBe(false)
  })
})

describe('parseStoredAvailableHours', () => {
  it('distinguishes not set, set and invalid', () => {
    expect(parseStoredAvailableHours(null)).toEqual({ status: 'not_set' })
    expect(parseStoredAvailableHours([])).toEqual({ status: 'not_set' })
    expect(parseStoredAvailableHours(weekdays('09:00', '17:30'))).toMatchObject({ status: 'set' })
    expect(parseStoredAvailableHours([{ weekday: 9, start: 'x', end: 'y' }])).toEqual({
      status: 'invalid',
    })
  })
})

describe('summaries', () => {
  it('groups consecutive days with identical ranges', () => {
    const hours: AvailableHours = [
      ...weekdays('09:00', '17:30'),
      { weekday: 6, start: '10:00', end: '12:00' },
    ]
    expect(summarizeAvailableHours(hours)).toBe('Mon–Fri 09:00–17:30 · Sat 10:00–12:00')
    expect(summarizeAvailableHours(null)).toBeNull()
    expect(summarizeAvailableHours([])).toBeNull()
  })

  it('does not merge non-consecutive days and lists multiple ranges', () => {
    const hours: AvailableHours = [
      { weekday: 1, start: '09:00', end: '12:00' },
      { weekday: 1, start: '13:00', end: '17:00' },
      { weekday: 3, start: '09:00', end: '12:00' },
      { weekday: 3, start: '13:00', end: '17:00' },
    ]
    expect(summarizeAvailableHours(hours)).toBe(
      'Mon 09:00–12:00, 13:00–17:00 · Wed 09:00–12:00, 13:00–17:00',
    )
  })

  it('counts available minutes per weekday', () => {
    const hours: AvailableHours = [
      { weekday: 1, start: '09:00', end: '12:00' },
      { weekday: 1, start: '13:00', end: '17:30' },
    ]
    expect(availableMinutesForWeekday(hours, 1)).toBe(450)
    expect(availableMinutesForWeekday(hours, 2)).toBe(0)
  })
})
