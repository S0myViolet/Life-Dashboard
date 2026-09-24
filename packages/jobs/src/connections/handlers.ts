/**
 * Job handlers for `sync.google` and `sync.microsoft`.
 *
 * Milestone 0 only proves background access (refresh + identity call); mail and
 * calendar import arrive in Milestone 2 behind the same job kinds.
 *
 * Payload: `{}` checks every due account of the provider (each isolated);
 * `{ connectionId }` checks one account.
 *
 * INTEGRATION NOTE: the dispatcher's `JobHandler` type is being defined in
 * ../dispatcher at the same time. `ConnectionJobHandler` below is a local
 * structural copy of the agreed contract; align the names when integrating.
 */
import { z } from 'zod'
import {
  connectionEncryptionKey,
  connectionFailure,
  type OAuthConnectProvider,
} from '@personal-home/core'
import {
  connectionApplyEvent,
  connectionGet,
  connectionsDue,
  withService,
  type Db,
} from '@personal-home/db'
import { oauthAdapterFromSettings } from '@personal-home/integrations'
import { connectionVerifyAccess, type ConnectionVerifyReport } from './verify.ts'

export interface ConnectionJobContext {
  db: Db
  now: () => Date
  fetch: typeof fetch
  signal: AbortSignal
  env: (name: string) => string | undefined
}

export interface ConnectionJob {
  id: string
  kind: string
  payload: unknown
}

export type ConnectionJobResult =
  | { status: 'succeeded' }
  | { status: 'retry'; retryAt?: Date; error: string }
  | { status: 'failed'; error: string }

export type ConnectionJobHandler = (
  ctx: ConnectionJobContext,
  job: ConnectionJob,
) => Promise<ConnectionJobResult>

const PayloadSchema = z
  .object({ connectionId: z.uuid().optional() })
  .passthrough()
  .nullish()
  .transform((v) => v ?? {})

/** Wait this long before retrying a connection another worker is refreshing. */
const BUSY_RETRY_MS = 60_000

/** Map one account's report to a job result (single-connection jobs). */
export function connectionJobResultFor(
  report: ConnectionVerifyReport,
  now: Date,
): ConnectionJobResult {
  switch (report.outcome) {
    case 'succeeded':
    case 'skipped_paused':
      return { status: 'succeeded' }
    case 'skipped_missing':
      return { status: 'failed', error: 'connection not found' }
    case 'skipped_needs_reconnect':
      return { status: 'failed', error: 'needs_reconnect' }
    case 'skipped_busy':
      return {
        status: 'retry',
        retryAt: new Date(now.getTime() + BUSY_RETRY_MS),
        error: 'refresh in progress elsewhere',
      }
    case 'skipped_not_due':
      return { status: 'retry', retryAt: report.nextAttemptAt ?? undefined, error: 'not due yet' }
    case 'failed': {
      const code = report.failure?.code ?? 'unknown'
      if (report.statusAfter === 'needs_reconnect' || report.failure?.kind === 'auth')
        return { status: 'failed', error: code }
      return { status: 'retry', retryAt: report.nextAttemptAt ?? undefined, error: code }
    }
  }
}

function makeHandler(provider: OAuthConnectProvider): ConnectionJobHandler {
  return async (ctx, job) => {
    const parsed = PayloadSchema.safeParse(job.payload)
    if (!parsed.success) return { status: 'failed', error: 'invalid payload' }
    const { connectionId } = parsed.data

    const lookup = oauthAdapterFromSettings(provider, ctx.env)
    const key = await connectionEncryptionKey(ctx.env('TOKEN_ENCRYPTION_KEY'))
    const missing = [...(lookup.ok ? [] : lookup.missing), ...(key ? [] : ['TOKEN_ENCRYPTION_KEY'])]
    if (!lookup.ok || !key) {
      // Tell the owner on each affected account instead of failing silently.
      const failure = connectionFailure(
        'config',
        'missing_settings',
        `Background jobs are missing server settings: ${missing.join(', ')}`,
      )
      const ids = connectionId
        ? [connectionId]
        : (await withService(ctx.db, (tx) => connectionsDue(tx, provider, ctx.now()))).map(
            (c) => c.id,
          )
      // Not set up and nothing due to check: that is needs_setup, not a failed job.
      if (ids.length === 0) return { status: 'succeeded' }
      for (const id of ids) {
        await withService(ctx.db, async (tx) => {
          const row = await connectionGet(tx, id)
          // Same filter as connectionsDue: a paused account stays paused, and one that
          // needs a reconnect keeps saying so (and keeps its Reconnect button).
          if (
            row?.provider === provider &&
            row.status !== 'paused' &&
            row.status !== 'needs_reconnect'
          )
            await connectionApplyEvent(tx, id, { type: 'attempt_failed', at: ctx.now(), failure })
        })
      }
      return { status: 'failed', error: `missing settings: ${missing.join(', ')}` }
    }

    const deps = {
      db: ctx.db,
      fetch: ctx.fetch,
      now: ctx.now,
      signal: ctx.signal,
      adapter: lookup.adapter,
      key,
    }

    if (connectionId) {
      const report = await connectionVerifyAccess(deps, connectionId)
      return connectionJobResultFor(report, ctx.now())
    }

    const due = await withService(ctx.db, (tx) => connectionsDue(tx, provider, ctx.now()))
    let internalErrors = 0
    for (const conn of due) {
      if (ctx.signal.aborted)
        return { status: 'retry', error: 'cancelled before every account was checked' }
      try {
        await connectionVerifyAccess(deps, conn.id)
      } catch {
        // Database trouble for one account must not stop the others. Never log details: they may hold PII.
        internalErrors++
      }
    }
    if (internalErrors > 0)
      return {
        status: 'retry',
        error: `${internalErrors} of ${due.length} accounts hit an internal error`,
      }
    return { status: 'succeeded' }
  }
}

export const connectionHandlers: Record<'sync.google' | 'sync.microsoft', ConnectionJobHandler> = {
  'sync.google': makeHandler('google'),
  'sync.microsoft': makeHandler('microsoft'),
}
