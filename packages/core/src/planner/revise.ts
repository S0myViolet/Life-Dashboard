/**
 * reviseDraft: compare a persisted plan with a freshly computed draft.
 *
 * The owner's changes are never touched: blocks that are accepted, pinned, done, dismissed or
 * edited by the owner are returned as `kept` and are never moved or removed. Only the planner's
 * own unaccepted suggestions can be moved, removed or added to, and the result is a proposal
 * (the caller decides whether to apply it; "Replan remaining day" applies it).
 */
import { MINUTE_MS, plannerSpansOverlap, type PlannerSpan } from './intervals.ts'
import { plannerFindConflicts } from './plan-day.ts'
import { plannerCandidateKey } from './rank.ts'
import type {
  PlanBlockBucket,
  PlanBlockState,
  PlanConflict,
  PlanDraft,
  PlanDraftBlock,
  PlannerCandidateKind,
  PlannerProtectedBlockInput,
} from './schemas.ts'

/** A persisted plan block, as the planner needs to see it. */
export interface PlanCurrentBlock {
  id: string
  candidateKind: PlannerCandidateKind
  candidateId: string
  title: string
  bucket: PlanBlockBucket
  /** ISO instants; null for list-mode items. */
  start: string | null
  end: string | null
  minutes: number
  state: PlanBlockState
  editedByOwner: boolean
  splitPart: number | null
  splitTotal: number | null
  position: number
  tentative?: boolean
  estimated?: boolean
}

/** Owner-owned: never changed or removed by the planner. */
export function plannerIsPreserved(b: Pick<PlanCurrentBlock, 'state' | 'editedByOwner'>): boolean {
  return b.state !== 'suggested' || b.editedByOwner
}

/** Owner-owned and still occupying time / covering its candidate (i.e. not dismissed). */
export function plannerIsProtected(b: Pick<PlanCurrentBlock, 'state' | 'editedByOwner'>): boolean {
  return plannerIsPreserved(b) && b.state !== 'dismissed'
}

/** The protected blocks of a plan, shaped as planDay input. */
export function plannerProtectedBlocksOf(
  blocks: readonly PlanCurrentBlock[],
): PlannerProtectedBlockInput[] {
  return blocks.filter(plannerIsProtected).map((b) => ({
    id: b.id,
    title: b.title,
    candidateKind: b.candidateKind,
    candidateId: b.candidateId,
    start: b.start,
    end: b.end,
    minutes: b.minutes,
    splitPart: b.splitPart,
    splitTotal: b.splitTotal,
  }))
}

/** Candidate keys the owner dismissed from this plan (they are not suggested again that day). */
export function plannerDismissedKeys(blocks: readonly PlanCurrentBlock[]): Set<string> {
  return new Set(
    blocks
      .filter((b) => b.state === 'dismissed')
      .map((b) => plannerCandidateKey(b.candidateKind, b.candidateId)),
  )
}

export interface PlanRevisionMove {
  blockId: string
  candidateKind: PlannerCandidateKind
  candidateId: string
  title: string
  from: { start: string | null; end: string | null; minutes: number }
  to: PlanDraftBlock
}

export interface PlanRevisionRemoval {
  blockId: string
  candidateKind: PlannerCandidateKind
  candidateId: string
  title: string
  start: string | null
  end: string | null
  minutes: number
}

export type PlanRevisionRejectReason =
  'dismissed_by_owner' | 'overlaps_protected' | 'overlaps_proposal'

export interface PlanRevision {
  /** Owner-owned blocks (accepted, pinned, done, dismissed, edited): unchanged by definition. */
  kept: PlanCurrentBlock[]
  /** Unaccepted suggestions whose slot is unchanged (details such as the title may refresh). */
  unchanged: Array<{ blockId: string; block: PlanDraftBlock }>
  moves: PlanRevisionMove[]
  additions: PlanDraftBlock[]
  removals: PlanRevisionRemoval[]
  /** Draft blocks that were not proposed because they would override an owner decision. */
  rejected: Array<{ block: PlanDraftBlock; reason: PlanRevisionRejectReason }>
  conflicts: PlanConflict[]
  hasChanges: boolean
}

