/**
 * Closed result codes of the connect flow. Kept apart from oauth-flow.ts
 * (server-only) so pages and tests can map them to messages without importing
 * server code.
 */
export const OAUTH_RESULT_ERRORS = [
  'needs_setup',
  'unknown_account',
  'invalid_request',
  'state_mismatch',
  'state_expired',
  'denied',
  'provider_error',
  'client_rejected',
  'exchange_failed',
  'no_refresh_token',
  'identity_failed',
  'rate_limited',
  'provider_unavailable',
] as const
export type OAuthResultError = (typeof OAUTH_RESULT_ERRORS)[number]

export function isOAuthResultError(value: unknown): value is OAuthResultError {
  return (OAUTH_RESULT_ERRORS as readonly unknown[]).includes(value)
}
