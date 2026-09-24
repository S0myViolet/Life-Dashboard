/**
 * Typed access to the AI budget ledger (supabase/migrations/20260924000300_ai_budget.sql).
 *
 * Everything except getAiBudgetStatus must run inside `withService` (jobs, the AI gateway).
 * Each call is one short statement; callers commit a reservation before making the provider
 * request, then settle it in a separate transaction.
 */
import { z } from 'zod'
import {
  AiModelIdSchema,
  aiBudgetPeriod,
  assertAiSourcesAllowed,
  isAiBudgetPeriod,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

const PeriodSchema = z.string().refine(isAiBudgetPeriod, 'invalid budget period (YYYY-MM)')
const MicrosSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const PurposeSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, 'invalid purpose')
const ErrorCodeSchema = z.string().regex(/^[a-z0-9_.:-]{1,64}$/, 'invalid error code')
const RateSchema = z.number().positive().max(10)

/** Token counts, audio seconds and limits only. Never text. */
export const AiUsageNumbersSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), z.number().finite().min(0))
  .refine((r) => Object.keys(r).length <= 24, 'too many usage fields')
export type AiUsageNumbers = z.infer<typeof AiUsageNumbersSchema>

export const AI_USAGE_STATUSES = ['reserved', 'reconciled', 'released', 'ambiguous'] as const
export type AiUsageStatus = (typeof AI_USAGE_STATUSES)[number]

const ReserveInputSchema = z.object({
  period: PeriodSchema,
  purpose: PurposeSchema,
  model: AiModelIdSchema,
  sourceTypes: z.array(z.string()).max(32),
  maxMicros: MicrosSchema.refine((n) => n > 0, 'reservation must be positive'),
  usdToGbpRate: RateSchema,
  usage: AiUsageNumbersSchema.optional(),
})
export type AiReserveInput = z.input<typeof ReserveInputSchema>

export interface AiReservation {
  allowed: boolean
  reason: 'reserved' | 'cap_reached' | 'disabled'
  reservationId: string | null
  capMicros: number
  committedMicros: number
  remainingMicros: number
  /** committed ≥ warn_ratio × cap (80% by default). */
  warn: boolean
}

/** Atomically reserve budget for one request, or refuse it (cap reached / AI disabled). */
export async function reserveAiBudget(tx: Tx, rawInput: AiReserveInput): Promise<AiReservation> {
  const input = ReserveInputSchema.parse(rawInput)
  assertAiSourcesAllowed(input.sourceTypes)
  const [row] = await tx<AiReservation[]>`
    select allowed, reason, reservation_id, cap_micros, committed_micros, remaining_micros, warn
    from private.ai_reserve(
      ${input.period}, ${input.purpose}, ${input.model}, ${input.sourceTypes}::text[],
      ${input.maxMicros}::bigint, ${input.usdToGbpRate}::numeric, ${tx.json(input.usage ?? {})}::jsonb
    )
  `
  if (!row) throw new Error('ai_reserve returned no row')
  return row
}

const ReconcileInputSchema = z.object({
  id: z.uuid(),
  actualMicros: MicrosSchema,
  usage: AiUsageNumbersSchema.optional(),
  errorCode: ErrorCodeSchema.nullish(),
})
export type AiReconcileInput = z.input<typeof ReconcileInputSchema>

export interface AiReconcileResult {
  status: 'reconciled'
  previousStatus: AiUsageStatus
  period: string
  reservedMicros: number
  actualMicros: number
  committedMicros: number
}

/**
 * Settle a completed request at its actual cost (lower or higher than reserved). Allowed from
 * 'reserved' or 'ambiguous'; calling it again is a no-op (previousStatus 'reconciled').
 */
