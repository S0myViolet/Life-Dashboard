/**
 * Briefing rules shared by the job handlers and the UI (brief §5 and §7):
 * one briefing per kind per owner-local date, published late with a label after
 * an outage, and never a backlog of notifications.
 */
import { z } from 'zod'
import type { JobKind } from '../catalog.ts'
import { CalendarDateSchema, IanaTimeZoneSchema } from '../time/zoned.ts'
import { JOB_SCHEDULE_DEFINITIONS } from './schedules.ts'

export const BRIEFING_KINDS = ['morning', 'evening'] as const
export const BriefingKindSchema = z.enum(BRIEFING_KINDS)
export type BriefingKind = z.infer<typeof BriefingKindSchema>

export const BRIEFING_STATUSES = ['preparing', 'published', 'failed'] as const
export const BriefingStatusSchema = z.enum(BRIEFING_STATUSES)
export type BriefingStatus = z.infer<typeof BriefingStatusSchema>

/** Published more than this long after its scheduled time → labelled late, no notification. */
export const BRIEFING_LATE_AFTER_MS = 30 * 60_000

export function briefingJobKind(kind: BriefingKind): JobKind {
  return kind === 'morning' ? 'briefing.morning' : 'briefing.evening'
}

export function briefingKindOfJob(jobKind: JobKind): BriefingKind | null {
  if (jobKind === 'briefing.morning') return 'morning'
  if (jobKind === 'briefing.evening') return 'evening'
  return null
}

/** The per-date idempotency key: `briefing.<kind>:<localDate>`. */
export function briefingDedupeKey(kind: BriefingKind, localDate: string): string {
  return `briefing.${kind}:${CalendarDateSchema.parse(localDate)}`
}

/** Owner-local publication time for each kind, taken from the schedule definitions. */
export function briefingLocalTime(kind: BriefingKind): string {
  const def = JOB_SCHEDULE_DEFINITIONS.find((d) => d.kind === briefingJobKind(kind))
  if (!def || def.cadence !== 'daily_local_time') {
    throw new Error(`no daily schedule defined for ${kind} briefing`)
  }
  return def.localTime
}

export function isBriefingLate(scheduledFor: Date, publishedAt: Date): boolean {
  return publishedAt.getTime() - scheduledFor.getTime() > BRIEFING_LATE_AFTER_MS
}

/**
 * Job payload. The dispatcher always fills all three fields (computed from the
 * owner's timezone when the occurrence was materialised). An empty payload means
 * "the most recent due briefing in the owner's current timezone" (manual run).
 */
export const BriefingJobPayloadSchema = z.union([
  z
    .object({
      localDate: CalendarDateSchema,
      scheduledFor: z.iso.datetime({ offset: true }),
      timezone: IanaTimeZoneSchema,
    })
    .strict(),
  z.object({}).strict(),
])
export type BriefingJobPayload = z.infer<typeof BriefingJobPayloadSchema>

export const BriefingSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  /** 'planned' = not built yet. Later milestones add real DataState values per section. */
  status: z.literal('planned'),
  availableIn: z.string(),
  description: z.string(),
})
export type BriefingSection = z.infer<typeof BriefingSectionSchema>

export const BriefingContentSchema = z.object({
  version: z.literal(1),
  kind: BriefingKindSchema,
  localDate: CalendarDateSchema,
  title: z.string(),
  summary: z.string(),
  sections: z.array(BriefingSectionSchema),
})
export type BriefingContent = z.infer<typeof BriefingContentSchema>

export const BriefingSourceFreshnessSchema = z.object({
  version: z.literal(1),
  /** One entry per source the briefing read. Empty: no source is read yet. */
  sources: z.array(z.record(z.string(), z.unknown())),
  note: z.string(),
})
export type BriefingSourceFreshness = z.infer<typeof BriefingSourceFreshnessSchema>

const SECTIONS: Record<
  BriefingKind,
  ReadonlyArray<Omit<BriefingSection, 'status' | 'availableIn'>>
> = {
  morning: [
    {
      key: 'important_email',
      title: 'Important email',
      description:
        'Action requests, explicit deadlines and important updates from connected Gmail and Outlook accounts.',
    },
    {
      key: 'todays_commitments',
      title: "Today's commitments",
      description: 'Calendar events, due tasks and reminders for today.',
    },
    {
      key: 'daily_plan',
      title: 'Proposed plan for today',
      description:
        'Three priorities, a suggested order and what can wait, refreshed from the planner.',
    },
    {
      key: 'project_priorities',
      title: 'Project priorities',
      description: 'Priorities drawn from captured ChatGPT and Claude project conversations.',
    },
    {
      key: 'upcoming_renewals',
      title: 'Upcoming renewals',
      description: 'Confirmed subscriptions renewing soon.',
    },
  ],
  evening: [
    {
      key: 'project_progress',
      title: 'Project progress',
      description: "What moved forward in today's captured project conversations.",
    },
    {
      key: 'unresolved_questions',
      title: 'Unresolved questions',
      description: 'Open questions left in project conversations.',
    },
    {
      key: 'suggested_next_actions',
      title: 'Suggested next actions',
      description:
        "Suggestions that can inform tomorrow's draft plan without changing accepted tasks.",
    },
    {
      key: 'journal_prompts',
      title: 'Optional journal prompts',
      description: 'A few optional prompts for the journal.',
    },
  ],
}

/**
 * Milestone 0 content: deterministic, and explicit that nothing is summarised yet.
 * It lists what each section will contain and when it arrives — no invented
 * email counts, plans or "nothing today" claims. It makes no claim about timing:
 * the same content is published on time, late or as an outage catch-up, and the
 * row's is_late flag is what labels a late briefing.
 */
export function buildBriefingSkeletonContent(
  kind: BriefingKind,
  localDate: string,
): BriefingContent {
  const date = CalendarDateSchema.parse(localDate)
  return {
    version: 1,
    kind,
    localDate: date,
    title: kind === 'morning' ? 'Morning briefing' : 'Evening project review',
    summary:
      'This briefing was prepared by the Milestone 0 job framework. It does not read email, ' +
      'calendars, tasks or projects yet, so it contains no summaries. The sections below arrive in Milestone 2.',
    sections: SECTIONS[kind].map((s) => ({ ...s, status: 'planned', availableIn: 'Milestone 2' })),
  }
}

export function buildBriefingSourceFreshness(): BriefingSourceFreshness {
  return {
    version: 1,
    sources: [],
    note: 'No connected sources are read by briefings until Milestone 2.',
  }
}
