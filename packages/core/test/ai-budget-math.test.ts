import { describe, expect, it } from 'vitest'
import {
  AI_DEFAULT_TEXT_MODEL,
  AI_DEFAULT_TRANSCRIBE_MODEL,
  AI_DEFAULT_USD_TO_GBP_RATE,
  AI_MODELS,
  AI_PRICES_AS_OF,
  AiModelConfigError,
  aiBudgetPeriod,
  aiTextTokensUpperBound,
  computeAiUsageCostMicrosGbp,
  estimateMaxCostMicrosGbp,
  isAiBudgetPeriod,
  resolveAiModel,
  usdToGbpMicros,
  type AiTokenUsage,
} from '../src/index.ts'

const usage = (u: Partial<AiTokenUsage>): AiTokenUsage => ({
  promptTokens: null,
  promptAudioTokens: null,
  candidatesTokens: null,
  thoughtsTokens: null,
  toolUsePromptTokens: null,
  cachedTokens: null,
  totalTokens: null,
  ...u,
})

describe('model catalogue', () => {
  it('defaults to the model ids named in the brief, with dated prices and a source', () => {
    expect(AI_DEFAULT_TEXT_MODEL).toBe('gemini-3.5-flash-lite')
    expect(AI_DEFAULT_TRANSCRIBE_MODEL).toBe('gemini-3.5-transcribe')
    for (const m of Object.values(AI_MODELS)) {
      expect(m.pricesAsOf).toBe(AI_PRICES_AS_OF)
      expect(m.priceSourceUrl).toMatch(/^https:\/\/ai\.google\.dev\//)
      expect(resolveAiModel(m.id)).toEqual(m)
    }
  })

  it('refuses to price an unknown model instead of guessing', () => {
    expect(() => resolveAiModel('gemini-9-ultra')).toThrow(AiModelConfigError)
    expect(() => resolveAiModel('../../v1/files')).toThrow(AiModelConfigError)
  })

  it('accepts price overrides and complete entries for new models', () => {
    const patched = resolveAiModel('gemini-3.5-flash-lite', {
      'gemini-3.5-flash-lite': { usdPer1M: { audioInput: 0.3 } },
    })
    expect(patched.usdPer1M).toEqual({ textInput: 0.3, audioInput: 0.3, output: 2.5 })

    const added = resolveAiModel('gemini-3.8-flash', {
      'gemini-3.8-flash': {
        kind: 'text',
        usdPer1M: { textInput: 1.5, audioInput: 1.5, output: 7.5 },
        audioTokensPerSecond: 32,
        maxInputTokens: 1_048_576,
        maxOutputTokens: 65_536,
        thinking: 'level',
        defaultThinkingLevel: 'LOW',
        pricesAsOf: '2026-09-24',
        priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      },
    })
    expect(added.id).toBe('gemini-3.8-flash')

    expect(() =>
      resolveAiModel('gemini-3.8-flash', { 'gemini-3.8-flash': { usdPer1M: { output: 7.5 } } }),
    ).toThrow(/incomplete or invalid/)
    expect(() =>
      resolveAiModel('gemini-3.5-flash-lite', {
        'gemini-3.5-flash-lite': { usdPer1M: { output: -1 } },
      }),
    ).toThrow(AiModelConfigError)
  })
})

describe('estimateMaxCostMicrosGbp', () => {
  it('charges input, output and thinking at list prices and converts at the default rate', () => {
    // 10,000 × $0.30/1M = 3,000 µ$; (1,000 + 2,048) × $2.50/1M = 7,620 µ$
    expect(
      estimateMaxCostMicrosGbp({
        model: 'gemini-3.5-flash-lite',
        maxInputTokens: 10_000,
        maxOutputTokens: 1_000,
        thinkingBudgetTokens: 2_048,
      }),
    ).toBe(10_620)
    expect(AI_DEFAULT_USD_TO_GBP_RATE).toBe(1)
    expect(
      estimateMaxCostMicrosGbp({
        model: 'gemini-3.5-flash-lite',
        maxInputTokens: 10_000,
        maxOutputTokens: 1_000,
        thinkingBudgetTokens: 2_048,
        usdToGbpRate: 0.8,
      }),
    ).toBe(8_496)
  })

  it('bills thinking as output', () => {
    const base = { model: 'gemini-3.5-flash-lite', maxInputTokens: 0, maxOutputTokens: 1_000 }
    const withThinking = estimateMaxCostMicrosGbp({ ...base, thinkingBudgetTokens: 1_000 })
    expect(withThinking).toBe(2 * estimateMaxCostMicrosGbp(base))
  })

  it('rounds audio up to whole seconds at 32 tokens/second', () => {
    // ceil(61.2) = 62 s × 32 = 1,984 audio tokens × $2 = 3,968 µ$; 100 text × $2 = 200; 500 out × $12 = 6,000
    expect(
      estimateMaxCostMicrosGbp({
        model: 'gemini-3.5-transcribe',
        maxInputTokens: 100,
        maxOutputTokens: 500,
        audioSeconds: 61.2,
      }),
    ).toBe(10_168)
  })

  it('always rounds up and never returns less than a micro for a non-empty request', () => {
    expect(
      estimateMaxCostMicrosGbp({ model: 'gemini-3.5-flash-lite', maxInputTokens: 1, maxOutputTokens: 0 }),
    ).toBe(1)
    expect(
      estimateMaxCostMicrosGbp({ model: 'gemini-3.5-flash-lite', maxInputTokens: 0, maxOutputTokens: 0 }),
    ).toBe(0)
  })

  it('rejects nonsense limits', () => {
    const m = 'gemini-3.5-flash-lite'
    expect(() => estimateMaxCostMicrosGbp({ model: m, maxInputTokens: -1, maxOutputTokens: 1 })).toThrow()
    expect(() => estimateMaxCostMicrosGbp({ model: m, maxInputTokens: 1.5, maxOutputTokens: 1 })).toThrow()
    expect(() =>
      estimateMaxCostMicrosGbp({ model: m, maxInputTokens: 1, maxOutputTokens: 1, audioSeconds: NaN }),
    ).toThrow()
    expect(() =>
      estimateMaxCostMicrosGbp({ model: m, maxInputTokens: 1, maxOutputTokens: 1, usdToGbpRate: 0 }),
    ).toThrow()
  })

  it('is never below the actual cost of any usage within the limits', () => {
    const model = resolveAiModel('gemini-3.5-flash-lite')
    let seed = 42
    const rnd = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed % (max + 1)
    }
    for (let i = 0; i < 500; i++) {
      const maxIn = rnd(50_000)
      const maxOut = rnd(8_000)
      const thinking = rnd(4_000)
      const audioSeconds = rnd(600)
      const audioTokens = rnd(audioSeconds * 32)
      const prompt = rnd(maxIn) + audioTokens
      const est = estimateMaxCostMicrosGbp({
        model,
        maxInputTokens: maxIn,
        maxOutputTokens: maxOut,
        thinkingBudgetTokens: thinking,
        audioSeconds,
        usdToGbpRate: 0.79,
      })
      const actual = computeAiUsageCostMicrosGbp(
        model,
        usage({
          promptTokens: prompt,
          promptAudioTokens: audioTokens,
          candidatesTokens: rnd(maxOut),
          thoughtsTokens: rnd(thinking),
        }),
        0.79,
      )
      expect(actual).not.toBeNull()
      expect(est).toBeGreaterThanOrEqual(actual!)
    }
  })
})

