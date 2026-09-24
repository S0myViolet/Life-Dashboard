/**
 * Google adapter: Gmail + Google Calendar, read-only, server authorization-code
 * flow with PKCE and offline access. Endpoints and parameters follow
 * docs/research/oauth.md (Google OIDC discovery document and API discovery docs).
 */
import { z } from 'zod'
import {
  CONNECTION_PROVIDER_INFO,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_GMAIL_SCOPE,
  connectionFailure,
  normalizeGrantedScopes,
  type ConnectionAccessCheck,
  type ConnectionAccountIdentity,
  type ConnectionAccountKind,
  type ConnectionAdapterContext,
  type ConnectionFailure,
  type ConnectionOAuthAdapter,
  type ConnectionRevokeOutcome,
  type OAuthTokenSet,
  isConnectionError,
} from '@personal-home/core'
import {
  httpRequestJson,
  httpRequestNoContent,
  type HttpProviderErrorInfo,
  type HttpRequestOptions,
} from '../http/client.ts'
import {
  oauthAuthorizationUrl,
  oauthDecodeJwtClaims,
  oauthTokenRequest,
} from '../oauth/oauth.ts'

export const GOOGLE_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  gmailProfile: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  calendarList: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
} as const

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const LABEL = 'Google'

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
}

const GmailProfileSchema = z.object({
  emailAddress: z.string().min(3).max(320),
  historyId: z.union([z.string(), z.number()]).optional(),
})

const UserInfoSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().max(320).optional(),
  hd: z.string().max(255).optional(),
})

const CalendarListSchema = z.object({ items: z.array(z.unknown()).optional() })

const RATE_LIMIT_REASONS = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'quotaexceeded',
  'dailylimitexceeded',
  'resource_exhausted',
  'rate_limit_exceeded',
])
const API_DISABLED_REASONS = new Set(['accessnotconfigured', 'service_disabled'])
const SCOPE_REASONS = new Set(['insufficientpermissions', 'access_token_scope_insufficient'])

/** Google API error classification (Gmail/Calendar return some quota errors as 403). */
export function googleClassifyApiError(
  operation: string,
): (info: HttpProviderErrorInfo) => ConnectionFailure | undefined {
  return (info) => {
    const tags = [info.code, ...info.reasons]
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase())
    const base = `${LABEL} ${operation} failed: HTTP ${info.status}${info.reasons[0] ? ` (${info.reasons[0]})` : info.code ? ` (${info.code})` : ''}`
    const extra = {
      httpStatus: info.status,
      ...(info.retryAfterMs !== null ? { retryAfterMs: info.retryAfterMs } : {}),
    }
    if (info.status === 403 || info.status === 429) {
      const rl = tags.find((t) => RATE_LIMIT_REASONS.has(t))
      if (rl || info.status === 429) return connectionFailure('rate_limited', rl ?? 'http_429', base, extra)
      if (tags.some((t) => API_DISABLED_REASONS.has(t)))
        return connectionFailure(
          'config',
          'api_disabled',
          `${base}. The API is not enabled in the Google Cloud project.`,
          extra,
        )
      if (tags.some((t) => SCOPE_REASONS.has(t)))
        return connectionFailure(
          'auth',
          'insufficient_scope',
          `${base}. Access to this data was not granted; reconnect and allow it.`,
          extra,
        )
    }
    return undefined
  }
}

function accountKindFor(email: string | undefined, hd: string | undefined): ConnectionAccountKind {
  if (hd) return 'work_or_school'
  if (email && /@(gmail|googlemail)\.com$/i.test(email)) return 'personal'
  return 'unknown'
}

/** Account kind from a Google id token: `hd` marks Workspace accounts, gmail.com personal ones. */
export function googleAccountKindFromIdToken(idToken: string | null): ConnectionAccountKind {
  const claims = idToken ? oauthDecodeJwtClaims(idToken) : null
  if (!claims) return 'unknown'
  return accountKindFor(
    typeof claims.email === 'string' ? claims.email : undefined,
    typeof claims.hd === 'string' ? claims.hd : undefined,
  )
}

