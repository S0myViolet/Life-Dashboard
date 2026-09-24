/**
 * Seeded property tests for planDay (fast-check is not installed: a small PRNG generates
 * inputs). Each failure message includes the seed so a case can be replayed.
 */
import { describe, expect, it } from 'vitest'
import {
  addLocalDays,
  planDay,
  plannerCandidateKey,
  plannerEventBlocksTime,
  plannerWindowSpans,
  PLANNER_DEFAULT_OPTIONS,
  zonedLocalToUtc,
  type PlanDraft,
  type PlannerBusyEventInput,
  type PlannerCandidateInput,
  type PlannerInput,
  type PlannerProtectedBlockInput,
} from '../src/index.ts'

/** mulberry32: tiny, fast, good enough for test generation. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  }
}
type Rng = ReturnType<typeof rng>

const ZONES = [
  'Europe/London',
  'America/New_York',
  'Australia/Lord_Howe', // 30-minute DST shift
  'Asia/Kathmandu', // +05:45
  'Pacific/Chatham', // +12:45 / +13:45
  'America/Sao_Paulo',
  'UTC',
]
const DATES = [
  '2026-03-29', // London spring forward
  '2026-10-25', // London fall back
  '2026-03-08', // New York spring forward
  '2026-11-01', // New York fall back
  '2026-04-05', // Lord Howe / Chatham fall back
  '2026-10-04', // Lord Howe spring forward
  '2026-09-27', // Chatham spring forward
  '2026-09-24',
  '2026-06-15',
]

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

function genInput(r: Rng): PlannerInput {
  const timezone = r.pick(ZONES)
  const localDate = r.pick(DATES)
  const dayStart = zonedLocalToUtc(localDate, '00:00', timezone).getTime()
  const dayEnd = zonedLocalToUtc(addLocalDays(localDate, 1), '00:00', timezone).getTime()
  const span = dayEnd - dayStart
  const now = new Date(dayStart + r.int(-6 * 60, 26 * 60) * 60_000 + r.int(0, 59_999))
  const inDay = () => new Date(dayStart + r.int(0, Math.floor(span / 60_000)) * 60_000)

  let availability: PlannerInput['availability'] = null
  if (!r.bool(0.15)) {
    availability = []
    for (let i = r.int(1, 4); i > 0; i--) {
      const grid = r.pick([1, 5, 15, 30])
      const s = r.int(0, Math.floor(1380 / grid)) * grid
      const e = Math.min(1440, s + r.int(1, 10) * r.pick([10, 15, 30, 45]))
      if (e <= s) continue
      availability.push({ start: hhmm(s), end: e === 1440 ? '24:00' : hhmm(e) })
    }
  }

  const busy: PlannerBusyEventInput[] = []
  for (let i = r.int(0, 6); i > 0; i--) {
    const s = inDay()
    const allDay = r.bool(0.15)
    busy.push({
      id: `ev${i}`,
      title: `Event ${i}`,
      start: allDay ? new Date(dayStart) : s,
      end: allDay ? new Date(dayEnd) : new Date(s.getTime() + r.int(5, 180) * 60_000),
      allDay,
      busy: r.bool(0.2) ? r.bool() : undefined,
    })
  }

  const candidates: PlannerCandidateInput[] = []
  const n = r.int(0, 18)
  for (let i = 0; i < n; i++) {
    const kind = r.pick([
      'task',
      'task',
      'task',
      'project_action',
      'email_deadline',
      'habit',
      'reading_goal',
    ] as const)
    const dueRoll = r.next()
    let dueAt: Date | null = null
    let dueDate: string | null = null
    if (dueRoll < 0.25) {
      dueAt = new Date(dayStart + r.int(-3 * 1440, 5 * 1440) * 60_000)
    } else if (dueRoll < 0.5) {
      dueDate = addLocalDays(localDate, r.int(-4, 6))
    }
    candidates.push({
      id: `c${i}`,
      kind,
      title: `Candidate ${i}`,
      dueAt,
      dueDate,
      priority: r.bool(0.5) ? r.int(1, 4) : null,
      durationMinutes: r.bool(0.6)
        ? r.pick([5, 7, 10, 15, 20, 25, 30, 45, 60, 90, 120, 240])
        : null,
      splittable: r.bool(0.35),
      confirmed: r.bool(0.8),
      createdAt: new Date(dayStart - r.int(0, 60) * 86_400_000),
    })
  }

  const protectedBlocks: PlannerProtectedBlockInput[] = []
  for (let i = r.int(0, 3); i > 0; i--) {
    const target = candidates.length && r.bool(0.7) ? r.pick(candidates) : null
    const minutes = r.int(1, 12) * 10
    const timed = r.bool(0.8)
    const s = inDay()
    const split = r.bool(0.3)
    protectedBlocks.push({
      id: `pb${i}`,
      title: `Kept ${i}`,
      candidateKind: target?.kind ?? null,
      candidateId: target?.id ?? null,
      start: timed ? s : null,
      end: timed ? new Date(s.getTime() + minutes * 60_000) : null,
      minutes,
      splitPart: split ? 1 : null,
      splitTotal: split ? 2 : null,
    })
  }

  const options: PlannerInput['options'] = r.bool(0.3)
    ? {
        bufferRatio: r.pick([0, 0.1, 0.2, 0.35, 0.5]),
        minBlockMinutes: r.pick([10, 15, 30]),
        smallTaskMaxMinutes: r.pick([10, 15, 20]),
        defaultEstimateMinutes: r.pick([15, 30, 45]),
        maxPriorities: r.int(0, 3),
      }
    : {}

  return { now, timezone, localDate, availability, busy, protectedBlocks, candidates, options }
}

function shuffle<T>(r: Rng, xs: readonly T[]): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(0, i)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function checkInvariants(inp: PlannerInput, d: PlanDraft, seed: number) {
  const msg = (what: string) => `seed ${seed}: ${what}`
  const opts = { ...PLANNER_DEFAULT_OPTIONS, ...inp.options }
  const now = new Date(inp.now as Date).getTime()
  const placed = [...d.scheduled, ...d.smallTasks]
  const spans = placed.map((b) => ({ b, s: Date.parse(b.start!), e: Date.parse(b.end!) }))

  // No block starts before now; every block is a positive span.
  for (const { b, s, e } of spans) {
    expect(s, msg(`${b.candidateId} starts before now`)).toBeGreaterThanOrEqual(now)
    expect(e, msg(`${b.candidateId} empty span`)).toBeGreaterThan(s)
    expect(Math.round((e - s) / 60_000), msg('minutes match span')).toBe(b.minutes)
  }
  // No overlap between blocks.
  const sorted = [...spans].sort((a, b) => a.s - b.s)
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]!.s, msg('blocks overlap each other')).toBeGreaterThanOrEqual(sorted[i - 1]!.e)
  }
  // No overlap with busy events or protected blocks.
  const blockers = [
    ...(inp.busy ?? [])
      .filter((e) => plannerEventBlocksTime({ allDay: e.allDay ?? false, busy: e.busy ?? null }))
      .map((e) => ({
        s: new Date(e.start as Date).getTime(),
        e: new Date(e.end as Date).getTime(),
      })),
    ...(inp.protectedBlocks ?? [])
      .filter((p) => p.start && p.end)
      .map((p) => ({
        s: new Date(p.start as Date).getTime(),
        e: new Date(p.end as Date).getTime(),
      })),
  ]
  for (const { b, s, e } of spans) {
    for (const x of blockers) {
      expect(s < x.e && x.s < e, msg(`${b.candidateId} overlaps busy/protected`)).toBe(false)
    }
  }
  // Inside the availability windows.
  if (inp.availability && inp.availability.length > 0) {
    const windows = plannerWindowSpans(inp.localDate, inp.availability, inp.timezone)
    for (const { b, s, e } of spans) {
      expect(
        windows.some((w) => w.start <= s && e <= w.end),
        msg(`${b.candidateId} outside windows`),
      ).toBe(true)
    }
  }
  // Buffer.
  const c = d.capacity
  if (c.known) {
    const free = c.freeMinutes!
    expect(c.allocatedMinutes, msg('allocation exceeds (1 − buffer) × free')).toBeLessThanOrEqual(
      (1 - opts.bufferRatio) * free + 1e-6,
    )
    expect(c.bufferMinutes! + c.budgetMinutes!).toBe(free)
    expect(c.allocatedMinutes).toBe(placed.reduce((sum, b) => sum + b.minutes, 0))
    expect(c.allocatedMinutes + c.overflowMinutes!).toBe(c.demandMinutes)
  } else {
    expect(placed).toEqual([])
    expect(d.canWait).toEqual([])
    expect(d.doesNotFit).toEqual([])
    expect(d.list.every((b) => b.start === null && b.end === null)).toBe(true)
  }
  // Priorities.
  const cands = new Map(inp.candidates.map((x) => [plannerCandidateKey(x.kind, x.id), x]))
  expect(d.priorities.length, msg('too many priorities')).toBeLessThanOrEqual(
    Math.min(3, opts.maxPriorities),
  )
  d.priorities.forEach((p, i) => {
    const cand = cands.get(plannerCandidateKey(p.candidateKind, p.candidateId))
    expect(cand, msg('priority is not a candidate')).toBeDefined()
    expect(cand!.confirmed ?? true, msg('tentative priority')).toBe(true)
    expect(p.rank).toBe(i + 1)
    expect(p.reason.length).toBeGreaterThan(0)
  })
  for (const b of [...placed, ...d.list]) {
    const cand = cands.get(plannerCandidateKey(b.candidateKind, b.candidateId))!
    expect(b.tentative).toBe(!(cand.confirmed ?? true))
    if (b.tentative) expect(b.priorityRank).toBeNull()
    expect(b.estimated).toBe(cand.durationMinutes == null)
  }
  // Every candidate in exactly one bucket.
  const bucketOf = new Map<string, string[]>()
  const note = (key: string, bucket: string) => {
    const list = bucketOf.get(key) ?? []
    if (!list.includes(bucket)) list.push(bucket)
    bucketOf.set(key, list)
  }
  for (const b of d.scheduled)
    note(plannerCandidateKey(b.candidateKind, b.candidateId), 'scheduled')
  for (const b of d.smallTasks)
    note(plannerCandidateKey(b.candidateKind, b.candidateId), 'smallTasks')
  for (const b of d.list) note(plannerCandidateKey(b.candidateKind, b.candidateId), 'list')
  for (const b of d.canWait) note(plannerCandidateKey(b.candidateKind, b.candidateId), 'canWait')
  for (const b of d.doesNotFit)
    note(plannerCandidateKey(b.candidateKind, b.candidateId), 'doesNotFit')
  for (const b of d.alreadyPlanned) {
    note(plannerCandidateKey(b.candidateKind, b.candidateId), 'alreadyPlanned')
  }
  for (const key of cands.keys()) {
    expect(bucketOf.get(key), msg(`${key} buckets`)).toHaveLength(1)
  }
  expect([...bucketOf.keys()].every((k) => cands.has(k))).toBe(true)
  // Splitting.
  const parts = new Map<string, typeof placed>()
  for (const b of placed) {
    const k = plannerCandidateKey(b.candidateKind, b.candidateId)
    parts.set(k, [...(parts.get(k) ?? []), b])
  }
  for (const [k, list] of parts) {
    const cand = cands.get(k)!
    if (list.length > 1) {
      expect(cand.splittable, msg(`${k} split but not splittable`)).toBe(true)
      for (const p of list) {
        expect(p.minutes, msg(`${k} part below minimum`)).toBeGreaterThanOrEqual(
          opts.minBlockMinutes,
        )
      }
    }
    const covered = (inp.protectedBlocks ?? [])
      .filter((p) => p.candidateKind === cand.kind && p.candidateId === cand.id)
      .reduce((s, p) => s + p.minutes, 0)
    const want = (cand.durationMinutes ?? opts.defaultEstimateMinutes) - covered
    expect(
      list.reduce((s, p) => s + p.minutes, 0),
      msg(`${k} total minutes`),
    ).toBe(want)
  }
}

describe('planDay properties (seeded)', { timeout: 120_000 }, () => {
  const RUNS = 600
  it(`holds the invariants over ${RUNS} random inputs`, () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(seed)
      const inp = genInput(r)
      const d = planDay(inp)
      checkInvariants(inp, d, seed)
    }
  })

  it('is deterministic and independent of input order', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7919)
      const inp = genInput(r)
      const first = planDay(inp)
      expect(planDay(structuredClone(inp)), `seed ${seed}`).toEqual(first)
      const shuffled: PlannerInput = {
        ...inp,
        candidates: shuffle(r, inp.candidates),
        busy: shuffle(r, inp.busy ?? []),
        protectedBlocks: shuffle(r, inp.protectedBlocks ?? []),
        availability: inp.availability ? shuffle(r, inp.availability) : inp.availability,
      }
      expect(planDay(shuffled), `seed ${seed} (shuffled)`).toEqual(first)
    }
  })

  it('never schedules anything when the whole day is in the past', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed * 104729)
      const inp = genInput(r)
      const later = zonedLocalToUtc(addLocalDays(inp.localDate, 1), '00:00', inp.timezone)
      const d = planDay({ ...inp, now: new Date(later.getTime() + 60_000) })
      expect([...d.scheduled, ...d.smallTasks], `seed ${seed}`).toEqual([])
    }
  })
})
