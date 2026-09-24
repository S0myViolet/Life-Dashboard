/**
 * Gemini model catalogue used for budget reservations and reconciliation.
 *
 * Prices are data, not code: USD per 1M tokens, as published on the pricing page on
 * `AI_PRICES_AS_OF` (docs/research/gemini.md). They were collected from search snippets of
 * https://ai.google.dev/gemini-api/docs/pricing because the build container cannot reach it,
 * so every value below errs upward where the sources disagree. Recheck before relying on the
 * numbers and override them with `resolveAiModel(id, overrides)` instead of editing call sites.
 */
import { z } from 'zod'

export const AI_PRICES_AS_OF = '2026-09-24'
export const AI_PRICES_SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing'

/** Default model ids by role. Both were confirmed to exist on 2026-09-24 (docs/research/gemini.md). */
export const AI_DEFAULT_TEXT_MODEL = 'gemini-3.5-flash-lite'
export const AI_DEFAULT_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe'

export const AI_THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const
export type AiThinkingLevel = (typeof AI_THINKING_LEVELS)[number]

/**
 * Thinking tokens assumed per level when reserving budget. Gemini 3.x has no documented hard
 * cap on thinking at a given level, so these are reservation allowances, not limits: if a
 * response thinks more, reconciliation records the real (higher) cost.
 */
export const AI_THINKING_ALLOWANCE_TOKENS: Record<AiThinkingLevel, number> = {
  MINIMAL: 2_048,
  LOW: 8_192,
  MEDIUM: 16_384,
  HIGH: 32_768,
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/

export const AiModelIdSchema = z.string().regex(MODEL_ID_RE, 'invalid model id')

const PriceSchema = z.number().positive().max(1_000)

export const AiModelConfigSchema = z.object({
  id: AiModelIdSchema,
  /** `text`: generateContent with text prompts. `transcribe`: speech-to-text on audio input. */
  kind: z.enum(['text', 'transcribe']),
  usdPer1M: z.object({
    textInput: PriceSchema,
    audioInput: PriceSchema,
    /** Output tokens, including thinking tokens (billed at the output rate). */
    output: PriceSchema,
  }),
  /** Conservative audio tokenisation rate used for reservations. */
  audioTokensPerSecond: z.number().int().positive().max(1_000),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  /** `level`: send thinkingConfig.thinkingLevel. `none`: send no thinking config. */
  thinking: z.enum(['level', 'none']),
  defaultThinkingLevel: z.enum(AI_THINKING_LEVELS).nullable(),
  pricesAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  priceSourceUrl: z.url({ protocol: /^https$/ }),
})
export type AiModelConfig = z.infer<typeof AiModelConfigSchema>

/**
 * Audio: the docs publish 32 tokens/second (audio + tokens pages) and 25 tokens/second (transcribe
 * pricing estimate). Reservations use the higher figure.
 */
const AUDIO_TOKENS_PER_SECOND = 32

export const AI_MODELS: Readonly<Record<string, AiModelConfig>> = Object.freeze({
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    kind: 'text',
    // $0.30 text/image/video/audio input, $2.50 output incl. thinking. One source listed $0.50
    // for audio input (3.1 Flash-Lite's rate); until the pricing row is verified the higher
    // audio figure is used.
    usdPer1M: { textInput: 0.3, audioInput: 0.5, output: 2.5 },
    audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    thinking: 'level',
    // Flash-Lite 3.x cannot disable thinking; MINIMAL is the lowest level.
    defaultThinkingLevel: 'MINIMAL',
    pricesAsOf: AI_PRICES_AS_OF,
    priceSourceUrl: AI_PRICES_SOURCE_URL,
  },
  'gemini-3.5-transcribe': {
    id: 'gemini-3.5-transcribe',
    kind: 'transcribe',
    // $2.00 audio input, $12.00 text output. No separate text-input price is published, so text
    // input is charged at the audio rate.
    usdPer1M: { textInput: 2, audioInput: 2, output: 12 },
    audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    thinking: 'none',
    defaultThinkingLevel: null,
    pricesAsOf: AI_PRICES_AS_OF,
    priceSourceUrl: AI_PRICES_SOURCE_URL,
  },
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    kind: 'text',
    // Cheaper for text-only work: $0.25 text input, $0.50 audio input, $1.50 output.
    usdPer1M: { textInput: 0.25, audioInput: 0.5, output: 1.5 },
    audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    thinking: 'level',
    defaultThinkingLevel: 'MINIMAL',
    pricesAsOf: AI_PRICES_AS_OF,
    priceSourceUrl: AI_PRICES_SOURCE_URL,
  },
} satisfies Record<string, AiModelConfig>)

/** Per-model overrides: a partial patch for a known model, or a full entry for a new one. */
export type AiModelOverrides = Readonly<
  Record<
    string,
    Partial<Omit<AiModelConfig, 'usdPer1M'>> & { usdPer1M?: Partial<AiModelConfig['usdPer1M']> }
  >
>

export class AiModelConfigError extends Error {
  override name = 'AiModelConfigError'
}

/**
 * Resolve a model id to its pricing/limits. A model that cannot be priced cannot be reserved
 * for, so unknown ids without a complete override throw instead of guessing.
 */
export function resolveAiModel(id: string, overrides?: AiModelOverrides): AiModelConfig {
  if (!MODEL_ID_RE.test(id)) throw new AiModelConfigError('invalid model id')
  const base = Object.hasOwn(AI_MODELS, id) ? AI_MODELS[id] : undefined
  const patch = overrides && Object.hasOwn(overrides, id) ? overrides[id] : undefined
  if (!base && !patch) {
    throw new AiModelConfigError(`no pricing configured for model ${id}`)
  }
  const merged = {
    ...base,
    ...patch,
    id,
    usdPer1M: { ...base?.usdPer1M, ...patch?.usdPer1M },
  }
  const parsed = AiModelConfigSchema.safeParse(merged)
  if (!parsed.success) {
    throw new AiModelConfigError(
      `incomplete or invalid configuration for model ${id}: ${parsed.error.issues
        .map((i) => i.path.join('.') || i.message)
        .join(', ')}`,
    )
  }
  return parsed.data
}
