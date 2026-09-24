/**
 * Turn due recurring schedules into jobs. Idempotent: each occurrence has a
 * dedupe key (`<kind>:<localDate>` or `<kind>:<period start>`), so concurrent or
 * repeated dispatcher runs enqueue it at most once. Only the most recent due
 * occurrence is materialised, so an outage produces one catch-up job per
 * schedule, not a backlog.
 */
import {
  isValidTimeZone,
  latestDueOccurrence,
  shouldMaterialiseOccurrence,
  type JobScheduleDefinition,
} from '@personal-home/core'
import {
  enqueueJob,
  lockEnabledJobSchedules,
  readJobOwnerContext,
  recordJobScheduleProgress,
  syncJobSchedules,
  withService,
  type Db,
} from '@personal-home/db'
import type { JobHandlerRegistry } from './types.ts'

export type ScheduleSkipReason = 'no_handler' | 'no_owner' | 'no_timezone'

export interface ScheduleSummary {
  /** Enabled schedules examined (excluding ones another dispatcher held). */
  checked: number
  /** New jobs created this run. */
  enqueued: number
  skipped: Array<{ name: string; reason: ScheduleSkipReason }>
}

export async function materialiseDueSchedules(input: {
  db: Db
  now: Date
  handlers: JobHandlerRegistry
  schedules: readonly JobScheduleDefinition[]
}): Promise<ScheduleSummary> {
  const { db, now, handlers, schedules } = input
  // Short transaction of its own so concurrent dispatchers do not queue behind
  // the materialisation below.
  await withService(db, (tx) => syncJobSchedules(tx, schedules, now))

  return withService(db, async (tx) => {
    const summary: ScheduleSummary = { checked: 0, enqueued: 0, skipped: [] }
    const owner = await readJobOwnerContext(tx)
    const timezone = owner.timezone && isValidTimeZone(owner.timezone) ? owner.timezone : null
    const byName = new Map(schedules.map((d) => [d.name, d]))

    for (const row of await lockEnabledJobSchedules(tx)) {
      const def = byName.get(row.name)
      if (!def || !row.enabledSince) continue
      summary.checked++
      if (!handlers[def.kind]) {
        summary.skipped.push({ name: def.name, reason: 'no_handler' })
        continue
      }
      // Every schedule serves the dashboard owner; before one exists there is nobody to brief or sync for.
      if (!owner.hasOwner) {
        summary.skipped.push({ name: def.name, reason: 'no_owner' })
        continue
      }
      if (def.cadence === 'daily_local_time' && !timezone) {
        summary.skipped.push({ name: def.name, reason: 'no_timezone' })
        continue
      }

      const occurrence = latestDueOccurrence(def, now, timezone)
      const due = shouldMaterialiseOccurrence({
        occurrence,
        enabledSince: row.enabledSince,
        lastOccurrenceAt: row.lastOccurrenceAt,
      })
      if (!due) {
        if (row.nextRunAt?.getTime() !== occurrence.nextRunAt.getTime()) {
          await recordJobScheduleProgress(tx, row.name, { nextRunAt: occurrence.nextRunAt })
        }
        continue
      }

      const payload =
        occurrence.localDate !== null
          ? { localDate: occurrence.localDate, scheduledFor: occurrence.dueAt.toISOString(), timezone }
          : { periodStart: occurrence.dueAt.toISOString() }
      const { created } = await enqueueJob(
        tx,
        {
          kind: def.kind,
          dedupeKey: occurrence.dedupeKey,
          payload,
          runAt: occurrence.dueAt,
          scheduleName: def.name,
        },
        now,
      )
      if (created) summary.enqueued++
      await recordJobScheduleProgress(tx, row.name, {
        nextRunAt: occurrence.nextRunAt,
        lastOccurrenceAt: occurrence.dueAt,
        ...(created ? { lastEnqueuedAt: now } : {}),
      })
    }
    return summary
  })
}
