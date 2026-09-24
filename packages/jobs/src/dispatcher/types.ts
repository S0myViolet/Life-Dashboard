import type { ClaimedJob, JobKind, JobRow } from '@personal-home/core'
import type { Db } from '@personal-home/db'

/** What a handler receives for one attempt of one job. */
export interface JobContext {
  /** The claimed job (attempts already counts this attempt). */
  job: ClaimedJob
  /** Open short service transactions with `withService(ctx.db, ...)`; never hold one across slow I/O. */
  db: Db
  /** The dispatcher's logical clock. Use it for every timestamp the job writes. */
  now: () => Date
  /**
   * Aborted when the job times out, the lease is lost, or the dispatcher stops.
   * Pass it to fetch() and check it before side effects: after an abort the
   * dispatcher has already recorded the attempt as failed.
   */
  signal: AbortSignal
  workerId: string
  /** Extend the lease now (the dispatcher also does this periodically). False when the lease was lost. */
  heartbeat: () => Promise<boolean>
}

/**
 * Small JSON summary stored in private.jobs.result: counts, ids, outcome codes.
 * camelCase keys only; never user content (mail, chat or journal text).
 */
export type JobHandlerResult = Record<string, unknown> | void

export interface JobDeadContext {
  job: JobRow
  db: Db
  now: () => Date
  /** Sanitised reason for the final failure. */
  error: string
}

export interface JobHandler {
  kind: JobKind
  /** Per-attempt time limit. Defaults to the dispatcher's defaultJobTimeoutMs. */
  timeoutMs?: number
  /**
   * Do the work. Throw JobFailure to control retry (retryable: false, retryAt
   * from Retry-After); any other throw is retried with backoff.
   */
  run(ctx: JobContext): Promise<JobHandlerResult>
  /**
   * Optional: called once when the job is dead (out of attempts, not retryable,
   * or its lease expired during the final attempt) so the handler can leave an
   * honest state behind (e.g. mark a briefing as failed instead of "preparing").
   */
  onDead?(ctx: JobDeadContext): Promise<void>
}

export type JobHandlerRegistry = Readonly<Partial<Record<JobKind, JobHandler>>>

/** Build a registry; a kind may have only one handler. */
export function createJobHandlerRegistry(handlers: readonly JobHandler[]): JobHandlerRegistry {
  const out: Partial<Record<JobKind, JobHandler>> = {}
  for (const h of handlers) {
    if (out[h.kind]) throw new Error(`duplicate job handler for ${h.kind}`)
    if (h.timeoutMs !== undefined && !(h.timeoutMs > 0)) {
      throw new Error(`invalid timeoutMs for ${h.kind}`)
    }
    out[h.kind] = h
  }
  return Object.freeze(out)
}

export function registeredJobKinds(registry: JobHandlerRegistry): JobKind[] {
  return (Object.keys(registry) as JobKind[]).filter((k) => registry[k] !== undefined).sort()
}