describe('usdToGbpMicros', () => {
  it('converts with a configurable rate and rounds up', () => {
    expect(usdToGbpMicros(1_000_000, 0.79)).toBe(790_000)
    expect(usdToGbpMicros(1, 0.79)).toBe(1)
    expect(usdToGbpMicros(0, 0.79)).toBe(0)
    expect(usdToGbpMicros(1_000_000)).toBe(1_000_000)
    expect(() => usdToGbpMicros(1, -1)).toThrow()
    expect(() => usdToGbpMicros(-1, 1)).toThrow()
  })
})

describe('computeAiUsageCostMicrosGbp', () => {
  it('bills thoughtsTokenCount at the output rate', () => {
    // 1,000 × 0.30 + (200 + 300) × 2.50 = 300 + 1,250
    expect(
      computeAiUsageCostMicrosGbp(
        'gemini-3.5-flash-lite',
        usage({
          promptTokens: 1_000,
          promptAudioTokens: 0,
          candidatesTokens: 200,
          thoughtsTokens: 300,
          totalTokens: 1_500,
        }),
      ),
    ).toBe(1_550)
  })

  it('prices audio and text prompt tokens separately when the modality breakdown is present', () => {
    // 1,920 audio × $2 + 12 text × $2 + 175 × $12
    expect(
      computeAiUsageCostMicrosGbp(
        'gemini-3.5-transcribe',
        usage({ promptTokens: 1_932, promptAudioTokens: 1_920, candidatesTokens: 175, totalTokens: 2_107 }),
      ),
    ).toBe(3_840 + 24 + 2_100)
  })

  it('charges unbroken-down prompt tokens at the higher input rate', () => {
    // flash-lite: text $0.30, audio $0.50 → 1,000 × 0.50
    expect(
      computeAiUsageCostMicrosGbp('gemini-3.5-flash-lite', usage({ promptTokens: 1_000, candidatesTokens: 0 })),
    ).toBe(500)
  })

  it('charges tokens that the breakdown does not explain at the output rate', () => {
    expect(
      computeAiUsageCostMicrosGbp(
        'gemini-3.5-flash-lite',
        usage({ promptTokens: 1_000, promptAudioTokens: 0, candidatesTokens: 500, totalTokens: 2_000 }),
      ),
    ).toBe(300 + 500 * 2.5 + 500 * 2.5)
  })

  it('returns null when usage is missing so the reservation stands', () => {
    expect(computeAiUsageCostMicrosGbp('gemini-3.5-flash-lite', null)).toBeNull()
    expect(computeAiUsageCostMicrosGbp('gemini-3.5-flash-lite', usage({}))).toBeNull()
  })
})

