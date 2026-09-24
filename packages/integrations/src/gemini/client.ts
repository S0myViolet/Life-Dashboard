/**
 * Gemini Developer API client (generateContent). Network only through the injected `fetch`.
 *
 * Every result says whether the request could have been billed, because the budget ledger
 * depends on it:
 *   - `ok`         the provider answered 2xx with a parseable body (usage reconciled from it);
 *   - `not_sent`   provably never reached the provider (validation failed before the call, or
 *                  the connection/DNS/TLS setup failed before any request bytes were written);
 *   - `ambiguous`  it may have been processed (timeout, reset after sending, any HTTP error,
 *                  unparseable 2xx body);
 *   - `rejected`   an HTTP error the provider documents as not billed. The research
 *                  (docs/research/gemini.md) documents none, so GEMINI_UNBILLED_HTTP_STATUSES is
 *                  empty and HTTP errors are treated as ambiguous.
 *
 * Nothing here logs, and results never carry prompt, response or error-body text.
 */
import { z } from 'zod'
import { AI_PROMPT_MAX_CHARS, AI_THINKING_LEVELS, AiModelIdSchema, bytesToBase64 } from '@personal-home/core'
import type { AiThinkingLevel, AiTokenUsage } from '@personal-home/core'
import { GEMINI_MAX_INLINE_AUDIO_BYTES, normalizeGeminiAudioMimeType, type GeminiAudioMime } from './audio.ts'
import {
  GeminiGenerateResponseSchema,
  geminiResponseText,
  geminiResponseTranscript,
  geminiUsageFromMetadata,
  type GeminiGenerateResponse,
} from './response.ts'

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** HTTP statuses documented as not billed. None are documented as of 2026-09-24. */
export const GEMINI_UNBILLED_HTTP_STATUSES: readonly number[] = []

export const GEMINI_DEFAULT_TIMEOUT_MS = 60_000
export const GEMINI_DEFAULT_TRANSCRIBE_TIMEOUT_MS = 120_000

export type GeminiFetch = (url: string, init: RequestInit) => Promise<Response>

export interface GeminiClientConfig {
  apiKey: string
  fetch: GeminiFetch
  /** Override for tests; must be https. */
  baseUrl?: string
  timeoutMs?: number
}

export type GeminiNotSentCode =
  | 'missing_api_key'
  | 'invalid_request'
  | 'audio_too_large'
  | 'unsupported_audio_type'
  | 'connect_failed'

export type GeminiAmbiguousCode = 'timeout' | 'network_error' | 'http_error' | 'unparseable_response'

export interface GeminiOk {
  outcome: 'ok'
  httpStatus: number
  text: string
  finishReason: string | null
  blockReason: string | null
  usage: AiTokenUsage | null
  modelVersion: string | null
  responseId: string | null
}

export interface GeminiNotSent {
  outcome: 'not_sent'
  code: GeminiNotSentCode
  /** Validation issue paths/codes only, never values. */
  issues: string[]
}

export interface GeminiAmbiguous {
  outcome: 'ambiguous'
  code: GeminiAmbiguousCode
  httpStatus: number | null
  /** google.rpc status name, e.g. RESOURCE_EXHAUSTED (never the message). */
  providerStatus: string | null
  retryAfterMs: number | null
}

export interface GeminiRejected {
  outcome: 'rejected'
  code: 'http_error'
  httpStatus: number
  providerStatus: string | null
  retryAfterMs: number | null
}

export type GeminiFailure = GeminiNotSent | GeminiAmbiguous | GeminiRejected
export type GeminiResult = GeminiOk | GeminiFailure

export interface GeminiTranscribeOk extends GeminiOk {
  emptyTranscript: boolean
  audio: GeminiAudioMime
}
export type GeminiTranscribeResult = GeminiTranscribeOk | GeminiFailure

/** Short code for the usage ledger (`error_code`), e.g. 'timeout', 'http_503'. */
export function geminiErrorCode(result: GeminiFailure): string {
  if (result.outcome === 'not_sent') return result.code
  if (result.code === 'http_error' && result.httpStatus != null) return `http_${result.httpStatus}`
  return result.code
}

const ThinkingSchema = z.union([
  z.object({ level: z.enum(AI_THINKING_LEVELS) }).strict(),
  z.object({ budgetTokens: z.number().int().min(0).max(32_768) }).strict(),
])
export type GeminiThinking = { level: AiThinkingLevel } | { budgetTokens: number }

const TimeoutSchema = z.number().int().min(1_000).max(600_000)

export const GeminiGenerateRequestSchema = z.object({
  model: AiModelIdSchema,
  systemInstruction: z.string().max(AI_PROMPT_MAX_CHARS).optional(),
  userText: z.string().min(1).max(AI_PROMPT_MAX_CHARS),
  maxOutputTokens: z.number().int().min(1).max(65_536),
  /** thinkingLevel (Gemini 3.x) or legacy thinkingBudget — never both (the API returns 400). */
  thinking: ThinkingSchema.nullish(),
  /** JSON response mode: responseMimeType application/json + responseJsonSchema. */
  responseJsonSchema: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: TimeoutSchema.optional(),
})
export type GeminiGenerateRequest = z.input<typeof GeminiGenerateRequestSchema>

