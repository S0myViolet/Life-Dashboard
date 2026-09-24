/**
 * Turn anything a job threw into a short, single-line message that is safe to
 * store in private.jobs.last_error and to show in an admin view.
 *
 * Only the error's name and message are used — never the stack, `cause`, or
 * arbitrary thrown objects (which can carry request configs with tokens).
 * Credentials, bearer/JWT/API-key-shaped strings, URL userinfo, secret query
 * parameters and email addresses are redacted, then the text is truncated.
 */
import { JOB_ERROR_MAX_LENGTH } from './schemas.ts'

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  // Authorization headers and bearer tokens.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // JWTs (header.payload[.signature]).
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g, '[redacted-jwt]'],
  // Supabase API keys and similar prefixed secrets.
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[redacted-key]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/g, '[redacted-key]'],
  // Credentials in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@'],
  // Secret-looking query parameters.
  [
    /([?&](?:access_token|refresh_token|id_token|token|code|key|api_key|apikey|secret|client_secret|password|sig|signature)=)[^&#\s]+/gi,
    '$1[redacted]',
  ],
  // key=value / key: value pairs with secret-looking names.
  [
    /\b(password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|authorization|cookie)\b(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    '$1$2[redacted]',
  ],
  // Email addresses (personal data).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]'],
  // Long opaque strings (tokens, hashes, ciphertext).
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]'],
]

function describe(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    return `${name}${String(error.message ?? '')}`
  }
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  return 'Non-error value thrown'
}

export function sanitizeJobError(error: unknown, maxLength: number = JOB_ERROR_MAX_LENGTH): string {
  let text = describe(error)
  // Bound the work before running regexes over untrusted text.
  if (text.length > 8 * maxLength) text = text.slice(0, 8 * maxLength)
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (text === '') text = 'Unknown error'
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`
  return text
}
