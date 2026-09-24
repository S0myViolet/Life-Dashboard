/**
 * Minimal HTTP helper for provider clients.
 *
 * - Network only through the injected `fetch` (tests pass a fake).
 * - Every request has a timeout (AbortSignal) and honours the caller's signal.
 * - Response bodies are size-bounded, parsed as JSON and validated with zod.
 * - Failures become `ConnectionError`s with a classified failure. Messages are
 *   built from fixed templates plus a validated provider error code: response
 *   bodies, URLs with query strings and credentials never reach an error.
 */
import type { z } from 'zod'
import { ConnectionError, connectionFailure, type ConnectionFailure } from '@personal-home/core'

export const HTTP_DEFAULT_TIMEOUT_MS = 15_000
export const HTTP_DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** What an error response told us, reduced to validated, non-secret fields. */
export interface HttpProviderErrorInfo {
  status: number
  /** OAuth `error`, Graph `error.code` or Google `error.status`. */
  code: string | null
  /** Google `error.errors[].reason` and `error.details[].reason`. */
  reasons: string[]
  retryAfterMs: number | null
}

export interface HttpRequestOptions {
  fetch: typeof fetch
  /** Label used in messages, e.g. "Google". */
  provider: string
  /** Label used in messages, e.g. "token refresh". */
  operation: string
  url: string
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: URLSearchParams | string
  timeoutMs?: number
  signal?: AbortSignal
  now?: () => Date
  maxBytes?: number
  /** Provider-specific classification; return undefined to fall back to the default. */
  classify?: (info: HttpProviderErrorInfo) => ConnectionFailure | null | undefined
  /** Exact secret values to scrub from any message as a last line of defence. */
  secrets?: readonly string[]
}

export interface HttpResult<T> {
  status: number
  headers: Headers
  data: T
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const validCode = (v: unknown): string | null =>
  typeof v === 'string' && CODE_RE.test(v) ? v : null

/**
 * Parse Retry-After (RFC 9110 §10.2.3): delay-seconds or an HTTP-date.
 * Returns milliseconds from `now` (never negative), or null when absent/invalid.
 */
export function httpParseRetryAfter(
  value: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (value === null || value === undefined) return null
  const v = value.trim()
  if (v === '') return null
  if (/^\d+$/.test(v)) {
    const seconds = Number(v)
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null
  }
  // HTTP-date must name a weekday and a GMT time; reject bare numbers and garbage.
  if (!/^[A-Za-z]{3,9},?\s/.test(v)) return null
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now.getTime())
}

/** Replace exact secret values (≥ 4 chars) in a string. */
export function httpRedactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[redacted]')
  }
  return out
}

/** Pull the validated error code(s) out of a JSON error body. Never returns free text. */
export function httpExtractProviderError(body: unknown): {
  code: string | null
  reasons: string[]
} {
  if (!body || typeof body !== 'object') return { code: null, reasons: [] }
  const b = body as Record<string, unknown>
  // OAuth 2.0 token endpoint: { error: "invalid_grant", error_description: "..." }
  if (typeof b.error === 'string') return { code: validCode(b.error), reasons: [] }
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>
    const reasons: string[] = []
    for (const list of [e.errors, e.details]) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const r = validCode((item as Record<string, unknown> | null)?.reason)
        if (r && !reasons.includes(r)) reasons.push(r)
      }
    }
    // Google APIs: { error: { code: 403, status: "PERMISSION_DENIED", errors: [...] } }
    // Microsoft Graph: { error: { code: "InvalidAuthenticationToken", message: "..." } }
    const code = validCode(e.status) ?? validCode(e.code)
    return { code, reasons }
  }
  return { code: null, reasons: [] }
}

function describe(opts: HttpRequestOptions, status: number, code: string | null): string {
  return `${opts.provider} ${opts.operation} failed: HTTP ${status}${code ? ` (${code})` : ''}`
}

