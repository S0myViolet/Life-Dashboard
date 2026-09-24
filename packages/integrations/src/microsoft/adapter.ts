/**
 * Microsoft adapter: Outlook mail + calendar via Microsoft Graph, read-only.
 * Microsoft identity platform v2.0 on the /common tenant (personal and
 * work/school accounts) as a CONFIDENTIAL Web client: the redirect URI must be
 * registered under platform "Web", not "SPA" (SPA refresh tokens expire after
 * 24 hours). Refresh tokens are replaced on every use, so callers must store
 * the rotated one every time. See docs/research/oauth.md.
 *
 * Revocation: the v2.0 endpoint has no token revocation API for delegated
 * refresh tokens. Disconnect deletes our copy; the owner removes the app's
 * consent from their Microsoft account (see MICROSOFT_CONSENT_PAGES).
 */
import { z } from 'zod'
import {
  CONNECTION_PROVIDER_INFO,
  connectionFailure,
  type ConnectionAccessCheck,
  type ConnectionAccountIdentity,
  type ConnectionAccountKind,
  type ConnectionAdapterContext,
  type ConnectionFailure,
  type ConnectionOAuthAdapter,
  type OAuthTokenSet,
} from '@personal-home/core'
import { httpRequestJson, type HttpProviderErrorInfo } from '../http/client.ts'
import { oauthAuthorizationUrl, oauthDecodeJwtClaims, oauthTokenRequest } from '../oauth/oauth.ts'

export type MicrosoftTenant = 'common' | 'organizations' | 'consumers'

export function microsoftEndpoints(tenant: MicrosoftTenant = 'common') {
  return {
    authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    me: 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
  } as const
}

/**
 * Where the owner removes this app's access after disconnecting.
 * UNVERIFIED: long-standing Microsoft URLs recalled from memory, not re-checked
 * from this container (learn.microsoft.com is blocked here).
 */
export const MICROSOFT_CONSENT_PAGES = {
  personal: 'https://account.live.com/consent/Manage',
  workOrSchool: 'https://myapplications.microsoft.com',
} as const

/**
 * Tenant id that Microsoft uses for personal (consumer) accounts in id tokens.
 * UNVERIFIED from this container; used only to label the account kind.
 */
export const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'

const LABEL = 'Microsoft'

export interface MicrosoftOAuthConfig {
  clientId: string
  clientSecret: string
  tenant?: MicrosoftTenant
}

const MeSchema = z.object({
  id: z.string().min(1).max(255),
  displayName: z.string().max(512).nullish(),
  mail: z.string().max(320).nullish(),
  userPrincipalName: z.string().max(320).nullish(),
})

/** Graph errors: 401 InvalidAuthenticationToken, 403 ErrorAccessDenied, 429/503 with Retry-After. */
export function microsoftClassifyGraphError(
  operation: string,
): (info: HttpProviderErrorInfo) => ConnectionFailure | undefined {
  return (info) => {
    const base = `${LABEL} ${operation} failed: HTTP ${info.status}${info.code ? ` (${info.code})` : ''}`
    const extra = {
      httpStatus: info.status,
      ...(info.retryAfterMs !== null ? { retryAfterMs: info.retryAfterMs } : {}),
    }
    if (info.status === 429 || info.code === 'TooManyRequests' || info.code === 'ApplicationThrottled')
      return connectionFailure('rate_limited', 'http_429', base, extra)
    if (info.status === 403 && info.code === 'MailboxNotEnabledForRESTAPI')
      return connectionFailure('provider', 'mailbox_not_enabled', `${base}. This account has no Outlook mailbox.`, extra)
    return undefined
  }
}

/** Account kind from a Microsoft id token's tenant id (consumer tenant → personal). */
export function microsoftAccountKindFromIdToken(idToken: string | null): ConnectionAccountKind {
  const claims = idToken ? oauthDecodeJwtClaims(idToken) : null
  const tid = typeof claims?.tid === 'string' ? claims.tid.toLowerCase() : null
  if (!tid) return 'unknown'
  return tid === MICROSOFT_CONSUMER_TENANT_ID ? 'personal' : 'work_or_school'
}

export function createMicrosoftAdapter(config: MicrosoftOAuthConfig): ConnectionOAuthAdapter {
  const endpoints = microsoftEndpoints(config.tenant ?? 'common')
  const scope = CONNECTION_PROVIDER_INFO.microsoft.scopes.join(' ')
  const secrets = [config.clientSecret]

  async function me(accessToken: string, ctx: ConnectionAdapterContext) {
    const { data } = await httpRequestJson(
      {
        fetch: ctx.fetch,
        signal: ctx.signal,
        now: ctx.now,
        provider: LABEL,
        operation: 'Graph /me',
        url: endpoints.me,
        headers: { authorization: `Bearer ${accessToken}` },
        classify: microsoftClassifyGraphError('Graph /me'),
        secrets: [...secrets, accessToken],
      },
      MeSchema,
    )
    return data
  }

  return {
    provider: 'microsoft',
    supportsRevoke: false,

    authorize({ state, codeChallenge, redirectUri, loginHint }) {
      return oauthAuthorizationUrl(endpoints.authorize, {
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // Let the owner choose which of several Microsoft accounts to connect.
        prompt: 'select_account',
        login_hint: loginHint,
      })
    },

    exchange({ code, codeVerifier, redirectUri }, ctx) {
      return oauthTokenRequest(
        {
          provider: 'microsoft',
          providerLabel: LABEL,
          operation: 'code exchange',
          tokenUrl: endpoints.token,
          params: {
            client_id: config.clientId,
            scope,
            code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: codeVerifier,
            client_secret: config.clientSecret,
          },
          secrets: [...secrets, code, codeVerifier],
        },
        ctx,
      )
    },

    refresh(refreshToken, ctx) {
      return oauthTokenRequest(
        {
          provider: 'microsoft',
          providerLabel: LABEL,
          operation: 'token refresh',
          tokenUrl: endpoints.token,
          params: {
            client_id: config.clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_secret: config.clientSecret,
            scope,
          },
          secrets: [...secrets, refreshToken],
        },
        ctx,
      )
    },

    async identify(tokens: OAuthTokenSet, ctx): Promise<ConnectionAccountIdentity> {
      const data = await me(tokens.accessToken, ctx)
      const label = (data.mail || data.userPrincipalName || data.id).toLowerCase()
      return {
        externalAccountId: data.id,
        accountLabel: label,
        accountKind: microsoftAccountKindFromIdToken(tokens.idToken),
      }
    },

    async verifyAccess(accessToken, _grantedScopes, ctx): Promise<ConnectionAccessCheck> {
      const data = await me(accessToken, ctx)
      return {
        endpoint: 'graph.me',
        accountLabel: (data.mail || data.userPrincipalName || null)?.toLowerCase() ?? null,
        externalAccountId: data.id,
        facts: {},
      }
    },

    async revoke() {
      return 'not_supported'
    },
  }
}
