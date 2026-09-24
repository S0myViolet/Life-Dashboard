/**
 * Connections repository.
 *
 * Reads of public.connections / sync_cursors / connection_events work in owner
 * (RLS) or service transactions. Every write and everything touching
 * private.connection_tokens / private.oauth_states requires a SERVICE
 * transaction (`withService`): the migration grants `authenticated` SELECT only.
 *
 * Status changes go through `connectionApplyEvent`, which locks the row and
 * applies the pure state machine from @personal-home/core, so a job outcome
 * that races with the owner pausing can never un-pause a connection.
 */
import {
  connectionTransition,
  sanitizeConnectionErrorMessage,
  MAX_ERROR_MESSAGE_LENGTH,
  type ConnectionEvent,
  type ConnectionHealth,
  type ConnectionRevokeOutcome,
  type Provider,
  type StoredConnectionStatus,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

export interface ConnectionRow {
  id: string
  provider: Provider
  accountLabel: string
  externalAccountId: string
  status: StoredConnectionStatus
  grantedScopes: string[]
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  nextAttemptAt: Date | null
  consecutiveFailures: number
  pausedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ConnectionTokensRow {
  connectionId: string
  refreshTokenCiphertext: string
  accessTokenCiphertext: string | null
  accessTokenExpiresAt: Date | null
  keyVersion: number
  updatedAt: Date
}

export type ConnectionEventKind = 'connected' | 'reconnected' | 'paused' | 'resumed' | 'renamed' | 'disconnected'

export interface ConnectionEventRow {
  id: string
  connectionId: string
  provider: Provider
  accountLabel: string
  kind: ConnectionEventKind
  revokeOutcome: ConnectionRevokeOutcome | null
  createdAt: Date
}

const COLUMNS = `id, provider, account_label, external_account_id, status, granted_scopes,
  last_attempt_at, last_success_at, last_error_code, last_error_message, next_attempt_at,
  consecutive_failures, paused_at, created_at, updated_at`

export function connectionHealthOf(row: ConnectionRow): ConnectionHealth {
  return {
    status: row.status,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    nextAttemptAt: row.nextAttemptAt,
    consecutiveFailures: row.consecutiveFailures,
    pausedAt: row.pausedAt,
  }
}

/** All connections (owner or service transaction), grouped by provider, oldest first. */
export async function connectionsList(tx: Tx, provider?: Provider): Promise<ConnectionRow[]> {
  if (provider) {
    return tx<ConnectionRow[]>`
      select ${tx.unsafe(COLUMNS)} from public.connections
      where provider = ${provider} order by created_at, id`
  }
  return tx<ConnectionRow[]>`
    select ${tx.unsafe(COLUMNS)} from public.connections order by provider, created_at, id`
}

export async function connectionGet(tx: Tx, id: string): Promise<ConnectionRow | null> {
  const [row] = await tx<ConnectionRow[]>`
    select ${tx.unsafe(COLUMNS)} from public.connections where id = ${id}`
  return row ?? null
}

/** Connections a background job should work on now: not paused, not awaiting reconnect, due. */
export async function connectionsDue(tx: Tx, provider: Provider, now: Date): Promise<ConnectionRow[]> {
  return tx<ConnectionRow[]>`
    select ${tx.unsafe(COLUMNS)} from public.connections
    where provider = ${provider}
      and paused_at is null
      and status <> 'needs_reconnect'
      and (next_attempt_at is null or next_attempt_at <= ${now})
    order by coalesce(last_attempt_at, '-infinity'::timestamptz), id`
}

async function writeHealth(tx: Tx, id: string, h: ConnectionHealth): Promise<ConnectionRow> {
  const [row] = await tx<ConnectionRow[]>`
    update public.connections set
      status = ${h.status},
      last_attempt_at = ${h.lastAttemptAt},
      last_success_at = ${h.lastSuccessAt},
      last_error_code = ${h.lastErrorCode},
      last_error_message = ${
        h.lastErrorMessage === null
          ? null
          : sanitizeConnectionErrorMessage(h.lastErrorMessage, MAX_ERROR_MESSAGE_LENGTH)
      },
      next_attempt_at = ${h.nextAttemptAt},
      consecutive_failures = ${h.consecutiveFailures},
      paused_at = ${h.pausedAt}
    where id = ${id}
    returning ${tx.unsafe(COLUMNS)}`
  if (!row) throw new Error('connection disappeared while updating')
  return row
}

/**
 * Lock the row, apply a state-machine event and persist the result.
 * Returns null when the connection no longer exists (e.g. disconnected meanwhile).
 */
export async function connectionApplyEvent(
  tx: Tx,
  id: string,
  event: ConnectionEvent,
): Promise<ConnectionRow | null> {
  const [row] = await tx<ConnectionRow[]>`
    select ${tx.unsafe(COLUMNS)} from public.connections where id = ${id} for update`
  if (!row) return null
  const next = connectionTransition(connectionHealthOf(row), event)
  return writeHealth(tx, id, next)
}

export interface ConnectionUpsertInput {
  provider: Provider
  externalAccountId: string
  accountLabel: string
  grantedScopes: string[]
  at: Date
}

/**
 * Create the connection for a freshly authorised account, or mark an existing
 * one (same provider + external id) as reconnected. Keeps the owner's label and
 * pause state on reconnect.
 */
export async function connectionUpsertAuthorized(
  tx: Tx,
  input: ConnectionUpsertInput,
): Promise<{ connection: ConnectionRow; created: boolean }> {
  const label = input.accountLabel.trim().slice(0, 200) || input.externalAccountId.slice(0, 200)
  const [inserted] = await tx<ConnectionRow[]>`
    insert into public.connections (
      provider, account_label, external_account_id, status, granted_scopes,
      last_attempt_at, last_success_at
    ) values (
      ${input.provider}, ${label}, ${input.externalAccountId}, 'connected', ${input.grantedScopes},
      ${input.at}, ${input.at}
    )
    on conflict (provider, external_account_id) do nothing
    returning ${tx.unsafe(COLUMNS)}`
  if (inserted) return { connection: inserted, created: true }

  const [existing] = await tx<{ id: string }[]>`
    select id from public.connections
    where provider = ${input.provider} and external_account_id = ${input.externalAccountId}`
  if (!existing) throw new Error('connection upsert raced with a delete')
  await tx`update public.connections set granted_scopes = ${input.grantedScopes} where id = ${existing.id}`
  const connection = await connectionApplyEvent(tx, existing.id, { type: 'reconnected', at: input.at })
  if (!connection) throw new Error('connection upsert raced with a delete')
  return { connection, created: false }
}

/** Record the scopes a refresh reported (granted scopes can shrink if the owner revokes some). */
export async function connectionSetGrantedScopes(tx: Tx, id: string, scopes: string[]): Promise<void> {
  await tx`update public.connections set granted_scopes = ${scopes}
    where id = ${id} and granted_scopes is distinct from ${scopes}::text[]`
}

export async function connectionRename(tx: Tx, id: string, label: string): Promise<ConnectionRow | null> {
  const clean = label.trim()
  if (clean.length < 1 || clean.length > 200) throw new Error('label must be 1–200 characters')
  const [row] = await tx<ConnectionRow[]>`
    update public.connections set account_label = ${clean} where id = ${id}
    returning ${tx.unsafe(COLUMNS)}`
  return row ?? null
}

/**
 * Delete a connection with its tokens and cursors (both also cascade).
 * Later milestones' imported data references connections with ON DELETE CASCADE.
 */
export async function connectionDelete(tx: Tx, id: string): Promise<ConnectionRow | null> {
  await tx`delete from public.sync_cursors where connection_id = ${id}`
  await tx`delete from private.connection_tokens where connection_id = ${id}`
  const [row] = await tx<ConnectionRow[]>`
    delete from public.connections where id = ${id} returning ${tx.unsafe(COLUMNS)}`
  return row ?? null
}

// ---------------------------------------------------------------------------
// Tokens (service transactions only)
// ---------------------------------------------------------------------------

export interface ConnectionTokensInput {
  connectionId: string
  refreshTokenCiphertext: string
  accessTokenCiphertext: string | null
  accessTokenExpiresAt: Date | null
  keyVersion: number
}

/** Insert or replace a connection's tokens (after a fresh authorization). */
export async function connectionTokensSave(tx: Tx, t: ConnectionTokensInput): Promise<void> {
  await tx`
    insert into private.connection_tokens (
      connection_id, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, key_version
    ) values (
      ${t.connectionId}, ${t.refreshTokenCiphertext}, ${t.accessTokenCiphertext}, ${t.accessTokenExpiresAt}, ${t.keyVersion}
    )
    on conflict (connection_id) do update set
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      access_token_ciphertext = excluded.access_token_ciphertext,
      access_token_expires_at = excluded.access_token_expires_at,
      key_version = excluded.key_version`
}

/**
 * Read a connection's tokens. `lock: 'skip_locked'` takes a row lock for the
 * rest of the transaction and returns `'busy'` when another worker holds it
 * (used to serialise refreshes so a rotated refresh token is never lost).
 */
export async function connectionTokensGet(
  tx: Tx,
  connectionId: string,
  lock: 'none' | 'skip_locked' = 'none',
): Promise<ConnectionTokensRow | null | 'busy'> {
  if (lock === 'none') {
    const [row] = await tx<ConnectionTokensRow[]>`
      select connection_id, refresh_token_ciphertext, access_token_ciphertext,
             access_token_expires_at, key_version, updated_at
      from private.connection_tokens where connection_id = ${connectionId}`
    return row ?? null
  }
  const [row] = await tx<ConnectionTokensRow[]>`
    select connection_id, refresh_token_ciphertext, access_token_ciphertext,
           access_token_expires_at, key_version, updated_at
    from private.connection_tokens where connection_id = ${connectionId}
    for update skip locked`
  if (row) return row
  const [exists] = await tx<{ one: number }[]>`
    select 1 as one from private.connection_tokens where connection_id = ${connectionId}`
  return exists ? 'busy' : null
}

export interface ConnectionTokensRotation {
  connectionId: string
  accessTokenCiphertext: string
  accessTokenExpiresAt: Date | null
  /** New refresh token when the provider rotated it; null keeps the stored one. */
  refreshTokenCiphertext: string | null
  keyVersion: number
}

/**
 * Persist refreshed tokens in one statement (access token, expiry and any
 * rotated refresh token together). UPDATE only: a connection deleted meanwhile
 * is not resurrected. Returns false when there was nothing to update.
 */
export async function connectionTokensRotate(tx: Tx, r: ConnectionTokensRotation): Promise<boolean> {
  const rows = await tx`
    update private.connection_tokens set
      access_token_ciphertext = ${r.accessTokenCiphertext},
      access_token_expires_at = ${r.accessTokenExpiresAt},
      refresh_token_ciphertext = coalesce(${r.refreshTokenCiphertext}::text, refresh_token_ciphertext),
      key_version = ${r.keyVersion}
    where connection_id = ${r.connectionId}
    returning connection_id`
  return rows.length === 1
}

// ---------------------------------------------------------------------------
// OAuth states (service transactions only)
// ---------------------------------------------------------------------------

export interface OAuthStateInput {
  stateHash: string
  provider: 'google' | 'microsoft' | 'whoop' | 'spotify'
  codeVerifierCiphertext: string
  returnTo: string
}

/** Store a new one-time state (10-minute TTL from the database clock) and purge old ones. */
export async function connectionOAuthStateCreate(tx: Tx, s: OAuthStateInput): Promise<void> {
  await tx`delete from private.oauth_states where expires_at < now() - interval '1 day'`
  await tx`
    insert into private.oauth_states (state_hash, provider, code_verifier_ciphertext, return_to)
    values (${s.stateHash}, ${s.provider}, ${s.codeVerifierCiphertext}, ${s.returnTo})`
}

/**
 * Atomically consume a state: succeeds once, only for the same provider and
 * only before it expires. Returns null otherwise (unknown, used, expired).
 */
export async function connectionOAuthStateConsume(
  tx: Tx,
  s: { stateHash: string; provider: OAuthStateInput['provider'] },
): Promise<{ codeVerifierCiphertext: string; returnTo: string } | null> {
  const [row] = await tx<{ codeVerifierCiphertext: string; returnTo: string }[]>`
    update private.oauth_states set consumed_at = now()
    where state_hash = ${s.stateHash}
      and provider = ${s.provider}
      and consumed_at is null
      and expires_at > now()
    returning code_verifier_ciphertext, return_to`
  return row ?? null
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function connectionEventRecord(
  tx: Tx,
  e: {
    connectionId: string
    provider: Provider
    accountLabel: string
    kind: ConnectionEventKind
    revokeOutcome?: ConnectionRevokeOutcome | null
  },
): Promise<void> {
  await tx`
    insert into public.connection_events (connection_id, provider, account_label, kind, revoke_outcome)
    values (${e.connectionId}, ${e.provider}, ${e.accountLabel.slice(0, 200)}, ${e.kind}, ${e.revokeOutcome ?? null})`
}

export async function connectionEventsRecent(tx: Tx, limit = 20): Promise<ConnectionEventRow[]> {
  return tx<ConnectionEventRow[]>`
    select id, connection_id, provider, account_label, kind, revoke_outcome, created_at
    from public.connection_events order by created_at desc, id limit ${Math.max(1, Math.min(limit, 200))}`
}

// ---------------------------------------------------------------------------
// Sync cursors (Milestone 2)
// ---------------------------------------------------------------------------

export const SYNC_CURSOR_STATUSES = ['pending', 'initial_sync', 'partial', 'synced', 'needs_resync', 'error'] as const
export type SyncCursorStatus = (typeof SYNC_CURSOR_STATUSES)[number]

export interface SyncCursorRow {
  id: string
  connectionId: string
  resourceType: string
  resourceId: string
  cursor: string | null
  windowStart: Date | null
  windowEnd: Date | null
  status: SyncCursorStatus
  lastSyncedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export async function syncCursorsList(tx: Tx, connectionId: string): Promise<SyncCursorRow[]> {
  return tx<SyncCursorRow[]>`
    select id, connection_id, resource_type, resource_id, cursor, window_start, window_end,
           status, last_synced_at, created_at, updated_at
    from public.sync_cursors where connection_id = ${connectionId}
    order by resource_type, resource_id`
}

export async function syncCursorUpsert(
  tx: Tx,
  c: {
    connectionId: string
    resourceType: string
    resourceId?: string
    cursor: string | null
    windowStart?: Date | null
    windowEnd?: Date | null
    status: SyncCursorStatus
    lastSyncedAt?: Date | null
  },
): Promise<SyncCursorRow> {
  const [row] = await tx<SyncCursorRow[]>`
    insert into public.sync_cursors (
      connection_id, resource_type, resource_id, cursor, window_start, window_end, status, last_synced_at
    ) values (
      ${c.connectionId}, ${c.resourceType}, ${c.resourceId ?? ''}, ${c.cursor},
      ${c.windowStart ?? null}, ${c.windowEnd ?? null}, ${c.status}, ${c.lastSyncedAt ?? null}
    )
    on conflict (connection_id, resource_type, resource_id) do update set
      cursor = excluded.cursor,
      window_start = excluded.window_start,
      window_end = excluded.window_end,
      status = excluded.status,
      last_synced_at = excluded.last_synced_at
    returning id, connection_id, resource_type, resource_id, cursor, window_start, window_end,
              status, last_synced_at, created_at, updated_at`
  if (!row) throw new Error('sync cursor upsert returned no row')
  return row
}
