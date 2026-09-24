/**
 * Deterministic ranking of plan candidates.
 *
 * Tiers (lower is more important), per the planner spec:
 *   0 overdue (dueAt before now / dueDate before the planned day)
 *   1 explicit deadline on the planned day (timed before untimed)
 *   2 owner priority 1
 *   3 accepted (confirmed) project action
 *   4 due within `dueSoonDays` after the planned day
 *   5 owner priority 2
 *   6 everything else ("low pressure")
 * Ties: earlier deadline, then higher owner priority, then older createdAt, then kind and id,
 * so the order is total and independent of input order.
 */
import { addLocalDays, localDateInZone, localDaysBetween, zonedLocalToUtc } from '../time/index.ts'
import { plannerRelativeDayLabel, plannerTimeLabel } from './format.ts'
import {
  PLANNER_CANDIDATE_KINDS,
  PLANNER_PRIORITY_KINDS,
  type PlannerCandidate,
  type PlannerPriorityReasonCode,
} from './schemas.ts'

export interface PlannerRankContext {
  nowMs: number
  timezone: string
  /** The planned local date. */
  localDate: string
  /** The owner's actual local date at `now`. */
  today: string
  dayStartMs: number
  dueSoonDays: number
}

export interface PlannerAssessment {
  candidate: PlannerCandidate
  key: string
  tier: number
  /** Deadline pressure or an owner priority/agreement: tiers 0–5. */
  pressure: boolean
  timedDue: boolean
  dueKey: number | null
  reasonCode: PlannerPriorityReasonCode | null
  reason: string | null
  eligibleForPriority: boolean
}

export const PLANNER_LOW_PRESSURE_TIER = 6

export function plannerCandidateKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

function endOfLocalDateMs(localDate: string, tz: string): number {
  return zonedLocalToUtc(addLocalDays(localDate, 1), '00:00', tz).getTime()
}

export function plannerAssessCandidate(
  c: PlannerCandidate,
  ctx: PlannerRankContext,
): PlannerAssessment {
  const tz = ctx.timezone
  const ref = Math.max(ctx.nowMs, ctx.dayStartMs)
  type Hit = { tier: number; code: PlannerPriorityReasonCode; reason: string }
  const hits: Hit[] = []
  let dueKey: number | null = null
  let timedDue = false

  if (c.dueAt) {
    const dueMs = c.dueAt.getTime()
    const dueLocal = localDateInZone(dueMs, tz)
    const time = plannerTimeLabel(dueMs, tz)
    dueKey = dueMs
    timedDue = true
    if (dueMs < ref) {
      const reason =
        dueMs < ctx.nowMs
          ? dueLocal === ctx.today
            ? `Overdue since ${time}`
            : `Overdue since ${plannerRelativeDayLabel(dueLocal, ctx.today)}`
          : `Due ${plannerRelativeDayLabel(dueLocal, ctx.today)} ${time}`
      hits.push({ tier: 0, code: 'overdue', reason })
    } else if (dueLocal === ctx.localDate) {
      hits.push({
        tier: 1,
        code: 'due_today_timed',
        reason: `Due ${plannerRelativeDayLabel(dueLocal, ctx.today)} ${time}`,
      })
    } else if (localDaysBetween(ctx.localDate, dueLocal) <= ctx.dueSoonDays) {
      hits.push({
        tier: 4,
        code: 'due_soon',
        reason: `Due ${plannerRelativeDayLabel(dueLocal, ctx.today)} ${time}`,
      })
    }
  } else if (c.dueDate) {
    dueKey = endOfLocalDateMs(c.dueDate, tz)
    const days = localDaysBetween(ctx.localDate, c.dueDate)
    if (days < 0) {
      const reason =
        c.dueDate < ctx.today
          ? `Overdue since ${plannerRelativeDayLabel(c.dueDate, ctx.today)}`
          : `Due ${plannerRelativeDayLabel(c.dueDate, ctx.today)}`
      hits.push({ tier: 0, code: 'overdue', reason })
    } else if (days === 0) {
      hits.push({
        tier: 1,
        code: 'due_today',
        reason: `Due ${plannerRelativeDayLabel(c.dueDate, ctx.today)}`,
      })
    } else if (days <= ctx.dueSoonDays) {
      hits.push({
        tier: 4,
        code: 'due_soon',
        reason: `Due ${plannerRelativeDayLabel(c.dueDate, ctx.today)}`,
      })
    }
  }

  if (c.priority === 1)
    hits.push({ tier: 2, code: 'high_priority', reason: 'Marked high priority' })
  if (c.kind === 'project_action' && c.confirmed) {
    hits.push({ tier: 3, code: 'project_action', reason: 'Agreed project action' })
  }
  if (c.priority === 2) hits.push({ tier: 5, code: 'priority_2', reason: 'Marked priority 2' })

  hits.sort((a, b) => a.tier - b.tier)
  const best = hits[0]
  const tier = best ? best.tier : PLANNER_LOW_PRESSURE_TIER
  return {
    candidate: c,
    key: plannerCandidateKey(c.kind, c.id),
    tier,
    pressure: tier < PLANNER_LOW_PRESSURE_TIER,
    timedDue,
    dueKey,
    reasonCode: best?.code ?? null,
    reason: best?.reason ?? null,
    eligibleForPriority:
      c.confirmed && PLANNER_PRIORITY_KINDS.includes(c.kind) && tier < PLANNER_LOW_PRESSURE_TIER,
  }
}

const KIND_ORDER = new Map(PLANNER_CANDIDATE_KINDS.map((k, i) => [k, i]))

export function plannerCompareAssessments(a: PlannerAssessment, b: PlannerAssessment): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if (a.tier === 1 && a.timedDue !== b.timedDue) return a.timedDue ? -1 : 1
  const ad = a.dueKey ?? Number.POSITIVE_INFINITY
  const bd = b.dueKey ?? Number.POSITIVE_INFINITY
  if (ad !== bd) return ad < bd ? -1 : 1
  const ap = a.candidate.priority ?? 5
  const bp = b.candidate.priority ?? 5
  if (ap !== bp) return ap - bp
  const ac = a.candidate.createdAt.getTime()
  const bc = b.candidate.createdAt.getTime()
  if (ac !== bc) return ac - bc
  const ak = KIND_ORDER.get(a.candidate.kind) ?? 99
  const bk = KIND_ORDER.get(b.candidate.kind) ?? 99
  if (ak !== bk) return ak - bk
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0
}

/** Assess and sort. Duplicate (kind, id) pairs keep only their first occurrence in rank order. */
export function plannerRankCandidates(
  candidates: readonly PlannerCandidate[],
  ctx: PlannerRankContext,
): PlannerAssessment[] {
  const ranked = candidates
    .map((c) => plannerAssessCandidate(c, ctx))
    .sort(plannerCompareAssessments)
  const seen = new Set<string>()
  return ranked.filter((a) => {
    if (seen.has(a.key)) return false
    seen.add(a.key)
    return true
  })
}

/** Up to `max` priorities: confirmed, priority-eligible kinds with deadline/owner pressure. */
export function plannerSelectPriorities(
  ranked: readonly PlannerAssessment[],
  max: number,
): PlannerAssessment[] {
  return ranked.filter((a) => a.eligibleForPriority).slice(0, Math.max(0, Math.min(3, max)))
}
