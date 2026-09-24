/**
 * planDay: the deterministic daily planner.
 *
 * Time mode (availability given):
 *   free   = windows − busy events − protected blocks − the past (now rounded up to the grid)
 *   budget = floor(free × (1 − bufferRatio))          (≈20% stays unallocated)
 *   passes, each in rank order, each placement consuming budget:
 *     1. priorities (≤ 3)                         earliest slot that fits (split if allowed)
 *     2. other confirmed items                    earliest slot that fits (split if allowed)
 *     3. small low-pressure confirmed items       best-fitting short gap   → smallTasks
 *     4. tentative (unconfirmed) items            earliest slot that fits
 *     5. small low-pressure tentative items       best-fitting short gap   → smallTasks
 *   Items that cannot be placed go to doesNotFit (with the reason) or, when they have no
 *   deadline pressure and no owner priority, to canWait.
 * List mode (no availability): the same ranking as an ordered list with effort; no times.
 *
 * Splitting: a splittable item is placed whole in the earliest gap that fits; only if no gap
 * fits it whole is it split across the earliest gaps into parts of at least minBlockMinutes.
 * Placement is all-or-nothing: an item is never partially scheduled.
 */
import { addLocalDays, localDateInZone, zonedLocalToUtc } from '../time/index.ts'
import { plannerTimeLabel } from './format.ts'
import {
  MINUTE_MS,
  plannerAlignUp,
  plannerMergeSpans,
  plannerSpanMinutes,
  plannerSpansOverlap,
  plannerSubtractSpans,
  type PlannerSpan,
} from './intervals.ts'
import {
  plannerCandidateKey,
  plannerRankCandidates,
  plannerSelectPriorities,
  type PlannerAssessment,
  type PlannerRankContext,
} from './rank.ts'
import {
  PLANNER_DEFAULT_OPTIONS,
  PlannerInputSchema,
  type PlanAlreadyPlannedItem,
  type PlanBlockBucket,
  type PlanConflict,
  type PlanDraft,
  type PlanDraftBlock,
  type PlannerBusyEvent,
  type PlannerInput,
  type PlannerOptions,
  type PlannerParsedInput,
  type PlannerProtectedBlock,
  type PlannerUnplacedReasonCode,
  type PlanNote,
  type PlanPriority,
  type PlanUnplacedItem,
} from './schemas.ts'

interface WorkItem {
  a: PlannerAssessment
  minutes: number
  estimated: boolean
  /** Parts already covered by protected blocks (continuations of a split task). */
  splitOffset: number
  /** Position in the overall order: confirmed items in rank order, then tentative ones. */
  seq: number
}

type FitReason = Exclude<PlannerUnplacedReasonCode, 'low_pressure'>

const FIT_REASON_TEXT: Record<FitReason, string> = {
  not_enough_time: 'Not enough free time today',
  no_gap_long_enough: 'No single gap long enough',
  after_last_window: "After the day's last window",
}

const LOW_PRESSURE_TEXT = 'No deadline soon and not marked high priority'

/** Whether a calendar event blocks time: timed events default to busy, all-day to free. */
export function plannerEventBlocksTime(e: Pick<PlannerBusyEvent, 'allDay' | 'busy'>): boolean {
  return e.busy ?? !e.allDay
}

