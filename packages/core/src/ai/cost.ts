/**
 * Cost arithmetic for AI budget reservations. Money is integer GBP micros (1 GBP = 1_000_000).
 * All intermediate maths is exact (BigInt) and every conversion rounds up, so an estimate is
 * never below the true figure for the given token counts and prices.
 */
import { utf8 } from '../crypto/encoding.ts'
import { resolveAiModel, type AiModelConfig, type AiModelOverrides } from './models.ts'

/**
 * Default USD→GBP conversion: 1 USD = 1.00 GBP.
 *
 * This deliberately overestimates the GBP cost of USD-priced usage: sterling has never traded
 * below parity with the dollar (its all-time low was about 1.035 USD in September 2022), so at
 * any historical rate 1.00 converts to at least the true GBP amount. VAT and card FX fees are
 * not included; the brief's tax/FX headroom row covers those. Configure a tighter rate in
 * `private.ai_budget_settings.usd_to_gbp_rate` if wanted (the database refuses values below 0.5).
 */
export const AI_DEFAULT_USD_TO_GBP_RATE = 1

export const AI_GBP_MICROS_PER_GBP = 1_000_000

const MILLION = 1_000_000n

function ceilDiv(a: bigint, b: bigint): bigint {
  if (a <= 0n) return 0n
  return (a + b - 1n) / b
}

function toSafeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('cost exceeds safe integer range')
  return Number(n)
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

/** USD per 1M tokens → integer micro-USD per 1M tokens, rounded up. */
function priceMicros(usdPer1M: number): bigint {
  // Round to the nearest micro first to absorb float noise (0.3 * 1e6 = 300000.00000000006).
  return BigInt(Math.ceil(Math.round(usdPer1M * 1e9) / 1e3))
}

/** GBP per USD → integer parts-per-million, rounded up (conservative). */
function rateMicros(usdToGbpRate: number): bigint {
  if (!Number.isFinite(usdToGbpRate) || usdToGbpRate <= 0 || usdToGbpRate > 10) {
    throw new RangeError('usdToGbpRate must be a positive number no greater than 10')
  }
  return BigInt(Math.ceil(Math.round(usdToGbpRate * 1e9) / 1e3))
}

/** Convert micro-USD to micro-GBP at `usdToGbpRate` GBP per USD, rounding up. */
export function usdToGbpMicros(usdMicros: number, usdToGbpRate = AI_DEFAULT_USD_TO_GBP_RATE): number {
  assertCount('usdMicros', usdMicros)
  return toSafeNumber(ceilDiv(BigInt(usdMicros) * rateMicros(usdToGbpRate), MILLION))
}

/**
 * `numerator` is micro-USD × 1e6 (tokens × micro-USD-per-1M-tokens). Convert straight to GBP
 * micros with a single rounding step.
 */
function numeratorToGbpMicros(numerator: bigint, usdToGbpRate: number): number {
  return toSafeNumber(ceilDiv(numerator * rateMicros(usdToGbpRate), MILLION * MILLION))
}

function model(m: string | AiModelConfig, overrides?: AiModelOverrides): AiModelConfig {
  return typeof m === 'string' ? resolveAiModel(m, overrides) : m
}

export interface AiMaxCostInput {
  model: string | AiModelConfig
  /** Upper bound on text (non-audio) prompt tokens, including system instruction and schema. */
  maxInputTokens: number
  maxOutputTokens: number
  /** Thinking tokens to allow for; billed at the output rate. */
  thinkingBudgetTokens?: number
  /** Audio duration; tokenised at the model's (conservative) tokens-per-second rate. */
  audioSeconds?: number
  usdToGbpRate?: number
  models?: AiModelOverrides
}

/** Audio tokens for a clip, rounding the duration up to whole seconds. */
export function aiAudioTokensUpperBound(cfg: AiModelConfig, audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds < 0) {
    throw new RangeError('audioSeconds must be a non-negative number')
  }
  return Math.ceil(audioSeconds) * cfg.audioTokensPerSecond
}

/**
 * Conservative upper bound on the GBP cost of one request: every input token at its rate, the
 * whole output allowance plus the thinking allowance at the output rate, audio at the higher
 * published tokens-per-second rate, then converted at a rate that overestimates GBP.
 */