/** Default mapping of an error response to a failure kind. */
export function httpDefaultFailure(
  opts: HttpRequestOptions,
  info: HttpProviderErrorInfo,
): ConnectionFailure {
  const msg = describe(opts, info.status, info.code)
  const extra = {
    httpStatus: info.status,
    ...(info.retryAfterMs !== null ? { retryAfterMs: info.retryAfterMs } : {}),
  }
  if (info.status === 401) return connectionFailure('auth', 'unauthorized', msg, extra)
  if (info.status === 403) return connectionFailure('auth', 'forbidden', msg, extra)
  if (info.status === 429) return connectionFailure('rate_limited', 'http_429', msg, extra)
  if (info.status === 408 || info.status >= 500)
    return connectionFailure('transient', `http_${info.status}`, msg, extra)
  return connectionFailure('provider', `http_${info.status}`, msg, extra)
}

function fail(opts: HttpRequestOptions, f: ConnectionFailure): never {
  const message = httpRedactSecrets(f.message, opts.secrets)
  throw new ConnectionError({ ...f, message })
}

async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    all.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/** Send the request and read the (bounded) body. Throws classified ConnectionErrors. */
async function send(opts: HttpRequestOptions): Promise<{ res: Response; text: string }> {
  const timeoutMs = opts.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const abortFailure = (): ConnectionFailure =>
    opts.signal?.aborted
      ? connectionFailure(
          'transient',
          'aborted',
          `${opts.provider} ${opts.operation} was cancelled`,
        )
      : connectionFailure(
          'transient',
          'timeout',
          `${opts.provider} ${opts.operation} timed out after ${Math.round(timeoutMs / 1000)}s`,
        )

  let res: Response
  try {
    res = await opts.fetch(opts.url, {
      method: opts.method ?? 'GET',
      headers: { accept: 'application/json', ...opts.headers },
      body: opts.body,
      signal,
      // Never follow a redirect with credentials attached.
      redirect: 'error',
    })
  } catch (err) {
    if (signal.aborted) fail(opts, abortFailure())
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code
    const detail = typeof cause === 'string' && /^[A-Z_]{2,32}$/.test(cause) ? ` (${cause})` : ''
    fail(
      opts,
      connectionFailure(
        'transient',
        'network',
        `${opts.provider} ${opts.operation} network error${detail}`,
      ),
    )
  }

  let text: string | null
  try {
    text = await readBounded(res, opts.maxBytes ?? HTTP_DEFAULT_MAX_RESPONSE_BYTES)
  } catch {
    if (signal.aborted) fail(opts, abortFailure())
    fail(
      opts,
      connectionFailure(
        'transient',
        'network',
        `${opts.provider} ${opts.operation} response was interrupted`,
      ),
    )
  }
  if (text === null) {
    fail(
      opts,
      connectionFailure(
        'transient',
        'response_too_large',
        `${opts.provider} ${opts.operation} response was too large`,
        {
          httpStatus: res.status,
        },
      ),
    )
  }
  return { res, text }
}

function errorInfo(res: Response, text: string, now: Date): HttpProviderErrorInfo {
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  const { code, reasons } = httpExtractProviderError(body)
  return {
    status: res.status,
    code,
    reasons,
    retryAfterMs: httpParseRetryAfter(res.headers.get('retry-after'), now),
  }
}

function throwForStatus(opts: HttpRequestOptions, res: Response, text: string): never {
  const info = errorInfo(res, text, (opts.now ?? (() => new Date()))())
  fail(opts, opts.classify?.(info) ?? httpDefaultFailure(opts, info))
}

/** Request a JSON document and validate it with `schema`. */
export async function httpRequestJson<T>(
  opts: HttpRequestOptions,
  schema: z.ZodType<T>,
): Promise<HttpResult<T>> {
  const { res, text } = await send(opts)
  if (!res.ok) throwForStatus(opts, res, text)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    fail(
      opts,
      connectionFailure(
        'transient',
        'malformed_response',
        `${opts.provider} ${opts.operation} returned malformed JSON`,
        {
          httpStatus: res.status,
        },
      ),
    )
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    fail(
      opts,
      connectionFailure(
        'transient',
        'malformed_response',
        `${opts.provider} ${opts.operation} returned an unexpected response shape`,
        { httpStatus: res.status },
      ),
    )
  }
  return { status: res.status, headers: res.headers, data: parsed.data }
}

/** Send a request whose success body is irrelevant (e.g. token revocation). Throws on non-2xx. */
export async function httpRequestNoContent(opts: HttpRequestOptions): Promise<{ status: number }> {
  const { res, text } = await send(opts)
  if (!res.ok) throwForStatus(opts, res, text)
  return { status: res.status }
}
