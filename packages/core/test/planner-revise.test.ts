/**
 * reviseDraft and owner edits: accepted/pinned/done/dismissed/edited blocks are never changed or
 * removed by a refresh; only the planner's own unaccepted suggestions are proposed for change.
 */
import { describe, expect, it } from 'vitest'
import {
  planDay,
  plannerAssignPositions,
  plannerDismissedKeys,
  plannerNextAction,
  plannerProtectedBlocksOf,
  plannerSplitLabels,
  plannerValidateBlockEdit,
  plannerValidateMove,
  reviseDraft,
  localTimeInZone,
  zonedLocalToUtc,
  type PlanCurrentBlock,
  type PlanDraft,
  type PlanDraftBlock,
  type PlannerCandidateInput,
  type PlannerInput,
} from '../src/index.ts'

const TZ = 'Europe/London'
const DATE = '2026-09-24'
const at = (time: string) => zonedLocalToUtc(DATE, time, TZ)
const iso = (time: string) => at(time).toISOString()
const wall = (s: string | null) => (s ? localTimeInZone(new Date(s), TZ) : null)

function cand(id: string, over: Partial<PlannerCandidateInput> = {}): PlannerCandidateInput {
  return { id, kind: 'task', title: id.toUpperCase(), createdAt: '2026-09-01T00:00:00Z', ...over }
}

let n = 0
function block(over: Partial<PlanCurrentBlock> & { candidateId: string }): PlanCurrentBlock {
  n++
  return {
    id: over.id ?? `blk${n}`,
    candidateKind: 'task',
    title: over.candidateId.toUpperCase(),
    bucket: 'scheduled',
    start: null,
    end: null,
    minutes: 30,
    state: 'suggested',
    editedByOwner: false,
    splitPart: null,
    splitTotal: null,
    position: n,
    ...over,
  }
}

/** Persist a draft the way the repository does: one suggested block per draft block. */
function persist(d: PlanDraft): PlanCurrentBlock[] {
  return [...d.scheduled, ...d.smallTasks, ...d.list].map((b: PlanDraftBlock, i) => ({
    id: `b-${b.candidateId}-${b.splitPart ?? 0}`,
    candidateKind: b.candidateKind,
    candidateId: b.candidateId,
    title: b.title,
    bucket: b.bucket,
    start: b.start,
    end: b.end,
    minutes: b.minutes,
    state: 'suggested',
    editedByOwner: false,
    splitPart: b.splitPart,
    splitTotal: b.splitTotal,
    position: i,
  }))
}

function draftFor(current: PlanCurrentBlock[], over: Partial<PlannerInput>): PlanDraft {
  const dismissed = plannerDismissedKeys(current)
  const candidates = (over.candidates ?? []).filter((c) => !dismissed.has(`${c.kind}:${c.id}`))
  return planDay({
    now: at('08:00'),
    timezone: TZ,
    localDate: DATE,
    availability: [{ start: '09:00', end: '17:00' }],
    ...over,
    candidates,
    protectedBlocks: plannerProtectedBlocksOf(current),
  })
}

