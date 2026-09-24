/**
 * Server side of "Connect a Google/Microsoft account".
 *
 * begin:    owner-only. Creates a one-time state (only its SHA-256 is stored)
 *           and a PKCE verifier (stored encrypted, bound to the state hash),
 *           and returns the provider's consent URL.
 * complete: owner-only. Checks the state against the browser-bound cookie,
 *           consumes it atomically, exchanges the code, identifies the account,
 *           proves access, encrypts the tokens bound to the connection id and
 *           upserts the connection.
 *
 * Integration consent is separate from app sign-in: nothing here touches
 * Supabase Auth or private.owner, so connecting any mailbox can never change
 * who owns the dashboard. Results are closed codes; provider responses are
 * never echoed.
 */
import 'server-only'
import { z } from 'zod'
import {
  CONNECTION_PROVIDER_INFO,
  CONNECTION_TOKEN_KEY_VERSION,
  connectionEncryptToken,
  decryptSecret,
  encryptSecret,
  normalizeGrantedScopes,
  oauthStateVerifierContext,
  sha256Hex,
  timingSafeEqual,
  toConnectionFailure,
  type ConnectionAccessCheck,
  type ConnectionFailure,
  type EncryptionKey,
  type OAuthConnectProvider,
} from '@personal-home/core'
import {
  connectionApplyEvent,
  connectionEventRecord,
  connectionGet,
  connectionOAuthStateConsume,
  connectionOAuthStateCreate,
  connectionTokensSave,
  connectionUpsertAuthorized,
  withService,
  type Db,
} from '@personal-home/db'
import { OAUTH_STATE_RE, oauthAdapterFromSettings, oauthPkcePair, oauthState } from '@personal-home/integrations'
import type { OAuthResultError } from './oauth-flow-codes'

export const DEFAULT_CONNECTIONS_PATH = '/settings/connections'

/** Only return to settings pages; anything else falls back to the Connections page. */
export function safeConnectionsReturnTo(path: string | null | undefined): string {
  return path && /^\/settings(\/[a-z0-9-]+)*$/.test(path) ? path : DEFAULT_CONNECTIONS_PATH
}

export { OAUTH_RESULT_ERRORS, type OAuthResultError } from './oauth-flow-codes'

export interface OAuthDeps {
  db: Db
  provider: OAuthConnectProvider
  redirectUri: string
  key: EncryptionKey | null
  setting: (name: string) => string | undefined
}

export type OAuthBeginResult =
  | { ok: true; authorizationUrl: string; state: string }
  | { ok: false; error: OAuthResultError }

const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function connectionOAuthBegin(
  deps: OAuthDeps & { returnTo?: string | null; reconnectConnectionId?: string | null },
): Promise<OAuthBeginResult> {
  const lookup = oauthAdapterFromSettings(deps.provider, deps.setting)
  if (!lookup.ok || !deps.key) return { ok: false, error: 'needs_setup' }
  const key = deps.key

  let loginHint: string | undefined
  if (deps.reconnectConnectionId) {
    const id = z.uuid().safeParse(deps.reconnectConnectionId)
    const conn = id.success ? await withService(deps.db, (tx) => connectionGet(tx, id.data)) : null
    if (!conn || conn.provider !== deps.provider) return { ok: false, error: 'unknown_account' }
    if (LOOKS_LIKE_EMAIL.test(conn.accountLabel)) loginHint = conn.accountLabel
  }

  const state = oauthState()
  const stateHash = await sha256Hex(state)
  const pkce = await oauthPkcePair()
  const verifierCiphertext = await encryptSecret(pkce.verifier, key, oauthStateVerifierContext(stateHash))
  await withService(deps.db, (tx) =>
    connectionOAuthStateCreate(tx, {
      stateHash,
      provider: deps.provider,
      codeVerifierCiphertext: verifierCiphertext,
      returnTo: safeConnectionsReturnTo(deps.returnTo),
    }),
  )
  const authorizationUrl = lookup.adapter.authorize({
    state,
    codeChallenge: pkce.challenge,
    redirectUri: deps.redirectUri,
    loginHint,
  })
  return { ok: true, authorizationUrl, state }
}

export type OAuthCompleteResult =
  | { ok: true; returnTo: string; outcome: 'connected' | 'reconnected'; accessChecked: boolean; connectionId: string }
  | { ok: false; returnTo: string; error: OAuthResultError }

const CallbackQuery = z.object({
  state: z.string().regex(OAUTH_STATE_RE).optional(),
  code: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
  error: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
})

function exchangeError(err: unknown): OAuthResultError {
  const f = toConnectionFailure(err)
  switch (f.kind) {
    case 'rate_limited':
      return 'rate_limited'
    case 'transient':
      return 'provider_unavailable'
    case 'config':
      return f.code === 'config.invalid_client' || f.code === 'config.unauthorized_client'
        ? 'client_rejected'
        : 'needs_setup'
    default:
      return 'exchange_failed'
  }
}

