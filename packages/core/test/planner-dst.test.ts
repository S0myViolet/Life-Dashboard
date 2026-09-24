/**
 * DST: planning on the Europe/London transition days produces correct wall-clock blocks and
 * counts real (elapsed) minutes.
 *   2026-03-29: 01:00 GMT → 02:00 BST (the 01:00–01:59 wall hour does not exist; day = 23 h)
 *   2026-10-25: 02:00 BST → 01:00 GMT (the 01:00–01:59 wall hour happens twice; day = 25 h)
 */
import { describe, expect, it } from 'vitest'
import {
  planDay,
  plannerValidateBlockEdit,
  localTimeInZone,
  zonedLocalToUtc,
  type PlanCurrentBlock,
  type PlannerCandidateInput,
} from '../src/index.ts'

const TZ = 'Europe/London'
const wall = (iso: string | null) => localTimeInZone(new Date(iso!), TZ)
const c = (id: string, minutes: number, extra: Partial<PlannerCandidateInput> = {}) => ({
  id,
  kind: 'task' as const,
  title: id,
  durationMinutes: minutes,
  priority: 1,
  createdAt: `2026-01-01T00:00:0${id.length % 10}Z`,
  ...extra,
})

describe('spring forward — 2026-03-29', () => {
  const date = '2026-03-29'
  const now = new Date('2026-03-28T20:00:00Z')

  it('a 00:00–04:00 window holds three real hours, and blocks skip the missing hour', () => {
    const d = planDay({
      now,
      timezone: TZ,
      localDate: date,
      availability: [{ start: '00:00', end: '04:00' }],
      candidates: [c('a', 40), c('bb', 40), c('ccc', 40)],
    })
    expect(d.capacity.freeMinutes).toBe(180)
    expect(d.capacity.budgetMinutes).toBe(144)
    expect(d.scheduled.map((b) => [b.candidateId, wall(b.start), wall(b.end), b.minutes])).toEqual([
      ['a', '00:00', '00:40', 40],
      ['bb', '00:40', '02:20', 40], // 00:40 GMT → 01:20 GMT = 02:20 BST
      ['ccc', '02:20', '03:00', 40],
    ])
    expect(d.scheduled.map((b) => b.start)).toEqual([
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T00:40:00.000Z',
      '2026-03-29T01:20:00.000Z',
    ])
  })

  it('a normal working day is still eight hours', () => {
    const d = planDay({
      now,
      timezone: TZ,
      localDate: date,
      availability: [{ start: '09:00', end: '17:00' }],
      candidates: [c('a', 60)],
    })
    expect(d.capacity.freeMinutes).toBe(480)
    expect(wall(d.scheduled[0]!.start)).toBe('09:00')
    expect(d.scheduled[0]!.start).toBe('2026-03-29T08:00:00.000Z')
  })

  it('a window that only covers the missing hour has no time', () => {
    const d = planDay({
      now,
      timezone: TZ,
      localDate: date,
      availability: [{ start: '01:00', end: '02:00' }],
      candidates: [c('a', 15)],
    })
    expect(d.capacity.freeMinutes).toBe(0)
    expect(d.scheduled).toEqual([])
    expect(d.doesNotFit[0]?.candidateId).toBe('a')
  })

  it('an owner edit to a nonexistent wall time resolves forward', () => {
    const blocks: PlanCurrentBlock[] = [
      {
        id: 'b1',
        candidateKind: 'task',
        candidateId: 'x',
        title: 'X',
        bucket: 'scheduled',
        start: '2026-03-29T09:00:00.000Z',
        end: '2026-03-29T09:30:00.000Z',
        minutes: 30,
        state: 'accepted',
        editedByOwner: false,
        splitPart: null,
        splitTotal: null,
        position: 0,
      },
    ]
    const r = plannerValidateBlockEdit({ timezone: TZ, localDate: date, now, blocks }, 'b1', {
      startTime: '01:30',
      minutes: 30,
    })
    expect(r.ok && r.value.start).toBe('2026-03-29T01:30:00.000Z') // 02:30 BST
  })
})

describe('fall back — 2026-10-25', () => {
  const date = '2026-10-25'
  const now = new Date('2026-10-24T20:00:00Z')

  it('a 00:00–04:00 window holds five real hours and the repeated hour appears twice', () => {
    const d = planDay({
      now,
      timezone: TZ,
      localDate: date,
      availability: [{ start: '00:00', end: '04:00' }],
      candidates: [c('a', 60), c('bb', 60), c('ccc', 60), c('dddd', 60)],
    })
    expect(d.capacity.freeMinutes).toBe(300)
    expect(d.capacity.budgetMinutes).toBe(240)
    expect(d.scheduled.map((b) => [wall(b.start), wall(b.end), b.minutes])).toEqual([
      ['00:00', '01:00', 60], // BST
      ['01:00', '01:00', 60], // 01:00 BST → 01:00 GMT
      ['01:00', '02:00', 60], // GMT
      ['02:00', '03:00', 60],
    ])
    expect(d.scheduled.map((b) => b.start)).toEqual([
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ])
  })

  it('respects "now" during the second 01:00 hour', () => {
    // 01:30 GMT (the second occurrence) = 01:30Z. A naive wall-time comparison would think
    // 01:30 BST (00:30Z) is still available.
    const d = planDay({
      now: new Date('2026-10-25T01:30:00Z'),
      timezone: TZ,
      localDate: date,
      availability: [{ start: '00:00', end: '04:00' }],
      candidates: [c('a', 30)],
    })
    expect(d.scheduled[0]!.start).toBe('2026-10-25T01:30:00.000Z')
    expect(d.capacity.freeMinutes).toBe(150)
  })

  it('a normal working day is still eight hours', () => {
    const d = planDay({
      now,
      timezone: TZ,
      localDate: date,
      availability: [{ start: '09:00', end: '17:00' }],
      candidates: [c('a', 60)],
    })
    expect(d.capacity.freeMinutes).toBe(480)
    expect(d.scheduled[0]!.start).toBe('2026-10-25T09:00:00.000Z')
  })

  it('an end of 24:00 is the real end of a 25-hour day', () => {
    const d = planDay({
      now,
      timezone: TZ,
      localDate: date,
      availability: [{ start: '00:00', end: '24:00' }],
      candidates: [],
    })
    expect(d.capacity.freeMinutes).toBe(25 * 60)
    expect(zonedLocalToUtc('2026-10-26', '00:00', TZ).toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    )
  })
})