function toSpan(start: Date, end: Date): PlannerSpan {
  return { start: start.getTime(), end: end.getTime() }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Local windows on `localDate` as instants (DST-aware; '24:00' = start of the next day). */
export function plannerWindowSpans(
  localDate: string,
  windows: readonly { start: string; end: string }[],
  timezone: string,
): PlannerSpan[] {
  const nextDayStart = zonedLocalToUtc(addLocalDays(localDate, 1), '00:00', timezone).getTime()
  return plannerMergeSpans(
    windows.map((w) => ({
      start: zonedLocalToUtc(localDate, w.start, timezone).getTime(),
      end: w.end === '24:00' ? nextDayStart : zonedLocalToUtc(localDate, w.end, timezone).getTime(),
    })),
  )
}

/**
 * Conflicts between the owner's protected blocks and busy events, and between protected
 * blocks themselves. Never resolved automatically: they are reported for the owner.
 */
export function plannerFindConflicts(
  protectedBlocks: readonly Pick<PlannerProtectedBlock, 'id' | 'title' | 'start' | 'end'>[],
  busy: readonly PlannerBusyEvent[],
  timezone: string,
): PlanConflict[] {
  const timed = protectedBlocks
    .filter((b): b is typeof b & { start: Date; end: Date } => !!b.start && !!b.end)
    .map((b) => ({ b, span: toSpan(b.start, b.end) }))
    .filter((x) => x.span.end > x.span.start)
    .sort((x, y) => x.span.start - y.span.start || (x.b.id < y.b.id ? -1 : 1))
  const events = busy
    .filter(plannerEventBlocksTime)
    .map((e) => ({ e, span: toSpan(e.start, e.end) }))
    .filter((x) => x.span.end > x.span.start)
    .sort((x, y) => x.span.start - y.span.start || (x.e.id < y.e.id ? -1 : 1))
  const out: PlanConflict[] = []
  const range = (s: number, e: number) =>
    `${plannerTimeLabel(s, timezone)}–${plannerTimeLabel(e, timezone)}`
  for (const { b, span } of timed) {
    for (const { e, span: es } of events) {
      if (!plannerSpansOverlap(span, es)) continue
      const s = Math.max(span.start, es.start)
      const en = Math.min(span.end, es.end)
      out.push({
        kind: 'event',
        blockId: b.id,
        blockTitle: b.title ?? null,
        withId: e.id,
        withTitle: e.title ?? null,
        overlapStart: iso(s),
        overlapEnd: iso(en),
        message: `Overlaps ${e.title ? `“${e.title}”` : 'a busy calendar event'} (${range(s, en)})`,
      })
    }
  }
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const x = timed[i]!
      const y = timed[j]!
      if (!plannerSpansOverlap(x.span, y.span)) continue
      const s = Math.max(x.span.start, y.span.start)
      const en = Math.min(x.span.end, y.span.end)
      out.push({
        kind: 'block',
        blockId: x.b.id,
        blockTitle: x.b.title ?? null,
        withId: y.b.id,
        withTitle: y.b.title ?? null,
        overlapStart: iso(s),
        overlapEnd: iso(en),
        message: `Overlaps ${y.b.title ? `“${y.b.title}”` : 'another planned block'} (${range(s, en)})`,
      })
    }
  }
  return out
}

function calendarNote(status: PlannerParsedInput['calendarStatus']): PlanNote | null {
  switch (status) {
    case 'not_connected':
      return {
        code: 'calendars_not_connected',
        message: 'Calendars are not connected, so busy calendar events are not taken into account.',
      }
    case 'partial':
      return {
        code: 'calendars_partial',
        message: 'Some calendars could not be read, so busy time may be missing.',
      }
    case 'unavailable':
      return {
        code: 'calendars_unavailable',
        message: 'Calendar busy time is unavailable right now, so the plan may overlap events.',
      }
    default:
      return null
  }
}

const LIST_MODE_NOTES: Record<'not_set' | 'none_for_weekday' | 'invalid', PlanNote> = {
  not_set: {
    code: 'list_mode_not_set',
    message:
      'Available hours are not set, so this is an ordered list with effort estimates and no times.',
  },
  none_for_weekday: {
    code: 'list_mode_none_for_weekday',
    message:
      'No available hours are set for this weekday, so this is an ordered list with effort estimates and no times.',
  },
  invalid: {
    code: 'list_mode_invalid',
    message:
      'Saved available hours could not be read, so this is an ordered list with effort estimates and no times.',
  },
}

