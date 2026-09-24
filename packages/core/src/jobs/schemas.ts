/**
 * Job queue vocabulary shared by the database layer, the dispatcher and tests.
 * The SQL check constraints in supabase/migrations/20260924000200_jobs.sql mirror
 * these lists; packages/db/test/jobs.test.ts fails if they drift apart.
 */
import { z } from 'zod'
import { JobKindSchema } from '../catalog.ts'

/**
 * Lifecycle of a job row:
 *   queued    → waiting for its first attempt (run_at may be in the future)
 *   running   → leased by a worker (lease_token/lease_expires_at set)
 *   failed    → the last attempt failed; retried when run_at comes round
 *   succeeded → finished
 *   dead      → out of attempts, or failed permanently
 *   cancelled → withdrawn before it finished (e.g. disconnect or deletion)
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
] as const
export const JobStatusSchema = z.enum(JOB_STATUSES)
export type JobStatus = z.infer<typeof JobStatusSchema>

/** Statuses a job never leaves. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'dead', 'cancelled']

export const JOB_DEDUPE_KEY_MAX = 200
export const JOB_MAX_ATTEMPTS_LIMIT = 50
export const JOB_DEFAULT_MAX_ATTEMPTS = 5
/** Upper bound for a stored error message (the SQL column enforces 1000). */
export const JOB_ERROR_MAX_LENGTH = 500
/** Payload/result JSON is small, structured metadata — never raw mail, chats or journal text. */
export const JOB_JSON_MAX_BYTES = 16_384

const JsonObjectSchema = z.record(z.string(), z.unknown())

/**
 * The db client reads jsonb through postgres.camel, which rewrites object keys
 * containing `_` to camelCase. Job payloads/results must therefore use keys
 * without underscores, or a handler would read back different keys than were
 * written. Returns the first offending key path, or null.
 */
export function findJobJsonKeyProblem(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = findJobJsonKeyProblem(value[i], `${path}[${i}]`)
      if (p) return p
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes('_')) return `${path}.${k}`
      const p = findJobJsonKeyProblem(v, `${path}.${k}`)
      if (p) return p
    }
  }
  return null
}

/** A JSON object for job payloads/results: camelCase keys, bounded size. */
export const JobJsonObjectSchema = JsonObjectSchema.superRefine((value, ctx) => {
  const bad = findJobJsonKeyProblem(value)
  if (bad)
    ctx.addIssue({ code: 'custom', message: `use camelCase keys without "_" (found ${bad})` })
  let size = Number.POSITIVE_INFINITY
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    // Not serialisable (cycle, BigInt): reported below.
  }
  if (size > JOB_JSON_MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `must be JSON-serialisable and at most ${JOB_JSON_MAX_BYTES} bytes`,
    })
  }
})

/** A stable identity for "this unit of work", e.g. `briefing.morning:2026-03-29`. */
export const JobDedupeKeySchema = z
  .string()
  .min(1)
  .max(JOB_DEDUPE_KEY_MAX)
  .regex(/^[\x21-\x7e]+$/, { message: 'dedupe keys are printable ASCII without spaces' })

export const EnqueueJobInputSchema = z.object({
  kind: JobKindSchema,
  dedupeKey: JobDedupeKeySchema.nullish(),
  payload: JobJsonObjectSchema.default({}),
  /** When the job becomes claimable. Defaults to now. */
  runAt: z.date().optional(),
  maxAttempts: z
    .number()
    .int()
    .min(1)
    .max(JOB_MAX_ATTEMPTS_LIMIT)
    .default(JOB_DEFAULT_MAX_ATTEMPTS),
  /** The recurring schedule that produced this job, if any. */
  scheduleName: z.string().min(1).max(64).nullish(),
})
export type EnqueueJobInput = z.input<typeof EnqueueJobInputSchema>
export type EnqueueJobParsed = z.output<typeof EnqueueJobInputSchema>

/** A row of private.jobs as returned by the db package (camelCase). */
export const JobRowSchema = z.object({
  id: z.uuid(),
  kind: JobKindSchema,
  dedupeKey: z.string().nullable(),
  scheduleName: z.string().nullable(),
  payload: JsonObjectSchema,
  status: JobStatusSchema,
  runAt: z.date(),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  leaseOwner: z.string().nullable(),
  leaseToken: z.uuid().nullable(),
  leaseExpiresAt: z.date().nullable(),
  lastError: z.string().nullable(),
  result: JsonObjectSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  finishedAt: z.date().nullable(),
})
export type JobRow = z.infer<typeof JobRowSchema>

/** A job this worker holds a lease on. `leaseToken` fences every later write. */
export type ClaimedJob = JobRow & { status: 'running'; leaseToken: string; leaseExpiresAt: Date }

export interface JobFailureOptions {
  /** False when retrying cannot help (invalid payload, revoked consent). Default true. */
  retryable?: boolean
  /** Earliest time to retry, e.g. from a provider's Retry-After header. */
  retryAt?: Date | null
  cause?: unknown
}

/**
 * Throw from a job handler to control how the failure is recorded.
 * Any other thrown value is treated as a retryable failure with backoff.
 * The message is sanitised before it is stored; still, never put tokens,
 * mail bodies or journal text in it.
 */
export class JobFailure extends Error {
  readonly retryable: boolean
  readonly retryAt: Date | null

  constructor(message: string, options: JobFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JobFailure'
    this.retryable = options.retryable ?? true
    this.retryAt = options.retryAt ?? null
  }
}