describe('aiTextTokensUpperBound', () => {
  it('is at least the UTF-8 byte length', () => {
    expect(aiTextTokensUpperBound('abc')).toBeGreaterThanOrEqual(3)
    expect(aiTextTokensUpperBound('€€')).toBeGreaterThanOrEqual(6)
    expect(aiTextTokensUpperBound('😀')).toBeGreaterThanOrEqual(4)
  })
})

describe('aiBudgetPeriod (owner-local calendar month)', () => {
  const tz = 'Europe/London'
  it('rolls over at local midnight on the 1st in GMT', () => {
    expect(aiBudgetPeriod(new Date('2026-01-31T23:59:59.999Z'), tz)).toBe('2026-01')
    expect(aiBudgetPeriod(new Date('2026-02-01T00:00:00.000Z'), tz)).toBe('2026-02')
  })

  it('rolls over at local midnight in BST (UTC+1), an hour before UTC does', () => {
    // BST started 2026-03-29. 22:59:59Z on 31 March is 23:59:59 local.
    expect(aiBudgetPeriod(new Date('2026-03-31T22:59:59.999Z'), tz)).toBe('2026-03')
    expect(aiBudgetPeriod(new Date('2026-03-31T23:00:00.000Z'), tz)).toBe('2026-04')
    expect(aiBudgetPeriod(new Date('2026-04-30T23:00:00.000Z'), tz)).toBe('2026-05')
    expect(aiBudgetPeriod(new Date('2026-09-30T23:30:00.000Z'), tz)).toBe('2026-10')
    // Same instant is still September in UTC.
    expect(aiBudgetPeriod(new Date('2026-09-30T23:30:00.000Z'), 'UTC')).toBe('2026-09')
  })

  it('handles other zones, year boundaries and numeric instants', () => {
    expect(aiBudgetPeriod(Date.UTC(2026, 11, 31, 23, 30), 'Europe/London')).toBe('2026-12')
    expect(aiBudgetPeriod(Date.UTC(2026, 11, 31, 23, 30), 'Europe/Berlin')).toBe('2027-01')
    expect(aiBudgetPeriod(Date.UTC(2027, 0, 1, 3), 'America/Los_Angeles')).toBe('2026-12')
  })

  it('rejects invalid timezones and instants', () => {
    expect(() => aiBudgetPeriod(new Date(), 'Mars/Olympus')).toThrow(/invalid IANA timezone/)
    expect(() => aiBudgetPeriod(new Date(), '')).toThrow()
    expect(() => aiBudgetPeriod(new Date('nope'), tz)).toThrow(/invalid instant/)
  })

  it('validates period strings', () => {
    expect(isAiBudgetPeriod('2026-09')).toBe(true)
    expect(isAiBudgetPeriod('2026-13')).toBe(false)
    expect(isAiBudgetPeriod('2026-9')).toBe(false)
  })
})