function spanOf(b: { start: string | null; end: string | null }): PlannerSpan | null {
  if (!b.start || !b.end) return null
  return { start: Date.parse(b.start), end: Date.parse(b.end) }
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function reviseDraft(
  currentPlan: readonly PlanCurrentBlock[],
  newDraft: PlanDraft,
): PlanRevision {
  const kept = currentPlan.filter(plannerIsPreserved)
  const open = currentPlan.filter((b) => !plannerIsPreserved(b))
  const keptSpans = kept
    .filter((b) => b.state !== 'dismissed')
    .map(spanOf)
    .filter((s): s is PlannerSpan => s !== null && s.end > s.start)
  const dismissed = plannerDismissedKeys(currentPlan)

  const proposals = [...newDraft.scheduled, ...newDraft.smallTasks, ...newDraft.list]
  const rejected: PlanRevision['rejected'] = []
  const accepted: PlanDraftBlock[] = []
  const acceptedSpans: PlannerSpan[] = []
  for (const p of proposals) {
    if (dismissed.has(plannerCandidateKey(p.candidateKind, p.candidateId))) {
      rejected.push({ block: p, reason: 'dismissed_by_owner' })
      continue
    }
    const s = spanOf(p)
    if (s && keptSpans.some((k) => plannerSpansOverlap(k, s))) {
      rejected.push({ block: p, reason: 'overlaps_protected' })
      continue
    }
    if (s && acceptedSpans.some((k) => plannerSpansOverlap(k, s))) {
      rejected.push({ block: p, reason: 'overlaps_proposal' })
      continue
    }
    accepted.push(p)
    if (s) acceptedSpans.push(s)
  }

  const groupCurrent = new Map<string, PlanCurrentBlock[]>()
  for (const b of open) {
    const k = plannerCandidateKey(b.candidateKind, b.candidateId)
    groupCurrent.set(k, [...(groupCurrent.get(k) ?? []), b])
  }
  const groupNew = new Map<string, PlanDraftBlock[]>()
  for (const p of accepted) {
    const k = plannerCandidateKey(p.candidateKind, p.candidateId)
    groupNew.set(k, [...(groupNew.get(k) ?? []), p])
  }

  const unchanged: PlanRevision['unchanged'] = []
  const moves: PlanRevisionMove[] = []
  const additions: PlanDraftBlock[] = []
  const removals: PlanRevisionRemoval[] = []

  const keys = [...new Set([...groupCurrent.keys(), ...groupNew.keys()])].sort(cmpStr)
  for (const key of keys) {
    const cur = [...(groupCurrent.get(key) ?? [])].sort(
      (a, b) =>
        cmpStr(a.start ?? '', b.start ?? '') || a.position - b.position || cmpStr(a.id, b.id),
    )
    const next = [...(groupNew.get(key) ?? [])].sort(
      (a, b) => cmpStr(a.start ?? '', b.start ?? '') || (a.splitPart ?? 0) - (b.splitPart ?? 0),
    )
    const n = Math.min(cur.length, next.length)
    for (let i = 0; i < n; i++) {
      const c = cur[i]!
      const p = next[i]!
      const same =
        c.start === p.start && c.end === p.end && c.minutes === p.minutes && c.bucket === p.bucket
      if (same) unchanged.push({ blockId: c.id, block: p })
      else {
        moves.push({
          blockId: c.id,
          candidateKind: c.candidateKind,
          candidateId: c.candidateId,
          title: c.title,
          from: { start: c.start, end: c.end, minutes: c.minutes },
          to: p,
        })
      }
    }
    for (const c of cur.slice(n)) {
      removals.push({
        blockId: c.id,
        candidateKind: c.candidateKind,
        candidateId: c.candidateId,
        title: c.title,
        start: c.start,
        end: c.end,
        minutes: c.minutes,
      })
    }
    additions.push(...next.slice(n))
  }

  // Conflicts: the draft's (protected vs busy events) plus protected vs protected, recomputed
  // from the plan itself so the result is right even for a draft built from stale blocks.
  const own = plannerFindConflicts(
    kept
      .filter((b) => b.state !== 'dismissed' && b.start && b.end)
      .map((b) => ({ id: b.id, title: b.title, start: new Date(b.start!), end: new Date(b.end!) })),
    [],
    newDraft.timezone,
  )
  const conflicts: PlanConflict[] = []
  const seen = new Set<string>()
  for (const c of [...newDraft.conflicts, ...own]) {
    const k = `${c.kind}|${[c.blockId, c.withId].sort().join('|')}`
    if (seen.has(k)) continue
    seen.add(k)
    conflicts.push(c)
  }

  return {
    kept,
    unchanged,
    moves,
    additions,
    removals,
    rejected,
    conflicts,
    hasChanges: moves.length + additions.length + removals.length > 0,
  }
}

/**
 * Positions for the suggestions that remain after a revision. Owner-kept blocks keep their
 * positions; the remaining suggestions fill the unused positions in draft order, so an owner's
 * manual ordering survives a replan.
 */
export function plannerAssignPositions(keptPositions: readonly number[], count: number): number[] {
  const used = new Set(keptPositions)
  const out: number[] = []
  let p = 0
  while (out.length < count) {
    if (!used.has(p)) out.push(p)
    p++
  }
  return out
}

/** Minutes between two ISO instants. */
export function plannerMinutesBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / MINUTE_MS)
}
