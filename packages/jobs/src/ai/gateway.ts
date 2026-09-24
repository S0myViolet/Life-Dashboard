/**
 * The AI gateway: the only way jobs and server code call a model (brief §6, §8).
 *
 *   assert sources → (AI enabled?) → build prompt → estimate max cost → reserve (own committed
 *   transaction) → call → settle:
 *     ok        → reconcile at the cost from usageMetadata (missing usage → the reserved amount)
 *     ambiguous → mark ambiguous (reservation stays fully counted)
 *     not_sent  → release
 *     rejected  → reconcile at 0 (only for statuses documented as unbilled; none today)
 *
 * Source restrictions are applied before the prompt is built, the budget is reserved before
 * anything is sent, and a refused reservation returns `budget_exhausted` without any network
 * call. If the budget database itself is unavailable nothing is sent either (`ledger_unavailable`).
 * Callers fall back to deterministic output for every non-`ok` status. Invalid input (forbidden
 * sources, unknown models, bad limits) throws instead, before build() or fetch is called.
 */
import { z } from 'zod'
import {
  AI_DEFAULT_TEXT_MODEL,
  AI_DEFAULT_TRANSCRIBE_MODEL,
  AI_THINKING_ALLOWANCE_TOKENS,
  AI_THINKING_LEVELS,
  AiModelConfigError,
  AiPurposeSchema,
  AiSourcePolicyError,
  aiBudgetPeriod,
  aiResponseJsonSchema,
  aiTextTokensUpperBound,
  assertAiSourcesAllowed,
  computeAiUsageCostMicrosGbp,
  estimateMaxCostMicrosGbp,
  resolveAiModel,
  validateAiOutput,
  type AiBuiltPrompt,
  type AiModelConfig,
  type AiModelOverrides,
  type AiPurpose,
  type AiThinkingLevel,
  type AiTokenUsage,
} from '@personal-home/core'
import {
  getAiBudgetSettings,
  markAiUsageAmbiguous,
  reconcileAiUsage,
  releaseAiReservation,
  reserveAiBudget,
  sweepStaleAiReservations,
  withService,
  type AiBudgetSettings,
  type AiReservation,
  type Db,
} from '@personal-home/db'
import {
  GEMINI_MAX_INLINE_AUDIO_BYTES,
  geminiAudioSecondsUpperBound,
  geminiErrorCode,
  geminiGenerateContent,
  geminiTranscribe,
  geminiTranscriptOutputTokenBudget,
  normalizeGeminiAudioMimeType,
  type GeminiAudioMime,
  type GeminiFailure,
  type GeminiFetch,
  type GeminiOk,
  type GeminiResult,
  type GeminiTranscribeResult,
} from '@personal-home/integrations'

export interface AiGatewayDeps {
  db: Db
  fetch: GeminiFetch
  now: () => Date
  /** Owner's IANA timezone (owner_settings.timezone); the budget period is the local month. */
  timezone: string
  /** GEMINI_API_KEY from server configuration. Never logged or returned. */
  apiKey: string | null | undefined
  /** Price/limit overrides for configured model ids. */
  models?: AiModelOverrides
}

export type AiDisabledReason = 'no_api_key' | 'disabled_in_settings'

export type AiEnabledState =
  | { enabled: true; settings: AiBudgetSettings }
  | { enabled: false; reason: AiDisabledReason; settings: AiBudgetSettings | null }

/** AI is usable only when a key is configured and the owner has not switched it off. */
export async function aiEnabled(deps: Pick<AiGatewayDeps, 'db' | 'apiKey'>): Promise<AiEnabledState> {
  if (typeof deps.apiKey !== 'string' || deps.apiKey.trim() === '') {
    return { enabled: false, reason: 'no_api_key', settings: null }
  }
  const settings = await withService(deps.db, (tx) => getAiBudgetSettings(tx))
  return settings.enabled
    ? { enabled: true, settings }
    : { enabled: false, reason: 'disabled_in_settings', settings }
}

/**
 * What happened to the reservation: `none` (nothing was reserved), `reconciled`, `released`,
 * `ambiguous` (still fully counted) or `pending` (ledger write failed; the row stays reserved and
 * the stale sweep marks it ambiguous later).
 */
export type AiAccounting = 'none' | 'reconciled' | 'released' | 'ambiguous' | 'pending'

export interface AiBudgetExhausted {
  status: 'budget_exhausted'
  requiredMicros: number
  capMicros: number
  committedMicros: number
  remainingMicros: number
}

