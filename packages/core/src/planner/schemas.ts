/**
 * Planner vocabulary and boundary validation.
 *
 * The planner is deterministic: the same input always produces the same draft. Instants
 * are accepted as `Date` objects or ISO-8601 strings with an offset and are emitted as
 * ISO strings (UTC, `toISOString()`), so a draft can be stored as JSON unchanged.
 */
import { z } from 'zod'
import { CalendarDateSchema, IanaTimeZoneSchema, WallClockTimeSchema } from '../time/index.ts'

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/** What a candidate is. Tasks, accepted project actions and email deadlines live in public.tasks in M1. */
export const PLANNER_CANDIDATE_KINDS = [
  'task',
  'project_action',
  'email_deadline',
  'habit',
  'reading_goal',
] as const
export const PlannerCandidateKindSchema = z.enum(PLANNER_CANDIDATE_KINDS)
export type PlannerCandidateKind = z.infer<typeof PlannerCandidateKindSchema>

/** Kinds that can be picked as one of the day's priorities (routines such as habits cannot). */
export const PLANNER_PRIORITY_KINDS: readonly PlannerCandidateKind[] = [
  'task',
  'project_action',
  'email_deadline',
]

/** Lifecycle of a persisted plan block. */
export const PLAN_BLOCK_STATES = ['suggested', 'accepted', 'pinned', 'dismissed', 'done'] as const
export const PlanBlockStateSchema = z.enum(PLAN_BLOCK_STATES)
export type PlanBlockState = z.infer<typeof PlanBlockStateSchema>

/** How a daily plan row was (last) produced. */
export const DAILY_PLAN_SOURCES = ['auto_first_use', 'manual', 'briefing', 'replan'] as const
export const DailyPlanSourceSchema = z.enum(DAILY_PLAN_SOURCES)
export type DailyPlanSource = z.infer<typeof DailyPlanSourceSchema>

/** Where a suggestion sits in the draft. */
export const PLAN_BLOCK_BUCKETS = ['scheduled', 'small', 'list'] as const
export const PlanBlockBucketSchema = z.enum(PLAN_BLOCK_BUCKETS)
export type PlanBlockBucket = z.infer<typeof PlanBlockBucketSchema>

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const PlannerOptionsSchema = z.object({
  /** Share of free time left unallocated (brief: approximately 20%). */
  bufferRatio: z.number().min(0).max(0.9).default(0.2),
  /** Estimate used when the owner entered no duration; labelled as an estimate. */
  defaultEstimateMinutes: z.number().int().min(5).max(480).default(30),
  /** Blocks start on this grid (and "now" is rounded up to it). */
  slotGranularityMinutes: z.number().int().min(1).max(60).default(5),
  /** Items at or under this length are "small tasks" used to fill short gaps. */
  smallTaskMaxMinutes: z.number().int().min(1).max(120).default(15),
  /** Smallest part a splittable task may be cut into. */
  minBlockMinutes: z.number().int().min(5).max(240).default(15),
  /** Upper bound on priorities (brief: three or fewer). */
  maxPriorities: z.number().int().min(0).max(3).default(3),
  /** "Due soon" horizon, in local days after the planned day. */
  dueSoonDays: z.number().int().min(1).max(14).default(3),
})
export type PlannerOptions = z.infer<typeof PlannerOptionsSchema>

export const PLANNER_DEFAULT_OPTIONS: PlannerOptions = PlannerOptionsSchema.parse({})

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** An instant: a Date or an ISO-8601 date-time string with an explicit offset. */
export const PlannerInstantSchema = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((v) => (v instanceof Date ? new Date(v.getTime()) : new Date(v)))
  .refine((d) => Number.isFinite(d.getTime()), { message: 'invalid instant' })

/** A local availability window on the planned date. `end` may be '24:00' (end of the day). */
export const PlannerWindowSchema = z.object({
  start: WallClockTimeSchema,
  end: z.union([WallClockTimeSchema, z.literal('24:00')]),
})
export type PlannerWindow = z.infer<typeof PlannerWindowSchema>

export const PlannerCandidateSchema = z.object({
  /** Stable id of the underlying record (task id, habit id, ...). */
  id: z.string().min(1).max(200),
  kind: PlannerCandidateKindSchema,
  title: z.string().trim().min(1).max(300),
  /** Explicit deadline instant, when the owner (or a confirmed source) gave a time. */
  dueAt: PlannerInstantSchema.nullish(),
  /** Local due date, when there is a date but no time. Ignored when dueAt is present. */
  dueDate: CalendarDateSchema.nullish(),
  /** 1 = highest. Null = no explicit priority. */
  priority: z.number().int().min(1).max(4).nullish(),
  /** Owner-entered effort. Null/absent means "not given": the planner estimates and says so. */
  durationMinutes: z.number().int().min(1).max(1440).nullish(),
  splittable: z.boolean().default(false),
  /** False for unconfirmed email/project inferences: tentative, never a priority. */
  confirmed: z.boolean().default(true),
  createdAt: PlannerInstantSchema,
  projectId: z.string().max(200).nullish(),
})
export type PlannerCandidate = z.infer<typeof PlannerCandidateSchema>
export type PlannerCandidateInput = z.input<typeof PlannerCandidateSchema>