export async function connectionOAuthComplete(
  deps: OAuthDeps & {
    query: URLSearchParams
    cookieState: string | undefined
    fetch: typeof fetch
    now: () => Date
    signal?: AbortSignal
  },
): Promise<OAuthCompleteResult> {
  const fallback = DEFAULT_CONNECTIONS_PATH
  const parsed = CallbackQuery.safeParse({
    state: deps.query.get('state') ?? undefined,
    code: deps.query.get('code') ?? undefined,
    error: deps.query.get('error') ?? undefined,
  })
  if (!parsed.success || !parsed.data.state) return { ok: false, returnTo: fallback, error: 'invalid_request' }
  const { state, code, error } = parsed.data

  // The state must come back to the same browser that started the flow.
  if (!deps.cookieState || !timingSafeEqual(deps.cookieState, state))
    return { ok: false, returnTo: fallback, error: 'state_mismatch' }

  const stateHash = await sha256Hex(state)
  const stored = await withService(deps.db, (tx) =>
    connectionOAuthStateConsume(tx, { stateHash, provider: deps.provider }),
  )
  if (!stored) return { ok: false, returnTo: fallback, error: 'state_expired' }
  const returnTo = safeConnectionsReturnTo(stored.returnTo)

  if (error) return { ok: false, returnTo, error: error === 'access_denied' ? 'denied' : 'provider_error' }
  if (!code) return { ok: false, returnTo, error: 'invalid_request' }

  const lookup = oauthAdapterFromSettings(deps.provider, deps.setting)
  if (!lookup.ok || !deps.key) return { ok: false, returnTo, error: 'needs_setup' }
  const key = deps.key
  const adapter = lookup.adapter

  let codeVerifier: string
  try {
    codeVerifier = await decryptSecret(stored.codeVerifierCiphertext, key, oauthStateVerifierContext(stateHash))
  } catch {
    return { ok: false, returnTo, error: 'state_expired' }
  }

  const ctx = { fetch: deps.fetch, now: deps.now, signal: deps.signal }
  let tokens
  try {
    tokens = await adapter.exchange({ code, codeVerifier, redirectUri: deps.redirectUri }, ctx)
  } catch (err) {
    return { ok: false, returnTo, error: exchangeError(err) }
  }
  const refreshToken = tokens.refreshToken
  if (!refreshToken) return { ok: false, returnTo, error: 'no_refresh_token' }
  // RFC 6749 §5.1: an omitted `scope` means exactly the requested scopes were granted.
  const grantedScopes =
    tokens.grantedScopes ?? normalizeGrantedScopes(deps.provider, CONNECTION_PROVIDER_INFO[deps.provider].scopes)

  let identity
  try {
    identity = await adapter.identify(tokens, ctx)
  } catch (err) {
    const f = toConnectionFailure(err)
    return { ok: false, returnTo, error: f.kind === 'rate_limited' ? 'rate_limited' : 'identity_failed' }
  }

  // Prove access now; a failure is recorded on the connection rather than hidden.
  let check: ConnectionAccessCheck | null = null
  let checkFailure: ConnectionFailure | null = null
  try {
    check = await adapter.verifyAccess(tokens.accessToken, grantedScopes, ctx)
  } catch (err) {
    checkFailure = toConnectionFailure(err)
  }
  if (check?.externalAccountId && check.externalAccountId !== identity.externalAccountId)
    return { ok: false, returnTo, error: 'identity_failed' }

  const at = deps.now()
  const saved = await withService(deps.db, async (tx) => {
    const { connection, created } = await connectionUpsertAuthorized(tx, {
      provider: deps.provider,
      externalAccountId: identity.externalAccountId,
      accountLabel: check?.accountLabel ?? identity.accountLabel,
      grantedScopes,
      at,
    })
    await connectionTokensSave(tx, {
      connectionId: connection.id,
      refreshTokenCiphertext: await connectionEncryptToken(key, connection.id, 'refresh_token', refreshToken),
      accessTokenCiphertext: await connectionEncryptToken(key, connection.id, 'access_token', tokens.accessToken),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      keyVersion: CONNECTION_TOKEN_KEY_VERSION,
    })
    if (checkFailure) {
      await connectionApplyEvent(tx, connection.id, { type: 'attempt_failed', at, failure: checkFailure })
    }
    await connectionEventRecord(tx, {
      connectionId: connection.id,
      provider: deps.provider,
      accountLabel: connection.accountLabel,
      kind: created ? 'connected' : 'reconnected',
    })
    return { id: connection.id, created }
  })

  return {
    ok: true,
    returnTo,
    outcome: saved.created ? 'connected' : 'reconnected',
    accessChecked: checkFailure === null,
    connectionId: saved.id,
  }
}

/** Relative redirect target carrying only closed result codes. */
export function oauthResultLocation(
  provider: OAuthConnectProvider,
  result: OAuthCompleteResult | { ok: false; error: OAuthResultError; returnTo?: string },
): string {
  const path = safeConnectionsReturnTo(result.returnTo)
  const params = new URLSearchParams({ provider })
  if (result.ok) {
    params.set('result', result.outcome)
    if (!result.accessChecked) params.set('check', 'failed')
  } else {
    params.set('error', result.error)
  }
  return `${path}?${params.toString()}`
}
