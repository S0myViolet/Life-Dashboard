/**
 * Recurring job schedules, defined as data. The dispatcher copies these into
 * private.job_schedules on every run and materialises due occurrences as jobs.
 *
 * Only schedules whose handlers exist are enabled. The others are listed so the
 * intended cadence is visible (brief §4 defaults), but stay disabled until a real
 * handler is registered — there are no placeholder handlers that pretend to sync.
 * Event-driven kinds (capture.summarize, ai.reconcile, push.deliver,
 * plan.daily_draft) are enqueued on demand and have no schedule.
 */
import { z } from 'zod'
import { JobKindSchema, type JobKind } from '../catalog.ts'
import {
  latestLocalDailyOccurrence,
  nextLocalDailyRun,
  WallClockTimeSchema,
} from '../time/zoned.ts'

export const JOB_SCHEDULE_CADENCES = ['daily_local_time', 'interval'] as const
export const JobScheduleCadenceSchema = z.enum(JOB_SCHEDULE_CADENCES)
export type JobScheduleCadence = z.infer<typeof JobScheduleCadenceSchema>

export const JobScheduleNameSchema = z.string().regex(/^[a-z0-9_.-]{1,64}$/)

const Common = {
  name: JobScheduleNameSchema,
  kind: JobKindSchema,
  enabled: z.boolean(),
  /** Why a schedule is disabled, or which milestone brings it. Not shown to the owner as status. */
  note: z.string().max(200).optional(),
}

export const JobScheduleDefinitionSchema = z.discriminatedUnion('cadence', [
  z.object({
    ...Common,
    cadence: z.literal('daily_local_time'),
    /** Owner-local wall-clock time, evaluated in owner_settings.timezone. */
    localTime: WallClockTimeSchema,
  }),
  z.object({
    ...Common,
    cadence: z.literal('interval'),
    /** Period length. Periods are aligned to the Unix epoch (UTC). */
    intervalSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
  }),
])
export type JobScheduleDefinition = z.infer<typeof JobScheduleDefinitionSchema>

export const JOB_SCHEDULE_DEFINITIONS: readonly JobScheduleDefinition[] = Object.freeze(
  z.array(JobScheduleDefinitionSchema).parse([
    // Brief §5: 11:00 briefing and 22:00 project review, owner-local time.
    {
      name: 'briefing.morning',
      kind: 'briefing.morning',
      cadence: 'daily_local_time',
      localTime: '11:00',
      enabled: true,
    },
    {
      name: 'briefing.evening',
      kind: 'briefing.evening',
      cadence: 'daily_local_time',
      localTime: '22:00',
      enabled: true,
    },
    // Brief §4 cadences. Disabled until their handlers exist (Milestones 2–3).
    {
      name: 'sync.google',
      kind: 'sync.google',
      cadence: 'interval',
      intervalSeconds: 900,
      enabled: false,
      note: 'Milestone 2: Gmail/Calendar incremental sync every 15 minutes',
    },
    {
      name: 'sync.microsoft',
      kind: 'sync.microsoft',
      cadence: 'interval',
      intervalSeconds: 900,
      enabled: false,
      note: 'Milestone 2: Outlook incremental sync every 15 minutes',
    },
    {
      name: 'sync.lunchflow',
      kind: 'sync.lunchflow',
      cadence: 'interval',
      intervalSeconds: 21_600,
      enabled: false,
      note: 'Milestone 3: provider refreshes about daily; poll every 6 hours',
    },
    {
      name: 'sync.whoop',
      kind: 'sync.whoop',
      cadence: 'interval',
      intervalSeconds: 3_600,
      enabled: false,
      note: 'Milestone 3: hourly incremental polling',
    },
    {
      name: 'sync.spotify',
      kind: 'sync.spotify',
      cadence: 'daily_local_time',
      localTime: '05:00',
      enabled: false,
      note: 'Milestone 3: daily refresh',
    },
    {
      name: 'sync.football',
      kind: 'sync.football',
      cadence: 'interval',
      intervalSeconds: 900,
      enabled: false,
      note: 'Milestone 3: handler decides 6-hourly fixtures vs 15-minute match-day results',
    },
    {
      name: 'sync.rss',
      kind: 'sync.rss',
      cadence: 'interval',
      intervalSeconds: 3_600,
      enabled: false,
      note: 'Milestone 3: hourly feed refresh',
    },
    {
      name: 'retention.purge',
      kind: 'retention.purge',
      cadence: 'daily_local_time',
      localTime: '03:30',
      enabled: false,
      note: 'Milestone 2: 30-day raw text retention',
    },
  ]),
)

/** Dedupe key for a daily-local-time occurrence: `<kind>:<localDate>`. */
export function dailyJobDedupeKey(kind: JobKind, localDate: string): string {
  return `${kind}:${localDate}`
}

/** Dedupe key for an interval period: `<kind>:<period start ISO>`. */
export function intervalJobDedupeKey(kind: JobKind, periodStart: Date): string {
  return `${kind}:${periodStart.toISOString()}`
}

export interface ScheduleOccurrence {
  /** Identity of the period; used as the job's dedupe key. */
  dedupeKey: string
  /** When this occurrence was due. */
  dueAt: Date
  /** Owner-local date for daily schedules; null for interval schedules. */
  localDate: string | null
  /** When the following occurrence is due (for next_run_at). */
  nextRunAt: Date
}

/**
 * The most recent occurrence of `schedule` that is due at `now` — only the most
 * recent one, so after an outage the dispatcher catches up with a single job
 * per schedule instead of a backlog.
 * `timezone` is required for daily schedules (the owner's saved IANA zone).
 */
export function latestDueOccurrence(
  schedule: JobScheduleDefinition,
  now: Date,
  timezone: string | null,
): ScheduleOccurrence {
  if (schedule.cadence === 'daily_local_time') {
    if (!timezone) throw new Error('daily schedules need the owner timezone')
    const latest = latestLocalDailyOccurrence(now, schedule.localTime, timezone)
    return {
      dedupeKey: dailyJobDedupeKey(schedule.kind, latest.localDate),
      dueAt: latest.at,
      localDate: latest.localDate,
      nextRunAt: nextLocalDailyRun(now, schedule.localTime, timezone),
    }
  }
  const periodMs = schedule.intervalSeconds * 1000
  const start = Math.floor(now.getTime() / periodMs) * periodMs
  return {
    dedupeKey: intervalJobDedupeKey(schedule.kind, new Date(start)),
    dueAt: new Date(start),
    localDate: null,
    nextRunAt: new Date(start + periodMs),
  }
}

/**
 * Whether the latest occurrence should be enqueued. An occurrence is only
 * materialised when it falls after the schedule was enabled (a fresh install
 * does not publish "missed" briefings from before it existed) and after the
 * previous occurrence we materialised (so a timezone change cannot resurrect
 * an older local date).
 */
export function shouldMaterialiseOccurrence(input: {
  occurrence: ScheduleOccurrence
  enabledSince: Date
  lastOccurrenceAt: Date | null
}): boolean {
  const due = input.occurrence.dueAt.getTime()
  if (input.lastOccurrenceAt && due <= input.lastOccurrenceAt.getTime()) return false
  if (input.occurrence.localDate === null) {
    // Interval: the period containing enabledSince counts, so a newly enabled
    // sync runs straight away instead of waiting a whole period.
    return input.occurrence.nextRunAt.getTime() > input.enabledSince.getTime()
  }
  return due >= input.enabledSince.getTime()
}