export function estimateMaxCostMicrosGbp(input: AiMaxCostInput): number {
  const cfg = model(input.model, input.models)
  const thinking = input.thinkingBudgetTokens ?? 0
  assertCount('maxInputTokens', input.maxInputTokens)
  assertCount('maxOutputTokens', input.maxOutputTokens)
  assertCount('thinkingBudgetTokens', thinking)
  const audioTokens = aiAudioTokensUpperBound(cfg, input.audioSeconds ?? 0)

  const numerator =
    BigInt(input.maxInputTokens) * priceMicros(cfg.usdPer1M.textInput) +
    BigInt(audioTokens) * priceMicros(cfg.usdPer1M.audioInput) +
    BigInt(input.maxOutputTokens + thinking) * priceMicros(cfg.usdPer1M.output)
  return numeratorToGbpMicros(numerator, input.usdToGbpRate ?? AI_DEFAULT_USD_TO_GBP_RATE)
}

/** Token counts reported by the provider for one request. `null` = not reported. */
export interface AiTokenUsage {
  promptTokens: number | null
  /** Prompt tokens whose modality was AUDIO, when the provider broke them down. */
  promptAudioTokens: number | null
  candidatesTokens: number | null
  thoughtsTokens: number | null
  toolUsePromptTokens: number | null
  cachedTokens: number | null
  totalTokens: number | null
}

/** True when the provider reported no token counts at all. */
export function aiUsageIsMissing(usage: AiTokenUsage | null | undefined): boolean {
  if (!usage) return true
  return (
    usage.promptTokens == null &&
    usage.candidatesTokens == null &&
    usage.thoughtsTokens == null &&
    usage.totalTokens == null
  )
}

/**
 * Actual cost of a completed request from reported usage, in GBP micros (rounded up).
 * Returns null when usage is missing, so the caller can keep the reserved amount instead.
 *
 * Conservative choices: without a modality breakdown every prompt token is charged at the
 * higher of the text/audio rates; cached tokens are charged at the full input rate; any part of
 * totalTokenCount not explained by the other fields is charged at the output rate.
 */
export function computeAiUsageCostMicrosGbp(
  modelOrId: string | AiModelConfig,
  usage: AiTokenUsage | null | undefined,
  usdToGbpRate = AI_DEFAULT_USD_TO_GBP_RATE,
  models?: AiModelOverrides,
): number | null {
  if (!usage || aiUsageIsMissing(usage)) return null
  const cfg = model(modelOrId, models)
  const n = (v: number | null) => {
    if (v == null) return 0
    assertCount('token count', v)
    return v
  }
  const prompt = n(usage.promptTokens)
  const toolUse = n(usage.toolUsePromptTokens)
  const candidates = n(usage.candidatesTokens)
  const thoughts = n(usage.thoughtsTokens)
  const total = n(usage.totalTokens)

  const textPrice = priceMicros(cfg.usdPer1M.textInput)
  const audioPrice = priceMicros(cfg.usdPer1M.audioInput)
  const outputPrice = priceMicros(cfg.usdPer1M.output)
  const maxInputPrice = textPrice > audioPrice ? textPrice : audioPrice

  let numerator = 0n
  if (usage.promptAudioTokens != null) {
    const audio = Math.min(n(usage.promptAudioTokens), prompt)
    numerator += BigInt(audio) * audioPrice + BigInt(prompt - audio) * textPrice
  } else {
    numerator += BigInt(prompt) * maxInputPrice
  }
  numerator += BigInt(toolUse) * textPrice
  numerator += BigInt(candidates + thoughts) * outputPrice
  const unexplained = total - (prompt + toolUse + candidates + thoughts)
  if (unexplained > 0) numerator += BigInt(unexplained) * outputPrice

  return numeratorToGbpMicros(numerator, usdToGbpRate)
}

/**
 * Upper bound on the tokens a piece of text can occupy. Gemini's tokenizer falls back to one
 * token per UTF-8 byte for unknown characters and otherwise covers at least one character per
 * token, so the byte length bounds the count; a small allowance covers turn/role markers.
 */
export function aiTextTokensUpperBound(text: string): number {
  return utf8(text).length + 16
}
