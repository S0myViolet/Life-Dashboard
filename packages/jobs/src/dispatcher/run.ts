/**
 * The minute dispatcher (brief §7). One run:
 *   1. materialises due recurring schedules (idempotent per period),
 *   2. reaps jobs whose lease expired during their final attempt,
 *   3. claims and runs due jobs one at a time until the time budget, maxJobs,
 *      an abort, or an empty queue stops it.
 *
 * Each job runs with an AbortSignal and a per-job timeout, is heartbeated while
 * it runs, and is completed or failed with its lease token. A throwing or hung
 * handler only affects its own job. A job is only claimed when its whole
 * timeout (plus a reserve for recording the outcome) fits in the remaining
 * budget, so the run finishes inside the budget.
 *
 * Runs in Node (tests) and Deno (the Edge Function): no Node-only APIs.
 */
import {
  JOB_SCHEDULE_DEFINITIONS,
  JobFailure,
  JobJsonObjectSchema,
  sanitizeJobError,
  type ClaimedJob,
  type JobBackoffPolicy,
  type JobKind,
  type JobRow,
  type JobScheduleDefinition,
} from '@personal-home/core'
import {
  claimJobs,
  completeJob,
  failJob,
  heartbeatJob,
  reapExpiredJobs,
  withService,
  type Db,
} from '@personal-home/db'
import { materialiseDueSchedules, type ScheduleSummary } from './materialise.ts'
import { registeredJobKinds, type JobContext, type JobHandler, type JobHandlerRegistry } from './types.ts'

export const DISPATCHER_DEFAULTS = {
  leaseMs: 60_000,
  defaultJobTimeoutMs: 20_000,
  finalizeReserveMs: 1_500,
} as const

export type DispatcherStopReason = 'idle' | 'budget' | 'max_jobs' | 'aborted' | 'error'
export type DispatchedJobOutcome = 'succeeded' | 'retrying' | 'dead' | 'lease_lost'

export interface DispatchedJob {
  id: string
  kind: JobKind
  attempt: number
  outcome: DispatchedJobOutcome
  timedOut: boolean
  durationMs: number
}

/** Structured log events. They carry ids, kinds and codes only — never payloads or user content. */
export type DispatcherLogEvent =
  | { event: 'job_finished'; job: DispatchedJob }
  | { event: 'schedule_error'; message: string }
  | { event: 'heartbeat_error'; jobId: string; message: string }
  | { event: 'on_dead_error'; jobId: string; kind: JobKind; message: string }
  | { event: 'dispatcher_error'; message: string }

export interface DispatcherSummary {
  workerId: string
  startedAt: string
  durationMs: number
  stoppedReason: DispatcherStopReason
  schedules: ScheduleSummary | null
  reaped: number
  jobs: DispatchedJob[]
  totals: {
    claimed: number
    succeeded: number
    retrying: number
    dead: number
    leaseLost: number
    timedOut: number
  }
  /** Error codes only (details go to `log`, sanitised). */
  errors: Array<'schedule_error' | 'dispatcher_error'>
}

export interface RunDispatcherOptions {
  db: Db
  /** Identifies this worker in lease_owner (e.g. `edge:<uuid>`). */
  workerId: string
  handlers: JobHandlerRegistry
  /** Wall-time budget for the whole run, in ms. */
  budgetMs: number
  /** Maximum jobs to run in this invocation. */
  maxJobs: number
  /** Logical clock for run_at/lease/briefing timestamps. Default: the system clock. */
  now?: () => Date
  /** Monotonic milliseconds for the budget. Default: performance.now(). */
  monotonicNow?: () => number
  /** Stops the run (the current job is aborted and recorded as a retryable failure). */
  signal?: AbortSignal
  leaseMs?: number
  defaultJobTimeoutMs?: number
  /** Heartbeat period while a job runs. Default: a third of the lease. */
  heartbeatIntervalMs?: number
  /** Time kept back after a job's timeout to record its outcome. */
  finalizeReserveMs?: number
  schedules?: readonly JobScheduleDefinition[]
  backoff?: JobBackoffPolicy
  log?: (event: DispatcherLogEvent) => void
}

class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`Job timed out after ${ms} ms`)
    this.name = 'JobTimeoutError'
  }
}