export async function reconcileAiUsage(
  tx: Tx,
  rawInput: AiReconcileInput,
): Promise<AiReconcileResult> {
  const input = ReconcileInputSchema.parse(rawInput)
  const [row] = await tx<AiReconcileResult[]>`
    select status, previous_status, period, reserved_micros, actual_micros, committed_micros
    from private.ai_reconcile(
      ${input.id}::uuid, ${input.actualMicros}::bigint, ${tx.json(input.usage ?? {})}::jsonb,
      ${input.errorCode ?? null}::text
    )
  `
  if (!row) throw new Error('ai_reconcile returned no row')
  return row
}

const AmbiguousInputSchema = z.object({
  id: z.uuid(),
  errorCode: ErrorCodeSchema,
  usage: AiUsageNumbersSchema.optional(),
})

/** The request may have been processed: keep the full reservation counted. */
export async function markAiUsageAmbiguous(
  tx: Tx,
  rawInput: z.input<typeof AmbiguousInputSchema>,
): Promise<{ status: AiUsageStatus; previousStatus: AiUsageStatus }> {
  const input = AmbiguousInputSchema.parse(rawInput)
  const [row] = await tx<{ status: AiUsageStatus; previousStatus: AiUsageStatus }[]>`
    select status, previous_status
    from private.ai_mark_ambiguous(${input.id}::uuid, ${input.errorCode}, ${tx.json(input.usage ?? {})}::jsonb)
  `
  if (!row) throw new Error('ai_mark_ambiguous returned no row')
  return row
}

const ReleaseInputSchema = z.object({ id: z.uuid(), errorCode: ErrorCodeSchema })

/**
 * Return a reservation for a request that provably never reached the provider. Throws for
 * ambiguous or reconciled rows; a repeated release is a no-op.
 */
export async function releaseAiReservation(
  tx: Tx,
  rawInput: z.input<typeof ReleaseInputSchema>,
): Promise<{ status: 'released'; previousStatus: AiUsageStatus; committedMicros: number }> {
  const input = ReleaseInputSchema.parse(rawInput)
  const [row] = await tx<
    { status: 'released'; previousStatus: AiUsageStatus; committedMicros: number }[]
  >`
    select status, previous_status, committed_micros
    from private.ai_release(${input.id}::uuid, ${input.errorCode})
  `
  if (!row) throw new Error('ai_release returned no row')
  return row
}

/** Turn reservations left 'reserved' for longer than `olderThanHours` into 'ambiguous'. */
export async function sweepStaleAiReservations(
  tx: Tx,
  options: { olderThanHours?: number; now?: Date } = {},
): Promise<number> {
  const hours = z.number().min(1).max(24 * 31).parse(options.olderThanHours ?? 24)
  const now = options.now ?? null
  const [row] = await tx<{ swept: number }[]>`
    select private.ai_sweep_stale(
      make_interval(secs => ${hours * 3600}::double precision),
      coalesce(${now}::timestamptz, now())
    ) as swept
  `
  return row?.swept ?? 0
}

export interface AiBudgetSettings {
  monthlyCapMicros: number
  warnRatio: number
  usdToGbpRate: number
  enabled: boolean
}

/** Service read of the budget settings (the gateway needs the conversion rate and switch). */
export async function getAiBudgetSettings(tx: Tx): Promise<AiBudgetSettings> {
  const [row] = await tx<
    { monthlyCapMicros: number; warnRatio: string; usdToGbpRate: string; enabled: boolean }[]
  >`
    select monthly_cap_micros, warn_ratio, usd_to_gbp_rate, enabled
    from private.ai_budget_settings where singleton
  `
  if (!row) throw new Error('AI budget settings are missing')
  return {
    monthlyCapMicros: row.monthlyCapMicros,
    warnRatio: Number(row.warnRatio),
    usdToGbpRate: Number(row.usdToGbpRate),
    enabled: row.enabled,
  }
}

const SettingsPatchSchema = z
  .object({
    monthlyCapMicros: z.number().int().min(0).max(1_000_000_000),
    warnRatio: z.number().gt(0).max(1),
    usdToGbpRate: z.number().min(0.5).max(5),
    enabled: z.boolean(),
  })
  .partial()
  .strict()

