/**
 * Gemini client tests. The provider cannot be reached from the build container, so every
 * response below is a SYNTHETIC FIXTURE shaped from docs/research/gemini.md (field names checked
 * against the @google/genai 2.24.0 type definitions there). None were captured from the live API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GEMINI_MAX_INLINE_AUDIO_BYTES,
  geminiAudioSecondsUpperBound,
  geminiErrorCode,
  geminiGenerateContent,
  geminiTranscribe,
  geminiTranscriptOutputTokenBudget,
  isGeminiConnectFailure,
  normalizeGeminiAudioMimeType,
  type GeminiFetch,
} from '../src/index.ts'

const KEY = 'test-key-not-real'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mockFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  const fn = vi.fn<GeminiFetch>(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) })
    return respond()
  })
  return { fn, calls }
}

// SYNTHETIC FIXTURE (not captured from the live service)
const TEXT_RESPONSE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          { text: 'Considering which emails matter…', thought: true },
          { text: '{"summary":"Two emails need a reply","items":[]}' },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 1234,
    candidatesTokenCount: 56,
    thoughtsTokenCount: 310,
    totalTokenCount: 1600,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1234 }],
  },
  modelVersion: 'gemini-3.5-flash-lite',
  responseId: 'resp-synthetic-1',
}

// SYNTHETIC FIXTURE (not captured from the live service)
const TRANSCRIBE_RESPONSE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            audioTranscription: {
              text: 'Today I finished the budget page.',
              finished: true,
              languageCode: 'en-GB',
            },
          },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 1932,
    candidatesTokenCount: 9,
    totalTokenCount: 1941,
    promptTokensDetails: [
      { modality: 'AUDIO', tokenCount: 1920 },
      { modality: 'TEXT', tokenCount: 12 },
    ],
  },
  modelVersion: 'gemini-3.5-transcribe',
}

// SYNTHETIC FIXTURE (not captured from the live service): forum-reported 200 with no transcript.
const EMPTY_TRANSCRIBE_RESPONSE = {
  candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
  usageMetadata: {
    promptTokenCount: 960,
    candidatesTokenCount: 0,
    totalTokenCount: 960,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 960 }],
  },
}

// SYNTHETIC FIXTURE (not captured from the live service): google.rpc error shape.
const RATE_LIMITED = {
  error: {
    code: 429,
    message: 'Quota exceeded for prompt "Dear Alice, please wire the money"',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
  },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('geminiGenerateContent', () => {
  it('sends a bounded JSON-mode request with the key in a header and parses usage incl. thoughts', async () => {
    const { fn, calls } = mockFetch(() => jsonResponse(TEXT_RESPONSE))
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
    const r = await geminiGenerateContent(
      { apiKey: KEY, fetch: fn },
      {
        model: 'gemini-3.5-flash-lite',
        systemInstruction: 'rules',
        userText: 'evidence',
        maxOutputTokens: 800,
        thinking: { level: 'MINIMAL' },
        responseJsonSchema: schema,
        temperature: 0.2,
      },
    )
    expect(fn).toHaveBeenCalledTimes(1)
    const call = calls[0]!
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    )
    expect(call.url).not.toContain(KEY)
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
    expect(call.init.redirect).toBe('error')
    expect(call.body).toEqual({
      systemInstruction: { parts: [{ text: 'rules' }] },
      contents: [{ role: 'user', parts: [{ text: 'evidence' }] }],
      generationConfig: {
        maxOutputTokens: 800,
        candidateCount: 1,
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    })

    expect(r).toEqual({
      outcome: 'ok',
      httpStatus: 200,
      text: '{"summary":"Two emails need a reply","items":[]}',
      finishReason: 'STOP',
      blockReason: null,
      usage: {
        promptTokens: 1234,
        promptAudioTokens: 0,
        candidatesTokens: 56,
        thoughtsTokens: 310,
        toolUsePromptTokens: null,
        cachedTokens: null,
        totalTokens: 1600,
      },
      modelVersion: 'gemini-3.5-flash-lite',
      responseId: 'resp-synthetic-1',
    })
  })

  it('sends the legacy thinkingBudget alone when asked, never both', async () => {
    const { fn, calls } = mockFetch(() => jsonResponse(TEXT_RESPONSE))
    await geminiGenerateContent(
      { apiKey: KEY, fetch: fn },
      { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10, thinking: { budgetTokens: 0 } },
    )
    expect((calls[0]!.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingBudget: 0,
    })
    const both = await geminiGenerateContent(
      { apiKey: KEY, fetch: fn },
      {
        model: 'gemini-3.5-flash-lite',
        userText: 'x',
        maxOutputTokens: 10,
        thinking: { level: 'LOW', budgetTokens: 10 } as never,
      },
    )
    expect(both).toMatchObject({ outcome: 'not_sent', code: 'invalid_request' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('classifies validation failures and a missing key as not sent, without calling fetch', async () => {
    const { fn } = mockFetch(() => jsonResponse(TEXT_RESPONSE))
    const cases = [
      { cfg: { apiKey: '', fetch: fn }, code: 'missing_api_key' },
      { cfg: { apiKey: KEY, fetch: fn, baseUrl: 'http://insecure.example' }, code: 'invalid_request' },
    ] as const
    for (const c of cases) {
      const r = await geminiGenerateContent(c.cfg, {
        model: 'gemini-3.5-flash-lite',
        userText: 'x',
        maxOutputTokens: 10,
      })
      expect(r).toMatchObject({ outcome: 'not_sent', code: c.code })
    }
    for (const bad of [
      { model: 'gemini-3.5-flash-lite', userText: '', maxOutputTokens: 10 },
      { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 0 },
      { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 100_000 },
      { model: '../files?x=', userText: 'x', maxOutputTokens: 10 },
    ]) {
      const r = await geminiGenerateContent({ apiKey: KEY, fetch: fn }, bad)
      expect(r).toMatchObject({ outcome: 'not_sent', code: 'invalid_request' })
    }
    expect(fn).not.toHaveBeenCalled()
  })

  it('treats connection-phase failures as not sent and anything after sending as ambiguous', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' }),
    })
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' }),
    })
    // Deno 2.9.6 shapes, as observed locally: TypeError('fetch failed') with the hyper error as cause.
    const denoError = (detail: string) =>
      Object.assign(new TypeError('fetch failed'), {
        cause: new Error(`error sending request for url (https://generativelanguage.googleapis.com/v1beta/models/m:generateContent): ${detail}`),
      })
    const denoRefused = denoError('client error (Connect): tcp connect error: Connection refused (os error 111)')
    const denoDns = denoError(
      'client error (Connect): dns error: failed to lookup address information: Name or service not known',
    )
    const denoTunnel = denoError('client error (Connect): unsuccessful tunnel')
    const denoAfterSend = denoError('client error (SendRequest): connection closed before message completed')
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }),
    })
    const closed = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })
    const writeUnreachable = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('write EHOSTUNREACH'), { code: 'EHOSTUNREACH', syscall: 'write' }),
    })
    const expectations: [unknown, string, string][] = [
      [refused, 'not_sent', 'connect_failed'],
      [dns, 'not_sent', 'connect_failed'],
      [denoRefused, 'not_sent', 'connect_failed'],
      [denoDns, 'not_sent', 'connect_failed'],
      [denoTunnel, 'not_sent', 'connect_failed'],
      [denoAfterSend, 'ambiguous', 'network_error'],
      [reset, 'ambiguous', 'network_error'],
      [closed, 'ambiguous', 'network_error'],
      [writeUnreachable, 'ambiguous', 'network_error'],
      [new Error('anything else'), 'ambiguous', 'network_error'],
    ]
    for (const [err, outcome, code] of expectations) {
      const fn = vi.fn<GeminiFetch>(async () => {
        throw err
      })
      const r = await geminiGenerateContent(
        { apiKey: KEY, fetch: fn },
        { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10 },
      )
      expect(r).toMatchObject({ outcome, code })
    }
    expect(isGeminiConnectFailure(undefined)).toBe(false)
  })

  it('treats a timeout as ambiguous', async () => {
    vi.useFakeTimers()
    const fn = vi.fn<GeminiFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
    const pending = geminiGenerateContent(
      { apiKey: KEY, fetch: fn, timeoutMs: 5_000 },
      { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10 },
    )
    await vi.advanceTimersByTimeAsync(5_001)
    const r = await pending
    expect(r).toEqual({ outcome: 'ambiguous', code: 'timeout', httpStatus: null, providerStatus: null, retryAfterMs: null })
    expect(geminiErrorCode(r as never)).toBe('timeout')
  })

  it('treats every HTTP error as ambiguous (none are documented as unbilled) and never keeps the message', async () => {
    const r429 = await geminiGenerateContent(
      { apiKey: KEY, fetch: mockFetch(() => jsonResponse(RATE_LIMITED, 429)).fn },
      { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10 },
    )
    expect(r429).toEqual({
      outcome: 'ambiguous',
      code: 'http_error',
      httpStatus: 429,
      providerStatus: 'RESOURCE_EXHAUSTED',
      retryAfterMs: 37_000,
    })
    expect(JSON.stringify(r429)).not.toContain('Dear Alice')
    expect(geminiErrorCode(r429 as never)).toBe('http_429')

    for (const status of [400, 403, 404, 500, 503]) {
      const r = await geminiGenerateContent(
        {
          apiKey: KEY,
          fetch: mockFetch(() => jsonResponse('<html>upstream error</html>', status, { 'retry-after': '12' })).fn,
        },
        { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10 },
      )
      expect(r).toEqual({
        outcome: 'ambiguous',
        code: 'http_error',
        httpStatus: status,
        providerStatus: null,
        retryAfterMs: 12_000,
      })
    }
  })

  it('treats an unparseable 2xx body as ambiguous', async () => {
    for (const body of ['not json', '[]', 'null', '{"candidates": "nope"}']) {
      const r = await geminiGenerateContent(
        { apiKey: KEY, fetch: mockFetch(() => jsonResponse(body)).fn },
        { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10 },
      )
      if (body === '{"candidates": "nope"}') {
        // Structurally odd but an object: lenient parse keeps what it can (no text, no usage).
        expect(r).toMatchObject({ outcome: 'ok', text: '', usage: null })
      } else {
        expect(r).toMatchObject({ outcome: 'ambiguous', code: 'unparseable_response', httpStatus: 200 })
      }
    }
  })

  it('treats a failure while reading the body as ambiguous', async () => {
    const res = jsonResponse(TEXT_RESPONSE)
    Object.defineProperty(res, 'text', { value: () => Promise.reject(new TypeError('terminated')) })
    const r = await geminiGenerateContent(
      { apiKey: KEY, fetch: vi.fn<GeminiFetch>(async () => res) },
      { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10 },
    )
    expect(r).toMatchObject({ outcome: 'ambiguous', code: 'network_error', httpStatus: 200 })
  })

  it('reports a blocked prompt with its usage and no text', async () => {
    // SYNTHETIC FIXTURE (not captured from the live service)
    const blocked = {
      promptFeedback: { blockReason: 'SAFETY' },
      usageMetadata: { promptTokenCount: 88, totalTokenCount: 88 },
    }
    const r = await geminiGenerateContent(
      { apiKey: KEY, fetch: mockFetch(() => jsonResponse(blocked)).fn },
      { model: 'gemini-3.5-flash-lite', userText: 'x', maxOutputTokens: 10 },
    )
    expect(r).toMatchObject({
      outcome: 'ok',
      text: '',
      blockReason: 'SAFETY',
      usage: { promptTokens: 88, promptAudioTokens: null, totalTokens: 88 },
    })
  })
})

describe('geminiTranscribe', () => {
  const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3])

  it('sends inline audio with a normalised MIME type and reads audioTranscription parts', async () => {
    const { fn, calls } = mockFetch(() => jsonResponse(TRANSCRIBE_RESPONSE))
    const r = await geminiTranscribe(
      { apiKey: KEY, fetch: fn },
      {
        model: 'gemini-3.5-transcribe',
        audio,
        mimeType: 'audio/webm;codecs=opus',
        maxOutputTokens: 512,
        languageCodes: ['en-GB'],
      },
    )
    const body = calls[0]!.body as {
      contents: { parts: { inlineData: { mimeType: string; data: string } }[] }[]
      generationConfig: Record<string, unknown>
    }
    expect(calls[0]!.url).toContain('/models/gemini-3.5-transcribe:generateContent')
    const inline = body.contents[0]!.parts[0]!.inlineData
    expect(inline.mimeType).toBe('audio/webm')
    expect(Uint8Array.from(atob(inline.data), (c) => c.charCodeAt(0))).toEqual(audio)
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 512,
      audioTranscriptionConfig: { languageCodes: ['en-GB'] },
    })
    expect(r).toMatchObject({
      outcome: 'ok',
      text: 'Today I finished the budget page.',
      emptyTranscript: false,
      usage: { promptTokens: 1932, promptAudioTokens: 1920, candidatesTokens: 9, thoughtsTokens: null },
      audio: { mimeType: 'audio/webm', relabelledFrom: 'audio/webm;codecs=opus', verified: true },
    })
  })

  it('joins several transcription segments without gluing words, breaking lines between speakers', async () => {
    // SYNTHETIC FIXTURE (not captured from the live service): diarized, per-utterance parts.
    const diarized = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { audioTranscription: { text: 'Morning.', speakerLabel: 'spk_1' } },
              { audioTranscription: { text: 'Plan for today', speakerLabel: 'spk_1' } },
              { audioTranscription: { text: 'is the budget page.', speakerLabel: 'spk_1' } },
              { audioTranscription: { text: 'Sounds good.', speakerLabel: 'spk_2' } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 330,
        candidatesTokenCount: 14,
        totalTokenCount: 344,
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 320 }, { modality: 'TEXT', tokenCount: 10 }],
      },
    }
    const r = await geminiTranscribe(
      { apiKey: KEY, fetch: mockFetch(() => jsonResponse(diarized)).fn },
      { model: 'gemini-3.5-transcribe', audio, mimeType: 'audio/webm', maxOutputTokens: 100 },
    )
    expect(r).toMatchObject({
      outcome: 'ok',
      text: 'Morning. Plan for today is the budget page.\nSounds good.',
      emptyTranscript: false,
      usage: { promptTokens: 330, promptAudioTokens: 320 },
    })
  })

  it('flags an empty transcript from a 200 response and still reports usage', async () => {
    const r = await geminiTranscribe(
      { apiKey: KEY, fetch: mockFetch(() => jsonResponse(EMPTY_TRANSCRIBE_RESPONSE)).fn },
      { model: 'gemini-3.5-transcribe', audio, mimeType: 'audio/ogg', maxOutputTokens: 100 },
    )
    expect(r).toMatchObject({
      outcome: 'ok',
      text: '',
      emptyTranscript: true,
      usage: { promptAudioTokens: 960, candidatesTokens: 0 },
    })
  })

  it("relabels iPhone Safari's audio/mp4 as audio/m4a and marks it unverified", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse(TRANSCRIBE_RESPONSE))
    const r = await geminiTranscribe(
      { apiKey: KEY, fetch: fn },
      { model: 'gemini-3.5-transcribe', audio, mimeType: 'audio/mp4', maxOutputTokens: 100 },
    )
    const body = calls[0]!.body as { contents: { parts: { inlineData: { mimeType: string } }[] }[] }
    expect(body.contents[0]!.parts[0]!.inlineData.mimeType).toBe('audio/m4a')
    expect(r).toMatchObject({ audio: { mimeType: 'audio/m4a', relabelledFrom: 'audio/mp4', verified: false } })
  })

  it('refuses unsupported, empty and oversized audio before sending', async () => {
    const { fn } = mockFetch(() => jsonResponse(TRANSCRIBE_RESPONSE))
    const cfg = { apiKey: KEY, fetch: fn }
    const base = { model: 'gemini-3.5-transcribe', maxOutputTokens: 100 }
    expect(await geminiTranscribe(cfg, { ...base, audio, mimeType: 'audio/x-ms-wma' })).toMatchObject({
      outcome: 'not_sent',
      code: 'unsupported_audio_type',
    })
    expect(await geminiTranscribe(cfg, { ...base, audio: new Uint8Array(0), mimeType: 'audio/webm' })).toMatchObject({
      outcome: 'not_sent',
      code: 'invalid_request',
    })
    expect(
      await geminiTranscribe(cfg, {
        ...base,
        audio: new Uint8Array(GEMINI_MAX_INLINE_AUDIO_BYTES + 1),
        mimeType: 'audio/webm',
      }),
    ).toMatchObject({ outcome: 'not_sent', code: 'audio_too_large' })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('audio helpers', () => {
  it('normalises MIME types', () => {
    expect(normalizeGeminiAudioMimeType('AUDIO/WAV')).toMatchObject({ mimeType: 'audio/wav', verified: true })
    expect(normalizeGeminiAudioMimeType('audio/wav')).toEqual({ mimeType: 'audio/wav', relabelledFrom: null, verified: true })
    expect(normalizeGeminiAudioMimeType('video/webm;codecs=opus')).toMatchObject({ mimeType: 'audio/webm' })
    expect(normalizeGeminiAudioMimeType('audio/x-m4a')).toMatchObject({ mimeType: 'audio/m4a', verified: true })
    expect(normalizeGeminiAudioMimeType('application/octet-stream')).toBeNull()
    expect(normalizeGeminiAudioMimeType('toString')).toBeNull()
  })

  it('sizes transcript output and duration bounds conservatively', () => {
    expect(geminiTranscriptOutputTokenBudget(0)).toBe(256)
    expect(geminiTranscriptOutputTokenBudget(60)).toBe(856)
    expect(geminiTranscriptOutputTokenBudget(10 * 3600)).toBe(65_536)
    expect(geminiAudioSecondsUpperBound(750)).toBe(1)
    expect(geminiAudioSecondsUpperBound(1_000_000)).toBe(1334)
  })
})
