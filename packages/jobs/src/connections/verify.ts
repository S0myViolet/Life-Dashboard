/**
 * Milestone 0 background access check for Google and Microsoft connections.
 *
 * For each account: load and decrypt tokens, refresh when the access token is
 * missing, expired or close to expiry (persisting a rotated refresh token in
 * the same statement), call the provider's identity endpoint, and record the
 * outcome through the connection state machine. Accounts are isolated: one
 * failing account never stops or changes another.
 *
 * Refreshes are serialised per connection with a row lock
 * (`for update skip locked`) held across the token request, so two workers can
 * never both redeem a Microsoft refresh token and lose the rotated one.
 */
import {
  CONNECTION_TOKEN_KEY_VERSION,
  ConnectionError,
  connectionDecryptToken,
  connectionEncryptToken,
  connectionFailure,
  isConnectionError,
  toConnectionFailure,
  type ConnectionAdapterContext,
  type ConnectionFailure,
  type ConnectionOAuthAdapter,
  type EncryptionKey,
  type OAuthConnectProvider,
  type StoredConnectionStatus,
} from '@personal-home/core'
import {
  connectionApplyEvent,
  connectionGet,
  connectionSetGrantedScopes,
  connectionTokensGet,
  connectionTokensRotate,
  withService,
  type ConnectionRow,
  type Db,
} from '@personal-home/db'
import { googleAccountKindFromIdToken, microsoftAccountKindFromIdToken } from '@personal-home/integrations'

/** Refresh when the access token expires within this margin. */
export const CONNECTION_REFRESH_MARGIN_MS = 5 * 60_000

export interface ConnectionVerifyDeps {
  db: Db
  fetch: typeof fetch
  now: () => Date
  signal?: AbortSignal
  adapter: ConnectionOAuthAdapter
  key: EncryptionKey
}

export interface ConnectionVerifyOptions {
  /** Ignore next_attempt_at (owner-run verification). Paused connections are still skipped. */
  ignoreSchedule?: boolean
  /** Also try connections marked needs_reconnect (owner-run verification). */
  includeNeedsReconnect?: boolean
  /** Refresh even if the stored access token is still valid (prove refresh works). */
  forceRefresh?: boolean
}

export type ConnectionVerifyOutcome =
  | 'succeeded'
  | 'failed'
  | 'skipped_missing'
  | 'skipped_paused'
  | 'skipped_needs_reconnect'
  | 'skipped_not_due'
  | 'skipped_busy'

/** Secret-free summary of one verification, used by the job and the owner-run scripts. */
export interface ConnectionVerifyReport {
  connectionId: string
  provider: OAuthConnectProvider
  outcome: ConnectionVerifyOutcome
  refreshed: boolean
  refreshTokenRotated: boolean
  accessTokenExpiresAt: Date | null
  accountKind: 'personal' | 'work_or_school' | 'unknown'
  endpoint: string | null
  facts: Record<string, string | number | boolean | null>
  failure: ConnectionFailure | null
  statusAfter: StoredConnectionStatus | null
  nextAttemptAt: Date | null
  connection: ConnectionRow | null
}

interface AccessResult {
  accessToken: string
  refreshed: boolean
  rotated: boolean
  expiresAt: Date | null
  grantedScopes: string[] | null
  idToken: string | null
}

function isFresh(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() - now.getTime() > CONNECTION_REFRESH_MARGIN_MS
}

function missingTokens(): ConnectionError {
  return new ConnectionError(
    connectionFailure('auth', 'missing_tokens', 'No stored tokens for this account. Reconnect it.'),
  )
}

/** Refresh under a row lock. Returns 'busy' when another worker is refreshing this connection. */
async function refreshLocked(
  deps: ConnectionVerifyDeps,
  conn: ConnectionRow,
  ctx: ConnectionAdapterContext,
  force: boolean,
): Promise<AccessResult | 'busy'> {
  return withService(deps.db, async (tx) => {
    const row = await connectionTokensGet(tx, conn.id, 'skip_locked')
    if (row === 'busy') return 'busy'
    if (row === null) throw missingTokens()

    // Another worker may have refreshed while we were deciding.
    if (!force && row.accessTokenCiphertext && isFresh(row.accessTokenExpiresAt, deps.now())) {
      return {
        accessToken: await connectionDecryptToken(deps.key, conn.id, 'access_token', row.accessTokenCiphertext),
        refreshed: false,
        rotated: false,
        expiresAt: row.accessTokenExpiresAt,
        grantedScopes: null,
        idToken: null,
      }
    }

    const refreshToken = await connectionDecryptToken(deps.key, conn.id, 'refresh_token', row.refreshTokenCiphertext)
    const set = await deps.adapter.refresh(refreshToken, ctx)
    const rotated = set.refreshToken !== null && set.refreshToken !== refreshToken
    const saved = await connectionTokensRotate(tx, {
      connectionId: conn.id,
      accessTokenCiphertext: await connectionEncryptToken(deps.key, conn.id, 'access_token', set.accessToken),
      accessTokenExpiresAt: set.accessTokenExpiresAt,
      refreshTokenCiphertext: rotated
        ? await connectionEncryptToken(deps.key, conn.id, 'refresh_token', set.refreshToken!)
        : null,
      keyVersion: CONNECTION_TOKEN_KEY_VERSION,
    })
    if (!saved) throw missingTokens()
    return {
      accessToken: set.accessToken,
      refreshed: true,
      rotated,
      expiresAt: set.accessTokenExpiresAt,
      grantedScopes: set.grantedScopes,
      idToken: set.idToken,
    }
  })
}