export const GeminiTranscribeRequestSchema = z.object({
  model: AiModelIdSchema,
  audio: z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'audio must be a Uint8Array'),
  mimeType: z.string().max(200),
  maxOutputTokens: z.number().int().min(1).max(65_536),
  /** BCP-47 hints, e.g. ['en-GB']. Omit for automatic language detection. */
  languageCodes: z
    .array(z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/))
    .max(10)
    .optional(),
  timeoutMs: TimeoutSchema.optional(),
})
export type GeminiTranscribeRequest = z.input<typeof GeminiTranscribeRequestSchema>

function notSent(code: GeminiNotSentCode, issues: string[] = []): GeminiNotSent {
  return { outcome: 'not_sent', code, issues }
}

function issuesOf(err: z.ZodError): string[] {
  return err.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
}

// Failures that happen while establishing the connection, before any request bytes are written.
const CONNECT_ERRNO = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EAI_FAIL',
  'EHOSTUNREACH',
  'ENETUNREACH',
])
const CONNECT_SYSCALLS = new Set(['connect', 'getaddrinfo', 'getaddrinfo_all', 'queryA', 'queryAaaa'])
const CONNECT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', // undici: TCP connect timed out
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])
// Deno's fetch surfaces connect-phase failures only in the message (checked against Deno 2.9.6):
//   "error sending request for url (…): client error (Connect): tcp connect error: Connection refused"
//   "… client error (Connect): dns error: failed to lookup address information: …"
//   "… client error (Connect): unsuccessful tunnel"   (HTTPS proxy refused the CONNECT)
// hyper's "client error (Connect)" kind is only raised while establishing the connection
// (TCP, TLS, proxy tunnel), i.e. before any request bytes are written.
const DENO_CONNECT_RE =
  /(?:client error \(Connect\)|\btcp connect error\b|\bconnection refused\b|\bdns error\b|\bfailed to lookup address\b|\bno such host is known\b)/i

/** True only when the error proves the request never left this machine. */
export function isGeminiConnectFailure(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    const { code, syscall, message } = e as { code?: unknown; syscall?: unknown; message?: unknown }
    if (typeof code === 'string') {
      if (CONNECT_CODES.has(code)) return true
      if (CONNECT_ERRNO.has(code) && typeof syscall === 'string' && CONNECT_SYSCALLS.has(syscall)) {
        return true
      }
    }
    if (typeof message === 'string' && DENO_CONNECT_RE.test(message)) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

function parseRetryDelay(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
  return m ? Math.ceil(Number(m[1]) * 1000) : null
}

function parseRetryAfterHeader(res: Response): number | null {
  const h = res.headers.get('retry-after')
  if (!h) return null
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000
  const at = Date.parse(h)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

const ErrorBodySchema = z.object({
  error: z
    .object({
      status: z.string().regex(/^[A-Z_]{1,64}$/).optional().catch(undefined),
      details: z
        .array(z.object({ '@type': z.string().optional(), retryDelay: z.unknown() }).loose())
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
})

function errorInfo(res: Response, body: string): { providerStatus: string | null; retryAfterMs: number | null } {
  let providerStatus: string | null = null
  let retryAfterMs = parseRetryAfterHeader(res)
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(body))
    if (parsed.success) {
      providerStatus = parsed.data.error?.status ?? null
      const retry = parsed.data.error?.details?.find((d) => String(d['@type'] ?? '').endsWith('RetryInfo'))
      retryAfterMs = parseRetryDelay(retry?.retryDelay) ?? retryAfterMs
    }
  } catch {
    // Non-JSON error body: keep only the status code.
  }
  return { providerStatus, retryAfterMs }
}

function baseUrl(config: GeminiClientConfig): string | null {
  const raw = config.baseUrl ?? GEMINI_API_BASE_URL
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    return raw.replace(/\/+$/, '')
  } catch {
    return null
  }
}

async function post(
  config: GeminiClientConfig,
  model: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ result: GeminiFailure } | { status: number; json: GeminiGenerateResponse }> {
  const base = baseUrl(config)
  if (!base) return { result: notSent('invalid_request', ['baseUrl: must be https']) }
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await config.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Header, not ?key=, so the key never appears in URLs or access logs.
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (err) {
      if (controller.signal.aborted) {
        return { result: { outcome: 'ambiguous', code: 'timeout', httpStatus: null, providerStatus: null, retryAfterMs: null } }
      }
      if (isGeminiConnectFailure(err)) return { result: notSent('connect_failed') }
      return { result: { outcome: 'ambiguous', code: 'network_error', httpStatus: null, providerStatus: null, retryAfterMs: null } }
    }

    let text: string
    try {
      text = await res.text()
    } catch {
      return {
        result: {
          outcome: 'ambiguous',
          code: controller.signal.aborted ? 'timeout' : 'network_error',
          httpStatus: res.status,
          providerStatus: null,
          retryAfterMs: null,
        },
      }
    }

    if (!res.ok) {
      const info = errorInfo(res, text)
      if (GEMINI_UNBILLED_HTTP_STATUSES.includes(res.status)) {
        return { result: { outcome: 'rejected', code: 'http_error', httpStatus: res.status, ...info } }
      }
      return { result: { outcome: 'ambiguous', code: 'http_error', httpStatus: res.status, ...info } }
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      raw = undefined
    }
    const parsed = GeminiGenerateResponseSchema.safeParse(raw)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !parsed.success) {
      return {
        result: {
          outcome: 'ambiguous',
          code: 'unparseable_response',
          httpStatus: res.status,
          providerStatus: null,
          retryAfterMs: null,
        },
      }
    }
    return { status: res.status, json: parsed.data }
  } finally {
    clearTimeout(timer)
  }
}

