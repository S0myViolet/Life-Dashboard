/**
 * HTTP layer of the `dispatcher` Edge Function, kept apart from `Deno.serve` so
 * the Deno tests can call it directly against a local database.
 *
 * Authentication (brief §6: "a public Supabase key alone is not sufficient"):
 * the platform JWT check is off (verify_jwt = false in supabase/config.toml) and
 * every request must carry `x-dispatcher-secret` equal to the DISPATCHER_SECRET
 * function secret. pg_cron sends it from Supabase Vault (supabase/setup/
 * 10_schedule_dispatcher.sql). Both values are hashed first and the digests are
 * compared with timingSafeEqual, so neither the content nor the length of the
 * secret leaks through timing. `apikey` / `Authorization` headers are ignored.
 *
 * The response is a small JSON summary (counts, job ids, kinds, outcome codes).
 * It never contains payloads, briefing content or error text.
 */
import { sanitizeJobError, sha256Hex, timingSafeEqual } from '@personal-home/core'
import type { Db } from '@personal-home/db'
import {
  runDispatcher,
  type DispatcherLogEvent,
  type DispatcherSummary,
  type JobHandlerRegistry,
} from '@personal-home/jobs'

export const DISPATCHER_SECRET_HEADER = 'x-dispatcher-secret'
/** Shorter secrets are treated as "not configured" (use `openssl rand -base64 32`). */
export const DISPATCHER_SECRET_MIN_LENGTH = 32
const MAX_PRESENTED_SECRET_LENGTH = 512

/**
 * Per-invocation limits. Edge Functions allow 2 s of CPU per request, a 150 s
 * request idle timeout and a 150 s (Free) / 400 s (paid) worker wall clock
 * (docs/research/supabase.md, Q3). The dispatcher is I/O-bound, so the wall-time
 * budget stays far below 150 s and inside the 60 s cron period, and maxJobs
 * bounds the CPU spent per request. pg_net waits up to 55 s for the response.
 */
export const EDGE_DISPATCHER_LIMITS = {
  budgetMs: 40_000,
  maxJobs: 20,
  leaseMs: 60_000,
  defaultJobTimeoutMs: 20_000,
} as const

export interface DispatcherHttpOptions {
  /** Read on every request (Supabase applies new secrets without a redeploy). */
  getSecret: () => string | undefined
  /** Lazily opened pool; throws DispatcherConfigError when the URL is missing. */
  getDb: () => Db
  handlers: JobHandlerRegistry
  /** Aborted when the worker is shutting down (`beforeunload`). */
  shutdownSignal?: AbortSignal
  /** Test seam: logical clock passed to runDispatcher. Defaults to the system clock. */
  now?: () => Date
  budgetMs?: number
  maxJobs?: number
  /** Receives structured, content-free events. Defaults to one JSON line on stdout. */
  log?: (entry: DispatcherHttpLogEntry) => void
  /** Test seam for the lease owner id. */
  workerId?: () => string
}

export type DispatcherHttpLogEntry =
  | DispatcherLogEvent
  | { event: 'dispatcher_rejected'; reason: 'unauthorized' | 'method' }
  | { event: 'dispatcher_not_configured'; setting: string }
  | {
      event: 'dispatcher_summary'
      workerId: string
      stoppedReason: DispatcherSummary['stoppedReason']
      durationMs: number
      totals: DispatcherSummary['totals']
      reaped: number
      enqueued: number
      errors: DispatcherSummary['errors']
    }

/** A required setting (env var) is missing. Carries the setting name only. */
export class DispatcherConfigError extends Error {
  readonly setting: string
  constructor(setting: string) {
    super(`${setting} is not configured`)
    this.name = 'DispatcherConfigError'
    this.setting = setting
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } })
}

/** Constant-time check of the presented secret against the configured one. */
export async function isAuthorizedDispatcherRequest(
  req: Request,
  configuredSecret: string,
): Promise<boolean> {
  const presented = req.headers.get(DISPATCHER_SECRET_HEADER) ?? ''
  // Hash both sides, so a comparison takes the same time whatever was presented.
  const [a, b] = await Promise.all([
    sha256Hex(presented.slice(0, MAX_PRESENTED_SECRET_LENGTH)),
    sha256Hex(configuredSecret),
  ])
  return (
    timingSafeEqual(a, b) && presented.length > 0 && presented.length <= MAX_PRESENTED_SECRET_LENGTH
  )
}