class LeaseLostError extends Error {
  constructor() {
    super('Lease lost to another worker')
    this.name = 'LeaseLostError'
  }
}

class DispatcherStoppedError extends Error {
  constructor() {
    super('Dispatcher stopped before the job finished')
    this.name = 'DispatcherStoppedError'
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function positive(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0)) throw new RangeError(`${name} must be a positive number`)
  return value
}

export async function runDispatcher(o: RunDispatcherOptions): Promise<DispatcherSummary> {
  const now = o.now ?? (() => new Date())
  const mono = o.monotonicNow ?? (() => performance.now())
  const budgetMs = positive('budgetMs', o.budgetMs)
  if (!Number.isInteger(o.maxJobs) || o.maxJobs < 0) throw new RangeError('maxJobs must be a non-negative integer')
  if (!o.workerId || o.workerId.length > 200) throw new RangeError('workerId must be 1–200 characters')
  const leaseMs = positive('leaseMs', o.leaseMs ?? DISPATCHER_DEFAULTS.leaseMs)
  const defaultTimeoutMs = positive('defaultJobTimeoutMs', o.defaultJobTimeoutMs ?? DISPATCHER_DEFAULTS.defaultJobTimeoutMs)
  const heartbeatMs = positive('heartbeatIntervalMs', o.heartbeatIntervalMs ?? Math.max(100, Math.floor(leaseMs / 3)))
  if (heartbeatMs >= leaseMs) throw new RangeError('heartbeatIntervalMs must be shorter than leaseMs')
  const reserveMs = o.finalizeReserveMs ?? DISPATCHER_DEFAULTS.finalizeReserveMs
  const log = o.log ?? (() => {})
  const { db, handlers, workerId } = o

  const started = mono()
  const deadline = started + budgetMs
  const summary: DispatcherSummary = {
    workerId,
    startedAt: now().toISOString(),
    durationMs: 0,
    stoppedReason: 'idle',
    schedules: null,
    reaped: 0,
    jobs: [],
    totals: { claimed: 0, succeeded: 0, retrying: 0, dead: 0, leaseLost: 0, timedOut: 0 },
    errors: [],
  }
  const kinds = registeredJobKinds(handlers)
  const timeoutFor = (h: JobHandler) => h.timeoutMs ?? defaultTimeoutMs
  // A handler whose timeout cannot fit in the budget would never be claimed: fail loudly.
  const tooSlow = kinds.filter((k) => timeoutFor(handlers[k]!) + reserveMs > budgetMs)
  if (tooSlow.length > 0) {
    throw new RangeError(`job timeout plus finalizeReserveMs exceeds budgetMs for: ${tooSlow.join(', ')}`)
  }

  const runOnDead = async (job: JobRow, error: string) => {
    const h = handlers[job.kind]
    if (!h?.onDead) return
    try {
      await h.onDead({ job, db, now, error })
    } catch (err) {
      log({ event: 'on_dead_error', jobId: job.id, kind: job.kind, message: sanitizeJobError(err) })
    }
  }

  const runOne = async (job: ClaimedJob, handler: JobHandler): Promise<DispatchedJob> => {
    const timeoutMs = timeoutFor(handler)
    const t0 = mono()
    const controller = new AbortController()
    let timedOut = false
    let leaseLost = false
    let finished = false

    const onParentAbort = () => controller.abort(new DispatcherStoppedError())
    o.signal?.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new JobTimeoutError(timeoutMs))
    }, timeoutMs)

    const heartbeat = async (): Promise<boolean> => {
      if (finished || leaseLost) return !leaseLost
      const expires = await withService(db, (tx) => heartbeatJob(tx, job, { leaseMs, now: now() }))
      if (!expires && !finished) {
        leaseLost = true
        controller.abort(new LeaseLostError())
      }
      return expires !== null
    }
    let hbTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleHeartbeat = () => {
      hbTimer = setTimeout(() => {
        heartbeat()
          .catch((err) => log({ event: 'heartbeat_error', jobId: job.id, message: sanitizeJobError(err) }))
          .finally(() => {
            if (!finished && !controller.signal.aborted) scheduleHeartbeat()
          })
      }, heartbeatMs)
    }
    scheduleHeartbeat()

    const stop = () => {
      finished = true
      clearTimeout(timer)
      if (hbTimer !== undefined) clearTimeout(hbTimer)
      o.signal?.removeEventListener('abort', onParentAbort)
    }

    const ctx: JobContext = { job, db, now, signal: controller.signal, workerId, heartbeat }
    let outcome: DispatchedJobOutcome
    try {
      const running = Promise.resolve().then(() => handler.run(ctx))
      // If we stop waiting (timeout/abort), a late rejection must not become unhandled.
      running.catch(() => {})
      const value = await Promise.race([running, rejectOnAbort(controller.signal)])
      stop()
      const parsed = value == null ? { success: true as const, data: null } : JobJsonObjectSchema.safeParse(value)
      if (!parsed.success) {
        throw new JobFailure('Handler returned an invalid result', { retryable: false })
      }
      const ok = await withService(db, (tx) => completeJob(tx, job, { result: parsed.data, now: now() }))
      outcome = ok ? 'succeeded' : 'lease_lost'
    } catch (err) {
      stop()
      if (leaseLost) {
        outcome = 'lease_lost'
      } else {
        const failure = err instanceof JobFailure ? err : null
        const error = timedOut ? new JobTimeoutError(timeoutMs) : err
        const result = await withService(db, (tx) =>
          failJob(tx, job, {
            error,
            attempt: job.attempts,
            retryable: failure?.retryable ?? true,
            retryAt: failure?.retryAt ?? null,
            backoff: o.backoff,
            now: now(),
          }),
        )
        outcome = result === null ? 'lease_lost' : result === 'dead' ? 'dead' : 'retrying'
        if (result === 'dead') await runOnDead(job, sanitizeJobError(error))
      }
    }
    return {
      id: job.id,
      kind: job.kind,
      attempt: job.attempts,
      outcome,
      timedOut,
      durationMs: Math.round(mono() - t0),
    }
  }

  try {
    if (o.signal?.aborted) {
      summary.stoppedReason = 'aborted'
      return summary
    }

    try {
      summary.schedules = await materialiseDueSchedules({
        db,
        now: now(),
        handlers,
        schedules: o.schedules ?? JOB_SCHEDULE_DEFINITIONS,
      })
    } catch (err) {
      // Keep going: jobs already queued can still run.
      summary.errors.push('schedule_error')
      log({ event: 'schedule_error', message: sanitizeJobError(err) })
    }

    const reaped = await withService(db, (tx) => reapExpiredJobs(tx, { kinds, now: now() }))
    summary.reaped = reaped.length
    for (const job of reaped) await runOnDead(job, 'Lease expired during the final attempt')

    for (;;) {
      if (o.signal?.aborted) {
        summary.stoppedReason = 'aborted'
        break
      }
      if (summary.totals.claimed >= o.maxJobs) {
        summary.stoppedReason = 'max_jobs'
        break
      }
      const remaining = deadline - mono()
      const eligible = kinds.filter((k) => timeoutFor(handlers[k]!) + reserveMs <= remaining)
      if (eligible.length === 0) {
        summary.stoppedReason = 'budget'
        break
      }
      const [job] = await withService(db, (tx) =>
        claimJobs(tx, { workerId, limit: 1, leaseMs, kinds: eligible, now: now() }),
      )
      if (!job) {
        summary.stoppedReason = eligible.length < kinds.length ? 'budget' : 'idle'
        break
      }
      summary.totals.claimed++
      const handler = handlers[job.kind]
      if (!handler) throw new Error(`claimed a job without a handler: ${job.kind}`)
      const done = await runOne(job, handler)
      summary.jobs.push(done)
      if (done.outcome === 'succeeded') summary.totals.succeeded++
      else if (done.outcome === 'retrying') summary.totals.retrying++
      else if (done.outcome === 'dead') summary.totals.dead++
      else summary.totals.leaseLost++
      if (done.timedOut) summary.totals.timedOut++
      log({ event: 'job_finished', job: done })
    }
  } catch (err) {
    summary.stoppedReason = 'error'
    summary.errors.push('dispatcher_error')
    log({ event: 'dispatcher_error', message: sanitizeJobError(err) })
  }
  summary.durationMs = Math.round(mono() - started)
  return summary
}
