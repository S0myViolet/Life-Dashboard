/**
 * Pure view models for the Plan pages and the Home "Your plan for today" card.
 * No I/O: the loaders in ./server.ts fetch rows and pass them here, so this is unit-tested.
 */
import {
  addLocalDays,
  isoWeekday,
  localTimeInZone,
  plannerDurationLabel,
  plannerIsPreserved,
  plannerNextAction,
  plannerSplitLabels,
  type PlanBlockState,
  type PlanCapacity,
  type PlanConflict,
  type PlanDraft,
  type PlanNote,
  type PlannerCandidateKind,
  type PlanRevision,
  type PlanUnplacedItem,
} from '@personal-home/core'
import type { PlanBlockRow, PlannerPlan, PlannerWeekDay } from '@personal-home/db'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** "Thursday 24 September". */
export function planLongDateLabel(localDate: string): string {
  const [, m, d] = localDate.split('-').map(Number) as [number, number, number]
  return `${WEEKDAYS[isoWeekday(localDate) - 1]} ${d} ${MONTHS[m - 1]}`
}

/** "Thu 24". */
export function planShortDateLabel(localDate: string): string {
  const d = Number(localDate.slice(8, 10))
  return `${WEEKDAYS[isoWeekday(localDate) - 1]!.slice(0, 3)} ${d}`
}

/** Monday of the ISO week containing `localDate`. */
export function planWeekStart(localDate: string): string {
  return addLocalDays(localDate, 1 - isoWeekday(localDate))
}

export const PLAN_KIND_LABELS: Record<PlannerCandidateKind, string> = {
  task: 'Task',
  project_action: 'Project action',
  email_deadline: 'Email deadline',
  habit: 'Habit',
  reading_goal: 'Reading',
}

export interface PlanBusyEventView {
  id: string
  title: string
  /** Calendar/account label, e.g. "Work (Google)". */
  source: string
  url: string | null
  start: Date
  end: Date
}

export interface PlanBlockView {
  id: string
  title: string
  kind: PlannerCandidateKind
  kindLabel: string
  state: PlanBlockState
  bucket: PlanBlockRow['bucket']
  timeLabel: string | null
  /** ISO start instant (null for list items). */
  startIso: string | null
  /** 'HH:MM' for the edit form. */
  startTime: string | null
  minutes: number
  durationLabel: string
  estimated: boolean
  tentative: boolean
  splitLabel: string | null
  priorityRank: number | null
  note: string | null
  editedByOwner: boolean
  /** Owner-owned: a replan never changes it. */
  preserved: boolean
  /** The slot is over (end ≤ now). */
  isPast: boolean
  /** now is inside the slot. */
  isNow: boolean
  /** The underlying task was completed or cancelled elsewhere. */
  sourceStatus: 'done' | 'cancelled' | null
  can: {
    accept: boolean
    pin: boolean
    unpin: boolean
    dismiss: boolean
    restore: boolean
    done: boolean
    edit: boolean
    moveUp: boolean
    moveDown: boolean
  }
}

export type PlanTimelineEntry =
  | { type: 'block'; start: number; block: PlanBlockView }
  | { type: 'event'; start: number; event: PlanBusyEventView & { timeLabel: string } }

export interface PlanPriorityView {
  rank: number
  title: string
  reason: string
  /** State of this priority's block(s) in the plan, when it has one. */
  state: PlanBlockState | 'not_scheduled' | 'does_not_fit'
  timeLabel: string | null
}

export interface PlanDayView {
  localDate: string
  dateLabel: string
  timezone: string
  relative: 'past' | 'today' | 'tomorrow' | 'future'
  /** Plans are drafted for today and tomorrow only. */
  canPlan: boolean
  readOnly: boolean
  prevDate: string
  nextDate: string
  exists: boolean
  mode: 'time' | 'list' | null
  generatedLabel: string | null
  priorities: PlanPriorityView[]
  timeline: PlanTimelineEntry[]
  smallTasks: PlanBlockView[]
  list: PlanBlockView[]
  dismissed: PlanBlockView[]
  canWait: PlanUnplacedItem[]
  doesNotFit: PlanUnplacedItem[]
  capacity: PlanCapacity | null
  notes: PlanNote[]
  conflicts: PlanConflict[]
  /** New data since the draft (a proposed revision, applied only by Replan). */
  changes: { additions: number; removals: number; moves: number } | null
  nextAction: PlanBlockView | null
  counts: { suggested: number; tentativeSuggested: number; accepted: number; done: number }
  calendar: { connected: boolean; message: string }
}

function timeRange(start: Date | null, end: Date | null, tz: string): string | null {
  if (!start || !end) return null
  return `${localTimeInZone(start, tz)}–${localTimeInZone(end, tz)}`
}

export function planMinutesLabel(minutes: number, estimated: boolean): string {
  return estimated ? `Estimate · ${plannerDurationLabel(minutes)}` : plannerDurationLabel(minutes)
}