/**
 * A read-only calendar commitment. Only events that are busy block time: timed events
 * default to busy, all-day events default to free unless explicitly marked busy.
 */
export const PlannerBusyEventSchema = z.object({
  id: z.string().min(1).max(500),
  title: z.string().max(500).nullish(),
  start: PlannerInstantSchema,
  end: PlannerInstantSchema,
  allDay: z.boolean().default(false),
  busy: z.boolean().nullish(),
  /** Human label of the source calendar/account, for display only. */
  source: z.string().max(200).nullish(),
  url: z.string().max(2000).nullish(),
})
export type PlannerBusyEvent = z.infer<typeof PlannerBusyEventSchema>
export type PlannerBusyEventInput = z.input<typeof PlannerBusyEventSchema>

/**
 * A plan block the owner has taken ownership of (accepted, pinned, done or edited).
 * With times it blocks the calendar; with or without times it covers its candidate.
 */
export const PlannerProtectedBlockSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().max(300).nullish(),
    candidateKind: PlannerCandidateKindSchema.nullish(),
    candidateId: z.string().max(200).nullish(),
    start: PlannerInstantSchema.nullish(),
    end: PlannerInstantSchema.nullish(),
    minutes: z.number().int().min(1).max(1440),
    /** Part number when this block is one part of a split task. */
    splitPart: z.number().int().min(1).max(99).nullish(),
    splitTotal: z.number().int().min(1).max(99).nullish(),
  })
  .refine((b) => (b.start == null) === (b.end == null), {
    message: 'protected block needs both start and end, or neither',
  })
export type PlannerProtectedBlock = z.infer<typeof PlannerProtectedBlockSchema>
export type PlannerProtectedBlockInput = z.input<typeof PlannerProtectedBlockSchema>

export const PlannerInputSchema = z.object({
  now: PlannerInstantSchema,
  timezone: IanaTimeZoneSchema,
  /** The day being planned (today or tomorrow in practice). */
  localDate: CalendarDateSchema,
  /** Windows for this date. Null/absent = the owner has not stated availability: list mode. */
  availability: z.array(PlannerWindowSchema).max(48).nullish(),
  /** Why availability is absent, echoed into the draft so the UI can explain list mode. */
  listModeReason: z.enum(['not_set', 'none_for_weekday', 'invalid']).nullish(),
  busy: z.array(PlannerBusyEventSchema).max(2000).default([]),
  protectedBlocks: z.array(PlannerProtectedBlockSchema).max(500).default([]),
  candidates: z.array(PlannerCandidateSchema).max(2000),
  /** Whether calendar busy time was available to the planner (M1: never connected). */
  calendarStatus: z
    .enum(['connected', 'partial', 'not_connected', 'unavailable'])
    .default('not_connected'),
  options: PlannerOptionsSchema.partial().default({}),
})
export type PlannerInput = z.input<typeof PlannerInputSchema>
export type PlannerParsedInput = z.infer<typeof PlannerInputSchema>

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type PlannerPriorityReasonCode =
  | 'overdue'
  | 'due_today_timed'
  | 'due_today'
  | 'high_priority'
  | 'project_action'
  | 'due_soon'
  | 'priority_2'

export interface PlanPriority {
  rank: number
  candidateKind: PlannerCandidateKind
  candidateId: string
  title: string
  reasonCode: PlannerPriorityReasonCode
  /** Short, deterministic explanation, e.g. "Overdue since Tue 22 Sep". */
  reason: string
}

/** One suggested block (time mode) or list item (list mode, no times). */
export interface PlanDraftBlock {
  candidateKind: PlannerCandidateKind
  candidateId: string
  title: string
  bucket: PlanBlockBucket
  /** ISO instants; null in list mode. */
  start: string | null
  end: string | null
  minutes: number
  /** True when the duration is the planner's default estimate, not an entered duration. */
  estimated: boolean
  /** True for unconfirmed inferences: shown as tentative, never a priority. */
  tentative: boolean
  splitPart: number | null
  splitTotal: number | null
  priorityRank: number | null
  /** Short deterministic note, e.g. "Ends after its 17:00 deadline". */
  note: string | null
}

export type PlannerUnplacedReasonCode =
  'not_enough_time' | 'no_gap_long_enough' | 'after_last_window' | 'low_pressure'

export interface PlanUnplacedItem {
  candidateKind: PlannerCandidateKind
  candidateId: string
  title: string
  minutes: number
  estimated: boolean
  tentative: boolean
  splittable: boolean
  priorityRank: number | null
  reasonCode: PlannerUnplacedReasonCode
  reason: string
  /** For "can wait" items: why they could not be placed as well. */
  fitReasonCode: Exclude<PlannerUnplacedReasonCode, 'low_pressure'> | null
}