export interface AiDisabled {
  status: 'disabled'
  reason: AiDisabledReason
}

export interface AiFailed {
  status: 'failed'
  /** not_sent: released (or never reserved); ambiguous: still counted; rejected: settled at zero. */
  outcome: 'not_sent' | 'ambiguous' | 'rejected'
  /**
   * Client codes (e.g. 'timeout', 'http_503', 'connect_failed'), or gateway codes:
   * 'input_too_large' (refused before reserving) and 'ledger_unavailable' (the budget database
   * could not be reached, so nothing was sent).
   */
  code: string
  reservationId: string | null
  retryAfterMs: number | null
  accounting: AiAccounting
}

export type AiGatewayResult<T> =
  | {
      status: 'ok'
      value: T
      reservationId: string
      costMicros: number
      accounting: AiAccounting
      /** Budget at or above the warn ratio (80%) after this reservation. */
      warn: boolean
      /** Evidence id → caller ref, to turn citations back into records. */
      evidenceRefs: Record<string, string>
      droppedCitations: string[]
      strippedUrls: number
      inputTruncated: boolean
      omittedEvidence: string[]
    }
  | {
      status: 'invalid_output'
      reason: 'blocked' | 'max_tokens' | 'empty' | 'invalid_json' | 'schema_mismatch'
      reservationId: string
      costMicros: number
      accounting: AiAccounting
      warn: boolean
    }
  | AiBudgetExhausted
  | AiDisabled
  | AiFailed

export const AiRequestLimitsSchema = z.object({
  maxOutputTokens: z.number().int().min(1).max(65_536),
  /** Ceiling on the estimated input tokens; larger prompts are refused before reserving. */
  maxInputTokens: z.number().int().min(1).max(1_000_000).default(60_000),
  thinkingLevel: z.enum(AI_THINKING_LEVELS).optional(),
  /** Thinking tokens to reserve for; defaults to the allowance for the thinking level. */
  thinkingBudgetTokens: z.number().int().min(0).max(65_536).optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
})
export type AiRequestLimits = z.input<typeof AiRequestLimitsSchema>

export interface RunAiRequestInput<T> extends AiGatewayDeps {
  purpose: AiPurpose
  /** Every source type the prompt may contain. Checked before build() runs. */
  sources: readonly string[]
  /** Defaults to AI_DEFAULT_TEXT_MODEL. */
  model?: string
  /** Builds the prompt (use buildAiPrompt). Called only after the source check passes. */
  build: () => AiBuiltPrompt | Promise<AiBuiltPrompt>
  /** Validates the model's JSON output; also used to derive the response schema. */
  output: z.ZodType<T>
  limits: AiRequestLimits
}

function usageNumbers(
  usage: AiTokenUsage | null,
  extra: Record<string, number> = {},
): Record<string, number> {
  const out: Record<string, number> = { ...extra }
  if (usage) {
    for (const [k, v] of Object.entries(usage)) if (typeof v === 'number') out[k] = v
  }
  return out
}

async function settleFailure(
  db: Db,
  reservationId: string,
  failure: GeminiFailure,
): Promise<AiFailed> {
  const code = geminiErrorCode(failure)
  const retryAfterMs = failure.outcome === 'not_sent' ? null : failure.retryAfterMs
  let accounting: AiAccounting = 'pending'
  try {
    if (failure.outcome === 'not_sent') {
      await withService(db, (tx) => releaseAiReservation(tx, { id: reservationId, errorCode: code }))
      accounting = 'released'
    } else if (failure.outcome === 'rejected') {
      await withService(db, (tx) =>
        reconcileAiUsage(tx, { id: reservationId, actualMicros: 0, errorCode: code }),
      )
      accounting = 'reconciled'
    } else {
      await withService(db, (tx) => markAiUsageAmbiguous(tx, { id: reservationId, errorCode: code }))
      accounting = 'ambiguous'
    }
  } catch {
    // Ledger unavailable: the row stays 'reserved' (fully counted) and the stale sweep turns
    // it ambiguous later. Never guess in the cheaper direction.
  }
  return { status: 'failed', outcome: failure.outcome, code, reservationId, retryAfterMs, accounting }
}