export function buildPlanBlockViews(
  blocks: readonly PlanBlockRow[],
  opts: {
    now: Date
    timezone: string
    readOnly: boolean
    sourceStatuses?: ReadonlyMap<string, 'open' | 'done' | 'cancelled'>
  },
): PlanBlockView[] {
  const nowMs = opts.now.getTime()
  const current = blocks.map((b) => ({
    id: b.id,
    candidateKind: b.candidateKind,
    candidateId: b.candidateId,
    title: b.titleSnapshot,
    bucket: b.bucket,
    start: b.startAt?.toISOString() ?? null,
    end: b.endAt?.toISOString() ?? null,
    minutes: b.minutes,
    state: b.state,
    editedByOwner: b.editedByOwner,
    splitPart: b.splitPart,
    splitTotal: b.splitTotal,
    position: b.position,
  }))
  const labels = plannerSplitLabels(current)
  // Neighbours for move up/down: same rules as plannerValidateMove (timed vs list, skip done/dismissed).
  const movable = blocks.filter((b) => b.state !== 'done' && b.state !== 'dismissed')
  const timedOrder = movable
    .filter((b) => b.startAt)
    .sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime() || a.position - b.position)
    .map((b) => b.id)
  const listOrder = movable
    .filter((b) => !b.startAt)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
    .map((b) => b.id)

  return blocks.map((b) => {
    const order = b.startAt ? timedOrder : listOrder
    const i = order.indexOf(b.id)
    const isPast = b.endAt !== null && b.endAt.getTime() <= nowMs
    const isNow =
      b.startAt !== null &&
      b.endAt !== null &&
      b.startAt.getTime() <= nowMs &&
      nowMs < b.endAt.getTime()
    const active = b.state !== 'done' && b.state !== 'dismissed'
    const ro = opts.readOnly
    const label = labels.get(b.id)
    const status = opts.sourceStatuses?.get(b.candidateId)
    return {
      id: b.id,
      title: b.titleSnapshot,
      kind: b.candidateKind,
      kindLabel: PLAN_KIND_LABELS[b.candidateKind],
      state: b.state,
      bucket: b.bucket,
      timeLabel: timeRange(b.startAt, b.endAt, opts.timezone),
      startIso: b.startAt ? b.startAt.toISOString() : null,
      startTime: b.startAt ? localTimeInZone(b.startAt, opts.timezone) : null,
      minutes: b.minutes,
      durationLabel: planMinutesLabel(b.minutes, b.estimated),
      estimated: b.estimated,
      tentative: b.tentative,
      splitLabel: label ? `${label.part} of ${label.total}` : null,
      priorityRank: b.priorityRank,
      note: b.note,
      editedByOwner: b.editedByOwner,
      preserved: plannerIsPreserved(b),
      isPast,
      isNow,
      sourceStatus: status === 'done' || status === 'cancelled' ? status : null,
      can: {
        accept: !ro && b.state === 'suggested' && !isPast,
        pin: !ro && (b.state === 'accepted' || (b.state === 'suggested' && !isPast)),
        unpin: !ro && b.state === 'pinned',
        dismiss: !ro && active,
        restore: !ro && b.state === 'dismissed',
        done: !ro && active,
        edit: !ro && active,
        moveUp: !ro && active && i > 0,
        moveDown: !ro && active && i >= 0 && i < order.length - 1,
      },
    }
  })
}

function relativeOf(localDate: string, today: string): PlanDayView['relative'] {
  if (localDate < today) return 'past'
  if (localDate === today) return 'today'
  if (localDate === addLocalDays(today, 1)) return 'tomorrow'
  return 'future'
}