function defaultLog(entry: DispatcherHttpLogEntry): void {
  // Routine successes are summarised once per run; everything else is logged.
  if (entry.event === 'job_finished' && entry.job.outcome === 'succeeded') return
  console.log(JSON.stringify(entry))
}

export function createDispatcherHttpHandler(
  o: DispatcherHttpOptions,
): (req: Request) => Promise<Response> {
  const log = o.log ?? defaultLog
  const budgetMs = o.budgetMs ?? EDGE_DISPATCHER_LIMITS.budgetMs
  const maxJobs = o.maxJobs ?? EDGE_DISPATCHER_LIMITS.maxJobs
  const newWorkerId = o.workerId ?? (() => `edge:${crypto.randomUUID()}`)

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      log({ event: 'dispatcher_rejected', reason: 'method' })
      return json(405, { ok: false, error: 'method_not_allowed' }, { allow: 'POST' })
    }

    const secret = o.getSecret()
    if (!secret || secret.length < DISPATCHER_SECRET_MIN_LENGTH) {
      // Fail closed: without a strong secret nothing can be authenticated.
      log({ event: 'dispatcher_not_configured', setting: 'DISPATCHER_SECRET' })
      return json(503, { ok: false, error: 'not_configured' })
    }
    if (!(await isAuthorizedDispatcherRequest(req, secret))) {
      log({ event: 'dispatcher_rejected', reason: 'unauthorized' })
      return json(401, { ok: false, error: 'unauthorized' })
    }
    // The request body is never read: nothing a caller sends can steer the run.

    let db: Db
    try {
      db = o.getDb()
    } catch (err) {
      // Never log this error's message: a malformed connection string may be in it.
      const setting = err instanceof DispatcherConfigError ? err.setting : 'SUPABASE_DB_URL'
      log({ event: 'dispatcher_not_configured', setting })
      return json(503, { ok: false, error: 'not_configured' })
    }

    let summary: DispatcherSummary
    try {
      summary = await runDispatcher({
        db,
        workerId: newWorkerId(),
        handlers: o.handlers,
        budgetMs,
        maxJobs,
        leaseMs: EDGE_DISPATCHER_LIMITS.leaseMs,
        defaultJobTimeoutMs: EDGE_DISPATCHER_LIMITS.defaultJobTimeoutMs,
        ...(o.now ? { now: o.now } : {}),
        ...(o.shutdownSignal ? { signal: o.shutdownSignal } : {}),
        log,
      })
    } catch (err) {
      // Only invalid options get here (runDispatcher reports run-time errors in its summary).
      log({ event: 'dispatcher_error', message: sanitizeJobError(err) })
      return json(500, { ok: false, error: 'dispatcher_error' })
    }
    log({
      event: 'dispatcher_summary',
      workerId: summary.workerId,
      stoppedReason: summary.stoppedReason,
      durationMs: summary.durationMs,
      totals: summary.totals,
      reaped: summary.reaped,
      enqueued: summary.schedules?.enqueued ?? 0,
      errors: summary.errors,
    })
    const ok = summary.stoppedReason !== 'error'
    return json(ok ? 200 : 500, { ok, summary: toPublicSummary(summary) })
  }
}

/**
 * The response body: an explicit allow-list of fields, so a future field on
 * DispatcherSummary cannot leak into HTTP responses (or pg_net's response log)
 * by accident.
 */
export function toPublicSummary(s: DispatcherSummary) {
  return {
    workerId: s.workerId,
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    stoppedReason: s.stoppedReason,
    schedules: s.schedules
      ? {
          checked: s.schedules.checked,
          enqueued: s.schedules.enqueued,
          skipped: s.schedules.skipped.map((k) => ({ name: k.name, reason: k.reason })),
        }
      : null,
    reaped: s.reaped,
    jobs: s.jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      attempt: j.attempt,
      outcome: j.outcome,
      timedOut: j.timedOut,
      durationMs: j.durationMs,
    })),
    totals: { ...s.totals },
    errors: [...s.errors],
  }
}