async function settleSuccess(
  db: Db,
  reservationId: string,
  model: AiModelConfig,
  reservedMicros: number,
  rate: number,
  ok: GeminiOk,
  extraUsage: Record<string, number> = {},
): Promise<{ costMicros: number; accounting: AiAccounting }> {
  const computed = computeAiUsageCostMicrosGbp(model, ok.usage, rate)
  const costMicros = computed ?? reservedMicros
  try {
    await withService(db, (tx) =>
      reconcileAiUsage(tx, {
        id: reservationId,
        actualMicros: costMicros,
        usage: usageNumbers(ok.usage, extraUsage),
        errorCode: computed == null ? 'usage_missing' : null,
      }),
    )
    return { costMicros, accounting: 'reconciled' }
  } catch {
    return { costMicros, accounting: 'pending' }
  }
}

/** Errors that mean the caller passed something invalid; these are thrown, not reported. */
function isProgrammingError(err: unknown): boolean {
  return (
    err instanceof z.ZodError ||
    err instanceof AiSourcePolicyError ||
    err instanceof AiModelConfigError ||
    err instanceof RangeError
  )
}

/** The budget ledger could not be read or written, so no model call is made. */
function ledgerUnavailable(accounting: AiAccounting): AiFailed {
  return {
    status: 'failed',
    outcome: 'not_sent',
    code: 'ledger_unavailable',
    reservationId: null,
    retryAfterMs: null,
    accounting,
  }
}

/** aiEnabled() for the gateway: a database failure becomes a typed result, not an exception. */
async function enabledOrUnavailable(
  deps: Pick<AiGatewayDeps, 'db' | 'apiKey'>,
): Promise<AiEnabledState | AiFailed> {
  try {
    return await aiEnabled(deps)
  } catch (err) {
    if (isProgrammingError(err)) throw err
    return ledgerUnavailable('none')
  }
}

async function reserve(
  deps: AiGatewayDeps,
  args: {
    purpose: AiPurpose
    model: AiModelConfig
    sources: readonly string[]
    maxMicros: number
    rate: number
    usage: Record<string, number>
  },
): Promise<
  { ok: true; reservation: AiReservation } | { ok: false; result: AiBudgetExhausted | AiDisabled | AiFailed }
> {
  const period = aiBudgetPeriod(deps.now(), deps.timezone)
  let reservation: AiReservation
  try {
    reservation = await withService(deps.db, (tx) =>
      reserveAiBudget(tx, {
        period,
        purpose: args.purpose,
        model: args.model.id,
        sourceTypes: [...new Set(args.sources)],
        maxMicros: args.maxMicros,
        usdToGbpRate: args.rate,
        usage: args.usage,
      }),
    )
  } catch (err) {
    if (isProgrammingError(err)) throw err
    // Database unreachable or the transaction failed. Nothing is sent. If the commit did land
    // before the connection dropped, the row stays 'reserved' (fully counted) until the sweep.
    return { ok: false, result: ledgerUnavailable('pending') }
  }
  if (reservation.allowed && reservation.reservationId) return { ok: true, reservation }
  if (reservation.reason === 'disabled') {
    return { ok: false, result: { status: 'disabled', reason: 'disabled_in_settings' } }
  }
  return {
    ok: false,
    result: {
      status: 'budget_exhausted',
      requiredMicros: args.maxMicros,
      capMicros: reservation.capMicros,
      committedMicros: reservation.committedMicros,
      remainingMicros: reservation.remainingMicros,
    },
  }
}

function modelOfKind(id: string, kind: AiModelConfig['kind'], overrides?: AiModelOverrides): AiModelConfig {
  const model = resolveAiModel(id, overrides)
  if (model.kind !== kind) {
    throw new AiModelConfigError(`model ${model.id} is not a ${kind} model`)
  }
  return model
}