export interface PlanAlreadyPlannedItem {
  candidateKind: PlannerCandidateKind
  candidateId: string
  title: string
  plannedMinutes: number
  priorityRank: number | null
}

export type PlanConflictKind = 'event' | 'block'

export interface PlanConflict {
  kind: PlanConflictKind
  /** The owner's protected block that is now in conflict. */
  blockId: string
  blockTitle: string | null
  /** The busy event or other protected block it overlaps. */
  withId: string
  withTitle: string | null
  overlapStart: string
  overlapEnd: string
  message: string
}

export interface PlanCapacity {
  /** False in list mode: no availability, so free time is unknown. */
  known: boolean
  /** Future free time inside the windows, after busy and protected time. */
  freeMinutes: number | null
  /** Left unallocated on purpose (≈20%). */
  bufferMinutes: number | null
  /** floor(free × (1 − buffer)). */
  budgetMinutes: number | null
  /** Minutes of suggested blocks. */
  allocatedMinutes: number
  /** Minutes wanted by items that were not placed (does not fit + can wait). */
  overflowMinutes: number | null
  /** Minutes wanted by every candidate that is not already planned. */
  demandMinutes: number
}

export type PlanNoteCode =
  | 'list_mode_not_set'
  | 'list_mode_none_for_weekday'
  | 'list_mode_invalid'
  | 'calendars_not_connected'
  | 'calendars_partial'
  | 'calendars_unavailable'
  | 'day_over'
  | 'nothing_to_plan'
  | 'sources_partial'

export interface PlanNote {
  code: PlanNoteCode
  message: string
}

export interface PlanDraft {
  version: 1
  localDate: string
  timezone: string
  generatedAt: string
  mode: 'time' | 'list'
  priorities: PlanPriority[]
  /** Time mode: suggested blocks for priorities and regular items. */
  scheduled: PlanDraftBlock[]
  /** Time mode: small low-pressure items placed into short gaps. */
  smallTasks: PlanDraftBlock[]
  /** List mode: every candidate in ranked order, with effort estimates and no times. */
  list: PlanDraftBlock[]
  canWait: PlanUnplacedItem[]
  doesNotFit: PlanUnplacedItem[]
  /** Candidates already covered by the owner's accepted/pinned/done/edited blocks. */
  alreadyPlanned: PlanAlreadyPlannedItem[]
  conflicts: PlanConflict[]
  capacity: PlanCapacity
  notes: PlanNote[]
}

// ---------------------------------------------------------------------------
// Owner settings: available hours (parsed defensively; the settings area owns the writer)
// ---------------------------------------------------------------------------

const AvailableHoursEntrySchema = z.object({
  weekday: z.number().int().min(1).max(7),
  start: WallClockTimeSchema,
  end: z.union([WallClockTimeSchema, z.literal('24:00')]),
})

export interface PlannerAvailabilityForDate {
  /** Null when the planner must use list mode. */
  windows: PlannerWindow[] | null
  listModeReason: 'not_set' | 'none_for_weekday' | 'invalid' | null
  /** Entries that were ignored because they were malformed or empty. */
  ignoredEntries: number
}

function wallMinutes(t: string): number {
  if (t === '24:00') return 1440
  const [h, m] = t.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * Windows for one ISO weekday from `owner_settings.available_hours`
 * (`[{ weekday: 1-7, start: 'HH:MM', end: 'HH:MM' }]`). Malformed entries are skipped,
 * never fatal; windows with end ≤ start (overnight) are ignored; overlaps are merged.
 */
export function plannerAvailabilityForWeekday(
  availableHours: unknown,
  weekday: number,
): PlannerAvailabilityForDate {
  if (availableHours == null || (Array.isArray(availableHours) && availableHours.length === 0)) {
    return { windows: null, listModeReason: 'not_set', ignoredEntries: 0 }
  }
  if (!Array.isArray(availableHours)) {
    return { windows: null, listModeReason: 'invalid', ignoredEntries: 1 }
  }
  let ignored = 0
  let valid = 0
  const ranges: Array<[number, number]> = []
  for (const raw of availableHours) {
    const parsed = AvailableHoursEntrySchema.safeParse(raw)
    if (!parsed.success) {
      ignored++
      continue
    }
    const s = wallMinutes(parsed.data.start)
    const e = wallMinutes(parsed.data.end)
    if (e <= s) {
      ignored++
      continue
    }
    valid++
    if (parsed.data.weekday === weekday) ranges.push([s, e])
  }
  if (valid === 0) return { windows: null, listModeReason: 'invalid', ignoredEntries: ignored }
  if (ranges.length === 0) {
    return { windows: null, listModeReason: 'none_for_weekday', ignoredEntries: ignored }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const fmt = (m: number) =>
    m === 1440
      ? '24:00'
      : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return {
    windows: merged.map(([s, e]) => ({ start: fmt(s), end: fmt(e) })),
    listModeReason: null,
    ignoredEntries: ignored,
  }
}