export function buildPlanDayView(input: {
  localDate: string
  today: string
  timezone: string
  now: Date
  plan: PlannerPlan | null
  revision?: PlanRevision | null
  sourceStatuses?: ReadonlyMap<string, 'open' | 'done' | 'cancelled'>
  events?: readonly PlanBusyEventView[]
}): PlanDayView {
  const { localDate, today, now } = input
  const relative = relativeOf(localDate, today)
  const canPlan = relative === 'today' || relative === 'tomorrow'
  const readOnly = relative === 'past'
  const plan = input.plan
  // Times are shown in the zone the plan was drafted in (the owner's zone at the time).
  const tz = plan?.plan.timezone ?? input.timezone
  const draft: PlanDraft | null = plan?.plan.draft?.version === 1 ? plan.plan.draft : null
  const views = plan
    ? buildPlanBlockViews(plan.blocks, {
        now,
        timezone: tz,
        readOnly,
        sourceStatuses: input.sourceStatuses,
      })
    : []

  const active = views.filter((v) => v.state !== 'dismissed')
  const timeline: PlanTimelineEntry[] = [
    ...active
      .filter((v) => v.timeLabel && v.bucket !== 'small')
      .map((block) => ({
        type: 'block' as const,
        start: plan!.blocks.find((b) => b.id === block.id)!.startAt!.getTime(),
        block,
      })),
    ...(input.events ?? []).map((e) => ({
      type: 'event' as const,
      start: e.start.getTime(),
      event: { ...e, timeLabel: timeRange(e.start, e.end, tz)! },
    })),
  ].sort((a, b) => a.start - b.start || (a.type === 'event' ? -1 : 1))

  const byCandidate = new Map<string, PlanBlockView[]>()
  if (plan) {
    for (const b of plan.blocks) {
      const view = views.find((v) => v.id === b.id)!
      const key = `${b.candidateKind}:${b.candidateId}`
      byCandidate.set(key, [...(byCandidate.get(key) ?? []), view])
    }
  }
  const doesNotFitKeys = new Set(
    (draft?.doesNotFit ?? []).map((d) => `${d.candidateKind}:${d.candidateId}`),
  )
  const stateRank: Record<PlanBlockState, number> = {
    done: 0,
    pinned: 1,
    accepted: 2,
    suggested: 3,
    dismissed: 4,
  }
  const priorities: PlanPriorityView[] = (draft?.priorities ?? []).map((p) => {
    const key = `${p.candidateKind}:${p.candidateId}`
    const blocks = (byCandidate.get(key) ?? []).filter((b) => b.state !== 'dismissed')
    blocks.sort((a, b) => stateRank[a.state] - stateRank[b.state])
    const first = blocks[0]
    return {
      rank: p.rank,
      title: p.title,
      reason: p.reason,
      state: first ? first.state : doesNotFitKeys.has(key) ? 'does_not_fit' : 'not_scheduled',
      timeLabel: first?.timeLabel ?? null,
    }
  })

  const next = plan
    ? plannerNextAction(
        plan.blocks.map((b) => ({
          id: b.id,
          candidateKind: b.candidateKind,
          candidateId: b.candidateId,
          title: b.titleSnapshot,
          bucket: b.bucket,
          start: b.startAt?.toISOString() ?? null,
          end: b.endAt?.toISOString() ?? null,
          minutes: b.minutes,
          state: b.state,
          editedByOwner: b.editedByOwner,
          splitPart: b.splitPart,
          splitTotal: b.splitTotal,
          position: b.position,
        })),
        now,
      )
    : null

  const rev = input.revision
  const dataChanges = rev ? rev.additions.length + rev.removals.length : 0

  return {
    localDate,
    dateLabel: planLongDateLabel(localDate),
    timezone: tz,
    relative,
    canPlan,
    readOnly,
    prevDate: addLocalDays(localDate, -1),
    nextDate: addLocalDays(localDate, 1),
    exists: plan !== null,
    mode: plan ? plan.plan.mode : null,
    generatedLabel: plan
      ? `${plan.plan.source === 'replan' ? 'Replanned' : 'Drafted'} at ${localTimeInZone(plan.plan.generatedAt, tz)}`
      : null,
    priorities,
    timeline,
    smallTasks: active.filter((v) => v.bucket === 'small' && v.timeLabel),
    list: active
      .filter((v) => !v.timeLabel)
      .sort(
        (a, b) =>
          plan!.blocks.find((x) => x.id === a.id)!.position -
          plan!.blocks.find((x) => x.id === b.id)!.position,
      ),
    dismissed: views.filter((v) => v.state === 'dismissed'),
    canWait: draft?.canWait ?? [],
    doesNotFit: draft?.doesNotFit ?? [],
    capacity: draft?.capacity ?? null,
    notes: (draft?.notes ?? []).filter((n) => n.code !== 'calendars_not_connected'),
    conflicts: rev?.conflicts ?? draft?.conflicts ?? [],
    changes:
      rev && !readOnly && dataChanges > 0
        ? {
            additions: rev.additions.length,
            removals: rev.removals.length,
            moves: rev.moves.length,
          }
        : null,
    nextAction: next ? (views.find((v) => v.id === next.id) ?? null) : null,
    counts: {
      suggested: views.filter((v) => v.state === 'suggested' && !v.tentative && !v.isPast).length,
      tentativeSuggested: views.filter((v) => v.state === 'suggested' && v.tentative).length,
      accepted: views.filter((v) => v.state === 'accepted' || v.state === 'pinned').length,
      done: views.filter((v) => v.state === 'done').length,
    },
    calendar: {
      connected: false,
      message: 'Calendars are not connected, so busy events are not shown or planned around yet.',
    },
  }
}

export interface PlanWeekDayView extends PlannerWeekDay {
  label: string
  isToday: boolean
  href: string
}

export function buildPlanWeekView(input: {
  days: readonly PlannerWeekDay[]
  today: string
}): PlanWeekDayView[] {
  return input.days.map((d) => ({
    ...d,
    label: planLongDateLabel(d.localDate),
    isToday: d.localDate === input.today,
    href: d.localDate === input.today ? '/plan' : `/plan/day/${d.localDate}`,
  }))
}

/** "2 tasks due", "1 task due". */
export function planCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}