function report(
  conn: ConnectionRow | null,
  connectionId: string,
  provider: OAuthConnectProvider,
  outcome: ConnectionVerifyOutcome,
): ConnectionVerifyReport {
  return {
    connectionId,
    provider,
    outcome,
    refreshed: false,
    refreshTokenRotated: false,
    accessTokenExpiresAt: null,
    accountKind: 'unknown',
    endpoint: null,
    facts: {},
    failure: null,
    statusAfter: conn?.status ?? null,
    nextAttemptAt: conn?.nextAttemptAt ?? null,
    connection: conn,
  }
}

/**
 * Verify background access for one connection and record the outcome.
 * Provider failures are recorded on the connection and reported, not thrown;
 * only database errors propagate.
 */
export async function connectionVerifyAccess(
  deps: ConnectionVerifyDeps,
  connectionId: string,
  options: ConnectionVerifyOptions = {},
): Promise<ConnectionVerifyReport> {
  const provider = deps.adapter.provider as OAuthConnectProvider
  const conn = await withService(deps.db, (tx) => connectionGet(tx, connectionId))
  if (!conn || conn.provider !== provider) return report(null, connectionId, provider, 'skipped_missing')
  if (conn.status === 'paused') return report(conn, connectionId, provider, 'skipped_paused')
  if (conn.status === 'needs_reconnect' && !options.includeNeedsReconnect)
    return report(conn, connectionId, provider, 'skipped_needs_reconnect')
  const startedAt = deps.now()
  if (!options.ignoreSchedule && conn.nextAttemptAt && conn.nextAttemptAt.getTime() > startedAt.getTime())
    return report(conn, connectionId, provider, 'skipped_not_due')

  const ctx: ConnectionAdapterContext = { fetch: deps.fetch, signal: deps.signal, now: deps.now }
  const out = report(conn, connectionId, provider, 'succeeded')

  try {
    const stored = await withService(deps.db, (tx) => connectionTokensGet(tx, conn.id))
    if (stored === null || stored === 'busy') throw missingTokens()

    let access: AccessResult | 'busy'
    if (!options.forceRefresh && stored.accessTokenCiphertext && isFresh(stored.accessTokenExpiresAt, startedAt)) {
      access = {
        accessToken: await connectionDecryptToken(deps.key, conn.id, 'access_token', stored.accessTokenCiphertext),
        refreshed: false,
        rotated: false,
        expiresAt: stored.accessTokenExpiresAt,
        grantedScopes: null,
        idToken: null,
      }
    } else {
      access = await refreshLocked(deps, conn, ctx, options.forceRefresh === true)
    }
    if (access === 'busy') return { ...out, outcome: 'skipped_busy' }

    const scopesFor = (a: AccessResult) => a.grantedScopes ?? conn.grantedScopes
    let check
    try {
      check = await deps.adapter.verifyAccess(access.accessToken, scopesFor(access), ctx)
    } catch (err) {
      // A cached access token can be revoked early: refresh once and try again.
      if (!access.refreshed && isConnectionError(err) && err.failure.code === 'auth.unauthorized') {
        const retried = await refreshLocked(deps, conn, ctx, true)
        if (retried === 'busy') return { ...out, outcome: 'skipped_busy' }
        access = retried
        check = await deps.adapter.verifyAccess(access.accessToken, scopesFor(access), ctx)
      } else {
        throw err
      }
    }

    if (check.externalAccountId && check.externalAccountId !== conn.externalAccountId) {
      throw new ConnectionError(
        connectionFailure(
          'auth',
          'account_mismatch',
          'The stored tokens belong to a different account than this connection. Reconnect it.',
        ),
      )
    }

    const granted = access.grantedScopes
    const row = await withService(deps.db, async (tx) => {
      if (granted && granted.length > 0) await connectionSetGrantedScopes(tx, conn.id, granted)
      return connectionApplyEvent(tx, conn.id, { type: 'attempt_succeeded', at: deps.now() })
    })
    return {
      ...out,
      outcome: row ? 'succeeded' : 'skipped_missing',
      refreshed: access.refreshed,
      refreshTokenRotated: access.rotated,
      accessTokenExpiresAt: access.expiresAt,
      accountKind:
        provider === 'google'
          ? googleAccountKindFromIdToken(access.idToken)
          : microsoftAccountKindFromIdToken(access.idToken),
      endpoint: check.endpoint,
      facts: check.facts,
      statusAfter: row?.status ?? null,
      nextAttemptAt: row?.nextAttemptAt ?? null,
      connection: row,
    }
  } catch (err) {
    // Provider and vault failures are classified; anything else is recorded as
    // transient with a sanitised message. If the database itself is failing,
    // recording throws and the caller sees the error.
    const failure = toConnectionFailure(err)
    const row = await withService(deps.db, (tx) =>
      connectionApplyEvent(tx, conn.id, { type: 'attempt_failed', at: deps.now(), failure }),
    )
    return {
      ...out,
      outcome: row ? 'failed' : 'skipped_missing',
      failure,
      statusAfter: row?.status ?? null,
      nextAttemptAt: row?.nextAttemptAt ?? null,
      connection: row,
    }
  }
}