export function createGoogleAdapter(config: GoogleOAuthConfig): ConnectionOAuthAdapter {
  const secrets = [config.clientSecret]
  const scopes = CONNECTION_PROVIDER_INFO.google.scopes

  const api = (
    ctx: ConnectionAdapterContext,
    operation: string,
    url: string,
    accessToken: string,
  ): HttpRequestOptions => ({
    fetch: ctx.fetch,
    signal: ctx.signal,
    now: ctx.now,
    provider: LABEL,
    operation,
    url,
    headers: { authorization: `Bearer ${accessToken}` },
    classify: googleClassifyApiError(operation),
    secrets: [...secrets, accessToken],
  })

  async function userinfo(accessToken: string, ctx: ConnectionAdapterContext) {
    const { data } = await httpRequestJson(
      api(ctx, 'userinfo', GOOGLE_ENDPOINTS.userinfo, accessToken),
      UserInfoSchema,
    )
    return data
  }

  return {
    provider: 'google',
    supportsRevoke: true,

    authorize({ state, codeChallenge, redirectUri, loginHint }) {
      return oauthAuthorizationUrl(GOOGLE_ENDPOINTS.authorize, {
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        // consent: always return a refresh token; select_account: let the owner pick
        // which of several Google accounts to connect.
        prompt: 'consent select_account',
        include_granted_scopes: 'true',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: loginHint,
      })
    },

    exchange({ code, codeVerifier, redirectUri }, ctx) {
      return oauthTokenRequest(
        {
          provider: 'google',
          providerLabel: LABEL,
          operation: 'code exchange',
          tokenUrl: GOOGLE_ENDPOINTS.token,
          params: {
            code,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: codeVerifier,
          },
          secrets: [...secrets, code, codeVerifier],
        },
        ctx,
      )
    },

    refresh(refreshToken, ctx) {
      return oauthTokenRequest(
        {
          provider: 'google',
          providerLabel: LABEL,
          operation: 'token refresh',
          tokenUrl: GOOGLE_ENDPOINTS.token,
          params: {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          },
          secrets: [...secrets, refreshToken],
        },
        ctx,
      )
    },

    async identify(tokens: OAuthTokenSet, ctx): Promise<ConnectionAccountIdentity> {
      const claims = tokens.idToken ? oauthDecodeJwtClaims(tokens.idToken) : null
      const aud = claims?.aud
      const audOk = aud === config.clientId || (Array.isArray(aud) && aud.includes(config.clientId))
      const issOk = typeof claims?.iss === 'string' && GOOGLE_ISSUERS.includes(claims.iss)
      const expOk = typeof claims?.exp === 'number' && claims.exp * 1000 > ctx.now().getTime() - 300_000
      if (claims && audOk && issOk && expOk && typeof claims.sub === 'string' && claims.sub) {
        const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined
        const hd = typeof claims.hd === 'string' ? claims.hd : undefined
        return { externalAccountId: claims.sub, accountLabel: email ?? claims.sub, accountKind: accountKindFor(email, hd) }
      }
      // No usable id token: ask the userinfo endpoint (openid + email are always granted).
      const info = await userinfo(tokens.accessToken, ctx)
      const email = info.email?.toLowerCase()
      return { externalAccountId: info.sub, accountLabel: email ?? info.sub, accountKind: accountKindFor(email, info.hd) }
    },

    async verifyAccess(accessToken, grantedScopes, ctx): Promise<ConnectionAccessCheck> {
      const granted = normalizeGrantedScopes('google', grantedScopes)
      if (granted.includes(GOOGLE_GMAIL_SCOPE)) {
        const { data } = await httpRequestJson(
          api(ctx, 'Gmail profile', GOOGLE_ENDPOINTS.gmailProfile, accessToken),
          GmailProfileSchema,
        )
        return {
          endpoint: 'gmail.users.getProfile',
          accountLabel: data.emailAddress.toLowerCase(),
          externalAccountId: null,
          facts: { historyIdPresent: data.historyId !== undefined && String(data.historyId) !== '' },
        }
      }
      if (GOOGLE_CALENDAR_SCOPES.some((s) => granted.includes(s))) {
        const url = `${GOOGLE_ENDPOINTS.calendarList}?maxResults=1`
        await httpRequestJson(api(ctx, 'calendar list', url, accessToken), CalendarListSchema)
        return { endpoint: 'calendar.calendarList.list', accountLabel: null, externalAccountId: null, facts: {} }
      }
      const info = await userinfo(accessToken, ctx)
      return {
        endpoint: 'openid.userinfo',
        accountLabel: info.email?.toLowerCase() ?? null,
        externalAccountId: info.sub,
        facts: {},
      }
    },

    revoke(token, ctx): Promise<ConnectionRevokeOutcome> {
      return googleRevokeToken(token, ctx)
    },
  }
}

/**
 * Revoke a Google grant (refresh or access token). Needs no client credentials,
 * so disconnect still works when the OAuth settings were removed. Never throws.
 */
export async function googleRevokeToken(
  token: string,
  ctx: ConnectionAdapterContext,
): Promise<ConnectionRevokeOutcome> {
  try {
    await httpRequestNoContent({
      fetch: ctx.fetch,
      signal: ctx.signal,
      now: ctx.now,
      provider: LABEL,
      operation: 'revoke',
      url: GOOGLE_ENDPOINTS.revoke,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      timeoutMs: 10_000,
      secrets: [token],
      // Google answers 400 invalid_token when the grant is already gone.
      classify: (info) =>
        info.status === 400 && info.code === 'invalid_token'
          ? connectionFailure('auth', 'invalid_token', 'Google revoke: token already invalid')
          : undefined,
    })
    return 'revoked'
  } catch (err) {
    if (isConnectionError(err) && err.failure.code === 'auth.invalid_token') return 'already_invalid'
    return 'failed'
  }
}