export function planDay(rawInput: PlannerInput): PlanDraft {
  const input = PlannerInputSchema.parse(rawInput)
  const opts: PlannerOptions = { ...PLANNER_DEFAULT_OPTIONS, ...input.options }
  const tz = input.timezone
  const nowMs = input.now.getTime()
  const localDate = input.localDate
  const today = localDateInZone(nowMs, tz)
  const dayStartMs = zonedLocalToUtc(localDate, '00:00', tz).getTime()
  const gMs = opts.slotGranularityMinutes * MINUTE_MS

  const ctx: PlannerRankContext = {
    nowMs,
    timezone: tz,
    localDate,
    today,
    dayStartMs,
    dueSoonDays: opts.dueSoonDays,
  }
  const ranked = plannerRankCandidates(input.candidates, ctx)
  const priorityList = plannerSelectPriorities(ranked, opts.maxPriorities)
  const priorityRank = new Map(priorityList.map((a, i) => [a.key, i + 1]))
  const priorities: PlanPriority[] = priorityList.map((a, i) => ({
    rank: i + 1,
    candidateKind: a.candidate.kind,
    candidateId: a.candidate.id,
    title: a.candidate.title,
    reasonCode: a.reasonCode!,
    reason: a.reason!,
  }))

  // --- Coverage by the owner's protected blocks ------------------------------------------
  const protectedByKey = new Map<string, PlannerProtectedBlock[]>()
  for (const b of input.protectedBlocks) {
    if (!b.candidateKind || !b.candidateId) continue
    const key = plannerCandidateKey(b.candidateKind, b.candidateId)
    const list = protectedByKey.get(key) ?? []
    list.push(b)
    protectedByKey.set(key, list)
  }

  const alreadyPlanned: PlanAlreadyPlannedItem[] = []
  const confirmedWork: WorkItem[] = []
  const tentativeWork: WorkItem[] = []
  for (const a of ranked) {
    const c = a.candidate
    const baseMinutes = c.durationMinutes ?? opts.defaultEstimateMinutes
    const estimated = c.durationMinutes == null
    const covering = protectedByKey.get(a.key) ?? []
    let minutes = baseMinutes
    let splitOffset = 0
    if (covering.length > 0) {
      const covered = covering.reduce((sum, b) => sum + b.minutes, 0)
      const wholeBlock = covering.some((b) => (b.splitTotal ?? 1) <= 1)
      const remaining = baseMinutes - covered
      if (!c.splittable || wholeBlock || remaining < opts.minBlockMinutes) {
        alreadyPlanned.push({
          candidateKind: c.kind,
          candidateId: c.id,
          title: c.title,
          plannedMinutes: covered,
          priorityRank: priorityRank.get(a.key) ?? null,
        })
        continue
      }
      minutes = remaining
      splitOffset = covering.reduce((m, b) => Math.max(m, b.splitPart ?? 0), 0)
    }
    const item: WorkItem = { a, minutes, estimated, splitOffset, seq: 0 }
    if (c.confirmed) confirmedWork.push(item)
    else tentativeWork.push(item)
  }
  const allWork = [...confirmedWork, ...tentativeWork]
  allWork.forEach((w, i) => (w.seq = i))
  const demandMinutes = allWork.reduce((s, w) => s + w.minutes, 0)

  const conflicts = plannerFindConflicts(input.protectedBlocks, input.busy, tz)
  const notes: PlanNote[] = []
  const calNote = calendarNote(input.calendarStatus)

  const makeBlock = (
    w: WorkItem,
    bucket: PlanBlockBucket,
    span: PlannerSpan | null,
    part: { index: number; count: number } | null,
    note: string | null,
  ): PlanDraftBlock => {
    const c = w.a.candidate
    const splitTotal =
      part && (part.count > 1 || w.splitOffset > 0) ? w.splitOffset + part.count : null
    return {
      candidateKind: c.kind,
      candidateId: c.id,
      title: c.title,
      bucket,
      start: span ? iso(span.start) : null,
      end: span ? iso(span.end) : null,
      minutes: span ? Math.round((span.end - span.start) / MINUTE_MS) : w.minutes,
      estimated: w.estimated,
      tentative: !c.confirmed,
      splitPart: splitTotal != null && part ? w.splitOffset + part.index + 1 : null,
      splitTotal,
      priorityRank: priorityRank.get(w.a.key) ?? null,
      note,
    }
  }

  // --- List mode --------------------------------------------------------------------------
  if (!input.availability || input.availability.length === 0) {
    const reason = input.listModeReason ?? (input.availability ? 'none_for_weekday' : 'not_set')
    notes.push(LIST_MODE_NOTES[reason])
    if (calNote) notes.push(calNote)
    if (allWork.length === 0 && alreadyPlanned.length === 0) {
      notes.push({
        code: 'nothing_to_plan',
        message: 'Nothing to plan: no open tasks, due habits or reading goals.',
      })
    }
    const list = allWork.map((w) => makeBlock(w, 'list', null, null, null))
    return {
      version: 1,
      localDate,
      timezone: tz,
      generatedAt: iso(nowMs),
      mode: 'list',
      priorities,
      scheduled: [],
      smallTasks: [],
      list,
      canWait: [],
      doesNotFit: [],
      alreadyPlanned,
      conflicts,
      capacity: {
        known: false,
        freeMinutes: null,
        bufferMinutes: null,
        budgetMinutes: null,
        allocatedMinutes: 0,
        overflowMinutes: null,
        demandMinutes,
      },
      notes,
    }
  }

  // --- Time mode --------------------------------------------------------------------------
  const windows = plannerWindowSpans(localDate, input.availability, tz)
  const nowRounded = plannerAlignUp(nowMs, gMs)
  const lastWindowEnd = windows.reduce((m, w) => Math.max(m, w.end), Number.NEGATIVE_INFINITY)
  const dayOver = windows.length === 0 || nowRounded >= lastWindowEnd

  const blocked: PlannerSpan[] = [{ start: Number.MIN_SAFE_INTEGER, end: nowRounded }]
  for (const e of input.busy) if (plannerEventBlocksTime(e)) blocked.push(toSpan(e.start, e.end))
  for (const b of input.protectedBlocks) if (b.start && b.end) blocked.push(toSpan(b.start, b.end))

  let free = plannerSubtractSpans(windows, blocked)
  const freeMinutes = plannerSpanMinutes(free)
  const budgetMinutes = Math.max(0, Math.floor(freeMinutes * (1 - opts.bufferRatio) + 1e-9))
  let remainingBudget = budgetMinutes

  const scheduled: PlanDraftBlock[] = []
  const smallTasks: PlanDraftBlock[] = []
  const failed: Array<{ w: WorkItem; fit: FitReason }> = []

  const earliestFit = (minutes: number): PlannerSpan | null => {
    const len = minutes * MINUTE_MS
    for (const f of free) {
      const s = plannerAlignUp(f.start, gMs)
      if (s + len <= f.end) return { start: s, end: s + len }
    }
    return null
  }

  const bestFit = (minutes: number): PlannerSpan | null => {
    const len = minutes * MINUTE_MS
    let best: PlannerSpan | null = null
    let bestRoom = Number.POSITIVE_INFINITY
    for (const f of free) {
      const s = plannerAlignUp(f.start, gMs)
      if (s + len > f.end) continue
      const room = f.end - s
      if (room < bestRoom) {
        best = { start: s, end: s + len }
        bestRoom = room
      }
    }
    return best
  }

  const splitFit = (minutes: number): PlannerSpan[] | null => {
    const gMin = opts.slotGranularityMinutes
    const minBlock = opts.minBlockMinutes
    const parts: PlannerSpan[] = []
    let remaining = minutes
    for (const f of free) {
      if (remaining <= 0) break
      const s = plannerAlignUp(f.start, gMs)
      const avail = Math.floor((f.end - s) / MINUTE_MS)
      if (avail < minBlock) continue
      let take = Math.min(avail, remaining)
      if (take < remaining) {
        take = Math.floor(take / gMin) * gMin
        if (remaining - take < minBlock) take = remaining - minBlock
        if (take < minBlock) continue
      }
      parts.push({ start: s, end: s + take * MINUTE_MS })
      remaining -= take
    }
    return remaining === 0 && parts.length > 1 ? parts : null
  }

  const fitFailure = (minutes: number): FitReason => {
    if (dayOver) return 'after_last_window'
    if (minutes > remainingBudget) return 'not_enough_time'
    return 'no_gap_long_enough'
  }

  const deadlineNote = (w: WorkItem, lastEnd: number): string | null => {
    const due = w.a.candidate.dueAt
    if (!due || w.a.tier === 0) return null
    const dueMs = due.getTime()
    if (localDateInZone(dueMs, tz) !== localDate) return null
    return lastEnd > dueMs ? `Ends after its ${plannerTimeLabel(dueMs, tz)} deadline` : null
  }

  const place = (w: WorkItem, mode: 'earliest' | 'best', bucket: PlanBlockBucket): void => {
    if (w.minutes > remainingBudget || dayOver) {
      failed.push({ w, fit: fitFailure(w.minutes) })
      return
    }
    let parts: PlannerSpan[] | null = null
    const whole = mode === 'best' ? bestFit(w.minutes) : earliestFit(w.minutes)
    if (whole) parts = [whole]
    else if (w.a.candidate.splittable && mode === 'earliest') parts = splitFit(w.minutes)
    if (!parts) {
      failed.push({ w, fit: fitFailure(w.minutes) })
      return
    }
    free = plannerSubtractSpans(free, parts)
    remainingBudget -= w.minutes
    const lastEnd = parts[parts.length - 1]!.end
    const note = deadlineNote(w, lastEnd)
    const target = bucket === 'small' ? smallTasks : scheduled
    parts.forEach((span, index) =>
      target.push(
        makeBlock(
          w,
          bucket,
          span,
          { index, count: parts.length },
          index === parts.length - 1 ? note : null,
        ),
      ),
    )
  }

  const isSmallLow = (w: WorkItem) =>
    w.minutes <= opts.smallTaskMaxMinutes && !w.a.pressure && !priorityRank.has(w.a.key)

  const prioritySet = new Set(priorityRank.keys())
  const confirmedPriorities = confirmedWork
    .filter((w) => prioritySet.has(w.a.key))
    .sort((x, y) => priorityRank.get(x.a.key)! - priorityRank.get(y.a.key)!)
  for (const w of confirmedPriorities) place(w, 'earliest', 'scheduled')
  for (const w of confirmedWork) {
    if (!prioritySet.has(w.a.key) && !isSmallLow(w)) place(w, 'earliest', 'scheduled')
  }
  for (const w of confirmedWork) if (isSmallLow(w)) place(w, 'best', 'small')
  for (const w of tentativeWork) if (!isSmallLow(w)) place(w, 'earliest', 'scheduled')
  for (const w of tentativeWork) if (isSmallLow(w)) place(w, 'best', 'small')

  const toUnplaced = (w: WorkItem, fit: FitReason): PlanUnplacedItem => {
    const c = w.a.candidate
    const low = !w.a.pressure && !priorityRank.has(w.a.key)
    return {
      candidateKind: c.kind,
      candidateId: c.id,
      title: c.title,
      minutes: w.minutes,
      estimated: w.estimated,
      tentative: !c.confirmed,
      splittable: c.splittable,
      priorityRank: priorityRank.get(w.a.key) ?? null,
      reasonCode: low ? 'low_pressure' : fit,
      reason: low ? LOW_PRESSURE_TEXT : FIT_REASON_TEXT[fit],
      fitReasonCode: low ? fit : null,
    }
  }
  failed.sort((x, y) => x.w.seq - y.w.seq)
  const canWait: PlanUnplacedItem[] = []
  const doesNotFit: PlanUnplacedItem[] = []
  for (const { w, fit } of failed) {
    const item = toUnplaced(w, fit)
    if (item.reasonCode === 'low_pressure') canWait.push(item)
    else doesNotFit.push(item)
  }

  const byStart = (a: PlanDraftBlock, b: PlanDraftBlock) =>
    a.start! < b.start! ? -1 : a.start! > b.start! ? 1 : 0
  scheduled.sort(byStart)
  smallTasks.sort(byStart)

  const allocatedMinutes = [...scheduled, ...smallTasks].reduce((s, b) => s + b.minutes, 0)
  const overflowMinutes = failed.reduce((s, f) => s + f.w.minutes, 0)

  if (calNote) notes.push(calNote)
  if (dayOver) {
    notes.push({
      code: 'day_over',
      message:
        localDate === today
          ? "Today's available hours are over, so nothing new can be scheduled."
          : 'No available time is left on this day.',
    })
  }
  if (allWork.length === 0 && alreadyPlanned.length === 0) {
    notes.push({
      code: 'nothing_to_plan',
      message: 'Nothing to plan: no open tasks, due habits or reading goals.',
    })
  }

  return {
    version: 1,
    localDate,
    timezone: tz,
    generatedAt: iso(nowMs),
    mode: 'time',
    priorities,
    scheduled,
    smallTasks,
    list: [],
    canWait,
    doesNotFit,
    alreadyPlanned,
    conflicts,
    capacity: {
      known: true,
      freeMinutes,
      bufferMinutes: freeMinutes - budgetMinutes,
      budgetMinutes,
      allocatedMinutes,
      overflowMinutes,
      demandMinutes,
    },
    notes,
  }
}