function okResult(status: number, json: GeminiGenerateResponse, text: string): GeminiOk {
  return {
    outcome: 'ok',
    httpStatus: status,
    text,
    finishReason: json.candidates?.[0]?.finishReason ?? null,
    blockReason: json.promptFeedback?.blockReason ?? null,
    usage: geminiUsageFromMetadata(json.usageMetadata),
    modelVersion: json.modelVersion ?? null,
    responseId: json.responseId ?? null,
  }
}

function checkKey(config: GeminiClientConfig): boolean {
  return typeof config.apiKey === 'string' && config.apiKey.trim().length > 0 && !/\s/.test(config.apiKey)
}

/** Build the generateContent body for a text request (exported for tests). */
export function geminiGenerateBody(req: z.output<typeof GeminiGenerateRequestSchema>): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: req.maxOutputTokens,
    candidateCount: 1,
  }
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.responseJsonSchema) {
    generationConfig.responseMimeType = 'application/json'
    generationConfig.responseJsonSchema = req.responseJsonSchema
  }
  if (req.thinking) {
    generationConfig.thinkingConfig =
      'level' in req.thinking
        ? { thinkingLevel: req.thinking.level }
        : { thinkingBudget: req.thinking.budgetTokens }
  }
  return {
    ...(req.systemInstruction ? { systemInstruction: { parts: [{ text: req.systemInstruction }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: req.userText }] }],
    generationConfig,
  }
}

/** One bounded generateContent call. */
export async function geminiGenerateContent(
  config: GeminiClientConfig,
  request: GeminiGenerateRequest,
): Promise<GeminiResult> {
  if (!checkKey(config)) return notSent('missing_api_key')
  const parsed = GeminiGenerateRequestSchema.safeParse(request)
  if (!parsed.success) return notSent('invalid_request', issuesOf(parsed.error))
  const req = parsed.data
  const r = await post(
    config,
    req.model,
    geminiGenerateBody(req),
    req.timeoutMs ?? config.timeoutMs ?? GEMINI_DEFAULT_TIMEOUT_MS,
  )
  if ('result' in r) return r.result
  return okResult(r.status, r.json, geminiResponseText(r.json))
}

/** Transcribe one recording sent inline (base64) with an explicit audio MIME type. */
export async function geminiTranscribe(
  config: GeminiClientConfig,
  request: GeminiTranscribeRequest,
): Promise<GeminiTranscribeResult> {
  if (!checkKey(config)) return notSent('missing_api_key')
  const parsed = GeminiTranscribeRequestSchema.safeParse(request)
  if (!parsed.success) return notSent('invalid_request', issuesOf(parsed.error))
  const req = parsed.data
  if (req.audio.byteLength === 0) {
    return notSent('invalid_request', ['audio: empty'])
  }
  if (req.audio.byteLength > GEMINI_MAX_INLINE_AUDIO_BYTES) {
    return notSent('audio_too_large')
  }
  const mime = normalizeGeminiAudioMimeType(req.mimeType)
  if (!mime) return notSent('unsupported_audio_type')

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: mime.mimeType, data: bytesToBase64(req.audio) } }],
      },
    ],
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens,
      audioTranscriptionConfig: req.languageCodes?.length ? { languageCodes: req.languageCodes } : {},
    },
  }
  const r = await post(
    config,
    req.model,
    body,
    req.timeoutMs ?? config.timeoutMs ?? GEMINI_DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  )
  if ('result' in r) return r.result
  const transcript = geminiResponseTranscript(r.json)
  return {
    ...okResult(r.status, r.json, transcript),
    // Reported on the live API: HTTP 200 with an empty transcript. Callers keep the recording.
    emptyTranscript: transcript.trim() === '',
    audio: mime,
  }
}
