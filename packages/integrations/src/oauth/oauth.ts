/**
 * OAuth 2.0 building blocks shared by the Google and Microsoft adapters:
 * PKCE (S256), state, the token endpoint request and its error classification,
 * and reading id-token claims.
 */
import { z } from 'zod'
import {
  bytesToBase64Url,
  connectionFailure,
  normalizeGrantedScopes,
  parseScopeString,
  randomToken,
  utf8,
  type ConnectionAdapterContext,
  type ConnectionFailure,
  type OAuthTokenSet,
  type Provider,
} from '@personal-home/core'
import { httpRequestJson, type HttpProviderErrorInfo } from '../http/client.ts'

/** PKCE code verifier: 43 chars of base64url (256 bits), within RFC 7636's 43–128 unreserved chars. */
export function oauthCodeVerifier(): string {
  return randomToken(32)
}

/** PKCE S256 challenge: BASE64URL(SHA256(ASCII(verifier))). */
export async function oauthCodeChallengeS256(verifier: string): Promise<string> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) throw new Error('invalid PKCE code verifier')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8(verifier) as BufferSource)
  return bytesToBase64Url(new Uint8Array(digest))
}

export async function oauthPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = oauthCodeVerifier()
  return { verifier, challenge: await oauthCodeChallengeS256(verifier) }
}

/** Unguessable, single-use OAuth `state` (256 bits). Only its SHA-256 is stored. */
export function oauthState(): string {
  return randomToken(32)
}

export const OAUTH_STATE_RE = /^[A-Za-z0-9_-]{43}$/

const ExpiresIn = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform((v) => Number(v))
  .pipe(z.number().int().nonnegative())

export const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z
    .string()
    .refine((t) => t.toLowerCase() === 'bearer', 'unsupported token type')
    .optional(),
  expires_in: ExpiresIn.optional(),
  refresh_token: z.string().min(1).max(8192).optional(),
  scope: z.string().max(4096).optional(),
  id_token: z.string().min(1).max(16384).optional(),
})
export type OAuthTokenResponse = z.infer<typeof OAuthTokenResponseSchema>

export function oauthTokenSetFromResponse(
  provider: Provider,
  body: OAuthTokenResponse,
  now: Date,
): OAuthTokenSet {
  const expiresIn = body.expires_in
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt:
      expiresIn !== undefined && expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000) : null,
    refreshToken: body.refresh_token ?? null,
    grantedScopes:
      body.scope !== undefined
        ? normalizeGrantedScopes(provider, parseScopeString(body.scope))
        : null,
    idToken: body.id_token ?? null,
  }
}

/**
 * Classify a token-endpoint error (RFC 6749 §5.2 plus provider extensions).
 * `invalid_grant` means the refresh token or code is no longer valid: reconnect.
 */
export function oauthClassifyTokenError(
  providerLabel: string,
  operation: string,
): (info: HttpProviderErrorInfo) => ConnectionFailure | undefined {
  return (info) => {
    const code = info.code?.toLowerCase() ?? null
    const base = `${providerLabel} ${operation} failed: HTTP ${info.status}${info.code ? ` (${info.code})` : ''}`
    const extra = {
      httpStatus: info.status,
      ...(info.retryAfterMs !== null ? { retryAfterMs: info.retryAfterMs } : {}),
    }
    if (info.status === 429) return connectionFailure('rate_limited', 'http_429', base, extra)
    if (info.status >= 500)
      return connectionFailure('transient', `http_${info.status}`, base, extra)
    switch (code) {
      case 'invalid_grant':
        return connectionFailure(
          'auth',
          'invalid_grant',
          `${providerLabel} no longer accepts the stored authorization (invalid_grant). Reconnect the account.`,
          extra,
        )
      case 'interaction_required':
      case 'consent_required':
      case 'login_required':
        return connectionFailure('auth', code, `${base}. Reconnect the account.`, extra)
      case 'invalid_client':
      case 'unauthorized_client':
        return connectionFailure(
          'config',
          code,
          `${providerLabel} rejected this app's client credentials (${code}). Check the client id and secret settings.`,
          extra,
        )
      case 'invalid_scope':
        return connectionFailure('config', code, base, extra)
      case 'temporarily_unavailable':
      case 'server_error':
        return connectionFailure('transient', code, base, extra)
      default:
        return undefined
    }
  }
}

export interface OAuthTokenRequest {
  provider: Provider
  providerLabel: string
  operation: string
  tokenUrl: string
  params: Record<string, string>
  /** Values scrubbed from any error message (client secret, codes, tokens). */
  secrets: readonly string[]
  timeoutMs?: number
}

/** POST application/x-www-form-urlencoded to a token endpoint and parse the token set. */
export async function oauthTokenRequest(
  req: OAuthTokenRequest,
  ctx: ConnectionAdapterContext,
): Promise<OAuthTokenSet> {
  const { data } = await httpRequestJson(
    {
      fetch: ctx.fetch,
      signal: ctx.signal,
      now: ctx.now,
      provider: req.providerLabel,
      operation: req.operation,
      url: req.tokenUrl,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // URLSearchParams form-encodes every value (Microsoft requires the secret URL-encoded).
      body: new URLSearchParams(req.params),
      timeoutMs: req.timeoutMs,
      classify: oauthClassifyTokenError(req.providerLabel, req.operation),
      secrets: req.secrets,
    },
    OAuthTokenResponseSchema,
  )
  return oauthTokenSetFromResponse(req.provider, data, ctx.now())
}

/**
 * Read a JWT's payload WITHOUT verifying its signature. Only for id tokens
 * received directly from the provider's token endpoint over TLS in a
 * confidential-client exchange (OpenID Connect Core §3.1.3.7 allows TLS
 * server validation in place of signature checking there); callers must still
 * check `iss`, `aud` and `exp`.
 */
export function oauthDecodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Build an authorization URL from an endpoint and parameters (undefined values are skipped). */
export function oauthAuthorizationUrl(
  endpoint: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(endpoint)
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') url.searchParams.set(k, v)
  return url.toString()
}
