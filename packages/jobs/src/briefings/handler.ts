/**
 * Morning briefing / evening review handlers — Milestone 0 skeleton.
 *
 * What is real: the scheduling, the owner-local date, idempotency (one row per
 * kind and local date across retries, concurrency, DST and timezone changes),
 * the late label, the notify flag and outage catch-up. What is not built yet is
 * the content: every section says plainly that it arrives in Milestone 2.
 */
import {
  briefingJobKind,
  briefingLocalTime,
  BriefingJobPayloadSchema,
  buildBriefingSkeletonContent,
  buildBriefingSourceFreshness,
  isBriefingLate,
  isValidTimeZone,
  JobFailure,
  latestLocalDailyOccurrence,
  type BriefingContent,
  type BriefingKind,
} from '@personal-home/core'
import {
  insertOrGetBriefing,
  markBriefingFailed,
  publishBriefing,
  readJobOwnerContext,
  withService,
} from '@personal-home/db'
import type { JobHandler } from '../dispatcher/types.ts'

export interface BriefingHandlerOptions {
  timeoutMs?: number
  /** Content builder. Default: the deterministic Milestone 0 skeleton. (Also a test seam.) */
  buildContent?: (
    kind: BriefingKind,
    localDate: string,
  ) => BriefingContent | Promise<BriefingContent>
}

export type BriefingJobOutcome = 'published' | 'already_published' | 'superseded'

export function createBriefingJobHandler(
  kind: BriefingKind,
  options: BriefingHandlerOptions = {},
): JobHandler {
  const localTime = briefingLocalTime(kind)
  const build = options.buildContent ?? buildBriefingSkeletonContent

  return {
    kind: briefingJobKind(kind),
    timeoutMs: options.timeoutMs ?? 15_000,

    async run(ctx) {
      const payload = BriefingJobPayloadSchema.safeParse(ctx.job.payload)
      if (!payload.success) {
        throw new JobFailure('Invalid briefing job payload', { retryable: false })
      }
      const owner = await withService(ctx.db, (tx) => readJobOwnerContext(tx))
      const currentTz = owner.timezone && isValidTimeZone(owner.timezone) ? owner.timezone : null

      // Which briefing: the occurrence the scheduler computed, or (manual run)
      // the most recent due one in the owner's current timezone.
      let target: { localDate: string; scheduledFor: Date; timezone: string }
      if ('localDate' in payload.data) {
        target = {
          localDate: payload.data.localDate,
          scheduledFor: new Date(payload.data.scheduledFor),
          timezone: payload.data.timezone,
        }
      } else {
        if (!currentTz) throw new JobFailure('Owner timezone is not set', { retryable: false })
        const latest = latestLocalDailyOccurrence(ctx.now(), localTime, currentTz)
        target = { localDate: latest.localDate, scheduledFor: latest.at, timezone: currentTz }
      }

      // Outage catch-up: when a newer briefing of this kind is already due, this
      // one is stale. Do not publish it (and never notify for it); a row left
      // over from an earlier attempt is marked failed instead of "preparing".
      if (currentTz) {
        const latest = latestLocalDailyOccurrence(ctx.now(), localTime, currentTz)
        if (latest.localDate > target.localDate) {
          await withService(ctx.db, (tx) =>
            markBriefingFailed(
              tx,
              { kind, localDate: target.localDate },
              {
                code: 'superseded',
                message:
                  'Not published: a newer briefing was already due when this one ran (for example after an outage).',
              },
            ),
          )
          return {
            outcome: 'superseded' satisfies BriefingJobOutcome,
            kind,
            localDate: target.localDate,
          }
        }
      }

      const { briefing } = await withService(ctx.db, (tx) =>
        insertOrGetBriefing(tx, { kind, ...target }),
      )
      if (briefing.status === 'published') {
        return {
          outcome: 'already_published' satisfies BriefingJobOutcome,
          kind,
          localDate: briefing.localDate,
        }
      }

      const content = await build(kind, briefing.localDate)
      // Timed out or lost the lease while preparing: do not publish from a stale attempt.
      ctx.signal.throwIfAborted()

      const publishedAt = ctx.now()
      const isLate = isBriefingLate(briefing.scheduledFor, publishedAt)
      const published = await withService(ctx.db, (tx) =>
        publishBriefing(tx, {
          id: briefing.id,
          publishedAt,
          isLate,
          notify: !isLate,
          content,
          sourceFreshness: buildBriefingSourceFreshness(),
        }),
      )
      const outcome: BriefingJobOutcome = published ? 'published' : 'already_published'
      return { outcome, kind, localDate: briefing.localDate, isLate: published ? isLate : null }
    },

    async onDead(ctx) {
      const payload = BriefingJobPayloadSchema.safeParse(ctx.job.payload)
      if (!payload.success || !('localDate' in payload.data)) return
      const localDate = payload.data.localDate
      await withService(ctx.db, (tx) =>
        markBriefingFailed(
          tx,
          { kind, localDate },
          {
            code: 'job_failed',
            message: 'The briefing could not be prepared after repeated attempts.',
          },
        ),
      )
    },
  }
}

export const morningBriefingJobHandler: JobHandler = createBriefingJobHandler('morning')
export const eveningBriefingJobHandler: JobHandler = createBriefingJobHandler('evening')

/** The briefing handlers, ready for createJobHandlerRegistry(...). */
export const briefingJobHandlers: readonly JobHandler[] = [
  morningBriefingJobHandler,
  eveningBriefingJobHandler,
]
