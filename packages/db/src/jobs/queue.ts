/**
 * Job queue access (private.jobs). Service transactions only: every function
 * here expects a `withService` transaction; anon/authenticated cannot reach the
 * private schema at all.
 */
import {
  computeJobRetryAt,
  EnqueueJobInputSchema,
  JobJsonObjectSchema,
  sanitizeJobError,
  type ClaimedJob,
  type EnqueueJobInput,
  type JobBackoffPolicy,
  type JobKind,
  type JobRow,
  type JobStatus,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import { jobsJsonb } from './json.ts'

export interface EnqueueJobResult {
  job: JobRow
  /** False when a job with the same dedupe key already existed (nothing was inserted). */
  created: boolean
}

/** Enqueue a job; idempotent on `dedupeKey`. */
export async function enqueueJob(tx: Tx, input: EnqueueJobInput, now?: Date): Promise<EnqueueJobResult> {
  const v = EnqueueJobInputSchema.parse(input)
  const [res] = await tx<{ jobId: string; created: boolean }[]>`
    select * from private.enqueue_job(
      ${v.kind},
      ${jobsJsonb(tx, v.payload)}::jsonb,
      ${v.dedupeKey ?? null},
      ${v.runAt ?? null}::timestamptz,
      ${v.maxAttempts},
      ${v.scheduleName ?? null},
      ${now ?? null}::timestamptz
    )
  `
  if (!res) throw new Error('enqueue_job returned no row')
  // A separate statement: rows written inside a function are not visible to the
  // snapshot of the statement that called it.
  const job = await getJob(tx, res.jobId)
  if (!job) throw new Error('enqueued job is not visible')
  return { job, created: res.created }
}

export interface ClaimJobsOptions {
  workerId: string
  /** At most this many jobs (1–100). */
  limit: number
  /** Lease length; the worker must heartbeat or finish before it expires. */
  leaseMs: number
  /** Only claim these kinds (the ones this worker has handlers for). Omit for all. */
  kinds?: readonly JobKind[] | null
  now?: Date
}

/** Claim due jobs with fresh leases (FOR UPDATE SKIP LOCKED). */
export async function claimJobs(tx: Tx, o: ClaimJobsOptions): Promise<ClaimedJob[]> {
  if (o.kinds && o.kinds.length === 0) return []
  const rows = await tx<ClaimedJob[]>`
    select * from private.claim_jobs(
      ${o.workerId},
      ${o.limit},
      ${Math.round(o.leaseMs)},
      ${o.kinds ? [...o.kinds] : null}::text[],
      ${o.now ?? null}::timestamptz
    )
  `
  return [...rows]
}

/** Mark jobs dead whose lease expired during their final attempt; returns them. */
export async function reapExpiredJobs(
  tx: Tx,
  o: { kinds?: readonly JobKind[] | null; now?: Date } = {},
): Promise<JobRow[]> {
  if (o.kinds && o.kinds.length === 0) return []
  const rows = await tx<JobRow[]>`
    select * from private.reap_expired_jobs(${o.kinds ? [...o.kinds] : null}::text[], ${o.now ?? null}::timestamptz)
  `
  return [...rows]
}

export interface LeaseRef {
  id: string
  leaseToken: string
}

/** Extend a lease. Returns the new expiry, or null when the lease was lost. */
export async function heartbeatJob(
  tx: Tx,
  lease: LeaseRef,
  o: { leaseMs: number; now?: Date },
): Promise<Date | null> {
  const [row] = await tx<{ expiresAt: Date | null }[]>`
    select private.heartbeat_job(${lease.id}::uuid, ${lease.leaseToken}::uuid, ${Math.round(o.leaseMs)}, ${o.now ?? null}::timestamptz) as expires_at
  `
  return row?.expiresAt ?? null
}

/** Mark a job succeeded. False when the lease token no longer holds the job. */
export async function completeJob(
  tx: Tx,
  lease: LeaseRef,
  o: { result?: Record<string, unknown> | null; now?: Date } = {},
): Promise<boolean> {
  const result = o.result == null ? null : JobJsonObjectSchema.parse(o.result)
  const [row] = await tx<{ ok: boolean }[]>`
    select private.complete_job(
      ${lease.id}::uuid,
      ${lease.leaseToken}::uuid,
      ${result === null ? null : jobsJsonb(tx, result)}::jsonb,
      ${o.now ?? null}::timestamptz
    ) as ok
  `
  return row?.ok === true
}

export interface FailJobOptions {
  /** Anything thrown. Only a sanitised, truncated message is stored. */
  error: unknown
  /** The attempt number that failed (job.attempts after the claim). Drives backoff. */
  attempt: number
  /** False: go straight to `dead`. */
  retryable?: boolean
  /** Provider-requested earliest retry (Retry-After). Backoff still applies as a floor. */
  retryAt?: Date | null
  backoff?: JobBackoffPolicy
  now?: Date
}

export type FailJobOutcome = 'failed' | 'dead'

/**
 * Record a failed attempt: retry later with deterministic backoff (seeded by the
 * job id), or `dead` after max_attempts. Returns null when the lease was lost.
 */
export async function failJob(tx: Tx, lease: LeaseRef, o: FailJobOptions): Promise<FailJobOutcome | null> {
  const now = o.now ?? new Date()
  const message = sanitizeJobError(o.error)
  const retryAt = computeJobRetryAt({
    now,
    attempt: Math.max(1, o.attempt),
    seed: lease.id,
    retryAt: o.retryAt ?? null,
    policy: o.backoff,
  })
  const [row] = await tx<{ outcome: FailJobOutcome | null }[]>`
    select private.fail_job(
      ${lease.id}::uuid,
      ${lease.leaseToken}::uuid,
      ${message},
      ${retryAt}::timestamptz,
      ${o.retryable ?? true},
      ${now}::timestamptz
    ) as outcome
  `
  return row?.outcome ?? null
}

export async function getJob(tx: Tx, id: string): Promise<JobRow | null> {
  const [row] = await tx<JobRow[]>`select * from private.jobs where id = ${id}::uuid`
  return row ?? null
}

export async function getJobByDedupeKey(tx: Tx, dedupeKey: string): Promise<JobRow | null> {
  const [row] = await tx<JobRow[]>`select * from private.jobs where dedupe_key = ${dedupeKey}`
  return row ?? null
}

export async function listJobs(
  tx: Tx,
  filter: { kind?: JobKind; status?: JobStatus; limit?: number } = {},
): Promise<JobRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 5000)
  const rows = await tx<JobRow[]>`
    select * from private.jobs
    where (${filter.kind ?? null}::text is null or kind = ${filter.kind ?? null})
      and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
    order by created_at, run_at, id
    limit ${limit}
  `
  return [...rows]
}

/** Count jobs per status (for dashboards/tests). Statuses with no jobs are omitted. */
export async function countJobsByStatus(tx: Tx): Promise<Partial<Record<JobStatus, number>>> {
  const rows = await tx<{ status: JobStatus; n: number }[]>`
    select status, count(*)::int as n from private.jobs group by status
  `
  return Object.fromEntries(rows.map((r) => [r.status, r.n]))
}