/** Run one bounded, budgeted, source-restricted text request. */
export async function runAiRequest<T>(input: RunAiRequestInput<T>): Promise<AiGatewayResult<T>> {
  // 1. Source policy, before the prompt exists.
  assertAiSourcesAllowed(input.sources)
  const purpose = AiPurposeSchema.parse(input.purpose)
  const limits = AiRequestLimitsSchema.parse(input.limits)
  const model = modelOfKind(input.model ?? AI_DEFAULT_TEXT_MODEL, 'text', input.models)

  // 2. Configured and switched on? (A database outage is reported, not thrown.)
  const state = await enabledOrUnavailable(input)
  if ('status' in state) return state
  if (!state.enabled) return { status: 'disabled', reason: state.reason }
  const rate = state.settings.usdToGbpRate

  // 3. Build, then re-check what actually ended up in the prompt.
  const prompt = await input.build()
  assertAiSourcesAllowed(prompt.sourceTypes)
  const undeclared = prompt.sourceTypes.filter((s) => !input.sources.includes(s))
  if (undeclared.length > 0) throw new AiSourcePolicyError(undeclared.map((s) => `${s} (undeclared)`))

  // 4. Conservative maximum cost.
  const responseJsonSchema = aiResponseJsonSchema(input.output)
  const maxInputTokens =
    aiTextTokensUpperBound(prompt.systemInstruction) +
    aiTextTokensUpperBound(prompt.userText) +
    // The API may expand the schema internally; count it twice.
    2 * aiTextTokensUpperBound(JSON.stringify(responseJsonSchema))
  if (maxInputTokens > limits.maxInputTokens) {
    return {
      status: 'failed',
      outcome: 'not_sent',
      code: 'input_too_large',
      reservationId: null,
      retryAfterMs: null,
      accounting: 'none',
    }
  }
  const thinkingLevel: AiThinkingLevel | null =
    model.thinking === 'level' ? (limits.thinkingLevel ?? model.defaultThinkingLevel ?? 'MINIMAL') : null
  const thinkingAllowance =
    limits.thinkingBudgetTokens ?? (thinkingLevel ? AI_THINKING_ALLOWANCE_TOKENS[thinkingLevel] : 0)
  const maxMicros = estimateMaxCostMicrosGbp({
    model,
    maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    thinkingBudgetTokens: thinkingAllowance,
    usdToGbpRate: rate,
  })

  // 5. Reserve in its own committed transaction; refusal means no network call at all.
  const reserved = await reserve(input, {
    purpose,
    model,
    sources: input.sources,
    maxMicros,
    rate,
    usage: {
      maxInputTokens,
      maxOutputTokens: limits.maxOutputTokens,
      thinkingAllowanceTokens: thinkingAllowance,
    },
  })
  if (!reserved.ok) return reserved.result
  const { reservation } = reserved
  const reservationId = reservation.reservationId!

  // 6. Call.
  let result: GeminiResult
  try {
    result = await geminiGenerateContent(
      { apiKey: input.apiKey!, fetch: input.fetch },
      {
        model: model.id,
        systemInstruction: prompt.systemInstruction,
        userText: prompt.userText,
        maxOutputTokens: limits.maxOutputTokens,
        thinking: thinkingLevel ? { level: thinkingLevel } : null,
        responseJsonSchema,
        temperature: limits.temperature,
        timeoutMs: limits.timeoutMs,
      },
    )
  } catch {
    // Unexpected failure inside the client: we cannot prove it was not sent.
    result = { outcome: 'ambiguous', code: 'network_error', httpStatus: null, providerStatus: null, retryAfterMs: null } as const
  }

  // 7. Settle.
  if (result.outcome !== 'ok') return settleFailure(input.db, reservationId, result)
  const { costMicros, accounting } = await settleSuccess(
    input.db,
    reservationId,
    model,
    maxMicros,
    rate,
    result,
  )

  const common = { reservationId, costMicros, accounting, warn: reservation.warn }
  if (result.blockReason) return { status: 'invalid_output', reason: 'blocked', ...common }
  const validated = validateAiOutput(result.text, input.output, {
    evidenceIds: prompt.evidenceIds,
    allowedUrls: prompt.allowedUrls,
  })
  if (!validated.ok) {
    const reason = result.finishReason === 'MAX_TOKENS' ? 'max_tokens' : validated.error
    return { status: 'invalid_output', reason, ...common }
  }
  return {
    status: 'ok',
    value: validated.value,
    ...common,
    evidenceRefs: prompt.evidenceRefs,
    droppedCitations: validated.droppedCitations,
    strippedUrls: validated.strippedUrls,
    inputTruncated: prompt.truncated,
    omittedEvidence: prompt.omittedRefs,
  }
}

export interface RunAiTranscriptionInput extends AiGatewayDeps {
  /** Defaults to ['journal_recording']. */
  sources?: readonly string[]
  /** Defaults to AI_DEFAULT_TRANSCRIBE_MODEL. */
  model?: string
  audio: Uint8Array
  mimeType: string
  /** Duration measured by the recorder. */
  audioSeconds: number
  languageCodes?: string[]
  limits?: { maxOutputTokens?: number; timeoutMs?: number }
}