/** Service write of the budget settings (call after the owner has been authenticated). */
export async function updateAiBudgetSettings(
  tx: Tx,
  patch: z.input<typeof SettingsPatchSchema>,
): Promise<AiBudgetSettings> {
  const p = SettingsPatchSchema.parse(patch)
  await tx`
    update private.ai_budget_settings set
      monthly_cap_micros = coalesce(${p.monthlyCapMicros ?? null}::bigint, monthly_cap_micros),
      warn_ratio = coalesce(${p.warnRatio ?? null}::numeric, warn_ratio),
      usd_to_gbp_rate = coalesce(${p.usdToGbpRate ?? null}::numeric, usd_to_gbp_rate),
      enabled = coalesce(${p.enabled ?? null}::boolean, enabled)
    where singleton
  `
  return getAiBudgetSettings(tx)
}

export interface AiBudgetStatus {
  period: string
  enabled: boolean
  capMicros: number
  warnRatio: number
  /** GBP per USD used for conversions. */
  usdToGbpRate: number
  /** Reserved + ambiguous + reconciled actuals. */
  committedMicros: number
  remainingMicros: number
  reconciledMicros: number
  reconciledCount: number
  /** Reservations for requests still in flight. */
  outstandingMicros: number
  outstandingCount: number
  /** Requests whose outcome is unknown; still fully counted. */
  ambiguousMicros: number
  ambiguousCount: number
  releasedCount: number
  deniedCount: number
  warn: boolean
  exhausted: boolean
}

type StatusRow = Omit<AiBudgetStatus, 'warnRatio' | 'usdToGbpRate'> & {
  warnRatio: string
  usdToGbpRate: string
}

function toStatus(row: StatusRow): AiBudgetStatus {
  return { ...row, warnRatio: Number(row.warnRatio), usdToGbpRate: Number(row.usdToGbpRate) }
}

/**
 * The budget period containing `now`: the owner-local calendar month from
 * owner_settings.timezone. Works as the owner (RLS allows reading owner_settings) or as service.
 */
export async function currentAiBudgetPeriod(tx: Tx, now: Date = new Date()): Promise<string> {
  const [row] = await tx<{ timezone: string }[]>`
    select timezone from public.owner_settings where singleton
  `
  if (!row) throw new Error('owner settings are missing (or not readable by this role)')
  return aiBudgetPeriod(now, row.timezone)
}

/** A period ('YYYY-MM'), or `{ now }` to use the owner-local month containing that instant. */
export type AiBudgetPeriodSelector = string | { now?: Date }

async function resolvePeriod(tx: Tx, selector: AiBudgetPeriodSelector | undefined): Promise<string> {
  if (typeof selector === 'string') return PeriodSchema.parse(selector)
  return currentAiBudgetPeriod(tx, selector?.now ?? new Date())
}

/**
 * Budget summary for Settings. Runs as the owner (`withOwner`): the database function checks
 * public.is_owner() and throws for anyone else. Without a period it reports the current
 * owner-local month.
 */
export async function getAiBudgetStatus(
  tx: Tx,
  period?: AiBudgetPeriodSelector,
): Promise<AiBudgetStatus> {
  const p = await resolvePeriod(tx, period)
  const [row] = await tx<StatusRow[]>`select * from public.ai_budget_status(${p})`
  if (!row) throw new Error('ai_budget_status returned no row')
  return toStatus(row)
}

/** The same summary for service contexts (jobs, tests). */
export async function getAiBudgetStatusAsService(
  tx: Tx,
  period?: AiBudgetPeriodSelector,
): Promise<AiBudgetStatus> {
  const p = await resolvePeriod(tx, period)
  const [row] = await tx<StatusRow[]>`select * from private.ai_budget_status(${p})`
  if (!row) throw new Error('ai_budget_status returned no row')
  return toStatus(row)
}
