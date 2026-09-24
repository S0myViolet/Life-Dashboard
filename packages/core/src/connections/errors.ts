/**
 * Connection failures: a small closed set of kinds that drive the status state
 * machine, a machine-readable code, and a sanitised message that is safe to
 * store in `connections.last_error_message` and show to the owner.
 */

export const CONNECTION_ERROR_KINDS = [
  /** Credentials are no longer accepted (invalid_grant, revoked consent, 401 after refresh). Owner must reconnect. */
  'auth',
  /** Provider asked us to slow down (429, Google 403 rateLimitExceeded). Retry after Retry-After. */
  'rate_limited',
  /** 5xx, network failure, timeout, malformed response. Retry with backoff. */
  'transient',
  /** Our own configuration is wrong or missing (invalid_client, API disabled, missing setting). Owner must fix settings. */
  'config',
  /** Any other provider-side refusal (unexpected 4xx). Retry with backoff. */
  'provider',
] as const
export type ConnectionErrorKind = (typeof CONNECTION_ERROR_KINDS)[number]

export interface ConnectionFailure {
  kind: ConnectionErrorKind
  /** `<kind>.<detail>`, lowercase, e.g. `auth.invalid_grant`, `transient.http_503`. */
  code: string
  /** Human-readable; sanitised again before storage. Never includes provider response bodies. */
  message: string
  /** From Retry-After, when the provider sent one. */
  retryAfterMs?: number
  httpStatus?: number
}

const CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/

/** Build a well-formed error code from a kind and a free-form detail. */
export function connectionErrorCode(kind: ConnectionErrorKind, detail: string): string {
  const d =
    detail
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'unknown'
  return `${kind}.${d}`
}

export function isConnectionErrorCode(code: unknown): code is string {
  return typeof code === 'string' && code.length <= 64 && CODE_RE.test(code)
}

/** The kind encoded in a stored error code (`null` when absent or malformed). */
export function connectionErrorKindOf(code: string | null | undefined): ConnectionErrorKind | null {
  if (!code || !isConnectionErrorCode(code)) return null
  const kind = code.slice(0, code.indexOf('.'))
  return (CONNECTION_ERROR_KINDS as readonly string[]).includes(kind)
    ? (kind as ConnectionErrorKind)
    : null
}

export function connectionFailure(
  kind: ConnectionErrorKind,
  detail: string,
  message: string,
  extra: { retryAfterMs?: number; httpStatus?: number } = {},
): ConnectionFailure {
  return {
    kind,
    code: connectionErrorCode(kind, detail),
    message: sanitizeConnectionErrorMessage(message),
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
  }
}

/**
 * Error thrown by adapters and clients. Carries a classified failure so
 * callers never have to inspect provider responses.
 */
export class ConnectionError extends Error {
  override readonly name = 'ConnectionError'
  readonly failure: ConnectionFailure
  constructor(failure: ConnectionFailure) {
    super(failure.message)
    this.failure = failure
  }
}

export function isConnectionError(err: unknown): err is ConnectionError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ConnectionError' &&
    typeof (err as { failure?: { code?: unknown } }).failure?.code === 'string'
  )
}

/** Any thrown value → a failure. Unknown errors are treated as transient and their text is sanitised. */
export function toConnectionFailure(err: unknown): ConnectionFailure {
  if (isConnectionError(err)) return err.failure
  return connectionFailure('transient', 'unexpected', `Unexpected error: ${messageOf(err)}`)
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'unknown'
}

const DEFAULT_MAX = 300

/**
 * Remove anything secret or personal from an error message before it is
 * stored or displayed: bearer credentials, OAuth tokens and codes, JWTs,
 * `key=value` secrets, email addresses, URL query strings/fragments and long
 * opaque strings. Control characters are dropped and the length is capped.
 */
export function sanitizeConnectionErrorMessage(input: unknown, maxLength = DEFAULT_MAX): string {
  let text = typeof input === 'string' ? input : input instanceof Error ? input.message : ''
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ')

  // URLs: keep origin and path, drop query and fragment (they carry codes and tokens).
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const u = new URL(raw)
      const tail = u.search || u.hash ? '?[redacted]' : ''
      return `${u.origin}${u.pathname}${tail}`
    } catch {
      return '[url]'
    }
  })

  // Authorization header values.
  text = text.replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')

  // key=value, key: value, "key":"value" for secret-bearing keys.
  text = text.replace(
    /\b(access_token|refresh_token|id_token|token|code|code_verifier|client_secret|secret|password|api[_-]?key|apikey|x-api-key|assertion|state|authorization)(["']?\s*[:=]\s*["']?)(?!\[redacted\]|Bearer\b|Basic\b)[^\s&,;"'}]+/gi,
    '$1$2[redacted]',
  )

  // JWTs (id tokens, some access tokens).
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[redacted]')

  // Google access tokens (ya29.), refresh tokens (1//) and authorization codes (4/).
  text = text.replace(/\bya29\.[A-Za-z0-9_\-.]+/g, '[redacted]')
  text = text.replace(/(^|[^A-Za-z0-9])1\/\/[A-Za-z0-9_\-./]+/g, '$1[redacted]')
  text = text.replace(/(^|[^A-Za-z0-9/])4\/[A-Za-z0-9_\-./]{8,}/g, '$1[redacted]')

  // Microsoft account codes and refresh tokens (M.C5..., M.R3_...).
  text = text.replace(/\bM\.[A-Z][A-Za-z0-9]{0,4}_[A-Za-z0-9_\-.!*$]+/g, '[redacted]')

  // Email addresses.
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')

  // Long opaque strings with letters and digits (API keys, tokens, ids).
  text = text.replace(/[A-Za-z0-9_\-+=.~]{24,}/g, (m) =>
    /\d/.test(m) && /[A-Za-z]/.test(m) ? '[redacted]' : m,
  )

  text = text.replace(/\s+/g, ' ').trim()
  const max = Math.max(1, Math.floor(maxLength))
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
  return text
}