describe('reviseDraft', () => {
  it('classifies unchanged, moved, removed and added suggestions', () => {
    const current = [
      block({ id: 'same', candidateId: 'a', start: iso('09:00'), end: iso('09:30') }),
      block({ id: 'moved', candidateId: 'b', start: iso('09:30'), end: iso('10:00') }),
      block({ id: 'gone', candidateId: 'c', start: iso('10:00'), end: iso('10:30') }),
    ]
    const draft = draftFor([], {
      candidates: [
        cand('a', { priority: 1 }),
        cand('b', { durationMinutes: 45, priority: 2 }),
        cand('d'),
      ],
    })
    const r = reviseDraft(current, draft)
    expect(r.unchanged.map((u) => u.blockId)).toEqual(['same'])
    expect(r.moves.map((m) => [m.blockId, wall(m.to.start), m.to.minutes])).toEqual([
      ['moved', '09:30', 45],
    ])
    expect(r.removals.map((x) => x.blockId)).toEqual(['gone'])
    expect(r.additions.map((x) => x.candidateId)).toEqual(['d'])
    expect(r.hasChanges).toBe(true)
  })

  it('never moves or removes accepted, pinned, done, dismissed or owner-edited blocks', () => {
    const current = [
      block({
        id: 'acc',
        candidateId: 'a',
        start: iso('09:00'),
        end: iso('09:30'),
        state: 'accepted',
      }),
      block({
        id: 'pin',
        candidateId: 'b',
        start: iso('11:00'),
        end: iso('11:30'),
        state: 'pinned',
      }),
      block({
        id: 'done',
        candidateId: 'c',
        start: iso('09:30'),
        end: iso('10:00'),
        state: 'done',
      }),
      block({
        id: 'dis',
        candidateId: 'd',
        start: iso('10:00'),
        end: iso('10:30'),
        state: 'dismissed',
      }),
      block({
        id: 'edit',
        candidateId: 'e',
        start: iso('14:00'),
        end: iso('14:50'),
        minutes: 50,
        editedByOwner: true,
      }),
    ]
    // Every candidate still exists (and 'a'..'e' would rank first), plus a new one.
    const cands = ['a', 'b', 'c', 'd', 'e'].map((id) => cand(id, { priority: 1 }))
    const draft = draftFor(current, { candidates: [...cands, cand('f')] })
    const r = reviseDraft(current, draft)
    const touched = new Set([
      ...r.moves.map((m) => m.blockId),
      ...r.removals.map((m) => m.blockId),
      ...r.unchanged.map((m) => m.blockId),
    ])
    for (const id of ['acc', 'pin', 'done', 'dis', 'edit']) expect(touched.has(id)).toBe(false)
    expect(r.kept.map((b) => b.id).sort()).toEqual(['acc', 'dis', 'done', 'edit', 'pin'])
    // Already-planned candidates are not suggested again; the dismissed one is not re-suggested.
    expect(r.additions.map((b) => b.candidateId)).toEqual(['f'])
    // The new suggestion does not overlap any kept block.
    const f = r.additions[0]!
    for (const k of current.filter((b) => b.state !== 'dismissed')) {
      expect(f.start! < k.end! && k.start! < f.end!).toBe(false)
    }
  })

  it('rejects proposals that would override an owner decision, even from a stale draft', () => {
    const current = [
      block({
        id: 'acc',
        candidateId: 'a',
        start: iso('09:00'),
        end: iso('10:00'),
        minutes: 60,
        state: 'accepted',
      }),
      block({
        id: 'dis',
        candidateId: 'x',
        state: 'dismissed',
        start: iso('12:00'),
        end: iso('12:30'),
      }),
    ]
    // A draft built without knowing the plan: it would put 'b' on top of the accepted block
    // and re-suggest the dismissed 'x'.
    const stale = draftFor([], { candidates: [cand('b', { priority: 1 }), cand('x')] })
    const r = reviseDraft(current, stale)
    expect(r.additions).toEqual([])
    expect(r.rejected.map((x) => [x.block.candidateId, x.reason]).sort()).toEqual([
      ['b', 'overlaps_protected'],
      ['x', 'dismissed_by_owner'],
    ])
  })

  it('reports overlapping kept blocks as conflicts without resolving them', () => {
    const current = [
      block({
        id: 'k1',
        candidateId: 'a',
        start: iso('09:00'),
        end: iso('10:00'),
        minutes: 60,
        state: 'accepted',
      }),
      block({
        id: 'k2',
        candidateId: 'b',
        start: iso('09:30'),
        end: iso('10:30'),
        minutes: 60,
        state: 'pinned',
      }),
    ]
    const r = reviseDraft(current, draftFor(current, { candidates: [] }))
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]).toMatchObject({ kind: 'block', blockId: 'k1', withId: 'k2' })
    expect(r.kept.map((b) => [b.id, b.start])).toEqual([
      ['k1', iso('09:00')],
      ['k2', iso('09:30')],
    ])
  })

  it('is a no-op when nothing changed', () => {
    const cands = [cand('a', { priority: 1 }), cand('b'), cand('c', { durationMinutes: 10 })]
    const d = draftFor([], { candidates: cands })
    const current = persist(d)
    const r = reviseDraft(current, draftFor(current, { candidates: cands }))
    expect(r.hasChanges).toBe(false)
    expect(r.unchanged).toHaveLength(3)
  })

  it('full cycle: accept, edit, time passes, replan keeps owner changes and only moves suggestions', () => {
    const cands = [
      cand('a', { priority: 1, durationMinutes: 60 }),
      cand('b', { priority: 1, durationMinutes: 60 }),
      cand('c', { durationMinutes: 60 }),
      cand('d', { durationMinutes: 30 }),
    ]
    const first = draftFor([], { candidates: cands })
    const blocks = persist(first)
    // Owner accepts 'a' (09:00–10:00) and moves 'c' to 15:00.
    blocks.find((b) => b.candidateId === 'a')!.state = 'accepted'
    const c = blocks.find((b) => b.candidateId === 'c')!
    Object.assign(c, { start: iso('15:00'), end: iso('16:00'), editedByOwner: true })
    // Later in the day a new urgent task arrives.
    const later = draftFor(blocks, {
      now: at('10:32'),
      candidates: [...cands, cand('urgent', { dueDate: DATE, durationMinutes: 30 })],
    })
    const r = reviseDraft(blocks, later)
    expect(r.kept.map((b) => b.candidateId).sort()).toEqual(['a', 'c'])
    const proposals = [
      ...r.additions,
      ...r.moves.map((m) => m.to),
      ...r.unchanged.map((u) => u.block),
    ]
    for (const p of proposals) {
      expect(Date.parse(p.start!)).toBeGreaterThanOrEqual(at('10:35').getTime())
      for (const k of r.kept) expect(p.start! < k.end! && k.start! < p.end!).toBe(false)
    }
    expect(r.additions.map((x) => x.candidateId)).toEqual(['urgent'])
    expect(r.moves.map((m) => m.candidateId).sort()).toEqual(['b', 'd'])
  })

  it('positions: kept blocks keep theirs, suggestions fill the gaps in order', () => {
    expect(plannerAssignPositions([0, 3], 4)).toEqual([1, 2, 4, 5])
    expect(plannerAssignPositions([], 2)).toEqual([0, 1])
  })
})