export type AiTranscriptionResult =
  | {
      status: 'ok'
      transcript: string
      /** HTTP 200 with no transcript (reported on the live API): keep the recording, offer retry. */
      empty: boolean
      /** Output hit the token limit; the transcript may be cut short. */
      truncated: boolean
      audio: GeminiAudioMime
      reservationId: string
      costMicros: number
      accounting: AiAccounting
      warn: boolean
    }
  | AiBudgetExhausted
  | AiDisabled
  | AiFailed

/** Transcribe one recording under the same budget and source rules. */
export async function runAiTranscription(input: RunAiTranscriptionInput): Promise<AiTranscriptionResult> {
  const sources = input.sources ?? ['journal_recording']
  assertAiSourcesAllowed(sources)
  const model = modelOfKind(input.model ?? AI_DEFAULT_TRANSCRIBE_MODEL, 'transcribe', input.models)
  if (!Number.isFinite(input.audioSeconds) || input.audioSeconds < 0) {
    throw new RangeError('audioSeconds must be a non-negative number')
  }

  const state = await enabledOrUnavailable(input)
  if ('status' in state) return state
  if (!state.enabled) return { status: 'disabled', reason: state.reason }
  const rate = state.settings.usdToGbpRate

  // Refuse what the client would refuse, before reserving anything.
  const notSent = (code: string): AiFailed => ({
    status: 'failed',
    outcome: 'not_sent',
    code,
    reservationId: null,
    retryAfterMs: null,
    accounting: 'none',
  })
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0) return notSent('invalid_request')
  if (input.audio.byteLength > GEMINI_MAX_INLINE_AUDIO_BYTES) return notSent('audio_too_large')
  if (!normalizeGeminiAudioMimeType(input.mimeType)) return notSent('unsupported_audio_type')

  // Reserve for the longer of the reported duration (+25%) and a size-derived bound, so a wrong
  // client duration cannot shrink the reservation.
  const reportedSeconds = input.audioSeconds * 1.25 + 10
  const reserveSeconds = Math.max(reportedSeconds, geminiAudioSecondsUpperBound(input.audio.byteLength))
  const maxOutputTokens =
    input.limits?.maxOutputTokens ?? geminiTranscriptOutputTokenBudget(reportedSeconds)
  const maxInputTokens = 256 // request framing; the audio itself is priced per second below
  const maxMicros = estimateMaxCostMicrosGbp({
    model,
    maxInputTokens,
    maxOutputTokens,
    audioSeconds: reserveSeconds,
    usdToGbpRate: rate,
  })

  const reserved = await reserve(input, {
    purpose: 'transcription',
    model,
    sources,
    maxMicros,
    rate,
    usage: {
      audioSeconds: input.audioSeconds,
      reservedAudioSeconds: Math.ceil(reserveSeconds),
      audioBytes: input.audio.byteLength,
      maxOutputTokens,
    },
  })
  if (!reserved.ok) return reserved.result
  const reservationId = reserved.reservation.reservationId!

  let result: GeminiTranscribeResult
  try {
    result = await geminiTranscribe(
      { apiKey: input.apiKey!, fetch: input.fetch },
      {
        model: model.id,
        audio: input.audio,
        mimeType: input.mimeType,
        maxOutputTokens,
        languageCodes: input.languageCodes,
        timeoutMs: input.limits?.timeoutMs,
      },
    )
  } catch {
    result = { outcome: 'ambiguous', code: 'network_error', httpStatus: null, providerStatus: null, retryAfterMs: null } as const
  }
  if (result.outcome !== 'ok') return settleFailure(input.db, reservationId, result)

  const { costMicros, accounting } = await settleSuccess(
    input.db,
    reservationId,
    model,
    maxMicros,
    rate,
    result,
  )
  return {
    status: 'ok',
    transcript: result.text,
    empty: result.emptyTranscript,
    truncated: result.finishReason === 'MAX_TOKENS',
    audio: result.audio,
    reservationId,
    costMicros,
    accounting,
    warn: reserved.reservation.warn,
  }
}

/**
 * `ai.reconcile` job: reservations left 'reserved' for over 24 hours (a worker died mid-call)
 * become 'ambiguous' so they stay counted and show up for review. Never releases anything.
 */
export async function runAiReconcileJob(deps: { db: Db; now: () => Date }): Promise<{ swept: number }> {
  const swept = await withService(deps.db, (tx) =>
    sweepStaleAiReservations(tx, { olderThanHours: 24, now: deps.now() }),
  )
  return { swept }
}
