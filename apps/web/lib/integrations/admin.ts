/**
 * Owner-driven connection changes. Callers (server actions) must have verified
 * the owner session first; these run as service transactions because the
 * owner's database role can only read connection state.
 *
 * Pause keeps tokens and stops jobs until the owner resumes.
 * Check now re-runs the background access check for one account (read-only).
 * Disconnect = revoke at the provider (best effort, recorded) + delete tokens,
 * cursors and the connection row (imported data cascades from it later).
 */
import 'server-only'
import {
  connectionDecryptToken,
  connectionErrorKindOf,
  isOAuthConnectProvider,
  type ConnectionRevokeOutcome,
  type EncryptionKey,
  type Provider,
} from '@personal-home/core'
import {
  connectionApplyEvent,
  connectionDelete,
  connectionEventRecord,
  connectionGet,
  connectionRename,
  connectionTokensGet,
  withService,
  type ConnectionRow,
  type Db,
} from '@personal-home/db'
import { googleRevokeToken, oauthAdapterFromSettings } from '@personal-home/integrations'
import { connectionVerifyAccess, type ConnectionVerifyReport } from '@personal-home/jobs'

export async function connectionAdminPause(
  db: Db,
  id: string,
  now: Date,
): Promise<ConnectionRow | null> {
  return withService(db, async (tx) => {
    const before = await connectionGet(tx, id)
    if (!before) return null
    const row = await connectionApplyEvent(tx, id, { type: 'paused', at: now })
    if (row && before.status !== 'paused')
      await connectionEventRecord(tx, {
        connectionId: id,
        provider: row.provider,
        accountLabel: row.accountLabel,
        kind: 'paused',
      })
    return row
  })
}

export async function connectionAdminResume(
  db: Db,
  id: string,
  now: Date,
): Promise<ConnectionRow | null> {
  return withService(db, async (tx) => {
    const before = await connectionGet(tx, id)
    if (!before) return null
    const row = await connectionApplyEvent(tx, id, { type: 'resumed', at: now })
    if (row && before.status === 'paused')
      await connectionEventRecord(tx, {
        connectionId: id,
        provider: row.provider,
        accountLabel: row.accountLabel,
        kind: 'resumed',
      })
    return row
  })
}

export async function connectionAdminRename(
  db: Db,
  id: string,
  label: string,
): Promise<ConnectionRow | null> {
  return withService(db, async (tx) => {
    const row = await connectionRename(tx, id, label)
    if (row)
      await connectionEventRecord(tx, {
        connectionId: id,
        provider: row.provider,
        accountLabel: row.accountLabel,
        kind: 'renamed',
      })
    return row
  })
}

/**
 * "Check now": run the background access check for one account right away, so
 * an owner who just fixed a configuration problem (e.g. enabled the Gmail API)
 * does not wait out the slow configuration retry. Only that wait is waived: a
 * provider's Retry-After or backoff still applies, and paused or
 * needs-reconnect accounts are left alone (the report says why).
 */
export async function connectionAdminCheckNow(deps: {
  db: Db
  id: string
  key: EncryptionKey | null
  fetch: typeof fetch
  now: () => Date
  setting: (name: string) => string | undefined
}): Promise<ConnectionVerifyReport | 'needs_setup' | null> {
  const conn = await withService(deps.db, (tx) => connectionGet(tx, deps.id))
  if (!conn || !isOAuthConnectProvider(conn.provider)) return null
  const lookup = oauthAdapterFromSettings(conn.provider, deps.setting)
  if (!lookup.ok || !deps.key) return 'needs_setup'
  return connectionVerifyAccess(
    { db: deps.db, fetch: deps.fetch, now: deps.now, adapter: lookup.adapter, key: deps.key },
    conn.id,
    { ignoreSchedule: connectionErrorKindOf(conn.lastErrorCode) === 'config' },
  )
}

export interface DisconnectResult {
  provider: Provider
  accountLabel: string
  revoke: ConnectionRevokeOutcome
}

export async function connectionAdminDisconnect(deps: {
  db: Db
  id: string
  key: EncryptionKey | null
  fetch: typeof fetch
  now: () => Date
}): Promise<DisconnectResult | null> {
  const found = await withService(deps.db, async (tx) => {
    const conn = await connectionGet(tx, deps.id)
    if (!conn) return null
    const tokens = await connectionTokensGet(tx, deps.id)
    return { conn, tokens: tokens === 'busy' ? null : tokens }
  })
  if (!found) return null
  const { conn, tokens } = found

  // 1. Revoke at the provider, best effort. Microsoft has no revocation endpoint.
  let revoke: ConnectionRevokeOutcome = 'not_supported'
  if (conn.provider === 'google') {
    revoke = 'failed'
    if (tokens && deps.key) {
      try {
        const refreshToken = await connectionDecryptToken(
          deps.key,
          conn.id,
          'refresh_token',
          tokens.refreshTokenCiphertext,
        )
        revoke = await googleRevokeToken(refreshToken, { fetch: deps.fetch, now: deps.now })
      } catch {
        revoke = 'failed'
      }
    }
  }

  // 2. Delete cursors, tokens and the row; record what happened at the provider.
  const deleted = await withService(deps.db, async (tx) => {
    const row = await connectionDelete(tx, conn.id)
    if (row)
      await connectionEventRecord(tx, {
        connectionId: row.id,
        provider: row.provider,
        accountLabel: row.accountLabel,
        kind: 'disconnected',
        revokeOutcome: revoke,
      })
    return row
  })
  if (!deleted) return null
  return { provider: deleted.provider, accountLabel: deleted.accountLabel, revoke }
}