describe('owner edits', () => {
  const ctxBlocks = () => [
    block({
      id: 'x',
      candidateId: 'x',
      start: iso('09:00'),
      end: iso('09:30'),
      state: 'accepted',
      position: 0,
    }),
    block({
      id: 'y',
      candidateId: 'y',
      start: iso('09:45'),
      end: iso('10:45'),
      minutes: 60,
      position: 1,
    }),
    block({ id: 'z', candidateId: 'z', start: iso('11:00'), end: iso('11:30'), position: 2 }),
    block({
      id: 'gone',
      candidateId: 'q',
      start: iso('12:00'),
      end: iso('13:00'),
      state: 'dismissed',
      position: 3,
    }),
  ]
  const ctx = (now = at('08:00')) => ({ timezone: TZ, localDate: DATE, now, blocks: ctxBlocks() })

  it('accepts a valid change of time and duration', () => {
    const r = plannerValidateBlockEdit(ctx(), 'z', { startTime: '12:00', minutes: 45 })
    expect(r).toEqual({
      ok: true,
      value: { id: 'z', start: iso('12:00'), end: iso('12:45'), minutes: 45, position: 2 },
    })
  })

  it('rejects overlaps with other blocks (but not dismissed ones) and busy events', () => {
    const r = plannerValidateBlockEdit(ctx(), 'x', { minutes: 60 })
    expect(r).toMatchObject({ ok: false, code: 'overlaps_block' })
    expect(!r.ok && r.message).toBe('Overlaps “Y” (09:45–10:45). Move or dismiss it first.')
    expect(plannerValidateBlockEdit(ctx(), 'z', { startTime: '12:15', minutes: 30 }).ok).toBe(true)
    const withEvent = {
      ...ctx(),
      busy: [{ id: 'e', title: 'Call', start: at('12:00'), end: at('12:30') }],
    }
    expect(
      plannerValidateBlockEdit(withEvent, 'z', { startTime: '12:15', minutes: 30 }),
    ).toMatchObject({
      ok: false,
      code: 'overlaps_event',
    })
  })

  it('rejects moving into the past or outside the day, and bad durations', () => {
    expect(
      plannerValidateBlockEdit(ctx(at('11:10')), 'z', { startTime: '11:05', minutes: 30 }),
    ).toMatchObject({
      ok: false,
      code: 'in_past',
    })
    // Changing only the duration of a block that already started is fine.
    expect(plannerValidateBlockEdit(ctx(at('11:10')), 'z', { minutes: 25 }).ok).toBe(true)
    expect(plannerValidateBlockEdit(ctx(), 'z', { startTime: '23:45', minutes: 30 })).toMatchObject(
      {
        ok: false,
        code: 'outside_day',
      },
    )
    expect(plannerValidateBlockEdit(ctx(), 'z', { minutes: 3 })).toMatchObject({
      ok: false,
      code: 'invalid_range',
    })
    expect(plannerValidateBlockEdit(ctx(), 'gone', { minutes: 30 })).toMatchObject({
      ok: false,
      code: 'not_editable',
    })
    expect(plannerValidateBlockEdit(ctx(), 'nope', { minutes: 30 })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('moves a timed block earlier by swapping slots and keeping the gap', () => {
    const r = plannerValidateMove(ctx(), 'y', 'up')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((u) => [u.id, wall(u.start), wall(u.end)])).toEqual([
      ['y', '09:00', '10:00'],
      ['x', '10:15', '10:45'],
    ])
  })

  it('moves a timed block later, and refuses at the ends or into the past', () => {
    const r = plannerValidateMove(ctx(), 'y', 'down')
    expect(r.ok && r.value.map((u) => [u.id, wall(u.start), wall(u.end)])).toEqual([
      ['z', '09:45', '10:15'],
      ['y', '10:30', '11:30'],
    ])
    expect(plannerValidateMove(ctx(), 'x', 'up')).toMatchObject({ ok: false, code: 'no_neighbour' })
    expect(plannerValidateMove(ctx(), 'z', 'down')).toMatchObject({
      ok: false,
      code: 'no_neighbour',
    })
    expect(plannerValidateMove(ctx(at('09:10')), 'y', 'up')).toMatchObject({
      ok: false,
      code: 'in_past',
    })
  })

  it('swaps list positions in list mode', () => {
    const blocks = [
      block({ id: 'l1', candidateId: 'a', bucket: 'list', position: 0 }),
      block({ id: 'l2', candidateId: 'b', bucket: 'list', position: 1 }),
      block({ id: 'l3', candidateId: 'c', bucket: 'list', position: 2, state: 'dismissed' }),
    ]
    const r = plannerValidateMove(
      { timezone: TZ, localDate: DATE, now: at('08:00'), blocks },
      'l2',
      'up',
    )
    expect(r.ok && r.value.map((u) => [u.id, u.position])).toEqual([
      ['l2', 0],
      ['l1', 1],
    ])
    const edit = plannerValidateBlockEdit(
      { timezone: TZ, localDate: DATE, now: at('08:00'), blocks },
      'l1',
      {
        minutes: 50,
      },
    )
    expect(edit).toEqual({
      ok: true,
      value: { id: 'l1', start: null, end: null, minutes: 50, position: 0 },
    })
    expect(
      plannerValidateBlockEdit({ timezone: TZ, localDate: DATE, now: at('08:00'), blocks }, 'l1', {
        startTime: '10:00',
        minutes: 50,
      }),
    ).toMatchObject({ ok: false, code: 'mixed_modes' })
  })
})

describe('display helpers', () => {
  it('labels split parts across accepted and suggested blocks', () => {
    const blocks = [
      block({ id: 'p2', candidateId: 's', start: iso('11:00'), end: iso('11:30') }),
      block({
        id: 'p1',
        candidateId: 's',
        start: iso('09:00'),
        end: iso('09:30'),
        state: 'accepted',
      }),
      block({
        id: 'px',
        candidateId: 's',
        start: iso('12:00'),
        end: iso('12:30'),
        state: 'dismissed',
      }),
      block({ id: 'solo', candidateId: 't', start: iso('10:00'), end: iso('10:30') }),
    ]
    const labels = plannerSplitLabels(blocks)
    expect(labels.get('p1')).toEqual({ part: 1, total: 2 })
    expect(labels.get('p2')).toEqual({ part: 2, total: 2 })
    expect(labels.has('solo')).toBe(false)
    expect(labels.has('px')).toBe(false)
  })

  it('finds the current or next action, skipping done and elapsed items', () => {
    const blocks = [
      block({ id: 'past', candidateId: 'a', start: iso('08:00'), end: iso('08:30') }),
      block({
        id: 'done',
        candidateId: 'b',
        start: iso('09:00'),
        end: iso('09:30'),
        state: 'done',
      }),
      block({
        id: 'now',
        candidateId: 'c',
        start: iso('09:15'),
        end: iso('10:00'),
        state: 'accepted',
      }),
      block({ id: 'next', candidateId: 'd', start: iso('10:00'), end: iso('10:30') }),
    ]
    expect(plannerNextAction(blocks, at('09:20'))?.id).toBe('now')
    expect(plannerNextAction(blocks, at('10:10'))?.id).toBe('next')
    expect(plannerNextAction(blocks, at('11:00'))).toBeNull()
    const list = [
      block({ id: 'l2', candidateId: 'a', position: 1 }),
      block({ id: 'l1', candidateId: 'b', position: 0, state: 'done' }),
    ]
    expect(plannerNextAction(list, at('11:00'))?.id).toBe('l2')
  })
})
